// 统一快捷键注册表——所有全局快捷键只有一个入口,避免各处散挂 keydown。
//
// chord 语法:"F9"、"F5"、"Ctrl+Space"、"Ctrl+Shift+K"(修饰键 + 主键,
// 修饰键大小写不敏感,别名:Control/Option/Cmd)。同一动作可绑定多条 chord。
//
// 两类动作:
// - tap:{ onTap } keydown 触发一次(忽略系统 repeat)
// - hold:{ onPress, onRelease } keydown 开始、keyup 结束;窗口失焦兜底释放
//   (按住时失焦会丢 keyup,不兜底 PTT 会卡在录音态)
//
// 输入框保护:焦点在 input/textarea/select/contenteditable 时默认不触发;
// 功能键(F1-F12)与带 Ctrl/Alt/Meta 的组合放行——裸字符键劫持了就没法打字。
//
// register(id, spec) 幂等:同 id 重注册 = 换绑(设置页改键后立即生效)。
"use strict";

(function () {
  const MOD_ALIASES = {
    ctrl: "ctrl", control: "ctrl",
    shift: "shift",
    alt: "alt", option: "alt",
    meta: "meta", cmd: "meta", win: "meta",
  };

  /** "Ctrl+Shift+K" -> { code: "KeyK", ctrl: true, shift: true, alt: false, meta: false } */
  function parseChord(raw) {
    const parts = String(raw ?? "").split("+").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const mods = { ctrl: false, shift: false, alt: false, meta: false };
    for (const part of parts.slice(0, -1)) {
      const name = MOD_ALIASES[part.toLowerCase()];
      if (!name) return null; // 未知修饰键:整条 chord 作废
      mods[name] = true;
    }
    const key = parts[parts.length - 1];
    // 主键统一成 KeyboardEvent.code:单字母/数字转 KeyX/DigitX,其余(F9、Space)按原名
    const code = /^[a-zA-Z]$/.test(key)
      ? `Key${key.toUpperCase()}`
      : /^[0-9]$/.test(key)
        ? `Digit${key}`
        : key;
    return { code, ...mods };
  }

  function matches(event, chord) {
    return (
      event.code === chord.code &&
      event.ctrlKey === chord.ctrl &&
      event.shiftKey === chord.shift &&
      event.altKey === chord.alt &&
      event.metaKey === chord.meta
    );
  }

  function inEditableTarget(event) {
    const target = event.target;
    return Boolean(target?.closest?.("input, textarea, select, [contenteditable=true]"));
  }

  function allowedIn(event, chord) {
    if (!inEditableTarget(event)) return true;
    return /^F\d{1,2}$/.test(chord.code) || chord.ctrl || chord.alt || chord.meta;
  }

  const holds = new Map(); // id -> { chords, onPress, onRelease, pressedCode }
  const taps = new Map(); // id -> { chords, onTap }

  function register(id, spec) {
    unregister(id);
    const chords = (Array.isArray(spec?.chords) ? spec.chords : []).map(parseChord).filter(Boolean);
    if (chords.length === 0) return;
    if (spec.onPress || spec.onRelease) {
      holds.set(id, { chords, onPress: spec.onPress, onRelease: spec.onRelease, pressedCode: null });
    } else {
      taps.set(id, { chords, onTap: spec.onTap ?? (() => {}) });
    }
  }

  function unregister(id) {
    holds.delete(id);
    taps.delete(id);
  }

  window.addEventListener("keydown", (event) => {
    if (window.__arcaneKeyCapture) return; // 设置页正在录入键位:按键归录入框,不触发动作
    for (const hold of holds.values()) {
      const chord = hold.chords.find((c) => matches(event, c));
      if (!chord || !allowedIn(event, chord)) continue;
      event.preventDefault();
      if (event.repeat || hold.pressedCode) return; // 已按住:忽略 repeat
      hold.pressedCode = event.code;
      hold.onPress?.();
      return;
    }
    for (const tap of taps.values()) {
      const chord = tap.chords.find((c) => matches(event, c));
      if (!chord || event.repeat || !allowedIn(event, chord)) continue;
      event.preventDefault();
      tap.onTap();
      return;
    }
  });

  window.addEventListener("keyup", (event) => {
    if (window.__arcaneKeyCapture) return;
    for (const hold of holds.values()) {
      if (!hold.pressedCode || event.code !== hold.pressedCode) continue;
      hold.pressedCode = null;
      hold.onRelease?.();
    }
  });

  window.addEventListener("blur", () => {
    for (const hold of holds.values()) {
      if (!hold.pressedCode) continue;
      hold.pressedCode = null;
      hold.onRelease?.();
    }
  });

  window.ArcaneShortcuts = { register, unregister };
})();
