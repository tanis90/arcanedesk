import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import test from "node:test";

import { AgentHost } from "../src/main/agent-host.js";
import { activeToolNamesForPool } from "../src/main/foundry-tool-policy.js";
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

const FETCH_OK_BODY = JSON.stringify({
  title: "dnd5e 5.3.4",
  content: "# Release notes\n\n- fixed A",
});

function stubFetchRaw(cases) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const match = cases.shift();
    if (!match) throw new Error("unexpected fetch call");
    return new Response(match.body ?? "", {
      status: match.status ?? 200,
      headers: { "Content-Type": "application/json", ...(match.headers ?? {}) },
    });
  };
  return { impl, calls };
}

test("web_fetch joins the pool alongside web_search and reads a page", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl, calls } = stubFetchRaw([{ body: FETCH_OK_BODY }]);
  const { host } = buildHost({
    store,
    fetchImpl: impl,
    spark: false,
    ownChatKeys: () => ({ deepseek: { apiKey: "sk-deepseek-user" } }),
  });

  const tools = host.buildTools();
  assert.equal(tools.some((t) => t.name === "web_search"), true);
  const fetchTool = tools.find((t) => t.name === "web_fetch");
  assert.ok(fetchTool, "web_fetch should be registered with a DeepSeek key");

  const result = await fetchTool.execute("f1", { url: "https://foundryvtt.com/releases/5.3.4" }, undefined);
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/fetch");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-deepseek-user");
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.title, "dnd5e 5.3.4");
  assert.match(parsed.content, /Release notes/);
  assert.equal(result.details.title, "dnd5e 5.3.4");
});

test("web_fetch is absent when search credentials are not configured", () => {
  const store = makeStore({ mode: "spark" });
  const { host } = buildHost({ store, spark: false, ownChatKeys: () => ({ deepseek: null }) });
  const tools = host.buildTools();
  assert.equal(tools.some((t) => t.name === "web_search"), false);
  assert.equal(tools.some((t) => t.name === "web_fetch"), false);
});

test("web_fetch is prep-only, never in the combat pool", () => {
  const store = makeStore({ mode: "spark" });
  const { host } = buildHost({
    store,
    profileMode: "combat",
    ownChatKeys: () => ({ deepseek: { apiKey: "sk-deepseek-user" } }),
  });
  const tools = host.buildTools();
  // buildTools 是两种模式的并集,per-mode 激活由 activeToolNamesForPool 决定。
  assert.equal(tools.some((t) => t.name === "web_fetch"), true);
  assert.equal(activeToolNamesForPool("combat", tools).includes("web_fetch"), false);
  assert.equal(activeToolNamesForPool("prep", tools).includes("web_fetch"), true);
});

test("web_fetch returns a recoverable isError result with model guidance", async () => {
  const store = makeStore({ mode: "spark" });
  // relay 未部署：404 非 JSON 体。
  const { impl } = stubFetchRaw([{ status: 404, body: "Not Found" }]);
  const { host, events } = buildHost({ store, fetchImpl: impl });

  const tool = host.buildTools().find((t) => t.name === "web_fetch");
  const result = await tool.execute("f1", { url: "https://example.com/a" }, undefined);
  assert.equal(result.isError, true);
  assert.equal(result.details.error, "fetchUnavailable");
  assert.match(result.content[0].text, /Could not retrieve readable content/);
  const emitted = events.find((event) => event.type === "search_error");
  assert.equal(emitted.data.code, "fetchUnavailable");
});

test("web_fetch rejects local schemes before any network call", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl, calls } = stubFetchRaw([]);
  const { host } = buildHost({ store, fetchImpl: impl });

  const tool = host.buildTools().find((t) => t.name === "web_fetch");
  const result = await tool.execute("f1", { url: "file:///C:/Windows/win.ini" }, undefined);
  assert.equal(result.isError, true);
  assert.equal(result.details.error, "badRequest");
  assert.match(result.content[0].text, /Invalid URL/);
  assert.equal(calls.length, 0);
});

test("web_fetch rate limiting tells the model to back off", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl } = stubFetchRaw([{
    status: 503,
    headers: { "Retry-After": "5" },
    body: JSON.stringify({ error: { code: "upstream_rate_limited" } }),
  }]);
  const { host } = buildHost({ store, fetchImpl: impl });

  const tool = host.buildTools().find((t) => t.name === "web_fetch");
  const result = await tool.execute("f1", { url: "https://example.com/a" }, undefined);
  assert.equal(result.isError, true);
  assert.equal(result.details.error, "rateLimited");
  assert.match(result.content[0].text, /rate-limited/);
  assert.match(result.content[0].text, /5s/);
});

test("every BYOK backend registers web_fetch alongside web_search", () => {
  // zai(网页阅读 API) 与 deepseek 都有抓取能力;只搜不抓的后端才该被挡在池外。
  for (const [backend, key] of [["zai", "zai-key-1234"], ["deepseek", "deepseek-key-1234"]]) {
    const store = makeStore({ mode: "byok", byokBackend: backend, apiKey: key });
    const { host } = buildHost({ store, spark: false });
    const tools = host.buildTools();
    assert.equal(tools.some((t) => t.name === "web_search"), true, `${backend} keeps search`);
    assert.equal(tools.some((t) => t.name === "web_fetch"), true, `${backend} registers fetch`);
  }
});

test("a DeepSeek key with non-ASCII characters fails as authFailed before any request", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl, calls } = stubFetch(DEEPSEEK_BODY);
  const { host, events } = buildHost({
    store,
    fetchImpl: impl,
    spark: false,
    // 真实事故形态：IME 把 key 第 4 位打成 零。
    ownChatKeys: () => ({ deepseek: { apiKey: "sk-零eekseek-user" } }),
  });

  const tool = host.buildTools().find((t) => t.name === "web_search");
  assert.ok(tool, "坏 key 不挡工具注册；错误必须可执行");
  const result = await tool.execute("c1", { query: "dnd5e" }, undefined);
  assert.equal(result.isError, true);
  assert.equal(result.details.error, "authFailed");
  assert.match(result.content[0].text, /authentication failed/i);
  assert.equal(calls.length, 0, "坏 key 不发包");
  const emitted = events.find((event) => event.type === "search_error");
  assert.equal(emitted.data.code, "authFailed");
});

test("web_fetch with a non-ASCII key fails as authFailed before any request", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl, calls } = stubFetchRaw([]);
  const { host } = buildHost({
    store,
    fetchImpl: impl,
    spark: false,
    ownChatKeys: () => ({ deepseek: { apiKey: "sk-零eekseek-user" } }),
  });

  const tool = host.buildTools().find((t) => t.name === "web_fetch");
  const result = await tool.execute("f1", { url: "https://example.com/a" }, undefined);
  assert.equal(result.isError, true);
  assert.equal(result.details.error, "authFailed");
  assert.match(result.content[0].text, /authentication failed/i);
  assert.equal(calls.length, 0);
});

test("byok deepseek without a stored key executes via the chat DeepSeek key", async () => {
  const store = makeStore({ mode: "byok", byokBackend: "deepseek" });
  const { impl, calls } = stubFetch(DEEPSEEK_BODY);
  const { host } = buildHost({
    store,
    fetchImpl: impl,
    spark: false,
    ownChatKeys: () => ({ deepseek: { apiKey: "sk-deepseek-user" } }),
  });

  const tool = host.buildTools().find((t) => t.name === "web_search");
  assert.ok(tool, "byok/deepseek 缺省复用聊天 key 即注册");
  const result = await tool.execute("c1", { query: "dnd5e" }, undefined);
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-deepseek-user");
});
