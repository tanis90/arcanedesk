// Static guardrails for the real-stack lobby E2E harness.
//
// The harness logs into a real local deployment, so its contract must stay honest:
// credentials and tokens come only from the environment, never from argv, and never
// reach the report; the local self-signed TLS bypass and the trusted-origin override
// stay harness-scoped instead of widening production rules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = readFileSync(path.join(here, "e2e-lobby-actions.mjs"), "utf8");
const fixture = readFileSync(path.join(here, "fixtures", "lobby-e2e-app.mjs"), "utf8");

test("real-lobby credentials and tokens never enter argv", () => {
  // The browser is spawned from an explicit argument list; credentials must not be
  // part of it. They are inherited through the process environment instead.
  const options = /for \(const name of \[([^\]]*)\]\)/.exec(launcher)?.[1] ?? "";
  for (const forbidden of ["password", "token", "secret", "credential"]) {
    assert.equal(options.toLowerCase().includes(forbidden), false, `launcher forwards ${forbidden} in argv`);
    const spawnArgs = /electronArgs\.push\(([^\n]*)\)/.exec(launcher)?.[1] ?? "";
    assert.equal(spawnArgs.toLowerCase().includes(forbidden), false, `launcher builds argv with ${forbidden}`);
  }
  assert.match(launcher, /MT_ACCEPT_USER \/ MT_ACCEPT_PASSWORD env only/);
  assert.match(fixture, /process\.env\.MT_ACCEPT_USER/);
  assert.match(fixture, /process\.env\.MT_ACCEPT_PASSWORD/);
});

test("the fixture scrubs secrets and fails real mode closed without credentials", () => {
  assert.match(fixture, /\[secret\]/);
  assert.match(fixture, /noSecretsInReport/);
  assert.match(fixture, /status: "needs-credentials"/);
  assert.match(fixture, /if \(realUrl && !credentialsPresent\)/);
});

test("self-signed TLS bypass and the trusted-origin override stay harness-scoped", () => {
  assert.match(fixture, /if \(insecureTls\) \{[\s\S]*?ignore-certificate-errors/);
  assert.match(fixture, /args\.get\("insecure-tls"\) === true/);
  // The origin gate reuses the documented production escape hatch instead of
  // adding the local origin to MT_COMPAT_TRUSTED_ORIGINS.
  assert.match(fixture, /createPanelProfileOverrides/);
  assert.match(fixture, /isTrustedLobbyUrl: url => resolvePanel\(url\)\?\.id === PAGE_PROFILES\.mtcompat\.id/);
  const pageProfiles = readFileSync(path.join(here, "..", "src", "main", "page-profiles.js"), "utf8");
  assert.equal(/mtlocal\.internal/.test(pageProfiles), false, "production trusted origins must not include the local test host");
});

test("the real contract covers the required tool checks and only cleans up its own objects", () => {
  for (const check of [
    "campaignsListReturnsIsolated",
    "importStarted",
    "nativeFileBound",
    "importJobSucceeded",
    "packEntriesRead",
    "campaignPacksRead",
    "campaignPacksUpdated",
    "staleCampaignUpdateRejected",
    "approvalDenied",
    "packDeletePreviewReported",
    "packDeleted",
    "existingPacksUntouched",
    "playPageRejectsLobbyTool",
    "worldImportSucceeded",
    "worldImportCreatedCampaign",
    "worldCampaignDeleted",
    "lobbyReturnRealCompleted",
    "lobbyReadyAfterRealReturn",
    "isolatedCampaignDeleted",
    "cleanupCompleted",
  ]) {
    assert.match(fixture, new RegExp(`\\b${check}\\b`), `missing check ${check}`);
  }
  assert.match(fixture, /refusing to import: module/);
  assert.match(fixture, /\/api\/collections\/foundry-userpacks\/profile\/me\/purge/);
  // Cleanup iterates the campaign ids this run recorded and skips the ones already deleted.
  assert.match(fixture, /for \(const \[key, id\] of \[\["campaignId", state\.campaignId\], \["worldCampaignId", state\.worldCampaignId\]\]\)/);
  assert.match(fixture, /\? state\.campaignDeleted : state\.worldCampaignDeleted/);
});
