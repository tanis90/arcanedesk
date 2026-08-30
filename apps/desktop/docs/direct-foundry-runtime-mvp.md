# Direct Foundry Runtime

Arcane Desktop 在自己持有的 Foundry `WebContentsView` 中调用固定、版本化的
`@arcanedesk/foundry-sdk` runtime。Desktop 不启动 CLI 子进程，也不接受模型提供的
runtime 源码。

```text
AgentHost structured tool
  -> DirectFoundryRuntime (thin product wrapper)
  -> WebContentsFoundryTransport
  -> FoundryRuntimeClient from @arcanedesk/foundry-sdk
  -> controlled Foundry /game page
```

SDK 负责 action 合同、参数 JSON 序列化、页面 preflight、超时、串行队列和写操作的
`indeterminate` 语义。Desktop 只负责：

- 获取当前 `WebContents`；
- 使用已有的导航安全 inspect/evaluate；
- 选择产品允许的工具；
- 把不含参数或结果内容的状态交给可选遥测。

战斗模式允许的固定 action 是 `worldInfo`、`battleContext`、`turnContext` 与
`executeTurn`。页面必须位于 `/game`、`game.ready`，且当前用户是 GM。

`executeTurn` 一旦跨过 evaluate dispatch 边界，导航、中止、超时或 renderer 错误都返回
`indeterminate`、`retry: false`。调用者必须重新读取上下文并让 DM 决定下一步，不能自动重放。

验收至少覆盖：

1. Desktop wrapper 只包含 transport 适配，不复制 SDK client 或 runtime 实现。
2. 参数只能作为 JSON 数据进入固定表达式。
3. 所有调用串行；失败不会污染后续队列。
4. 读操作中断返回稳定 `FOUNDRY_SDK_*` 错误码。
5. 写操作中断返回不可重试的四态回执。
