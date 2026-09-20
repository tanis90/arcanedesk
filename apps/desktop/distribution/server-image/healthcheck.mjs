// healthcheck.mjs — 容器 HEALTHCHECK：GET /api/status，断言 version 与钉版一致。
// 我们的镜像就是 hello-world（方案 §3"Docker 安装保障"：全程免 docker pull），
// 所以健康判据不依赖任何外部探针，只用 node 内建 fetch。
import { FOUNDRY_VERSION } from "./pins.mjs";

const STATUS_URL = process.env.ARCANE_STATUS_URL ?? "http://127.0.0.1:30000/api/status";

// /api/status 报两段("13.351"),钉版可能三段("13.351.0")——规范化后比较。
function normalizeVersion(value) {
  const segments = String(value ?? "").split(".").map(Number);
  if (segments.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  while (segments.length < 3) segments.push(0);
  return segments.slice(0, 3).join(".");
}

try {
  const response = await fetch(STATUS_URL, {
    signal: AbortSignal.timeout(4000),
    redirect: "error",
    headers: { "accept": "application/json" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const status = await response.json();
  if (normalizeVersion(status?.version) !== normalizeVersion(FOUNDRY_VERSION)) {
    throw new Error(`serving version ${String(status?.version)}, image pins ${FOUNDRY_VERSION}`);
  }
  process.exit(0);
} catch (error) {
  console.error(`[arcane:healthcheck] ${STATUS_URL} failed: ${error?.message ?? error}`);
  process.exit(1);
}
