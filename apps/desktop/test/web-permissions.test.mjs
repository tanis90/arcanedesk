import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DisplayMediaController } from "../src/main/permissions/display-media.js";
import { WebPermissionPolicy } from "../src/main/permissions/web-permission-policy.js";
import { WebPermissionStore } from "../src/main/permissions/web-permission-store.js";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "arcane-web-permissions-test-"));
  const file = join(dir, "web-permissions.json");
  return { file, store: new WebPermissionStore(file, () => {}) };
}

function requestDetails(overrides = {}) {
  return {
    isMainFrame: true,
    requestingUrl: "https://foundry.example/game",
    securityOrigin: "https://foundry.example",
    ...overrides,
  };
}

function checkDetails(overrides = {}) {
  return { isMainFrame: true, ...overrides };
}

function policyFixture(store = tempStore().store) {
  const chat = { id: 1 };
  const foundry = { id: 2 };
  const events = [];
  let nextId = 0;
  const policy = new WebPermissionPolicy({
    store,
    getChatWebContents: () => chat,
    getFoundryWebContents: () => foundry,
    getFoundryOrigin: () => "https://foundry.example",
    sendToRenderer: (event) => events.push(event),
    idFactory: () => `permission-${++nextId}`,
    requestTimeoutMs: 5_000,
    log: () => {},
  });
  return { chat, foundry, events, policy };
}

test("permission store keeps only exact http(s) origins and persistable keys", () => {
  const { file } = tempStore();
  writeFileSync(file, JSON.stringify({
    version: 99,
    origins: {
      "https://foundry.example/path": {
        "media:audio": "allow",
        "clipboard-read": "allow",
        notifications: "maybe",
      },
      "file:///tmp/test": { "media:video": "allow" },
    },
  }));

  const store = new WebPermissionStore(file, () => {});
  assert.equal(store.get("https://foundry.example", "media:audio"), "allow");
  assert.equal(store.get("https://foundry.example", "clipboard-read"), null);
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.list()[0], {
    origin: "https://foundry.example",
    permissions: [{ key: "media:audio", decision: "allow" }],
  });
});

test("permission store persists, revokes, and clears decisions", () => {
  const { file, store } = tempStore();
  assert.deepEqual(store.set("https://foundry.example:443/game", "media:video", "allow"), { ok: true });
  assert.deepEqual(store.set("https://foundry.example", "notifications", "deny"), { ok: true });
  const persisted = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.origins["https://foundry.example"]["media:video"], "allow");
  assert.equal(persisted.origins["https://foundry.example"].notifications, "deny");

  store.revoke("https://foundry.example", "media:video");
  assert.equal(store.get("https://foundry.example", "media:video"), null);
  store.clear("https://foundry.example");
  assert.deepEqual(store.list(), []);
});

test("chat receives audio only, never camera or unknown media", () => {
  const { chat, policy } = policyFixture();
  assert.equal(policy.check(chat, "media", "null", checkDetails({ mediaType: "audio" })), true);
  assert.equal(policy.check(chat, "media", "null", checkDetails({ mediaType: "video" })), false);

  let audio;
  policy.request(chat, "media", (granted) => { audio = granted; }, { mediaTypes: ["audio"] });
  assert.equal(audio, true);
  // video 在策略层被统一剥离,chat 请求 audio+video 实际只获得 audio
  let combined;
  policy.request(chat, "media", (granted) => { combined = granted; }, { mediaTypes: ["audio", "video"] });
  assert.equal(combined, true);
  let unknown;
  policy.request(chat, "media", (granted) => { unknown = granted; }, {});
  assert.equal(unknown, false);
});

test("Foundry fixed allows require exact origin and the main frame", () => {
  const { foundry, policy } = policyFixture();
  assert.equal(policy.check(foundry, "fullscreen", "https://foundry.example", checkDetails()), true);
  assert.equal(policy.check(foundry, "fullscreen", "https://foundry.example:444", checkDetails()), false);
  assert.equal(policy.check(foundry, "fullscreen", "https://foundry.example", checkDetails({ isMainFrame: false })), false);
  assert.equal(policy.check({ id: 3 }, "fullscreen", "https://foundry.example", checkDetails()), false);

  let crossOrigin;
  policy.request(foundry, "fullscreen", (granted) => { crossOrigin = granted; }, requestDetails({
    requestingUrl: "https://evil.example/frame",
  }));
  assert.equal(crossOrigin, false);

  let display;
  policy.request(foundry, "display-capture", (granted) => { display = granted; }, requestDetails());
  assert.equal(display, true); // The separate display controller still requires gesture + source choice.
  let unknown;
  policy.request(foundry, "unknown", (granted) => { unknown = granted; }, requestDetails());
  assert.equal(unknown, false);
});

test("Foundry media prompt grants a session without asking again", () => {
  const { foundry, events, policy } = policyFixture();
  let granted;
  policy.request(foundry, "media", (value) => { granted = value; }, requestDetails({ mediaTypes: ["audio", "video"] }));
  assert.equal(granted, undefined);
  assert.deepEqual(events.at(-1).mediaTypes, ["audio"]); // video 不进弹窗:策略层直接剥离
  assert.equal(policy.check(foundry, "media", "https://foundry.example", checkDetails({ mediaType: "audio" })), false);

  assert.deepEqual(policy.respond(events.at(-1).requestId, "allow-session"), { ok: true, granted: true });
  assert.equal(granted, true);
  assert.equal(policy.check(foundry, "media", "https://foundry.example", checkDetails({ mediaType: "audio" })), true);
  // 即使弹窗允许过,摄像头也永远不会被授予
  assert.equal(policy.check(foundry, "media", "https://foundry.example", checkDetails({ mediaType: "video" })), false);

  let second;
  policy.request(foundry, "media", (value) => { second = value; }, requestDetails({ mediaTypes: ["audio"] }));
  assert.equal(second, true);
});

test("video requests are denied outright; audio prompts on its own", () => {
  const { foundry, events, policy } = policyFixture();
  const results = [];
  policy.request(foundry, "media", (value) => results.push(["audio", value]), requestDetails({ mediaTypes: ["audio"] }));
  policy.request(foundry, "media", (value) => results.push(["video", value]), requestDetails({ mediaTypes: ["video"] }));
  // video 同步被拒(不进弹窗、不发事件);audio 仍在等待用户选择
  assert.deepEqual(results, [["video", false]]);
  const prompt = events.filter((event) => event.type === "permission_request").at(-1);
  assert.deepEqual(prompt.mediaTypes, ["audio"]);
  policy.respond(prompt.requestId, "deny");
  assert.deepEqual(results, [["video", false], ["audio", false]]);
  assert.equal(events.filter((event) => event.type === "permission_resolved").length, 1);
});

test("persistent allow survives policy recreation and persistent deny is silent", () => {
  const { store } = tempStore();
  store.set("https://foundry.example", "notifications", "allow");
  store.set("https://foundry.example", "media:video", "deny");
  const { foundry, events, policy } = policyFixture(store);
  assert.equal(policy.check(foundry, "notifications", "https://foundry.example", checkDetails()), true);

  let notification;
  policy.request(foundry, "notifications", (value) => { notification = value; }, requestDetails());
  assert.equal(notification, true);
  let video;
  policy.request(foundry, "media", (value) => { video = value; }, requestDetails({ mediaTypes: ["video"] }));
  assert.equal(video, false);
  assert.equal(events.some((event) => event.type === "permission_request"), false);

  // 历史遗留的 media:video allow 也不再生效:策略层根本不查 video 的授权
  store.set("https://foundry.example", "media:video", "allow");
  assert.equal(policy.check(foundry, "media", "https://foundry.example", checkDetails({ mediaType: "video" })), false);
});

test("same-origin navigation can cancel pending requests without clearing grants", () => {
  const { foundry, events, policy } = policyFixture();
  let first;
  policy.request(foundry, "notifications", (value) => { first = value; }, requestDetails());
  policy.respond(events.at(-1).requestId, "allow-session");
  assert.equal(first, true);

  let pending;
  policy.request(foundry, "clipboard-read", (value) => { pending = value; }, requestDetails());
  policy.cancelPending("same-origin-reload");
  assert.equal(pending, false);
  assert.equal(policy.check(foundry, "notifications", "https://foundry.example", checkDetails()), true);

  policy.clearSessionGrants("panel-closed");
  assert.equal(policy.check(foundry, "notifications", "https://foundry.example", checkDetails()), false);
});

test("three user denials silence prompt spam for the current panel lifecycle", () => {
  const { foundry, events, policy } = policyFixture();
  const results = [];
  for (let index = 0; index < 3; index += 1) {
    policy.request(foundry, "clipboard-read", (value) => results.push(value), requestDetails());
    const prompt = events.filter((event) => event.type === "permission_request").at(-1);
    policy.respond(prompt.requestId, "deny");
  }
  const promptCount = events.filter((event) => event.type === "permission_request").length;
  policy.request(foundry, "clipboard-read", (value) => results.push(value), requestDetails());
  assert.equal(events.filter((event) => event.type === "permission_request").length, promptCount);
  assert.deepEqual(results, [false, false, false, false]);
});

function image(value) {
  return {
    isEmpty: () => !value,
    toDataURL: () => value,
  };
}

function displayFixture() {
  const mainFrame = {
    parent: null,
    frameTreeNodeId: 20,
    origin: "https://foundry.example",
    isDestroyed: () => false,
  };
  const webContents = { mainFrame, isDestroyed: () => false };
  const source = {
    id: "screen:1:0",
    name: "Screen 1",
    thumbnail: image("data:image/png;base64,preview"),
    appIcon: image(""),
  };
  const events = [];
  const controller = new DisplayMediaController({
    desktopCapturer: { getSources: async () => [source] },
    getFoundryWebContents: () => webContents,
    getFoundryOrigin: () => "https://foundry.example",
    sendToRenderer: (event) => events.push(event),
    platform: "win32",
    idFactory: () => "display-1",
    requestTimeoutMs: 5_000,
    log: () => {},
  });
  const request = {
    frame: mainFrame,
    securityOrigin: "https://foundry.example",
    videoRequested: true,
    audioRequested: true,
    userGesture: true,
  };
  return { controller, events, request, source };
}

test("display capture requires user gesture, main frame, and exact origin", async () => {
  const { controller, events, request } = displayFixture();
  let noGesture;
  await controller.handle({ ...request, userGesture: false }, (streams) => { noGesture = streams; });
  assert.deepEqual(noGesture, {});
  let iframe;
  await controller.handle({ ...request, frame: { ...request.frame, parent: {} } }, (streams) => { iframe = streams; });
  assert.deepEqual(iframe, {});
  let wrongOrigin;
  await controller.handle({ ...request, securityOrigin: "https://evil.example" }, (streams) => { wrongOrigin = streams; });
  assert.deepEqual(wrongOrigin, {});
  assert.deepEqual(events, []);
});

test("display capture exposes a source chooser and returns only the selected source", async () => {
  const { controller, events, request, source } = displayFixture();
  let streams;
  await controller.handle(request, (value) => { streams = value; });
  const prompt = events.find((event) => event.type === "display_source_request");
  assert.equal(prompt.sources[0].id, source.id);
  assert.equal(prompt.audioAvailable, true);
  assert.equal(streams, undefined);

  assert.deepEqual(controller.respond(prompt.requestId, source.id, true), { ok: true, granted: true });
  assert.equal(streams.video, source);
  assert.equal(streams.audio, "loopback");
  assert.equal(events.at(-1).type, "display_source_resolved");
});

test("display capture cancellation returns an empty stream selection", async () => {
  const { controller, events, request } = displayFixture();
  let streams;
  await controller.handle(request, (value) => { streams = value; });
  controller.cancelAll("navigation");
  assert.deepEqual(streams, {});
  assert.equal(events.at(-1).reason, "navigation");
});
