# Voice Input

语音输入由 renderer 录音、主进程转写两部分组成。renderer 只取得可公开的配置视图和
掩码，不接触 API Key。

```text
microphone -> renderer WAV encoder -> trusted IPC -> main-process ASR client
```

主要约束：

- 首次真正录音时才请求麦克风权限。
- 单次音频有大小与时长上限；过短或过大的输入在联网前拒绝。
- ASR 请求、鉴权和 relay 凭据解析只在主进程发生。
- Provider 与语音 Key 通过 Electron `safeStorage` 保护后持久化；旧明文 JSON 启动时迁移。
- renderer 的 Key 字段只有“保持原值/覆盖”语义，从不回显明文。
- relay 模式可以显式配置自托管 OpenAI-compatible endpoint；官方 endpoint 不是前置。

任何会把音频或文档发送给第三方云服务的新增能力，都必须在第一次发送前说明接收方和
数据范围，并取得用户明确同意。
