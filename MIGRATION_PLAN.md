# Arcane Desk OSS 迁移计划

> 本文件是迁移工作的唯一进度台账。每个 milestone 都必须写明目标、范围、验收命令、完成证据和状态；只有验收证据齐全后才能标记完成。

## 项目边界

- 本地仓库：本文件所在 Git 仓库（`.`）
- 公开项目名：`arcane-desk`
- 仓库形态：npm workspaces monorepo
- 核心依赖方向：`Foundry SDK <- CLI`，`Foundry SDK <- Desktop`
- 首次远端推送：本计划内禁止执行。完成全部发布门后先由项目所有者检查。
- 迁移输入：原私有仓库的只读工作树；它不属于本仓库，也不是安装、构建或测试依赖。

## 状态约定

- `PENDING`：尚未开始。
- `IN_PROGRESS`：正在实施。
- `BLOCKED`：存在已经记录、无法在当前范围内消除的外部阻塞。
- `COMPLETE`：验收命令通过，证据已写入本文件。

## 总体完成定义

以下条件全部成立后，仓库才达到“可以推送 GitHub，等待首次推送前检查”的状态：

1. 新 clone 只需公开仓库内容即可安装、构建和测试，不引用原私有仓库或仓库外相对路径。
2. `@arcanedesk/foundry-sdk` 是 Foundry 页面 runtime、合同、错误码和传输无关 client 的唯一源码。
3. `@arcanedesk/fvtt-cli` 通过公开 SDK 工作，不再拥有 runtime 的第二份实现。
4. Desktop 通过公开 SDK 工作，不再运行旧根仓库的 `fvtt:cdp:build`，也不再 staging CLI 产物。
5. 根目录安装、全量测试、类型检查、构建以及 npm pack smoke test 全绿。
6. Desktop 至少完成源码测试、类型检查与当前宿主平台的 unpacked/package 验收。
7. 包含开源许可证、第三方声明、贡献、安全、商标、行为准则和 CI 配置。
8. 当前工作树无秘密、无本地绝对路径、无构建产物、无未解释的大文件；Git 工作树干净。
9. 未配置会导致误推的远端，未执行 `git push`。
10. `PRE_PUSH_REVIEW.md` 汇总首次推送前需要项目所有者确认的内容。

---

## M0 — 建立干净公开仓库与进度台账

**状态：COMPLETE**

### 目标

建立不带私有仓库历史的本地 Git 仓库、workspace 骨架和本迁移台账。

### 范围

- 初始化 `main` 分支。
- 不添加远端。
- 建立 `apps/desktop`、`packages/foundry-sdk`、`packages/fvtt-cli`。
- 建立根 `package.json`、`.gitignore` 和公开 README 骨架。

### 验收命令

```powershell
git branch --show-current
git remote -v
npm pkg get workspaces
git status --short
```

### 完成证据

- `git branch --show-current` 返回 `main`。
- `git remote -v` 无输出，确认没有远端。
- `npm pkg get workspaces` 返回 `apps/*` 与 `packages/*`。
- 目录骨架、根 package、README、gitignore 与本台账均已创建。

---

## M1 — 提取 `@arcanedesk/foundry-sdk`

**状态：COMPLETE**

### 目标

把合同、页面 runtime 和传输无关 client 从旧 CLI 中提取为独立、可发布、无 Electron/CDP 运行时依赖的 SDK。

### 范围

- 建立 SDK package metadata、exports、build、test、typecheck。
- 拆分合同、runtime source、hash、错误码、调用 client。
- runtime 构建结果可重复。
- 保留写操作 dispatch 边界、串行调用、超时/取消与 `indeterminate` 语义。
- 迁移 runtime 单元测试和类型测试。
- 把 runtime 内可独立测试的纯 helper 归 SDK 所有，并用精确漂移门保证其与自包含注入 runtime 一致。

### 验收命令

```powershell
npm run build --workspace @arcanedesk/foundry-sdk
npm test --workspace @arcanedesk/foundry-sdk
npm run typecheck --workspace @arcanedesk/foundry-sdk
npm pack --workspace @arcanedesk/foundry-sdk --dry-run
```

### 完成证据

- `@arcanedesk/foundry-sdk@0.1.0` 无 runtime dependencies，公开 `.`, `./client`, `./contracts`, `./runtime`, `./runtime-helpers` 与 `./package.json` exports。
- SDK runtime 与旧 Desktop 生成产物逐字一致，SHA-256 为 `827e008b48d07962d587fd0e97d8292bc454c47437c79a6f1a82e9680ad3a8fb`。
- transport-neutral client 覆盖默认四 action allowlist、JSON 安全序列化、Foundry `/game`/ready/GM preflight、串行队列、超时/Abort 以及写操作 dispatch 后 `indeterminate` 语义。
- `npm run build --workspace @arcanedesk/foundry-sdk`、`typecheck` 均 exit 0。
- 28 个 action 有穷尽 effect metadata：11 read、17 write；所有写操作 dispatch 后中断都不可自动重试，`executeTurn` 返回 typed receipt，其余写 action 抛带稳定 code 与 `indeterminate` details 的错误。
- `npm test --workspace @arcanedesk/foundry-sdk`：32/32 通过；其中 drift gate 逐个比较 30 个 helper 的编译函数体与注入 runtime 闭包，30/30 完全一致。
- `npm pack --workspace @arcanedesk/foundry-sdk --dry-run --json`：exit 0，28 files，94,832 bytes packed，包含 package-local `LICENSE` 与 `NOTICE`。
- workspace subpath import smoke test 通过。

---

## M2 — 独立化 `@arcanedesk/fvtt-cli`

**状态：COMPLETE**

### 目标

让 CLI 成为独立 npm package，只保留 CDP transport、命令解析和 CLI 专属能力，统一消费 SDK runtime 与合同。

### 范围

- 从旧 `packages/arcane-fvtt-cli` 迁移源码和测试。
- 建立独立 package metadata、bin、build、test、typecheck。
- 删除 CLI 中重复的页面 runtime 源码。
- 确保 `dist/cli.js --help` 可运行。
- 多 Foundry tab 时 fail closed，只允许唯一候选或精确 target ID/URL/origin；所有写 action 继承 SDK 非重试中断语义。

### 验收命令

```powershell
npm run build --workspace @arcanedesk/fvtt-cli
npm test --workspace @arcanedesk/fvtt-cli
npm run typecheck --workspace @arcanedesk/fvtt-cli
node packages/fvtt-cli/dist/cli.js --help
npm pack --workspace @arcanedesk/fvtt-cli --dry-run
```

### 完成证据

- CLI package 已独立为 `@arcanedesk/fvtt-cli@0.1.0`；CDP transport、登录、截图、鼠标/UI QA 与命令解析保留在 CLI。
- `DirectAction` 合同从 `@arcanedesk/foundry-sdk/contracts` 导入并重新导出，页面 `directRuntimeFunction` 从 `@arcanedesk/foundry-sdk/runtime` 导入；CLI 不再包含页面 runtime 第二份实现。
- `npm run build` 与 `npm run typecheck` 均 exit 0；build 专用 tsconfig 排除了测试产物。
- `npm test --workspace @arcanedesk/fvtt-cli`：1 test file、232/232 tests 通过；覆盖全部写 action CDP dispatch 后的 `indeterminate`/`retry:false` 语义、读操作/dispatch 前失败的区分，以及多 tab、精确 target ID/URL/origin 与近似 URL 拒绝。
- `node packages/fvtt-cli/dist/cli.js --help`：exit 0，完整命令树可加载。
- CLI 是 bin-only package：只公开 `./package.json`；root 与 `dist/*` bare subpath import 均返回 `ERR_PACKAGE_PATH_NOT_EXPORTED`，而 `.bin/arcane-fvtt` 正常运行。
- `npm pack --workspace @arcanedesk/fvtt-cli --dry-run --json`：exit 0，24 files，54,069 bytes packed；prepack 强制 typecheck/test/build，不含编译后的测试，包含 `LICENSE` 与 `NOTICE`。

---

## M3 — Desktop 迁移并消费 SDK

**状态：COMPLETE**

### 目标

迁移 Electron Desktop，使用 SDK 提供的 runtime 与 client，消除旧仓库构建和 generated runtime 耦合。

### 范围

- 迁移产品源码、运行时 skills、prompt、测试和必要文档。
- Desktop package 改为 workspace 内依赖 SDK。
- 用 WebContents transport 接入 SDK。
- 删除对父仓库构建命令和 `generated/fvtt-runtime` staging 的依赖。
- 调整 electron-builder files 与 package verifier。
- 保留 Desktop 自己的工具 allowlist、IPC、权限和遥测边界。
- 使用 Electron `safeStorage` 保护 provider/voice API Key，并迁移旧明文配置。
- 用最小 community distribution 替换私有镜像、预制世界和内部 QA profile；默认不下载 system/module/world。
- 第三方下载、云文档解析与 macOS quarantine 修复均要求明确的用户知情同意。

### 验收命令

```powershell
npm test --workspace arcane-desktop
npm run typecheck --workspace arcane-desktop
npm run verify:source --workspace arcane-desktop
npm run dist:dir --workspace arcane-desktop
```

### 完成证据

- Desktop package 已独立为 `arcane-desktop@0.1.0`，只依赖 workspace SDK，不依赖 CLI、旧根仓库构建或 staged runtime。
- `DirectFoundryRuntime` 已缩为 `WebContentsFoundryTransport` + SDK `FoundryRuntimeClient`；SDK 负责 allowlist、序列化、preflight、排队、超时与 `indeterminate` 安全语义。
- provider 与 voice API Key 使用 Electron `safeStorage` 保护；旧明文自动迁移、磁盘只写 protected envelope、renderer 只接收掩码，OS 加密不可用时 fail closed。
- 私有 distribution 已被 `community-distribution.json` 替换：无镜像、预制世界、私有模块和默认第三方下载；可选 dnd5e 只使用固定官方上游、许可证与 SHA256，并要求用户 opt-in。
- setup/ops/module-reader 明确禁止网络响应管道执行；第三方云上传逐文档同意；macOS quarantine 仅可在验签后作为用户明确授权的故障修复。
- package-local `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 已进入 Desktop build 并由 verifier 强制检查。
- `npm run verify:source` 与 `npm run typecheck` 均 exit 0；源码 gate 在已有 ignored `dist` 时仍可重复运行。
- `npm test --workspace arcane-desktop`：186/186 通过。
- `npm run dist:dir --workspace arcane-desktop` 在 Windows 连续两次通过，固定官方 Node 22.23.2 工件 SHA256 验证成功，生成 Electron 44.0.0 unpacked candidate。
- `verify:package`：`ok=true`、`errors=[]`、36 个 required files；产物位于 ignored 的 `apps/desktop/dist/win-unpacked`。

---

## M4 — 开源治理与公开文档

**状态：COMPLETE**

### 目标

补齐公开项目所需的法律、贡献、安全、隐私和维护边界。

### 范围

- Apache-2.0 `LICENSE`。
- `NOTICE`、`AUTHORS.md`、`THIRD_PARTY_NOTICES.md`。
- `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`。
- `TRADEMARKS.md`：代码开源，Arcane Desk 名称和 Logo 保留权利。
- README 包含 unofficial Foundry VTT integration 声明与用户自备合法 Foundry 副本要求。
- 清理内部路径、凭证说明、私有发行资产和内部运维资料。

### 验收命令

```powershell
npm run verify:repo
rg --files -g 'LICENSE' -g 'NOTICE' -g 'SECURITY.md' -g 'CONTRIBUTING.md' -g 'CODE_OF_CONDUCT.md' -g 'TRADEMARKS.md'
npm run docs:check
```

### 完成证据

- 根目录包含 Apache-2.0 `LICENSE`、`NOTICE`、`AUTHORS.md`、`THIRD_PARTY_NOTICES.md`、贡献指南、安全政策、商标政策与行为准则；SDK、CLI 与 Desktop candidate 另带适用的 package-local legal files。
- `THIRD_PARTY_NOTICES.md` 与三个 workspace manifests 机械比对：15/15 个直接第三方依赖有记录。
- Foundry 非官方集成、用户自备合法副本、不得分发商业内容、Arcane 名称/Logo 保留权利等边界已写入 README、贡献、安全和商标文档。
- 当前仓库/用户绝对路径、迁移专用私有 denylist、凭据模式、私有发行资产、旧 distribution 与 legacy runtime staging 综合扫描 0 命中；denylist 本身不写入公开仓库。
- `npm run docs:check`：26 个 Markdown 文件的本地链接全部存在。
- Desktop source boundary gate 与根 repository verifier 均通过。

---

## M5 — CI、依赖治理与发布准备

**状态：COMPLETE**

### 目标

建立公开 GitHub 仓库所需的验证与发布流水线，保证 SDK、CLI 和 Desktop 构建可追溯。

### 范围

- PR CI：安装、lint/typecheck、测试、构建、pack smoke test。
- Windows/macOS Desktop 构建矩阵。
- Dependabot、CodeQL、最小 GitHub Actions permissions。
- SBOM、SHA256、artifact attestation 入口。
- Release workflow 只创建构建产物；签名和发布凭证通过 GitHub secrets 注入。
- 不包含任何真实 secret 或远端推送逻辑。

### 验收命令

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

### 完成证据

- `.github/workflows` 的 3 个 workflow 均由 actionlint 1.7.12（0 diagnostics）与 js-yaml 4.3.2 严格解析通过。
- CI 在 Linux、Windows、macOS 上执行锁定安装与根 `verify`；PR 另执行 dependency review，CodeQL 覆盖 JavaScript/TypeScript。
- release workflow 仅可手动触发，只生成短期 SDK、CLI、Windows/macOS Desktop 候选、SHA256、CycloneDX SBOM 与 GitHub provenance；不执行 npm publish、GitHub Release、git push 或外部上传。
- workflow 副作用与 secret 扫描：publish/push/Release/外部分发命令 0 命中，`${{ secrets.* }}` 0 引用；Desktop `SHA256SUMS` 只生成一次，输入与上传扩展名完全一致。
- 权限最小化：CI 仅 `contents: read`；CodeQL 另有 `security-events: write`；attestation job 仅增加 `id-token`、`attestations`、`artifact-metadata` write，无 contents/packages/actions write。
- `npm audit --omit=dev --json`：258 个 production dependencies，info/low/moderate/high/critical/total 均为 0。
- 本地 production SBOM smoke test：CycloneDX 1.5，258 components、259 dependency nodes，0 duplicate bom-ref、0 unresolved refs；仓库未留下 SBOM 产物。
- 从 SDK/CLI `dist` 不存在的状态执行 `npm run verify`：exit 0；repository、Markdown、本地绝对路径、dependency notice、typecheck、tests、build 与两个 pack dry-run 全部通过。安全收口后的最终精确计数在 M6 复验记录。

---

## M6 — 完整发布门与首次推送前检查

**状态：IN_PROGRESS**

### 目标

从干净状态证明仓库可以被推送到 GitHub，并生成所有者检查材料；不执行推送。

### 范围

- 清理并重新执行根级安装和全部 gate。
- 执行秘密、绝对路径、许可证、依赖和大文件检查。
- 检查 Git 状态、提交历史和远端状态。
- 生成 `PRE_PUSH_REVIEW.md`。
- 本地提交整理完成。

### 验收命令

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
git status --short
git log --oneline --decorate -n 20
git remote -v
```

### 完成证据

- 待填写。

---

## 进度日志

| 时间 | Milestone | 事件 | 证据/备注 |
|---|---|---|---|
| 2026-08-30 | M0 | 初始化工作开始 | 源仓库存在用户未提交改动，迁移过程保持源仓库只读。 |
| 2026-08-30 | M0 | Milestone 完成 | `main` 分支、无 remote、npm workspaces 骨架及台账验收通过。 |
| 2026-08-30 | M1 | SDK 提取开始 | 从旧 CLI 的混合 runtime 中建立公开 SDK 边界。 |
| 2026-08-30 | M1 | Milestone 完成 | build/typecheck/32 tests/pack 全绿；30 helper drift gate、28-action effect metadata 通过，runtime hash 与原 Desktop 产物一致。 |
| 2026-08-30 | M2 | CLI 独立化开始 | 迁移 CLI，删除页面 runtime 第二份实现，合同与 runtime 改由 SDK 提供。 |
| 2026-08-30 | M2 | Milestone 完成 | build/typecheck/232 tests/help/pack 全绿；SDK 成为合同/runtime/effect metadata 唯一来源，多 tab 与写中断安全门生效。 |
| 2026-08-30 | M3 | Desktop 迁移开始 | 接入 SDK WebContents transport、OS secret storage，并清理公开发行边界。 |
| 2026-08-30 | M3 | Milestone 完成 | 186 tests/typecheck/source gate/连续两次 unpacked build/package verifier 全绿；community profile 与用户同意边界生效。 |
| 2026-08-30 | M4 | 开源治理验收开始 | 核对许可证、贡献/安全/商标、第三方依赖与公开内容边界。 |
| 2026-08-30 | M4 | Milestone 完成 | 15/15 直接依赖 notice 覆盖、26 个 Markdown 链接通过、私有边界扫描 0 命中。 |
| 2026-08-30 | M5 | CI 与发布准备验收开始 | 验证 clean-clone 脚本顺序、Actions 语法、SBOM/校验和/attestation 与最小权限。 |
| 2026-08-30 | M5 | Milestone 完成 | actionlint/YAML 全绿；production audit 0 漏洞；CycloneDX SBOM 图完整；发布 workflow 无发布/推送/外部上传；无 SDK/CLI dist 的根 verify 全绿。 |
| 2026-08-30 | M6 | 完整发布门开始 | 处理最终安全审计项、生成首次推送前检查单、本地提交并在本地 clean clone 复验。 |
