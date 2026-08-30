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
  buildWorldCatalog,
  commitStage,
  commitWorldStage,
  compareVersions,
  inspectWorldEnvironment,
  listInstalledModules,
  stageModule,
  stageWorldEnvironment,
  validateEnvironmentProfile,
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

function bufferResponse(value, contentType = "application/octet-stream") {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return new Response(buffer, {
    status: 200,
    headers: { "content-type": contentType, "content-length": String(buffer.length) },
  });
}

async function createContentZip(file, directory, manifestName, manifest, extraName = "content.txt") {
  await execFileAsync("python", [
    "-c",
    "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); root=sys.argv[2]; z.writestr(root+'/'+sys.argv[3],sys.argv[4]); z.writestr(root+'/'+sys.argv[5],'fixture'); z.close()",
    file,
    directory,
    manifestName,
    JSON.stringify(manifest),
    extraName,
  ]);
  return readFile(file);
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
  const archivedManifest = {
    id: "demo",
    title: "Demo",
    version: "2.0.0",
    manifest: "https://github.example.test/demo/releases/latest/module.json",
    download: "https://github.example.test/demo/releases/download/2.0.0/module.zip",
    esmodules: ["scripts/demo.js"],
  };
  const zipFile = path.join(root, "fixture.zip");
  await execFileAsync("python", [
    "-c",
    "import json,sys,zipfile; m=json.loads(sys.argv[2]); z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.writestr('module.json',json.dumps(m)); z.writestr('scripts/demo.js','export const ok = true;'); z.writestr('source/module.json',json.dumps({'id':'source-copy','version':'0.0.0'})); z.close()",
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
  const installedManifest = JSON.parse(await readFile(path.join(oldDir, "module.json"), "utf8"));
  assert.equal(installedManifest.version, "2.0.0");
  assert.equal(installedManifest.manifest, manifestUrl);
  assert.equal(installedManifest.download, downloadUrl);
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

test("world profiles resolve current stable packages independently from world artifacts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-world-manager-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "FoundryVTT");
  const moduleDir = path.join(dataDir, "Data", "modules", "custom-demo-module");
  const dependencyDir = path.join(dataDir, "Data", "modules", "socketlib");
  const systemDir = path.join(dataDir, "Data", "systems", "dnd5e");
  const worldDir = path.join(dataDir, "Data", "worlds", "arcane-demo");
  await Promise.all([
    mkdir(moduleDir, { recursive: true }),
    mkdir(dependencyDir, { recursive: true }),
    mkdir(systemDir, { recursive: true }),
    mkdir(worldDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(moduleDir, "module.json"), JSON.stringify({ id: "demo-module", title: "Demo Module", version: "1.0.0" })),
    writeFile(path.join(dependencyDir, "module.json"), JSON.stringify({ id: "socketlib", title: "SocketLib", version: "1.0.0" })),
    writeFile(path.join(systemDir, "system.json"), JSON.stringify({ id: "dnd5e", title: "D&D 5e", version: "5.3.3" })),
    writeFile(path.join(worldDir, "world.json"), JSON.stringify({ id: "arcane-demo", title: "Arcane Demo", version: "0.1.0", system: "dnd5e" })),
    writeFile(path.join(worldDir, "user-journal.txt"), "keep in backup"),
  ]);

  const profileUrl = "https://packages.example.test/profiles/arcane-demo-full/1/profile.json";
  const artifacts = {
    system: {
      id: "dnd5e",
      title: "D&D 5e",
      version: "5.3.3",
      manifestUrl: "https://packages.example.test/systems/dnd5e/5.3.3/system.json",
      downloadUrl: "https://packages.example.test/systems/dnd5e/5.3.3/dnd5e.zip",
    },
    module: {
      id: "demo-module",
      title: "Demo Module",
      version: "2.0.0",
      manifestUrl: "https://packages.example.test/modules/demo-module/2.0.0/module.json",
      downloadUrl: "https://packages.example.test/modules/demo-module/2.0.0/demo-module.zip",
    },
    dependency: {
      id: "socketlib",
      title: "SocketLib",
      version: "1.0.0",
      manifestUrl: "https://packages.example.test/modules/socketlib/1.0.0/module.json",
      downloadUrl: "https://packages.example.test/modules/socketlib/1.0.0/socketlib.zip",
    },
    world: {
      id: "arcane-demo",
      title: "Arcane Demo",
      version: "0.2.0",
      manifestUrl: "https://packages.example.test/worlds/arcane-demo/0.2.0/world.json",
      downloadUrl: "https://packages.example.test/worlds/arcane-demo/0.2.0/arcane-demo.zip",
    },
  };
  const manifests = {
    system: { id: "dnd5e", title: "D&D 5e", version: "5.3.3", manifest: artifacts.system.manifestUrl, download: artifacts.system.downloadUrl },
    module: {
      id: "demo-module",
      title: "Demo Module",
      version: "2.0.0",
      manifest: artifacts.module.manifestUrl,
      download: artifacts.module.downloadUrl,
      relationships: { requires: [{ id: "socketlib", type: "module", compatibility: { minimum: "1.0.0" } }] },
    },
    dependency: { id: "socketlib", title: "SocketLib", version: "1.0.0", manifest: artifacts.dependency.manifestUrl, download: artifacts.dependency.downloadUrl },
    world: {
      id: "arcane-demo",
      title: "Arcane Demo",
      version: "0.2.0",
      system: "dnd5e",
      systemVersion: "5.3.3",
      coreVersion: "13.351",
      manifest: artifacts.world.manifestUrl,
      download: artifacts.world.downloadUrl,
    },
  };
  const archivedManifests = {
    ...manifests,
    module: {
      ...manifests.module,
      manifest: "https://github.example.test/demo-module/releases/latest/module.json",
      download: "https://github.example.test/demo-module/releases/download/2.0.0/module.zip",
    },
  };
  const manifestBuffers = Object.fromEntries(
    Object.entries(manifests).map(([kind, value]) => [kind, Buffer.from(JSON.stringify(value))]),
  );
  const zipBuffers = {
    system: await createContentZip(path.join(root, "system.zip"), "dnd5e", "system.json", manifests.system),
    module: await createContentZip(path.join(root, "module.zip"), "demo-module", "module.json", archivedManifests.module),
    dependency: await createContentZip(path.join(root, "dependency.zip"), "socketlib", "module.json", manifests.dependency),
    world: await createContentZip(path.join(root, "world.zip"), "arcane-demo", "world.json", manifests.world, "new-content.txt"),
  };
  function described(kind) {
    return {
      ...artifacts[kind],
      manifestBytes: manifestBuffers[kind].length,
      manifestSha256: sha256(manifestBuffers[kind]),
      bytes: zipBuffers[kind].length,
      sha256: sha256(zipBuffers[kind]),
    };
  }
  const profile = {
    schemaVersion: 1,
    kind: "foundry-environment-profile",
    id: "arcane-demo-full",
    title: "Arcane Demo Full",
    revision: 1,
    packageChannel: "stable",
    system: "dnd5e",
    modules: ["demo-module"],
  };
  assert.deepEqual(validateEnvironmentProfile(profile).modules, ["demo-module"]);
  const profileBuffer = Buffer.from(JSON.stringify(profile));
  let mirrorIndex = {
    generated: "2026-08-30T22:30:00+08:00",
    packages: [
      { id: "dnd5e", version: "5.3.3", group: "system", bytes: zipBuffers.system.length, sha256: sha256(zipBuffers.system), zipUrl: artifacts.system.downloadUrl, manifestUrl: artifacts.system.manifestUrl },
      { id: "demo-module", version: "2.0.0", group: "demo", bytes: zipBuffers.module.length, sha256: sha256(zipBuffers.module), zipUrl: artifacts.module.downloadUrl, manifestUrl: artifacts.module.manifestUrl },
      { id: "socketlib", version: "1.0.0", group: "demo", bytes: zipBuffers.dependency.length, sha256: sha256(zipBuffers.dependency), zipUrl: artifacts.dependency.downloadUrl, manifestUrl: artifacts.dependency.manifestUrl },
    ],
    worlds: [{
      ...described("world"),
      defaultProfile: "arcane-demo-full",
    }],
    profiles: [{
      id: "arcane-demo-full",
      title: "Arcane Demo Full",
      revision: 1,
      profileUrl,
      profileBytes: profileBuffer.length,
      profileSha256: sha256(profileBuffer),
    }],
  };
  const payloads = new Map([
    [profileUrl, profileBuffer],
    [artifacts.system.manifestUrl, manifestBuffers.system],
    [artifacts.module.manifestUrl, manifestBuffers.module],
    [artifacts.dependency.manifestUrl, manifestBuffers.dependency],
    [artifacts.world.manifestUrl, manifestBuffers.world],
    [artifacts.system.downloadUrl, zipBuffers.system],
    [artifacts.module.downloadUrl, zipBuffers.module],
    [artifacts.dependency.downloadUrl, zipBuffers.dependency],
    [artifacts.world.downloadUrl, zipBuffers.world],
  ]);
  const fakeFetch = async (url) => {
    if (url === indexUrl) return bufferResponse(Buffer.from(JSON.stringify(mirrorIndex)), "application/json");
    return payloads.has(url)
      ? bufferResponse(payloads.get(url), url.endsWith(".zip") ? "application/zip" : "application/json")
      : new Response("not found", { status: 404 });
  };

  const catalog = buildWorldCatalog(mirrorIndex, {
    worlds: [{ id: "arcane-demo", title: "Arcane Demo", version: "0.1.0", directory: worldDir }],
    invalid: [],
  });
  assert.equal(catalog.rows[0].status, "update");
  const inspected = await inspectWorldEnvironment({ worldId: "arcane-demo", dataDir, fetchImpl: fakeFetch, indexUrl });
  assert.equal(inspected.system.status, "current");
  assert.equal(inspected.modules[0].status, "upgrade");
  assert.equal(inspected.modules[1].id, "socketlib");
  assert.equal(inspected.modules[1].resolutionSource, "required-by:demo-module");
  assert.equal(inspected.modules[1].status, "current");
  assert.equal(inspected.world.status, "upgrade");
  assert.equal(inspected.plannedArchiveBytes, zipBuffers.module.length + zipBuffers.world.length);
  assert.match(inspected.resolutionSha256, /^[a-f0-9]{64}$/);

  await assert.rejects(
    stageWorldEnvironment({
      worldId: "arcane-demo",
      dataDir,
      expectedWorldVersion: inspected.version,
      expectedWorldSha256: inspected.archiveSha256,
      expectedProfileId: inspected.profile.id,
      expectedProfileRevision: inspected.profile.revision,
      expectedProfileSha256: inspected.profile.profileSha256,
      expectedIndexGenerated: inspected.generated,
      fetchImpl: fakeFetch,
      indexUrl,
      tempRoot: root,
    }),
    /--expected-resolution-sha256 is required; rerun world-inspect/,
  );

  payloads.set(artifacts.module.manifestUrl, Buffer.from(JSON.stringify({
    ...manifests.module,
    description: "changed without advancing the index generation",
  })));
  await assert.rejects(
    stageWorldEnvironment({
      worldId: "arcane-demo",
      dataDir,
      expectedWorldVersion: inspected.version,
      expectedWorldSha256: inspected.archiveSha256,
      expectedProfileId: inspected.profile.id,
      expectedProfileRevision: inspected.profile.revision,
      expectedProfileSha256: inspected.profile.profileSha256,
      expectedIndexGenerated: inspected.generated,
      expectedResolutionSha256: inspected.resolutionSha256,
      fetchImpl: fakeFetch,
      indexUrl,
      tempRoot: root,
    }),
    /world resolution SHA256 changed/,
  );
  payloads.set(artifacts.module.manifestUrl, manifestBuffers.module);

  const staged = await stageWorldEnvironment({
    worldId: "arcane-demo",
    dataDir,
    expectedWorldVersion: inspected.version,
    expectedWorldSha256: inspected.archiveSha256,
    expectedProfileId: inspected.profile.id,
    expectedProfileRevision: inspected.profile.revision,
    expectedProfileSha256: inspected.profile.profileSha256,
    expectedIndexGenerated: inspected.generated,
    expectedResolutionSha256: inspected.resolutionSha256,
    fetchImpl: fakeFetch,
    indexUrl,
    tempRoot: root,
  });
  assert.deepEqual(staged.artifacts.map((artifact) => `${artifact.kind}:${artifact.id}`), [
    "module:demo-module",
    "world:arcane-demo",
  ]);
  assert.equal(staged.dependencyReplacements[0].from, "1.0.0");

  await writeFile(path.join(worldDir, "world.json"), JSON.stringify({
    id: "arcane-demo",
    title: "Arcane Demo",
    version: "0.1.1",
    system: "dnd5e",
  }));
  await assert.rejects(
    commitWorldStage({ stageDir: staged.stageDir, dataDir, expectedCurrentVersion: "0.1.0" }),
    /world arcane-demo changed after staging/,
  );
  await writeFile(path.join(worldDir, "world.json"), JSON.stringify({
    id: "arcane-demo",
    title: "Arcane Demo",
    version: "0.1.0",
    system: "dnd5e",
  }));

  const committed = await commitWorldStage({
    stageDir: staged.stageDir,
    dataDir,
    expectedCurrentVersion: "0.1.0",
  });
  assert.equal(committed.version, "0.2.0");
  const committedModuleManifest = JSON.parse(await readFile(path.join(moduleDir, "module.json"), "utf8"));
  assert.equal(committedModuleManifest.version, "2.0.0");
  assert.equal(committedModuleManifest.manifest, artifacts.module.manifestUrl);
  assert.equal(committedModuleManifest.download, artifacts.module.downloadUrl);
  assert.equal(JSON.parse(await readFile(path.join(worldDir, "world.json"), "utf8")).version, "0.2.0");
  const worldBackup = committed.backups.find((entry) => entry.kind === "world");
  assert.match(worldBackup.path, /\.arcane-world-backups[\\/]arcane-demo/);
  assert.equal(await readFile(path.join(worldBackup.path, "user-journal.txt"), "utf8"), "keep in backup");
  assert.ok(committed.receiptPath);
  const firstReceipt = JSON.parse(await readFile(committed.receiptPath, "utf8"));
  assert.equal(firstReceipt.profile.id, "arcane-demo-full");
  assert.equal(firstReceipt.packages.find((entry) => entry.id === "demo-module").resolvedVersion, "2.0.0");
  await assert.rejects(stat(staged.stageDir), { code: "ENOENT" });

  await writeFile(path.join(worldDir, "local-world-data.txt"), "must survive package-only updates");
  const module21 = {
    ...manifests.module,
    version: "2.1.0",
    manifest: "https://packages.example.test/modules/demo-module/2.1.0/module.json",
    download: "https://packages.example.test/modules/demo-module/2.1.0/demo-module.zip",
  };
  const module21Manifest = Buffer.from(JSON.stringify(module21));
  const module21Zip = await createContentZip(path.join(root, "module-2.1.zip"), "demo-module", "module.json", module21);
  payloads.set(module21.manifest, module21Manifest);
  payloads.set(module21.download, module21Zip);
  mirrorIndex = {
    ...mirrorIndex,
    generated: "2026-08-30T23:00:00+08:00",
    packages: mirrorIndex.packages.map((entry) => entry.id === "demo-module" ? {
      ...entry,
      version: "2.1.0",
      bytes: module21Zip.length,
      sha256: sha256(module21Zip),
      manifestUrl: module21.manifest,
      zipUrl: module21.download,
    } : entry),
  };
  const packageOnlyPlan = await inspectWorldEnvironment({ worldId: "arcane-demo", dataDir, fetchImpl: fakeFetch, indexUrl });
  assert.equal(packageOnlyPlan.world.status, "current");
  assert.deepEqual(packageOnlyPlan.actionable.map((entry) => `${entry.kind}:${entry.id}`), ["module:demo-module"]);
  assert.equal(packageOnlyPlan.plannedArchiveBytes, module21Zip.length);
  const packageOnlyStage = await stageWorldEnvironment({
    worldId: "arcane-demo",
    dataDir,
    expectedWorldVersion: packageOnlyPlan.version,
    expectedWorldSha256: packageOnlyPlan.archiveSha256,
    expectedProfileId: packageOnlyPlan.profile.id,
    expectedProfileRevision: packageOnlyPlan.profile.revision,
    expectedProfileSha256: packageOnlyPlan.profile.profileSha256,
    expectedIndexGenerated: packageOnlyPlan.generated,
    expectedResolutionSha256: packageOnlyPlan.resolutionSha256,
    fetchImpl: fakeFetch,
    indexUrl,
    tempRoot: root,
  });
  assert.deepEqual(packageOnlyStage.artifacts.map((entry) => `${entry.kind}:${entry.id}`), ["module:demo-module"]);
  const packageOnlyCommit = await commitWorldStage({
    stageDir: packageOnlyStage.stageDir,
    dataDir,
    expectedCurrentVersion: "0.2.0",
  });
  assert.equal(packageOnlyCommit.world, null);
  assert.equal(packageOnlyCommit.backups.some((entry) => entry.kind === "world"), false);
  assert.equal(await readFile(path.join(worldDir, "local-world-data.txt"), "utf8"), "must survive package-only updates");
  assert.equal(JSON.parse(await readFile(path.join(moduleDir, "module.json"), "utf8")).version, "2.1.0");
  const secondReceipt = JSON.parse(await readFile(packageOnlyCommit.receiptPath, "utf8"));
  assert.equal(secondReceipt.world.installedVersion, "0.2.0");
  assert.equal(secondReceipt.packages.find((entry) => entry.id === "demo-module").resolvedVersion, "2.1.0");
});
