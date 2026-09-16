import assert from "node:assert/strict";
import test from "node:test";

import {
  PanelSurfaceController,
  READER_CONTENT_CHANNEL,
  READER_LOCALE_CHANNEL,
  READER_THEME_CHANNEL,
  STATE,
} from "../src/main/panel-surface-controller.js";

// 状态机不 import electron,所以整套四态 × 四事件转移表用假 view 就能跑完(md-reader-spec §9)。

/** 假 WebContentsView:记录显隐、bounds、穿透与收到的 IPC。
    destroyed 与 crashed 分开建模:真实 renderer 崩溃(render-process-gone)后
    isDestroyed() 仍是 false,只有 isCrashed() 为 true(review BUG-4)。 */
function fakeView(label) {
  const view = {
    label,
    visible: false,
    bounds: null,
    ignoreMouse: null,
    destroyed: false,
    crashed: false,
    sent: [],
    setVisible(value) { view.visible = value; },
    setBounds(value) { view.bounds = value; },
    webContents: {
      isDestroyed: () => view.destroyed,
      isCrashed: () => view.crashed,
      send: (channel, payload) => view.sent.push({ channel, payload }),
      setIgnoreMouseEvents: (value) => { view.ignoreMouse = value; },
    },
  };
  return view;
}

const BOUNDS = { x: 486, y: 36, width: 1028, height: 884 };

function harness({ notes = {} } = {}) {
  const events = [];
  const views = [];
  const calls = { loadFoundry: 0, reloadFoundry: 0, readNote: [], rereadNote: [], destroyed: [] };
  const window = { destroyed: false, isDestroyed: () => window.destroyed };
  let controller;
  const hooks = {
    getWindow: () => window,
    computeLayout: () => (window.destroyed ? null : { bounds: BOUNDS, chatWidth: 480, gutter: 6 }),
    emit: (event) => events.push(event),
    createFoundryView: () => { const view = fakeView("foundry"); views.push(view); return view; },
    destroyFoundryView: (view, reason) => { view.destroyed = true; calls.destroyed.push({ label: "foundry", reason }); },
    createReaderView: () => { const view = fakeView("reader"); views.push(view); return view; },
    destroyReaderView: (view) => { view.destroyed = true; calls.destroyed.push({ label: "reader" }); },
    // main.js 的 openFoundryView:建 view → surface 归位 → 加载页面。这里省掉页面加载。
    loadFoundry: async () => { calls.loadFoundry++; controller.showFoundry(); return { ok: true }; },
    reloadFoundry: async () => { calls.reloadFoundry++; return { ok: true }; },
    readNote: (rawPath) => {
      calls.readNote.push(rawPath);
      return notes[rawPath] ?? { name: "npc.md", text: `# ${rawPath}`, truncated: false };
    },
    // main.js 的 reloadNotePayload:按打开时的 absolute + baseDir 快照复检后重读(N4)。
    // 这里用 notes 里的 reread 键模拟磁盘现状,默认回一份通用内容。
    rereadNote: (absolute, baseDir) => {
      calls.rereadNote.push([absolute, baseDir]);
      return notes[`reread:${absolute}`] ?? { name: "npc.md", text: `# ${absolute}`, truncated: false };
    },
  };
  controller = new PanelSurfaceController(hooks);
  const live = (label) => views.filter((view) => view.label === label && !view.destroyed);
  return {
    controller,
    events,
    views,
    calls,
    window,
    live,
    visible: () => views.filter((view) => view.visible && !view.destroyed),
    content: () => live("reader")[0]?.sent
      .filter((message) => message.channel === READER_CONTENT_CHANNEL).at(-1)?.payload ?? null,
    setNote: (rawPath, payload) => { notes[rawPath] = payload; },
  };
}

/** 不变量 1 的唯一断言点:每次转移之后都调它。 */
function assertSingleVisible(h, message) {
  const shown = h.visible();
  assert.ok(shown.length <= 1, `${message}: ${shown.length} views visible at once`);
  return shown[0] ?? null;
}

// ---------- §3.4 转移表:CLOSED 行 ----------

test("CLOSED: ① opens Foundry, ② opens the reader without Foundry, ④ opens Foundry", async () => {
  const h = harness();
  assert.equal(h.controller.state, STATE.CLOSED);

  await h.controller.openPanel();
  assert.equal(h.controller.state, STATE.FOUNDRY);
  assert.equal(h.calls.loadFoundry, 1);
  assert.equal(assertSingleVisible(h, "CLOSED --①").label, "foundry");

  h.controller.closePanel();
  assert.equal(h.controller.state, STATE.CLOSED);
  assert.equal(h.visible().length, 0);
  assert.deepEqual(h.events.slice(-2), [
    { type: "panel_status", open: false, surface: null },
    { type: "panel_layout", open: false },
  ]);

  h.controller.showReader("notes/a.md");
  assert.equal(h.controller.state, STATE.READER_C);
  assert.equal(h.controller.origin, "closed");
  assert.equal(h.live("foundry").length, 0, "READER_C must not create a Foundry view");
  assert.equal(assertSingleVisible(h, "CLOSED --②").label, "reader");

  h.controller.closePanel();

  h.controller.showFoundry();
  assert.equal(h.controller.state, STATE.FOUNDRY);
  assert.equal(assertSingleVisible(h, "CLOSED --④").label, "foundry");
});

// ---------- §3.4 转移表:FOUNDRY 行 ----------

test("FOUNDRY: ① closes, ② covers with the reader, ④ is idempotent", async () => {
  const h = harness();
  await h.controller.openPanel();

  h.controller.showReader("notes/a.md");
  assert.equal(h.controller.state, STATE.READER_F);
  const foundry = h.live("foundry")[0];
  assert.equal(foundry.destroyed, false, "② keeps the Foundry page alive underneath");
  assert.equal(foundry.visible, false);
  assert.equal(assertSingleVisible(h, "FOUNDRY --②").label, "reader");

  h.controller.showFoundry();
  assert.equal(h.controller.state, STATE.FOUNDRY);
  assert.equal(assertSingleVisible(h, "FOUNDRY --④").label, "foundry");

  h.controller.closePanel();
  assert.equal(h.controller.state, STATE.CLOSED);
  assert.equal(h.live("foundry").length, 0);

  await h.controller.openPanel();
  assert.equal(h.controller.state, STATE.FOUNDRY);
  assert.equal(h.calls.loadFoundry, 2);
});

// ---------- §3.4 转移表:READER_F 行 ----------

test("READER_F: ② swaps content without resetting origin, switching back to Foundry only flips visibility", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  assert.equal(h.controller.state, STATE.READER_F);
  assert.equal(h.controller.origin, "foundry");

  h.controller.showReader("notes/b.md");
  assert.equal(h.controller.state, STATE.READER_F);
  assert.equal(h.controller.origin, "foundry", "换笔记不重置 origin(§3.1)");
  assert.deepEqual(h.calls.readNote, ["notes/a.md", "notes/b.md"]);
  assert.equal(h.live("reader").length, 1, "the reader view is reused, not rebuilt");

  h.controller.switchSurface("foundry");
  assert.equal(h.controller.state, STATE.FOUNDRY);
  assert.equal(h.calls.loadFoundry, 1, "不变量 2:切换只做显隐切换,永不加载 FVTT");
  assert.equal(h.live("reader").length, 1, "切走之后阅读器保活");
  assert.equal(assertSingleVisible(h, "READER_F --switch").label, "foundry");
  assert.equal(h.controller.origin, null);
});

test("READER_F: ④ hides the reader, keeps it alive and tells chat nothing", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  const before = h.events.length;

  h.controller.showFoundry();
  assert.equal(h.controller.state, STATE.FOUNDRY);
  const reader = h.live("reader")[0];
  assert.equal(reader.destroyed, false, "④ 隐藏保活,不销毁");
  assert.equal(reader.visible, false);
  // §1 非目标:被顶掉时不往 chat 推系统消息,只允许既有协议事件
  for (const event of h.events.slice(before)) {
    assert.ok(["panel_status", "panel_layout"].includes(event.type), `unexpected chat event: ${event.type}`);
  }
});

test("① restores Foundry when closed from READER_F, the reader when closed from READER_C (BUG-3)", async () => {
  // READER_F 关闭:lastContent 记 foundry,重开落在 Foundry——笔记仍可从 chat 链接再进,
  // 否则 ②→①→② 形成死循环,用户够不到 Foundry(review BUG-3,方案 A)。
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  assert.equal(h.controller.state, STATE.READER_F);
  h.controller.closePanel();
  assert.equal(h.controller.state, STATE.CLOSED);
  assert.equal(h.live("foundry").length, 0);
  assert.equal(h.live("reader").length, 0, "① 关面板销毁两个 view(§8)");

  await h.controller.openPanel();
  assert.equal(h.controller.state, STATE.FOUNDRY, "READER_F 关闭后重开落在 Foundry");
  assert.equal(h.calls.loadFoundry, 2);
  assert.deepEqual(h.calls.readNote, ["notes/a.md"], "重开 Foundry 不重读笔记");

  // READER_C 关闭:底下本来就没有 Foundry,重开恢复笔记(§3.4 CLOSED 行)。
  h.controller.closePanel();
  h.controller.showReader("notes/b.md");
  assert.equal(h.controller.state, STATE.READER_C);
  h.controller.closePanel();

  await h.controller.openPanel();
  assert.equal(h.controller.state, STATE.READER_C, "READER_C 关闭后重开恢复笔记");
  assert.equal(h.controller.origin, "closed");
  assert.equal(h.calls.loadFoundry, 2, "重开笔记不得静默拉起一次 FVTT 加载");
  assert.equal(h.live("foundry").length, 0);
  assert.equal(h.controller.readerPath, "notes/b.md");

  const switched = h.controller.switchSurface("foundry");
  assert.equal(switched.empty, "foundry", "底下没有可切换的 Foundry 现场(不变量 3)");
  assert.equal(h.controller.state, STATE.READER_C, "空切换不改变状态");
  assert.equal(h.calls.loadFoundry, 2, "切换绝不主动拉起 FVTT 加载");
  assert.equal(h.live("reader").length, 1, "阅读器原样保留,笔记不丢");
});

// ---------- §3.4 转移表:READER_C 行 ----------

test("READER_C: ② swaps content, ④ takes over", async () => {
  const h = harness();
  h.controller.showReader("notes/a.md");
  assert.equal(h.controller.state, STATE.READER_C);

  h.controller.showReader("notes/b.md");
  assert.equal(h.controller.state, STATE.READER_C);
  assert.equal(h.controller.origin, "closed");

  h.controller.showFoundry();
  assert.equal(h.controller.state, STATE.FOUNDRY);
  assert.equal(h.live("reader").length, 1, "④ 隐藏保活");
  assert.equal(h.controller.origin, null, "阅读周期结束");

  h.controller.showReader("notes/c.md");
  assert.equal(h.controller.state, STATE.READER_F, "底下现在压着活的 Foundry");
  h.controller.switchSurface("foundry");
  assert.equal(h.controller.state, STATE.FOUNDRY);

  h.controller.closePanel();
  h.controller.showReader("notes/d.md");
  assert.equal(h.controller.state, STATE.READER_C);
  const switched = h.controller.switchSurface("foundry");
  assert.equal(switched.empty, "foundry", "READER_C 底下没有 Foundry,切换如实报空");
  assert.equal(h.controller.state, STATE.READER_C, "空切换不改变状态");
  assert.equal(h.live("reader").length, 1, "阅读器原样保留");
});

// ---------- 不变量与围栏 ----------

test("invariants hold across a long mixed event sequence", async () => {
  const h = harness();
  const steps = [
    () => h.controller.showReader("a.md"),
    () => h.controller.showFoundry(),
    () => h.controller.showReader("b.md"),
    () => h.controller.switchSurface("foundry"),
    () => h.controller.showReader("c.md"),
    () => h.controller.closePanel(),
    () => h.controller.openPanel(),
    () => h.controller.showFoundry(),
    () => h.controller.closePanel(),
    () => h.controller.openPanel(),
    () => h.controller.switchSurface("foundry"),
    () => h.controller.showReader("d.md"),
    () => h.controller.showFoundry(),
    () => h.controller.switchSurface("foundry"),
    () => h.controller.closePanel(),
  ];
  for (const [index, step] of steps.entries()) {
    await step();
    const state = h.controller.state;
    assertSingleVisible(h, `step ${index} (${state})`);
    if (state === STATE.CLOSED) assert.equal(h.visible().length, 0, `step ${index}: CLOSED shows nothing`);
    if (state === STATE.FOUNDRY) assert.equal(h.live("foundry").length, 1, `step ${index}: FOUNDRY needs a live view`);
    if (state === STATE.READER_F) assert.equal(h.live("foundry").length, 1, `step ${index}: 不变量 2`);
    if (state === STATE.READER_C) assert.equal(h.live("foundry").length, 0, `step ${index}: 不变量 3`);
    if (state !== STATE.CLOSED) {
      assert.deepEqual(h.events.at(-1), { type: "panel_layout", open: true, chatWidth: 480, gutter: 6 }, `step ${index}`);
    }
  }
});

test("a fence failure still opens the reader and shows the error page (R5)", () => {
  const h = harness({ notes: { "../escape.md": { error: "outside" } } });
  h.controller.showReader("../escape.md");
  assert.equal(h.controller.state, STATE.READER_C, "点击意图必须得到响应,不能无声拒绝");
  assert.deepEqual(h.content(), { error: "outside", path: "../escape.md" });
});

test("content push carries the path so the page can tell a recall from a new note (§2)", () => {
  const h = harness();
  h.controller.showReader("notes/a.md");
  assert.equal(h.content().path, "notes/a.md");

  // ④ 顶掉后 ② 唤回同一条路径:path 不变,页面据此保留滚动位置。
  h.controller.showFoundry();
  h.controller.showReader("notes/a.md");
  assert.equal(h.content().path, "notes/a.md");

  // 换一份:path 跟着变,页面回顶。
  h.controller.showReader("notes/b.md");
  assert.equal(h.content().path, "notes/b.md");
});

test("onReaderReady re-reads the note and pushes no theme until setTheme was called (N2/N8)", () => {
  const h = harness();
  h.controller.showReader("notes/a.md");
  const reader = h.live("reader")[0];
  reader.sent.length = 0;

  h.controller.onReaderReady();
  assert.deepEqual(reader.sent.map((message) => message.channel), [READER_CONTENT_CHANNEL],
    "未热切换过主题:首屏已从 ?theme= 拿到权威值,不能拿默认 light 去盖深色用户(N2)");
  assert.deepEqual(h.calls.readNote, ["notes/a.md", "notes/a.md"], "页面重载后重读磁盘,不重推缓存(N8)");

  // setTheme 之后,加载完成才顺带重推热切换过的主题
  h.controller.setTheme("dark");
  reader.sent.length = 0;
  h.controller.onReaderReady();
  assert.deepEqual(reader.sent.map((message) => message.channel), [READER_THEME_CHANNEL, READER_CONTENT_CHANNEL]);
  assert.equal(reader.sent[0].payload, "dark");
});

test("reloadSurface re-reads for the reader and defers to Foundry otherwise", async () => {
  const h = harness({ notes: { "notes/a.md": { name: "a.md", text: "v1", truncated: false } } });
  h.controller.showReader("notes/a.md");
  h.setNote("notes/a.md", { name: "a.md", text: "v2", truncated: false });

  await h.controller.reloadSurface();
  assert.equal(h.controller.state, STATE.READER_C);
  assert.deepEqual(h.calls.readNote, ["notes/a.md", "notes/a.md"]);
  assert.equal(h.content().text, "v2", "F5 就是手动刷新");
  assert.equal(h.calls.reloadFoundry, 0);

  h.controller.showFoundry();
  assert.equal(h.controller.state, STATE.FOUNDRY);
  await h.controller.reloadSurface();
  assert.equal(h.calls.reloadFoundry, 1);

  h.controller.closePanel();
  await h.controller.reloadSurface();
  assert.equal(h.calls.reloadFoundry, 1, "CLOSED 下没有可刷新的 surface");
  assert.equal(h.calls.readNote.length, 2);
});

test("F5 re-reads via the open-time snapshot, not the current cwd (N4)", async () => {
  // 打开时 cwd 是 projA;之后会话切到 projB。若按原始路径对当前 cwd 重解析,
  // 会静默读到 projB 的同名文件——快照复检保证授权范围仍是"打开时的那个目录"。
  const h = harness({ notes: {
    "notes/a.md": { name: "a.md", text: "projA v1", truncated: false, absolute: "/projA/notes/a.md", baseDir: "/projA" },
    "reread:/projA/notes/a.md": { name: "a.md", text: "projA v2", truncated: false },
  } });
  h.controller.showReader("notes/a.md");
  assert.equal(h.content().text, "projA v1");
  // absolute/baseDir 与 origin 都是 main 侧快照,不下发给页面
  assert.equal("absolute" in h.content(), false);
  assert.equal("baseDir" in h.content(), false);
  assert.equal("origin" in h.content(), false);

  await h.controller.reloadSurface();
  assert.deepEqual(h.calls.rereadNote, [["/projA/notes/a.md", "/projA"]]);
  assert.deepEqual(h.calls.readNote, ["notes/a.md"], "F5 不再拿原始路径对当前 cwd 重解析");
  assert.equal(h.content().text, "projA v2");

  // 打开时读链就失败 → 没有快照,F5 退回按原始路径重解析(现状行为)
  h.setNote("notes/gone.md", { error: "missing" });
  h.controller.showReader("notes/gone.md");
  await h.controller.reloadSurface();
  assert.deepEqual(h.calls.readNote, ["notes/a.md", "notes/gone.md", "notes/gone.md"]);
  assert.equal(h.calls.rereadNote.length, 1);
});

test("openPanel restores the note through the stored snapshot after a cwd switch (N4)", async () => {
  const h = harness({ notes: {
    "notes/a.md": { name: "a.md", text: "projA", truncated: false, absolute: "/projA/notes/a.md", baseDir: "/projA" },
  } });
  h.controller.showReader("notes/a.md");
  h.controller.closePanel();
  // 关面板期间会话已切到别的项目;重开不得按新 cwd 重解析
  await h.controller.openPanel();
  assert.equal(h.controller.state, STATE.READER_C);
  assert.deepEqual(h.calls.rereadNote, [["/projA/notes/a.md", "/projA"]]);
  assert.deepEqual(h.calls.readNote, ["notes/a.md"]);
  assert.equal(h.content().text, "# /projA/notes/a.md");
  assert.equal(h.content().path, "notes/a.md", "rawPath 仍下发给页面做唤回比较");

  // 快照复检失败(文件被删)→ 落到正常错误页,而不是静默读错文件
  h.controller.closePanel();
  h.setNote("reread:/projA/notes/a.md", { error: "missing" });
  await h.controller.openPanel();
  assert.equal(h.content().error, "missing");
});

test("reloadSurface rebuilds a crashed reader view before pushing (N5)", async () => {
  const h = harness();
  h.controller.showReader("notes/a.md");
  const first = h.live("reader")[0];
  // 真实崩溃语义:isCrashed() === true 而 isDestroyed() === false
  first.crashed = true;

  await h.controller.reloadSurface();
  const second = h.live("reader")[0];
  assert.notEqual(first, second, "死屏不能复用,先重建");
  assert.deepEqual(h.calls.destroyed.at(-1), { label: "reader" });
  assert.equal(second.visible, true, "重建后仍是当前可见 surface");
  assert.deepEqual(second.bounds, BOUNDS, "重建后立即拿到正确布局");
  assert.equal(h.content().text, "# notes/a.md", "内容重读并推给新 view");
});

test("setTheme reaches the reader only; the Foundry page keeps its own theming", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  const reader = h.live("reader")[0];
  const themes = () => reader.sent.filter((message) => message.channel === READER_THEME_CHANNEL);

  h.controller.setTheme("dark");
  assert.equal(themes().at(-1).payload, "dark");
  assert.equal(h.live("foundry")[0].sent.length, 0);
  // 非法值归一到 light,与 resolveTheme() 的取值域一致
  h.controller.setTheme("nonsense");
  assert.equal(themes().at(-1).payload, "light");
});

test("setLocale reaches the reader only and is re-pushed on reload (M2)", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  const reader = h.live("reader")[0];
  const locales = () => reader.sent.filter((message) => message.channel === READER_LOCALE_CHANNEL);

  h.controller.setLocale("en-US");
  assert.equal(locales().at(-1).payload, "en-US");
  assert.equal(h.live("foundry")[0].sent.length, 0);
  // 非法值丢弃,且不覆盖已记住的语言
  h.controller.setLocale("klingon");
  assert.equal(locales().length, 1);

  // F5 重载后页面回到 ?lang= 的启动语言,onReaderReady 必须重推热切换过的值
  reader.sent.length = 0;
  h.controller.onReaderReady();
  assert.deepEqual(reader.sent.map((message) => message.channel),
    [READER_LOCALE_CHANNEL, READER_CONTENT_CHANNEL]);
  assert.equal(reader.sent[0].payload, "en-US");
});

test("onReaderReady skips the locale push when the language was never hot-switched", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  const reader = h.live("reader")[0];
  reader.sent.length = 0;

  h.controller.onReaderReady();
  assert.deepEqual(reader.sent.map((message) => message.channel), [READER_CONTENT_CHANNEL],
    "首屏语言与主题已从 query 拿到,未热切换过就不多推一条");
});

test("layout feeds both views the same bounds and emits panel_layout once per transition", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  const layouts = h.events.filter((event) => event.type === "panel_layout" && event.open);
  assert.equal(layouts.length, 2);
  assert.deepEqual(layouts.at(-1), { type: "panel_layout", open: true, chatWidth: 480, gutter: 6 });
  assert.deepEqual(h.live("foundry")[0].bounds, BOUNDS);
  assert.deepEqual(h.live("reader")[0].bounds, BOUNDS, "隐藏的那个也拿到正确 bounds,切换时不闪旧布局");
});

test("layout stays silent while the panel is closed or the window is gone", async () => {
  const h = harness();
  h.controller.layout();
  assert.equal(h.events.length, 0, "关面板时由 closePanel 发 open:false,layout 不重复发");

  await h.controller.openPanel();
  const before = h.events.length;
  h.window.destroyed = true;
  h.controller.layout();
  assert.equal(h.events.length, before);
});

test("pointer passthrough follows the visible surface", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.setPointerPassthrough(true);
  assert.equal(h.live("foundry")[0].ignoreMouse, true);

  h.controller.showReader("notes/a.md");
  h.controller.setPointerPassthrough(true);
  assert.equal(h.live("reader")[0].ignoreMouse, true);
  h.controller.setPointerPassthrough(false);
  assert.equal(h.live("reader")[0].ignoreMouse, false);
  assert.equal(h.live("foundry")[0].ignoreMouse, true, "只作用于当前可见 view");
});

test("ensureFoundryView rebuilds a crashed renderer instead of showing a blank view", () => {
  const h = harness();
  const first = h.controller.ensureFoundryView();
  // 真实崩溃语义:isCrashed() === true 而 isDestroyed() === false(review BUG-4)
  first.crashed = true;
  assert.equal(first.webContents.isDestroyed(), false);
  const second = h.controller.ensureFoundryView();
  assert.notEqual(first, second);
  assert.deepEqual(h.calls.destroyed.at(-1), { label: "foundry", reason: "foundry-renderer-gone" });
  assert.equal(h.controller.foundryView, second);

  // 销毁语义同样触发重建
  second.destroyed = true;
  const third = h.controller.ensureFoundryView();
  assert.notEqual(second, third);
});

test("a crashed Foundry reads as empty to switchSurface and is rebuilt on the agent path", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  assert.equal(h.controller.state, STATE.READER_F);
  // 阅读期间 Foundry 的 renderer 崩溃(R1:崩溃即常态):view 没销毁,只是死了
  const foundry = h.live("foundry")[0];
  foundry.crashed = true;
  assert.equal(foundry.destroyed, false, "render-process-gone 后 isDestroyed() 仍是 false");

  const switched = h.controller.switchSurface("foundry");
  assert.equal(switched.ok, false, "崩掉的 Foundry 不算可切换的现场,不摆死黑屏");
  assert.equal(switched.empty, "foundry");
  assert.equal(h.calls.loadFoundry, 1, "切换绝不主动拉起 FVTT 加载");

  h.controller.showFoundry();
  assert.equal(h.controller.state, STATE.FOUNDRY);
  assert.equal(h.live("foundry")[0].crashed, false, "崩掉的 view 已被重建");
  assert.deepEqual(h.calls.destroyed.at(-1), { label: "foundry", reason: "foundry-renderer-gone" });
  assert.equal(h.live("reader").length, 1, "阅读器隐藏保活");
});

test("Foundry consumers never see the reader view", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  assert.equal(h.controller.foundryView.label, "foundry");
  assert.equal(h.controller.activeView().label, "reader");
  assert.equal(h.controller.surface, "reader");
  assert.equal(h.controller.readerPath, "notes/a.md");
});

test("dispose drops every reference and emits nothing", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  const before = h.events.length;

  h.controller.dispose();
  assert.equal(h.controller.state, STATE.CLOSED);
  assert.equal(h.controller.foundryView, null);
  assert.equal(h.controller.activeView(), null);
  assert.equal(h.controller.readerPath, null);
  assert.equal(h.events.length, before, "renderer 已经不在了,不能再发事件");
});

test("openPanel and closePanel are idempotent", async () => {
  const h = harness();
  h.controller.showReader("notes/a.md");
  await h.controller.openPanel();
  assert.equal(h.controller.state, STATE.READER_C, "已开时 ① 不改变当前内容");
  assert.equal(h.calls.loadFoundry, 0);

  h.controller.closePanel();
  h.controller.closePanel();
  assert.equal(h.controller.state, STATE.CLOSED);
  assert.equal(h.calls.destroyed.filter((entry) => entry.label === "reader").length, 1);
  assert.equal(h.events.filter((event) => event.type === "panel_status" && event.open === false).length, 1);
});

// ---------- 顶栏 FVTT/文档切换(switchSurface) ----------

test("switchSurface from CLOSED reports empty for both targets and creates nothing", async () => {
  const h = harness();
  assert.deepEqual(h.controller.switchSurface("foundry"), { ok: false, empty: "foundry", state: STATE.CLOSED });
  assert.deepEqual(h.controller.switchSurface("reader"), { ok: false, empty: "reader", state: STATE.CLOSED });
  assert.equal(h.calls.loadFoundry, 0, "切换绝不主动拉起 FVTT 加载");
  assert.equal(h.views.length, 0, "切换不创建任何 view");
});

test("switchSurface rejects an unknown target", async () => {
  const h = harness();
  assert.equal(h.controller.switchSurface("settings").ok, false);
  assert.equal(h.controller.switchSurface("settings").empty, undefined);
});

test("FOUNDRY without a note: reader target is empty, foundry target is a no-op", async () => {
  const h = harness();
  await h.controller.openPanel();
  const before = h.events.length;

  assert.equal(h.controller.switchSurface("reader").empty, "reader");
  assert.equal(h.controller.state, STATE.FOUNDRY, "空切换不改变状态");

  const result = h.controller.switchSurface("foundry");
  assert.equal(result.ok, true, "已在目标表面:幂等");
  assert.equal(h.events.length, before, "空切换与幂等切换都不发事件");
});

test("READER_F round-trips through switchSurface without loads or rereads", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  assert.equal(h.controller.state, STATE.READER_F);
  const loadsBefore = h.calls.loadFoundry;
  const readsBefore = h.calls.readNote.length;

  const toFoundry = h.controller.switchSurface("foundry");
  assert.equal(toFoundry.ok, true);
  assert.equal(h.controller.state, STATE.FOUNDRY);
  assert.equal(h.calls.loadFoundry, loadsBefore, "切回 Foundry 走显隐,永不加载(§3.5 不变量 2)");
  const reader = h.live("reader")[0];
  assert.equal(reader.destroyed, false);
  assert.equal(reader.visible, false);

  const toReader = h.controller.switchSurface("reader");
  assert.equal(toReader.ok, true);
  assert.equal(h.controller.state, STATE.READER_F, "切回阅读器,origin 重记为 foundry");
  assert.equal(h.controller.origin, "foundry");
  assert.equal(h.calls.readNote.length, readsBefore, "唤回同一份不重读(§2)");
  assert.equal(assertSingleVisible(h, "switchSurface round-trip").label, "reader");
  assert.equal(h.content().path, "notes/a.md");
});

test("READER_C: foundry target is empty and never triggers a load", async () => {
  const h = harness();
  h.controller.showReader("notes/a.md");
  assert.equal(h.controller.state, STATE.READER_C);

  const result = h.controller.switchSurface("foundry");
  assert.equal(result.ok, false);
  assert.equal(result.empty, "foundry");
  assert.equal(h.controller.state, STATE.READER_C);
  assert.equal(h.calls.loadFoundry, 0);
  assert.equal(h.live("foundry").length, 0);
});

test("switchSurface rebuilds a crashed hidden reader and rereads by snapshot (N4/N5)", async () => {
  const h = harness({
    notes: { "notes/a.md": { name: "a.md", text: "# A", absolute: "/ws/a.md", baseDir: "/ws" } },
  });
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  h.controller.showFoundry();
  const reader = h.live("reader")[0];
  reader.crashed = true; // render-process-gone:isDestroyed=false,isCrashed=true

  const result = h.controller.switchSurface("reader");
  assert.equal(result.ok, true);
  assert.equal(h.controller.state, STATE.READER_F);
  assert.deepEqual(h.calls.rereadNote, [["/ws/a.md", "/ws"]], "重建后按打开时的快照重读");
  assert.equal(assertSingleVisible(h, "crashed reader switch").destroyed, false);
});

test("switchSurface after closePanel finds nothing (views are destroyed on close)", async () => {
  const h = harness();
  await h.controller.openPanel();
  h.controller.showReader("notes/a.md");
  h.controller.closePanel();

  assert.equal(h.controller.switchSurface("foundry").empty, "foundry");
  assert.equal(h.controller.switchSurface("reader").empty, "reader");
  assert.equal(h.controller.state, STATE.CLOSED);
});

test("panel_status carries the current surface for the renderer switch", async () => {
  const h = harness();
  await h.controller.openPanel();
  assert.deepEqual(h.events.at(-2), { type: "panel_status", open: true, surface: "foundry" });

  h.controller.showReader("notes/a.md");
  assert.deepEqual(
    h.events.filter((event) => event.type === "panel_status").at(-1),
    { type: "panel_status", open: true, surface: "reader" },
  );

  h.controller.showFoundry();
  assert.deepEqual(
    h.events.filter((event) => event.type === "panel_status").at(-1),
    { type: "panel_status", open: true, surface: "foundry" },
  );
});
