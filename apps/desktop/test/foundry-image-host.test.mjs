import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/main/agent-host.js";

test("production image decoder unwraps the navigation-safe result and rejects failed reads", async t => {
  const directory = mkdtempSync(join(tmpdir(), "arcane-image-host-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const page = new EventEmitter();
  page.isDestroyed = () => false;
  page.executeJavaScript = async () => ({ width: 64, height: 32 });
  const host = new AgentHost({ operationStorageDir: directory, getFoundryView: () => ({ webContents: page }), log() {} });
  host.describeCurrent = () => ({ id: "image-test" });
  const decoder = host.foundryServices().decodeImage;
  assert.deepEqual(await decoder(Buffer.from("fixture"), "image/png"), { width: 64, height: 32 });
  page.executeJavaScript = async () => { throw Error("decode error"); };
  await assert.rejects(decoder(Buffer.from("fixture"), "image/png"), /IMAGE_DECODE_FAILED/);
});
