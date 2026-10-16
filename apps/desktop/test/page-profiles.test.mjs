import assert from "node:assert/strict";
import test from "node:test";

import {
  MT_COMPAT_PATH_SUFFIX,
  PAGE_PROFILES,
  clientPageProfile,
  createPanelProfileOverrides,
  createPanelProfileState,
  matchPageProfile,
  resolvePageProfile,
} from "../src/main/page-profiles.js";

const MT_URL = "https://49.7.212.177:30002/user-files/compat/play.html";
const MT_ALIAS_URL = "https://vtt.arcanedesk.bitterbebop.cn/user-files/compat/play.html";
const MT_BRANCH_URL = "https://49.7.212.177:30002/user-files/compat-qa/play.html";

test("mtcompat URL patterns cover IP, alias, compat-<slug> branch deploys and query strings", () => {
  assert.equal(matchPageProfile(MT_URL)?.id, "mtcompat");
  assert.equal(matchPageProfile(MT_ALIAS_URL)?.id, "mtcompat");
  // 分支部署目录形态 compat-<slug>(PRD A1 的 URL 契约,一次放宽覆盖三形态)。
  assert.equal(matchPageProfile(MT_BRANCH_URL)?.id, "mtcompat");
  assert.equal(matchPageProfile("https://49.7.212.177:30002/user-files/compat-feat-agent-api/play.html")?.id, "mtcompat");
  assert.equal(matchPageProfile(`${MT_URL}?code=abc&state=xyz`)?.id, "mtcompat");
  assert.equal(matchPageProfile(`${MT_BRANCH_URL}?code=abc#frag`)?.id, "mtcompat");
  // 锚定在 pathname 末段:相邻目录名与尾随路径都不算命中。
  assert.equal(matchPageProfile(MT_URL.replace("play.html", "index.html")), null);
  assert.equal(matchPageProfile("https://49.7.212.177:30002/user-files/compatfoo/play.html"), null);
  assert.equal(matchPageProfile("https://49.7.212.177:30002/user-files/compat/play.html/extra"), null);
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
  assert.equal(mtcompat.isGamePath("/user-files/compat-qa/play.html"), true); // 分支部署形态
  assert.equal(mtcompat.isGamePath("/user-files/compatfoo/play.html"), false);
  assert.equal(mtcompat.isGamePath("/user-files/compat/play.html/extra"), false);
  assert.equal(mtcompat.isGamePath("/auth/realms/mt/protocol/openid-connect/auth"), false);
  assert.equal(mtcompat.isGamePath("/game"), false);

  // window.game exists even before the SPA has bootstrapped the world.
  assert.equal(mtcompat.detect({ hasGame: true, detected: false }), true);
  assert.equal(mtcompat.detect({ hasGame: false, detected: true }), false);

  assert.equal(
    mtcompat.isReady({
      hasGame: true, ready: true, world: "curse-of-strahd", user: "gm",
      path: "/user-files/compat/play.html", hasMtAgentRuntime: true,
    }),
    true,
  );
  // GM flag is not part of mtcompat readiness; user presence is.
  assert.equal(
    mtcompat.isReady({
      hasGame: true, ready: true, world: "w", user: "gm", gm: false,
      path: "/user-files/compat-qa/play.html", hasMtAgentRuntime: true,
    }),
    true,
  );
  for (const missing of [
    { hasGame: false, ready: true, world: "w", user: "gm", path: "/user-files/compat/play.html", hasMtAgentRuntime: true },
    { hasGame: true, ready: false, world: "w", user: "gm", path: "/user-files/compat/play.html", hasMtAgentRuntime: true },
    { hasGame: true, ready: true, world: null, user: "gm", path: "/user-files/compat/play.html", hasMtAgentRuntime: true },
    { hasGame: true, ready: true, world: "w", user: null, path: "/user-files/compat/play.html", hasMtAgentRuntime: true },
    { hasGame: true, ready: true, world: "w", user: "gm", path: "/auth/login", hasMtAgentRuntime: true },
    { hasGame: true, ready: true, world: "w", user: "gm", path: "/user-files/compat/play.html" },
  ]) {
    assert.equal(mtcompat.isReady(missing), false, JSON.stringify(missing));
  }
});

test("the mtcompat runtime fingerprint only corroborates readiness, never recognition", () => {
  const mtcompat = PAGE_PROFILES.mtcompat;
  // 指纹缺席 = 未佐证态:URL 命中 + window.game 在位 → 识别照旧(detect true),
  // 但 runtime 没自证 → isReady 不成立(指纹是合取进就绪判定的佐证)。
  const unattested = {
    hasGame: true, ready: true, world: "w", user: "gm",
    path: "/user-files/compat/play.html", hasMtAgentRuntime: false,
  };
  assert.equal(mtcompat.detect(unattested), true);
  assert.equal(mtcompat.isReady(unattested), false);
  // 指纹在位但不满足 URL 契约(例如同源其它路径):识别与就绪都不成立 —— 指纹
  // 不是第二检测机制,URL 仍是主证据。
  const offPath = { ...unattested, path: "/auth/login", hasMtAgentRuntime: true };
  assert.equal(mtcompat.detect(offPath), true); // hasGame 仍在:页内信号,不算命中档位
  assert.equal(mtcompat.isReady(offPath), false);
  assert.equal(matchPageProfile("https://mt.test/auth/login"), null);
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
  assert.equal(override.isGamePath({ path: "/user-files/compat-qa/play.html" }), true);
  assert.equal(override.isGamePath({ path: "/game" }), false);
  assert.equal(override.isGamePath({}), false);
  assert.equal(
    override.isReady({
      hasGame: true, ready: true, world: "w", user: "gm",
      path: "/user-files/compat/play.html", hasMtAgentRuntime: true,
    }),
    true,
  );
  // 指纹缺席:识别照旧,但 SDK preflight 不把它当就绪(未佐证态)。
  assert.equal(
    override.isReady({ hasGame: true, ready: true, world: "w", user: "gm", path: "/user-files/compat/play.html" }),
    false,
  );
  assert.equal(
    override.isReady({
      hasGame: true, ready: true, world: "w", user: "gm", path: "/auth", hasMtAgentRuntime: true,
    }),
    false,
  );
});


test("hidden per-URL profile overrides resolve by prefix with boundary and longest-key-wins", () => {
  const logs = [];
  const parse = raw => createPanelProfileOverrides(raw, message => logs.push(message));

  // 未配置 → 永不命中,也不落日志。
  const empty = parse("  ");
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.resolve(MT_URL), null);
  assert.deepEqual(logs, []);

  const overrides = parse(JSON.stringify({
    "https://49.7.212.177:30002/user-files/compat-dev": "mtcompat",
    "http://localhost:5173/": "mtcompat",
    "https://vtt.example.test/user-files/compat/play.html": "foundry",
  }));
  assert.deepEqual(overrides.entries.map(entry => entry.prefix), [
    "https://vtt.example.test/user-files/compat/play.html",
    "https://49.7.212.177:30002/user-files/compat-dev",
    "http://localhost:5173",
  ]);
  assert.equal(overrides.resolve("https://49.7.212.177:30002/user-files/compat-dev/play.html?x=1")?.id, "mtcompat");
  assert.equal(overrides.resolve("https://49.7.212.177:30002/user-files/compat-dev")?.id, "mtcompat");
  // 边界判定:/compat-devfoo 不吃 /compat-dev 的覆盖。
  assert.equal(overrides.resolve("https://49.7.212.177:30002/user-files/compat-devfoo/play.html"), null);
  // 尾部斜杠归一:写 origin 带不带斜杠等效。
  assert.equal(overrides.resolve("http://localhost:5173/index.html")?.id, "mtcompat");
  // 值可以是 foundry —— 把被模式误判的地址拉回开放默认档。
  assert.equal(overrides.resolve("https://vtt.example.test/user-files/compat/play.html")?.id, "foundry");
  assert.equal(overrides.resolve("https://elsewhere.test/user-files/compat/play.html"), null);

  // 最长前缀优先(更具体的 URL 覆盖更宽的 origin)。
  const nested = parse(JSON.stringify({
    "https://host.test/user-files": "foundry",
    "https://host.test/user-files/compat-dev": "mtcompat",
  }));
  assert.equal(nested.resolve("https://host.test/user-files/compat-dev/play.html")?.id, "mtcompat");
  assert.equal(nested.resolve("https://host.test/user-files/other")?.id, "foundry");
});

test("malformed profile override config is ignored with a warning, never fatal", () => {
  const logs = [];
  const parse = raw => createPanelProfileOverrides(raw, message => logs.push(message));

  const partial = parse(JSON.stringify({ "https://x.test": "mtcompat", "https://y.test": "stealth-profile" }));
  assert.equal(partial.entries.length, 1);
  assert.equal(partial.resolve("https://x.test/anything")?.id, "mtcompat");
  assert.equal(partial.resolve("https://y.test/anything"), null);
  assert.ok(logs.some(message => /unknown profile/.test(message)));

  assert.deepEqual(parse("not json").entries, []);
  assert.ok(logs.some(message => /ARCANEDESK_PANEL_PROFILE_OVERRIDES: invalid JSON/.test(message)));
  assert.deepEqual(parse("[1,2]").entries, []);
  assert.ok(logs.some(message => /expected a JSON object/.test(message)));
  assert.deepEqual(parse("42").entries, []);
  assert.deepEqual(parse('{"":"mtcompat"}').entries, []);
  assert.ok(logs.some(message => /empty URL prefix/.test(message)));
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
