const assert = require("node:assert/strict");
module.exports = name => {
  assert.ok(["qa-a", "local-cos"].includes(name), "Explicit known benchmark target required");
  return name === "local-cos"
    ? { name, origin: "http://127.0.0.1:30000", port: 9230, worldId: "COS" }
    : { name, origin: "http://127.0.0.1:30101", port: 9231, worldId: "cos-a" };
};
