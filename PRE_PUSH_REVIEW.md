# First push review

> 本文件记录首次公开源码推送的所有者检查结果。GitHub public repository 已创建并完成 `main` 推送；未创建 npm package、Desktop 安装包或 GitHub Release。

## 拟公开坐标

以下坐标已写入 package metadata，但仍需项目所有者在首次推送前确认：

- GitHub：`tanis90/arcanedesk`
- npm：`@arcanedesk/foundry-sdk`、`@arcanedesk/fvtt-cli`
- Desktop npm package：`arcane-desktop`，保持 `private: true`
- 初始版本：`0.1.0`，明确为 pre-release API
- 许可证：Apache-2.0

若 GitHub owner 或 npm scope 不是 `arcanedesk`，必须先统一修改两个公开 package 的 `name`、`repository`、README 示例和 workspace 依赖，再重新执行完整验证；不要仅修改 remote URL。

## 所有者需要逐项确认

- [x] 确认 GitHub owner/repository 为 `tanis90/arcanedesk`；同账号下既有私有 legacy repository 不属于本次操作范围。
- [x] 首次公开只推送源码，不执行 npm publish；`@arcanedesk` scope 与发布权限延后到首次 npm 发布前确认。
- [x] 项目所有者已确认私有历史中恢复的 3 个 display name 均为本人使用的署名，不存在需要另行取得许可的第三方作者；公开仓库不再保留单独的作者名册。
- [x] 确认 Apache-2.0 适用于本次迁移代码，且贡献采用 DCO sign-off，不要求 CLA。
- [x] 确认 Arcane Desk 名称、Logo 与官方产品 artwork 继续保留商标权；代码许可证不授予品牌使用权。
- [x] 确认仓库可以包含现有 Arcane Desk 品牌素材作为官方项目资产；第三方 fork 必须采用不同品牌。
- [x] 确认 Foundry VTT 仅作为独立、非官方兼容目标；仓库和候选产物不分发 Foundry 软件、许可证、商业内容或私有 world。
- [x] 确认 community distribution 默认不安装 system/module/world；可选第三方下载必须固定上游、版本、许可证和 SHA256，并由用户明确选择。
- [x] 确认 API key 使用 OS `safeStorage`，第三方文档上传逐文档征求同意，遥测默认边界与公开文档一致。
- [x] 确认代码中公开的 Arcane website、Spark gateway、telemetry endpoint 与官方 application ID 可以随源码发布：Spark 只有配置 key 后才可调用，telemetry 只有明确 consent 后才发送，相关 endpoint 均可由环境配置覆盖。
- [x] 首次公开只推送源码；签名、notarization、npm token、Desktop candidate、GitHub Release 和正式分发均属于后续受控发布流程。

## 架构与公开边界

```text
@arcanedesk/foundry-sdk
├── @arcanedesk/fvtt-cli
└── arcane-desktop
```

- SDK 是合同、页面 runtime、纯 runtime helper、错误码和传输无关 client 的唯一源码。
- CLI 只保留 CDP transport、命令行与授权 QA/维护能力；Desktop 只保留 Electron transport、产品权限、IPC 和 UI。
- SDK 默认仅开放 4 个 safe action；完整 28-action runtime registry 供显式授权的维护客户端使用。
- 当前稳定输入/输出类型覆盖 4 个 safe action；其余维护 action 暂为泛型参数/结果，README 已明确，不宣称完整 typed API。
- 页面 runtime SHA-256 固定为 `827e008b48d07962d587fd0e97d8292bc454c47437c79a6f1a82e9680ad3a8fb`；SDK drift gate 保证可测试 helper 与注入闭包逐函数一致。

## 本地发布门

最终复验完成后，本节必须同时满足：

- [x] 锁文件安装：`npm ci --workspaces --include-workspace-root`
- [x] 根 gate：repository/docs/typecheck/tests/build/pack 全绿
- [x] 测试：SDK 33、CLI 232、Desktop 202 全部通过
- [x] Desktop：当前 Windows unpacked candidate 构建与 package verifier 通过
- [x] production audit：0 vulnerabilities
- [x] CycloneDX production SBOM 可生成且依赖图无悬空引用
- [x] 3 个 GitHub workflow 通过 actionlint 与 YAML 解析
- [x] secrets、当前机器绝对路径、私有 migration denylist、大文件、嵌套 lockfile 扫描通过
- [x] SDK/CLI tarball 安装后 subpath import 与 CLI `--help` consumer smoke test 通过
- [x] 本地 clean clone 执行 `npm ci` 与 `npm run verify` 通过
- [x] 首次推送前 `git status --short` 无输出且无 remote；推送后 `main` 只跟踪精确的新 public `origin`

精确命令、结果和 milestone 状态记录在 [MIGRATION_PLAN.md](MIGRATION_PLAN.md)。

## 首次推送后、首次正式发布前仍要做

这些事项不阻塞公开源码首推，但阻塞相应正式发布：

1. 已启用 private vulnerability reporting、branch protection、required CI 与 CodeQL；首次三平台 CI 与 CodeQL 全绿。
2. 为 npm 启用 trusted publishing 或最小权限 token、2FA 和 provenance；先确认 package 名未被占用。
3. 在正式 npm/Desktop release 前增加机器生成的完整 transitive license report，并审核未知/不兼容许可证；当前人工 notice 已覆盖所有直接第三方依赖。
4. 配置 Windows signing 与 Apple Developer ID/notarization；密钥不得进入仓库。
5. 评估是否把 GitHub Actions 从官方 major tag 进一步固定到完整 commit SHA，并由 Dependabot 维护。
6. 在 1.0 前决定是否为其余 24 个 maintenance action 提供完整 typed action map。
7. 跟进 `npm ci` 当前来自 transitive build/tooling tree 的 `inflight`、旧 `rimraf`、旧 `glob`、`boolean` 与 `node-domexception` deprecation warning；当前 production audit 为 0，但应随上游可用版本持续升级。
8. 决定正式 Desktop release 的 ASAR 策略并补 package author metadata；当前 `asar: false` 使开源 app 内容可直接检查，但 electron-builder 会给出加固建议，这不是代码许可证或签名替代品。

## 已执行的首次推送

首次推送使用以下目标完成：

```shell
git remote add origin https://github.com/tanis90/arcanedesk.git
git push -u origin main
```

远端创建、坐标核对和推送结果记录在 [MIGRATION_PLAN.md](MIGRATION_PLAN.md) 的 M9；后续 push 受 `main` branch protection 和 required checks 约束。

## 最终本地提交

- 首次公开源码提交：`ffeebe76d3bd046219ed373f62ee65b3cc059044`（`chore(repo): prepare public GitHub launch`）。
- 检查材料提交：本文件所在最终 `HEAD`；用 `git log -2 --show-signature` 核对，避免在提交内嵌无法自洽的自身 hash。
- 分支：`main`
- Remote：`https://github.com/tanis90/arcanedesk.git`
- Push：已执行，仅包含 `main` 源码；无 npm、安装包或 Release
