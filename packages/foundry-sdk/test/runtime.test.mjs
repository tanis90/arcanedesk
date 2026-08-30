import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  protocolVersion,
  runtimeFunction,
  runtimeHash,
  runtimeVersion,
} from "../dist/runtime.js";

test("runtime subpath exports the canonical runtime and integrity metadata", () => {
  assert.equal(protocolVersion, 2);
  assert.equal(runtimeVersion, "0.1.0");
  assert.ok(runtimeFunction.startsWith("\nasync function (action, args, options)"));
  assert.equal(
    runtimeHash,
    createHash("sha256").update(runtimeFunction, "utf8").digest("hex"),
  );
});

test("runtime subpath exposes exactly the stable names", async () => {
  const exports = await import("../dist/runtime.js");
  assert.deepEqual(Object.keys(exports).sort(), [
    "protocolVersion",
    "runtimeFunction",
    "runtimeHash",
    "runtimeVersion",
  ]);
});

test("the package declares no runtime dependencies and publishes all stable subpaths", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.name, "@arcanedesk/foundry-sdk");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    ".",
    "./client",
    "./contracts",
    "./package.json",
    "./runtime",
    "./runtime-helpers",
  ]);
});
