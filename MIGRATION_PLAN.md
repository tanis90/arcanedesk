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
- `npm pack --workspace @arcanedesk/foundry-sdk --dry-run --json`：exit 0，28 files，94,829 bytes packed，包含 package-local `LICENSE` 与 `NOTICE`；本仓库与 clean clone 的 shasum 均为 `4917b0b8375484899b118be5b52119e005424415`。
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
- `npm pack --workspace @arcanedesk/fvtt-cli --dry-run --json`：exit 0，24 files，53,954 bytes packed；prepack 强制 typecheck/test/build，不含编译后的测试，包含 `LICENSE` 与 `NOTICE`；本仓库与 clean clone 的 shasum 均为 `b725b00bfeb8c5908f309ff020021456e71b6fe7`。

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
- `NOTICE`、`THIRD_PARTY_NOTICES.md`。
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

- 根目录包含 Apache-2.0 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、贡献指南、安全政策、商标政策与行为准则；SDK、CLI 与 Desktop candidate 另带适用的 package-local legal files。
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

**状态：COMPLETE**

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
npm ci --workspaces --include-workspace-root
npm run verify
npm audit --omit=dev
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -oneline
go run github.com/zricethezav/gitleaks/v8@v8.30.1 detect --no-git --source . --no-banner --redact
npm run dist:dir --workspace arcane-desktop
node apps/desktop/scripts/verify-package.mjs apps/desktop/dist/win-unpacked/resources/app --expected-node-platform win-x64
git status --short
git log --oneline --decorate -n 20
git remote -v
```

### 完成证据

- `npm ci --workspaces --include-workspace-root`：从根 lockfile 安装 586 packages，audit 590 packages，0 vulnerabilities；5 个 transitive tooling deprecation warning 已记入首次推送检查单，不隐瞒为全静默安装。
- 最终根 `npm run verify` 与 final-HEAD 本地 clean clone 的同一命令均 exit 0：repository 153 tracked files/4 packages/15 direct third-party dependencies 无错误，27 个 Markdown 文件链接通过，SDK 32、CLI 232、Desktop 186 tests 全绿，typecheck/build 全绿。
- `pack:check` 已升级为实际消费者 gate：真实打包、在 OS 临时空项目安装、导入 SDK 5 个公开子路径、核对 28 action 的 11 read/17 write metadata、验证 CLI 深层 import 被封锁并运行安装后的 `.bin --help`；临时目录自动清除。
- 最终 LF-normalized SDK tarball：94,829 bytes，SHA-256 `69894e4606138abc4aa3181170f195630666b16d0edacfc11ef33a63b372e2a3`；CLI tarball：53,954 bytes，SHA-256 `6c4759b3b224e3f360b2e30192b766bd7d459fd7f649df79d41e262ad7236644`。npm shasum 与 clean clone 一致。
- gitleaks 8.30.1 对 107.54 MB 最终工作树扫描：`no leaks found`；迁移 denylist、凭据规则、高熵字面量、credential-like filename、大文件、嵌套 lockfile 均通过。两个 URL credential 候选是“拒绝并不回显”的负向测试夹具，不含真实 secret。
- actionlint 1.7.12：0 diagnostics；3 个 workflow YAML 解析通过；production audit 258 dependencies、0 vulnerabilities；CycloneDX 1.5 为 258 components/259 dependency nodes、0 悬空引用。
- Windows Desktop final-HEAD unpacked candidate 构建通过；package verifier `ok=true`、`errors=[]`、36 required files，release metadata 含真实 Git commit。构建输出全部处于 ignored `apps/desktop/dist`/`generated`。
- 本地 Git 采用 clean history：implementation root commit 为 `f254dd3eae7a1a715fd9d083bca9195420eb3768`，最终检查材料由其后一个 sign-off commit 记录；`main` 工作树干净，remote 为空，未执行 push。
- 原私有仓库始终作为只读迁移输入，本仓库的安装、验证、构建和候选包不引用它。

---

## M7 — Provider 凭据与网络端点安全绑定

**状态：COMPLETE**

### 目标

消除 Desktop 使用已保存 API Key 时由 renderer 单独替换 Base URL 的凭据外传路径，并保证模型拉取、正常模型调用和语音中转都只能把 Key 发送到它原本绑定的安全目标。

### 范围

- Provider Key 与 credential target（显式端点的 scheme/host/port，或无显式端点时的 API 默认目标）绑定。
- Key 与 target 一起进入 Electron `safeStorage` 加密封装；明文 `providers.json`/`voice.json` 中的 Base URL 被篡改时 fail closed。
- provider/voice 配置 schema 升级到 v3；旧明文及 pre-v3 protected raw key 自动迁移为绑定封装。
- 保存 Provider、拉取模型或修改语音中转目标时，跨 target 复用空白/打码 Key 返回 `KEY_REENTRY_REQUIRED`；显式重新输入 Key 才可换目标。
- 远程端点强制 HTTPS；HTTP 只允许精确 loopback `localhost`、`127.0.0.1`、`[::1]`。
- `/models` 请求禁止跟随 redirect；拒绝带 URL credential、query 或 fragment 的 Base URL。
- provider 设置、模型拉取、语音设置和语音上传 IPC 只接受本地 Chat 主 frame。
- Arcane Spark 聊天与语音共享 Key 时始终复用同一组已验证 Key/endpoint，不再允许语音 override 与 Spark Key 重新组合。

### 验收命令

```powershell
node --test apps/desktop/test/providers.test.mjs apps/desktop/test/provider-endpoint.test.mjs apps/desktop/test/voice-store.test.mjs
npm run typecheck --workspace arcane-desktop
npm test --workspace arcane-desktop
npm run verify
git diff --check
```

### 完成证据

- 31 个针对性安全测试全部通过，覆盖同 origin 换路径、scheme/host/port 变化、显式重输、Arcane Spark 任意地址转发、远程 HTTP、loopback HTTP、redirect 禁止、IPC sender gate 和 v2→v3 迁移。
- 明文 Provider/Voice Base URL 篡改测试证明：加密封装内的 target 不匹配时 renderer 不再看到可用 Key，ModelRuntime、模型目录请求和语音中转均拿不到该 Key。
- 借用 Arcane Spark Key 的语音路径始终使用 Spark 自己的已验证 Base URL；切换语音供应商会丢弃前一个供应商的自有 Key，不跨供应商继承。
- Desktop `typecheck` 通过，Desktop 测试由 186 增至 202，`202/202` 全绿。
- 根 `npm run verify` exit 0：repository/source/docs/typecheck 全绿，Desktop 202、SDK 33、CLI 232 tests 全绿，SDK/CLI build 与真实 pack consumer smoke test 通过。
- `git diff --check` 无错误；工作分支为 `codex/provider-credential-origin`，未配置远端、未执行 push。

---

## M8 — 版权归属确认与作者名册清理

**状态：COMPLETE**

### 目标

依据项目所有者对旧代码权属的确认，移除可能让公开项目误解为存在多名历史版权人的作者名册，同时保留 Apache-2.0 发行所需的许可证、NOTICE 与第三方声明。

### 范围

- 项目所有者确认旧作者名册中的 3 个 display name 均为本人使用的署名，自动化账号不构成人类作者，不存在需要另行取得 Apache-2.0 再许可的第三方作者。
- 删除旧作者名册文件，并清理根目录和 Desktop `NOTICE`、首次推送检查单、迁移账本及仓库校验器中的引用。
- 保留 Apache-2.0 `LICENSE`、项目 `NOTICE`、`THIRD_PARTY_NOTICES.md` 与 Git 历史；不把作者名册作为 Apache-2.0 合规前提。

### 验收命令

```powershell
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' 'AUTHOR[S]\.md|author[s]\.md' .
npm run verify:repo
npm run docs:check
npm run verify
git diff --check
```

### 完成证据

- 旧作者名册文件已删除；全仓对应文件名引用扫描 0 命中，根目录和 Desktop `NOTICE` 不再依赖单独作者文件。
- 首次推送检查单已记录所有者确认：旧名册中的 3 个 display name 均为本人署名，不存在需要另行授权的第三方作者；Apache-2.0 `LICENSE`、项目 `NOTICE` 和第三方声明均保留。
- repository verifier 与 Markdown link checker 已修复暂存前删除 tracked 文件时的 `ENOENT`，现在只读取工作树中实际存在的文件。
- `npm run verify:repo`：155 个文件、4 个 package、15 个直接第三方依赖，0 errors、0 warnings；`npm run docs:check`：26 个 Markdown 文件链接全部通过。
- 根 `npm run verify` exit 0：repository/docs/typecheck 全绿，Desktop 202、SDK 33、CLI 232 tests 全绿，SDK/CLI build 与真实 pack consumer smoke test 通过。
- `git diff --check` 无错误；未配置远端、未执行 push。

---

## M9 — 首次公开源码发布

**状态：IN PROGRESS**

### 目标

将 SDK-first monorepo 的最终验证状态首次发布到全新的 GitHub public repository，同时确保同账号下既有私有仓库不被读取、修改或用作 remote。

### 范围

- 新公开坐标固定为 `tanis90/arcanedesk`，仓库名为无连字符的小写 `arcanedesk`。
- 既有私有 legacy repository 明确排除在本 milestone 之外；本地只使用独立 OSS checkout，remote 只能指向新公开仓库。
- 保留现有 Git 提交结构、作者 `tanis` 和作者邮箱，不执行 squash 或历史重写。
- 将 SDK/CLI package repository metadata 更新为新公开坐标，npm scope 仍为 `@arcanedesk`。
- 将最终工作分支 fast-forward 到 `main`，创建全新 public repository 并只推送源码；不发布 npm、Desktop 安装包或 GitHub Release。
- 首次推送后核对仓库可见性、默认分支、remote、CI 与公开 URL。

### 验收命令

```powershell
npm run verify
go run github.com/zricethezav/gitleaks/v8@v8.30.1 git . --no-banner --redact
git diff --check
git status --short --branch
git remote get-url origin
gh repo view tanis90/arcanedesk --json nameWithOwner,visibility,url,defaultBranchRef
gh run list --repo tanis90/arcanedesk
```

### 完成证据

- 待首次公开推送和远端核验完成后填写。

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
| 2026-08-30 | M6 | Milestone 完成 | gitleaks/actionlint/audit/SBOM/consumer tarball/Desktop package/final-HEAD clean clone 全绿；两笔本地 sign-off commit、clean status、无 remote、无 push。 |
| 2026-08-30 | M6 | 推送前 review 修订 | 所有者侧 code review 后：runtime 导出收敛为 `runtimeFunction`/`runtimeHash`（移除 `directRuntimeFunction`/`runtimeSource` 别名），`verify:repo` 不再永久要求迁移文档，SDK README 记录 runtime 单一事实源退出计划；根 `npm run verify` 全绿，runtime SHA-256 `827e008b…` 不变，tarball 哈希随导出面变化。 |
| 2026-08-30 | M7 | Provider 凭据安全收口开始 | 复现已保存 Key 与 renderer 提供 Base URL 解耦的问题，并将语音中转的同类复用路径纳入同一安全边界。 |
| 2026-08-30 | M7 | Milestone 完成 | Key/target 加密绑定、HTTPS/loopback、redirect、trusted IPC 和语音成对解析全部生效；31 个针对性测试、Desktop 202 tests 与根 `npm run verify` 全绿。 |
| 2026-08-30 | M8 | 版权归属清理开始 | 项目所有者确认旧作者名册中的 3 个 display name 均为本人署名；开始移除名册及全部强制引用。 |
| 2026-08-30 | M8 | Milestone 完成 | 删除旧作者名册并清理全部引用；修复校验器对未提交删除文件的处理；全仓扫描、155-file repository gate、26-file docs gate 与根 `npm run verify` 全绿。 |
| 2026-08-30 | M9 | 首次公开源码发布开始 | 目标固定为全新 `tanis90/arcanedesk`；确认 `gh` 登录账号为 `tanis90` 且新目标尚不存在，既有私有 legacy repository 排除在操作范围外。 |
