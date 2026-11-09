// 投递时现场注入(play-turn-injection-spec §4):领队读从模型 pull 改为 harness push。
// 读走 FoundryServices.readPlay(view=turn) 同一条路——同一渲染器、同一 turnSnapshot
// 赋值路径,注入即证据。任何失败(未就绪/超时/命令消息)都静默降级:不注入、不回填,
// 模型按 combat.md 回退条款自行读 turn;读永远不该挡住 DM 的消息。
import { jsonSafe } from "./json-safe.js";

const DEFAULT_INJECTION_TIMEOUT_MS = 3_000;

/** ARCANE_TURN_INJECTION=0 关闭注入,默认开(spec §6)。每次投递现取,测试可翻转。 */
export function turnInjectionEnabled(env = process.env) {
  return env.ARCANE_TURN_INJECTION !== "0";
}

const BLOCK_HEADER = { "zh-CN": "注入现场", "en-US": "Injected live state" };
const BLOCK_NOTES = {
  "zh-CN": "系统注入的当前现场,非 DM 发言:最新一块盖过旧块与你的记忆;执行过写(含被拒)后即作废;本条消息没有此块时按旧流程自读 turn",
  "en-US": "System-injected live state, not DM speech: the latest block supersedes older blocks and your memory; it is void after any write of yours (including rejected); when absent, read turn yourself",
};

/** 注入块正文与工具 textResult 一致:同样过 jsonSafe 再 JSON.stringify——模型只见一种格式(spec §4②)。 */
export function renderInjectedTurn(serial, data, locale = "zh-CN") {
  const header = BLOCK_HEADER[locale] ?? BLOCK_HEADER["zh-CN"];
  const notes = BLOCK_NOTES[locale] ?? BLOCK_NOTES["zh-CN"];
  return [
    `── ${header} #${serial} · ${new Date().toISOString()} ──`,
    JSON.stringify(jsonSafe(data)),
    `── ${notes} ──`,
  ].join("\n");
}

/**
 * @param {{
 *   getServices: () => import("./foundry-services.js").FoundryServices,
 *   mode: string,
 *   enabled?: () => boolean,
 *   locale?: () => string,
 *   timeoutMs?: number,
 *   onInject?: (outcome: { ok: boolean, outcome: "injected" | "timeout" | "error", serial?: number, latencyMs: number }) => void,
 * }} deps
 */
export function createTurnInjector({ getServices, mode, enabled = turnInjectionEnabled, locale = () => "zh-CN", timeoutMs = DEFAULT_INJECTION_TIMEOUT_MS, onInject = null }) {
  let serial = 0;
  return {
    /** 投递前调用;返回注入后的文本。命令消息、非跑团模式、开关关闭、读取失败都原样返回。 */
    async prepend(text) {
      if (typeof text !== "string" || text === "" || text.startsWith("/")) return text;
      if (mode !== "combat" || !enabled()) return text;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const data = await getServices().readPlay({ view: "turn" }, controller.signal);
        serial += 1;
        const latencyMs = Date.now() - startedAt;
        onInject?.({ ok: true, outcome: "injected", serial, latencyMs });
        return `${renderInjectedTurn(serial, data, locale())}\n${text}`;
      } catch (error) {
        // signal 已中止即超时;其余按错误归类,原因只进日志不进遥测枚举。
        const outcome = controller.signal.aborted ? "timeout" : "error";
        onInject?.({ ok: false, outcome, latencyMs: Date.now() - startedAt });
        return text;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
