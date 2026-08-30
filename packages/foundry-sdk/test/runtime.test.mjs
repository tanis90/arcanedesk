import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  directRuntimeFunction,
  protocolVersion,
  runtimeFunction,
  runtimeHash,
  runtimeSource,
  runtimeVersion,
} from "../dist/runtime.js";

test("runtime subpath exports stable aliases and integrity metadata", () => {
  assert.equal(protocolVersion, 2);
  assert.equal(runtimeVersion, "0.1.0");
  assert.equal(directRuntimeFunction, runtimeFunction);
  assert.equal(runtimeSource, runtimeFunction);
  assert.ok(runtimeSource.startsWith("\nasync function (action, args, options)"));
  assert.equal(
    runtimeHash,
    createHash("sha256").update(runtimeSource, "utf8").digest("hex"),
  );
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
