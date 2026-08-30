import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildCatalog,
  commitStage,
  compareVersions,
  listInstalledModules,
  stageModule,
} from "../skills/prep/arcane-fvtt-mods/scripts/mod-manager.mjs";

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestUrl = "https://packages.example.test/demo/2.0.0/module.json";
const downloadUrl = "https://packages.example.test/demo/2.0.0/demo.zip";
const indexUrl = "https://packages.example.test/index.json";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function jsonResponse(value) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
  });
}

function binaryResponse(value) {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "application/zip", "content-length": String(value.length) },
  });
}

test("loose Foundry versions compare numerically and refuse ambiguous formats", () => {
  assert.equal(compareVersions("13.01", "13.1"), 0);
  assert.equal(compareVersions("2.0.0", "1.10.9"), 1);
  assert.equal(compareVersions("2.0.0-beta.2", "2.0.0-beta.1"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0-beta.9"), 1);
  assert.equal(compareVersions("release-two", "release-one"), null);
});

test("desktop exposes the packaged mod manager to prep shell sessions", async () => {
  const main = await readFile(path.join(desktopRoot, "src", "main", "main.js"), "utf8");
  assert.match(main, /process\.env\.ARCANE_FVTT_MOD_MANAGER\s*=\s*path\.join/);
  assert.match(main, /"arcane-fvtt-mods"[\s\S]*"mod-manager\.mjs"/);
});

test("catalog compares only installed modules and excludes system packages", () => {
  const index = {
    generated: "2026-08-30T21:29:09+08:00",
    packages: [
      {
        id: "demo",
        version: "2.0.0",
        group: "arcane",
        bytes: 100,
        sha256: "a".repeat(64),
        zipUrl: downloadUrl,
        manifestUrl,
      },
      {
        id: "dnd5e",
        version: "5.3.3",
        group: "system",
        bytes: 200,
        sha256: "b".repeat(64),
        zipUrl: "https://packages.example.test/dnd5e.zip",
        manifestUrl: "https://packages.example.test/system.json",
      },
    ],
  };
  const catalog = buildCatalog(index, {
    modules: [
      { id: "demo", title: "Demo", version: "1.0.0", directory: "/modules/demo" },
      { id: "elsewhere", title: "Elsewhere", version: "4.0.0", directory: "/modules/elsewhere" },
    ],
    invalid: [],
  });
  assert.deepEqual(catalog.updates.map((row) => row.id), ["demo"]);
  assert.equal(catalog.rows[0].status, "update");
  assert.deepEqual(catalog.notInMirror.map((row) => row.id), ["elsewhere"]);
  assert.equal(catalog.rows.some((row) => row.id === "dnd5e"), false);
});

test("trusted staging verifies the mirror hash and commit backs up an installed module", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-mod-manager-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "FoundryVTT");
  const oldDir = path.join(dataDir, "Data", "modules", "custom-folder");
  await mkdir(oldDir, { recursive: true });
  await writeFile(path.join(oldDir, "module.json"), JSON.stringify({ id: "demo", title: "Demo", version: "1.0.0" }));
  await writeFile(path.join(oldDir, "old.txt"), "old");

  const remoteManifest = {
    id: "demo",
    title: "Demo",
    version: "2.0.0",
    download: downloadUrl,
    manifest: manifestUrl,
    esmodules: ["scripts/demo.js"],
  };
  // Mirror ZIPs may intentionally omit distribution-only download/manifest fields.
  const archivedManifest = { id: "demo", title: "Demo", version: "2.0.0", esmodules: ["scripts/demo.js"] };
  const zipFile = path.join(root, "fixture.zip");
  await execFileAsync("python", [
    "-c",
    "import json,sys,zipfile; m=json.loads(sys.argv[2]); z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.writestr('demo/module.json',json.dumps(m)); z.writestr('demo/scripts/demo.js','export const ok = true;'); z.close()",
    zipFile,
    JSON.stringify(archivedManifest),
  ]);
  const zip = await readFile(zipFile);
  const mirrorIndex = {
    generated: "2026-08-30T21:29:09+08:00",
    packages: [{
      id: "demo",
      version: "2.0.0",
      group: "arcane",
      bytes: zip.length,
      sha256: sha256(zip),
      zipUrl: downloadUrl,
      manifestUrl,
    }],
  };
  const fakeFetch = async (url) => {
    if (url === manifestUrl) return jsonResponse(remoteManifest);
    if (url === indexUrl) return jsonResponse(mirrorIndex);
    if (url === downloadUrl) return binaryResponse(zip);
    return new Response("not found", { status: 404 });
  };

  const staged = await stageModule({
    manifestUrl,
    expectedId: "demo",
    expectedVersion: "2.0.0",
    expectedDownloadUrl: downloadUrl,
    fetchImpl: fakeFetch,
    indexUrl,
    tempRoot: root,
  });
  assert.equal(staged.trustedByMirrorIndex, true);
  assert.equal(staged.requiresSecondConfirmation, false);
  assert.equal(staged.archiveSha256, sha256(zip));

  const committed = await commitStage({
    stageDir: staged.stageDir,
    dataDir,
    expectedCurrentVersion: "1.0.0",
  });
  assert.equal(committed.previousVersion, "1.0.0");
  assert.equal(committed.version, "2.0.0");
  assert.equal(committed.target, oldDir);
  assert.ok(committed.backup);
  assert.equal(JSON.parse(await readFile(path.join(oldDir, "module.json"), "utf8")).version, "2.0.0");
  assert.equal(await readFile(path.join(committed.backup, "old.txt"), "utf8"), "old");
  await assert.rejects(stat(staged.stageDir), { code: "ENOENT" });

  const installed = await listInstalledModules(dataDir);
  assert.deepEqual(installed.modules.map(({ id, version }) => ({ id, version })), [{ id: "demo", version: "2.0.0" }]);
});

test("an unindexed stage cannot commit without accepting its exact computed hash", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-mod-manager-untrusted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "FoundryVTT");
  await mkdir(path.join(dataDir, "Data"), { recursive: true });
  const remoteManifest = { id: "demo", title: "Demo", version: "2.0.0", download: downloadUrl, manifest: manifestUrl };
  const zipFile = path.join(root, "fixture.zip");
  await execFileAsync("python", [
    "-c",
    "import json,sys,zipfile; m=json.loads(sys.argv[2]); z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('module.json',json.dumps(m)); z.close()",
    zipFile,
    JSON.stringify(remoteManifest),
  ]);
  const zip = await readFile(zipFile);
  const fakeFetch = async (url) => {
    if (url === manifestUrl) return jsonResponse(remoteManifest);
    if (url === indexUrl) return jsonResponse({ generated: "now", packages: [] });
    if (url === downloadUrl) return binaryResponse(zip);
    return new Response("not found", { status: 404 });
  };
  const staged = await stageModule({
    manifestUrl,
    expectedId: "demo",
    expectedVersion: "2.0.0",
    expectedDownloadUrl: downloadUrl,
    fetchImpl: fakeFetch,
    indexUrl,
    tempRoot: root,
  });
  assert.equal(staged.requiresSecondConfirmation, true);
  await assert.rejects(
    commitStage({ stageDir: staged.stageDir, dataDir, expectedCurrentVersion: "none" }),
    /requires --accept-sha256/,
  );
  const committed = await commitStage({
    stageDir: staged.stageDir,
    dataDir,
    expectedCurrentVersion: "none",
    acceptSha256: staged.archiveSha256,
  });
  assert.equal(committed.version, "2.0.0");
  assert.equal(committed.backup, null);
});
