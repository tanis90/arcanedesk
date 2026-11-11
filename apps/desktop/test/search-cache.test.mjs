import assert from "node:assert/strict";
import test from "node:test";

import { normalizeQuery, SearchRunCache } from "../src/main/search/cache.js";
import { sanitizeParams } from "../src/main/search/index.js";
import { SearchError } from "../src/main/search/errors.js";

test("normalizeQuery collapses whitespace and lowercases ASCII only", () => {
  assert.equal(normalizeQuery("  Foundry   VTT v13 "), "foundry vtt v13");
  assert.equal(normalizeQuery("法师 诡术 咒法"), "法师 诡术 咒法");
});

test("sanitizeParams clamps count to 1..20 and validates freshness/domains", () => {
  assert.deepEqual(
    sanitizeParams({ query: "foundry v13", count: 99, freshness: "month", domains: ["FoundryVTT.COM", ""] }),
    { query: "foundry v13", count: 20, freshness: "month", domains: ["foundryvtt.com"] },
  );
  assert.deepEqual(
    sanitizeParams({ query: "dnd5e errata", count: 0, freshness: "decade" }),
    { query: "dnd5e errata", count: 1, freshness: null, domains: [] },
  );
  assert.deepEqual(sanitizeParams({ query: "defaults" }), { query: "defaults", count: 5, freshness: null, domains: [] });
  assert.throws(() => sanitizeParams({ query: "a" }), SearchError);
});

test("cache: dedupe hit returns cache without counting", () => {
  const cache = new SearchRunCache();
  cache.reset("run-1");
  cache.record("run-1", "Foundry  V13", "payload-a");
  assert.equal(cache.used("run-1"), 1);
  assert.equal(cache.lookup("run-1", "foundry v13"), "payload-a");
  assert.equal(cache.lookup("run-1", "other query"), null);
});

test("cache: usage count keeps growing without any cap", () => {
  const cache = new SearchRunCache();
  cache.reset("run-1");
  for (let i = 0; i < 25; i += 1) cache.record("run-1", `q${i}`, `p${i}`);
  assert.equal(cache.used("run-1"), 25);
  assert.equal(cache.lookup("run-1", "q24"), "p24");
});

test("cache: reset on a new run key isolates counters; unknown keys auto-start", () => {
  const cache = new SearchRunCache();
  cache.reset("run-1");
  cache.record("run-1", "q", "p");
  assert.equal(cache.used("run-2"), 0);
  assert.equal(cache.used("run-1"), 1);
  assert.equal(cache.lookup("run-2", "q"), null); // 缓存不跨 run
  cache.reset("run-1"); // 幂等：不清掉已记账数
  assert.equal(cache.used("run-1"), 1);
});

test("cache: clear drops all runs", () => {
  const cache = new SearchRunCache();
  cache.reset("run-1");
  cache.record("run-1", "q", "p");
  cache.clear();
  assert.equal(cache.used("run-1"), 0);
  assert.equal(cache.lookup("run-1", "q"), null);
});

test("SearchError.toIpc maps code to err.search.* keys with backend param", () => {
  const error = new SearchError("quotaExceeded", { backend: "spark", used: "10" });
  assert.deepEqual(error.toIpc(), {
    key: "err.search.quotaExceeded",
    params: { backend: "spark", used: "10" },
  });
  assert.deepEqual(new SearchError("empty", { backend: "zai" }).toIpc(), {
    key: "err.search.empty",
    params: { backend: "zai" },
  });
});
