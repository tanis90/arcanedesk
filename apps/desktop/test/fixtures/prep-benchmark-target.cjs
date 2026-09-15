const assert = require("node:assert/strict");
module.exports = name => {
  assert.ok(["qa-a", "local-cos"].includes(name), "Explicit known benchmark target required");
  return name === "local-cos"
    ? { name, origin: process.env.ARCANE_FVTT_ORIGIN ?? "http://127.0.0.1:30000", port: Number(process.env.ARCANE_FVTT_CDP_PORT ?? 9230), worldId: "COS" }
    : { name, origin: "http://127.0.0.1:30101", port: 9231, worldId: "cos-a" };
};
