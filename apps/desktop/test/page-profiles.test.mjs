import assert from "node:assert/strict";
import test from "node:test";

import {
  MT_COMPAT_PATH_SUFFIX,
  PAGE_PROFILES,
  clientPageProfile,
  createPanelProfileState,
  matchPageProfile,
  resolvePageProfile,
} from "../src/main/page-profiles.js";

const MT_URL = "https://49.7.212.177:30002/user-files/compat/play.html";
const MT_ALIAS_URL = "https://vtt.arcanedesk.bitterbebop.cn/user-files/compat/play.html";

test("mtcompat URL patterns match both the direct-IP and the alias domain form", () => {
  assert.equal(matchPageProfile(MT_URL)?.id, "mtcompat");
  assert.equal(matchPageProfile(MT_ALIAS_URL)?.id, "mtcompat");
  assert.equal(matchPageProfile(`${MT_URL}?code=abc&state=xyz`)?.id, "mtcompat");
  assert.equal(matchPageProfile(MT_URL.replace("play.html", "index.html")), null);
  assert.equal(matchPageProfile("https://49.7.212.177:30002/auth/realmt/protocol/openid-connect/auth"), null);
  assert.equal(matchPageProfile("not a url"), null);
});

test("resolvePageProfile falls back to the open foundry default for http(s) targets", () => {
  assert.equal(resolvePageProfile(MT_URL).id, "mtcompat");
  for (const url of [
    "http://localhost:30000",
    "http://localhost:30000/game",
    "http://localhost:30000/join",
    "https://foundry.example.test/setup",
  ]) {
    assert.equal(resolvePageProfile(url).id, "foundry", url);
  }
  assert.equal(resolvePageProfile("file:///Users/x/index.html"), null);
  assert.equal(resolvePageProfile("about:blank"), null);
  assert.equal(resolvePageProfile("::bad::"), null);
});

test("foundry profile keeps its exact legacy path and readiness semantics", () => {
  const foundry = PAGE_PROFILES.foundry;
  assert.equal(foundry.isGamePath("/game"), true);
  assert.equal(foundry.isGamePath("/game/"), true);
  assert.equal(foundry.isGamePath("/game//"), true);
  assert.equal(foundry.isGamePath("/join"), false);
  assert.equal(foundry.isGamePath("/lookalike/game"), false);
  assert.equal(foundry.isGamePath(undefined), false);

  assert.equal(foundry.detect({ detected: true }), true);
  assert.equal(foundry.detect({ detected: false }), false);
  assert.equal(
    foundry.isReady({ detected: true, ready: true, gm: true, path: "/game" }),
    true,
  );
  for (const missing of [
    { detected: false, ready: true, gm: true, path: "/game" },
    { detected: true, ready: false, gm: true, path: "/game" },
    { detected: true, ready: true, gm: false, path: "/game" },
    { detected: true, ready: true, gm: true, path: "/join" },
  ]) {
    assert.equal(foundry.isReady(missing), false, JSON.stringify(missing));
  }
});

test("mtcompat profile detects window.game pre-bootstrap and requires world bootstrap for readiness", () => {
  const mtcompat = PAGE_PROFILES.mtcompat;
  assert.equal(mtcompat.isGamePath(MT_COMPAT_PATH_SUFFIX), true);
  assert.equal(mtcompat.isGamePath("/user-files/compat/play.html"), true);
  assert.equal(mtcompat.isGamePath("/auth/realms/mt/protocol/openid-connect/auth"), false);
  assert.equal(mtcompat.isGamePath("/game"), false);

  // window.game exists even before the SPA has bootstrapped the world.
  assert.equal(mtcompat.detect({ hasGame: true, detected: false }), true);
  assert.equal(mtcompat.detect({ hasGame: false, detected: true }), false);

  assert.equal(
    mtcompat.isReady({
      hasGame: true, ready: true, world: "curse-of-strahd", user: "gm", path: "/user-files/compat/play.html",
    }),
    true,
  );
  // GM flag is not part of mtcompat readiness; user presence is.
  assert.equal(
    mtcompat.isReady({
      hasGame: true, ready: true, world: "w", user: "gm", gm: false, path: "/user-files/compat/play.html",
    }),
    true,
  );
  for (const missing of [
    { hasGame: false, ready: true, world: "w", user: "gm", path: "/user-files/compat/play.html" },
    { hasGame: true, ready: false, world: "w", user: "gm", path: "/user-files/compat/play.html" },
    { hasGame: true, ready: true, world: null, user: "gm", path: "/user-files/compat/play.html" },
    { hasGame: true, ready: true, world: "w", user: null, path: "/user-files/compat/play.html" },
    { hasGame: true, ready: true, world: "w", user: "gm", path: "/auth/login" },
  ]) {
    assert.equal(mtcompat.isReady(missing), false, JSON.stringify(missing));
  }
});

test("session semantics differ per profile", () => {
  assert.deepEqual(PAGE_PROFILES.foundry.sessionCookie, { name: "session" });
  assert.equal(PAGE_PROFILES.foundry.landingPath, "/game");
  assert.equal(PAGE_PROFILES.mtcompat.sessionCookie, null);
  assert.equal(PAGE_PROFILES.mtcompat.landingPath, null);
});

test("clientPageProfile leaves foundry undefined and adapts other profiles for the SDK preflight", () => {
  assert.equal(clientPageProfile(PAGE_PROFILES.foundry), undefined);
  assert.equal(clientPageProfile(null), undefined);

  const override = clientPageProfile(PAGE_PROFILES.mtcompat);
  assert.equal(override.id, "mtcompat");
  assert.equal(override.isGamePath({ path: "/user-files/compat/play.html" }), true);
  assert.equal(override.isGamePath({ path: "/game" }), false);
  assert.equal(override.isGamePath({}), false);
  assert.equal(
    override.isReady({ hasGame: true, ready: true, world: "w", user: "gm", path: "/user-files/compat/play.html" }),
    true,
  );
  assert.equal(override.isReady({ hasGame: true, ready: true, world: "w", user: "gm", path: "/auth" }), false);
});


test("panel profile state seeds the null profile until the panel first opens", () => {
  const state = createPanelProfileState();
  assert.deepEqual(state.current(), {
    type: "panel_profile",
    profileId: null,
    url: null,
    displayName: null,
  });
  // null 档上的重复 set 依然去重。
  assert.equal(state.set(null, null), null);
});

test("panel profile state emits on change and dedupes unchanged values", () => {
  const state = createPanelProfileState();
  const first = state.set("foundry", "http://localhost:30000");
  assert.deepEqual(first, {
    type: "panel_profile",
    profileId: "foundry",
    url: "http://localhost:30000",
    displayName: "Foundry VTT",
  });
  // 同值重复:set 返回 null(不重复推送),current 仍报当前档。
  assert.equal(state.set("foundry", "http://localhost:30000"), null);
  assert.deepEqual(state.current(), first);
  // 同档内 URL 变化(url 是 payload 的一部分)也要发 —— reload/二次导航路径。
  assert.deepEqual(state.set("foundry", "http://localhost:30000/game"), {
    type: "panel_profile",
    profileId: "foundry",
    url: "http://localhost:30000/game",
    displayName: "Foundry VTT",
  });
});

test("panel profile state maps displayName from PAGE_PROFILES", () => {
  const state = createPanelProfileState();
  assert.deepEqual(state.set("mtcompat", MT_URL), {
    type: "panel_profile",
    profileId: "mtcompat",
    url: MT_URL,
    displayName: "MT Compat",
  });
  // 切档(profileId 变、url 也变了)同样产出新 payload。
  assert.deepEqual(state.set("foundry", "http://localhost:30000"), {
    type: "panel_profile",
    profileId: "foundry",
    url: "http://localhost:30000",
    displayName: "Foundry VTT",
  });
});

test("panel profile state clears to the null profile when the panel closes", () => {
  const state = createPanelProfileState();
  state.set("mtcompat", MT_URL);
  // null 档强制 url/displayName 为 null,即使调用方带了 url。
  assert.deepEqual(state.set(null, MT_URL), {
    type: "panel_profile",
    profileId: null,
    url: null,
    displayName: null,
  });
  assert.equal(state.set(null, null), null);
  assert.deepEqual(state.current(), {
    type: "panel_profile",
    profileId: null,
    url: null,
    displayName: null,
  });
});

test("panel profile state treats unknown profile ids as the null profile", () => {
  const state = createPanelProfileState();
  state.set("foundry", "http://localhost:30000");
  assert.deepEqual(state.set("stealth-profile", "http://localhost:30000"), {
    type: "panel_profile",
    profileId: null,
    url: null,
    displayName: null,
  });
});
