// VoiceStore — 语音识别(ASR)配置持久化,照抄 ProviderStore 的模式。
// 数据存在 userData/config/voice.json。prompt/hotwords 的默认值是 preset.js 的
// 双语 D&D 预设,null = 跟随当前界面语言取对应 locale 的预设;用户改过即固化为
// 覆盖,不再随语言切换。判据统一为「与任一 locale 预设完全相等 = 未自定义」,
// 读写两侧都用它,误保存原文不会把用户锁死在某个语言的预设上。
//
// 单 Key 语义:provider=arcane-relay 时 apiKey/baseUrl 留空 = 跟随 Arcane Spark
// (providers.json 的内置 provider),聊天与语音共用一张发放的 sk- Key;
// 显式填写才算覆盖；renderer 始终只接收掩码。
import { readFileSync, writeFileSync } from "node:fs";
import { VOICE_PRESETS, voicePresetFor } from "./preset.js";
import { decodeBoundCredential, encodeBoundCredential } from "../bound-credential.js";
import { err } from "../i18n-error.mjs";
import { providerCredentialTarget, validateProviderBaseUrl } from "../provider-endpoint.js";
import { DEFAULT_NEW_API_BASE_URL } from "../providers.js";
import { createUnavailableSecretStorage } from "../secret-storage.js";

/** 热词值等于某个 locale 预设的词表(逐项全等) = 该字段未自定义。 */
function matchesAnyPresetHotwords(words) {
  return Object.values(VOICE_PRESETS).some((preset) =>
    preset.hotwords.length === words.length && preset.hotwords.every((w, i) => w === words[i]));
}

/** prompt 值等于某个 locale 预设的 prompt = 该字段未自定义。 */
function matchesAnyPresetPrompt(prompt) {
  return Object.values(VOICE_PRESETS).some((preset) => preset.prompt === prompt);
}

/** 存盘值 → 覆盖语义:缺键/非字符串/与预设相等 → null(跟随);空串是显式清空,保留。 */
function storedPromptOverride(value) {
  if (typeof value !== "string") return null;
  if (value === "") return "";
  return matchesAnyPresetPrompt(value) ? null : value;
}

/** 存盘词表 → 覆盖语义:非数组/与预设相等 → null(跟随)。 */
function storedHotwordsOverride(value) {
  if (!Array.isArray(value)) return null;
  const words = value.map(String).filter(Boolean).slice(0, MAX_HOTWORDS);
  return matchesAnyPresetHotwords(words) ? null : words;
}

const MAX_HOTWORDS = 100; // 智谱 GLM-ASR-2512 hotwords 上限
const DEFAULT_HOLD_KEY = "F9"; // 长按模式默认键;chord 语法见 renderer/shortcuts.js
const PROVIDERS = new Set(["zhipu", "arcane-relay"]);
const ZHIPU_CREDENTIAL_TARGET = "origin:https://open.bigmodel.cn";

/** chord 字符串,空串 = 不绑定。 */
function normalizeKey(value, fallback = "") {
  const key = String(value ?? "").trim();
  return key || fallback;
}

function voiceCredentialTarget(provider, baseUrl, relayBaseUrl) {
  if (provider === "zhipu") {
    return { ok: true, target: ZHIPU_CREDENTIAL_TARGET, baseUrl: "" };
  }
  const endpoint = providerCredentialTarget({
    api: "openai-completions",
    baseUrl: baseUrl || relayBaseUrl || DEFAULT_NEW_API_BASE_URL,
  });
  return endpoint;
}

/**
 * relay 模式的最终凭据:voice 自己的值优先,留空回退 Arcane Spark,
 * 地址再兜底默认网关。spark 形如 {apiKey,baseUrl},可为 null
 * (内置 provider 被移除的极端情况)。
 */
export function resolveRelayCredentials(voiceData, spark, relayBaseUrl = DEFAULT_NEW_API_BASE_URL) {
  const ownTarget = voiceCredentialTarget("arcane-relay", voiceData.baseUrl, spark?.baseUrl || relayBaseUrl);
  if (
    ownTarget.ok &&
    voiceData.apiKey &&
    voiceData.credentialTarget === ownTarget.target
  ) {
    return { apiKey: voiceData.apiKey, baseUrl: ownTarget.baseUrl };
  }

  const sparkEndpoint = spark?.apiKey
    ? providerCredentialTarget({ api: "openai-completions", baseUrl: spark.baseUrl })
    : null;
  if (sparkEndpoint?.ok) {
    return { apiKey: String(spark.apiKey), baseUrl: sparkEndpoint.baseUrl };
  }

  const fallback = providerCredentialTarget({ api: "openai-completions", baseUrl: relayBaseUrl });
  return { apiKey: "", baseUrl: fallback.ok ? fallback.baseUrl : DEFAULT_NEW_API_BASE_URL };
}

export class VoiceStore {
  constructor(
    filePath,
    log = console.log,
    secretStorage = createUnavailableSecretStorage(),
    relayBaseUrl = DEFAULT_NEW_API_BASE_URL,
    localeProvider = () => "zh-CN",
  ) {
    this.filePath = filePath;
    this.log = log;
    this.secretStorage = secretStorage;
    this.localeProvider = localeProvider;
    const relayEndpoint = validateProviderBaseUrl(relayBaseUrl);
    this.relayBaseUrl = relayEndpoint.ok && relayEndpoint.baseUrl
      ? relayEndpoint.baseUrl
      : DEFAULT_NEW_API_BASE_URL;
    const loaded = this.load();
    this.data = loaded.data;
    if (loaded.needsMigration) this.save();
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      let needsMigration = Object.hasOwn(parsed, "apiKey");
      const provider = PROVIDERS.has(parsed.provider) ? parsed.provider : "zhipu";
      const rawBaseUrl = String(parsed.baseUrl ?? "").trim();
      const endpoint = validateProviderBaseUrl(rawBaseUrl);
      const baseUrl = endpoint.ok ? endpoint.baseUrl : "";
      let apiKey = "";
      let credentialTarget = null;
      try {
        const revealed = parsed.apiKeyProtected
          ? this.secretStorage.reveal(parsed.apiKeyProtected)
          : String(parsed.apiKey ?? "");
        const decoded = decodeBoundCredential(revealed);
        apiKey = decoded.secret;
        credentialTarget = decoded.target;
        if (apiKey && (!credentialTarget || decoded.legacy)) {
          const derived = rawBaseUrl && !endpoint.ok
            ? null
            : voiceCredentialTarget(provider, baseUrl, this.relayBaseUrl);
          credentialTarget = derived?.ok ? derived.target : null;
          needsMigration = true;
        }
      } catch (error) {
        this.log(`[voice] protected API key could not be opened: ${error.message}`);
      }
      // 旧配置迁移:hotkeys 数组的第一条当作长按键
      const legacyHold = Array.isArray(parsed.hotkeys) ? parsed.hotkeys[0] : null;
      return { data: {
        enabled: Boolean(parsed.enabled),
        provider,
        apiKey,
        ...(apiKey && credentialTarget ? { credentialTarget } : {}),
        baseUrl,
        // v3 及更早的存量配置物化过预设值:与任一 locale 预设相等 → null 重新跟随语言,
        // 不等的才是用户覆盖。空串 prompt / 空词表是显式清空,保持覆盖。
        prompt: storedPromptOverride(parsed.prompt),
        hotwords: storedHotwordsOverride(parsed.hotwords),
        holdKey: normalizeKey(parsed.holdKey ?? legacyHold, DEFAULT_HOLD_KEY),
        toggleKey: normalizeKey(parsed.toggleKey),
      }, needsMigration };
    } catch {
      return { data: {
        // 新用户直接继承 Arcane Spark 的接入;只有实际触发录音时才申请麦克风权限。
        // prompt/hotwords 不物化,null = 跟随界面语言取预设。
        enabled: true,
        provider: "arcane-relay",
        apiKey: "",
        baseUrl: "",
        prompt: null,
        hotwords: null,
        holdKey: DEFAULT_HOLD_KEY,
        toggleKey: "",
      }, needsMigration: false };
    }
  }

  save() {
    const { apiKey, credentialTarget, ...configuration } = this.data;
    writeFileSync(this.filePath, JSON.stringify({
      schemaVersion: 4,
      ...configuration,
      apiKeyProtected: this.secretStorage.protect(encodeBoundCredential(apiKey, credentialTarget)),
    }, null, 2));
  }

  /** ASR 实际使用的 prompt/热词:用户覆盖优先,缺省按当前界面语言取预设。 */
  effective() {
    const preset = voicePresetFor(this.localeProvider());
    return {
      prompt: this.data.prompt ?? preset.prompt,
      hotwords: this.data.hotwords ?? preset.hotwords,
    };
  }

  /**
   * 给 renderer 的视图:apiKey 打码(仅留后 4 位)。
   * spark = Arcane Spark provider 的 {apiKey,baseUrl} 或 null:relay 模式下
   * 未自设 key 时展示 Spark 的打码 key(keySource="arcane-spark"),
   * 避免用户误以为没配置;baseUrl 是自己的覆盖值(空 = 跟随),
   * relayBaseUrl 是实际会使用的地址,给 UI 当 placeholder。
   */
  toPublic(spark = null) {
    const relay = this.data.provider === "arcane-relay";
    const resolved = this.credentialForUse(spark);
    const ownTarget = voiceCredentialTarget(this.data.provider, this.data.baseUrl, spark?.baseUrl || this.relayBaseUrl);
    const ownUsable = Boolean(
      this.data.apiKey && ownTarget.ok && this.data.credentialTarget === ownTarget.target,
    );
    const effectiveApiKey = resolved.apiKey;
    const followsSpark = relay && !ownUsable && Boolean(effectiveApiKey && spark?.apiKey);
    const ownApiKey = ownUsable ? this.data.apiKey : "";
    const effective = this.effective();
    return {
      enabled: this.data.enabled,
      provider: this.data.provider,
      apiKey: effectiveApiKey ? `••••${effectiveApiKey.slice(-4)}` : "",
      hasKey: Boolean(effectiveApiKey),
      keySource: followsSpark ? "arcane-spark" : "voice",
      hasOwnKey: Boolean(ownApiKey),
      ownApiKey: ownApiKey ? `••••${ownApiKey.slice(-4)}` : "",
      sparkHasKey: Boolean(spark?.apiKey),
      baseUrl: this.data.baseUrl,
      relayBaseUrl: relay ? resolved.baseUrl : "",
      // 设置页展示的是「实际会发给 ASR 的值」:覆盖值或当前语言的预设。
      prompt: effective.prompt,
      hotwords: effective.hotwords,
      holdKey: this.data.holdKey,
      toggleKey: this.data.toggleKey,
    };
  }

  /** apiKey 仅在 provider/credential target 不变时允许留空或用掩码复用。 */
  update(input, spark = null) {
    const provider = PROVIDERS.has(input.provider) ? input.provider : "zhipu";
    const rawBaseUrl = provider === "arcane-relay" ? String(input.baseUrl ?? "").trim() : "";
    const endpoint = validateProviderBaseUrl(rawBaseUrl);
    if (!endpoint.ok) return endpoint;
    const target = voiceCredentialTarget(
      provider,
      endpoint.baseUrl,
      spark?.baseUrl || this.relayBaseUrl,
    );
    if (!target.ok) return target;
    const inputApiKey = String(input?.apiKey ?? "").trim();
    const reusesStoredKey = !inputApiKey || inputApiKey.startsWith("••••");
    const targetChanged = Boolean(
      reusesStoredKey &&
      this.data.apiKey &&
      this.data.credentialTarget !== target.target,
    );
    if (targetChanged && provider === this.data.provider) {
      return {
        ok: false,
        code: "KEY_REENTRY_REQUIRED",
        error: err("err.provider.keyReentryRequired"),
      };
    }
    // Changing provider with a blank field intentionally drops the old provider's
    // own key. It must never follow the user into the newly selected service.
    const apiKey = reusesStoredKey
      ? (targetChanged ? "" : this.data.apiKey)
      : inputApiKey;
    const credentialTarget = apiKey
      ? (reusesStoredKey ? this.data.credentialTarget : target.target)
      : null;
    // prompt/hotwords:输入缺省 = 保持现值(renderer 恒发全量,防御性兜底);
    // 与任一 locale 预设相等 → null 继续跟随语言(设置页原样保存不会固化);
    // 空串 prompt / 空词表是显式清空,按覆盖落盘。
    const inputPrompt = typeof input.prompt === "string" ? input.prompt : this.data.prompt;
    const inputHotwords = Array.isArray(input.hotwords)
      ? input.hotwords.map((w) => String(w ?? "").trim()).filter(Boolean).slice(0, MAX_HOTWORDS)
      : this.data.hotwords;
    this.data = {
      enabled: Boolean(input.enabled),
      provider,
      apiKey,
      ...(credentialTarget ? { credentialTarget } : {}),
      // 空串 = 跟随 Arcane Spark；非空地址已经过 HTTPS/loopback 校验。
      baseUrl: endpoint.baseUrl,
      prompt: storedPromptOverride(inputPrompt),
      hotwords: storedHotwordsOverride(inputHotwords),
      // 空串 = 不绑定(设置页 × 清除的语义),不是回默认
      holdKey: normalizeKey(input.holdKey),
      toggleKey: normalizeKey(input.toggleKey),
    };
    this.save();
    return { ok: true };
  }

  /**
   * 是否可以发起一次识别(给 IPC 入口的守卫)。
   * relay 模式可借用 Arcane Spark 的 Key;zhipu 直连只认自己的 key。
   */
  usable(spark = null) {
    if (!this.data.enabled) return false;
    return Boolean(this.credentialForUse(spark).apiKey);
  }

  /** Resolve the exact endpoint paired with a usable credential; never expose an unbound key. */
  credentialForUse(spark = null) {
    if (this.data.provider === "arcane-relay") {
      return resolveRelayCredentials(this.data, spark, this.relayBaseUrl);
    }
    const target = voiceCredentialTarget("zhipu", "", this.relayBaseUrl);
    return {
      apiKey: this.data.apiKey && this.data.credentialTarget === target.target ? this.data.apiKey : "",
      baseUrl: "",
    };
  }
}
