// ASR provider 层 — 两条链路共用智谱 GLM-ASR-2512(唯一同时支持 prompt+hotwords
// 且接入简单的);字节 Seed-ASR 留 P2(需要 TOS 上传管线,见 voice-input-plan.md)。
//
// 智谱契约:POST multipart/form-data,file 仅支持 wav/mp3 且 ≤30s;
// hotwords 用重复字段传(与 Python requests 的 list 值编码一致,voice-ime 已验证)。
//
// arcane-relay:走 Arcane NewAPI 中转站(与聊天同一张发放 sk- key,按次扣配额)。
// 网关原样透传 multipart 字段(含 hotwords/prompt),上游仍是智谱,响应格式一致;
// 凭据只由主进程解析和发送，不进入 renderer。
// 面向用户的错误抛 I18nError(key 见 shared/i18n/messages.js 的 err.asr.*)。

import { I18nError } from "../i18n-error.mjs";

const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions";
const MODEL = "glm-asr-2512";
const TIMEOUT_MS = 30_000;

function buildForm({ wavBuffer, prompt, hotwords }) {
  const form = new FormData();
  form.append("model", MODEL);
  form.append("stream", "false");
  if (prompt) form.append("prompt", prompt);
  for (const w of hotwords ?? []) form.append("hotwords", w);
  form.append("file", new Blob([/** @type {BlobPart} */ (wavBuffer)], { type: "audio/wav" }), "voice.wav");
  return form;
}

async function postTranscription(url, apiKey, form) {
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new I18nError("err.asr.requestFailed", { error: error.message });
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new I18nError("err.asr.httpError", { status: resp.status, detail: body.slice(0, 200) });
  }
  const data = await resp.json();
  return { text: String(data.text ?? ""), latency: (Date.now() - t0) / 1000 };
}

/** 智谱直连。 */
export async function transcribeZhipu({ apiKey, wavBuffer, prompt, hotwords }) {
  return postTranscription(ZHIPU_URL, apiKey, buildForm({ wavBuffer, prompt, hotwords }));
}

/** OpenAI-compatible relay; the official endpoint can be replaced with a self-hosted baseUrl. */
export async function transcribeRelay({ apiKey, baseUrl, wavBuffer, prompt, hotwords }) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new I18nError("err.asr.badRelayUrl");
  return postTranscription(
    `${base}/audio/transcriptions`,
    apiKey,
    buildForm({ wavBuffer, prompt, hotwords }),
  );
}

/** 按 provider 分发;"zhipu" 之外的值都按中转处理前先显式判断,避免拼错静默走直连。 */
export async function transcribe(opts) {
  if (opts.provider === "arcane-relay") return transcribeRelay(opts);
  return transcribeZhipu(opts);
}
