import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import {
  applyArcaneFvttOpsEnvironment,
  applyArcaneSubprocessEnvironment,
} from "../src/main/subprocess-env.mjs";

const execFileAsync = promisify(execFile);

test("Windows child processes default Python text handling to UTF-8", () => {
  const env = {};
  assert.equal(applyArcaneSubprocessEnvironment(env, "win32"), env);
  assert.deepEqual(env, {
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  });
});

test("explicit Python encoding choices are preserved", () => {
  const env = {
    PYTHONUTF8: "0",
    PYTHONIOENCODING: "gbk",
  };
  applyArcaneSubprocessEnvironment(env, "win32");
  assert.deepEqual(env, {
    PYTHONUTF8: "0",
    PYTHONIOENCODING: "gbk",
  });
});

test("non-Windows child process environments are unchanged", () => {
  const env = { EXISTING: "value" };
  applyArcaneSubprocessEnvironment(env, "darwin");
  assert.deepEqual(env, { EXISTING: "value" });
});

test("FVTT Ops Node is explicit and first on the Windows Agent PATH", () => {
  const env = {
    Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
    PATH: "C:\\duplicate-path-key",
  };
  const nodeBinary = "C:\\Users\\dm\\AppData\\Local\\ArcaneDesk\\runtime\\node\\22.23.2\\win-x64\\node.exe";
  assert.equal(applyArcaneFvttOpsEnvironment(env, nodeBinary, "win32"), env);
  assert.equal(env.ARCANE_FVTT_NODE, nodeBinary);
  assert.equal(
    env.Path,
    "C:\\Users\\dm\\AppData\\Local\\ArcaneDesk\\runtime\\node\\22.23.2\\win-x64;" +
      "C:\\Windows\\System32;C:\\Program Files\\nodejs;C:\\duplicate-path-key",
  );
  assert.equal("PATH" in env, false);
});

test("FVTT Ops Node replaces a stale duplicate without editing the system environment", () => {
  const env = {
    PATH: "/usr/local/bin:/opt/arcane/node/22.23.2/darwin-arm64/bin:/usr/bin",
  };
  const nodeBinary = "/opt/arcane/node/22.23.2/darwin-arm64/bin/node";
  applyArcaneFvttOpsEnvironment(env, nodeBinary, "darwin");
  assert.equal(env.ARCANE_FVTT_NODE, nodeBinary);
  assert.equal(env.PATH, "/opt/arcane/node/22.23.2/darwin-arm64/bin:/usr/local/bin:/usr/bin");
});

test("FVTT Ops Node rejects relative executable paths", () => {
  assert.throws(
    () => applyArcaneFvttOpsEnvironment({}, "runtime/node.exe", "win32"),
    /absolute executable path/,
  );
});

test("the Windows defaults produce UTF-8 Python streams and implicit text files", async () => {
  const env = applyArcaneSubprocessEnvironment({ ...process.env }, "win32");
  const program = [
    "import json, locale, sys",
    "print(json.dumps({",
    "  'utf8_mode': sys.flags.utf8_mode,",
    "  'stdout': sys.stdout.encoding.lower().replace('-', ''),",
    "  'preferred': locale.getpreferredencoding(False).lower().replace('-', ''),",
    "  'chinese': '中文正常',",
    "}, ensure_ascii=False))",
  ].join("\n");
  const { stdout } = await execFileAsync("python", ["-c", program], {
    env,
    encoding: "utf8",
  });
  const result = JSON.parse(stdout);
  assert.deepEqual(result, {
    utf8_mode: 1,
    stdout: "utf8",
    preferred: "utf8",
    chinese: "中文正常",
  });
});
