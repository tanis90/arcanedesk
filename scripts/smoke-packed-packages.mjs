#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = resolve(tmpdir());
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("Run this gate through npm so npm_execpath identifies the active locked npm CLI.");
}

const scratch = mkdtempSync(join(temporaryRoot, "arcane-desk-pack-smoke-"));

if (!scratch.startsWith(`${temporaryRoot}${sep}`)) {
  throw new Error(`Refusing to use a scratch directory outside the OS temp root: ${scratch}`);
}

function run(command, args, cwd, capture = false) {
  return execFileSync(command, args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    windowsHide: true,
  });
}

function runNpm(args, cwd, capture = false) {
  return run(process.execPath, [npmCli, ...args], cwd, capture);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

try {
  const packageDirectory = join(scratch, "packages");
  mkdirSync(packageDirectory);

  for (const workspace of ["@arcanedesk/foundry-sdk", "@arcanedesk/fvtt-cli"]) {
    runNpm(
      ["pack", "--silent", "--workspace", workspace, "--pack-destination", packageDirectory],
      repositoryRoot,
    );
  }

  const tarballs = readdirSync(packageDirectory)
    .filter((file) => file.endsWith(".tgz"))
    .sort();
  assert.equal(tarballs.length, 2, "exactly two npm package tarballs must be produced");

  const sdkTarball = tarballs.find((file) => file.includes("foundry-sdk"));
  const cliTarball = tarballs.find((file) => file.includes("fvtt-cli"));
  assert.ok(sdkTarball, "SDK tarball is missing");
  assert.ok(cliTarball, "CLI tarball is missing");

  const consumerDirectory = join(scratch, "consumer");
  mkdirSync(consumerDirectory);
  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({
      name: "arcane-desk-package-consumer-smoke",
      version: "0.0.0",
      private: true,
      type: "module",
    }, null, 2)}\n`,
  );

  runNpm(
    [
      "install",
      "--no-audit",
      "--no-fund",
      join(packageDirectory, sdkTarball),
      join(packageDirectory, cliTarball),
    ],
    consumerDirectory,
  );

  writeFileSync(
    join(consumerDirectory, "smoke.mjs"),
    `import assert from "node:assert/strict";

const root = await import("@arcanedesk/foundry-sdk");
const client = await import("@arcanedesk/foundry-sdk/client");
const contracts = await import("@arcanedesk/foundry-sdk/contracts");
const runtime = await import("@arcanedesk/foundry-sdk/runtime");
const helpers = await import("@arcanedesk/foundry-sdk/runtime-helpers");
const sdkPackage = await import("@arcanedesk/foundry-sdk/package.json", { with: { type: "json" } });
const cliPackage = await import("@arcanedesk/fvtt-cli/package.json", { with: { type: "json" } });

assert.equal(typeof root.FoundryRuntimeClient, "function");
assert.equal(typeof client.FoundryRuntimeClient, "function");
assert.equal(contracts.ALL_DIRECT_ACTIONS.length, 28);
assert.equal(contracts.READ_DIRECT_ACTIONS.length, 11);
assert.equal(contracts.WRITE_DIRECT_ACTIONS.length, 17);
assert.equal(runtime.runtimeHash, "827e008b48d07962d587fd0e97d8292bc454c47437c79a6f1a82e9680ad3a8fb");
assert.equal(typeof helpers.serializeTurnResponseV2, "function");
assert.equal(sdkPackage.default.name, "@arcanedesk/foundry-sdk");
assert.equal(cliPackage.default.name, "@arcanedesk/fvtt-cli");

for (const specifier of [
  "@arcanedesk/fvtt-cli",
  "@arcanedesk/fvtt-cli/dist/foundry-runtime.js",
]) {
  await assert.rejects(import(specifier), (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
}
`,
  );

  run(process.execPath, [join(consumerDirectory, "smoke.mjs")], consumerDirectory);
  const help = runNpm(["exec", "--", "arcane-fvtt", "--help"], consumerDirectory, true);
  assert.match(help, /--target-id <id>/, "installed CLI help must expose exact target selection");

  const result = tarballs.map((file) => {
    const absolute = join(packageDirectory, file);
    return {
      file,
      bytes: statSync(absolute).size,
      sha256: sha256(absolute),
    };
  });
  process.stdout.write(`${JSON.stringify({ ok: true, packages: result }, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
