import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FRAGMENT_SCHEMA_VERSION,
  buildFragment,
  collectStageFiles,
  verifyMacSums,
} from "../scripts/stage-release.mjs";
import {
  assertBaseManifestFresh,
  assertSourceCommitMatchesReleaseId,
  collectFinalizeInstallers,
  headStatus,
  loadJournal,
  mergeFragmentFiles,
  parseArgs,
} from "../scripts/publish-release.mjs";

function makeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

test("stage collection accepts mac packages and windows zips, never installers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-collect-"));
  try {
    makeTree(root, {
      "staging/macos-arm64/Arcane-Desk-0.1.0-mac-arm64.dmg": "dmg-bytes",
      "staging/macos-arm64/Arcane-Desk-0.1.0-mac-arm64.zip": "zip-bytes",
      "staging/macos-arm64/SHA256SUMS.txt": "sums",
      "staging/windows-x64/Arcane-Desk-0.1.0-win-x64.zip": "winzip-bytes",
      "staging/windows-x64/SHA256SUMS.txt": "unsigned sums are not published",
    });
    const entries = collectStageFiles(path.join(root, "staging"));
    // mac 收 dmg/zip/sums；windows 只收 zip（exe 禁入，CI 清单不发布）。
    assert.deepEqual(entries.map((e) => `${path.basename(path.dirname(e.file))}/${path.basename(e.file)}`).sort(), [
      "macos-arm64/Arcane-Desk-0.1.0-mac-arm64.dmg",
      "macos-arm64/Arcane-Desk-0.1.0-mac-arm64.zip",
      "macos-arm64/SHA256SUMS.txt",
      "windows-x64/Arcane-Desk-0.1.0-win-x64.zip",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stage collection rejects an unsigned installer outright", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-exe-"));
  try {
    makeTree(root, { "staging/windows-x64/Arcane-Desk-0.1.0-win-x64.exe": "unsigned" });
    assert.throws(() => collectStageFiles(path.join(root, "staging")), /unsigned installer must not be staged/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mac CI sums must match the staged bytes before anything is uploaded", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-sums-"));
  try {
    const { createHash } = await import("node:crypto");
    const dmg = "dmg-bytes";
    const zip = "zip-bytes";
    const sha = (s) => createHash("sha256").update(s).digest("hex");
    makeTree(root, {
      [`staging/macos-x64/Arcane-Desk-0.1.0-mac-x64.dmg`]: dmg,
      [`staging/macos-x64/Arcane-Desk-0.1.0-mac-x64.zip`]: zip,
      [`staging/macos-x64/SHA256SUMS.txt`]: `${sha(dmg)}  Arcane-Desk-0.1.0-mac-x64.dmg\n${sha(zip)}  Arcane-Desk-0.1.0-mac-x64.zip\n`,
      // windows zip 不参与 sums 对账
      [`staging/windows-x64/Arcane-Desk-0.1.0-win-x64.zip`]: "winzip",
    });
    const entries = collectStageFiles(path.join(root, "staging"));
    assert.deepEqual(await verifyMacSums(entries), []);

    fs.writeFileSync(path.join(root, "staging/macos-x64/Arcane-Desk-0.1.0-mac-x64.dmg"), "tampered");
    const errors = await verifyMacSums(collectStageFiles(path.join(root, "staging")));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /disagrees with CI SHA256SUMS/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fragment lists staged files with hashes, sorted by platform and name", async () => {
  const fragment = buildFragment({
    releaseId: "0.1.0-abcd1234",
    region: "intl",
    files: [
      { platform: "macos-x64", name: "Arcane-Desk-0.1.0-mac-x64-intl.zip", bytes: 3, sha256: "c".repeat(64) },
      { platform: "macos-arm64", name: "Arcane-Desk-0.1.0-mac-arm64-intl.dmg", bytes: 2, sha256: "a".repeat(64) },
      { platform: "windows-x64", name: "Arcane-Desk-0.1.0-win-x64-intl.zip", bytes: 4, sha256: "d".repeat(64) },
    ],
  });
  assert.equal(fragment.schemaVersion, FRAGMENT_SCHEMA_VERSION);
  assert.deepEqual(fragment.files.map((f) => `${f.platform}/${f.name}`), [
    "macos-arm64/Arcane-Desk-0.1.0-mac-arm64-intl.dmg",
    "macos-x64/Arcane-Desk-0.1.0-mac-x64-intl.zip",
    "windows-x64/Arcane-Desk-0.1.0-win-x64-intl.zip",
  ]);
  assert.equal(fragment.files[0].kind, "dmg");
  assert.equal(fragment.files[1].kind, "zip");
  assert.equal(fragment.files[2].contentType, "application/zip");
});

test("finalize staging accepts installers only and overlays signed copies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-collect-"));
  try {
    makeTree(root, {
      "staging/windows-x64/Arcane-Desk-0.1.0-win-x64.exe": "unsigned-x64",
      "staging/windows-arm64/Arcane-Desk-0.1.0-win-arm64.exe": "unsigned-arm64",
      "signed/Arcane-Desk-0.1.0-win-x64.exe": "signed-x64",
      "signed/Arcane-Desk-0.1.0-win-arm64.exe": "signed-arm64",
    });
    const overlaid = collectFinalizeInstallers(path.join(root, "staging"), path.join(root, "signed"));
    assert.deepEqual(
      overlaid.map((e) => `${e.platform}:${path.basename(e.file)}`).sort(),
      ["windows-arm64:Arcane-Desk-0.1.0-win-arm64.exe", "windows-x64:Arcane-Desk-0.1.0-win-x64.exe"],
    );
    for (const entry of overlaid) {
      assert.match(entry.file, /[\\/]signed[\\/]/, "overlay must swap in the signed copy");
    }
    // 缺任一签名件：整体失败（不能把未签名安装包发出去）
    fs.rmSync(path.join(root, "signed/Arcane-Desk-0.1.0-win-arm64.exe"));
    assert.throws(
      () => collectFinalizeInstallers(path.join(root, "staging"), path.join(root, "signed")),
      /signed copy missing/,
    );
    // 非 exe 混入：拒绝（zip 等已由阶段 1 上传，本地 staging 只装安装器）
    makeTree(root, { "staging2/windows-x64/Arcane-Desk-0.1.0-win-x64.exe": "u", "staging2/windows-x64/extra.zip": "z" });
    assert.throws(
      () => collectFinalizeInstallers(path.join(root, "staging2"), path.join(root, "signed")),
      /accepts installers only/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finalize journal loads region-scoped entries and tolerates absence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "journal-"));
  try {
    const file = path.join(root, "journal.json");
    const empty = loadJournal("0.1.0-none", file);
    assert.equal(empty.size, 0);
    await fsp.writeFile(file, JSON.stringify([
      { region: "cn", key: "desktop/arcane-desk/releases/0.1.0-x/windows-x64/a.exe", sha256: "a".repeat(64), bytes: 1 },
      { region: "intl", key: "desktop/arcane-desk-intl/releases/0.1.0-x/windows-x64/a-intl.exe", sha256: "b".repeat(64), bytes: 2 },
    ]), "utf8");
    const journal = loadJournal("0.1.0-x", file);
    assert.equal(journal.get("cn:desktop/arcane-desk/releases/0.1.0-x/windows-x64/a.exe").sha256, "a".repeat(64));
    assert.equal(journal.size, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("single-shot HEAD status distinguishes 404 from length-matched 200", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method });
    const status = url.includes("/missing") ? 404 : 200;
    return {
      status,
      headers: new Map([["content-length", status === 200 ? "42" : "0"]]),
    };
  };
  try {
    const missing = await headStatus("https://example.test/missing");
    assert.deepEqual(missing, { status: 404, length: 0 });
    const present = await headStatus("https://example.test/present");
    assert.deepEqual(present, { status: 200, length: 42 });
    for (const call of calls) {
      assert.equal(call.method, "HEAD");
      assert.match(call.url, /_cb=/, "cache-buster keeps negative caches honest");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseArgs enforces finalize option combinations", () => {
  assert.deepEqual(parseArgs([
    "--finalize", "--staging", "wexe", "--signed-dir", "signed",
    "--fragment", "fragment-cn.json", "--region", "cn",
  ]), {
    finalize: true,
    staging: "wexe",
    signedDir: "signed",
    fragments: ["fragment-cn.json"],
    region: "cn",
  });
  assert.throws(() => parseArgs(["--finalize", "--staging", "wexe", "--signed-dir", "s"]), /requires at least one --fragment/);
  assert.throws(() => parseArgs(["--finalize", "--fragment", "f", "--signed-dir", "s"]), /requires --staging/);
  assert.throws(() => parseArgs(["--finalize", "--fragment", "f", "--staging", "wexe"]), /requires --signed-dir/);
  assert.throws(
    () => parseArgs(["--finalize", "--fragment", "f", "--staging", "wexe", "--signed-dir", "s", "--promote-release", "x"]),
    /cannot be combined/,
  );
});

test("finalize refuses a stale base manifest version (0.5.0 cn incident)", () => {
  const stale = { product: { version: "0.4.3" } };
  assert.throws(
    () => assertBaseManifestFresh(stale, "0.5.0-411e6f7b"),
    /product\.version \(0\.4\.3\) != release id version \(0\.5\.0\)/,
  );
  assert.throws(
    () => assertBaseManifestFresh(stale, "0.5.0-411e6f7b-intl"),
    /prepare:desktop-release/,
  );
  // 基座一致、非版本型 releaseId、缺 product 块的非版本 id：均放行
  assert.doesNotThrow(() => assertBaseManifestFresh({ product: { version: "0.5.0" } }, "0.5.0-411e6f7b"));
  assert.doesNotThrow(() => assertBaseManifestFresh({ product: { version: "0.5.0" } }, "hotfix-2026-09-20"));
  assert.doesNotThrow(() => assertBaseManifestFresh({}, "custom-id"));
});

test("mergeFragmentFiles merges disjoint fragments and rejects duplicates", () => {
  const mac = {
    schemaVersion: 1, releaseId: "0.6.1-1a2b3c4d", region: "cn",
    files: [
      { platform: "macos-x64", name: "Arcane-Desk-0.6.1-mac-x64.dmg", bytes: 1, sha256: "a", sha512: "b" },
      { platform: "macos-x64", name: "Arcane-Desk-0.6.1-mac-x64.zip", bytes: 2, sha256: "c", sha512: "d" },
    ],
  };
  const win = {
    schemaVersion: 1, releaseId: "0.6.1-1a2b3c4d", region: "cn",
    files: [
      { platform: "windows-x64", name: "Arcane-Desk-0.6.1-win-x64.zip", bytes: 3, sha256: "e", sha512: "f" },
    ],
  };
  const merged = mergeFragmentFiles([mac, win], { releaseId: "0.6.1-1a2b3c4d", region: "cn" });
  assert.equal(merged.length, 3);

  // 同一对象被两个来源声明 → 拒绝
  assert.throws(
    () => mergeFragmentFiles([mac, { ...win, files: [...win.files, { ...win.files[0] }] }], { releaseId: "0.6.1-1a2b3c4d", region: "cn" }),
    /duplicate fragment entry across fragments: windows-x64\/Arcane-Desk-0\.6\.1-win-x64\.zip/,
  );
  // 分片携带 exe → 拒绝（分片永远不含安装器）
  assert.throws(
    () => mergeFragmentFiles([{ ...win, files: [{ platform: "windows-x64", name: "Arcane-Desk-0.6.1-win-x64.exe", bytes: 1 }] }], { releaseId: "0.6.1-1a2b3c4d", region: "cn" }),
    /must not carry installers/,
  );
  // 逐片校验 releaseId/region
  assert.throws(
    () => mergeFragmentFiles([{ ...win, releaseId: "0.6.1-other990" }], { releaseId: "0.6.1-1a2b3c4d", region: "cn" }),
    /fragment releaseId/,
  );
  assert.throws(
    () => mergeFragmentFiles([{ ...win, region: "intl" }], { releaseId: "0.6.1-1a2b3c4d", region: "cn" }),
    /fragment region/,
  );
});

test("finalize refuses a base manifest whose source commit mismatches the release id (0.6.0 intl near-miss)", () => {
  const manifest = { product: { version: "0.6.1" }, source: { commit: "66040a344e9cc25e5f9993f3cbd8194ab1591798" } };
  assert.throws(
    () => assertSourceCommitMatchesReleaseId(manifest, "0.6.1-1a2b3c4d"),
    /source\.commit \(66040a34\) != release id sha8 \(1a2b3c4d\)/,
  );
  assert.doesNotThrow(() => assertSourceCommitMatchesReleaseId(manifest, "0.6.1-66040a34"));
  assert.doesNotThrow(() => assertSourceCommitMatchesReleaseId(manifest, "0.6.1-66040a34-intl"));
  // 非版本-提交型 id：不设卡；版本-提交型 id 但缺 source：同样拦截
  assert.doesNotThrow(() => assertSourceCommitMatchesReleaseId(manifest, "hotfix-2026-09"));
  assert.throws(
    () => assertSourceCommitMatchesReleaseId({ product: { version: "0.6.1" } }, "0.6.1-1a2b3c4d"),
    /source\.commit \(missing\)/,
  );
});

test("finalize parseArgs accepts repeated --fragment and still guards the empty case", () => {
  const base = ["--finalize", "--staging", "s", "--signed-dir", "d"];
  const two = parseArgs([...base, "--fragment", "a.json", "--fragment", "b.json"]);
  assert.deepEqual(two.fragments, ["a.json", "b.json"]);
  assert.throws(() => parseArgs(base), /requires at least one --fragment/);
});
