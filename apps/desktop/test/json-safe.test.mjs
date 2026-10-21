import assert from "node:assert/strict";
import test from "node:test";

import { jsonSafe } from "../src/main/json-safe.js";

test("jsonSafe clones plain values unchanged", () => {
  const value = { a: 1, b: [true, null, "x"], c: { d: 2 } };
  const safe = jsonSafe(value);
  assert.deepEqual(safe, value);
  assert.notEqual(safe, value);
});

test("jsonSafe marks circular references instead of throwing", () => {
  const root = { actor: { system: { attributes: {} } }, count: 2n };
  root.actor.system.attributes.hd = root.actor;
  const safe = jsonSafe(root);
  assert.equal(safe.actor.system.attributes.hd, "[Circular]");
  assert.equal(safe.count, "2");
  assert.doesNotThrow(() => JSON.stringify(safe));
});

test("jsonSafe passes undefined through", () => {
  assert.equal(jsonSafe(undefined), undefined);
});
