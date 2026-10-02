import assert from "node:assert/strict";
import test from "node:test";

import {
  MT_COMPAT_PATH_SUFFIX,
  PAGE_PROFILES,
  clientPageProfile,
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
