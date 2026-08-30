// ProviderCatalog — 内置 provider 预设与模型视觉能力表(provider-catalog.json)。
// 解决 pi 的缺省陷阱:模型定义不显式声明 input 就按 ["text"] 处理,图片被静默降级。
// 这里给设置页两个能力:① 选预设自动带出模型清单;② 已知模型自动预勾 vision。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { err } from "./i18n-error.mjs";

const catalogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "provider-catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

const visionPatterns = (catalog.vision?.patterns ?? []).map((p) => new RegExp(p, "i"));
const visionExact = new Map(Object.entries(catalog.vision?.exact ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

/** 模型是否支持图片输入:exact 实测表优先,其次启发式 pattern,默认 false(保守)。 */
export function resolveVision(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  if (visionExact.has(id)) return visionExact.get(id);
  return visionPatterns.some((re) => re.test(id));
}

/** 给设置页的预设视图:模型清单带上 vision 预勾;nameEn 供英文界面取显示名。 */
export function listPresets() {
  return catalog.providers.map((p) => ({
    id: p.id,
    name: p.name,
    nameEn: p.nameEn ?? null,
    api: p.api,
    baseUrl: p.baseUrl,
    models: (p.models ?? []).map((id) => ({ id, vision: resolveVision(id) })),
  }));
}

/**
 * 用 API key 调 OpenAI 兼容端点的 GET /models 拉取可用模型,逐个标注 vision。
 * 仅支持 openai-completions 类端点;其他 API 类型(anthropic/google)由调用方拦截。
 */
export async function fetchModels({ baseUrl, apiKey }) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return { ok: false, error: err("err.fetch.needBaseUrl") };
  if (!apiKey) return { ok: false, error: err("err.fetch.needApiKey") };
  let res;
  try {
    res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return { ok: false, error: err("err.fetch.requestFailed", { error: error.message }) };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.error?.message ?? JSON.stringify(body)?.slice(0, 200) ?? "";
    return { ok: false, error: `HTTP ${res.status} ${detail}`.trim() };
  }
  const ids = (body?.data ?? []).map((m) => m?.id).filter(Boolean);
  if (ids.length === 0) return { ok: false, error: err("err.fetch.noModels") };
  return { ok: true, models: ids.sort().map((id) => ({ id, vision: resolveVision(id) })) };
}
