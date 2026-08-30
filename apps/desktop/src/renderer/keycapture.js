// 键位捕获控件:点击按钮进入录入态,按下组合键即录入,Esc 取消,× 清除。
// 注意:按钮不要包在 <label> 里——label 的激活行为会向控件补发一次合成 click
// (target=按钮),stopPropagation 也拦不住,× 清除会误触录入态。
// 产出/消费的 chord 字符串与 shortcuts.js 的 parseChord 兼容:
// "F9"、"Ctrl+Space"、修饰键组合 "Ctrl+Meta+MetaLeft"(显示为"Ctrl + 左 Win")。
"use strict";

(function () {
  const t = window.ArcaneI18n.t;
  // mac 上 Meta = Cmd,Windows 上 = Win;Alt 在 mac 上的俗名是 Option
  const IS_MAC = navigator.userAgentData?.platform === "macOS" || /^Mac/.test(navigator.platform ?? "");
  const MODCODES = {
    ControlLeft: "ctrl", ControlRight: "ctrl",
    ShiftLeft: "shift", ShiftRight: "shift",
    AltLeft: "alt", AltRight: "alt",
    MetaLeft: "meta", MetaRight: "meta",
  };
  // 与 shortcuts.js 的修饰键别名一致(chord 可能来自手改的配置文件)
  const MOD_ALIASES = {
    ctrl: "ctrl", control: "ctrl",
    shift: "shift",
    alt: "alt", option: "alt",
    meta: "meta", cmd: "meta", win: "meta",
  };
  const MOD_DISPLAY = { Ctrl: "Ctrl", Alt: IS_MAC ? "Opt" : "Alt", Shift: "Shift", Meta: IS_MAC ? "Cmd" : "Win" };
  // 带左右位的修饰键主键:显示名走字典(kc.left = "左 Ctrl" / "Left Ctrl")
  const SIDE_KEY_DISPLAY = {
    ControlLeft: "Ctrl", ControlRight: "Ctrl",
    ShiftLeft: "Shift", ShiftRight: "Shift",
    AltLeft: "Alt", AltRight: "Alt",
    MetaLeft: IS_MAC ? "Cmd" : "Win", MetaRight: IS_MAC ? "Cmd" : "Win",
  };

  /** 主键存储 token:单字母/数字存字符,其余存 KeyboardEvent.code。 */
  function keyToken(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    return code;
  }

  function friendlyKey(token) {
    if (SIDE_KEY_DISPLAY[token]) {
      // 左右位信息保留:ControlLeft/ControlRight 决定前缀
      return t(token.endsWith("Right") ? "kc.right" : "kc.left", { key: SIDE_KEY_DISPLAY[token] });
    }
    return token; // F9 / M / 3 / Space 等
  }

  /** "Ctrl+Meta+MetaLeft" -> "左 Win + Ctrl";"Ctrl+Space" -> "Ctrl + Space"。
   * 主键是修饰键时主键排前(读法贴近按键动作:"左 Ctrl + 左 Win"),其余修饰随后。 */
  function chordToDisplay(chord) {
    if (!chord) return "";
    const parts = chord.split("+");
    const main = parts[parts.length - 1];
    const mainMod = MODCODES[main] ?? null;
    // 主键是修饰键时,其自身修饰位不重复显示(在原始 token 上比对,不吃显示名的平台差异)
    const rawMods = parts
      .slice(0, -1)
      .filter((m) => (MOD_ALIASES[m.toLowerCase()] ?? m.toLowerCase()) !== mainMod);
    const mods = rawMods.map((m) => MOD_DISPLAY[m] ?? m);
    if (mainMod) return [friendlyKey(main), ...mods].join(" + ");
    return [...mods, friendlyKey(main)].join(" + ");
  }

  /**
   * attachKeyCapture(button, { get, set })
   * get() 返回当前 chord 字符串,set(chord) 写入(空串 = 清除绑定)。
   * 保存与否由调用方决定(本控件只改待存值)。
   */
  function attachKeyCapture(button, { get, set }) {
    let capturing = false;

    function render() {
      const value = get();
      button.classList.toggle("capturing", capturing);
      button.classList.toggle("empty", !value && !capturing);
      button.textContent = "";
      if (capturing) {
        button.textContent = t("kc.capturing");
        return;
      }
      if (!value) {
        button.textContent = t("kc.set");
        return;
      }
      const chip = document.createElement("span");
      chip.className = "kc-chip";
      chip.textContent = chordToDisplay(value);
      const clear = document.createElement("span");
      clear.className = "kc-clear";
      clear.textContent = "×";
      clear.title = t("kc.clear");
      clear.addEventListener("click", (event) => {
        event.stopPropagation();
        set("");
        render();
      });
      button.append(chip, clear);
    }

    button.addEventListener("click", (event) => {
      if (event.target.closest(".kc-clear")) return; // × 的点击不进入录入态
      capturing = true;
      window.__arcaneKeyCapture = true; // 让 shortcuts.js 的动作暂不响应
      render();
    });

    button.addEventListener("keydown", (event) => {
      if (!capturing) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") {
        capturing = false;
        window.__arcaneKeyCapture = false;
        render();
        return;
      }
      if (event.repeat) return;
      const mainMod = MODCODES[event.code] ?? null;
      const mods = [];
      if (event.ctrlKey) mods.push("Ctrl");
      if (event.altKey) mods.push("Alt");
      if (event.shiftKey) mods.push("Shift");
      if (event.metaKey) mods.push("Meta");
      // 只按了一个修饰键:不收尾,等第二个键(支持"左 Ctrl+左 Win"这类纯修饰组合)
      if (mainMod && mods.length === 1) return;
      // 主键是修饰键时其自身修饰位已在 mods 里(parseChord 匹配时需要)
      set([...mods, keyToken(event.code)].join("+"));
      capturing = false;
      window.__arcaneKeyCapture = false;
      render();
    });

    button.addEventListener("blur", () => {
      if (!capturing) return;
      capturing = false;
      window.__arcaneKeyCapture = false;
      render();
    });

    render();
    return { render };
  }

  window.ArcaneKeyCapture = { attach: attachKeyCapture, display: chordToDisplay };
})();
