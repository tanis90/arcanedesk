import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import test from "node:test";

import { AgentHost } from "../src/main/agent-host.js";
import { SearchStore } from "../src/main/search/store.js";
import { testSecretStorage } from "./test-secret-storage.mjs";

const scratch = mkdtempSync(path.join(os.tmpdir(), "arcane-search-tool-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const SPARK = { apiKey: "sk-spark-9999", baseUrl: "https://llm.example/v1" };

function stubFetch(body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { impl, calls };
}

const OK_BODY = JSON.stringify({
  search_results: [
    { title: "dnd5e 5.3.4", url: "https://foundryvtt.com/a", content: "notes", publish_date: "2026-08-30" },
  ],
  requestId: "req-1",
});

function buildHost({ store, fetchImpl, profileMode = "prep", ownChatKeys = null, spark = true } = {}) {
  const events = [];
  const host = new AgentHost({
    foundryRuntime: { call: async () => ({}) },
    operationStorageDir: mkdtempSync(path.join(scratch, "session-")),
    getFoundryView: () => null,
    openFoundry: async () => ({ ok: true, summary: "open" }),
    sendToRenderer: (payload) => events.push(payload),
    log: () => {},
    profile: { mode: profileMode, getCwd: () => scratch },
    ...(store ? {
      search: {
        store,
        spark: () => (spark ? SPARK : null),
        ...(ownChatKeys ? { ownChatKeys: () => ownChatKeys() } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      },
    } : {}),
  });
  host.describeCurrent = () => ({ id: "session-1" });
  return { host, events };
}

function makeStore(mode, spark) {
  const store = new SearchStore(path.join(scratch, `search-${Math.random().toString(36).slice(2)}.json`), () => {}, testSecretStorage());
  if (mode) store.update(mode, spark);
  return store;
}

test("web_search joins the tool pool only when search is configured and usable", () => {
  const off = buildHost({ store: makeStore({ mode: "off" }) });
  assert.equal(off.host.buildTools().some((tool) => tool.name === "web_search"), false);

  const sparkMode = buildHost({ store: makeStore({ mode: "spark" }) });
  // spark 模式 usable(有 Spark 凭据)即进池;凭据缺失时 store.usable 为 false。
  assert.equal(sparkMode.host.buildTools().some((tool) => tool.name === "web_search"), true);

  const none = buildHost({});
  assert.equal(none.host.buildTools().some((tool) => tool.name === "web_search"), false);
});

test("web_search execute returns structured payload and emits search_usage", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl } = stubFetch(OK_BODY);
  const { host, events } = buildHost({ store, fetchImpl: impl });

  const tool = host.buildTools().find((t) => t.name === "web_search");
  const result = await tool.execute("call-1", { query: "foundry v13 dnd5e", count: 5 }, undefined);

  assert.equal(result.isError, undefined);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0].url, "https://foundryvtt.com/a");
  assert.equal(parsed.meta.backend, "spark");
  assert.deepEqual(result.details.results, parsed.results);
  const usage = events.find((event) => event.type === "search_usage");
  assert.equal(usage.data.used, 1);
  assert.equal(usage.data.backend, "spark");
  assert.equal(usage.data.sessionId, "session-1");
});

test("agent_start resets the cache so the same query goes out again", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl, calls } = stubFetch(OK_BODY);
  const { host } = buildHost({ store, fetchImpl: impl });

  const tool = host.buildTools().find((t) => t.name === "web_search");
  // 无首次确认闸：配置完成即外发。
  const first = await tool.execute("c1", { query: "same query" }, undefined);
  assert.equal(first.isError, undefined);
  assert.equal(calls.length, 1);

  // 同 run 同 query：缓存短路，不再发包。
  const second = await tool.execute("c2", { query: "same query" }, undefined);
  assert.equal(second.isError, undefined);
  assert.equal(calls.length, 1);

  // agent_start 语义：新一轮 run 缓存清空，同 query 重新发包。
  host.resetSearchRun();
  const third = await tool.execute("c3", { query: "same query" }, undefined);
  assert.equal(third.isError, undefined);
  assert.equal(calls.length, 2);
});

const DEEPSEEK_BODY = JSON.stringify({
  results: [
    { title: "dnd5e 5.3.4", url: "https://foundryvtt.com/a", snippet: "notes", date: "2026-08-30", authority: "official" },
  ],
});

test("a user's own DeepSeek key brings web_search online without Spark", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl, calls } = stubFetch(DEEPSEEK_BODY);
  const { host, events } = buildHost({
    store,
    fetchImpl: impl,
    spark: false,
    ownChatKeys: () => ({ deepseek: { apiKey: "sk-deepseek-user", baseUrl: "https://api.deepseek.com/v1" } }),
  });

  const tool = host.buildTools().find((t) => t.name === "web_search");
  assert.ok(tool, "web_search should join the pool when only a DeepSeek key exists");
  const result = await tool.execute("c1", { query: "dnd5e 5.3.4" }, undefined);

  assert.equal(result.isError, undefined);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-deepseek-user");
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.meta.backend, "deepseek");
  const usage = events.find((event) => event.type === "search_usage");
  assert.equal(usage.data.backend, "deepseek");
});

test("saving a DeepSeek key mid-session takes effect on the next execute", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl, calls } = stubFetch(DEEPSEEK_BODY);
  let deepseek = null;
  const { host } = buildHost({ store, fetchImpl: impl, spark: false, ownChatKeys: () => ({ deepseek }) });

  // 构建工具池时还没有任何凭据:工具不注册。
  assert.equal(host.buildTools().some((t) => t.name === "web_search"), false);

  // 会话进行中用户在模型页保存了 DeepSeek key:工具池不重建，
  // 但 next 会话/下一次 attach 会重新走 buildTools()，并拿到新凭据。
  deepseek = { apiKey: "sk-deepseek-user", baseUrl: "https://api.deepseek.com/v1" };
  const tools = host.buildTools();
  const tool = tools.find((t) => t.name === "web_search");
  assert.ok(tool);

  // 执行时再改 key（不重建工具池）：下一次 execute 直接用新 key，无需重开会话。
  const first = await tool.execute("c1", { query: "first" }, undefined);
  assert.equal(first.isError, undefined);
  assert.equal(calls.length, 1);

  deepseek = { apiKey: "sk-deepseek-rotated", baseUrl: "https://api.deepseek.com/v1" };
  const second = await tool.execute("c2", { query: "second" }, undefined);
  assert.equal(second.isError, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.Authorization, "Bearer sk-deepseek-rotated");
});

test("spark stays the fallback when the DeepSeek key is removed mid-session", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl, calls } = stubFetch(OK_BODY);
  let deepseek = { apiKey: "sk-deepseek-user" };
  const { host } = buildHost({ store, fetchImpl: impl, ownChatKeys: () => ({ deepseek }) });

  const tool = host.buildTools().find((t) => t.name === "web_search");
  await tool.execute("c1", { query: "first" }, undefined);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");

  // 删除 DeepSeek provider 后回到既有 Spark relay 路径。
  deepseek = null;
  const second = await tool.execute("c2", { query: "second" }, undefined);
  assert.equal(second.isError, undefined);
  assert.equal(calls[1].url, "https://llm.example/v1/search");
  assert.equal(calls[1].init.headers.Authorization, "Bearer sk-spark-9999");
});

test("spark mode without spark and without deepseek keeps web_search out of the pool", () => {
  const store = makeStore({ mode: "spark" });
  const { host } = buildHost({ store, spark: false, ownChatKeys: () => ({ deepseek: null }) });
  assert.equal(host.buildTools().some((t) => t.name === "web_search"), false);
});

test("off mode keeps the tool out of the pool even with a DeepSeek key", () => {
  const store = makeStore({ mode: "off" });
  const { host } = buildHost({
    store,
    spark: false,
    ownChatKeys: () => ({ deepseek: { apiKey: "sk-deepseek-user" } }),
  });
  assert.equal(host.buildTools().some((t) => t.name === "web_search"), false);
});
