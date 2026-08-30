import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { TelemetryUploader } from "../src/main/telemetry/telemetry-uploader.js";

const INSTALLATION = "ins_00112233445566778899aabbccddeeff";

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), "arcane-telemetry-uploader-"));
  const queue = join(dir, "queue");
  mkdirSync(queue, { recursive: true });
  return { dir, queue };
}

function seedReady(queue, name = "20260827T081500Z_0001.ready.jsonl", lines = 2) {
  const body =
    Array.from({ length: lines }, (_, i) => JSON.stringify({ event: "app.started", seq: i })).join("\n") + "\n";
  writeFileSync(join(queue, name), body);
}

function makeUploader(dir, handler, endpoint = "https://api.test") {
  return new TelemetryUploader({
    telemetryDir: dir,
    getEndpoint: () => endpoint,
    getInstallationId: () => INSTALLATION,
    fetchImpl: handler,
  });
}

test("successful ack deletes the ready file and sends gzip NDJSON with contract headers", async () => {
  const { dir, queue } = tempEnv();
  seedReady(queue);
  let seen = null;
  const uploader = makeUploader(dir, async (url, init) => {
    seen = { url, headers: init.headers, body: init.body };
    return { ok: true, json: async () => ({ accepted: true, batchId: "20260827T081500Z_0001" }) };
  });
  await uploader.attempt();
  uploader.stop();
  assert.equal(seen.url, "https://api.test/v1/telemetry/batches");
  assert.equal(seen.headers["Content-Encoding"], "gzip");
  assert.equal(seen.headers.Authorization, `Bearer ${INSTALLATION}`);
  assert.equal(seen.headers["X-Arcane-Batch-Id"], "20260827T081500Z_0001");
  assert.equal(seen.headers["X-Arcane-Schema-Version"], "1");
  const roundTripped = gunzipSync(seen.body).toString("utf8");
  assert.ok(roundTripped.startsWith('{"event":"app.started"'));
  assert.equal(readdirSync(queue).length, 0); // 只有匹配 ack 后才删
});

test("accepted ack for a different batch never deletes the ready file", async () => {
  const { dir, queue } = tempEnv();
  seedReady(queue);
  const uploader = makeUploader(dir, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ accepted: true, batchId: "different_batch" }),
  }));
  await uploader.attempt();
  uploader.stop();
  assert.equal(readdirSync(queue).length, 1);
});

test("4xx schema rejection deletes the unrecoverable file", async () => {
  const { dir, queue } = tempEnv();
  seedReady(queue);
  const uploader = makeUploader(dir, async () => ({
    ok: false,
    status: 400,
    json: async () => ({ accepted: false, error: "forbidden_key" }),
  }));
  await uploader.attempt();
  uploader.stop();
  assert.equal(readdirSync(queue).length, 0);
  assert.equal(existsSync(join(dir, "quarantine")), false);
});

test("5xx keeps the file for retry", async () => {
  const { dir, queue } = tempEnv();
  seedReady(queue);
  const uploader = makeUploader(dir, async () => ({ ok: false, status: 503 }));
  await uploader.attempt();
  uploader.stop();
  assert.equal(readdirSync(queue).length, 1); // 未 ack,文件保留
});

test("network failure keeps the file for retry", async () => {
  const { dir, queue } = tempEnv();
  seedReady(queue);
  const uploader = makeUploader(dir, async () => {
    throw new Error("ECONNREFUSED");
  });
  await uploader.attempt();
  uploader.stop();
  assert.equal(readdirSync(queue).length, 1);
});

test("no endpoint configured is a no-op", async () => {
  const { dir, queue } = tempEnv();
  seedReady(queue);
  let called = false;
  const uploader = makeUploader(
    dir,
    async () => {
      called = true;
      return { ok: true, json: async () => ({ accepted: true }) };
    },
    null
  );
  await uploader.attempt();
  uploader.stop();
  assert.equal(called, false);
  assert.equal(readdirSync(queue).length, 1);
});
