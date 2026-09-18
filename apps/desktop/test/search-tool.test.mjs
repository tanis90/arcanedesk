import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import test from "node:test";

import { AgentHost } from "../src/main/agent-host.js";
import { SearchBudget } from "../src/main/search/budget.js";
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

function buildHost({ store, fetchImpl, profileMode = "prep" } = {}) {
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
        spark: () => SPARK,
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

test("first search succeeds without confirmation; hard cap and run reset behave", async () => {
  const store = makeStore({ mode: "spark" });
  const { impl, calls } = stubFetch(OK_BODY);
  const { host } = buildHost({ store, fetchImpl: impl });
  host.searchBudget = new SearchBudget({ soft: 5, hard: 1 }); // 注入小上限

  const tool = host.buildTools().find((t) => t.name === "web_search");
  // 无首次确认闸:配置完成即外发。
  const first = await tool.execute("c1", { query: "first query" }, undefined);
  assert.equal(first.isError, undefined);
  assert.equal(calls.length, 1);

  // 第二条触发硬上限。
  const second = await tool.execute("c2", { query: "second query" }, undefined);
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /budget for this turn is exhausted/);

  // agent_start 语义:新一轮 run 预算重置。
  host.resetSearchRun();
  const third = await tool.execute("c3", { query: "third query" }, undefined);
  assert.equal(third.isError, undefined);
});
