import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildStoredZip } from "../scripts/make-fake-foundry-zip.mjs";
import { mirrorInstall } from "../skills/prep/arcane-fvtt-mods/scripts/mod-manager.mjs";
import { createModMirrorTools, mapJobsResponse, modsJobsUrl, prepareModule } from "../src/main/mod-mirror-tools.js";

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modManager = path.join(desktopRoot, "skills", "prep", "arcane-fvtt-mods", "scripts", "mod-manager.mjs");

const SPARK = { apiKey: "sk-spark-fixture", baseUrl: "https://llm.example.test/v1" };

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function moduleZip({ id = "demo", version = "2.0.0", title = "Demo" } = {}) {
  return buildStoredZip({
    "module.json": Buffer.from(JSON.stringify({ id, title, version, esmodules: ["scripts/demo.js"] })),
    "scripts/demo.js": Buffer.from("export const ok = true;"),
  });
}

/** 收集请求与响应体，供断言使用。 */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const record = { url: String(url), init };
    calls.push(record);
    const response = await handler(record);
    return response;
  };
  return { impl, calls };
}

function json(value, status = 200) {
  const body = JSON.stringify(value);
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function toolFor(host) {
  return createModMirrorTools(host)[0];
}

// ---------- 工具：五种响应 + 未配置 key ----------

test("foundry_module_prepare posts to the spark origin /v1/mods/jobs with the spark key only in-process", async () => {
  const { impl, calls } = stubFetch(() => json({
    status: "ready", module_id: "demo", title: "Demo", version: "2.0.0",
    download_url: "https://dl.example.test/mods/demo-2.0.0.zip", sha256: "a".repeat(64), size: 1234,
  }));
  const tool = toolFor({ searchDeps: { spark: () => SPARK, fetchImpl: impl } });
  const result = await tool.execute("call", { query: "demo", version: "2.0.0" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://llm.example.test/v1/mods/jobs");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-spark-fixture");
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: "demo", version: "2.0.0" });

  assert.equal(result.details.status, "ready");
  assert.equal(result.details.module_id, "demo");
  assert.equal(result.details.download_url, "https://dl.example.test/mods/demo-2.0.0.zip");
  assert.equal(result.details.sha256, "a".repeat(64));
  assert.equal(result.details.size, 1234);
  assert.match(result.details.user_message, /已就绪/);
  // key 永不进入工具结果（模型上下文/会话快照都看得见它）。
  assert.equal(JSON.stringify(result).includes("sk-spark-fixture"), false);
});

test("preparing response exposes poll_url and tells the agent how to poll", () => {
  const mapped = mapJobsResponse({
    httpStatus: 202,
    body: {
      status: "preparing", job_id: "job-1", poll_url: "https://llm.example.test/v1/mods/jobs/job-1?token=abc",
      retry_after: 3, module_id: "demo", version: "2.0.0",
    },
  });
  assert.equal(mapped.status, "preparing");
  assert.equal(mapped.job_id, "job-1");
  assert.equal(mapped.retry_after, 3);
  assert.match(mapped.poll_url, /token=abc/);
  assert.match(mapped.user_message, /mirror-install/);
});

test("candidates response is thin, capped and asks for an exact id", () => {
  const mapped = mapJobsResponse({
    httpStatus: 200,
    body: { candidates: Array.from({ length: 25 }, (_, index) => ({
      module_id: `demo-${index}`, title: `Demo ${index}`, foundry_v13_ok: true, cached: index === 0, license: "MIT", extra: "dropped",
    })) },
  });
  assert.equal(mapped.status, "candidates");
  assert.equal(mapped.candidates.length, 20);
  assert.deepEqual(Object.keys(mapped.candidates[0]).sort(), ["cached", "foundry_v13_ok", "license", "module_id", "title"]);
  assert.match(mapped.user_message, /module_id/);
});

test("incompatible response names the highest supported Foundry major", () => {
  const mapped = mapJobsResponse({ httpStatus: 200, body: { status: "incompatible", max_foundry: "11", module_id: "demo" } });
  assert.equal(mapped.status, "incompatible");
  assert.equal(mapped.max_foundry, "11");
  assert.match(mapped.user_message, /最高只支持 v11/);
});

test("blocked responses keep the reason and one plain-language message per reason", () => {
  const server = mapJobsResponse({
    httpStatus: 451,
    body: { status: "blocked", reason: "license_proprietary", user_message: "服务端说明", module_id: "demo" },
  });
  assert.equal(server.status, "blocked");
  assert.equal(server.reason, "license_proprietary");
  assert.equal(server.user_message, "服务端说明");
  assert.equal(server.http_status, 451);

  for (const [reason, pattern] of [
    ["license_proprietary", /许可证/],
    ["license_unknown", /没有附带许可证/],
    ["quota", /额度/],
    ["takedown", /下架/],
    ["no_download", /下载地址/],
    ["incompatible", /v13/],
    ["unknown", /无法提供/],
  ]) {
    const mapped = mapJobsResponse({ httpStatus: 451, body: { status: "blocked", reason } });
    assert.equal(mapped.reason, reason);
    assert.match(mapped.user_message, pattern);
  }
  // 未知 reason 收敛到 unknown，不把服务端字符串原样转述成用户话术。
  const unknown = mapJobsResponse({ httpStatus: 451, body: { status: "blocked", reason: "weird_new_reason" } });
  assert.equal(unknown.reason, "unknown");
});

test("HTTP 401/402/410/451 map into blocked semantics instead of transport errors", () => {
  const expectations = [
    [401, "blocked", "unknown"],
    [402, "blocked", "quota"],
    [410, "blocked", "takedown"],
    [451, "blocked", "license_proprietary"],
  ];
  for (const [status, expectedStatus, expectedReason] of expectations) {
    const mapped = mapJobsResponse({ httpStatus: status, body: null });
    assert.equal(mapped.status, expectedStatus, `HTTP ${status}`);
    assert.equal(mapped.reason, expectedReason, `HTTP ${status}`);
    assert.equal(mapped.http_status, status);
    assert.ok(mapped.user_message.length > 0);
  }
});

test("404 with an application JSON body means the catalog has no such module", () => {
  const mapped = mapJobsResponse({ httpStatus: 404, body: { error: "not_found", reason: "not_found" } });
  assert.equal(mapped.status, "blocked");
  assert.equal(mapped.code, "NOT_FOUND");
  assert.equal(mapped.http_status, 404);
  assert.match(mapped.user_message, /镜像目录/);
});

test("404 with a non-JSON body is a gateway-level miss, not an empty catalog", () => {
  // 2026-10-23 教训：llm.* 网关未放行 /v1/mods/jobs 时返回 text/plain 裸 404，
  // 曾被误诊成"镜像目录里没有 bg3-hud"。非 JSON 404 必须报通道不可用。
  const mapped = mapJobsResponse({ httpStatus: 404, body: null });
  assert.equal(mapped.status, "error");
  assert.equal(mapped.code, "MIRROR_UNAVAILABLE");
  assert.equal(mapped.http_status, 404);
  assert.match(mapped.user_message, /稍后再试/);
});

test("an unconfigured spark key returns a structured guidance result without any request", async () => {
  const { impl, calls } = stubFetch(() => json({ status: "ready" }));
  const tool = toolFor({ searchDeps: { spark: () => null, fetchImpl: impl } });
  const result = await tool.execute("call", { query: "demo" });
  assert.equal(calls.length, 0);
  assert.equal(result.details.status, "not_configured");
  assert.equal(result.details.code, "SPARK_NOT_CONFIGURED");
  assert.match(result.details.user_message, /ArcaneSpark/);

  const noDeps = await toolFor({}).execute("call", { query: "demo" });
  assert.equal(noDeps.details.status, "not_configured");
});

test("transport failures and timeouts degrade to a retryable structured result", async () => {
  const failing = await prepareModule({
    query: "demo",
    credential: SPARK,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(failing.status, "error");
  assert.equal(failing.code, "MIRROR_UNAVAILABLE");
  assert.match(failing.user_message, /稍后再试/);
});

test("base URL is derived from the spark origin and only plaintext loopback is allowed", () => {
  assert.equal(modsJobsUrl("https://llm.arcanedesk.bitterbebop.cn/v1"), "https://llm.arcanedesk.bitterbebop.cn/v1/mods/jobs");
  assert.equal(modsJobsUrl("https://llm.arcanedesk.app/v1/"), "https://llm.arcanedesk.app/v1/mods/jobs");
  assert.equal(modsJobsUrl("http://127.0.0.1:38080/v1"), "http://127.0.0.1:38080/v1/mods/jobs");
  assert.throws(() => modsJobsUrl("http://llm.example.test/v1"), /HTTPS/);
  assert.throws(() => modsJobsUrl("https://user:pass@llm.example.test/v1"), /credentials/);
  assert.throws(() => modsJobsUrl(""), /not configured/);
});

// ---------- CLI：hermetic 本地 HTTP mock ----------

async function startMirrorServer(t, { zip, sha, size, statuses = ["ready"] }) {
  const state = { polls: 0, downloads: 0, requests: [] };
  const server = createServer((request, response) => {
    state.requests.push({ method: request.method, url: request.url });
    if (request.url.startsWith("/v1/mods/jobs/job-1")) {
      const status = statuses[Math.min(state.polls, statuses.length - 1)];
      state.polls += 1;
      if (status === "ready") {
        const body = JSON.stringify({
          status: "ready", sha256: sha, size,
          download_url: `${state.origin}/v1/mods/dl/payload/hmac/demo-2.0.0.zip`,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status, retry_after: 0 }));
      return;
    }
    if (request.url.startsWith("/v1/mods/dl/")) {
      state.downloads += 1;
      response.writeHead(200, { "content-type": "application/zip", "content-length": String(zip.length) });
      response.end(zip);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return state;
}

async function makeDataDir(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-mirror-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "foundry-data");
  await mkdir(path.join(dataDir, "Data", "modules"), { recursive: true });
  return { root, dataDir };
}

test("mirror-install polls, downloads, verifies sha256 and installs into Data/modules", async (t) => {
  const zip = moduleZip();
  const { dataDir } = await makeDataDir(t);
  const server = await startMirrorServer(t, { zip, sha: sha256(zip), size: zip.length, statuses: ["queued", "fetching", "ready"] });

  const result = await mirrorInstall({
    pollUrl: `${server.origin}/v1/mods/jobs/job-1?token=fixture`,
    dataDir,
    waitSeconds: 60,
    sleep: async () => {},
  });

  assert.equal(server.polls, 3);
  assert.equal(server.downloads, 1);
  assert.equal(result.installed, true);
  assert.equal(result.id, "demo");
  assert.equal(result.version, "2.0.0");
  assert.equal(result.archiveName, "demo-2.0.0.zip");
  assert.equal(result.archiveSha256, sha256(zip));
  const installed = path.join(dataDir, "Data", "modules", "demo");
  assert.equal(JSON.parse(await readFile(path.join(installed, "module.json"), "utf8")).version, "2.0.0");
});

test("mirror-install rejects a tampered download, deletes the file and exits non-zero", async (t) => {
  const zip = moduleZip();
  const tampered = moduleZip({ title: "Tampered" });
  const { dataDir } = await makeDataDir(t);
  const server = await startMirrorServer(t, { zip: tampered, sha: sha256(zip), size: zip.length });

  await assert.rejects(
    mirrorInstall({ pollUrl: `${server.origin}/v1/mods/jobs/job-1?token=fixture`, dataDir, waitSeconds: 10 }),
    (error) => error.exitCode === 1 && /校验失败：疑似内容被篡改/.test(error.message),
  );
  assert.equal(server.downloads, 1);
  assert.deepEqual(await readdir(path.join(dataDir, "Data", "modules")), []);
});

test("mirror-install gives up on the wait budget with exit code 2 (job keeps preparing)", async (t) => {
  const zip = moduleZip();
  const { dataDir } = await makeDataDir(t);
  const server = await startMirrorServer(t, { zip, sha: sha256(zip), size: zip.length, statuses: ["queued"] });
  await assert.rejects(
    mirrorInstall({ pollUrl: `${server.origin}/v1/mods/jobs/job-1?token=fixture`, dataDir, waitSeconds: 0 }),
    (error) => error.exitCode === 2 && /已排队，稍后重试即秒取/.test(error.message),
  );
  assert.equal(server.downloads, 0);
});

test("mirror-install reports a failed job with exit code 1 and never downloads", async (t) => {
  const zip = moduleZip();
  const { dataDir } = await makeDataDir(t);
  const server = await startMirrorServer(t, { zip, sha: sha256(zip), size: zip.length, statuses: ["failed"] });
  await assert.rejects(
    mirrorInstall({ pollUrl: `${server.origin}/v1/mods/jobs/job-1?token=fixture`, dataDir, waitSeconds: 10 }),
    (error) => error.exitCode === 1 && /job failed/.test(error.message),
  );
  assert.equal(server.downloads, 0);
});

test("the mirror-install CLI process exits 2 when the budget runs out and 1 on a failed job", async (t) => {
  const zip = moduleZip();
  const { dataDir } = await makeDataDir(t);
  const pending = await startMirrorServer(t, { zip, sha: sha256(zip), size: zip.length, statuses: ["queued"] });
  const pendingRun = await execFileAsync(process.execPath, [
    modManager, "mirror-install", "--poll-url", `${pending.origin}/v1/mods/jobs/job-1?token=fixture`,
    "--data-dir", dataDir, "--wait", "0",
  ]).catch((error) => error);
  assert.equal(pendingRun.code, 2);
  assert.match(pendingRun.stderr, /已排队，稍后重试即秒取/);

  const failed = await startMirrorServer(t, { zip, sha: sha256(zip), size: zip.length, statuses: ["failed"] });
  const failedRun = await execFileAsync(process.execPath, [
    modManager, "mirror-install", "--poll-url", `${failed.origin}/v1/mods/jobs/job-1?token=fixture`,
    "--data-dir", dataDir, "--wait", "5",
  ]).catch((error) => error);
  assert.equal(failedRun.code, 1);
  assert.match(failedRun.stderr, /mirror job failed/);
});

test("the CLI help documents mirror-install without changing the direct-install commands", async () => {
  const { stdout } = await execFileAsync(process.execPath, [modManager, "help"]);
  assert.match(stdout, /mirror-install --poll-url/);
  assert.match(stdout, /--github-mirror-prefix/);
  assert.match(stdout, /local-stage/);
});

test("mirror-install refuses a non-loopback plaintext poll URL before any request", async (t) => {
  const { dataDir } = await makeDataDir(t);
  let requested = 0;
  await assert.rejects(
    mirrorInstall({
      pollUrl: "http://mirror.example.test/v1/mods/jobs/job-1?token=fixture",
      dataDir,
      fetchImpl: async () => { requested += 1; return new Response("{}"); },
    }),
    /HTTPS/,
  );
  assert.equal(requested, 0);
});
