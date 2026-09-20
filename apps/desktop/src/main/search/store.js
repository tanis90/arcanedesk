// search/store.js — SearchStore：联网搜索配置与凭据持久化。
// 模式复刻 VoiceStore（voice/voice-store.js）：userData JSON + safeStorage +
// credential-target 绑定 + 掩码复用语义；差异只在字段与 backend 分发。
// renderer 永远只拿 toPublic() 的掩码视图。

import { readFileSync, writeFileSync } from "node:fs";
import { decodeBoundCredential, encodeBoundCredential } from "../bound-credential.js";
import { err } from "../i18n-error.mjs";
import { validateProviderBaseUrl } from "../provider-endpoint.js";
import { createUnavailableSecretStorage } from "../secret-storage.js";

export const MODES = new Set(["off", "spark", "byok", "custom"]);
export const BYOK_BACKENDS = new Set(["zai", "brave"]);

export const DEFAULT_ZAI_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/web_search";
export const DEFAULT_ZAI_SEARCH_ENGINE = "search_pro";
export const DEFAULT_BRAVE_BASE_URL = "https://api.search.brave.com/res/v1/web/search";

/** 目标 backend → 实际会请求的端点。 */
function effectiveBaseUrl(data, defaults) {
  if (data.mode === "spark") return ""; // 运行时取 Spark provider 的 baseUrl
  if (data.mode === "custom") return data.customBaseUrl;
  if (data.mode === "byok") {
    return data.byokBackend === "brave" ? defaults.braveBaseUrl : defaults.zaiBaseUrl;
  }
  return "";
}

/** consent target = 接收方 origin（credential-target 同款字符串）。 */
export function consentTargetForBaseUrl(baseUrl) {
  try {
    return `origin:${new URL(baseUrl).origin}`;
  } catch {
    return "";
  }
}

export class SearchStore {
  /**
   * @param {string} filePath userData/config/search.json
   * @param {Function} log
   * @param {import("../secret-storage.js").SecretStorage} secretStorage SecretStorage 实例（测试注入桩）
   * @param {{ zaiBaseUrl?: string, zaiSearchEngine?: string }} defaults 区域 overlay 注入点（国内 bigmodel+search_pro / 国际 z.ai+search-prime）
   */
  constructor(filePath, log = console.log, secretStorage = createUnavailableSecretStorage(), defaults = {}) {
    this.filePath = filePath;
    this.log = log;
    this.secretStorage = secretStorage;
    this.defaults = {
      zaiBaseUrl: defaults.zaiBaseUrl ?? DEFAULT_ZAI_BASE_URL,
      zaiSearchEngine: defaults.zaiSearchEngine ?? DEFAULT_ZAI_SEARCH_ENGINE,
      braveBaseUrl: DEFAULT_BRAVE_BASE_URL,
    };
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      let apiKey = "";
      let credentialTarget = null;
      try {
        const revealed = parsed.apiKeyProtected
          ? this.secretStorage.reveal(parsed.apiKeyProtected)
          : "";
        const decoded = decodeBoundCredential(revealed);
        apiKey = decoded.secret;
        credentialTarget = decoded.target;
      } catch (error) {
        this.log(`[search] protected API key could not be opened: ${error.message}`);
      }
      const rawBaseUrl = String(parsed.customBaseUrl ?? "").trim();
      const endpoint = validateProviderBaseUrl(rawBaseUrl);
      return {
        mode: MODES.has(parsed.mode) ? parsed.mode : "spark",
        byokBackend: BYOK_BACKENDS.has(parsed.byokBackend) ? parsed.byokBackend : "zai",
        customBaseUrl: endpoint.ok ? endpoint.baseUrl : "",
        apiKey,
        ...(apiKey && credentialTarget ? { credentialTarget } : {}),
      };
    } catch {
      // 新用户默认 spark：有 Spark 凭据即可用，没有时 usable() 为 false——
      // 工具不注册、零请求；自己填 Key 的 byok/custom 始终要显式选择+保存。
      return {
        mode: "spark",
        byokBackend: "zai",
        customBaseUrl: "",
        apiKey: "",
      };
    }
  }

  save() {
    const { apiKey, credentialTarget, ...configuration } = this.data;
    writeFileSync(this.filePath, JSON.stringify({
      schemaVersion: 2,
      ...configuration,
      apiKeyProtected: this.secretStorage.protect(encodeBoundCredential(apiKey, credentialTarget)),
    }, null, 2));
  }

  /** 掩码视图（renderer 唯一可见形态）。 */
  toPublic(spark = null) {
    const resolved = this.credentialForUse(spark);
    const followsSpark = this.data.mode === "spark" && !this.data.apiKey;
    return {
      mode: this.data.mode,
      byokBackend: this.data.byokBackend,
      customBaseUrl: this.data.customBaseUrl,
      apiKey: resolved.apiKey ? `••••${resolved.apiKey.slice(-4)}` : "",
      hasKey: Boolean(resolved.apiKey),
      keySource: followsSpark && resolved.apiKey ? "arcane-spark" : "search",
      sparkHasKey: Boolean(spark?.apiKey),
      defaults: { zaiBaseUrl: this.defaults.zaiBaseUrl, zaiSearchEngine: this.defaults.zaiSearchEngine },
    };
  }

  /**
   * 保存配置。掩码/留空 = 沿用已存 key；backend 或 endpoint 变化时已存 key 不跨
   * target 复用（KEY_REENTRY_REQUIRED）；mode 切换离开 byok/custom 丢弃自有 key。
   */
  update(input, spark = null) {
    const mode = MODES.has(input?.mode) ? input.mode : "off";
    const byokBackend = BYOK_BACKENDS.has(input?.byokBackend) ? input.byokBackend : "zai";
    const rawBaseUrl = String(input?.customBaseUrl ?? "").trim();
    const endpoint = validateProviderBaseUrl(rawBaseUrl);
    if (!endpoint.ok) return endpoint;

    const usesOwnKey = mode === "byok" || mode === "custom";
    const nextTarget = usesOwnKey
      ? consentTargetForBaseUrl(mode === "custom" ? endpoint.baseUrl : effectiveBaseUrl({ mode, byokBackend }, this.defaults))
      : "";

    const inputApiKey = String(input?.apiKey ?? "").trim();
    const reusesStoredKey = !inputApiKey || inputApiKey.startsWith("••••");
    if (reusesStoredKey && usesOwnKey && this.data.apiKey && this.data.credentialTarget && this.data.credentialTarget !== nextTarget) {
      return {
        ok: false,
        code: "KEY_REENTRY_REQUIRED",
        error: err("err.provider.keyReentryRequired"),
      };
    }
    // 换 target（backend/endpoint）或离开自有 key 模式：旧 key 不带走。
    const keepKey = reusesStoredKey && usesOwnKey
      && this.data.credentialTarget === nextTarget;
    const apiKey = keepKey
      ? this.data.apiKey
      : (usesOwnKey ? inputApiKey : "");
    const credentialTarget = apiKey ? nextTarget : null;

    this.data = {
      mode,
      byokBackend,
      customBaseUrl: mode === "custom" ? endpoint.baseUrl : "",
      apiKey,
      ...(credentialTarget ? { credentialTarget } : {}),
    };
    this.save();
    return { ok: true };
  }

  /** 是否可以向 agent 注册 web_search（mode≠off 且凭据齐备）。 */
  usable(spark = null) {
    if (this.data.mode === "off") return false;
    return Boolean(this.credentialForUse(spark).apiKey);
  }

  /** 运行时凭据与 adapter 选择；spark 模式跟随 Spark provider。 */
  credentialForUse(spark = null) {
    if (this.data.mode === "spark") {
      const base = spark?.baseUrl ? String(spark.baseUrl).replace(/\/+$/, "") : "";
      return { adapterId: "spark", apiKey: spark?.apiKey ? String(spark.apiKey) : "", baseUrl: base };
    }
    if (this.data.mode === "byok") {
      const backend = this.data.byokBackend;
      const base = backend === "brave" ? this.defaults.braveBaseUrl : this.defaults.zaiBaseUrl;
      const target = consentTargetForBaseUrl(base);
      return {
        adapterId: backend,
        apiKey: this.data.apiKey && this.data.credentialTarget === target ? this.data.apiKey : "",
        baseUrl: base,
        ...(backend === "zai" ? { searchEngine: this.defaults.zaiSearchEngine } : {}),
      };
    }
    if (this.data.mode === "custom") {
      const target = consentTargetForBaseUrl(this.data.customBaseUrl);
      return {
        adapterId: "custom",
        apiKey: this.data.apiKey && this.data.credentialTarget === target ? this.data.apiKey : "",
        baseUrl: this.data.customBaseUrl,
      };
    }
    return { adapterId: null, apiKey: "", baseUrl: "" };
  }
}
