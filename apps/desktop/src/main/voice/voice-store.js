// VoiceStore — 语音识别(ASR)配置持久化,照抄 ProviderStore 的模式。
// 数据存在 userData/config/voice.json。prompt/hotwords 的默认值就是 preset.js 的
// D&D 预设:配置里缺这两个键时补预设;用户保存后以配置为准(包括清空)。
//
// 单 Key 语义:provider=arcane-relay 时 apiKey/baseUrl 留空 = 跟随 Arcane Spark
// (providers.json 的内置 provider),聊天与语音共用一张发放的 sk- Key;
// 显式填写才算覆盖；renderer 始终只接收掩码。
import { readFileSync, writeFileSync } from "node:fs";
import { VOICE_PRESET } from "./preset.js";
import { DEFAULT_NEW_API_BASE_URL } from "../providers.js";
import { createUnavailableSecretStorage } from "../secret-storage.js";

const MAX_HOTWORDS = 100; // 智谱 GLM-ASR-2512 hotwords 上限
const DEFAULT_HOLD_KEY = "F9"; // 长按模式默认键;chord 语法见 renderer/shortcuts.js
const PROVIDERS = new Set(["zhipu", "arcane-relay"]);

/** chord 字符串,空串 = 不绑定。 */
function normalizeKey(value, fallback = "") {
  const key = String(value ?? "").trim();
  return key || fallback;
}

/** 中转地址;空串 = 跟随 Arcane Spark,非法输入也归零为跟随。 */
function normalizeBaseUrl(value) {
  const url = String(value ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(url) ? url : "";
}

/**
 * relay 模式的最终凭据:voice 自己的值优先,留空回退 Arcane Spark,
 * 地址再兜底默认网关。spark 形如 {apiKey,baseUrl},可为 null
 * (内置 provider 被移除的极端情况)。
 */
export function resolveRelayCredentials(voiceData, spark) {
  return {
    apiKey: voiceData.apiKey || String(spark?.apiKey ?? ""),
    baseUrl:
      voiceData.baseUrl ||
      String(spark?.baseUrl ?? "") ||
      DEFAULT_NEW_API_BASE_URL,
  };
}

export class VoiceStore {
  constructor(filePath, log = console.log, secretStorage = createUnavailableSecretStorage()) {
    this.filePath = filePath;
    this.log = log;
    this.secretStorage = secretStorage;
    const loaded = this.load();
    this.data = loaded.data;
    if (loaded.needsMigration) this.save();
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      const needsMigration = Object.hasOwn(parsed, "apiKey");
      let apiKey = "";
      try {
        apiKey = parsed.apiKeyProtected
          ? this.secretStorage.reveal(parsed.apiKeyProtected)
          : String(parsed.apiKey ?? "");
      } catch (error) {
        this.log(`[voice] protected API key could not be opened: ${error.message}`);
      }
      // 旧配置迁移:hotkeys 数组的第一条当作长按键
      const legacyHold = Array.isArray(parsed.hotkeys) ? parsed.hotkeys[0] : null;
      return { data: {
        enabled: Boolean(parsed.enabled),
        provider: PROVIDERS.has(parsed.provider) ? parsed.provider : "zhipu",
        apiKey,
        baseUrl: normalizeBaseUrl(parsed.baseUrl),
        prompt: parsed.prompt == null ? VOICE_PRESET.prompt : String(parsed.prompt),
        hotwords: Array.isArray(parsed.hotwords)
          ? parsed.hotwords.map(String).filter(Boolean).slice(0, MAX_HOTWORDS)
          : [...VOICE_PRESET.hotwords],
        holdKey: normalizeKey(parsed.holdKey ?? legacyHold, DEFAULT_HOLD_KEY),
        toggleKey: normalizeKey(parsed.toggleKey),
      }, needsMigration };
    } catch {
      return { data: {
        // 新用户直接继承 Arcane Spark 的接入;只有实际触发录音时才申请麦克风权限。
        enabled: true,
        provider: "arcane-relay",
        apiKey: "",
        baseUrl: "",
        prompt: VOICE_PRESET.prompt,
        hotwords: [...VOICE_PRESET.hotwords],
        holdKey: DEFAULT_HOLD_KEY,
        toggleKey: "",
      }, needsMigration: false };
    }
  }

  save() {
    const { apiKey, ...configuration } = this.data;
    writeFileSync(this.filePath, JSON.stringify({
      schemaVersion: 2,
      ...configuration,
      apiKeyProtected: this.secretStorage.protect(apiKey),
    }, null, 2));
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
    const resolved = relay ? resolveRelayCredentials(this.data, spark) : null;
    const effectiveApiKey = relay ? resolved.apiKey : this.data.apiKey;
    const followsSpark = relay && !this.data.apiKey && Boolean(spark?.apiKey);
    const ownApiKey = this.data.apiKey;
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
      prompt: this.data.prompt,
      hotwords: this.data.hotwords,
      holdKey: this.data.holdKey,
      toggleKey: this.data.toggleKey,
    };
  }

  /** apiKey 语义同 ProviderStore:空字符串或打码值 = 保持原值,否则覆盖。 */
  update(input) {
    const apiKey =
      !input.apiKey || String(input.apiKey).startsWith("••••")
        ? this.data.apiKey
        : String(input.apiKey).trim();
    this.data = {
      enabled: Boolean(input.enabled),
      provider: PROVIDERS.has(input.provider) ? input.provider : "zhipu",
      apiKey,
      // 空串 = 跟随 Arcane Spark;非法输入同样归零为跟随
      baseUrl: normalizeBaseUrl(input.baseUrl),
      prompt: String(input.prompt ?? ""),
      hotwords: (Array.isArray(input.hotwords) ? input.hotwords : [])
        .map((w) => String(w ?? "").trim())
        .filter(Boolean)
        .slice(0, MAX_HOTWORDS),
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
    if (this.data.provider === "arcane-relay") {
      return Boolean(this.data.apiKey || spark?.apiKey);
    }
    return Boolean(this.data.apiKey);
  }
}
