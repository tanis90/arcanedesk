#!/usr/bin/env node
// e2e-verify-version.mjs — 换装重启后核对应用版本（M3 本地 E2E 终点）。
// 用法：node scripts/e2e-verify-version.mjs <expectedVersion>
// 连接 --remote-debugging-port=9222 上的应用，读取 window.arcane.updateState()
// 的 currentVersion，与期望版本比对；不匹配退出码 1。
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.E2E_CDP_PORT ?? 9222);
const expected = process.argv[2];
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(expected ?? "")) {
  console.error("usage: e2e-verify-version.mjs <expectedVersion>");
  process.exit(2);
}

async function fetchJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} ${path}`);
  return res.json();
}

async function evaluate(page, expression) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP evaluate timeout")), 30_000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }, { once: true });
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
        expression, returnByValue: true, awaitPromise: true,
      } }));
    });
    if (result.exceptionDetails) throw new Error("page exception");
    return result.result?.value;
  } finally {
    ws.close();
  }
}

async function main() {
  // 换装重启需要时间：轮询 CDP 端点直到应用重新出现。
  const deadline = Date.now() + 120_000;
  let page = null;
  for (;;) {
    try {
      const targets = await fetchJson("/json/list");
      page = targets.find((t) => t.type === "page" && /index\.html/.test(t.url));
      if (page) break;
    } catch { /* 未就绪 */ }
    if (Date.now() > deadline) throw new Error("app did not come back after install");
    await delay(1_000);
  }
  const res = await evaluate(page, "window.arcane.updateState()");
  const actual = res?.state?.currentVersion;
  console.log(`currentVersion=${actual} expected=${expected}`);
  if (actual !== expected) {
    console.error("VERSION MISMATCH");
    process.exit(1);
  }
  console.log("E2E PASS: version changed after restart-install");
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
