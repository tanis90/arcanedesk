// 右屏阅读器的 CDP 验收(md-reader-spec §9)。
//
// 与 test/smoke-md-reader.mjs 的分工:那个在 main 进程内断言双 view 的生命周期与不变量,
// 这个从**进程外**用 Chrome DevTools Protocol 驱动真实窗口——点击、按键、换主题都走真的
// 输入与 IPC 栈,而且能拿到只有 CDP 才给得出的两样东西:
//   1. 阅读器是不是一个独立的 page target(§2:必须是 WebContentsView,不是 chat 页里的 DOM);
//   2. 阅读器页真正渲染出来的样子(截图证据,落在 docs/md-reader-evidence/)。
// 夹具(--md-reader-review)只在磁盘上准备好笔记,不替 runner 按任何按钮。
//
// 走位按 §3.4 排:① 的恢复目标由 lastContent 决定,所以先建立 Foundry 现场再进阅读器,
// 否则"重开面板"会一直恢复成笔记,永远走不到 FOUNDRY 那一行。
//
// 手动跑:`node test/review-md-reader.mjs`(与 review-layout.mjs 同款,不进 npm test)。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL(".", import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "arcane-md-reader-review-"));
const evidence = path.resolve(here, "../docs/md-reader-evidence");
mkdirSync(evidence, { recursive: true });
const readyFile = path.join(scratch, "review-ready.txt");
const doneFile = path.join(scratch, "review-done.txt");

const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [
  `--remote-debugging-port=${port}`,
  `--smoke-root=${scratch}`,
  path.resolve(here, "fixtures/production-main-smoke.cjs"),
  "--md-reader-review",
], { env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
let appLog = "";
child.stdout.on("data", chunk => { appLog += chunk; });
child.stderr.on("data", chunk => { appLog += chunk; });
let exited = false;
child.on("exit", () => { exited = true; });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await sleep(80); }
  throw Error(`Timed out: ${label}`);
}

/** 一个 CDP 会话:够用到能 evaluate、截图、发真实按键。 */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(Error(`cannot open ${wsUrl}`)); });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const pair = pending.get(message.id);
    if (!pair) return;
    pending.delete(message.id);
    if (message.error) pair.reject(Error(message.error.message)); else pair.resolve(message.result);
  };
  // 会话可能在一次调用飞行中就被拆了(target 随 view 一起销毁)。不把 pending 拒掉的话
  // 它们就永远悬着,整个 runner 卡死在一个看不懂的 "unsettled top-level await" 上。
  socket.onclose = () => {
    for (const pair of pending.values()) pair.reject(Error("the CDP session closed before replying"));
    pending.clear();
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    // 对已经关掉的 socket 再 send,undici 既不报错也不回消息,promise 就永远悬着
    // (表现是 Node 的 "unsettled top-level await",而不是一个看得懂的超时)。当场拒掉。
    if (socket.readyState !== WebSocket.OPEN) { reject(Error("the CDP session is already closed")); return; }
    const id = ++serial;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    call,
    async evaluate(expression) {
      const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`);
      return result.result.value;
    },
    async screenshot(name) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(evidence, name), Buffer.from(shot.data, "base64"));
      return name;
    },
    /** Esc 走真的输入栈,不是 dispatchEvent 造的合成事件。
        origin=closed 时这一下会把阅读器 view 连带它自己的 CDP 会话一起销毁,
        按键的回执就到不了了——那正是"按成了"的表现,所以用 mayDie 放行。 */
    async pressEscape({ mayDie = false } = {}) {
      const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      for (const type of ["rawKeyDown", "keyUp"]) {
        try { await call("Input.dispatchKeyEvent", { type, ...key }); }
        catch (error) { if (!mayDie) throw error; }
      }
    },
    close() { try { socket.close(); } catch { /* already gone */ } },
  };
}

const listTargets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
const findTarget = async (match) => (await listTargets()).find(tab => tab.type === "page" && match(tab.url)) ?? null;
const chatTarget = () => findTarget(url => url.split("?")[0].endsWith("/index.html"));
const readerTarget = () => findTarget(url => url.includes("md-reader.html"));
const foundryTarget = () => findTarget(url => url.includes("foundry-unavailable.html") || /^https?:/.test(url));

const report = { port, scratch, targets: {}, assertions: [], screenshots: [] };
const note = (what) => { report.assertions.push(what); console.log(`OK   ${what}`); };
const shoot = async (session, name) => { report.screenshots.push(await session.screenshot(name)); };

let chat = null;
let readerSession = null;
let foundrySession = null;
try {
  await until(() => existsSync(readyFile), "the app prepared the campaign directory", 120000);
  await until(async () => Boolean(await chatTarget()), "the chat page shows up as a CDP target");
  chat = await connect((await chatTarget()).webSocketDebuggerUrl);
  await chat.call("Page.enable");
  await chat.call("Runtime.enable");
  await until(async () => {
    try { return await chat.evaluate('typeof selectedSessionId !== "undefined" && workspaceReady.has(selectedSessionId) && !restoringView'); } catch { return false; }
  }, "the chat renderer is ready");
  report.targets.chat = (await chatTarget()).id;

  // 文案一律拿 chat 页的 t() 当参照,不写死中文:验收跟着系统语言跑。
  const word = (key) => chat.evaluate(`t(${JSON.stringify(key)})`);
  const panelOpen = () => chat.evaluate("panelOpen");

  // ③ 的等待条件必须是"保证会发生的可观测变化"。Foundry 的 URL 在 Esc 前后一模一样
  // (§3.5 不变量 2:③ 绝不重载 Foundry),panelOpen 也一直是 true——拿它们当条件是恒真,
  // 等于没等,后面读到的可能还是 Esc 之前的状态。leaveReader() 的 foundry 分支必调
  // layout(),而 layout() 必发一次 panel_layout,所以在 chat 页数这个事件就是可靠的往返信号。
  await chat.evaluate('window.__cdpEvents = []; window.arcane.onEvent(event => __cdpEvents.push(event.type)); void 0');
  const eventCount = () => chat.evaluate("window.__cdpEvents.length");
  /** 等到下一次布局广播落地:面板的显隐切换只有走完 layout() 才算真的完成。 */
  const waitRelayout = async (seen, label) => {
    await until(async () => (await eventCount()) > seen, label);
    return eventCount();
  };

  let noteSerial = 0;
  /** 在 chat 里造一条带路径的 assistant 消息(走生产 renderMarkdown),返回它的 id。 */
  const say = async (text) => {
    const id = `cdp-note-${++noteSerial}`;
    const shape = await chat.evaluate(`(() => {
      const box = document.createElement("div");
      box.className = "msg assistant";
      box.id = ${JSON.stringify(id)};
      messages.appendChild(box);
      renderMarkdown(box, ${JSON.stringify(text)});
      const link = box.querySelector("a.md-path");
      return { count: box.querySelectorAll("a.md-path").length, path: link?.dataset.mdPath ?? null, href: link?.getAttribute("href") ?? null, tabIndex: link?.tabIndex ?? null, role: link?.getAttribute("role") ?? null };
    })()`);
    assert.ok(shape.count >= 1, `expected a clickable note path in: ${text}`);
    return { id, shape };
  };
  const click = (id) => chat.evaluate(`document.getElementById(${JSON.stringify(id)}).querySelector("a.md-path").click()`);
  const sayAndClick = async (text) => { const said = await say(text); await click(said.id); return said; };

  const attachReader = async () => {
    await until(async () => Boolean(await readerTarget()), "the reader shows up as its own CDP page target");
    const target = await readerTarget();
    readerSession?.close();
    readerSession = await connect(target.webSocketDebuggerUrl);
    await readerSession.call("Page.enable");
    await readerSession.call("Runtime.enable");
    return target;
  };
  const readerState = () => readerSession.evaluate(`(() => {
    const doc = document.getElementById("reader-doc");
    const pane = document.getElementById("reader-scroll");
    return {
      name: document.getElementById("reader-name").textContent,
      back: document.getElementById("reader-back").textContent,
      ariaBack: document.getElementById("reader-back").getAttribute("aria-label"),
      headings: [...doc.querySelectorAll("h1, h4")].map(node => node.textContent),
      text: doc.textContent,
      anchors: document.querySelectorAll("a.md-path").length,
      errorHidden: document.getElementById("reader-error").hidden,
      errorText: document.getElementById("reader-error").hidden ? null : document.querySelector("#reader-error p").textContent,
      scrollHidden: pane.hidden,
      theme: document.documentElement.dataset.theme,
      title: document.title,
      probe: window.__cdpProbe ?? null,
      columnWidth: Math.round(doc.getBoundingClientRect().width),
      paneWidth: Math.round(pane.getBoundingClientRect().width),
      headFont: getComputedStyle(document.getElementById("reader-name")).fontFamily,
    };
  })()`);
  const waitNote = async (name) => {
    await until(async () => { try { return (await readerState()).name === name; } catch { return false; } }, `the reader renders ${name}`);
    return readerState();
  };

  // ---------- ① 从全新 CLOSED 开面板:建立 Foundry 现场 ----------
  assert.equal(await panelOpen(), false, "the pane starts closed");
  await chat.evaluate('window.arcane.openPanel()');
  await until(async () => (await panelOpen()) === true, "① opens the pane");
  await until(async () => Boolean(await foundryTarget()), "the Foundry surface is a page target of its own");
  const foundry = await foundryTarget();
  report.targets.foundry = { id: foundry.id, url: foundry.url };
  assert.equal(await readerTarget(), null, "FOUNDRY has no reader view");
  note("① 开面板 → Foundry surface 是独立 page target(本地没有 FVTT,落到既有的连接失败页)");
  foundrySession = await connect(foundry.webSocketDebuggerUrl);
  await foundrySession.call("Page.enable");
  // 在 Foundry 页上埋一个只能活到页面重载之前的探针:URL 不变只能证明"没导航到别处",
  // 而探针还在才能证明这张页从头到尾没被重建过——这才是 §3.5 不变量 2 的真实含义。
  await foundrySession.evaluate('window.__cdpFoundryProbe = "loaded"');
  await shoot(foundrySession, "01-foundry-surface.png");

  // ---------- ② 从 FOUNDRY 点路径:锚点形态 + 独立 target ----------
  const first = await say("备好了 notes/gatekeeper.md，点开看看。");
  assert.deepEqual(first.shape, { count: 1, path: "notes/gatekeeper.md", href: null, tabIndex: 0, role: "link" }, "锚点无 href、可聚焦、role=link(§4.2)");
  note("② 生产渲染管线把 notes/gatekeeper.md 变成一个无 href、可聚焦、role=link 的锚点");
  await shoot(chat, "02-chat-anchor.png");
  await click(first.id);
  const opened = await attachReader();
  report.targets.reader = { id: opened.id, url: opened.url };
  assert.ok(opened.url.startsWith("file:"), "the reader page is a local file, never a remote origin");
  assert.notEqual(opened.id, report.targets.chat, "the reader is not the chat page");
  note(`② 点击后多出一个独立 page target(${opened.id})——阅读器是 WebContentsView,不是 chat 页里的 DOM`);

  let state = await waitNote("gatekeeper.md");
  assert.deepEqual(state.headings, ["守门人"]);
  assert.match(state.text, /石门后面站着一个不说话的人/);
  assert.equal(state.errorHidden, true);
  assert.equal(state.anchors, 0, "笔记正文里的两个 md 路径不产锚点:阅读器页兑现不了它们(R5)");
  assert.equal(state.back, await word("reader.back"), "origin=foundry 时按钮自称返回");
  assert.equal(state.ariaBack, state.back, "按钮的 aria-label 与可见文案一致");
  assert.equal(state.title, "gatekeeper.md · ArcaneDesk");
  assert.match(state.headFont, /Georgia|Palatino|Songti|STSong|serif/, "页眉文件名用衬线(§5.2 signature)");
  assert.ok(state.columnWidth < state.paneWidth, `正文栏不拉满右屏:${state.columnWidth}px < ${state.paneWidth}px(§5.2 的 68ch)`);
  assert.ok(state.columnWidth >= 320 && state.columnWidth <= 900, `正文栏宽 ${state.columnWidth}px 落在可读区间`);
  assert.ok((await foundryTarget()).id === report.targets.foundry.id, "READER_F 底下压着活的 Foundry(§3.5 不变量 2)");
  note("② READER_F:正文渲染、返回按钮自称返回、68ch 衬线排版、Foundry 隐藏保活");
  await shoot(readerSession, "03-reader-over-foundry.png");
  await readerSession.evaluate('window.__cdpProbe = "alive"');

  // ---------- ② 换笔记:保活意味着文档不重建(§2) ----------
  await sayAndClick("另一份在 notes/second.md。");
  state = await waitNote("second.md");
  assert.match(state.text, /换一份笔记/);
  assert.equal(state.probe, "alive", "换笔记不重建文档:挂在 window 上的探针还在");
  assert.equal((await readerTarget()).id, report.targets.reader.id, "还是同一个 target,页面没有重载");
  assert.equal(state.back, await word("reader.back"), "origin 在一个阅读周期内不变(§3.1)");
  note("② 阅读中换笔记:同一个 target、同一个文档,只换内容");

  // ---------- 主题广播:真点顶栏按钮,不直接调 IPC ----------
  await chat.evaluate('document.getElementById("theme-toggle").click()');
  await until(async () => (await readerState()).theme === "dark", "the theme broadcast reaches the reader page");
  assert.equal((await readerState()).name, "second.md", "切主题不重读文件、不重渲染(§7)");
  note("① 顶栏切主题 → 阅读器页 dataset.theme 跟着变,内容不动");
  await shoot(readerSession, "04-reader-dark.png");
  await chat.evaluate('document.getElementById("theme-toggle").click()');
  await until(async () => (await readerState()).theme === "light", "the theme broadcast goes back");

  // ---------- mermaid:真 vendored 库在阅读器页的 CSP 下真的画出 SVG ----------
  // 单测里的 mermaid 是注进去的假全局,只能证明注册表分发;真库能不能在
  // md-reader.html 的 CSP 下加载、能不能画出图,只有真页面能回答(§9)。
  await sayAndClick("图在 notes/diagram.md。");
  await until(async () => { try { return (await readerState()).name === "diagram.md"; } catch { return false; } }, "the reader renders diagram.md");
  await until(async () => {
    try { return await readerSession.evaluate('Boolean(document.querySelector("div.md-mermaid svg"))'); } catch { return false; }
  }, "the vendored mermaid library draws an SVG inside the reader page");
  assert.equal(await readerSession.evaluate('document.querySelector("div.md-mermaid-error")'), null, "mermaid 没走失败回退:vendored 脚本被 CSP 放行了");
  note("② 含 mermaid 围栏的笔记:阅读器页里真渲染出 SVG,不是失败回退(§9)");
  await shoot(readerSession, "07-reader-mermaid.png");

  // ---------- 错误页:越界路径照样进阅读器(R5) ----------
  const foundryUrlBefore = (await foundryTarget()).url;
  await sayAndClick("这份在外面 ../outside.md。");
  await until(async () => { try { return (await readerState()).errorHidden === false; } catch { return false; } }, "the reader shows the error page");
  state = await readerState();
  assert.equal(state.errorText, await word("reader.error.outside"));
  assert.equal(state.scrollHidden, true, "错误页顶掉正文");
  assert.equal(state.name, "");
  assert.equal((await readerTarget()).id, report.targets.reader.id, "错误也渲染在阅读器里,不在 chat 弹任何东西");
  assert.equal((await foundryTarget()).url, foundryUrlBefore, "② 绝不碰 Foundry 页(§3.5 不变量 2)");
  note("② 越界路径 → 阅读器里的错误页,chat 侧零打扰,Foundry 不受影响");
  await shoot(readerSession, "05-reader-error.png");

  // ---------- ③ Esc 走真的输入栈:origin=foundry → 回 FOUNDRY ----------
  const seenBeforeEscape = await eventCount();
  await readerSession.pressEscape();
  await waitRelayout(seenBeforeEscape, "③ hands the pane back to Foundry");
  assert.equal((await readerTarget()).id, report.targets.reader.id, "阅读器隐藏保活,没被销毁");
  assert.equal((await readerState()).probe, "alive", "保活的页面文档没重建");
  assert.equal((await foundryTarget()).url, foundryUrlBefore, "③ 绝不导航 Foundry 页(§3.5 不变量 2)");
  assert.equal(await foundrySession.evaluate("window.__cdpFoundryProbe"), "loaded", "③ 绝不重载 Foundry 页:步骤 A 埋的探针还在(§3.5 不变量 2)");
  note("③ origin=foundry 时 Esc 回 FOUNDRY:Foundry 页没重载(探针存活),阅读器隐藏保活");

  // 为什么不用 document.visibilityState 当"只有一个 view 可见"的证据?实测过,两头都不成立:
  //   窗口隐藏时(普通 smoke)两张页都报 hidden,分不出谁可见;
  //   而 CDP 客户端 Page.enable 过的 target 会把 setVisible(false) 盖掉,一律报 visible。
  // 所以不变量 1 的权威证据只能是 main 里的 view.getVisible(),由 test/fixtures/md-reader-panel.cjs 把守。
  // 这里只如实记下读数,不当门禁。
  report.visibilityStateAfterEscape = {
    foundry: await foundrySession.evaluate("document.visibilityState"),
    reader: await readerSession.evaluate("document.visibilityState"),
  };

  // ---------- ① 关掉再开:记住 Foundry 那一面(§3.4) ----------
  await chat.evaluate('window.arcane.closePanel()');
  await until(async () => (await panelOpen()) === false, "① closes the pane");
  readerSession.close();
  readerSession = null;
  foundrySession.close();
  foundrySession = null;
  await until(async () => (await readerTarget()) === null && (await foundryTarget()) === null, "① destroys both views");
  note("① 关面板:两个 view 一起销毁(§2 保活范围之外)");
  await chat.evaluate('window.arcane.openPanel()');
  await until(async () => Boolean(await foundryTarget()), "① reopens onto the Foundry surface");
  assert.equal(await readerTarget(), null, "restoring Foundry does not resurrect the reader");
  note("① 关闭前是 Foundry → 重开落 FOUNDRY(§3.4 CLOSED 行),走的就是 ④ 那个归位动词");

  // ---------- ② 再进阅读器,然后 ① 关掉重开:这次要恢复笔记 ----------
  await sayAndClick("回到 notes/gatekeeper.md。");
  const reopened = await attachReader();
  state = await waitNote("gatekeeper.md");
  assert.equal(state.back, await word("reader.back"), "新的阅读周期重新快照 origin=foundry(§3.1)");
  assert.notEqual(reopened.id, report.targets.reader.id, "上一张页面被 ① 销毁过,这是一张新的");
  report.targets.readerRestored = reopened.id;
  await chat.evaluate('window.arcane.closePanel()');
  await until(async () => (await readerTarget()) === null && (await foundryTarget()) === null, "① destroys both views again");
  await chat.evaluate('window.arcane.openPanel()');
  // 重开的是一张全新的 target,旧的 session 随 view 一起没了:必须重新 attach,
  // 否则后面的 evaluate 全部打在死 socket 上。
  const restored = await attachReader();
  assert.equal(await foundryTarget(), null, "恢复笔记绝不静默拉起 FVTT(§3.4)");
  assert.notEqual(restored.id, report.targets.readerRestored, "① 销毁过的那张页面不会原地复活,这是一张新的");
  report.targets.readerReopened = restored.id;
  state = await waitNote("gatekeeper.md");
  assert.equal(state.back, await word("reader.close"), "重开后 foundryView 已不存在,origin 重新快照成 closed(§3.1)");
  note("① 关闭前是笔记 → 重开落 READER_C,并且不静默拉起一次 FVTT 加载");
  await shoot(readerSession, "06-reader-restored.png");

  // ---------- ③ origin=closed 时 Esc 关掉整个右屏 ----------
  // 这一下会销毁阅读器 view,连带拆掉我们正在用的这个 CDP 会话,所以 mayDie。
  await readerSession.pressEscape({ mayDie: true });
  await until(async () => (await panelOpen()) === false, "③ closes the pane when origin=closed");
  readerSession.close();
  readerSession = null;
  await until(async () => (await readerTarget()) === null && (await foundryTarget()) === null, "③ destroyed the reader view");
  note("③ origin=closed 时 Esc 关掉整个右屏(§3.4)");

  writeFileSync(doneFile, "done");
  writeFileSync(path.join(evidence, "review.json"), `${JSON.stringify(report, null, 2)}\n`);
  const browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  const control = new WebSocket(browser);
  await new Promise(resolve => { control.onopen = resolve; });
  control.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  await until(() => exited, "the app exits", 30000);
  control.close();
  console.log("PASS md reader review: CDP drove a real window through ①②③, the reader is its own page target, and the rendered pages are on disk");
} catch (error) {
  console.error(appLog.slice(-6000));
  try { writeFileSync(doneFile, "failed"); } catch { /* scratch may be gone */ }
  if (!exited) child.kill();
  throw error;
} finally {
  chat?.close();
  readerSession?.close();
  foundrySession?.close();
}
