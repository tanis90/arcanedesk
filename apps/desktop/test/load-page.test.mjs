import test from "node:test";
import assert from "node:assert/strict";
import { loadPageWithRetry } from "../src/main/load-page.js";

test("connection failure retries once and can succeed", async () => {
  const urls = [];
  await loadPageWithRetry({ isDestroyed: () => false, async loadURL(url) {
    urls.push(url);
    if (urls.length === 1) throw Object.assign(new Error(), { code: "ERR_CONNECTION_REFUSED" });
  } }, "http://localhost:30000");
  assert.deepEqual(urls, ["http://localhost:30000", "http://localhost:30000"]);
});

test("persistent connection failure stops after two attempts", async () => {
  let calls = 0;
  const error = Object.assign(new Error(), { code: "ERR_CONNECTION_RESET" });
  await assert.rejects(loadPageWithRetry({ isDestroyed: () => false, async loadURL() {
    calls++; throw error;
  } }, "http://localhost:30000"), error);
  assert.equal(calls, 2);
});

test("success, aborted navigation, certificate errors and destroyed pages do not retry", async () => {
  for (const [code, destroyed] of [[null, false], ["ERR_ABORTED", false], ["ERR_CERT_AUTHORITY_INVALID", false], ["ERR_CONNECTION_RESET", true]]) {
    let calls = 0;
    const run = loadPageWithRetry({ isDestroyed: () => destroyed, async loadURL() {
      calls++; if (code) throw Object.assign(new Error(), { code });
    } }, "http://localhost:30000");
    if (code) await assert.rejects(run); else await run;
    assert.equal(calls, 1);
  }
});
