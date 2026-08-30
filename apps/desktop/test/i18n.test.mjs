// Desktop i18n release gates:
//   1) locale dictionaries have identical keys and placeholders
//   2) static and dynamic key references all resolve
//   3) user-facing JS string literals contain no unextracted Chinese
//   4) renderer files remain compatible with classic <script> loading
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { I18nError, err, errorToIpc } from "../src/main/i18n-error.mjs";
import "../src/shared/i18n/messages.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MESSAGES = /** @type {Record<string, Record<string, string>>} */ (
  /** @type {any} */ (globalThis).ARCANE_MESSAGES
);

test("dictionary loads and covers zh-CN + en-US", () => {
  assert.ok(MESSAGES, "messages.js should assign globalThis.ARCANE_MESSAGES");
  assert.ok(Object.keys(MESSAGES["zh-CN"] ?? {}).length > 100, "zh-CN dictionary looks too small");
  assert.ok(Object.keys(MESSAGES["en-US"] ?? {}).length > 100, "en-US dictionary looks too small");
});

test("zh-CN and en-US key sets are identical", () => {
  const zh = new Set(Object.keys(MESSAGES["zh-CN"]));
  const en = new Set(Object.keys(MESSAGES["en-US"]));
  assert.deepEqual([...zh].filter((key) => !en.has(key)), [], "keys missing in en-US");
  assert.deepEqual([...en].filter((key) => !zh.has(key)), [], "keys missing in zh-CN");
});

test("parameter placeholders match across locales", () => {
  const paramsOf = (value) => (String(value).match(/\{(\w+)\}/g) ?? []).sort().join(",");
  for (const key of Object.keys(MESSAGES["zh-CN"])) {
    assert.equal(
      paramsOf(MESSAGES["en-US"][key]),
      paramsOf(MESSAGES["zh-CN"][key]),
      `placeholder mismatch for key ${key}`,
    );
  }
});

test("every data-i18n reference in index.html exists", () => {
  const html = readFileSync(path.join(appRoot, "src/renderer/index.html"), "utf8");
  const refs = new Set();
  for (const match of html.matchAll(/data-i18n(?:-html|-title|-placeholder|-prompt|-alt)?="([^"]+)"/g)) {
    refs.add(match[1]);
  }
  assert.ok(refs.size > 30, `expected many data-i18n references, found ${refs.size}`);
  for (const key of refs) {
    assert.ok(key in MESSAGES["zh-CN"], `data-i18n key missing in zh-CN: ${key}`);
    assert.ok(key in MESSAGES["en-US"], `data-i18n key missing in en-US: ${key}`);
  }
});

test("prep guidance offers a deployed FVTT URL immediately after local Foundry", () => {
  const html = readFileSync(path.join(appRoot, "src/renderer/index.html"), "utf8");
  const localIndex = html.indexOf('data-i18n="welcome.example1.label"');
  const remoteIndex = html.indexOf('data-i18n="welcome.remote.label"');
  const nextGuidanceIndex = html.indexOf('data-i18n="welcome.example3.label"');
  assert.ok(localIndex >= 0 && remoteIndex > localIndex && nextGuidanceIndex > remoteIndex);
  assert.match(
    html,
    /data-prompt="打开我已部署好了的 FVTT，网址是 "[^>]+data-i18n-prompt="welcome\.remote\.prompt"/,
  );
});

test("site permissions live inside General instead of a dedicated settings tab", () => {
  const html = readFileSync(path.join(appRoot, "src/renderer/index.html"), "utf8");
  const paneRefs = [...html.matchAll(/class="tab(?: active)?" data-pane="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(paneRefs, ["pane-model", "pane-voice", "pane-general"]);
  assert.doesNotMatch(html, /id="pane-permissions"/);
  assert.match(
    html,
    /id="pane-general"[\s\S]*id="locale-select"[\s\S]*id="telemetry-setting-switch"[\s\S]*id="web-permission-list"/,
    "General should contain language, telemetry consent, then saved site permissions",
  );
});

test("telemetry consent is explicit, non-blocking, and reversible from General", () => {
  const html = readFileSync(path.join(appRoot, "src/renderer/index.html"), "utf8");
  const preload = readFileSync(path.join(appRoot, "preload.cjs"), "utf8");
  const main = readFileSync(path.join(appRoot, "src/main/main.js"), "utf8");
  assert.match(html, /id="telemetry-consent-card" hidden/);
  assert.match(html, /id="telemetry-consent-decline"[^>]*class="btn"|class="btn"[^>]*id="telemetry-consent-decline"/);
  assert.match(html, /id="telemetry-consent-accept"[^>]*class="btn"|class="btn"[^>]*id="telemetry-consent-accept"/);
  assert.doesNotMatch(html, /telemetry-consent-(?:accept|decline)[^>]*primary/);
  assert.match(html, /id="telemetry-setting-switch"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(preload, /getTelemetryConsent:[\s\S]*telemetry:consent-get/);
  assert.match(preload, /setTelemetryConsent:[\s\S]*telemetry:consent-set/);
  assert.match(main, /isTrustedChatIpc\(event\)[\s\S]*telemetry:consent-set/);
});

test("voice settings expose one neutral three-state connection control", () => {
  const html = readFileSync(path.join(appRoot, "src/renderer/index.html"), "utf8");
  assert.doesNotMatch(html, /id="vs-enabled"/);
  assert.match(
    html,
    /id="vs-mode"[\s\S]*value="arcane-relay"[\s\S]*value="zhipu"[\s\S]*value="off"/,
  );
  assert.match(html, /\.pf-row\[hidden\]\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(html, /Arcane Spark[^<]*(推荐|Recommended)/i);
});

test("first launch paints prep mode with a light theme before async startup", () => {
  const html = readFileSync(path.join(appRoot, "src/renderer/index.html"), "utf8");
  const themeInit = readFileSync(path.join(appRoot, "src/renderer/theme-init.js"), "utf8");
  const main = readFileSync(path.join(appRoot, "src/main/main.js"), "utf8");
  assert.match(html, /<body data-mode="prep">/);
  assert.match(html, /class="seg active" id="mode-seg-prep"/);
  assert.doesNotMatch(html, /class="seg active" id="mode-seg-combat"/);
  assert.match(themeInit, /theme\s*=\s*"light";/);
  assert.match(main, /return readUiState\(\)\.theme === "dark" \? "dark" : "light";/);
});

test("messages.js remains loadable as a classic script", () => {
  const source = readFileSync(path.join(appRoot, "src/shared/i18n/messages.js"), "utf8");
  assert.match(source, /globalThis\.ARCANE_MESSAGES\s*=/);
  assert.doesNotMatch(source, /(^|\n)\s*(import|export)\b/);
});

test("structured IPC errors preserve localizable data", () => {
  assert.deepEqual(err("err.example", { name: "Arcane" }), {
    key: "err.example",
    params: { name: "Arcane" },
  });
  assert.deepEqual(errorToIpc(new I18nError("err.prep.invalidDir", { path: "X:" })), {
    key: "err.prep.invalidDir",
    params: { path: "X:" },
  });
  assert.deepEqual(errorToIpc(Object.assign(new Error("internal detail"), {
    code: "SESSION_MODE_MISMATCH",
  })), {
    key: "err.session.modeMismatch",
    params: {},
  });
  assert.equal(errorToIpc(new Error("diagnostic only")), "diagnostic only");
});

// LLM prompts/fence explanations and ASR vocabulary are data rather than UI.
// Session/mode modules expose stable error codes; the IPC boundary maps those codes.
const EXEMPT_FILES = new Set([
  "src/main/agent-host.js",
  "src/main/voice/preset.js",
  "src/main/session-mode.js",
  "src/main/mode-host-controller.js",
]);
const CHINESE_ALLOWLIST = ["附带图片已存为本地文件"];
const SCAN_FILES = [
  "src/renderer/chat.js",
  "src/renderer/voice.js",
  "src/renderer/keycapture.js",
  "src/renderer/markdown.js",
  "src/renderer/shortcuts.js",
  "src/renderer/theme-init.js",
  "src/renderer/i18n.js",
  "src/renderer/i18n-init.js",
  "src/main/main.js",
  "src/main/providers.js",
  "src/main/provider-catalog.js",
  "src/main/i18n-error.mjs",
  "src/main/voice/asr.js",
  "src/main/voice/voice-store.js",
  "src/main/config-dir.js",
  "src/main/prep-store.js",
  "src/main/session-mode.js",
  "src/main/mode-host-controller.js",
  "src/main/permissions/display-media.js",
  "src/main/permissions/web-permission-policy.js",
  "src/main/permissions/web-permission-store.js",
  "src/main/agent-host.js",
  "src/main/voice/preset.js",
  "preload.cjs",
];

function stripComments(code) {
  return code
    .replace(/^\uFEFF/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?:^|\n)[ \t]*\/\/[^\n]*/g, "")
    .replace(/([^:'"`\w])\/\/[^\n]*/g, "$1");
}

test("scanned renderer/main string literals contain no unextracted Chinese", () => {
  const offenders = [];
  for (const rel of SCAN_FILES) {
    if (EXEMPT_FILES.has(rel)) continue;
    const code = stripComments(readFileSync(path.join(appRoot, rel), "utf8"));
    for (const match of code.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
      const literal = match[2];
      if (!/[\u4e00-\u9fff]/.test(literal)) continue;
      if (CHINESE_ALLOWLIST.some((allowed) => literal.includes(allowed))) continue;
      offenders.push(`${rel}: ${literal.slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [], "found Chinese UI text outside the shared dictionary");
});

test("intentional scan exemptions remain present", () => {
  for (const rel of EXEMPT_FILES) {
    assert.ok(readFileSync(path.join(appRoot, rel), "utf8").length > 0, `${rel} exempted but missing`);
  }
});

const KEY_REF_SOURCES = [
  "src/renderer/chat.js",
  "src/renderer/voice.js",
  "src/renderer/keycapture.js",
  "src/renderer/markdown.js",
  "src/renderer/i18n.js",
  "src/main/main.js",
  "src/main/providers.js",
  "src/main/provider-catalog.js",
  "src/main/i18n-error.mjs",
  "src/main/voice/asr.js",
  "src/main/prep-store.js",
  "src/main/agent-host.js",
];

test("literal keys passed to t()/err()/I18nError exist in both locales", () => {
  const refs = new Set();
  for (const rel of KEY_REF_SOURCES) {
    const code = stripComments(readFileSync(path.join(appRoot, rel), "utf8"));
    for (const match of code.matchAll(/\bt\(\s*"([^"]+)"/g)) refs.add(match[1]);
    for (const match of code.matchAll(/\berr\(\s*"([^"]+)"/g)) refs.add(match[1]);
    for (const match of code.matchAll(/new I18nError\(\s*"([^"]+)"/g)) refs.add(match[1]);
  }
  refs.add("sessions.unsaved");
  refs.add("agent.modelCallFailed");
  assert.ok(refs.size > 80, `expected many literal key references, found ${refs.size}`);
  for (const key of refs) {
    assert.ok(key in MESSAGES["zh-CN"], `dynamic key missing in zh-CN: ${key}`);
    assert.ok(key in MESSAGES["en-US"], `dynamic key missing in en-US: ${key}`);
  }
});

const CLASSIC_SCRIPTS = [
  "src/renderer/theme-init.js",
  "src/renderer/i18n-init.js",
  "src/renderer/i18n.js",
  "src/renderer/shortcuts.js",
  "src/renderer/keycapture.js",
  "src/renderer/markdown.js",
  "src/renderer/chat.js",
  "src/renderer/voice.js",
];

test("renderer classic scripts declare no colliding top-level names", () => {
  const owner = new Map();
  const collisions = [];
  for (const rel of CLASSIC_SCRIPTS) {
    const code = stripComments(readFileSync(path.join(appRoot, rel), "utf8"));
    const body = code.trim().replace(/^["']use strict["'];?\s*/, "").trim();
    if (body.startsWith("(")) continue;
    for (const match of code.matchAll(/^(?:const|let|var|class|function\s*\*?)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1];
      if (owner.has(name) && owner.get(name) !== rel) {
        collisions.push(`'${name}' declared top-level in both ${owner.get(name)} and ${rel}`);
      } else {
        owner.set(name, rel);
      }
    }
  }
  assert.deepEqual(collisions, [], "classic script top-level declaration collision");
});
