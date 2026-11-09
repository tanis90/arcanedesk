#!/usr/bin/env node
// e2e-drive-update.mjs — 用 CDP 驱动已安装的桌面应用走完整更新流（M3 本地 E2E）。
// 前置：应用已用 --remote-debugging-port=9222 启动，且
// ARCANE_UPDATE_FEED_BASE_URL 指向 e2e-local-feed-server。
//
// 流程：等 available（轮询 window.arcane.updateState()）→ downloadUpdate() →
// 轮询 ready → installUpdate()（应用退出换装）。退出即本脚本终点——
// 「重启后版本变更」由 e2e-verify-version.mjs 在换装后重新连接核对。
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.E2E_CDP_PORT ?? 9222);
const STARTUP_GRACE_MS = Number(process.env.E2E_STARTUP_GRACE_MS ?? 90_000);

async function fetchJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} ${path}`);
  return res.json();
}

async function connectPage() {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const targets = await fetchJson("/json/list");
      const page = targets.find((t) => t.type === "page" && /index\.html/.test(t.url));
      if (page) return page;
    } catch { /* CDP 未就绪 */ }
    if (Date.now() > deadline) throw new Error("no debuggable page found on :9222");
    await delay(500);
  }
}

async function evaluate(page, expression) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  try {
    const id = 1;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP evaluate timeout")), 30_000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id !== id) return;
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }, { once: true });
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {
        expression, returnByValue: true, awaitPromise: true,
      } }));
    });
    if (result.exceptionDetails) {
      throw new Error(`page exception: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`);
    }
    return result.result?.value;
  } finally {
    ws.close();
  }
}

async function waitForState(page, want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await evaluate(page, "window.arcane.updateState()");
    const status = res?.state?.status;
    if (Array.isArray(want) ? want.includes(status) : status === want) return res.state;
    if (Date.now() > deadline) throw new Error(`timeout waiting for state ${want.join?.("/") ?? want}; last=${status}`);
    await delay(1_000);
  }
}

async function main() {
  const page = await connectPage();
  console.log("page:", page.url);
  // 启动例行 check 在 30s+抖动后触发；在宽限期内轮询等 available。
  console.log(`waiting for update_available (grace ${STARTUP_GRACE_MS / 1000}s)…`);
  const available = await waitForState(page, ["available"], STARTUP_GRACE_MS);
  console.log(`available: ${available.currentVersion} → ${available.version}`);
  // 打开浮层同款路径：直接走 bridge（UI 视觉由人工/截图验收）。
  await evaluate(page, "window.arcane.downloadUpdate()");
  const ready = await waitForState(page, ["ready", "error"], 10 * 60_000);
  if (ready.status !== "ready") throw new Error(`download ended in ${ready.status}: ${ready.error}`);
  console.log(`ready: ${ready.version} downloaded & verified`);
  await evaluate(page, "window.arcane.installUpdate()");
  console.log("install triggered — app should quit and reinstall");
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
