import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createR2Client,
  parseArgs,
  platformForFile,
  resolvePublishRegion,
  resolveTarget,
  stageFromDist,
  uploadObject,
  verifyUrl,
} from "../scripts/publish-release.mjs";

test("release publisher maps only supported desktop artifact names", () => {
  assert.equal(platformForFile("Arcane-Desk-0.1.0-mac-arm64.dmg"), "macos-arm64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-mac-x64.zip"), "macos-x64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-win-x64.exe"), "windows-x64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-win-arm64.zip"), "windows-arm64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-win-x64.exe.blockmap"), null);
});

test("release publisher maps intl-flavored artifact names (D5 dual track)", () => {
  assert.equal(platformForFile("Arcane-Desk-0.1.0-mac-arm64-intl.dmg"), "macos-arm64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-mac-x64-intl.zip"), "macos-x64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-win-x64-intl.exe"), "windows-x64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-win-arm64-intl.zip"), "windows-arm64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-win-x64-intl.exe.blockmap"), null);
});

test("release publisher rejects typoed options and unsupported platforms", () => {
  assert.deepEqual(parseArgs([
    "--staging", "stage",
    "--release-id", "0.1.0-test",
    "--platforms", "windows-x64,windows-arm64",
    "--skip-latest",
  ]), {
    staging: "stage",
    releaseId: "0.1.0-test",
    platforms: ["windows-x64", "windows-arm64"],
    skipLatest: true,
  });
  assert.throws(() => parseArgs(["--skip-lates"]), /unknown option/);
  assert.throws(() => parseArgs(["--platforms", "linux-x64"]), /unsupported platform/);
  assert.throws(
    () => parseArgs(["--staging", "stage", "--from-dist", "dist"]),
    /only one/,
  );
  assert.deepEqual(parseArgs(["--promote-release", "0.1.0-stable"]), {
    promoteRelease: "0.1.0-stable",
  });
  assert.throws(
    () => parseArgs(["--promote-release", "old", "--staging", "stage"]),
    /cannot be combined/,
  );
});

test("release publisher parses --region and --signed-dir", () => {
  assert.deepEqual(parseArgs(["--staging", "stage", "--region", "intl", "--signed-dir", "signed"]), {
    staging: "stage",
    region: "intl",
    signedDir: "signed",
  });
  assert.throws(() => parseArgs(["--region", "us"]), /unsupported region/);
  assert.throws(() => parseArgs(["--region"]), /requires a value/);
  assert.throws(
    () => parseArgs(["--promote-release", "0.1.0", "--signed-dir", "signed"]),
    /cannot be combined/,
  );
});

test("publish targets: cn keeps OSS, intl goes to R2 behind dl.arcanedesk.app", () => {
  assert.deepEqual(resolveTarget("cn"), {
    clientKind: "oss",
    bucket: "arcane-package",
    baseUrl: "https://arcane-package.oss-cn-beijing.aliyuncs.com",
    releaseRoot: "desktop/arcane-desk/releases",
    latestKey: "desktop/arcane-desk/latest.json",
    repoLatestFile: "desktop-latest.json",
    skillsRoot: "desktop/arcane-desk/skills",
  });
  assert.deepEqual(resolveTarget("intl"), {
    clientKind: "r2",
    bucket: "arcane-desk-intl",
    baseUrl: "https://dl.arcanedesk.app",
    releaseRoot: "desktop/arcane-desk-intl/releases",
    latestKey: "desktop/arcane-desk-intl/latest.json",
    repoLatestFile: "desktop-latest-intl.json",
    skillsRoot: "desktop/arcane-desk-intl/skills",
  });
  assert.throws(() => resolveTarget("us"), /unknown publish region/);
});

test("publish region resolution: explicit flag > region.json > cn, conflicts rejected", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-region-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const missing = path.join(dir, "nope.json");
  const intlFile = path.join(dir, "region.json");
  await fsp.writeFile(intlFile, JSON.stringify({ schemaVersion: 1, region: "intl" }), "utf8");

  assert.equal(resolvePublishRegion({}, missing), "cn");
  assert.equal(resolvePublishRegion({}, intlFile), "intl");
  assert.equal(resolvePublishRegion({ region: "intl" }, missing), "intl");
  assert.equal(resolvePublishRegion({ region: "intl" }, intlFile), "intl");
  assert.throws(() => resolvePublishRegion({ region: "cn" }, intlFile), /disagrees/);
  assert.throws(() => resolvePublishRegion({ region: "us" }, missing), /--region/);
});

test("immutable uploads ask OSS to reject same-key overwrites", async () => {
  const calls = [];
  const client = {
    put: async (...args) => calls.push(["put", ...args]),
    multipartUpload: async (...args) => calls.push(["multipart", ...args]),
  };
  await uploadObject(client, {
    key: "desktop/arcane-desk/releases/test/release.json",
    body: "{}\n",
    bytes: 3,
    cache: "immutable",
    contentType: "application/json",
    immutable: true,
  });
  await uploadObject(client, {
    key: "desktop/arcane-desk/latest.json",
    body: "{}\n",
    bytes: 3,
    cache: "no-cache",
    contentType: "application/json",
  });
  await uploadObject(client, {
    key: "desktop/arcane-desk/releases/test/app.zip",
    file: "app.zip",
    bytes: 33 * 1024 * 1024,
    cache: "immutable",
    contentType: "application/zip",
    immutable: true,
  });

  assert.equal(calls[0][3].headers["x-oss-forbid-overwrite"], "true");
  assert.equal(calls[1][3].headers["x-oss-forbid-overwrite"], undefined);
  assert.equal(calls[2][3].headers["x-oss-forbid-overwrite"], "true");
});

test("R2 uploads never send the OSS-only forbid-overwrite header", async () => {
  const calls = [];
  const client = {
    kind: "r2",
    put: async (...args) => calls.push(["put", ...args]),
    multipartUpload: async (...args) => calls.push(["multipart", ...args]),
  };
  await uploadObject(client, {
    key: "desktop/arcane-desk-intl/releases/test/release.json",
    body: "{}\n",
    bytes: 3,
    cache: "immutable",
    contentType: "application/json",
    immutable: true,
  });
  assert.equal(calls[0][3].headers["x-oss-forbid-overwrite"], undefined);
});

test("R2 client requires credentials", async () => {
  const saved = {
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  };
  delete process.env.CF_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  try {
    await assert.rejects(() => createR2Client(), /missing R2 credentials/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function fakeResponse(status, { headers = {}, body = "" } = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

test("R2 put signs SigV4 with path-style URL and auto region", async () => {
  const requests = [];
  const client = await createR2Client({
    accountId: "acct123",
    bucket: "arcane-desk-intl",
    accessKeyId: "R2KEY",
    secretAccessKey: "r2secret",
    now: () => new Date("2026-09-10T20:07:00.000Z"),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return fakeResponse(200);
    },
  });

  await client.put("desktop/arcane-desk-intl/latest.json", Buffer.from("{}\n"), {
    headers: { "Cache-Control": "no-cache", "Content-Type": "application/json; charset=utf-8" },
  });

  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(init.method, "PUT");
  assert.equal(url, "https://acct123.r2.cloudflarestorage.com/arcane-desk-intl/desktop/arcane-desk-intl/latest.json");
  assert.equal(init.headers["x-amz-date"], "20260910T200700Z");
  const payloadHash = crypto.createHash("sha256").update(Buffer.from("{}\n")).digest("hex");
  assert.equal(init.headers["x-amz-content-sha256"], payloadHash);

  // 独立复算签名（同一规范、独立实现），防止接线错误（顺序/范围/字段）。
  const amzDate = "20260910T200700Z";
  const scope = "20260910/auto/s3/aws4_request";
  const canonicalHeaders = `host:acct123.r2.cloudflarestorage.com\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = [
    "PUT",
    "/arcane-desk-intl/desktop/arcane-desk-intl/latest.json",
    "",
    canonicalHeaders,
    "host;x-amz-content-sha256;x-amz-date",
    payloadHash,
  ].join("\n");
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac("AWS4r2secret", "20260910"), "auto"), "s3"), "aws4_request");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const expectedSignature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  assert.equal(
    init.headers.authorization,
    `AWS4-HMAC-SHA256 Credential=R2KEY/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${expectedSignature}`,
  );
});

test("R2 head surfaces a 404 status for the immutability pre-check", async () => {
  const client = await createR2Client({
    accountId: "acct123",
    bucket: "arcane-desk-intl",
    accessKeyId: "R2KEY",
    secretAccessKey: "r2secret",
    fetchImpl: async () => fakeResponse(404, { body: "NoSuchKey" }),
  });
  await assert.rejects(
    () => client.head("desktop/arcane-desk-intl/releases/x/release.json"),
    (error) => error.status === 404 && /HTTP 404/.test(error.message),
  );
});

test("R2 multipart upload creates, uploads parts, and completes", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-r2-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "big.bin");
  const size = 5 * 1024 * 1024 + 7;
  await fsp.writeFile(file, crypto.randomBytes(size));

  const calls = [];
  const client = await createR2Client({
    accountId: "acct123",
    bucket: "arcane-desk-intl",
    accessKeyId: "R2KEY",
    secretAccessKey: "r2secret",
    now: () => new Date("2026-09-10T20:07:00.000Z"),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("?uploads=")) {
        return fakeResponse(200, { body: `<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>` });
      }
      if (init.method === "PUT") {
        return fakeResponse(200, { headers: { etag: `"etag-${calls.length}"` } });
      }
      return fakeResponse(200, { body: "<CompleteMultipartUploadResult/>" });
    },
  });

  await client.multipartUpload("desktop/arcane-desk-intl/releases/x/big.bin", file, { partSize: 2 * 1024 * 1024 });

  assert.equal(calls.length, 1 + 3 + 1);
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].url, /\?uploads=$/);
  for (let part = 1; part <= 3; part += 1) {
    assert.equal(calls[part].init.method, "PUT");
    assert.match(calls[part].url, /\?partNumber=\d&uploadId=upload-1$/);
    const expectedLength = part < 3 ? 2 * 1024 * 1024 : 1 * 1024 * 1024 + 7;
    assert.equal(calls[part].init.body.length, expectedLength);
  }
  const complete = calls[4];
  assert.equal(complete.init.method, "POST");
  assert.match(complete.url, /\?uploadId=upload-1$/);
  const xml = complete.init.body.toString("utf8");
  assert.match(xml, /<CompleteMultipartUpload>/);
  assert.equal((xml.match(/<PartNumber>/g) ?? []).length, 3);
  assert.match(xml, /<ETag>"etag-4"<\/ETag>/);
});

test("R2 multipart aborts when a part fails", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-r2-abort-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "big.bin");
  await fsp.writeFile(file, crypto.randomBytes(3 * 1024 * 1024));

  const methods = [];
  const client = await createR2Client({
    accountId: "acct123",
    bucket: "arcane-desk-intl",
    accessKeyId: "R2KEY",
    secretAccessKey: "r2secret",
    fetchImpl: async (url, init) => {
      methods.push(init.method);
      if (init.method === "PUT") return fakeResponse(503, { body: "SlowDown" });
      return fakeResponse(200, { body: "<InitiateMultipartUploadResult><UploadId>u2</UploadId></InitiateMultipartUploadResult>" });
    },
  });

  await assert.rejects(
    () => client.multipartUpload("k", file, { partSize: 1024 * 1024 }),
    /HTTP 503/,
  );
  assert.deepEqual(methods, ["POST", "PUT", "DELETE"]);
});

test("--signed-dir overlays signed artifacts before hashing (sign-first-then-publish)", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-staging-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const dist = path.join(dir, "dist");
  const signed = path.join(dir, "signed");
  await fsp.mkdir(dist);
  await fsp.mkdir(signed);
  await fsp.writeFile(path.join(dist, "Arcane-Desk-9.9.9-win-x64.exe"), "unsigned-exe");
  await fsp.writeFile(path.join(dist, "Arcane-Desk-9.9.9-win-x64.zip"), "zip-bytes");
  await fsp.writeFile(path.join(signed, "Arcane-Desk-9.9.9-win-x64.exe"), "signed-exe");

  const staging = await stageFromDist(dist, ["windows-x64"], signed);
  const exe = staging.find((s) => s.file.endsWith(".exe"));
  assert.equal(exe.file, path.join(signed, "Arcane-Desk-9.9.9-win-x64.exe"));

  const sums = await fsp.readFile(path.join(dist, "SHA256SUMS-windows-x64.txt"), "utf8");
  const signedSha = crypto.createHash("sha256").update("signed-exe").digest("hex");
  const zipSha = crypto.createHash("sha256").update("zip-bytes").digest("hex");
  assert.equal(sums, `${signedSha}  Arcane-Desk-9.9.9-win-x64.exe\n${zipSha}  Arcane-Desk-9.9.9-win-x64.zip\n`);
});

test("--signed-dir fails when an installer has no signed copy", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-staging-miss-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const dist = path.join(dir, "dist");
  const signed = path.join(dir, "signed");
  await fsp.mkdir(dist);
  await fsp.mkdir(signed);
  await fsp.writeFile(path.join(dist, "Arcane-Desk-9.9.9-win-x64.exe"), "unsigned-exe");

  await assert.rejects(
    () => stageFromDist(dist, ["windows-x64"], signed),
    /signed copy missing for Arcane-Desk-9\.9\.9-win-x64\.exe/,
  );
});

test("release verifier requests identity encoding for exact OSS content length", async (t) => {
  let acceptEncoding;
  const server = http.createServer((request, response) => {
    acceptEncoding = request.headers["accept-encoding"];
    response.writeHead(200, { "content-length": "6611" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));

  const { port } = server.address();
  assert.equal(await verifyUrl(`http://127.0.0.1:${port}/release.json`, 6611), true);
  assert.equal(acceptEncoding, "identity");
});
