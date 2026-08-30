import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { parseArgs, platformForFile, uploadObject, verifyUrl } from "../scripts/publish-release.mjs";

test("release publisher maps only supported desktop artifact names", () => {
  assert.equal(platformForFile("Arcane-Desk-0.1.0-mac-arm64.dmg"), "macos-arm64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-mac-x64.zip"), "macos-x64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-win-x64.exe"), "windows-x64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-win-arm64.zip"), "windows-arm64");
  assert.equal(platformForFile("Arcane-Desk-0.1.0-win-x64.exe.blockmap"), null);
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
