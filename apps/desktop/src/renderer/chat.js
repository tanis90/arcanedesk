// Chat renderer — agent loop UI: dialog stream, streaming deltas, tool receipt
// cards, status indicators, opt-in approval cards. The input is never locked:
// messages sent while the agent is busy are steered into the running turn.
"use strict";

const messages = document.getElementById("messages");
const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("chat-input"));
const send = document.getElementById("send");
const stop = document.getElementById("stop");
const composerWrap = document.getElementById("composer-wrap");
const panelDot = document.getElementById("panel-dot");
const worldChip = document.getElementById("world-chip");
const modeSegs = {
  prep: document.getElementById("mode-seg-prep"),
  combat: document.getElementById("mode-seg-combat"),
};
const dirChip = document.getElementById("dir-chip");
const scrollBottomBtn = document.getElementById("scroll-bottom");
const togglePanelBtn = document.getElementById("toggle-panel");
const welcome = document.getElementById("welcome");
const permissionCenter = document.getElementById("permission-center");
const displayPickerBackdrop = document.getElementById("display-picker-backdrop");
const ARCANE_SPARK_PROVIDER_ID = "arcane-spark";
// i18n:t/fmtIpc 来自 head 里的 i18n.js(先于本文件加载);纯函数无 this,解构安全。
const { t, fmtIpc } = window.ArcaneI18n;

const toolCards = new Map(); // toolCallId -> { card, startAt, summary }
const streamBubbles = new Map(); // message key -> bubble element
const thinkBlocks = new Map(); // message key -> { block, label, body, startAt }
let busy = false;
let panelOpen = false;
let modelSetupCard = null;
const permissionRequests = new Map();
const permissionQueue = [];
let displaySourceRequest = null;

// ---------- 模式(战斗 / 备团):双 host 并存,切模式 = 换整条对话区 ----------

/** @type {"combat" | "prep"} */
let currentMode = "prep";
let currentModeGeneration = 0;
/** @type {"combat" | "prep"} */
let requestedMode = currentMode;
let modeSwitchRequest = 0;
let lastPrepCwd = null;

/** @returns {ArcaneModeContext} */
function modeContext() {
  return { mode: currentMode, generation: currentModeGeneration };
}

function sameModeContext(context) {
  return context.mode === currentMode && context.generation === currentModeGeneration;
}

/** 拒绝比当前 UI 更旧的 main 快照，避免迟到响应把界面切回去。 */
function acceptModeSnapshot(payload) {
  const generation = Number(payload?.generation);
  if (Number.isInteger(generation)) {
    if (generation < currentModeGeneration) return false;
    currentModeGeneration = generation;
  }
  return true;
}

// 空会话(welcome 显示中)才允许选备团目录——对齐 kimi web:选文件夹 = 在它的工作区开新会话。
// 有消息后 chip 隐藏,换目录走抽屉 + 新会话回到空态再选。
let conversationEmpty = true;

function syncDirChip() {
  dirChip.style.display = currentMode === "prep" && conversationEmpty ? "" : "none";
}

function applyModeUi(mode, cwd) {
  currentMode = mode === "prep" ? "prep" : "combat";
  modeSegs.prep.classList.toggle("active", currentMode === "prep");
  modeSegs.combat.classList.toggle("active", currentMode === "combat");
  document.body.dataset.mode = currentMode;
  syncDirChip();
  lastPrepCwd = cwd || null;
  if (cwd) {
    dirChip.textContent = `📁 ${cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd} ⌄`;
    dirChip.title = t("header.dir.titleWith", { path: cwd });
  } else {
    dirChip.textContent = `📁 ${t("header.dir.chooseLabel")} ⌄`;
    dirChip.title = t("header.dir.chooseTitle");
  }
}

async function switchMode(next) {
  next = next === "prep" ? "prep" : "combat";
  if (next === requestedMode) return; // 已选中或已有同目标请求在途
  requestedMode = next;
  const requestId = ++modeSwitchRequest;
  let result;
  try {
    result = await window.arcane.setMode(next);
  } catch (error) {
    if (requestId !== modeSwitchRequest) return;
    requestedMode = currentMode;
    // invoke reject(handler 抛错)也要有反馈,不能静默卡在两态分裂里
    addStatus(t("chat.status.modeSwitchFailed", { error: error?.message ?? "unknown" }));
    return;
  }
  if (requestId !== modeSwitchRequest) return; // 更新的用户选择已经在途/完成
  if (!result?.ok) {
    requestedMode = currentMode;
    addStatus(t("chat.status.modeSwitchFailed", {
      error: result?.error ? fmtIpc(result.error) : t("common.unknown"),
    }));
    return;
  }
  if (!acceptModeSnapshot(result)) return;
  applyModeUi(result.mode, result.cwd);
  requestedMode = currentMode;
  invalidateSlashItems(); // slash 候选按 host 走,换模式必须重拉
  renderHistory(result.history ?? []);
  setBusy(Boolean(result.busy)); // 后台模式可能还在跑:恢复真实 busy 态
  if (result.modelLabel) updateModelLabels(result.modelLabel);
  if (typeof result.supportsImages === "boolean") modelSupportsImages = result.supportsImages;
  refreshSessions();
}

modeSegs.prep.addEventListener("click", () => switchMode("prep"));
modeSegs.combat.addEventListener("click", () => switchMode("combat"));

dirChip.addEventListener("click", async () => {
  const context = modeContext();
  const result = await window.arcane.prepChooseDir(context);
  if (!result?.ok) {
    if (!result?.canceled) {
      addStatus(t("chat.status.prepDirFailed", {
        error: result?.error ? fmtIpc(result.error) : t("common.unknown"),
      }));
    }
    return;
  }
  if (!sameModeContext(context)) return;
  applyModeUi("prep", result.cwd);
  invalidateSlashItems(); // cwd 变了,项目级 skills/模板可能不同
  // 换目录 = main 侧已开新 session,session_switched 事件会带历史来
  refreshSessions();
});

// ---------- scrolling ----------

function nearBottom() {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
}

function scrollToEnd(force = false) {
  if (force || nearBottom()) {
    messages.scrollTop = messages.scrollHeight;
  }
  updateScrollButton();
}

function updateScrollButton() {
  scrollBottomBtn.classList.toggle("show", !nearBottom() && messages.scrollHeight > messages.clientHeight);
}

messages.addEventListener("scroll", updateScrollButton);
scrollBottomBtn.addEventListener("click", () => scrollToEnd(true));

// ---------- helpers ----------

// 欢迎页用显示/隐藏而不是移除:切换到空的全新会话时要能再展示回来。
function dismissWelcome() {
  welcome.style.display = "none";
  conversationEmpty = false;
  syncDirChip();
}

function showWelcome() {
  if (!welcome.isConnected) messages.appendChild(welcome);
  welcome.style.display = "";
  conversationEmpty = true;
  syncDirChip();
}

// markdown 渲染管线(marked + KaTeX + hljs + mermaid)在 markdown.js。
// tsc 把 renderer 各 classic script 当模块(全局函数互不可见),故入口走 window 钩子。

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** 渲染 markdown 到容器;实现在 markdown.js(挂 window.arcaneMd),缺失时兜底纯文本。 */
function renderMarkdown(container, text) {
  const md = /** @type {any} */ (window).arcaneMd;
  if (md?.render) {
    md.render(container, text);
  } else {
    container.textContent = text;
  }
}

// ---------- messages ----------

// /skill:xxx 被 pi 展开成 <skill>...</skill> 全文存进历史;回显时折成小卡
const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;
// 备团贴图:main 追加的 inbox 路径注解读起来很吵,历史回显时折成一行小字
const INBOX_NOTE_RE = /\n\n\[附带图片已存为本地文件:([^\]]+)\]$/;

function renderUserText(node, text) {
  const skill = text.match(SKILL_BLOCK_RE);
  if (skill) {
    const [, name, args] = skill;
    const card = el("div", "skill-echo");
    const head = el("div", "skill-echo-head");
    head.append(document.createTextNode(`📖 skill: ${name}`), el("span", "chevron", "▸"));
    const body = el("div", "skill-echo-body");
    // 全文从 history 取,展开才可见;去掉首行 References 说明噪音
    body.textContent = text.replace(/^<skill[^>]*>\nReferences are relative to[^\n]*\n+/, "").replace(/\n<\/skill>[\s\S]*$/, "").trim();
    head.addEventListener("click", () => card.classList.toggle("open"));
    card.append(head, body);
    node.appendChild(card);
    if (args?.trim()) node.appendChild(el("div", "skill-echo-args", args.trim()));
    return;
  }
  const inbox = text.match(INBOX_NOTE_RE);
  const display = inbox ? text.slice(0, text.length - inbox[0].length) : text;
  node.textContent = display;
  if (inbox) {
    const count = inbox[1].split(";").length;
    node.appendChild(el("div", "inbox-note", t("chat.inboxNote", { count })));
  }
}

function addMessage(role, text, images) {
  closeWorkBlock(); // 最终回答/新 user 消息落在块外
  dismissWelcome();
  const node = el("div", `msg ${role}`);
  if (role === "assistant") {
    const body = el("div", "body");
    renderMarkdown(body, text);
    node.appendChild(body);
  } else {
    renderUserText(node, text);
  }
  if (images?.length) {
    const wrap = el("div", "msg-images");
    for (const item of images) {
      const img = document.createElement("img");
      img.src = item.previewUrl ?? `data:${item.mimeType ?? "image/png"};base64,${item.data}`;
      img.alt = t("chat.attach.alt");
      wrap.appendChild(img);
    }
    node.appendChild(wrap);
  }
  messages.appendChild(node);
  scrollToEnd();
  return node;
}

function addStatus(text) {
  closeWorkBlock();
  const node = el("div", "status-line", text);
  messages.appendChild(node);
  scrollToEnd();
  return node;
}

function streamBubble(key) {
  let bubble = streamBubbles.get(key);
  if (bubble) return bubble;
  closeWorkBlock(); // assistant 文本(含轮间插叙)不属于工作过程块
  dismissWelcome();
  bubble = el("div", "msg assistant streaming");
  const body = el("div", "body");
  bubble.appendChild(body);
  messages.appendChild(bubble);
  streamBubbles.set(key, bubble);
  return bubble;
}

// ---------- thinking(思考过程一行折叠,参考 kimi code web 的 turn-fold) ----------

// ---- 工作过程折叠块(M6,仅备团模式):一轮里的 thinking + 工具卡片收进一个
// <details>;流式期间展开,turn 结束自动折叠。战斗模式不走这里,渲染与现状一致。
let workBlock = null; // { root, summary, body, steps, firstAt, lastAt }

/** prep 模式下 thinking/工具卡片的挂载点 = 工作过程块;战斗模式 = messages 平铺。 */
function workTarget() {
  if (currentMode !== "prep") return messages;
  if (!workBlock) {
    const root = el("details", "work-process");
    root.open = true; // 流式期间展开,结束时 closeWorkBlock 折叠
    const summary = el("summary", null, t("chat.workProcess"));
    const body = el("div", "wp-body");
    root.append(summary, body);
    messages.appendChild(root);
    workBlock = { root, summary, body, steps: 0, firstAt: Date.now(), lastAt: Date.now() };
  }
  return workBlock.body;
}

/** 收尾并折叠当前工作过程块(新消息/turn 结束/历史分组时调用)。 */
function closeWorkBlock(timed = true) {
  if (!workBlock) return;
  const secs = Math.max(0.1, (workBlock.lastAt - workBlock.firstAt) / 1000).toFixed(1);
  const stepPart = workBlock.steps > 0 ? t("chat.workSteps", { count: workBlock.steps }) : "";
  workBlock.summary.textContent = `${t("chat.workProcess")}${stepPart}${timed ? ` · ${secs}s` : ""}`;
  workBlock.root.open = false;
  workBlock = null;
}

function thinkBlock(key) {
  let entry = thinkBlocks.get(key);
  if (entry) return entry;
  dismissWelcome();
  const block = el("div", "think");
  const head = el("button", "think-head");
  const label = el("span", "think-label", t("chat.thinking"));
  const chev = el("span", "chev", "▸");
  head.append(label, chev);
  const body = el("div", "think-body");
  block.append(head, body);
  head.addEventListener("click", () => block.classList.toggle("open"));
  workTarget().appendChild(block);
  if (workBlock && workBlock.body.contains(block)) workBlock.lastAt = Date.now();
  entry = { block, label, body, startAt: Date.now() };
  thinkBlocks.set(key, entry);
  return entry;
}

function settleThinkBlock(key, thinking) {
  const entry = thinkBlocks.get(key);
  if (!entry) return;
  if (thinking) entry.body.textContent = thinking; // 终稿为准,丢掉流式累积
  const secs = ((Date.now() - entry.startAt) / 1000).toFixed(1);
  entry.label.textContent = t("chat.thinkingDone", { secs });
  entry.block.classList.add("settled");
}

/** 历史回放用:无计时的已定稿思考块。 */
function renderThinkingHistory(key, thinking) {
  const entry = thinkBlock(key);
  entry.body.textContent = thinking;
  entry.label.textContent = t("chat.thinkingSettled");
  entry.block.classList.add("settled");
}

// ---------- tool cards ----------

function summarizeArgs(toolName, args) {
  if (!args) return "";
  try {
    switch (toolName) {
      case "foundry_open":
        return args.url ?? t("chat.card.defaultUrl");
      case "browser_evaluate": {
        const first = String(args.code ?? "").split("\n")[0].trim();
        return first.length > 90 ? first.slice(0, 90) + "…" : first;
      }
      case "combat_execute_turn": {
        if (Array.isArray(args.actions) && args.actions.length > 0) {
          return args.actions.map((a) => a?.actionId ?? "?").join("; ") + (args.advance ? " [advance]" : "");
        }
        return (args.actionId ?? "(no action)") + (args.advance ? " [advance]" : "");
      }
      default:
        return "";
    }
  } catch {
    return "";
  }
}

function resultText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content)) {
    return result.content
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** Try to pull a Turn Protocol four-state receipt status out of a tool result. */
function receiptStatus(text) {
  try {
    const parsed = JSON.parse(text);
    const status = parsed?.status ?? parsed?.data?.status;
    if (["completed", "rejected", "partial", "indeterminate"].includes(status)) return status;
  } catch {
    /* not JSON — no receipt */
  }
  return null;
}

function shorten(text, limit = 4000) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (${text.length - limit} more chars)`;
}

function formatArgs(args) {
  if (args == null) return "";
  try {
    const text = typeof args === "string" ? args : JSON.stringify(args, null, 2);
    return !text || text === "{}" ? "" : shorten(text);
  } catch {
    return String(args);
  }
}

function ensureToolCard(toolCallId, toolName, args) {
  let entry = toolCards.get(toolCallId);
  if (entry) return entry;
  dismissWelcome();

  const card = el("div", "card running open");
  const head = el("div", "head");
  const dot = el("span", "dot");
  const name = el("span", "tool-name", toolName);
  const summary = el("span", "arg-summary", summarizeArgs(toolName, args));
  const meta = el("span", "meta");
  const duration = el("span", "duration");
  const state = el("span", "state-chip running", t("chat.card.running"));
  const chev = el("span", "chev", "▸");
  meta.append(duration, state, chev);
  head.append(dot, name, summary, meta);
  card.appendChild(head);
  head.addEventListener("click", () => card.classList.toggle("open"));

  // body 建卡时就带上入参:运行中也能核对 agent 到底提交了什么
  const body = el("div", "body");
  const argsText = formatArgs(args);
  if (argsText) {
    body.appendChild(el("div", "io-label", t("chat.card.input")));
    body.appendChild(el("pre", null, argsText));
  }
  card.appendChild(body);

  const target = workTarget();
  target.appendChild(card);
  if (workBlock && target === workBlock.body) {
    workBlock.steps += 1;
    workBlock.lastAt = Date.now();
  }
  scrollToEnd();
  entry = { card, startAt: Date.now(), state };
  toolCards.set(toolCallId, entry);
  return entry;
}

function finishToolCard(toolCallId, toolName, event) {
  const entry = ensureToolCard(toolCallId, toolName);
  const { card, startAt, state } = entry;
  card.classList.remove("running");
  card.classList.add(event.isError ? "err" : "ok");
  const secs = ((Date.now() - startAt) / 1000).toFixed(1);
  card.querySelector(".duration").textContent = `${secs}s`;

  const text = resultText(event.result);
  const receipt = event.isError ? null : receiptStatus(text);
  if (receipt) {
    state.textContent = receipt;
    state.className = `state-chip ${receipt}`;
  } else {
    state.textContent = event.isError ? t("chat.card.failed") : t("chat.card.done");
    state.className = `state-chip ${event.isError ? "err" : "ok"}`;
  }
  if (event.isError) card.classList.add("open");

  let body = card.querySelector(".body");
  if (!body) {
    body = el("div", "body");
    card.appendChild(body);
  }
  body.appendChild(el("div", "io-label", event.isError ? t("chat.card.error") : t("chat.card.output")));
  body.appendChild(el("pre", null, shorten(text)));
  // 完成且无回执详情的卡片收起,保持时间线干净;有 receipt 或错误时保持展开。
  if (!event.isError && !receipt) card.classList.remove("open");
  scrollToEnd();
}

// ---------- approval ----------

function addApprovalCard(event) {
  dismissWelcome();
  const card = el("div", "card approval");
  const head = el("div", "head");
  const dot = el("span", "dot");
  dot.style.background = "var(--warn)";
  const name = el("span", "tool-name", t("chat.approval.title", { tool: event.tool }));
  const state = el("span", "state-chip running", t("chat.approval.waiting"));
  const meta = el("span", "meta");
  meta.append(state);
  head.append(dot, name, meta);
  const body = el("div", "approval-body", event.summary ?? "");
  const actions = el("div", "actions");
  const allow = el("button", "allow", t("chat.approval.allow"));
  const deny = el("button", "deny", t("chat.approval.deny"));
  actions.append(allow, deny);
  card.append(head, body, actions);
  messages.appendChild(card);
  scrollToEnd();

  const finish = (approved) => {
    allow.disabled = true;
    deny.disabled = true;
    state.textContent = approved ? t("chat.approval.allowed") : t("chat.approval.denied");
    state.className = `state-chip ${approved ? "ok" : "err"}`;
  };
  allow.addEventListener("click", () => {
    window.arcane.respondApproval(event.approvalId, true);
    finish(true);
  });
  deny.addEventListener("click", () => {
    window.arcane.respondApproval(event.approvalId, false);
    finish(false);
  });
}

// ---------- website permissions (global, survives mode/session switches) ----------

function permissionLabel(permission, mediaTypes = []) {
  if (permission === "media") {
    const audio = mediaTypes.includes("audio");
    const video = mediaTypes.includes("video");
    if (audio && video) return t("permission.media.audioVideo");
    if (audio) return t("permission.media.audio");
    if (video) return t("permission.media.video");
    return t("permission.media.generic");
  }
  return ({
    notifications: t("permission.notifications"),
    "speaker-selection": t("permission.speakerSelection"),
    "clipboard-read": t("permission.clipboardRead"),
    pointerLock: t("permission.pointerLock"),
  })[permission] ?? permission;
}

function receivePermissionRequest(event) {
  if (!permissionRequests.has(event.requestId)) permissionQueue.push(event.requestId);
  permissionRequests.set(event.requestId, event);
  renderPermissionRequest();
}

function resolvePermissionRequest(requestId) {
  permissionRequests.delete(requestId);
  const index = permissionQueue.indexOf(requestId);
  if (index >= 0) permissionQueue.splice(index, 1);
  renderPermissionRequest();
}

function renderPermissionRequest() {
  permissionCenter.textContent = "";
  while (permissionQueue.length > 0 && !permissionRequests.has(permissionQueue[0])) permissionQueue.shift();
  const event = permissionRequests.get(permissionQueue[0]);
  if (!event) return;

  const card = el("div", "permission-card");
  const label = permissionLabel(event.permission, event.mediaTypes ?? []);
  card.appendChild(el("div", "permission-title", t("permission.request.title", { label })));
  const origin = el("div", "permission-origin", event.origin);
  origin.title = event.origin;
  card.appendChild(origin);
  card.appendChild(el("div", "permission-explain", t("permission.request.explain")));

  const actions = el("div", "permission-actions");
  const allowSession = el("button", "primary", t("permission.allowSession"));
  actions.appendChild(allowSession);
  const allowPersist = event.canPersist ? el("button", null, t("permission.allowPersist")) : null;
  if (allowPersist) actions.appendChild(allowPersist);
  const deny = el("button", "deny", t("permission.deny"));
  actions.appendChild(deny);

  const respond = async (decision) => {
    [...actions.querySelectorAll("button")].forEach((button) => { button.disabled = true; });
    try {
      const result = await window.arcane.respondPermission(event.requestId, decision);
      if (!result?.ok) resolvePermissionRequest(event.requestId);
    } catch {
      resolvePermissionRequest(event.requestId);
    }
  };
  allowSession.addEventListener("click", () => respond("allow-session"));
  allowPersist?.addEventListener("click", () => respond("allow-persist"));
  deny.addEventListener("click", () => respond("deny"));
  card.appendChild(actions);
  permissionCenter.appendChild(card);
}

function hideDisplaySourcePicker(requestId) {
  if (requestId && displaySourceRequest?.requestId !== requestId) return;
  displaySourceRequest = null;
  displayPickerBackdrop.textContent = "";
  displayPickerBackdrop.hidden = true;
}

function showDisplaySourcePicker(event) {
  displaySourceRequest = event;
  displayPickerBackdrop.textContent = "";
  displayPickerBackdrop.hidden = false;

  const picker = el("div", "display-picker");
  const head = el("div", "display-picker-head");
  head.appendChild(el("div", "display-picker-title", t("displayPicker.title")));
  head.appendChild(el("div", "display-picker-origin", event.origin));
  const grid = el("div", "display-source-grid");
  let selectedId = null;
  let selectedButton = null;

  const foot = el("div", "display-picker-foot");
  let audio = null;
  if (event.audioAvailable) {
    const audioLabel = el("label", "display-audio");
    audio = /** @type {HTMLInputElement} */ (document.createElement("input"));
    audio.type = "checkbox";
    audio.checked = false;
    audioLabel.append(audio, document.createTextNode(t("displayPicker.includeAudio")));
    foot.appendChild(audioLabel);
  } else {
    foot.appendChild(el("span", "display-audio", ""));
  }
  const cancel = el("button", "btn", t("displayPicker.cancel"));
  const share = /** @type {HTMLButtonElement} */ (el("button", "btn primary", t("displayPicker.share")));
  share.disabled = true;
  foot.append(cancel, share);

  for (const source of event.sources ?? []) {
    const button = el("button", "display-source");
    button.type = "button";
    const preview = /** @type {HTMLImageElement} */ (document.createElement("img"));
    preview.className = "preview";
    preview.alt = "";
    if (source.thumbnail) preview.src = source.thumbnail;
    const name = el("div", "display-source-name");
    if (source.appIcon) {
      const icon = /** @type {HTMLImageElement} */ (document.createElement("img"));
      icon.alt = "";
      icon.src = source.appIcon;
      name.appendChild(icon);
    }
    name.appendChild(el("span", null, source.name));
    button.append(preview, name, el("div", "display-source-kind", t(source.kind === "screen" ? "displayPicker.screen" : "displayPicker.window")));
    button.title = source.name;
    button.addEventListener("click", () => {
      selectedButton?.classList.remove("selected");
      selectedButton = button;
      selectedButton.classList.add("selected");
      selectedId = source.id;
      share.disabled = false;
    });
    grid.appendChild(button);
  }

  const respond = async (sourceId) => {
    cancel.disabled = true;
    share.disabled = true;
    try {
      const result = await window.arcane.respondDisplaySource(event.requestId, sourceId, Boolean(audio?.checked));
      if (!result?.ok) hideDisplaySourcePicker(event.requestId);
    } catch {
      hideDisplaySourcePicker(event.requestId);
    }
  };
  cancel.addEventListener("click", () => respond(null));
  share.addEventListener("click", () => respond(selectedId));
  picker.append(head, grid, foot);
  displayPickerBackdrop.appendChild(picker);
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || displayPickerBackdrop.hidden || !displaySourceRequest) return;
  event.preventDefault();
  window.arcane.respondDisplaySource(displaySourceRequest.requestId, null, false).catch(() => {
    hideDisplaySourcePicker(displaySourceRequest?.requestId);
  });
});

function addModelSetupCard(info = {}) {
  if (modelSetupCard?.isConnected) {
    modelSetupCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return modelSetupCard;
  }
  closeWorkBlock();
  dismissWelcome();
  const providerName = info.providerName || t("setup.currentProvider");
  const card = el("div", "card model-setup");
  const head = el("div", "head");
  const dot = el("span", "dot");
  dot.style.background = "var(--accent)";
  head.append(dot, el("span", "setup-title", t("setup.title", { name: providerName })));
  const body = el("div", "setup-body", t("setup.body", { name: providerName }));
  const actions = el("div", "actions");
  const configure = el("button", "primary", t("setup.configure"));
  configure.addEventListener("click", () => openProviderSettings(info.providerId));
  actions.appendChild(configure);
  const foot = el("div", "setup-foot");
  foot.appendChild(document.createTextNode(t("setup.noKey")));
  const apply = el("button", "setup-link", t("setup.getTrialKey"));
  apply.addEventListener("click", () => window.arcane.openArcaneWebsite());
  foot.appendChild(apply);
  card.append(head, body, actions, foot);
  messages.appendChild(card);
  modelSetupCard = card;
  scrollToEnd(true);
  return card;
}

function clearModelSetupCard() {
  modelSetupCard?.remove();
  modelSetupCard = null;
}

// ---------- busy state ----------

function setBusy(next) {
  busy = next;
  composerWrap.classList.toggle("busy", busy);
}

// ---------- events ----------

function onEvent(event) {
  // 双模式:带 mode 标签的事件只渲染活动模式;无标签的 panel 等全局事件放行
  if (event.mode && event.mode !== currentMode) return;
  switch (event.type) {
    case "message": {
      // 终稿:替换对应流式草稿气泡(同 key),否则新建消息。
      // textI18n:主进程结构化文案(如模型调用失败),显示前本地化。
      const finalText = event.textI18n ? t(event.textI18n.key, event.textI18n.params) : event.text;
      const bubble = event.key ? streamBubbles.get(event.key) : null;
      if (bubble) {
        streamBubbles.delete(event.key);
        bubble.classList.remove("streaming");
        const body = bubble.querySelector(".body");
        body.textContent = "";
        if (finalText) renderMarkdown(body, finalText);
        scrollToEnd();
      } else if (finalText) {
        addMessage(event.role, finalText);
      }
      if (event.key) settleThinkBlock(event.key, event.thinking);
      break;
    }
    case "message_delta": {
      if (event.thinking) {
        const think = thinkBlock(event.key);
        think.body.textContent = event.thinking;
        scrollToEnd();
      }
      if (event.text) {
        const bubble = streamBubble(event.key);
        const body = bubble.querySelector(".body");
        body.textContent = event.text;
        scrollToEnd();
      }
      break;
    }
    case "tool_start":
      ensureToolCard(event.toolCallId, event.toolName, event.args);
      break;
    case "tool_end":
      finishToolCard(event.toolCallId, event.toolName, event);
      break;
    case "panel_status":
      panelOpen = Boolean(event.open);
      panelDot.classList.toggle("on", panelOpen);
      togglePanelBtn.classList.toggle("open", panelOpen);
      break;
    case "panel_layout":
      panelLayout.open = Boolean(event.open);
      if (typeof event.chatWidth === "number") panelLayout.chatWidth = event.chatWidth;
      if (typeof event.gutter === "number") panelLayout.gutter = event.gutter;
      applyPanelLayout();
      break;
    case "fullscreen":
      // 真全屏(F11):main 告知状态,CSS 收起标题栏带、分隔条上沿回窗口顶
      document.body.classList.toggle("is-fullscreen", Boolean(event.on));
      break;
    case "model_info":
      updateModelLabels(event.label ?? "default");
      if (typeof event.supportsImages === "boolean") modelSupportsImages = event.supportsImages;
      break;
    case "world_info": {
      const title = event.data?.world?.title ?? event.data?.world?.id;
      if (title) {
        worldChip.textContent = title;
        worldChip.title = `world: ${event.data?.world?.id ?? title}`;
        worldChip.style.display = "";
      }
      break;
    }
    case "permission_request":
      receivePermissionRequest(event);
      break;
    case "permission_resolved":
      resolvePermissionRequest(event.requestId);
      break;
    case "display_source_request":
      showDisplaySourcePicker(event);
      break;
    case "display_source_resolved":
      hideDisplaySourcePicker(event.requestId);
      break;
    case "approval_request":
      addApprovalCard(event);
      break;
    case "session_switched":
      // 切换/新建会话:整体重置后按历史重渲染(含工具卡片四态)
      renderHistory(event.history ?? []);
      if (event.modelLabel) updateModelLabels(event.modelLabel);
      if (typeof event.supportsImages === "boolean") modelSupportsImages = event.supportsImages;
      refreshSessions();
      break;
    case "agent_ready":
      // agent 在 renderer 之后就绪:补拉当前会话历史
      pullCurrentSession();
      break;
    case "agent_settled":
      closeWorkBlock();
      setBusy(false);
      addStatus(t("chat.status.agentReady"));
      break;
    case "agent_end":
      closeWorkBlock();
      setBusy(false);
      // 首轮结束后 main 会给会话起名;抽屉开着时刷新列表
      if (drawer.classList.contains("open")) refreshSessions();
      break;
    case "compaction_start":
      // pi 自动压缩(threshold/overflow)或手动 /compact(manual)
      addStatus(event.reason === "manual" ? t("chat.status.compactManual") : t("chat.status.compactAuto"));
      break;
    case "compaction_end":
      addStatus(event.errorMessage ? t("chat.status.compactFailed", { error: event.errorMessage }) : t("chat.status.compacted"));
      break;
    default:
      break;
  }
}

// ---------- slash 候选弹窗 ----------
// 候选 = app 命令(/compact,main 侧拦截)+ 当前会话 skills + prompt 模板。
// /skill:name 与 /模板名 由 pi session.prompt 原生展开,renderer 只做列举与补全。
const slashPopup = document.getElementById("slash-popup");
let slashItems = null; // null = 未拉取;模式/目录切换后置空重拉
let slashFetching = false;
let slashRequest = 0;
let slashMatches = [];
let slashActive = -1;

// 候选来源徽标按当前语言显示(热切换后 renderSlash 会重走这里)
const slashSrcLabel = (src) =>
  t(src === "command" ? "slash.src.command" : src === "template" ? "slash.src.template" : "slash.src.skill");

async function ensureSlashItems() {
  if (slashItems || slashFetching) return;
  const requestId = ++slashRequest;
  const context = modeContext();
  slashFetching = true;
  try {
    const data = await window.arcane.listSlash(context);
    if (requestId !== slashRequest || !sameModeContext(context) || data?.ok === false) return;
    slashItems = [
      ...(data?.commands ?? []).map((c) => ({
        typed: c.name,
        desc: c.descriptionKey ? t(c.descriptionKey) : c.description ?? "",
        hint: c.argumentHintKey ? t(c.argumentHintKey) : c.argumentHint ?? "",
        src: "command",
      })),
      ...(data?.skills ?? []).map((s) => ({
        typed: `skill:${s.name}`, desc: s.description ?? "", hint: "", src: "skill",
      })),
      ...(data?.templates ?? []).map((t) => ({
        typed: t.name, desc: t.description ?? "", hint: t.argumentHint ?? "", src: "template",
      })),
    ];
  } catch {
    if (requestId !== slashRequest || !sameModeContext(context)) return;
    slashItems = [];
  } finally {
    if (requestId === slashRequest) slashFetching = false;
  }
  if (requestId !== slashRequest || !sameModeContext(context)) return;
  // 拉取期间输入可能已变,重走一遍过滤
  renderSlash();
}

function invalidateSlashItems() {
  slashRequest += 1;
  slashFetching = false;
  slashItems = null;
  closeSlash();
}

/** 只有整段输入是 "/xxx"(无空格无换行)时才弹候选;开始输参数就收起。 */
function slashToken() {
  const match = input.value.match(/^\/(\S*)$/);
  return match ? match[1].toLowerCase() : null;
}

function closeSlash() {
  slashPopup.classList.remove("open");
  slashMatches = [];
  slashActive = -1;
}

function renderSlash() {
  const token = slashToken();
  if (token === null) {
    closeSlash();
    return;
  }
  if (!slashItems) {
    ensureSlashItems(); // 拉取中不弹,完成后 ensureSlashItems 里重渲
    return;
  }
  slashMatches = slashItems.filter((item) => !token || item.typed.toLowerCase().includes(token));
  slashActive = slashMatches.length > 0 ? 0 : -1;
  slashPopup.textContent = "";
  if (slashMatches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "slash-empty";
    empty.textContent = t("slash.empty");
    slashPopup.appendChild(empty);
  } else {
    slashMatches.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "slash-item";
      const name = document.createElement("span");
      name.className = "slash-name";
      name.textContent = `/${item.typed}`;
      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "slash-hint";
        hint.textContent = ` ${item.hint}`;
        name.appendChild(hint);
      }
      const desc = document.createElement("span");
      desc.className = "slash-desc";
      desc.textContent = item.desc;
      const src = document.createElement("span");
      src.className = "slash-src";
      src.textContent = slashSrcLabel(item.src);
      row.append(name, desc, src);
      // mousedown 抢在 textarea blur 前;preventDefault 保持焦点不丢
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        pickSlash(item);
      });
      slashPopup.appendChild(row);
    });
  }
  paintSlashActive();
  slashPopup.classList.add("open");
}

function paintSlashActive() {
  slashPopup.querySelectorAll(".slash-item").forEach((row, index) => {
    const on = index === slashActive;
    row.classList.toggle("active", on);
    if (on) row.scrollIntoView({ block: "nearest" });
  });
}

function moveSlash(delta) {
  if (slashMatches.length === 0) return;
  slashActive = (slashActive + delta + slashMatches.length) % slashMatches.length;
  paintSlashActive();
}

function pickSlash(item) {
  input.value = `/${item.typed} `;
  closeSlash();
  autosize();
  input.focus();
}

// ---------- + 功能菜单(输入行左侧;目前收图片入口,以后往菜单里加项即可) ----------
const plusBtn = document.getElementById("plus");
const plusMenu = document.getElementById("plus-menu");

plusBtn.addEventListener("click", () => {
  plusMenu.hidden = !plusMenu.hidden;
});
// 菜单项各自的处理由各自监听器完成(attach → attachInput.click()),这里只管点完后收起菜单
plusMenu.addEventListener("click", (event) => {
  if (/** @type {Element | null} */ (event.target)?.closest(".plus-item")) plusMenu.hidden = true;
});
document.addEventListener("mousedown", (event) => {
  const target = /** @type {Node} */ (event.target);
  if (!plusMenu.hidden && !plusMenu.contains(target) && !plusBtn.contains(target)) plusMenu.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !plusMenu.hidden) plusMenu.hidden = true;
});

// ---------- 图片附件(粘贴 Ctrl+V / 拖入 / + 菜单选择;随消息发出,备团模式 main 侧另存文件) ----------
const attachBtn = document.getElementById("attach");
const attachInput = /** @type {HTMLInputElement} */ (document.getElementById("attach-input"));
const attachStrip = document.getElementById("attach-strip");
const MAX_ATTACH = 6;
const MAX_IMAGE_DIM = 1568; // 长边超限才重编码(对齐主流视觉模型推荐上限)
const MAX_IMAGE_B64 = 2 * 1024 * 1024; // 单图 base64 ≤2MB；6 图请求可控制在 16MB 网关合同内
let pendingImages = []; // { data: base64, mimeType, previewUrl }
let modelSupportsImages = true;

async function fileToAttachment(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const node = new Image();
    node.onload = () => resolve(node);
    node.onerror = () => reject(new Error("decode failed"));
    node.src = dataUrl;
  });
  let finalUrl = dataUrl;
  let finalMime = file.type || "image/png";
  const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
  const originalB64 = String(dataUrl).split(",")[1] ?? "";
  if (maxDim > MAX_IMAGE_DIM || originalB64.length > MAX_IMAGE_B64) {
    const initialScale = Math.min(1, MAX_IMAGE_DIM / maxDim);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    let accepted = false;
    // 先降 JPEG 质量，再逐级缩小尺寸；避免小尺寸高熵 PNG/GIF 穿透 4~10MB。
    for (let shrink = 0; shrink < 4 && !accepted; shrink += 1) {
      const scale = initialScale * (0.82 ** shrink);
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      context.fillStyle = "#fff"; // JPEG 无透明通道，给透明 PNG 一个稳定背景
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.87, 0.76, 0.64]) {
        finalUrl = canvas.toDataURL("image/jpeg", quality);
        if ((finalUrl.split(",")[1] ?? "").length <= MAX_IMAGE_B64) {
          accepted = true;
          break;
        }
      }
    }
    if (!accepted) throw new Error("image too large");
    finalMime = "image/jpeg";
  }
  const finalB64 = finalUrl.split(",")[1] ?? "";
  if (!finalB64 || finalB64.length > MAX_IMAGE_B64) throw new Error("image too large");
  return { data: finalB64, mimeType: finalMime, previewUrl: finalUrl };
}

async function addImageFiles(files) {
  const images = [...(files ?? [])].filter((f) => f?.type?.startsWith("image/"));
  if (images.length === 0) return;
  if (!modelSupportsImages) addStatus(t("chat.status.imageNoVision"));
  for (const file of images) {
    if (pendingImages.length >= MAX_ATTACH) {
      addStatus(t("chat.status.imageLimit", { count: MAX_ATTACH }));
      break;
    }
    try {
      pendingImages.push(await fileToAttachment(file));
    } catch {
      addStatus(t("chat.status.imageReadFailed", { name: file.name ?? "clipboard" }));
    }
  }
  renderAttachStrip();
}

function renderAttachStrip() {
  attachStrip.textContent = "";
  attachStrip.classList.toggle("has-items", pendingImages.length > 0);
  pendingImages.forEach((item, index) => {
    const thumb = el("div", "attach-thumb");
    const img = document.createElement("img");
    img.src = item.previewUrl;
    img.alt = t("chat.attach.altN", { n: index + 1 });
    const remove = el("button", "attach-remove", "×");
    remove.title = t("chat.attach.remove");
    remove.addEventListener("click", () => {
      pendingImages.splice(index, 1);
      renderAttachStrip();
    });
    thumb.append(img, remove);
    attachStrip.appendChild(thumb);
  });
}

attachBtn.addEventListener("click", () => attachInput.click());
attachInput.addEventListener("change", () => {
  addImageFiles(attachInput.files);
  attachInput.value = ""; // 允许连续选同一文件
});
input.addEventListener("paste", (event) => {
  const items = [...(event.clipboardData?.items ?? [])];
  const files = items.filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter(Boolean);
  if (files.length === 0) return; // 纯文本粘贴走默认
  event.preventDefault(); // 有图时整个吃掉,避免文件名文本混进输入框
  addImageFiles(files);
});
composerWrap.addEventListener("dragover", (event) => {
  if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
  event.preventDefault();
  composerWrap.classList.add("drag-over");
});
composerWrap.addEventListener("dragleave", () => composerWrap.classList.remove("drag-over"));
composerWrap.addEventListener("drop", (event) => {
  event.preventDefault();
  composerWrap.classList.remove("drag-over");
  addImageFiles(event.dataTransfer?.files);
});

// ---------- composer ----------

function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

async function submit() {
  const text = input.value.trim();
  const images = pendingImages.map(({ data, mimeType }) => ({ data, mimeType }));
  if (!text && images.length === 0) return;
  try {
    const access = await window.arcane.getModelAccess();
    if (access?.missingKey) {
      addModelSetupCard(access.missingKey);
      return;
    }
  } catch {
    // Main process repeats this guard; a transient preflight failure must not block chat.
  }
  closeSlash();
  input.value = "";
  autosize();
  const echoImages = pendingImages.slice();
  pendingImages = [];
  renderAttachStrip();
  const outbound = text || t("chat.imagePlaceholder"); // pi 总会带 text part,空串会被部分 provider 拒绝
  const userMessage = addMessage("user", outbound, echoImages);
  if (!busy) setBusy(true);
  const context = modeContext();
  const result = await window.arcane.prompt(outbound, images, context);
  // 请求已绑定旧模式并可在后台继续；切换后的 UI 不接收它的完成态副作用。
  if (!sameModeContext(context)) return;
  if (!result?.ok) {
    // 发送失败:恢复附件与文本,别让用户重贴
    pendingImages = echoImages;
    renderAttachStrip();
    if (!input.value) {
      input.value = text;
      autosize();
    }
    setBusy(false);
    // /compact 的失败已由 compaction_end 事件透出,不重复报
    if (result?.code === "MODEL_PROVIDER_KEY_REQUIRED") {
      userMessage.remove();
      addModelSetupCard(result);
    } else if (!result?.compacted) {
      addStatus(t("chat.status.sendFailed", { error: result?.error ? fmtIpc(result.error) : t("common.unknownError") }));
    }
  } else if (result.compacted) {
    // /compact 不产生 agent_end(compaction 不走 turn),这里手动解除 busy
    setBusy(false);
  } else if (result.steered) {
    addStatus(t("chat.status.steered"));
  }
}

send.addEventListener("click", submit);
stop.addEventListener("click", () => {
  window.arcane.abort(modeContext());
  addStatus(t("chat.status.abortRequested"));
});
togglePanelBtn.addEventListener("click", async () => {
  if (panelOpen) {
    await window.arcane.closePanel();
    return;
  }
  const result = await window.arcane.openPanel();
  if (result && result.ok === false) {
    addStatus(t("chat.status.panelOpenFailed", {
      error: result.error ? fmtIpc(result.error) : result.summary ?? t("common.unknown"),
    }));
  }
});
input.addEventListener("input", () => {
  autosize();
  renderSlash();
});
input.addEventListener("keydown", (event) => {
  // IME 组合中(中/日/韩输入法选字)的按键不进入 app 逻辑——
  // 确认词组的回车、选字的方向键都不是发给输入框的指令;
  // keyCode 229 是个别 IME 不上报 isComposing 的兜底
  if (event.isComposing || event.keyCode === 229) return;
  if (slashPopup.classList.contains("open")) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSlash(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSlash(-1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSlash();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (slashActive >= 0) pickSlash(slashMatches[slashActive]);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const active = slashActive >= 0 ? slashMatches[slashActive] : null;
      // 已完整敲出高亮命令(如 /compact)→ 放行直接执行;否则 Enter = 补全
      if (active && active.typed.toLowerCase() !== slashToken()) {
        event.preventDefault();
        pickSlash(active);
        return;
      }
      closeSlash();
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

document.querySelectorAll(".example-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    input.value = /** @type {HTMLElement} */ (chip).dataset.prompt ?? chip.textContent;
    autosize();
    input.focus();
  });
});

// ---------- panel layout:chat 居左,Foundry 主视觉从右侧弹出 + 可拖分栏 ----------
// chat 页面是整窗的,Foundry WebContentsView 盖在右屏;main 侧通过
// panel_layout 事件告知 chat 宽度,这里用 body margin-right 把内容让出来。
const splitter = document.getElementById("splitter");
const panelLayout = { open: false, chatWidth: 0, gutter: 6 };

function applyPanelLayout() {
  if (!panelLayout.open) {
    document.body.classList.remove("with-panel");
    document.body.classList.remove("header-tight");
    document.body.style.marginRight = "";
    document.body.style.removeProperty("--panel-w");
    scrollBottomBtn.style.right = "";
    return;
  }
  document.body.classList.add("with-panel");
  // chat 侧被 margin 压窄时(media query 只看整窗,感知不到),收掉顶栏次要信息,
  // 保证模式开关等关键控件不被挤没;阈值对齐既有 560px 断点
  document.body.classList.toggle("header-tight", panelLayout.chatWidth < 560);
  const margin = Math.max(0, window.innerWidth - panelLayout.chatWidth - panelLayout.gutter);
  document.body.style.marginRight = `${margin}px`;
  // 供浮层(设置/抽屉遮罩)收进 chat 区域:BrowserView 原生压在渲染层之上,任何 z-index 都盖不住它
  document.body.style.setProperty("--panel-w", `${margin}px`);
  splitter.style.left = `${panelLayout.chatWidth}px`;
  // scroll-bottom 是 position:fixed,right 基准是整个视口;
  // Foundry view 盖在右屏,要把它收进 chat 区域内。
  scrollBottomBtn.style.right = `${margin + 18}px`;
}
window.addEventListener("resize", applyPanelLayout);

// 拖拽:本地立即重排(体感零延迟),~60ms 节流同步给 main 调整 Foundry view。
// pointerdown 时通知 main 让 Foundry view 鼠标事件穿透,指针划过右屏也不断流。
let dragging = false;
let lastSentWidth = 0;
let lastSendAt = 0;

splitter.addEventListener("pointerdown", (event) => {
  if (!panelLayout.open) return;
  dragging = true;
  splitter.classList.add("dragging");
  splitter.setPointerCapture(event.pointerId);
  window.arcane.panelDragStart();
  event.preventDefault();
});

splitter.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const minChat = 280;
  const maxChat = Math.round(window.innerWidth * 0.65);
  const newChatWidth = Math.min(Math.max(minChat, event.clientX - panelLayout.gutter / 2), maxChat);
  panelLayout.chatWidth = newChatWidth;
  applyPanelLayout();
  const now = Date.now();
  if (newChatWidth !== lastSentWidth && now - lastSendAt > 60) {
    lastSentWidth = newChatWidth;
    lastSendAt = now;
    window.arcane.setChatWidth(newChatWidth);
  }
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  splitter.classList.remove("dragging");
  window.arcane.setChatWidth(panelLayout.chatWidth);
  window.arcane.panelDragEnd();
}
splitter.addEventListener("pointerup", endDrag);
splitter.addEventListener("pointercancel", endDrag);

// ---------- theme:月之暗面 <-> 月之亮面 ----------
const themeToggle = document.getElementById("theme-toggle");

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function reflectThemeGlyph() {
  const dark = currentTheme() === "dark";
  themeToggle.textContent = dark ? "☀" : "☾";
  themeToggle.title = dark ? t("header.theme.toLight") : t("header.theme.toDark");
}

function applyTheme(theme, event) {
  const swap = () => {
    document.documentElement.dataset.theme = theme;
    reflectThemeGlyph();
  };
  // 圆形扩散过渡(Chromium View Transition);不支持则直接切换
  if (document.startViewTransition && event) {
    const x = event.clientX ?? window.innerWidth / 2;
    const y = event.clientY ?? 0;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(swap);
    transition.ready
      .then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: 450, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" }
        );
      })
      .catch(() => {});
  } else {
    swap();
  }
  try {
    localStorage.setItem("arcane-theme", theme);
  } catch {
    /* ignore */
  }
  window.arcane.setTheme?.(theme);
}

themeToggle.addEventListener("click", (event) => {
  applyTheme(currentTheme() === "dark" ? "light" : "dark", event);
});
reflectThemeGlyph();

// ---------- sessions:历史渲染 + 会话抽屉 ----------

function resetConversation() {
  messages.innerHTML = "";
  toolCards.clear();
  streamBubbles.clear();
  thinkBlocks.clear();
  workBlock = null;
  setBusy(false);
}

function renderHistory(entries) {
  resetConversation();
  if (!entries || entries.length === 0) {
    showWelcome();
    return;
  }
  for (const entry of entries) {
    if (entry.role === "user") {
      addMessage("user", entry.text, entry.images);
    } else if (entry.role === "assistant") {
      if (currentMode === "prep") {
        // 备团:thinking + 工具卡片收进「工作过程」块(折叠),最终文本在块外
        const calls = entry.toolCalls ?? [];
        if (entry.thinking || calls.length > 0) {
          if (entry.thinking) renderThinkingHistory(`hist:${entry.ts}`, entry.thinking);
          for (const call of calls) {
            ensureToolCard(call.id, call.name, call.args);
            finishToolCard(call.id, call.name, {
              isError: Boolean(call.isError),
              result: { content: call.resultText ? [{ type: "text", text: call.resultText }] : [] },
            });
          }
          closeWorkBlock(false); // 历史块直接收尾折叠;历史没有真实计时,不显示秒数
        }
        if (entry.text) addMessage("assistant", entry.text);
      } else {
        // 战斗:与现状逐像素一致(平铺)
        if (entry.thinking) renderThinkingHistory(`hist:${entry.ts}`, entry.thinking);
        if (entry.text) addMessage("assistant", entry.text);
        for (const call of entry.toolCalls ?? []) {
          ensureToolCard(call.id, call.name, call.args);
          finishToolCard(call.id, call.name, {
            isError: Boolean(call.isError),
            result: { content: call.resultText ? [{ type: "text", text: call.resultText }] : [] },
          });
        }
      }
    }
  }
  addStatus(t("chat.sessionRestored"));
  scrollToEnd(true);
}

let currentSessionRequest = 0;

async function pullCurrentSession() {
  const requestId = ++currentSessionRequest;
  const payload = await window.arcane.currentSession();
  if (requestId !== currentSessionRequest || !acceptModeSnapshot(payload)) return;
  // 模式真相以 main 为准(持久化在 ui.json);顺带同步模式滑块与目录 chip
  if (payload.mode) {
    const previousMode = currentMode;
    applyModeUi(payload.mode, payload.cwd);
    // 启动同步可把 renderer 默认 prep 校准成持久化模式；不要覆盖在途切换目标。
    if (requestedMode === previousMode) requestedMode = currentMode;
  }
  if (!payload?.session) return;
  if (typeof payload.busy === "boolean") setBusy(payload.busy);
  // 启动竞态:world/model 的推送可能早于 renderer 订阅,这里一并补齐
  const title = payload.worldInfo?.world?.title ?? payload.worldInfo?.world?.id;
  if (title) {
    worldChip.textContent = title;
    worldChip.title = `world: ${payload.worldInfo?.world?.id ?? title}`;
    worldChip.style.display = "";
  }
  if (payload.modelLabel) updateModelLabels(payload.modelLabel);
  if (typeof payload.supportsImages === "boolean") modelSupportsImages = payload.supportsImages;
  // 用户已经在本地输入/收到过消息时不覆盖对话区(启动竞态保护)
  if (messages.querySelector(".msg, .card")) return;
  renderHistory(payload.history ?? []);
}

const drawer = document.getElementById("session-drawer");
const drawerBackdrop = document.getElementById("drawer-backdrop");
const sessionList = document.getElementById("session-list");
let sessionRefreshRequest = 0;

function setDrawer(open) {
  drawer.classList.toggle("open", open);
  document.body.classList.toggle("drawer-open", open);
  if (open) refreshSessions();
}

async function refreshSessions() {
  const requestId = ++sessionRefreshRequest;
  const context = modeContext();
  const result = await window.arcane.listSessions(context);
  if (requestId !== sessionRefreshRequest || !sameModeContext(context) || result?.ok === false) return;
  const sessions = result?.sessions ?? [];
  sessionList.innerHTML = "";
  if (sessions.length === 0) {
    sessionList.appendChild(el("div", "drawer-empty", t("sessions.empty")));
    return;
  }
  for (const s of sessions) {
    // 未落盘的新会话由 main 标 firstMessageI18n(sessions.unsaved),其余用真实首条消息
    const sessionName = s.name
      || (s.firstMessageI18n ? t(s.firstMessageI18n) : s.firstMessage)
      || t("sessions.untitled");
    const item = el("div", `session-item${s.active ? " active" : ""}`);
    const body = el("div", "s-body");
    body.appendChild(el("div", "s-title", sessionName));
    const when = s.modified ? new Date(s.modified) : null;
    const countPart = t("sessions.count", { count: s.messageCount });
    const meta = when
      ? `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")} · ${countPart}`
      : countPart;
    body.appendChild(el("div", "s-meta", meta));
    const del = el("button", "s-del", "×");
    del.title = t("sessions.delete");
    del.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm(t("sessions.deleteConfirm", { name: sessionName }))) return;
      if (!sameModeContext(context)) return;
      const result = await window.arcane.deleteSession(s.path, context);
      if (!result?.ok) {
        addStatus(t("sessions.deleteFailed", {
          error: result?.error ? fmtIpc(result.error) : t("common.unknown"),
        }));
        return;
      }
      refreshSessions();
    });
    item.append(body, del);
    item.addEventListener("click", async () => {
      setDrawer(false);
      if (!s.active && sameModeContext(context)) {
        const result = await window.arcane.openSession(s.path, context);
        if (!result?.ok) {
          addStatus(t("sessions.openFailed", {
            error: result?.error ? fmtIpc(result.error) : t("common.unknown"),
          }));
        }
      }
    });
    sessionList.appendChild(item);
  }
}

document.getElementById("sessions-toggle").addEventListener("click", () =>
  setDrawer(!drawer.classList.contains("open"))
);
drawerBackdrop.addEventListener("click", () => setDrawer(false));
document.getElementById("session-new").addEventListener("click", async () => {
  setDrawer(false);
  const context = modeContext();
  const result = await window.arcane.newSession(context);
  if (!sameModeContext(context)) return;
  if (!result?.ok) {
    addStatus(t("sessions.newFailed", {
      error: result?.error ? fmtIpc(result.error) : t("common.unknown"),
    }));
  }
  input.focus();
});

// ---------- settings:provider 管理 + 默认模型 ----------
const settingsBackdrop = document.getElementById("settings-backdrop");
const webPermissionList = document.getElementById("web-permission-list");
const telemetryConsentCard = document.getElementById("telemetry-consent-card");
const telemetryConsentAccept = /** @type {HTMLButtonElement} */ (document.getElementById("telemetry-consent-accept"));
const telemetryConsentDecline = /** @type {HTMLButtonElement} */ (document.getElementById("telemetry-consent-decline"));
const telemetrySettingSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("telemetry-setting-switch"));
const telemetrySettingStatus = document.getElementById("telemetry-setting-status");
const providerList = document.getElementById("provider-list");
const providerFormWrap = document.getElementById("provider-form-wrap");
const defaultModelSelect = /** @type {HTMLSelectElement} */ (document.getElementById("default-model-select"));
const pfId = /** @type {HTMLInputElement} */ (document.getElementById("pf-id"));
const pfName = /** @type {HTMLInputElement} */ (document.getElementById("pf-name"));
const pfApi = /** @type {HTMLSelectElement} */ (document.getElementById("pf-api"));
const pfBaseUrl = /** @type {HTMLInputElement} */ (document.getElementById("pf-baseurl"));
const pfApiKey = /** @type {HTMLInputElement} */ (document.getElementById("pf-apikey"));
const pfModels = /** @type {HTMLTextAreaElement} */ (document.getElementById("pf-models"));
const pfError = document.getElementById("pf-error");
const pfPreset = /** @type {HTMLInputElement} */ (document.getElementById("pf-preset"));
const pfPresetList = document.getElementById("pf-preset-list");
const pfFetchModels = /** @type {HTMLButtonElement} */ (document.getElementById("pf-fetch-models"));

/** @type {ArcaneTelemetryConsentStatus | null} */
let telemetryConsentState = null;
let telemetryConsentBusy = false;
let telemetryConsentSaveFailed = false;

function renderTelemetryConsent() {
  const state = telemetryConsentState;
  const showPrompt = Boolean(state?.userControllable && !state.decided);
  telemetryConsentCard.hidden = !showPrompt;
  telemetryConsentCard.setAttribute("aria-busy", String(telemetryConsentBusy));
  telemetryConsentAccept.disabled = telemetryConsentBusy;
  telemetryConsentDecline.disabled = telemetryConsentBusy;

  const enabled = Boolean(state?.enabled);
  telemetrySettingSwitch.hidden = !state?.userControllable;
  telemetrySettingSwitch.disabled = telemetryConsentBusy || !state?.userControllable;
  telemetrySettingSwitch.classList.toggle("on", enabled);
  telemetrySettingSwitch.setAttribute("aria-checked", String(enabled));

  if (telemetryConsentBusy) {
    telemetrySettingStatus.textContent = t("settings.telemetry.saving");
  } else if (telemetryConsentSaveFailed) {
    telemetrySettingStatus.textContent = t("settings.telemetry.failed");
  } else if (state?.mode === "development") {
    telemetrySettingStatus.textContent = t("settings.telemetry.dev");
  } else if (!state?.available || state?.mode === "disabled" || state?.mode === "unavailable") {
    telemetrySettingStatus.textContent = t("settings.telemetry.unavailable");
  } else {
    telemetrySettingStatus.textContent = t(enabled ? "settings.telemetry.on" : "settings.telemetry.off");
  }
}

async function refreshTelemetryConsent() {
  try {
    telemetryConsentState = await window.arcane.getTelemetryConsent();
    telemetryConsentSaveFailed = false;
  } catch {
    telemetryConsentState = {
      available: false,
      userControllable: false,
      enabled: false,
      decided: false,
      recording: false,
      mode: "unavailable",
    };
  }
  renderTelemetryConsent();
  return telemetryConsentState;
}

async function setTelemetryConsent(enabled) {
  if (!telemetryConsentState?.userControllable || telemetryConsentBusy) return;
  telemetryConsentBusy = true;
  telemetryConsentSaveFailed = false;
  renderTelemetryConsent();
  try {
    const result = await window.arcane.setTelemetryConsent(enabled);
    if (result?.status) telemetryConsentState = result.status;
    telemetryConsentSaveFailed = !result?.ok;
  } catch {
    telemetryConsentSaveFailed = true;
  } finally {
    telemetryConsentBusy = false;
    renderTelemetryConsent();
  }
}

telemetryConsentAccept.addEventListener("click", () => setTelemetryConsent(true));
telemetryConsentDecline.addEventListener("click", () => setTelemetryConsent(false));
telemetrySettingSwitch.addEventListener("click", () => setTelemetryConsent(!telemetryConsentState?.enabled));

// 内置 provider 预设目录(主进程 provider-catalog):选模板自动带出端点与模型,已知模型预勾 (vision)。
// 预设较多,模板框是可输入筛选的 combobox:输入按名称/id/端点子串过滤,↑↓ 移动、Enter 选中、Esc 关闭。
let providerPresets = null;
async function ensureProviderPresets() {
  if (providerPresets) return providerPresets;
  try {
    providerPresets = (await window.arcane.getProviderCatalog()) ?? [];
  } catch {
    providerPresets = [];
  }
  return providerPresets;
}

const visionSuffix = (m) => `${m.id}${m.vision ? " (vision)" : ""}`;

// 预设显示名按语言取:en 用 nameEn(缺失回退 name),zh 用 name。
const presetDisplayName = (p) =>
  window.ArcaneI18n.getLocale() === "en-US" ? (p.nameEn ?? p.name) : p.name;

let presetItems = []; // 当前渲染的可见预设(键盘导航用)
let presetActiveIdx = -1;

function applyPreset(preset) {
  pfPresetList.hidden = true;
  pfPreset.value = preset ? presetDisplayName(preset) : "";
  if (!preset) return; // 自定义(空白):不动已填内容
  if (!pfId.disabled) pfId.value = preset.id; // 编辑已有 provider 时 id 锁定,不覆盖
  pfName.value = presetDisplayName(preset);
  pfApi.value = preset.api;
  pfBaseUrl.value = preset.baseUrl;
  if (preset.models.length > 0) pfModels.value = preset.models.map(visionSuffix).join("\n");
}

function renderPresetList() {
  const q = pfPreset.value.trim().toLowerCase();
  presetItems = (providerPresets ?? []).filter((p) =>
    !q || p.name.toLowerCase().includes(q) || (p.nameEn ?? "").toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (p.baseUrl ?? "").toLowerCase().includes(q));
  presetActiveIdx = presetItems.length > 0 ? 0 : -1;
  pfPresetList.textContent = "";
  if (!q) {
    const custom = el("div", "combo-item", t("sm.form.presetCustom"));
    custom.addEventListener("mousedown", (e) => { e.preventDefault(); applyPreset(null); });
    pfPresetList.appendChild(custom);
  }
  if (presetItems.length === 0) {
    pfPresetList.appendChild(el("div", "combo-item disabled", t("sm.form.presetNoMatch")));
  }
  for (const p of presetItems) {
    const item = el("div", "combo-item");
    item.appendChild(el("span", null, presetDisplayName(p)));
    item.appendChild(el("span", "cid", p.id));
    item.addEventListener("mousedown", (e) => { e.preventDefault(); applyPreset(p); }); // mousedown 抢在 blur 前
    pfPresetList.appendChild(item);
  }
  markPresetActive();
}

function markPresetActive() {
  [...pfPresetList.children].forEach((node, i) => {
    // 空筛选时第 0 项是"自定义(空白)",预设项索引要 +1
    const presetIdx = pfPreset.value.trim() ? i : i - 1;
    node.classList.toggle("active", presetIdx === presetActiveIdx && presetIdx >= 0);
  });
  pfPresetList.querySelector(".combo-item.active")?.scrollIntoView({ block: "nearest" });
}

pfPreset.addEventListener("focus", () => { renderPresetList(); pfPresetList.hidden = false; });
pfPreset.addEventListener("input", () => { renderPresetList(); pfPresetList.hidden = false; });
pfPreset.addEventListener("blur", () => { pfPresetList.hidden = true; });
pfPreset.addEventListener("keydown", (e) => {
  if (pfPresetList.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    renderPresetList();
    pfPresetList.hidden = false;
    e.preventDefault();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (presetItems.length === 0) return;
    const delta = e.key === "ArrowDown" ? 1 : -1;
    presetActiveIdx = (presetActiveIdx + delta + presetItems.length) % presetItems.length;
    markPresetActive();
    e.preventDefault();
  } else if (e.key === "Enter") {
    if (!pfPresetList.hidden && presetActiveIdx >= 0) {
      applyPreset(presetItems[presetActiveIdx]);
      e.preventDefault();
    }
  } else if (e.key === "Escape") {
    pfPresetList.hidden = true;
  }
});

function resetPresetCombo() {
  pfPreset.value = "";
  presetActiveIdx = -1;
  pfPresetList.hidden = true;
}

pfFetchModels.addEventListener("click", async () => {
  pfError.textContent = "";
  pfFetchModels.disabled = true;
  pfFetchModels.textContent = t("sm.form.fetching");
  try {
    const result = await window.arcane.fetchProviderModels({
      providerId: pfId.value.trim() || undefined,
      api: pfApi.value,
      baseUrl: pfBaseUrl.value.trim(),
      apiKey: pfApiKey.value,
    });
    if (!result?.ok) {
      pfError.textContent = result?.error ? fmtIpc(result.error) : t("sm.form.fetchFailed");
      return;
    }
    pfModels.value = result.models.map(visionSuffix).join("\n");
  } finally {
    pfFetchModels.disabled = false;
    pfFetchModels.textContent = t("sm.form.fetchModels");
  }
});

async function setSettingsOpen(open) {
  settingsBackdrop.classList.toggle("open", open);
  return open ? refreshSettings() : null;
}

async function refreshSettings() {
  const settings = await window.arcane.getSettings();
  refreshVoiceSettings(); // 语音分区与 provider 同页,一并刷新
  refreshWebPermissions();
  refreshLocaleSetting();
  refreshTelemetryConsent();
  const providers = settings.providers ?? [];
  const providerById = Object.fromEntries(providers.map((p) => [p.id, p]));
  // 默认模型下拉:label = provider/modelId(model id 本身可能带 /,按第一个切)
  defaultModelSelect.innerHTML = "";
  const currentLabel = settings.defaultModel ? `${settings.defaultModel.providerId}/${settings.defaultModel.modelId}` : "";
  const placeholder = el("option", null, t("sm.defaultModelPlaceholder"));
  placeholder.value = "";
  if (!currentLabel) placeholder.selected = true;
  defaultModelSelect.appendChild(placeholder);
  for (const m of settings.models ?? []) {
    const provider = providerById[m.providerId];
    const label = provider?.managed
      ? (provider.hasKey ? provider.name : t("sm.providerUnconfigured", { name: provider.name }))
      : m.label;
    const opt = el("option", null, label);
    opt.value = m.label;
    if (m.label === currentLabel) opt.selected = true;
    defaultModelSelect.appendChild(opt);
  }
  // provider 列表
  providerList.innerHTML = "";
  if (providers.length === 0) {
    providerList.appendChild(el("div", "drawer-empty", t("sm.noProviders")));
  }
  for (const p of providers) {
    const item = el("div", "provider-item");
    const body = el("div", "p-body");
    const name = el("div", "p-name", p.managed ? p.name : `${p.name} (${p.id})`);
    body.appendChild(name);
    if (p.managed) {
      const keyState = p.hasKey ? t("sm.keyConfigured", { key: p.apiKey }) : t("sm.keyMissing");
      body.appendChild(el("div", "p-meta", t("sm.provider.managedMeta", { state: keyState })));
    } else {
      const modelsText = p.models.map((m) => `${m.id}${m.vision ? " 👁" : ""}`).join(", ") || t("sm.provider.noModels");
      body.appendChild(el("div", "p-meta", `${p.api} · ${p.baseUrl || t("sm.provider.defaultEndpoint")} · ${modelsText}${p.apiKey ? ` · ${p.apiKey}` : ""}`));
    }
    const actions = el("div", "p-actions");
    const edit = el("button", null, p.managed && !p.hasKey ? t("sm.provider.configure") : t("sm.provider.edit"));
    edit.addEventListener("click", () => fillProviderForm(p));
    actions.appendChild(edit);
    if (!p.managed) {
      const del = el("button", "danger", t("sm.provider.delete"));
      del.addEventListener("click", async () => {
        if (!confirm(t("sm.provider.deleteConfirm", { name: p.name }))) return;
        await window.arcane.deleteProvider(p.id);
        refreshSettings();
      });
      actions.appendChild(del);
    }
    item.append(body, actions);
    providerList.appendChild(item);
  }
  return settings;
}

async function refreshWebPermissions() {
  let origins = [];
  try {
    origins = (await window.arcane.listWebPermissions()) ?? [];
  } catch {
    origins = [];
  }
  webPermissionList.textContent = "";
  if (origins.length === 0) {
    webPermissionList.appendChild(el("div", "drawer-empty", t("permission.saved.empty")));
    return;
  }
  for (const site of origins) {
    const group = el("div", "web-permission-origin");
    const head = el("div", "web-permission-origin-head");
    const origin = document.createElement("code");
    origin.textContent = site.origin;
    origin.title = site.origin;
    const clear = el("button", null, t("permission.saved.clearAll"));
    clear.addEventListener("click", async () => {
      await window.arcane.clearWebPermissions(site.origin);
      refreshWebPermissions();
    });
    head.append(origin, clear);
    group.appendChild(head);
    for (const permission of site.permissions ?? []) {
      const row = el("div", "web-permission-row");
      const [rawPermission, subtype] = permission.key.split(":");
      const label = permissionLabel(rawPermission, subtype ? [subtype] : []);
      row.appendChild(el("span", "label", label));
      row.appendChild(el("span", "decision", t(permission.decision === "allow" ? "permission.saved.alwaysAllow" : "permission.saved.alwaysDeny")));
      const revoke = el("button", null, t("permission.saved.revoke"));
      revoke.addEventListener("click", async () => {
        await window.arcane.revokeWebPermission(site.origin, permission.key);
        refreshWebPermissions();
      });
      row.appendChild(revoke);
      group.appendChild(row);
    }
    webPermissionList.appendChild(group);
  }
}

function setProviderFormManaged(managed) {
  pfPreset.disabled = managed;
  pfName.disabled = managed;
  pfApi.disabled = managed;
  pfBaseUrl.disabled = managed;
  pfModels.disabled = managed;
  pfFetchModels.hidden = managed;
}

function fillProviderForm(p) {
  document.getElementById("provider-form-title").textContent = p.managed
    ? t("sm.form.configureTitle")
    : t("sm.form.editTitle", { name: p.name });
  pfId.value = p.id;
  pfId.disabled = true; // id 不可变
  pfName.value = p.name;
  pfApi.value = p.api;
  pfBaseUrl.value = p.baseUrl;
  pfApiKey.value = ""; // 留空 = 保持原值
  pfModels.value = p.models.map((m) => `${m.id}${m.vision ? " (vision)" : ""}`).join("\n");
  pfApiKey.placeholder = p.hasKey
    ? t("sm.form.apikeyKeep", { key: p.apiKey })
    : p.managed ? t("sm.form.apikeyPlaceholderSpark") : t("sm.form.apikeyPlaceholder");
  pfError.textContent = "";
  resetPresetCombo();
  setProviderFormManaged(Boolean(p.managed));
  ensureProviderPresets();
  providerFormWrap.hidden = false;
}

function activateSettingsPane(paneId) {
  document.querySelectorAll(".settings-tabs .tab").forEach((tab) => {
    const node = /** @type {HTMLElement} */ (tab);
    node.classList.toggle("active", node.dataset.pane === paneId);
  });
  document.querySelectorAll(".settings-pane").forEach((pane) => {
    const node = /** @type {HTMLElement} */ (pane);
    node.hidden = node.id !== paneId;
  });
}

async function openProviderSettings(providerId) {
  activateSettingsPane("pane-model");
  const settings = await setSettingsOpen(true);
  const provider = settings?.providers?.find((p) => p.id === providerId);
  if (provider) fillProviderForm(provider);
  const target = provider ? pfApiKey : defaultModelSelect;
  target.focus();
  target.scrollIntoView({ block: "nearest" });
}

document.getElementById("settings-toggle").addEventListener("click", () => setSettingsOpen(true));
document.getElementById("settings-close").addEventListener("click", () => setSettingsOpen(false));
settingsBackdrop.addEventListener("click", (event) => {
  if (event.target === settingsBackdrop) setSettingsOpen(false);
});

// ---------- composer 模型选择器(kimi web 风格:hint 行右侧芯片,弹出可筛选列表) ----------
const modelPicker = document.getElementById("model-picker");
const modelPickerLabel = document.getElementById("model-picker-label");
const modelPopup = document.getElementById("model-popup");
const modelFilter = /** @type {HTMLInputElement} */ (document.getElementById("model-filter"));
const modelList = document.getElementById("model-list");
let currentModelLabel = null;
let modelPickerModels = []; // 全量候选 { providerId, modelId, label, name }
let providerNames = {};     // providerId -> 显示名(自管 provider 有 name,pi 配置的退回 id)
let modelItemEls = [];      // 与可见行平行的 DOM 项(键盘导航)
let modelVisible = [];      // 当前可见行 { type: "provider"|"model"|"back", ... }
let modelActiveIdx = -1;
let modelMenuProvider = null; // 两级菜单:非 null = 二级(该供应商的模型);筛选词非空时绕过层级平铺

function providerDisplayName(pid) {
  return providerNames[pid] ?? pid;
}

// 顶栏不再放模型 chip(与 composer 右下角的选择器重复),标签只更新 modelPicker;短标签 = 去掉 provider 前缀
function updateModelLabels(label) {
  if (!label) return;
  currentModelLabel = label;
  const arcaneSpark = label.startsWith(`${ARCANE_SPARK_PROVIDER_ID}/`);
  const display = arcaneSpark ? "Arcane Spark" : label;
  const slash = label.indexOf("/");
  modelPickerLabel.textContent = arcaneSpark ? "Arcane Spark" : slash > 0 ? label.slice(slash + 1) : label;
  modelPicker.title = t("modelPicker.titleCurrent", { model: display });
}

function renderModelList() {
  const q = modelFilter.value.trim().toLowerCase();
  modelItemEls = [];
  modelList.textContent = "";
  const addRow = (entry, build) => {
    const item = el("div", "model-item");
    build(item);
    // mousedown 抢在 blur/外部关闭前;stopPropagation 必须加——activate 会重渲染列表,
    // 本元素随之从 DOM 摘除,事件冒泡到 document 时 contains(target) 变 false,会被外部点击守卫误关
    item.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); activateModelRow(entry); });
    modelList.appendChild(item);
    modelItemEls.push(item);
    modelVisible.push(entry);
  };
  modelVisible = [];
  if (q) {
    // 有筛选词:跨供应商平铺搜索结果(逃生口,绕过两级导航)
    const matches = modelPickerModels.filter((m) =>
      m.modelId.toLowerCase().includes(q) || m.providerId.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q));
    for (const m of matches) {
      addRow({ type: "model", model: m }, (item) => {
        item.appendChild(el("span", "mid", `${m.name ?? m.modelId}  ·  ${providerDisplayName(m.providerId)}`));
        if (m.label === currentModelLabel) item.classList.add("current");
      });
    }
  } else if (modelMenuProvider) {
    // 二级:该供应商的模型,首行返回
    addRow({ type: "back" }, (item) => {
      item.classList.add("model-back");
      item.appendChild(el("span", "mid", `‹ ${providerDisplayName(modelMenuProvider)}`));
    });
    for (const m of modelPickerModels.filter((x) => x.providerId === modelMenuProvider)) {
      addRow({ type: "model", model: m }, (item) => {
        item.appendChild(el("span", "mid", m.name ?? m.modelId));
        if (m.label === currentModelLabel) item.classList.add("current");
      });
    }
  } else {
    // 一级:供应商列表(点击才展开)
    for (const pid of [...new Set(modelPickerModels.map((m) => m.providerId))]) {
      const count = modelPickerModels.filter((m) => m.providerId === pid).length;
      addRow({ type: "provider", providerId: pid }, (item) => {
        item.appendChild(el("span", "mid", providerDisplayName(pid)));
        item.appendChild(el("span", "chev", `${count} ›`));
        if (currentModelLabel?.startsWith(`${pid}/`)) item.classList.add("current");
      });
    }
  }
  modelActiveIdx = modelVisible.length > 0 ? 0 : -1;
  if (modelVisible.length === 0) modelList.appendChild(el("div", "combo-item disabled", q ? t("modelPicker.noMatch") : t("modelPicker.none")));
  markModelActive();
}

function activateModelRow(entry) {
  if (entry.type === "provider") {
    modelMenuProvider = entry.providerId;
    renderModelList();
  } else if (entry.type === "back") {
    modelMenuProvider = null;
    renderModelList();
  } else {
    pickModel(entry.model);
  }
}

function markModelActive() {
  modelItemEls.forEach((node, i) => node.classList.toggle("active", i === modelActiveIdx));
  modelItemEls[modelActiveIdx]?.scrollIntoView({ block: "nearest" });
}

async function pickModel(m) {
  modelPopup.hidden = true;
  updateModelLabels(m.label); // 乐观更新;model_info 事件回来再校准
  await window.arcane.setDefaultModel(m.providerId, m.modelId);
}

modelPicker.addEventListener("click", async () => {
  if (!modelPopup.hidden) {
    modelPopup.hidden = true;
    return;
  }
  try {
    const settings = await window.arcane.getSettings();
    modelPickerModels = settings?.models ?? [];
    providerNames = Object.fromEntries((settings?.providers ?? []).map((p) => [p.id, p.name ?? p.id]));
  } catch {
    modelPickerModels = [];
    providerNames = {};
  }
  modelMenuProvider = null;
  modelFilter.value = "";
  renderModelList();
  modelPopup.hidden = false;
  modelFilter.focus();
});
document.addEventListener("mousedown", (e) => {
  if (!modelPopup.hidden && !modelPopup.contains(/** @type {Node} */ (e.target)) && !modelPicker.contains(/** @type {Node} */ (e.target))) modelPopup.hidden = true;
});
modelFilter.addEventListener("input", renderModelList);
modelFilter.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (modelItemEls.length === 0) return;
    const delta = e.key === "ArrowDown" ? 1 : -1;
    modelActiveIdx = (modelActiveIdx + delta + modelItemEls.length) % modelItemEls.length;
    markModelActive();
    e.preventDefault();
  } else if (e.key === "Enter") {
    if (modelActiveIdx >= 0 && modelVisible[modelActiveIdx]) {
      activateModelRow(modelVisible[modelActiveIdx]);
      e.preventDefault();
    }
  } else if (e.key === "Escape") {
    if (modelMenuProvider && !modelFilter.value.trim()) {
      modelMenuProvider = null; // 二级先返回一级,再 Esc 才关
      renderModelList();
    } else {
      modelPopup.hidden = true;
      modelPicker.focus();
    }
  }
});

// 设置页 tab 切换(模型 / 语音 / 通用)
document.querySelectorAll(".settings-tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    activateSettingsPane(/** @type {HTMLElement} */ (tab).dataset.pane);
  });
});

document.getElementById("provider-add").addEventListener("click", () => {
  document.getElementById("provider-form-title").textContent = t("sm.form.addTitle");
  pfId.value = "";
  pfId.disabled = false;
  pfName.value = "";
  pfApi.value = "openai-completions";
  pfBaseUrl.value = "";
  pfApiKey.value = "";
  pfApiKey.placeholder = t("sm.form.apikeyPlaceholder");
  pfModels.value = "";
  pfError.textContent = "";
  resetPresetCombo();
  setProviderFormManaged(false);
  ensureProviderPresets();
  providerFormWrap.hidden = false;
});
document.getElementById("pf-cancel").addEventListener("click", () => {
  providerFormWrap.hidden = true;
});
document.getElementById("pf-save").addEventListener("click", async () => {
  const models = pfModels.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const vision = /\(vision\)\s*$/i.test(line);
      return { id: line.replace(/\s*\(vision\)\s*$/i, ""), vision };
    })
    .filter((m) => m.id);
  const result = await window.arcane.saveProvider({
    id: pfId.value.trim(),
    name: pfName.value.trim(),
    api: pfApi.value,
    baseUrl: pfBaseUrl.value.trim(),
    apiKey: pfApiKey.value,
    models,
  });
  if (!result?.ok) {
    pfError.textContent = result?.error ? fmtIpc(result.error) : t("sm.form.saveFailed");
    return;
  }
  providerFormWrap.hidden = true;
  await refreshSettings();
  const access = await window.arcane.getModelAccess();
  if (!access?.missingKey) clearModelSetupCard();
});
defaultModelSelect.addEventListener("change", async () => {
  const value = defaultModelSelect.value;
  if (!value) {
    await window.arcane.setDefaultModel("", ""); // 清除偏好,回到 SDK 默认(下个会话生效)
    return;
  }
  const slash = value.indexOf("/");
  await window.arcane.setDefaultModel(value.slice(0, slash), value.slice(slash + 1));
});

// ---------- settings:语音识别(Arcane Spark / 自有智谱 API / 关闭) ----------
const vsMode = /** @type {HTMLSelectElement} */ (document.getElementById("vs-mode"));
const vsApikeyRow = document.getElementById("vs-apikey-row");
const vsApikey = /** @type {HTMLInputElement} */ (document.getElementById("vs-apikey"));
const vsAccessState = document.getElementById("vs-access-state");
const vsAccessStatus = document.getElementById("vs-access-status");
const vsAccessAction = /** @type {HTMLButtonElement} */ (document.getElementById("vs-access-action"));
const vsPrompt = /** @type {HTMLTextAreaElement} */ (document.getElementById("vs-prompt"));
const vsHotwords = /** @type {HTMLTextAreaElement} */ (document.getElementById("vs-hotwords"));
const vsStatus = document.getElementById("vs-status");

// 最近一次加载的配置:切换接入方式时刷新 placeholder(跟随/覆盖语义)
let lastVoiceCfg = null;

function voiceKeyPlaceholder() {
  const cfg = lastVoiceCfg;
  if (cfg?.hasOwnKey) {
    return t("sv.apikeyKeepCurrent", { key: cfg.ownApiKey });
  }
  return t("sv.apikeyPlaceholderZhipu");
}

function renderVoiceModeUi() {
  const mode = vsMode.value;
  const ownKeyReady = Boolean(lastVoiceCfg?.hasOwnKey);
  const sparkReady = Boolean(lastVoiceCfg?.sparkHasKey || (
    lastVoiceCfg?.provider === "arcane-relay" && lastVoiceCfg?.hasOwnKey
  ));
  vsApikeyRow.hidden = mode !== "zhipu";
  vsApikey.placeholder = voiceKeyPlaceholder();
  vsAccessAction.hidden = true;
  if (mode === "off") {
    vsAccessState.dataset.state = "off";
    vsAccessStatus.textContent = t("sv.state.off");
  } else if (mode === "zhipu") {
    vsAccessState.dataset.state = ownKeyReady ? "ready" : "needs-key";
    vsAccessStatus.textContent = t(ownKeyReady ? "sv.state.zhipuReady" : "sv.state.zhipuMissing");
  } else {
    vsAccessState.dataset.state = sparkReady ? "ready" : "needs-key";
    vsAccessStatus.textContent = t(sparkReady ? "sv.state.sparkReady" : "sv.state.sparkMissing");
    vsAccessAction.hidden = sparkReady;
  }
}

// 键位捕获控件只改待存值,点"保存"才落盘
let pendingHoldKey = "F9";
let pendingToggleKey = "";
const capHold = window.ArcaneKeyCapture.attach(document.getElementById("vs-holdkey"), {
  get: () => pendingHoldKey,
  set: (value) => { pendingHoldKey = value; },
});
const capToggle = window.ArcaneKeyCapture.attach(document.getElementById("vs-togglekey"), {
  get: () => pendingToggleKey,
  set: (value) => { pendingToggleKey = value; },
});

async function refreshVoiceSettings() {
  const cfg = await window.arcane.getVoiceConfig();
  if (!cfg) return;
  lastVoiceCfg = cfg;
  vsMode.value = cfg.enabled
    ? (cfg.provider === "arcane-relay" ? "arcane-relay" : "zhipu")
    : "off";
  vsApikey.value = ""; // 打码/留空语义同 provider:留空 = 保持原值或继续跟随
  renderVoiceModeUi();
  pendingHoldKey = cfg.holdKey ?? "F9";
  pendingToggleKey = cfg.toggleKey ?? "";
  capHold.render();
  capToggle.render();
  vsPrompt.value = cfg.prompt ?? "";
  vsHotwords.value = (cfg.hotwords ?? []).join("\n");
}

vsMode.addEventListener("change", renderVoiceModeUi);
vsAccessAction.addEventListener("click", () => openProviderSettings("arcane-spark"));

async function openVoiceSettings(focus = "mode") {
  activateSettingsPane("pane-voice");
  await setSettingsOpen(true);
  const target = focus === "apikey" ? vsApikey : vsMode;
  target.focus();
  target.scrollIntoView({ block: "nearest" });
}

window.__arcaneOpenVoiceSettings = openVoiceSettings;
window.__arcaneOpenProviderSettings = openProviderSettings;

document.getElementById("vs-save").addEventListener("click", async () => {
  const selectedMode = vsMode.value;
  const result = await window.arcane.saveVoiceConfig({
    enabled: selectedMode !== "off",
    // 关闭只改 enabled,保留上一次选择,下次开启时仍由用户显式选择接入方式。
    provider: selectedMode === "off" ? (lastVoiceCfg?.provider ?? "arcane-relay") : selectedMode,
    apiKey: vsApikey.value,
    // 旧版本允许覆盖中转地址;新界面不再暴露该实现细节,但保存时仍保留旧值。
    baseUrl: lastVoiceCfg?.baseUrl ?? "",
    holdKey: pendingHoldKey,
    toggleKey: pendingToggleKey,
    prompt: vsPrompt.value,
    hotwords: vsHotwords.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  });
  vsStatus.textContent = result?.ok
    ? t("sv.saved")
    : t("sv.saveFailed", { error: result?.error ? fmtIpc(result.error) : t("common.unknownError") });
  if (result?.ok) {
    window.__arcaneRefreshVoice?.(); // 让麦克风按钮立刻反映最新启用态与快捷键
    refreshVoiceSettings(); // 刷新 key 打码回显
  }
});

// ---------- 设置:通用(界面语言) ----------
const localeSelect = /** @type {HTMLSelectElement} */ (document.getElementById("locale-select"));

async function refreshLocaleSetting() {
  try {
    const pref = await window.arcane.getLocalePref();
    localeSelect.value = pref?.pref ?? "auto";
  } catch {
    localeSelect.value = "auto";
  }
}

localeSelect.addEventListener("change", async () => {
  const pref = localeSelect.value;
  try {
    await window.arcane.setLocale(pref); // 持久化到 ui.json(下次启动即显式选择)
  } catch {
    /* 持久化失败不阻塞本次切换 */
  }
  window.ArcaneI18n.setLocaleForPref(pref); // 本页立即热切换
});

// ---------- 全局快捷键(shortcuts.js 注册表;PTT 在 voice.js 里注册) ----------

// F5 刷新右侧 Foundry 面板:玩家自救入口,面板没开时 main 侧 no-op。
window.ArcaneShortcuts?.register("panel.reload", {
  chords: ["F5"],
  onTap: async () => {
    const result = await window.arcane.reloadPanel?.();
    if (result?.ok) addStatus(t("chat.status.panelReloaded"));
  },
});

// 语言热切换:静态文案由 i18n.js 的 applyI18n 回填,状态派生标签在这里重跑。
// 已渲染的聊天记录/会话标题是用户与 LLM 的数据,刻意不回翻。
window.ArcaneI18n.onLocaleChange(() => {
  applyModeUi(currentMode, lastPrepCwd);
  reflectThemeGlyph();
  if (currentModelLabel) updateModelLabels(currentModelLabel);
  window.__arcaneRefreshVoice?.();
  renderPermissionRequest();
  if (displaySourceRequest) showDisplaySourcePicker(displaySourceRequest);
  if (settingsBackdrop.classList.contains("open")) refreshSettings();
});

// 首帧就用当前语言落一次模式徽章/目录 chip(applyI18n 对 dynamic 节点是跳过的)
applyModeUi(currentMode, lastPrepCwd);
refreshTelemetryConsent();

input.focus();
window.arcane.onEvent(onEvent);
pullCurrentSession();
