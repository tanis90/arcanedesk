// ProviderStore — 用户可管的 LLM provider 配置(设置页的后端)。
// 数据存在 userData/config/providers.json;启动/保存时注册进 Pi 的 ModelRuntime。
// 应用层自己持有这份配置,不去改 ~/.pi/agent/models.json 的格式——
 // 运行时注册(registerProvider)与 Pi 配置文件里的 provider 可以共存。
import { readFileSync, writeFileSync } from "node:fs";
import { err } from "./i18n-error.mjs";
import { createUnavailableSecretStorage } from "./secret-storage.js";

// Keep the default product budget aligned with the 256K context exposed by
// current coding-plan models such as Kimi K2.7 (`262144` in provider configs).
// Pi reserves response headroom from this value before triggering compaction.
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 8192;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ARCANE_SPARK_PROVIDER_ID = "arcane-spark";
const ARCANE_SPARK_PROVIDER_NAME = "Arcane Spark";
// 语音中转(arcane-relay)复用同一个网关地址,导出给 voice-store 做默认值
export const DEFAULT_NEW_API_BASE_URL =
  cleanEnvValue(process.env.ARCANE_SPARK_BASE_URL) || "https://llm.arcanedesk.bitterbebop.cn/v1";
// 客户端只发送稳定的产品模型 ID；真实供应商模型由 NewAPI model_mapping 决定。
// 这样以后切换上游模型无需发布新的 Desktop，也不会把供应商型号暴露给用户。
const ARCANE_SPARK_MODEL_ID = "arcane-spark";

function cleanEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export class ProviderStore {
  constructor(filePath, log = console.log, env = process.env, secretStorage = createUnavailableSecretStorage()) {
    this.filePath = filePath;
    this.log = log;
    this.secretStorage = secretStorage;
    const loaded = this.load();
    this.data = loaded.data;
    if (loaded.needsMigration) this.save();
    this.provisionArcaneSparkProvider(env);
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      let needsMigration = false;
      const providers = (Array.isArray(parsed.providers) ? parsed.providers : []).map((provider) => {
        const { apiKey: legacyApiKey, apiKeyProtected, ...publicConfig } = provider ?? {};
        if (Object.hasOwn(provider ?? {}, "apiKey")) needsMigration = true;
        let apiKey = "";
        try {
          apiKey = apiKeyProtected
            ? this.secretStorage.reveal(apiKeyProtected)
            : String(legacyApiKey ?? "");
        } catch (error) {
          this.log(`[providers] protected API key could not be opened for ${provider?.id ?? "unknown"}: ${error.message}`);
        }
        return { ...publicConfig, apiKey };
      });
      return {
        data: { providers, defaultModel: parsed.defaultModel ?? null },
        needsMigration,
      };
    } catch {
      return { data: { providers: [], defaultModel: null }, needsMigration: false };
    }
  }

  save() {
    const persisted = {
      schemaVersion: 2,
      providers: this.data.providers.map(({ apiKey, ...provider }) => ({
        ...provider,
        apiKeyProtected: this.secretStorage.protect(apiKey),
      })),
      defaultModel: this.data.defaultModel,
    };
    writeFileSync(this.filePath, JSON.stringify(persisted, null, 2));
  }

  /**
   * Arcane Spark 是内置 provider：首次安装即展示，但 Key 由用户自行填写，
   * 或由安装程序/本地启动器通过环境变量注入。首次安装会把它设为默认模型；
   * 已有用户手动选择的默认模型保持不变。
   */
  provisionArcaneSparkProvider(env = process.env) {
    if (cleanEnvValue(env.ARCANE_SPARK_ENABLED) === "0") return false;

    const existing = this.data.providers.find((provider) => provider.id === ARCANE_SPARK_PROVIDER_ID);
    let apiKey = cleanEnvValue(env.ARCANE_SPARK_API_KEY);
    const tokenFile = cleanEnvValue(env.ARCANE_SPARK_API_KEY_FILE);
    if (!apiKey && tokenFile) {
      try {
        apiKey = readFileSync(tokenFile, "utf8").trim();
      } catch (error) {
        this.log(`[providers] read ARCANE_SPARK_API_KEY_FILE failed: ${error.message}`);
      }
    }
    const record = {
      id: ARCANE_SPARK_PROVIDER_ID,
      name: ARCANE_SPARK_PROVIDER_NAME,
      api: "openai-completions",
      baseUrl: cleanEnvValue(env.ARCANE_SPARK_BASE_URL) || DEFAULT_NEW_API_BASE_URL,
      apiKey: apiKey || existing?.apiKey || "",
      models: [{ id: ARCANE_SPARK_MODEL_ID, name: ARCANE_SPARK_PROVIDER_NAME, vision: true }],
    };

    let changed = false;
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        Object.assign(existing, record);
        changed = true;
      }
    } else {
      this.data.providers.push(record);
      changed = true;
    }

    const forceDefault = cleanEnvValue(env.ARCANE_SPARK_FORCE_DEFAULT) === "1";
    const sparkDefaultNeedsMigration =
      this.data.defaultModel?.providerId === ARCANE_SPARK_PROVIDER_ID &&
      this.data.defaultModel.modelId !== ARCANE_SPARK_MODEL_ID;
    if (!this.data.defaultModel || forceDefault || sparkDefaultNeedsMigration) {
      const nextDefault = { providerId: ARCANE_SPARK_PROVIDER_ID, modelId: ARCANE_SPARK_MODEL_ID };
      if (JSON.stringify(this.data.defaultModel) !== JSON.stringify(nextDefault)) {
        this.data.defaultModel = nextDefault;
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  /** 给 renderer 的视图:apiKey 打码(仅留后 4 位)。 */
  toPublic() {
    return {
      providers: this.data.providers.map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        managed: p.id === ARCANE_SPARK_PROVIDER_ID,
        api: p.api ?? "openai-completions",
        baseUrl: p.baseUrl ?? "",
        apiKey: p.apiKey ? `••••${p.apiKey.slice(-4)}` : "",
        hasKey: Boolean(p.apiKey),
        models: (p.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, vision: Boolean(m.vision) })),
      })),
      defaultModel: this.data.defaultModel,
    };
  }

  /** 当前默认模型属于自管 provider 且缺 Key 时，返回供 UI 拦截使用的信息。 */
  missingApiKeyForDefault() {
    const pref = this.data.defaultModel;
    if (!pref?.providerId) return null;
    const provider = this.data.providers.find((p) => p.id === pref.providerId);
    if (!provider || provider.apiKey) return null;
    return {
      providerId: provider.id,
      providerName: provider.name ?? provider.id,
      arcaneSpark: provider.id === ARCANE_SPARK_PROVIDER_ID,
    };
  }

  /**
   * 新增/更新 provider。apiKey 语义:空字符串或打码值("••••xxxx")= 保持原值;
   * 否则覆盖。models 接受 [{id,name?,vision?}]——vision: true 表示支持图片输入,
   * 注册进 pi 时映射为 input: ["text","image"](pi 缺省 ["text"],图片会被静默丢弃)。
   */
  upsertProvider(input) {
    const id = String(input?.id ?? "").trim();
    if (!id) return { ok: false, error: err("err.provider.idEmpty") };
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) return { ok: false, error: err("err.provider.idInvalid") };
    const existing = this.data.providers.find((p) => p.id === id);
    const apiKey =
      !input.apiKey || input.apiKey.startsWith("••••") ? existing?.apiKey ?? "" : String(input.apiKey).trim();
    const models = (Array.isArray(input.models) ? input.models : [])
      .map((m) => ({
        id: String(m?.id ?? "").trim(),
        name: String(m?.name ?? "").trim() || undefined,
        vision: Boolean(m?.vision),
      }))
      .filter((m) => m.id);
    const managed = id === ARCANE_SPARK_PROVIDER_ID;
    const record = managed
      ? {
          id,
          name: ARCANE_SPARK_PROVIDER_NAME,
          api: "openai-completions",
          baseUrl: DEFAULT_NEW_API_BASE_URL,
          apiKey,
          models: [{ id: ARCANE_SPARK_MODEL_ID, name: ARCANE_SPARK_PROVIDER_NAME, vision: true }],
        }
      : {
          id,
          name: String(input.name ?? "").trim() || id,
          api: String(input.api ?? "openai-completions"),
          baseUrl: String(input.baseUrl ?? "").trim(),
          apiKey,
          models,
        };
    if (existing) {
      Object.assign(existing, record);
    } else {
      this.data.providers.push(record);
    }
    this.save();
    return { ok: true };
  }

  removeProvider(id) {
    if (id === ARCANE_SPARK_PROVIDER_ID) {
      return { ok: false, error: err("err.provider.sparkProtected") };
    }
    const before = this.data.providers.length;
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    if (this.data.defaultModel?.providerId === id) this.data.defaultModel = null;
    if (this.data.providers.length !== before) {
      this.save();
      return { ok: true };
    }
    return { ok: false, error: err("err.provider.notFound") };
  }

  setDefaultModel(providerId, modelId) {
    this.data.defaultModel = providerId && modelId ? { providerId, modelId } : null;
    this.save();
  }

  /** 把全部 provider 注册进 ModelRuntime。失败单个跳过,不影响其它。 */
  applyToRuntime(modelRuntime) {
    if (!modelRuntime) return;
    for (const p of this.data.providers) {
      try {
        modelRuntime.registerProvider(p.id, {
          name: p.name ?? p.id,
          baseUrl: p.baseUrl || undefined,
          apiKey: p.apiKey || undefined,
          api: p.api ?? "openai-completions",
          authHeader: true,
          models: (p.models ?? []).map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            reasoning: Boolean(m.reasoning),
            input: m.vision ? ["text", "image"] : ["text"],
            cost: { ...ZERO_COST },
            contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
          })),
        });
      } catch (error) {
        this.log(`[providers] register ${p.id} failed:`, error.message);
      }
    }
  }
}
