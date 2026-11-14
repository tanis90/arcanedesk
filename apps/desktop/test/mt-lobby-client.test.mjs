import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MtLobbyClient, MtLobbyError, isTerminalJob, jobPhaseOf } from "../src/main/mt-lobby-client.js";
import { evaluateNavigationSafe } from "../src/main/foundry-web.js";
import { prepareLobbySourceFile } from "../src/main/mt-lobby-file.js";
import { createPanelProfileOverrides } from "../src/main/page-profiles.js";
import { LOBBY_URL, createLobbyFixture, createLobbyState } from "./fixtures/lobby-harness.mjs";

function fixture(options = {}) {
  const page = createLobbyFixture(options);
  const client = new MtLobbyClient({
    getWebContents: () => page.webContents,
    log: () => {},
  });
  return { ...page, client };
}

function tempSource(t, name = "world.zip", body = "PK fixture world") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-source-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  writeFileSync(file, body);
  return { directory, file, sha256: createHash("sha256").update(body).digest("hex"), size: Buffer.byteLength(body) };
}

test("preflight accepts the trusted lobby page and never exposes __MT_AUTH__ contents", async () => {
  const { client } = fixture();
  const target = client.captureTarget();
  const result = await client.preflight("lobbyCampaignsList", target);
  assert.equal(result.url, LOBBY_URL);
  assert.equal(result.protocolVersion, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
});

test("preflight accepts the compat service.version shape when protocolVersion is absent", async () => {
  const page = createLobbyFixture();
  delete page.service.protocolVersion;
  page.service.version = 1;
  const client = new MtLobbyClient({ getWebContents: () => page.webContents });
  const result = await client.preflight("lobbyCampaignsList", client.captureTarget());
  assert.equal(result.protocolVersion, 1);
});

test("login, profile, origin, path and capability failures are stable fail-closed codes", async () => {
  const unauthenticated = fixture({ auth: false });
  await assert.rejects(unauthenticated.client.call("lobbyCampaignsList", {}), error => error.code === "LOGIN_REQUIRED");

  const authPage = createLobbyFixture({ url: "https://arcanemap.com/auth/realms/arcane/protocol/openid-connect/auth" });
  const authClient = new MtLobbyClient({ getWebContents: () => authPage.webContents });
  assert.throws(() => authClient.captureTarget(), error => error.code === "LOGIN_REQUIRED");

  const playPage = createLobbyFixture({ url: "https://arcanemap.com/user-files/compat/play.html?campaign=c1" });
  const playClient = new MtLobbyClient({ getWebContents: () => playPage.webContents });
  assert.throws(() => playClient.captureTarget(), error => error.code === "PROFILE_MISMATCH");

  const evilPage = createLobbyFixture({ url: "https://evil.example/user-files/compat/lobby.html" });
  const evilClient = new MtLobbyClient({ getWebContents: () => evilPage.webContents });
  assert.throws(() => evilClient.captureTarget(), error => error.code === "PROFILE_MISMATCH");

  const noService = fixture();
  noService.setService(null);
  await assert.rejects(noService.client.call("lobbyCampaignsList", {}), error => error.code === "CAPABILITY_UNAVAILABLE");

  const noRuntime = fixture();
  noRuntime.setRuntime(false);
  await assert.rejects(noRuntime.client.call("lobbyCampaignsList", {}), error => error.code === "CAPABILITY_UNAVAILABLE");

  const noAction = fixture();
  delete noAction.service.lobbyPackRead;
  await assert.rejects(noAction.client.call("lobbyCampaignsList", {}), error => {
    return error.code === "CAPABILITY_UNAVAILABLE" && /lobbyPackRead/.test(error.message);
  });

  const oldProtocol = fixture({ protocolVersion: 0 });
  await assert.rejects(oldProtocol.client.call("lobbyCampaignsList", {}), error => error.code === "CAPABILITY_UNAVAILABLE");
});

test("an explicit panel-profile override can trust a local lobby origin without widening the default list", async () => {
  const localUrl = "http://127.0.0.1:4711/user-files/compat-dev/lobby.html";
  const page = createLobbyFixture({ url: localUrl });
  const defaultClient = new MtLobbyClient({ getWebContents: () => page.webContents });
  assert.throws(() => defaultClient.captureTarget(), error => error.code === "PROFILE_MISMATCH");

  const overrides = createPanelProfileOverrides(JSON.stringify({ "http://127.0.0.1:4711": "mtcompat" }), () => {});
  const overrideClient = new MtLobbyClient({
    getWebContents: () => page.webContents,
    isTrustedLobbyUrl: url => overrides.resolve(url)?.id === "mtcompat",
  });
  const target = overrideClient.captureTarget();
  assert.equal(target.url, localUrl);
  const campaigns = await overrideClient.call("lobbyCampaignsList", {});
  assert.equal(campaigns.campaigns[0].id, "campaign-1");

  const denied = new MtLobbyClient({
    getWebContents: () => page.webContents,
    isTrustedLobbyUrl: () => false,
  });
  assert.throws(() => denied.captureTarget(), error => error.code === "PROFILE_MISMATCH");
});

test("action whitelist rejects anything outside the mt-compat lobby contract", async () => {
  const { client } = fixture();
  await assert.rejects(client.call("runtimeEval", {}), error => error.code === "ACTION_UNKNOWN");
  await assert.rejects(client.call("pageEval", { code: "1" }), error => error.code === "ACTION_UNKNOWN");
});

test("calls are serialized and a failed call does not poison the queue", async () => {
  const page = createLobbyFixture();
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  page.service.lobbyCampaignsList = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("first fails"), { code: "LOBBY_ACTION_FAILED" });
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    return { campaigns: [] };
  };
  const client = new MtLobbyClient({ getWebContents: () => page.webContents });
  const first = client.call("lobbyCampaignsList", {});
  const second = client.call("lobbyCampaignsList", {});
  const third = client.call("lobbyCampaignsList", {});
  await assert.rejects(first, error => error.code === "LOBBY_ACTION_FAILED");
  await Promise.all([second, third]);
  assert.equal(maxActive, 1);
});

test("captured target cannot silently follow a navigation", async () => {
  const page = createLobbyFixture();
  const client = new MtLobbyClient({ getWebContents: () => page.webContents });
  const target = client.captureTarget();
  page.webContents.navigate(`${LOBBY_URL}?campaign=c1`);
  assert.throws(() => client.assertTarget(target), error => error.code === "TARGET_CHANGED");
  await assert.rejects(client.call("lobbyCampaignsList", {}, { target }), error => error.code === "TARGET_CHANGED");
  assert.equal(page.state.listCalls, 0);
});

test("navigation and renderer crashes make running jobs indeterminate without replay", async () => {
  const page = createLobbyFixture();
  const client = new MtLobbyClient({ getWebContents: () => page.webContents });
  const target = client.captureTarget();
  client.registerJob("job-nav", target);
  page.webContents.navigate(`${LOBBY_URL}?campaign=nav`);
  await assert.rejects(client.statusJob("job-nav"), error => error.code === "JOB_INDETERMINATE");
  assert.equal(page.state.statusCalls, 0);

  const page2 = createLobbyFixture();
  const client2 = new MtLobbyClient({ getWebContents: () => page2.webContents });
  client2.registerJob("job-crash", client2.captureTarget());
  page2.webContents.crash();
  await assert.rejects(client2.statusJob("job-crash"), error => error.code === "JOB_INDETERMINATE");
  assert.equal(page2.state.statusCalls, 0);
});

test("native file binding uses only fixed CDP commands and the hidden service input", async (t) => {
  const source = tempSource(t);
  const page = createLobbyFixture();
  const client = new MtLobbyClient({ getWebContents: () => page.webContents });
  const prepared = await prepareLobbySourceFile(source.file, { roots: [source.directory] });
  assert.equal(prepared.filename, "world.zip");
  assert.equal(prepared.size, source.size);
  assert.equal(prepared.sha256, source.sha256);
  assert.equal(JSON.stringify(prepared).includes(source.directory), false);
  assert.equal("realPath" in JSON.parse(JSON.stringify(prepared)), false);

  const target = client.captureTarget();
  const inspection = await client.inspectImportFile(target, prepared, { expectedKind: "world", campaignName: "Test", failurePolicy: "abort" });
  assert.equal(inspection.preparationId, "prep-secret");
  assert.equal(page.state.inspectCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(page.state.inspectCalls[0])), {
    filename: "world.zip",
    size: source.size,
    sha256: source.sha256,
    expectedKind: "world",
    options: { campaignName: "Test", failurePolicy: "abort" },
  });
  assert.equal(page.state.boundFile.name, "world.zip");
  assert.equal(page.state.boundFile.sha256, source.sha256);
  assert.deepEqual(page.commands.map(command => command.method), [
    "Runtime.evaluate",
    "DOM.enable",
    "DOM.setFileInputFiles",
    "Runtime.releaseObjectGroup",
  ]);
  assert.equal(page.commands[0].params.expression, "globalThis.__MT_LOBBY_SERVICE__.getFileInput()");
  assert.deepEqual(page.commands[2].params.files, [realpathSync.native(source.file)]);
  assert.equal(page.commands[2].params.objectId, "fixture-input-object");
  assert.equal(page.webContents.debugger.isAttached(), false, "the adapter detaches a debugger it attached");
  assert.equal(page.commands.some(command => command.method === "Page.setInterceptFileChooserDialog"), false);
  assert.equal(page.evaluateCount(), 1, "only the fixed getFileInput expression is evaluated through CDP");
});

test("source fence rejects outside/non-regular/empty files and detects changes while hashing", async (t) => {
  const inner = tempSource(t, "inner.zip", "inside");
  const outerDir = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-outside-"));
  t.after(() => rmSync(outerDir, { recursive: true, force: true }));
  const outer = path.join(outerDir, "outside.zip");
  writeFileSync(outer, "outside");

  await assert.rejects(
    prepareLobbySourceFile(outer, { roots: [inner.directory] }),
    error => error.code === "FILE_OUTSIDE_FENCE",
  );
  await assert.rejects(
    prepareLobbySourceFile(inner.directory, { roots: [inner.directory] }),
    error => error.code === "FILE_NOT_REGULAR",
  );
  const empty = tempSource(t, "empty.zip", "");
  await assert.rejects(
    prepareLobbySourceFile(empty.file, { roots: [empty.directory] }),
    error => error.code === "FILE_EMPTY",
  );
  await assert.rejects(
    prepareLobbySourceFile(path.join(inner.directory, "missing.zip"), { roots: [inner.directory] }),
    error => error.code === "FILE_NOT_FOUND",
  );

  const changed = tempSource(t, "changed.zip", "first");
  await assert.rejects(
    prepareLobbySourceFile(changed.file, {
      roots: [changed.directory],
      createReadStream: async function* stream(file) {
        yield Buffer.from("first");
        writeFileSync(file, "second version");
      },
    }),
    error => error.code === "FILE_CHANGED",
  );
});

test("configured secondary roots are allowed independently of the prep cwd", async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-cwd-"));
  const mirror = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-mirror-"));
  t.after(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(mirror, { recursive: true, force: true }); });
  const mirrored = path.join(mirror, "mirrored.zip");
  writeFileSync(mirrored, "mirror bytes");
  const prepared = await prepareLobbySourceFile(mirrored, { roots: [cwd, mirror] });
  assert.equal(prepared.filename, "mirrored.zip");
});

test("status supports bounded waitMs and returns the terminal report once", async () => {
  const page = createLobbyFixture();
  const client = new MtLobbyClient({ getWebContents: () => page.webContents });
  const started = await client.runImport(client.captureTarget(), "prep-secret");
  assert.equal(started.jobId, "job-1");
  const result = await client.statusJob("job-1", { waitMs: 2_500 });
  assert.equal(result.phase, "succeeded");
  assert.equal(result.report.actors, 12);
  assert.ok(page.state.statusCalls >= 2);
});

test("cancel is a real contract call and unknown job ids fail closed", async () => {
  const page = createLobbyFixture();
  const client = new MtLobbyClient({ getWebContents: () => page.webContents });
  await client.runImport(client.captureTarget(), "prep-secret");
  const cancelled = await client.cancelJob("job-1");
  assert.equal(cancelled.phase, "cancelling");
  assert.deepEqual(page.state.cancelCalls, [{ jobId: "job-1" }]);
  await assert.rejects(client.cancelJob("unknown"), error => error.code === "JOB_NOT_FOUND");
});

test("job lifecycle accepts phase/status/state and treats succeeded as terminal", () => {
  assert.equal(jobPhaseOf({ phase: "succeeded" }), "succeeded");
  assert.equal(jobPhaseOf({ status: "completed" }), "completed");
  assert.equal(jobPhaseOf({ state: "failed" }), "failed");
  assert.equal(jobPhaseOf({ phase: "unknown", status: "succeeded" }), "succeeded");
  assert.equal(jobPhaseOf({ phase: "running", status: "succeeded" }), "running");
  assert.equal(isTerminalJob({ phase: "succeeded" }), true);
  assert.equal(isTerminalJob({ phase: "cancelled" }), true);
  assert.equal(isTerminalJob({ phase: "cancelling" }), false);
  assert.equal(isTerminalJob({ status: "completed" }), true);
  assert.equal(isTerminalJob({ terminal: true, phase: "running" }), true);
});

test("status reads a compat phase=succeeded job without degrading to unknown", async () => {
  const page = createLobbyFixture();
  page.service.lobbyImportStatus = async ({ jobId }) => {
    page.state.statusCalls += 1;
    return { jobId, phase: "succeeded", terminal: true, report: { actors: 1 }, failures: [] };
  };
  const client = new MtLobbyClient({ getWebContents: () => page.webContents });
  const started = await client.runImport(client.captureTarget(), "prep-secret");
  const result = await client.statusJob(started.jobId, { waitMs: 1_000 });
  assert.equal(jobPhaseOf(result), "succeeded");
  assert.equal(isTerminalJob(result), true);
  assert.equal(page.state.statusCalls, 1);
});

test("MtLobbyError is the stable error type used by the client", async () => {
  const { client } = fixture();
  await assert.rejects(client.call("notAnAction", {}), MtLobbyError);
});

// ---- 方案 B：play → lobby 的 URL 分类与有界就绪等待 ----

const PLAY_URL = "https://arcanemap.com/user-files/compat/play.html?campaign=campaign-1";
const AUTH_URL = "https://arcanemap.com/auth/realms/arcane/protocol/openid-connect/auth?client_id=compat";

test("classifyPanelUrl reads the campaign from the play URL and fails closed everywhere else", () => {
  const play = createLobbyFixture({ url: PLAY_URL });
  const playClient = new MtLobbyClient({ getWebContents: () => play.webContents });
  assert.deepEqual(playClient.classifyPanelUrl(), {
    kind: "play",
    url: PLAY_URL,
    path: "/user-files/compat/play.html",
    origin: "https://arcanemap.com",
    campaignId: "campaign-1",
  });

  const lobby = createLobbyFixture();
  assert.equal(new MtLobbyClient({ getWebContents: () => lobby.webContents }).classifyPanelUrl().kind, "lobby");

  const auth = createLobbyFixture({ url: AUTH_URL });
  assert.equal(new MtLobbyClient({ getWebContents: () => auth.webContents }).classifyPanelUrl().kind, "auth");

  const noCampaign = createLobbyFixture({ url: "https://arcanemap.com/user-files/compat/play.html" });
  assert.throws(
    () => new MtLobbyClient({ getWebContents: () => noCampaign.webContents }).classifyPanelUrl(),
    error => error.code === "PROFILE_MISMATCH",
  );

  const foundry = createLobbyFixture({ url: "https://foundry.example/game" });
  assert.throws(
    () => new MtLobbyClient({ getWebContents: () => foundry.webContents }).classifyPanelUrl(),
    error => error.code === "PROFILE_MISMATCH",
  );

  const evilPlay = createLobbyFixture({ url: "https://evil.example/user-files/compat/play.html?campaign=c1" });
  assert.throws(
    () => new MtLobbyClient({ getWebContents: () => evilPlay.webContents }).classifyPanelUrl(),
    error => error.code === "PROFILE_MISMATCH",
  );

  assert.throws(
    () => new MtLobbyClient({ getWebContents: () => null }).classifyPanelUrl(),
    error => error.code === "TARGET_UNAVAILABLE",
  );
});

test("waitForLobbyReady re-captures the target after navigation instead of failing on the old epoch", async () => {
  const page = createLobbyFixture({ url: PLAY_URL });
  let navigated = false;
  const client = new MtLobbyClient({
    getWebContents: () => page.webContents,
    readyTimeoutMs: 1_000,
    readyPollMs: 10,
    evaluate: async (webContents, expression, options) => {
      if (!navigated) {
        navigated = true;
        page.webContents.navigate(`${LOBBY_URL}?campaign=campaign-1`);
      }
      return evaluateNavigationSafe(webContents, expression, options);
    },
  });
  page.webContents.navigate(LOBBY_URL);
  const ready = await client.waitForLobbyReady({ expectedOrigin: "https://arcanemap.com" });
  assert.equal(ready.path, "/user-files/compat/lobby.html");
  assert.equal(ready.origin, "https://arcanemap.com");
  assert.equal(navigated, true, "the first preflight must have raced a navigation");
});

test("waitForLobbyReady waits for a delayed service and then reports the trusted lobby", async () => {
  const page = createLobbyFixture({ url: PLAY_URL });
  const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 2_000, readyPollMs: 10 });
  const service = page.service;
  page.webContents.navigate(LOBBY_URL);
  page.setService(null);
  const timer = setTimeout(() => page.setService(service), 80);
  try {
    const ready = await client.waitForLobbyReady();
    assert.equal(ready.path, "/user-files/compat/lobby.html");
    assert.equal(ready.protocolVersion, 1);
  } finally {
    clearTimeout(timer);
  }
});

test("waitForLobbyReady maps wrong destinations, auth, and deadlines to stable codes", async (t) => {
  await t.test("wrong path", async () => {
    const page = createLobbyFixture({ url: PLAY_URL });
    const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 300, readyPollMs: 10 });
    page.webContents.navigate("https://arcanemap.com/game");
    await assert.rejects(client.waitForLobbyReady(), error => error.code === "TARGET_CHANGED");
  });

  await t.test("untrusted origin", async () => {
    const page = createLobbyFixture({ url: PLAY_URL });
    const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 300, readyPollMs: 10 });
    page.webContents.navigate("https://evil.example/user-files/compat/lobby.html");
    await assert.rejects(client.waitForLobbyReady(), error => error.code === "TARGET_CHANGED");
  });

  await t.test("different origin than the saved play URL", async () => {
    const page = createLobbyFixture({ url: PLAY_URL });
    const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 300, readyPollMs: 10 });
    page.webContents.navigate("https://arcanemap.cn/user-files/compat/lobby.html");
    await assert.rejects(
      client.waitForLobbyReady({ expectedOrigin: "https://arcanemap.com" }),
      error => error.code === "TARGET_CHANGED",
    );
  });

  await t.test("login flow", async () => {
    const page = createLobbyFixture({ url: PLAY_URL });
    const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 300, readyPollMs: 10 });
    page.webContents.navigate(AUTH_URL);
    await assert.rejects(client.waitForLobbyReady(), error => error.code === "LOGIN_REQUIRED");
  });

  await t.test("stays on play", async () => {
    const page = createLobbyFixture({ url: PLAY_URL });
    const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 120, readyPollMs: 10 });
    await assert.rejects(client.waitForLobbyReady(), error => error.code === "TARGET_CHANGED");
  });

  await t.test("lobby service never becomes ready", async () => {
    const page = createLobbyFixture({ url: PLAY_URL });
    const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 150, readyPollMs: 10 });
    page.webContents.navigate(LOBBY_URL);
    page.setService(null);
    await assert.rejects(client.waitForLobbyReady(), error => error.code === "CAPABILITY_UNAVAILABLE");
  });

  await t.test("lobby page has no signed-in session", async () => {
    const page = createLobbyFixture({ url: PLAY_URL });
    const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 150, readyPollMs: 10 });
    page.webContents.navigate(LOBBY_URL);
    page.setAuth(false);
    await assert.rejects(client.waitForLobbyReady(), error => error.code === "LOGIN_REQUIRED");
  });

  await t.test("panel destroyed", async () => {
    const page = createLobbyFixture({ url: PLAY_URL });
    const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 150, readyPollMs: 10 });
    page.webContents.close();
    await assert.rejects(client.waitForLobbyReady(), error => error.code === "TARGET_UNAVAILABLE");
  });
});

test("a navigation after preflight returns is confirmed with the new document's evidence", async () => {
  const page = createLobbyFixture();
  const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 1_000, readyPollMs: 10 });
  const originalPreflight = client.preflight.bind(client);
  let navigated = false;
  client.preflight = async (action, target, options) => {
    const result = await originalPreflight(action, target, options);
    if (!navigated) {
      navigated = true;
      // 新文档的 service 协议不同：最终回执若来自旧证据会停在 1。
      page.service.protocolVersion = 2;
      page.webContents.navigate(`${LOBBY_URL}?reload=1`);
    }
    return result;
  };

  const ready = await client.waitForLobbyReady({ expectedOrigin: "https://arcanemap.com" });
  assert.equal(navigated, true);
  assert.equal(ready.protocolVersion, 2, "confirmation must come from the new document, not the old preflight");
});

test("uncertain lobby evidence survives a fallback to play until the deadline", async () => {
  const page = createLobbyFixture();
  const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 150, readyPollMs: 10 });
  let first = true;
  client.preflight = async () => {
    if (first) {
      first = false;
      page.webContents.navigate(PLAY_URL);
      throw new MtLobbyError("TARGET_TIMEOUT", "lobby preflight timed out");
    }
    throw new Error("should not be called after the page left the lobby");
  };

  await assert.rejects(client.waitForLobbyReady(), error => error.code === "JOB_INDETERMINATE");
});
