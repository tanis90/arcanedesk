import assert from "node:assert/strict";
import test from "node:test";

import * as pageProfiles from "../src/main/page-profiles.js";
import {
  MT_COMPAT_PATH_SUFFIX,
  MT_COMPAT_TRUSTED_ORIGINS,
  PAGE_PROFILES,
  clientPageProfile,
  createPanelProfileOverrides,
  createPanelProfileState,
  isMtCompatAuthUrl,
  isMtCompatNavigationHold,
  isMtCompatTrustedOrigin,
  matchPageProfile,
  normalizeMtCompatEntryUrl,
  resolvePageProfile,
} from "../src/main/page-profiles.js";

const MT_ORIGIN = "https://arcanemap.ssskill.cn";
const MT_URL = `${MT_ORIGIN}/user-files/compat/play.html`;
const MT_LOBBY_URL = `${MT_ORIGIN}/user-files/compat/lobby.html`;
const MT_AUTH_URL = `${MT_ORIGIN}/auth/realms/arcanevtt/protocol/openid-connect/auth`;
const MT_ALIAS_URL = "https://vtt.arcanedesk.bitterbebop.cn/user-files/compat/play.html";
const MT_BRANCH_URL = `${MT_ORIGIN}/user-files/compat-qa/play.html`;

test("mtcompat site pages are recognized only on the three trusted origins, exact origin match", () => {
  // 白名单恰好三个 origin,精确匹配(new URL().origin):https/http、www、端口、
  // 后缀拼贴域都不算。三个 origin 都是部署白名单，不按 DNS 状态动态增删。
  assert.deepEqual([...MT_COMPAT_TRUSTED_ORIGINS], [
    "https://arcanemap.ssskill.cn",
    "https://arcanemap.com",
    "https://arcanemap.cn",
  ]);
  for (const origin of MT_COMPAT_TRUSTED_ORIGINS) {
    assert.equal(isMtCompatTrustedOrigin(`${origin}/`), true, origin);
    assert.equal(matchPageProfile(`${origin}/user-files/compat/play.html`)?.id, "mtcompat", origin);
    assert.equal(matchPageProfile(`${origin}/user-files/compat/lobby.html`)?.id, "mtcompat", origin);
    assert.equal(matchPageProfile(`${origin}/auth/realms/arcanevtt/protocol/openid-connect/auth`)?.id, "mtcompat", origin);
    // compat-<slug> 分支部署形态(PRD A1 的路径锚点)仍被同档识别。
    assert.equal(matchPageProfile(`${origin}/user-files/compat-qa/play.html`)?.id, "mtcompat", origin);
    assert.equal(matchPageProfile(`${origin}/user-files/compat-feat-agent-api/play.html`)?.id, "mtcompat", origin);
    // 查询串/哈希不参与(Keycloak 换码 URL 带 ?code=...)。
    assert.equal(matchPageProfile(`${origin}/user-files/compat/play.html?code=abc&state=xyz`)?.id, "mtcompat", origin);
    assert.equal(matchPageProfile(`${origin}/user-files/compat-qa/play.html?code=abc#frag`)?.id, "mtcompat", origin);
  }

  // host 是安全边界:同样的 play.html 路径挂在白名单外的域上就是冒牌页 ——
  // 不认 mtcompat,落到 Foundry 开放默认档(加载后走 not-Foundry 报错路径)。
  for (const url of [
    MT_ALIAS_URL, // 旧别名域
    "https://49.7.212.177:30002/user-files/compat/play.html", // IP 直连
    "https://arcanemap.ssskill.cn.evil.test/user-files/compat/play.html", // 后缀拼贴域
    "https://www.arcanemap.ssskill.cn/user-files/compat/play.html",
    "http://arcanemap.ssskill.cn/user-files/compat/play.html", // http 不认
    "https://arcanemap.ssskill.cn:8443/user-files/compat/play.html", // 其他端口不认
  ]) {
    assert.equal(matchPageProfile(url), null, url);
    assert.equal(resolvePageProfile(url).id, "foundry", url);
  }

  // 受信 origin 内,相邻目录名与尾随路径都不算命中。
  assert.equal(matchPageProfile(MT_URL.replace("play.html", "index.html")), null);
  assert.equal(matchPageProfile(`${MT_ORIGIN}/user-files/compatfoo/play.html`), null);
  assert.equal(matchPageProfile(`${MT_ORIGIN}/user-files/compat/play.html/extra`), null);
  // 非受信 origin 的 /auth/** 同样不认(钓鱼 Keycloak 页按 Foundry 档处理)。
  assert.equal(matchPageProfile("https://phish.example.test/auth/realms/mt/protocol/openid-connect/auth"), null);
  assert.equal(matchPageProfile("not a url"), null);
  assert.equal(isMtCompatTrustedOrigin("not a url"), false);
});

test("trusted root and lobby shell URLs normalize to the compat lobby before profile selection", () => {
  for (const origin of MT_COMPAT_TRUSTED_ORIGINS) {
    assert.equal(normalizeMtCompatEntryUrl(`${origin}/`), `${origin}/user-files/compat/lobby.html`, origin);
    assert.equal(normalizeMtCompatEntryUrl(`${origin}/lobby.html`), `${origin}/user-files/compat/lobby.html`, origin);
    assert.equal(
      normalizeMtCompatEntryUrl(`${origin}/lobby.html?from=agent#top`),
      `${origin}/user-files/compat/lobby.html?from=agent#top`,
      origin,
    );
    const play = `${origin}/user-files/compat/play.html`;
    assert.equal(normalizeMtCompatEntryUrl(play), play, origin);
  }
  for (const url of [
    "https://evil.example/",
    "https://evil.example/lobby.html",
    "http://arcanemap.com/",
    "https://www.arcanemap.com/lobby.html",
    "not a url",
  ]) assert.equal(normalizeMtCompatEntryUrl(url), url, url);
});

test("lobby/auth pages are mtcompat site pages but never game paths", () => {
  const mtcompat = PAGE_PROFILES.mtcompat;
  assert.equal(matchPageProfile(MT_LOBBY_URL)?.id, "mtcompat");
  assert.equal(matchPageProfile(MT_AUTH_URL)?.id, "mtcompat");
  // 展示准入 ≠ 游戏准入:isGamePath 仍只允许 play.html。
  assert.equal(mtcompat.isGamePath("/user-files/compat/lobby.html"), false);
  assert.equal(mtcompat.isGamePath("/user-files/compat-qa/lobby.html"), false);
  assert.equal(mtcompat.isGamePath("/auth/realms/arcanevtt/protocol/openid-connect/auth"), false);
  // lobby/auth 路径不满足就绪判定(游戏就绪仍只看 play.html + ready/world/user/指纹)。
  assert.equal(
    mtcompat.isReady({ hasGame: true, ready: true, world: "w", user: "gm", path: "/user-files/compat/lobby.html", hasMtAgentRuntime: true }),
    false,
  );
  assert.equal(
    mtcompat.isReady({ hasGame: true, ready: true, world: "w", user: "gm", path: "/auth/realms/arcanevtt/protocol/openid-connect/auth", hasMtAgentRuntime: true }),
    false,
  );
});

test("isMtCompatNavigationHold is pure URL/path idempotence: auth and same-pathname hold, lobby→play navigates", () => {
  const play = MT_URL;
  const playCampaign = `${play}?campaign=cos`;
  const lobby = MT_LOBBY_URL;
  const auth = `${MT_AUTH_URL}?client_id=arcane&redirect_uri=play`;

  // Keycloak 登录页:重复 open 只回登录中状态、不重新导航 —— 无时间成分,无论过多久。
  assert.equal(isMtCompatNavigationHold(auth, play), true);
  assert.equal(isMtCompatNavigationHold(auth, lobby), true);
  assert.equal(isMtCompatNavigationHold(auth, playCampaign), true);

  // 同 pathname(query 可不同,尤其 play?campaign=)且未就绪:不重复加载。
  assert.equal(isMtCompatNavigationHold(playCampaign, play), true);
  assert.equal(isMtCompatNavigationHold(play, playCampaign), true);
  assert.equal(isMtCompatNavigationHold(lobby, lobby), true);

  // 显式从 lobby 打开 play:同 origin 不同 pathname,是显式意图 —— 正常导航。
  assert.equal(isMtCompatNavigationHold(lobby, play), false);
  // 打开不同 origin(含另两个受信 origin)仍是显式导航。
  assert.equal(isMtCompatNavigationHold(play, "https://arcanemap.com/user-files/compat/play.html"), false);
  assert.equal(isMtCompatNavigationHold("http://localhost:30000/game", play), false);

  // 非受信 origin 的 /auth/** 不触发登录守卫(那是冒牌页,按 Foundry 档报错重试)。
  assert.equal(isMtCompatNavigationHold("https://phish.example.test/auth/realms/mt/login", play), false);
  // 非法 URL 一律不守卫。
  assert.equal(isMtCompatNavigationHold("about:blank", play), false);
  assert.equal(isMtCompatNavigationHold(play, "::bad::"), false);
});

test("isMtCompatAuthUrl only trusts the allowlist /auth/**", () => {
  assert.equal(isMtCompatAuthUrl("https://arcanemap.ssskill.cn/auth/realms/arcanevtt/login"), true);
  assert.equal(isMtCompatAuthUrl("https://arcanemap.com/auth"), true);
  assert.equal(isMtCompatAuthUrl("https://arcanemap.cn/auth/"), true);
  for (const url of [
    "https://arcanemap.ssskill.cn/authenticate", // /auth 前缀但非路径边界
    "https://phish.example.test/auth/realms/mt/login",
    "http://arcanemap.ssskill.cn/auth/realms/arcanevtt/login",
    "https://www.arcanemap.com/auth/login",
    "about:blank",
  ]) {
    assert.equal(isMtCompatAuthUrl(url), false, url);
  }
});

test("the removed 120s login window left no timer constant behind", () => {
  assert.equal(pageProfiles.MT_COMPAT_LOGIN_WINDOW_MS, undefined);
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
    displayName: "奥法地图",
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
