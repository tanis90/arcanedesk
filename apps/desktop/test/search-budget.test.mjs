import assert from "node:assert/strict";
import test from "node:test";

import { normalizeQuery, SearchBudget } from "../src/main/search/budget.js";
import { sanitizeParams } from "../src/main/search/index.js";
import { SearchError } from "../src/main/search/errors.js";

test("normalizeQuery collapses whitespace and lowercases ASCII only", () => {
  assert.equal(normalizeQuery("  Foundry   VTT v13 "), "foundry vtt v13");
  assert.equal(normalizeQuery("法师 诡术 咒法"), "法师 诡术 咒法");
});

test("sanitizeParams clamps count to 1..5 and validates freshness/domains", () => {
  assert.deepEqual(
    sanitizeParams({ query: "foundry v13", count: 99, freshness: "month", domains: ["FoundryVTT.COM", ""] }),
    { query: "foundry v13", count: 5, freshness: "month", domains: ["foundryvtt.com"] },
  );
  assert.deepEqual(
    sanitizeParams({ query: "dnd5e errata", count: 0, freshness: "decade" }),
    { query: "dnd5e errata", count: 1, freshness: null, domains: [] },
  );
  assert.throws(() => sanitizeParams({ query: "a" }), SearchError);
});

test("budget: dedupe hit returns cache without counting", () => {
  const budget = new SearchBudget();
  budget.reset("run-1");
  budget.record("run-1", "Foundry  V13", "payload-a");
  assert.equal(budget.used("run-1"), 1);
  assert.equal(budget.lookup("run-1", "foundry v13"), "payload-a");
  assert.equal(budget.lookup("run-1", "other query"), null);
});

test("budget: soft notice flips at the 6th call, hard cap rejects the 11th", () => {
  const budget = new SearchBudget(); // soft 5 / hard 10
  budget.reset("run-1");
  for (let i = 0; i < 5; i += 1) assert.equal(budget.record("run-1", `q${i}`, `p${i}`), false);
  assert.equal(budget.record("run-1", "q5", "p5"), true); // 第 6 次过软阈值
  for (let i = 6; i < 10; i += 1) {
    assert.equal(budget.allow("run-1"), true);
    budget.record("run-1", `q${i}`, `p${i}`);
  }
  assert.equal(budget.allow("run-1"), false); // 已 10 次
  budget.recordMiss("run-1"); // miss 同样计数
  assert.equal(budget.allow("run-1"), false);
});

test("budget: reset on a new run key isolates counters; unknown keys auto-start", () => {
  const budget = new SearchBudget();
  budget.reset("run-1");
  budget.record("run-1", "q", "p");
  assert.equal(budget.used("run-2"), 0);
  assert.equal(budget.used("run-1"), 1);
  assert.equal(budget.lookup("run-2", "q"), null); // 缓存不跨 run
  budget.reset("run-1"); // 幂等：不清掉已记账数
  assert.equal(budget.used("run-1"), 1);
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
