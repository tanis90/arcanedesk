# ArcaneDesk 国际化技术方案

状态：M0 / M1 / M2 已完成 · M3 / M4 代码完成（本地提交，未 push）· 日期：2026-09-11 · 分支：docs/internationalization-plan

**2026-09-10 决策记录（拍板）：**

- M0 已完成：R2 桶 `arcane-desk-intl` + 自定义域 `dl.arcanedesk.app`、D1 库
  `arcane-desk-intl`、Workers Paid、R2 S3 密钥对、CF API Token，GitHub Secrets
  （仓库级 + `desktop-release` environment）均已就位。
- LLM 上游改 **DeepSeek 海外站**（不再用 OpenRouter，见 D3 修订）；海外 LLM 整体
  暂缓，首发 BYOK，M5 推迟。
- arcane-agent-bridge **弃用不开源**：桌面端已切换 DirectFoundryRuntime
  （main.js 直注 Foundry 页，测试断言不再引用该模块），旧 loopback 桥为残留架构。
- intl 自动化内容口径**已拍板接受降级**：国际版 = arcane-spells-2014（SRD 5.1，
  167 法术 + 20 戏法配方，不含任何全文/描述/美术/怪物数据，对用户自备内容施加
  自动化）；完整 Auto 2014 不出海。对外文案不得宣称"完整 2014 自动化"。

本文是国际化的总战略文档：现状结论、设计决策、里程碑（M0–M8）、人员任务清单、
拓扑排序与并发方案。涉及四个仓库：

| 仓库 | 职责 |
|---|---|
| `Arcane-Desk`（本仓库） | Desktop 应用、mod 引擎与技能包、发布流水线、国际索引生成 |
| `arcanedesk-ops`（private） | 遥测 Worker、LLM 网关 Worker、发 key CLI、签名 runbook、基础设施记录 |
| `arcanedesk-web`（private） | 官网前端与发布流水线（/en/ 清理、下载链接、合规页面） |
| `tanis90/arcanedesk-fvtt-mods`（public） | 自有合规模块真源，需补 arcane-agent-bridge 与 release 自动化 |

---

## 1. 现状结论（调研基线）

### 1.1 发布与下载

- 唯一发布目标是阿里云 OSS 北京桶 `arcane-package`（`apps/desktop/scripts/publish-release.mjs`），
  GitHub Releases 仅为可选次要渠道。无 S3/R2/CDN。
- App 没有自动更新器（无 electron-updater/autoUpdater），用户手动下载安装包。
- 唯一自更新组件是技能包，拉取地址硬编码 OSS 北京
  （`apps/desktop/src/main/skills-updater.mjs:33`）。
- Windows 签名走本机补签（ops 仓库 `.codex/skills/arcanedesk-windows-signing/`，
  SimplySign + signtool），当前是"先发布、后覆盖"的 immutable 例外流程；
  mac 签名 + 公证已在 CI 内完成。

### 1.2 Mod 系统

- 引擎是 `apps/desktop/skills/prep/arcane-fvtt-mods/scripts/mod-manager.mjs`（CLI，由 LLM
  agent 按 SKILL.md 驱动），随技能包通道远程下发。
- 镜像索引 `MIRROR_INDEX_URL` 硬编码在该文件第 15 行，无 CLI 参数、无环境变量可切换。
- 镜像不是运行时代理，而是"重新打包 + 改写 manifest 后托管 OSS"；索引 38 包按 group 分类：
  `arcane`（7，自有）/ `core` `fx` `ui`（代理第三方）/ `zh`（汉化）/ `system`（dnd5e）。
- 不在索引内的包会走"风险提示 + `--accept-sha256`"裸流程——国际版不能只关镜像，
  必须提供国际索引。
- Foundry 本体与 Node 运行时不分发，用户经官方渠道获取，全球可用，无需改动。

### 1.3 i18n 与中国化硬编码

- UI 已双语（自研 zh-CN/en-US，`src/shared/i18n/messages.js`），设置内可切换。
- 未国际化的部分：LLM 系统提示词（`system-prompts/prep.md`、`combat.md` 纯中文 +
  运行时语言指令补丁）、语音 ASR（智谱 + 中文热词预设，`voice/asr.js`、`voice/preset.js`）、
  provider 目录（20 家几乎全国内厂商）、硬编码 `.cn` 端点
  （`main.js:51` 官网、`providers.js:21` LLM 代理、`telemetry-client.js:27` 遥测）。
- 现有 `ARCANE_*` 环境变量覆盖机制保留为最高优先级覆盖层。

### 1.4 国内后端（ops 仓库）

- 遥测：Go 服务 arcane-api（4 条信封契约 + 违禁 key 递归扫描 + Bearer=installation_id
  鉴权）→ OSS 原始 NDJSON → 离线 DuckDB 分析；30 天生命周期；自助删除端点。
- LLM：NewAPI 中转站（DeepSeek 官方上游，`model_mapping` 别名 `arcane-spark`，双闸门配额），
  `arcane-key` CLI 手工发 key（SSH + SQLite 登记 + 全文只显示一次）。
- ops 仓库中不存在任何 `arcanedesk.app` / Cloudflare 引用——海外后端是全新绿地。

---

## 2. 关键设计决策

### D1：Region 单一事实来源（一套代码海内海外自然分开）

构建期从 `ARCANE_BUILD_REGION`（默认 `cn`）生成 `generated/region.json` 打进包内；
运行期由 `src/main/region.mjs` 读取并导出默认值表，业务代码禁止出现 `if (region)`。
优先级：环境变量 > region 默认值。

| 配置项 | cn（默认） | intl |
|---|---|---|
| websiteUrl | arcanedesk.bitterbebop.cn | arcanedesk.app/en |
| telemetryEndpoint | api.arcanedesk.bitterbebop.cn | api.arcanedesk.app |
| sparkBaseUrl | llm.arcanedesk.bitterbebop.cn | llm.arcanedesk.app |
| skillsUpdateBaseUrl | OSS 北京 | R2 `dl.arcanedesk.app`（intl 前缀） |
| modIndexUrl | OSS `index.json` | R2 `index-en.json` |
| provider 目录排序 | 国内厂商在前 | OpenAI/Anthropic/OpenRouter/Google 在前 |
| ASR 默认 | 智谱 + 中文热词 | OpenAI 兼容转写 + 英文 D&D 热词 |
| 社区/支持链接 | 微信/小红书 | Discord/GitHub Issues |

选构建期 flavor 而非运行时切换：确定性、离线可用、合规干净（intl 包默认值即海外端点，
不存在"海外数据先碰国内端点"的窗口）。代价是 CI 矩阵 ×2，可接受。

### D2：下载与静态分发上 Cloudflare R2

R2 + 自定义域 `dl.arcanedesk.app`：零出口流量费（对比 OSS 国际流量或 AWS CloudFront
约 $0.09/GB），S3 兼容 API 可直接接入现有发布脚本。需要搬运的三类对象：
安装包 + latest 指针、技能包（intl 独立前缀隔离）、国际 mod 索引。

### D3：LLM 上游改 DeepSeek 海外站，NewAPI 不出海（2026-09-10 修订）

- 原方案选 OpenRouter（ provisioning API 发子 key），已拍板改为 **DeepSeek 海外站**
  （api.deepseek.com，模型 `deepseek-flash` / `deepseek-v4-pro`，已充值并实测连通）。
- DeepSeek 海外站**没有 sub-key provisioning API**，M5 的配额执行完全落在
  D1 配额表 + Worker 内记账，不再有两层兜底。
- 国内 NewAPI 的四项职责在海外版的落点：双闸门配额 → D1 配额表；
  模型别名 → Worker 内改写 `arcane-spark` → `deepseek-flash`；定价 → DeepSeek 账单；
  生命周期 → D1 登记 + 禁用/轮换。
- **M5 整体暂缓**：首发 BYOK（零后端），Spark-intl 在需要发试用 key 验证付费意愿时再启动。

### D4：订阅三段式，首发不做订阅

1. BYOK 为主（零后端）；
2. Spark 海外试用 key 手工发放（沿袭 `arcane-key` 模式，渠道换 Discord/邮件）；
3. 有收入信号后接 Paddle/Lemon Squeezy（Merchant of Record，自动处理欧盟 VAT），
   key 格式与配额语义向前兼容。

### D5：签名改为"先签后发"

CI 出未签名 EXE → 本机一次签完两个 flavor → 验签 + 重建校验和 → 双写 OSS/R2。
恢复 immutable 契约，消除两个存储间的不一致窗口。Certum/SimplySign 证书海外有效，不换。

### D6：遥测同构移植

Worker 复刻 arcane-api 的 4 条信封契约 + 违禁 key 扫描 → 写 R2（90 天生命周期）→
DuckDB + httpfs 直读 R2 分析（与国内 OSS 分析只差 endpoint 配置）；
Workers Analytics Engine 做实时仪表盘（注意只保留 3 个月，另设月度 rollup Cron）；
复刻自助删除端点满足 GDPR。

---

## 3. Mod 覆盖检查（38 包处置表）

基于线上 `index.json`（generated 2026-09-04）逐一处置：

| 组 | 包 | 国际处置 |
|---|---|---|
| arcane | arcane-common-display-vision、arcane-dice-so-nice-dnd5e-fix | 已开源，指 GitHub manifest |
| arcane | arcane-agent-bridge | **弃用，不开源**（2026-09-10 拍板：桌面端已切换 DirectFoundryRuntime，该模块为旧 loopback 桥残留；国内镜像暂留 0.1.0 供存量，intl 索引剔除） |
| arcane | arcane-dnd5e-2014-automation（0.3.19/0.4.1/0.4.2） | 不出海，替换为 arcane-spells-2014（SRD 5.1，167 法术） |
| arcane | zzzz_arcane_dnd5e_cn | 剔除（中文专属） |
| core ×12 | midi-qol、dae、times-up、socketlib、lib-wrapper、itemacro、ActiveAuras、ATL、auraeffects、dfreds-convenient-effects、lib-dfreds-migrations、lib-dfreds-ui-extender | 上游原始路径（Foundry 官方注册表/GitHub） |
| fx | autoanimations、dice-so-nice、sequencer、dnd5e-animations | 上游 |
| fx | JB2A_DnD5e（1.6GB） | 上游免费版；索引只许出现免费版，脚本核对 manifest 来源 |
| system | dnd5e 5.3.3 | Foundry 官方源 |
| ui | tidy5e-sheet、token-action-hud-core/dnd5e、monks-common-display、combat-tracker-dock、color-picker、colorsettings、tidy-ui_game-settings、foundryvtt-actor-studio | 上游（生成脚本验证钉版在架） |
| zh ×4 | 5e_chn、babele、foundry_chn、zzz_mod_chn | 剔除 |
| worlds | arcane-demo 0.1.2 + arcane-demo-full profile | 内容审计（是否含 2014 全文本产物），profile 清单按本表替换 |

净结论：31 个直接上游、2 个自有已开源、1 个弃用剔除（agent-bridge）、1 个替换、5 个剔除、1 组待审计。

注意：镜像是重新打包的，字节与上游不同，**国际索引的 bytes/sha256 必须对上游 zip 实测**，
不能复用镜像哈希。版本钉与国内镜像保持一致，保证海内海外跑同一套验证过的组合。

---

## 4. 里程碑

### M0：账号与基础设施就绪（阻塞一切，见 §5）

R2 桶、D1 库、CF API token、DeepSeek 海外站 key、Discord、waitlist 工具、GitHub Secrets。

### M1：Region 真源（本仓库，S，必须第一个做）

- `apps/desktop/scripts/prepare-desktop-release.mjs`：构建期生成 `generated/region.json`
- 新增 `apps/desktop/src/main/region.mjs`：默认值表（见 D1）
- `main.js:50-51`、`providers.js:21`、`telemetry-client.js:27`、`main.js:670` 四处改读 region
- `main.js` 埋设 `process.env.ARCANE_MOD_INDEX_URL`（M3 接线点）
- renderer 经 IPC 拿 websiteUrl/社区链接；`test/` 加 region 快照测试
- 验收：`ARCANE_REGION=intl npm start` 全部默认值指向 `.app` 域名；`verify:source` 通过

### M2：发布双轨（本仓库 + ops，M）— ✅ 代码与配置完成（2026-09-10，`fad803a`）

- ✅ `publish-release.mjs`：`--region cn|intl`（默认读 `generated/region.json`，冲突即报错）；
  intl 走 R2 `arcane-desk-intl`（内置最小 SigV4 S3 客户端，零新依赖），`--signed-dir`
  先签后发（缺 staged `.exe` 签名件即失败）
- ✅ electron-builder artifactName 经 `${env.ARCANE_ARTIFACT_SUFFIX}` 宏加 `-intl` 后缀，
  新增 `scripts/dist.mjs` 包装器按 region.json 注入；intl 默认 releaseId 带 `-intl` 后缀
- ✅ release workflow：build 矩阵 4 平台 × 2 region 共 8 腿，verify 冒烟断言包内
  region.json（`--expected-region`），publish 拆 cn/intl 两路、GitHub Release 分 tag
- ✅ ops 签名 runbook 改先签后发（覆盖补签降级为应急，`b3547a3`）；
  ✅ R2 `dl.arcanedesk.app` CORS 已配（GET/HEAD、Origin `*`）
- ⏳ 验收待触发：一次完整发版，两 flavor 各落其位，`dl.arcanedesk.app/.../latest.json`
  公开可读（需用户 dispatch 一次 release workflow）

### M3：Mod 链路（本仓库 + mods 仓库，M）— ✅ 代码完成（2026-09-11）

- ✅ `mod-manager.mjs`：`--index-url` 参数 + `ARCANE_MOD_INDEX_URL` 环境变量
  （参数名与语义在 M1 规格中钉死），六个索引消费命令全部接线；14/14 测试
- ✅ `scripts/prepare-intl-index.mjs`：策展清单（`distribution/intl-mod-curation.json`）→
  上游实测哈希 → `index-en.json`，哈希漂移报警（同版本 URL/哈希变化即失败，版本升级放行）
  + 依赖闭包强制校验（缺谁报谁，不自动追加）；10/10 测试
- ✅ 周更 cron workflow `arcane-intl-mod-index.yml`（每周一 03:23 UTC + dispatch，
  `desktop-release` environment，publish-plan 留 artifact 审计 90 天）
- **重要发现（F13/F14 断层）**：上游 latest 已全部转向 Foundry V14（dnd5e 6.0.0 要求
  ≥14.367、midi-qol 14.x、dae 14.x），与 Arcane 钉的 13.351 不兼容。策展按 F13 兼容线钉版：
  - midi-qol / dae 走 tposney `v13` 大版本分支（自指 URL 稳定，实测 13.0.65 / 13.0.29）
  - socketlib / lib-wrapper 的 latest 仍兼容 F13，保持跟踪（v1.1.4 / 1.13.5.1）
  - dnd5e 5.3.3（F13 末版）自指 URL 指向 master 可变分支，直连不可能 → 新增**镜像模式**
    （策展条目 `mirror: true`）：改写 manifest/download 为 R2 版本化 URL
    （`mods/packages/<id>/<version>/`）随索引发布；周更幂等（已存在且一致跳过，
    不一致即不可变漂移报警）
- arcane-demo 世界审计结论：世界内容 **0 中文字符**，英文可直接复用；但 intl 版
  world/profile **暂缓**——cn profile 26 个模块含 5 个中文本地化模块（intl 剔除）、
  2 个 arcane 自有模块（依赖 mods 仓库 release workflow，人工任务 #8）、十余个待扩充
  策展的上游模块；世界包工件也需镜像到 R2。待自有 mod GitHub 发布线就绪后一并做
- ⏳ 验收待触发：push 后 dispatch `arcane-intl-mod-index.yml` 完成首次发布，
  再在 intl 构建里由 agent 装 midi-qol（上游下载 + 索引哈希校验）

### M4：技能包区域化（本仓库，M，依赖 M3 的 CLI 定稿）— ✅ 代码完成（2026-09-11，`6aa588f`，分支 feat/intl-m4-skill-packs）

- ✅ 设计定稿：**脚本单源 + 散文覆盖**。cn 树 `skills/prep` 不动；intl 覆盖树
  `skills/prep-intl` 只放翻译散文 + 自己的 `bundle.json`（独立 revision 计数）。
  intl 基线由 `scripts/compose-intl-skills.mjs` 组合产出，四道 fail-closed 门禁：
  ①intl 不得有游离文件 ②intl 散文零 CJK ③cn 原创散文 100% 有译文 ④合法 bundle.json
- ✅ 翻译完成：12 个 cn 原创散文（5 个 SKILL.md + 7 个 references）原生英文版 +
  `system-prompts-intl/prep.md`、`combat.md`（vendored node_modules README 豁免；
  combat 的中文小队称呼表按 intl 场景改写为通用昵称映射规则）
- ✅ `publish-skills.mjs --region cn|intl`：intl 先组合再发 R2 独立前缀
  `desktop/arcane-desk-intl/skills/`（publish-release TARGETS 增加 `skillsRoot`）；
  cn 行为不变
- ✅ 运行期接线：region.mjs 默认值表新增 `bundledSkillsDir` / `systemPromptsDir`，
  main.js / agent-host.js 改读 region 配置；intl 构建由 prepare-desktop-release.mjs
  组合 `generated/skills-intl/prep` 并复制 `generated/system-prompts-intl`（过 CJK 门禁），
  cn 构建清理陈旧 intl 基线；双树随包（接受约 3.4MB 冗余）
- ✅ `check-skills-revision.mjs` 双树：prep 与 prep-intl 各自强制 bump 单调 revision；
  skills/AGENTS.md 补充覆盖树约定；verify-source 注册组合器；全量测试 431/431，
  tsc 干净，intl 构建冒烟通过（`0.4.3-8b6ef79a-intl`）
- ⏳ 验收待触发：push 后 dispatch release workflow 出 intl 包 + 首次
  `publish-skills --region intl`（远端无指针按 r0 放行），验证 intl 构建自更新到
  英文技能包、英文 agent 全流程无中文渗漏

### M5：LLM 网关 Spark-intl（ops 新服务，L，全新代码）— **暂缓**

- `services/arcane-spark-edge/` Worker：key 校验（D1）→ 别名改写 `arcane-spark` →
  `deepseek-flash` → 转发 DeepSeek 海外站 → 按 usage 扣 D1 额度；流式透传
- `tools/arcane-key-intl/` CLI：生成 Spark key + D1 登记 + 手工发放纪律
  （DeepSeek 无 provisioning API，上游额度不在 key 层兜底）
- 主仓库 `provider-catalog.json` intl 排序；`voice/asr.js`/`preset.js` intl 默认
- 验收：intl 构建填 Spark-intl key 跑通 prep 会话；BYOK 目录前三位海外厂商

### M6：遥测海外通道（ops 新服务，M）

- `services/arcane-telemetry-edge/` Worker：复刻信封契约 + 违禁 key 扫描 + 删除端点，写 R2
- WAE 聚合 + 月度 rollup Cron + R2 lifecycle 90 天；DuckDB 脚本加 R2 endpoint
- 验收：上报可见、可查、可删；隐私政策文案与设计一致

### M7：网站与合规（arcanedesk-web，S-M）

/en/ 去微信/小红书（换 email waitlist + Discord）；下载改指 R2 + 分平台直链；
Privacy Policy / ToS 页；hreflang。

### M8：国际版发布（集成，1 天）

全平台 intl 构建 → 先签后发 → R2 + GitHub Releases → 海外干净机器端到端 smoke
（下载 → 装 FVTT → 装 mod → prep → 战斗）→ 站点上线。

---

## 5. 人员任务清单（账号 / 充值 / 决策）

**立即（阻塞 M2/M4/M5/M6）：**（1–3 已于 2026-09-10 完成）

1. ~~Cloudflare~~ ✅ R2 桶 `arcane-desk-intl`、D1 库、`dl.arcanedesk.app` 自定义域、
   R2 S3 密钥对、CF API Token、Workers Paid 均已就位（`api./llm.` 域在 M5/M6 部署
   Worker 时再加）
2. ~~OpenRouter~~ ✅ 改为 DeepSeek 海外站：已注册充值，key 实测连通
   （可用模型 `deepseek-flash`、`deepseek-v4-pro`）
3. ~~GitHub Secrets~~ ✅ `R2_ACCESS_KEY_ID/SECRET`、`CF_ACCOUNT_ID`、`CF_API_TOKEN`
   已写入仓库级 + `desktop-release` environment（`OPENROUTER_PROVISIONING_KEY` 取消）
4. Discord 建服务器 + 永久邀请链接（暂缓，M7 前需要）
5. waitlist：Buttondown 或 ConvertKit 注册（免费档）（暂缓，M7 前需要）

**本周内（阻塞 M3）：**

6. ~~拍板 arcane-agent-bridge 开源~~ ✅ 已拍板**弃用**（DirectFoundryRuntime 替代）
7. ~~拍板 intl 自动化内容口径~~ ✅ 已拍板**接受降级**：国际版 = SRD 5.1 共 167 法术
   （+20 戏法）自动化配方、用户自备内容；对外文案不得宣称"完整 2014 自动化"
8. mods 仓库开 workflow 权限（配 release 自动化）

**下周前（阻塞 M7/M8）：**

9. 法务审阅 Privacy Policy / ToS（AI 起草，人审；披露要点：遥测 opt-in、数据存
   Cloudflare 全球网络、LLM 请求经 OpenRouter 及其上游）
10. 签名工时：每发版日预留约 2 倍手工签名时间（两个 flavor）

**暂缓（第三阶段）：**

11. Paddle / Lemon Squeezy 入驻（需公司主体与收款账户）——BYOK + 手工 key 验证付费意愿后
12. DeepSeek 国际站账号（可选 provider）

**预算：当期现金 ≈ $5/月（CF）+ DeepSeek 充值，无其他采购。**

---

## 6. 拓扑排序与并发方案

```
M0(人) ──┬─→ M2 发布双轨 ───────────┐
         ├─→ M3 Mod链路 ─→ M4 技能包 ─┤
M1 ──────┼─→ M5 LLM网关 ─────────────┼─→ M8 发布
         ├─→ M6 遥测 ────────────────┤
         └─→ M7 网站合规 ────────────┘
```

串行前提：M0（1–2 天）→ M1（约半天）。M1 合并后五条线并行：

| Agent | 任务 | 独占文件范围 |
|---|---|---|
| ① | M2 | `publish-release.mjs`、`package.json`、release workflow；ops 签名 runbook |
| ② | M3 | `mod-manager.mjs`、`scripts/prepare-intl-index.mjs`、索引 cron workflow；mods 仓库 |
| ③ | M4 | `skills/prep/**/SKILL.md`、`references/*`、`system-prompts/*.md`、`publish-skills.mjs` |
| ④ | M5 | ops `services/arcane-spark-edge/`、`tools/arcane-key-intl/` |
| ⑤ | M6 | ops `services/arcane-telemetry-edge/` |

冲突规避：②③ 同碰 `skills/prep/` 但文件不重叠（引擎 vs 文档）；③不等待②完成，
因为 `--index-url` / `ARCANE_MOD_INDEX_URL` 的名字与语义已在 M1 规格钉死。
④⑤ 在 ops 全新目录，与主仓库零交集。共享文件（`main.js`、`providers.js`、`voice/*`、
`provider-catalog.json`）全部归 M1 与收尾，不进并行范围。

收尾串行：provider 目录/ASR intl 默认值 → 签名 → M8 集成 + 海外 smoke。

收益：串行约 15–20 个工作日；并行后墙钟约 5–7 个工作日 + M0/M8 两天，压缩约 60%。
