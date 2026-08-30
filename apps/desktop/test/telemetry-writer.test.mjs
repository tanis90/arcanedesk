import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TelemetryWriter } from "../src/main/telemetry/telemetry-writer.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "arcane-telemetry-writer-"));
}

function line(seq) {
  return JSON.stringify({ schema_version: 1, event: "app.started", seq, data: {} });
}

async function settle(writer) {
  await writer.flush(); // 只等队列落盘,不触发退出的轮转语义
}

function totalTelemetryBytes(dir) {
  let total = 0;
  for (const child of ["queue", "quarantine"]) {
    const childDir = join(dir, child);
    if (!existsSync(childDir)) continue;
    for (const name of readdirSync(childDir)) total += statSync(join(childDir, name)).size;
  }
  return total;
}

test("appends events as newline-delimited JSON in an open file", async () => {
  const dir = tempDir();
  const writer = new TelemetryWriter(dir);
  await writer.start();
  writer.append(JSON.parse(line(1)));
  writer.append(JSON.parse(line(2)));
  await settle(writer);
  const files = readdirSync(join(dir, "queue"));
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith(".open.jsonl"));
  const body = readFileSync(join(dir, "queue", files[0]), "utf8");
  assert.equal(body.split("\n").filter(Boolean).length, 2);
});

test("rotates to ready when the per-file event cap is hit", async () => {
  const dir = tempDir();
  const writer = new TelemetryWriter(dir, { maxFileEvents: 2 });
  await writer.start();
  for (let i = 1; i <= 5; i++) writer.append(JSON.parse(line(i)));
  await settle(writer);
  const files = readdirSync(join(dir, "queue")).sort();
  assert.equal(files.length, 3); // 2+2 已封盘,第 3 个还在写
  assert.ok(files[0].endsWith(".ready.jsonl"));
  assert.ok(files[1].endsWith(".ready.jsonl"));
  assert.ok(files[2].endsWith(".open.jsonl"));
  assert.equal(readFileSync(join(dir, "queue", files[0]), "utf8").split("\n").filter(Boolean).length, 2);
});

test("hard cap is enforced after every rotation", async () => {
  const dir = tempDir();
  const capBytes = 250;
  const writer = new TelemetryWriter(dir, { maxFileEvents: 1, capBytes });
  await writer.start();
  for (let i = 1; i <= 20; i++) writer.append(JSON.parse(line(i)));
  await settle(writer);
  assert.ok(totalTelemetryBytes(dir) <= capBytes);
  assert.ok(readdirSync(join(dir, "queue")).every((name) => name.endsWith(".ready.jsonl")));
});

test("hard cap counts queue and quarantine together", async () => {
  const dir = tempDir();
  const queue = join(dir, "queue");
  const quarantine = join(dir, "quarantine");
  mkdirSync(queue, { recursive: true });
  mkdirSync(quarantine, { recursive: true });
  const quarantined = join(quarantine, "old.open.jsonl");
  const ready = join(queue, "new.ready.jsonl");
  writeFileSync(quarantined, "q".repeat(200));
  writeFileSync(ready, "r".repeat(200));
  utimesSync(quarantined, new Date(1_000), new Date(1_000));
  utimesSync(ready, new Date(2_000), new Date(2_000));

  const writer = new TelemetryWriter(dir, { capBytes: 250 });
  await writer.start();
  assert.ok(totalTelemetryBytes(dir) <= 250);
  assert.equal(readdirSync(quarantine).length, 0);
  assert.deepEqual(readdirSync(queue), ["new.ready.jsonl"]);
});

test("crash recovery keeps the valid prefix and drops the partial tail line", async () => {
  const dir = tempDir();
  const queue = join(dir, "queue");
  mkdirSync(queue, { recursive: true });
  // 两行完整 + 一行残缺(崩溃时写了一半,无换行)
  writeFileSync(join(queue, "20260827T081500Z_0001.open.jsonl"), `${line(1)}\n${line(2)}\n${line(3).slice(0, 20)}`);
  const writer = new TelemetryWriter(dir);
  await writer.start();
  const ready = readdirSync(queue);
  assert.equal(ready.length, 1);
  assert.ok(ready[0].endsWith(".ready.jsonl"));
  const body = readFileSync(join(queue, ready[0]), "utf8");
  assert.equal(body.split("\n").filter(Boolean).length, 2);
});

test("an invalid middle line quarantines the whole file", async () => {
  const dir = tempDir();
  const queue = join(dir, "queue");
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(queue, "20260827T081500Z_0001.open.jsonl"), `${line(1)}\nnot-json\n${line(2)}\n`);
  const writer = new TelemetryWriter(dir);
  await writer.start();
  assert.equal(readdirSync(queue).length, 0);
  assert.equal(readdirSync(join(dir, "quarantine")).length, 1);
});

test("empty leftover open file is deleted on recovery", async () => {
  const dir = tempDir();
  const queue = join(dir, "queue");
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(queue, "20260827T081500Z_0001.open.jsonl"), "");
  const writer = new TelemetryWriter(dir);
  await writer.start();
  assert.equal(readdirSync(queue).length, 0);
});

test("deleteAll removes queued and quarantined files (consent off)", async () => {
  const dir = tempDir();
  const writer = new TelemetryWriter(dir, { maxFileEvents: 1 });
  await writer.start();
  writer.append(JSON.parse(line(1)));
  writer.append(JSON.parse(line(2)));
  await settle(writer);
  assert.ok(readdirSync(join(dir, "queue")).length > 0);
  await writer.deleteAll();
  assert.equal(readdirSync(join(dir, "queue")).length, 0);
  assert.equal(readdirSync(join(dir, "quarantine")).length, 0);
  assert.ok(!existsSync(join(dir, "queue", "x"))); // 目录保留,内容清空
});
