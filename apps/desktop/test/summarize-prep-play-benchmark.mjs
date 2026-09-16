import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const reportPath = process.argv[2];
assert.ok(reportPath, "benchmark report path is required");
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(report.status, "passed", "only a completed run can produce a benchmark summary");
assert.ok(report.samples >= 10, "at least ten interleaved samples are required");
const quantile = (values, percentile) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * percentile) - 1];
const metrics = values => ({ count: values.length, p50: quantile(values, .5), p95: quantile(values, .95), mean: values.reduce((a, b) => a + b, 0) / values.length });
const groups = [];
for (const revision of ["baseline", "candidate"]) for (const turn of [0, 1]) {
  const trials = report.trials.filter(row => row.revision === revision);
  assert.equal(trials.length, report.samples);
  const rows = trials.map(row => row.turns.find(value => value.turn === turn));
  assert.ok(rows.every(row => row.taskState === "completed"));
  groups.push({ revision, turn, totalMs: metrics(rows.map(row => row.ms)), calls: metrics(rows.map(row => row.tools.length)),
    inputTokens: metrics(rows.map(row => row.usage.reduce((n, usage) => n + usage.input + usage.cacheRead + usage.cacheWrite, 0))),
    outputTokens: metrics(rows.map(row => row.usage.reduce((n, usage) => n + usage.output, 0))),
    reasoningTokens: rows.every(row => row.usage.every(usage => Number.isFinite(usage.reasoning)))
      ? metrics(rows.map(row => row.usage.reduce((n, usage) => n + usage.reasoning, 0))) : null,
    heavyReads: rows.map(row => row.tools.filter(tool => ["combat_battle_context", "foundry_static_context"].includes(tool.name)).length),
    toolSequences: rows.map(row => row.tools.map(tool => tool.name)) });
}
const comparisons = [0, 1].map(turn => {
  const base = groups.find(row => row.revision === "baseline" && row.turn === turn);
  const next = groups.find(row => row.revision === "candidate" && row.turn === turn);
  return { turn, p50ChangePercent: (next.totalMs.p50 / base.totalMs.p50 - 1) * 100,
    p95ChangePercent: (next.totalMs.p95 / base.totalMs.p95 - 1) * 100,
    meanCallDifference: next.calls.mean - base.calls.mean,
    latencyNeedsInvestigation: next.totalMs.p50 > base.totalMs.p50 * 1.1 || next.totalMs.p95 > base.totalMs.p95 * 1.1 };
});
const summary = { model: report.model, samples: report.samples, sdkThinkingLevels: [...new Set(report.trials.map(row => row.thinking))],
  conditions: "Same QA-A world/modules/provider, alternating revision order. First and subsequent user instructions are separated. Human wait is zero. Warm connection; independent cold-start network latency is not measured. Reasoning token counts are provider-returned counters, not thinking duration.",
  groups, comparisons,
  runtimePerTwoTurnTrialMs: ["baseline", "candidate"].map(revision => ({ revision,
    ...metrics(report.trials.filter(row => row.revision === revision).map(row => row.runtime.reduce((sum, call) => sum + call.durationMs, 0))) })),
  queueWaitMs: null, humanWaitMs: 0,
  timingLimitations: "Runtime counters include the SDK call lifetime. Queue waiting is not separately instrumented by this runner; it must not be inferred as zero from the serial workload." };
const output = reportPath.replace(/\.json$/, ".summary.json");
await writeFile(output, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ output, comparisons }, null, 2));
