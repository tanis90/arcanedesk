// Voice input — 两种触发:长按模式(按住快捷键/麦克风按钮说话,松开识别)和
// 免按模式(按一下快捷键开始,再按一下结束)。识别结果插入 composer 光标处
// (不自动发送,人工检查后 Enter)。快捷键由 shortcuts.js 注册表统一管理,
// 设置页用 keycapture.js 控件录入(单绑定,× 清除 = 不绑定)。
// 链路:MediaRecorder(webm/opus)→ decodeAudioData → 重采样 16kHz 单声道 →
// 手拼 16-bit PCM WAV(智谱只收 wav/mp3)→ preload.transcribeAudio。
"use strict";

const micBtn = /** @type {HTMLButtonElement} */ (document.getElementById("mic"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chat-input"));
const voiceStatus = document.getElementById("voice-status");

const MAX_RECORD_MS = 25_000; // 智谱上限 30s,留 5s 余量
const TARGET_SAMPLE_RATE = 16000;

let voiceReady = false; // 配置可用(启用 + 有 key),决定是否可以开始录音
let voiceCfg = null;
let state = "idle"; // idle | recording | transcribing
let mediaStream = null;
let recorder = null;
let chunks = [];
let recordStartAt = 0;
let autoStopTimer = null;
let tickTimer = null;
let statusClearTimer = null;

// ---------- status ----------

function setStatus(text, sticky = false) {
  voiceStatus.textContent = text;
  clearTimeout(statusClearTimer);
  // 非粘性提示(如"未识别到语音")几秒后自动清掉,不常驻占位
  if (text && !sticky && state === "idle") {
    statusClearTimer = setTimeout(() => (voiceStatus.textContent = ""), 4000);
  }
}

// ---------- config ----------

async function refreshVoiceConfig() {
  const cfg = await window.arcane.getVoiceConfig?.();
  voiceCfg = cfg;
  voiceReady = Boolean(cfg?.enabled && cfg?.hasKey);
  const holdKey = cfg?.holdKey ?? "F9";
  const toggleKey = cfg?.toggleKey ?? "";
  bindShortcuts(voiceReady ? holdKey : "", voiceReady ? toggleKey : "");
  micBtn.disabled = false;
  micBtn.classList.toggle("voice-unavailable", !voiceReady);
  micBtn.title = voiceReady
    ? (holdKey ? window.ArcaneI18n.t("composer.mic.titleWithKey", { key: holdKey }) : window.ArcaneI18n.t("composer.mic.title"))
    : voiceSetupMessage();
}

function voiceSetupMessage() {
  if (!voiceCfg?.enabled) return window.ArcaneI18n.t("voice.status.off");
  return window.ArcaneI18n.t(
    voiceCfg.provider === "zhipu" ? "voice.status.needsZhipuKey" : "voice.status.needsSparkKey",
  );
}

function guideVoiceSetup() {
  const message = voiceSetupMessage();
  setStatus(message);
  if (voiceCfg?.enabled && voiceCfg.provider === "arcane-relay") {
    window.__arcaneOpenProviderSettings?.("arcane-spark");
  } else {
    window.__arcaneOpenVoiceSettings?.(voiceCfg?.enabled ? "apikey" : "mode");
  }
}

/** 快捷键走统一注册表(shortcuts.js):chords 空数组 = 解绑(register 内已先 unregister)。 */
function bindShortcuts(holdKey, toggleKey) {
  window.ArcaneShortcuts?.register("voice.ptt", {
    chords: holdKey ? [holdKey] : [],
    onPress: startRecording,
    onRelease: stopAndTranscribe,
  });
  window.ArcaneShortcuts?.register("voice.toggle", {
    chords: toggleKey ? [toggleKey] : [],
    onTap: toggleRecording,
  });
}

/** 免按模式:录音中→停止识别;空闲→开始录音。不受窗口 blur 兜底影响。 */
function toggleRecording() {
  if (state === "recording") stopAndTranscribe();
  else if (state === "idle") startRecording();
}

// ---------- WAV 编码 ----------

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** 线性插值重采样(voice-ime 实测 16kHz 是智谱推荐采样率)。 */
function downsample(input, fromRate) {
  if (fromRate === TARGET_SAMPLE_RATE) return input;
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const next = Math.min(idx + 1, input.length - 1);
    out[i] = input[idx] + (input[next] - input[idx]) * (pos - idx);
  }
  return out;
}

function encodeWav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

async function blobToWav(blob) {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    return encodeWav(downsample(decoded.getChannelData(0), decoded.sampleRate));
  } finally {
    ctx.close();
  }
}

// ---------- push-to-talk 状态机 ----------

async function startRecording() {
  if (state !== "idle") return;
  if (!voiceReady) {
    guideVoiceSetup();
    return;
  }
  // macOS 首次录音需系统级授权(其他平台 IPC 恒 ok)
  const mic = await window.arcane.ensureMicAccess?.();
  if (mic && !mic.ok) {
    setStatus(window.ArcaneI18n.fmtIpc(mic.error), true);
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (error) {
    setStatus(window.ArcaneI18n.t("voice.status.micUnavailable", { error: error.message }));
    return;
  }
  chunks = [];
  recorder = new MediaRecorder(mediaStream);
  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };
  recorder.start(250);
  state = "recording";
  recordStartAt = Date.now();
  micBtn.classList.add("recording");
  setStatus(window.ArcaneI18n.t("voice.status.recording", { secs: 0 }));
  tickTimer = setInterval(() => {
    setStatus(window.ArcaneI18n.t("voice.status.recording", { secs: Math.floor((Date.now() - recordStartAt) / 1000) }), true);
  }, 1000);
  autoStopTimer = setTimeout(() => {
    stopAndTranscribe();
    setStatus(window.ArcaneI18n.t("voice.status.autoStop", { secs: MAX_RECORD_MS / 1000 }), false);
  }, MAX_RECORD_MS);
}

async function stopAndTranscribe() {
  if (state !== "recording") return;
  state = "transcribing";
  clearTimeout(autoStopTimer);
  clearInterval(tickTimer);
  const blob = await new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
    recorder.stop();
  });
  mediaStream.getTracks().forEach((track) => track.stop());
  micBtn.classList.remove("recording");

  // 过短的录音(误触)直接丢弃,不打搅 ASR
  const elapsed = Date.now() - recordStartAt;
  if (elapsed < 500 || blob.size < 2000) {
    state = "idle";
    setStatus(window.ArcaneI18n.t("voice.status.tooShort"));
    return;
  }

  setStatus(window.ArcaneI18n.t("voice.status.transcribing"), true);
  try {
    const wav = await blobToWav(blob);
    const result = await window.arcane.transcribeAudio(wav);
    state = "idle";
    if (result?.ok && result.text) {
      insertToComposer(result.text);
      setStatus("");
    } else if (result?.ok) {
      setStatus(window.ArcaneI18n.t("voice.status.noSpeech"));
    } else {
      setStatus(window.ArcaneI18n.t("voice.status.failed", { error: window.ArcaneI18n.fmtIpc(result?.error) }), true);
    }
  } catch (error) {
    state = "idle";
    setStatus(window.ArcaneI18n.t("voice.status.failed", { error: error.message }), true);
  }
}

/** 插入 composer 光标处;input 事件让 chat.js 的 autosize 生效。 */
function insertToComposer(text) {
  const start = chatInput.selectionStart ?? chatInput.value.length;
  const end = chatInput.selectionEnd ?? start;
  chatInput.value = chatInput.value.slice(0, start) + text + chatInput.value.slice(end);
  const caret = start + text.length;
  chatInput.setSelectionRange(caret, caret);
  chatInput.dispatchEvent(new Event("input"));
  chatInput.focus();
}

// ---------- 触发:按钮按住 + 快捷键(shortcuts.js 注册表,见 bindShortcuts) ----------

micBtn.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  startRecording();
});
// 键盘触发 button 时没有 pointerdown;只处理 detail=0,避免鼠标点击重复打开设置。
micBtn.addEventListener("click", (event) => {
  if (!voiceReady && event.detail === 0) guideVoiceSetup();
});
micBtn.addEventListener("pointerup", stopAndTranscribe);
micBtn.addEventListener("pointerleave", stopAndTranscribe);

refreshVoiceConfig();
// chat.js 保存语音设置后调用,刷新麦克风可用态
window.__arcaneRefreshVoice = refreshVoiceConfig;
