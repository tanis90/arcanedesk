import assert from "node:assert/strict";
import test from "node:test";

import { VOICE_PRESET, VOICE_PRESETS, voicePresetFor } from "../src/main/voice/preset.js";

const MAX_HOTWORDS = 100; // 智谱 GLM-ASR-2512 hotwords 上限,须与 voice-store 一致

test("bilingual presets stay one-to-one and within the hotword cap", () => {
  const zh = VOICE_PRESETS["zh-CN"];
  const en = VOICE_PRESETS["en-US"];
  assert.ok(zh.prompt.length > 0 && en.prompt.length > 0);
  assert.ok(zh.hotwords.length > 0);
  // 同序一一对应是翻译审校的基准:改一处必须两侧同步,长度漂移即是失配。
  assert.equal(en.hotwords.length, zh.hotwords.length);
  assert.ok(zh.hotwords.length <= MAX_HOTWORDS);
  for (const [label, words] of [["zh-CN", zh.hotwords], ["en-US", en.hotwords]]) {
    assert.deepEqual(words, [...new Set(words)], `${label} hotwords must be unique`);
    assert.ok(words.every((w) => w.trim() === w && w.length > 0), `${label} hotwords must be trimmed`);
  }
});

test("english preset carries no Chinese and zh preset stays the legacy default", () => {
  const en = VOICE_PRESETS["en-US"];
  assert.doesNotMatch(en.prompt, /[\u4e00-\u9fff]/);
  assert.ok(en.hotwords.every((w) => !/[\u4e00-\u9fff]/.test(w)));
  // VOICE_PRESET 是存量配置/调用方的锚点:必须始终指回 zh 预设,且内容逐字节稳定
  // (按 locale 播种的迁移用「存量值 === 预设值」判自定义)。
  assert.equal(VOICE_PRESET, VOICE_PRESETS["zh-CN"]);
});

test("voicePresetFor only promotes en-US; anything else falls back to zh", () => {
  assert.equal(voicePresetFor("en-US"), VOICE_PRESETS["en-US"]);
  assert.equal(voicePresetFor("zh-CN"), VOICE_PRESETS["zh-CN"]);
  assert.equal(voicePresetFor("en-GB"), VOICE_PRESETS["zh-CN"]);
  assert.equal(voicePresetFor(""), VOICE_PRESETS["zh-CN"]);
  assert.equal(voicePresetFor(undefined), VOICE_PRESETS["zh-CN"]);
});
