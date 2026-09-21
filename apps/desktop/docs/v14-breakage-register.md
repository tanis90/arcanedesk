# V14 破坏面登记册(M0 交付物,2026-09-21)

- 状态:M0 spike 完成,结论待评审
- 调查环境:Foundry 14.368(官方 Node 构建 zip)/ Node 24.21.0(私有)/ dnd5e 6.0.3 / midi-qol 14.0.12 / dae 14.0.14 / socketlib v1.1.4 / lib-wrapper 1.13.5.1,数据目录 `D:\FVTT_DATA_V14`(marker 闸门),COS 金本位副本 `cos-v14qa-20260921`
- 详细工件:`D:\apps\fvtt\v14-spike\schema-diff-v14.md`(schema diff)、`hook-diff-v14.md`(hook/API 对照)、`D:\apps\fvtt\v14-stack-README.md`(环境拓扑)

## 0. 三条改变策略的结论(TL;DR)

1. **"V14 移除了 MeasuredTemplate"是误报**——core 14.368 仍完整携带 `MeasuredTemplateDocument`(client/documents/_module.mjs:50),实测创建/集合/渲染/删除全链可用(PoC-A)。真正换成 Region 的是 **dnd5e 6.x** 的放置产物;core 级模板 API 没死。原方案 B2"最高危"定级撤销。
2. **midi-qol 的 v14 线(14.0.12)还不支持 dnd5e 6.x**(relationships.systems 钉 dnd5e 5.2.4–5.3.99),且 v14 服务端会把与系统不兼容的模块强制写回禁用——本世界实测无法启用。全栈(core14+dnd5e6+midi)当前不可达成,等 tposney。
3. **存在今天就可用的中间栈:core 14.368 + dnd5e 5.3.3 + midi-qol 14.0.12**——dnd5e 5.3.3 官方声明 `compatibility {minimum 13.347, verified 14}`,midi v14 线就是为这批用户发的。**建议迁移策略改为两级:先升 core(栈 A,面小、立即可做),dnd5e 6.x 系统迁移拆成独立里程碑(外部阻塞)**。

## 1. 环境与迁移演练(已完成)

| 项 | 结果 |
|---|---|
| 金本位快照 | `D:\apps\fvtt\v14-golden\COS-f13-20260921`(523 目录/2471 文件/1.007GB,robocopy 0 失败,已设只读;world.json 仍 13.351/5.3.3 未污染) |
| 工作副本 | `cos-v14qa-20260921`(world.json id/compatibility.verified 已改为副本口径——见 N1b) |
| 核心迁移 | "Migrating World to core platform 14.368 … completed successfully"(1 秒) |
| 系统迁移 | dnd5e 6.0.3 migrateWorld 全量执行;世界激活,876 actors/244 scenes/317 items/21 combats 在册 |
| **单向性** | **坐实**:副本 world.json 已变 coreVersion 14.368/systemVersion 6.0.3,不可回 F13 |
| 迁移拒绝样本 | 20 条 "Failed to initialize Item":场景 token ActorDelta 内嵌 item 的 `effects type:"auraeffects.aura"`(疑似 ActiveAuras 系)及旧 ActiveEffect 校验失败;世界本体 actor 内嵌 effect 亦有同类(DataModelValidationFailure 刷屏,见浏览器 console)——**M2/M3 需要一个"旧 effect 清洗/豁免"工单** |
| rules version | `rulesVersion=legacy` 迁移后保留(2014 线不断) |
| 许可证 | 复用 F13 license 验证成功(E18 模式复现) |

## 2. 原方案 B1–B12 判定修订

| # | 原判定 | M0 实测 | 修订 |
|---|---|---|---|
| B1 Node 互斥 | 高 | 环境落地:私有 Node 24.21.0 绝对路径运行,nvm/系统 node 零接触(本机 nvm 激活态原为 24.12.0,全程未动) | 确认,机械 |
| B2 MeasuredTemplate 移除 | **最高** | **推翻**:core 14 模板类健在,PoC-A CRUD 通过;Region 是 dnd5e 6.x 的放置产物 | 降为"仅 dnd5e 6.x 线",KD-3 见 §4 |
| B3 Scene Levels canvas 重构 | 高 | 未逐项测(canvas.grid.measurePath 运行时为 function;SDK 用的坐标 API 待 M2 编译期核对);display-vision 的 CanvasVisibility patch 属 M4 小模块项,未测 | 待 M2/M4,预降级 |
| B4 AE V2 | 中 | 观察到旧 effect 校验拒绝(见 §1);dae 14 正常激活 | 确认,新增清洗工单 |
| B5 dnd5e schema | 高 | 源码逐项确认(AC 列表化/chat flags/senses/bloodied,证据见 schema-diff);**我方命中极小**:ac.calc 仅 catalogue 1 处 AE + SDK 6 处,chat 迁移键全仓 0 命中 | 确认,量级下修 |
| B6 activities/chat API | 中高 | 源码确认(applicableEffects→profiles、结构化 getCardData、activateChatListeners 弃用至 6.2) | 确认(M6 项) |
| B7 advancement 行为变化 | 高 | API 完好(运行时 forNewItem/flowsForLevel 均 function);行为变化在 `#synthesizeSteps` 逐级不跳步——需 M2 行为级回归 | 确认,API 面安全 |
| B8 midi-qol/dae 大版本 hook 断裂 | 高 | **大幅下修**:49 hook 中 48 intact、0 改名、1 死注册(renderActorDirectory5e);SDK 消费的 13 个 MidiQOL API 全部 intact(computeTargetsFromTemplates 保留,内部 Region 化);三个"动态派发"陷阱见 hook-diff §0 | **下修为低-中**(注意 grep 方法论) |
| B9 不能应用内升级 | 中 | 官方文档事实,未重测 | 维持 |
| B10 两处版本全等断言 | 低 | 未动(工作项不变) | 维持 |
| B11 manifest 硬上限 | 低 | 未动;**新增**:v14 服务端 `#t` 过滤器会把 system-不兼容模块强制禁用(midi 在 dnd5e6 世界被强制 false 的根因) | 维持+新增核心行为 |
| B12 世界单向迁移 | 流程 | 演练坐实 | 维持 |

## 3. 新发现(N1–N10,M0 原始输出)

- **N1 v14 运维面变化(影响 ops/desktop/skills)**:
  a. admin API 只剩 `GET /api/status`——`/api/worlds`、`/api/launch` 均已删除;世界启动回归 options.json `world` 自动加载。
  b. **自动加载闸门**:`canAutoLaunch` 要求 world.json `compatibility.verified` ≥ 当前核心版本,否则 "not available to auto-launch"——所有 QA 副本必须显式提 verified(COS 原值 13.351 被拒)。
  c. POST 全域加 CSRF 校验(必须带 Origin 头),脚本调用要注意。
- **N2 `DND5E` 全局在 6.x 被移除**→ `CONFIG.DND5E`(SPELL_LISTS 现取自 `CONFIG.DND5E.SPELL_LISTS`,8 条 journal UUID)。automation.js 的裸 `DND5E.*` 引用在 6.x 会抛错;5.3.3 栈不受影响。
- **N3 `registry.spellLists.forType(type, identifier)` 双参为新签名,单参 `"class:wizard"` 仍兼容**(实测均返回 204 identifiers,5.3.3 为 219——**内容集本身有漂移**)。
- **N4 SRD 法术集漂移**:6.0.3 的 `dnd5e.spells`(320 条)没有 Hunger of Hadar;`spells24` 341 条也没有。M3 的 186 配方 parity 基线必须按"内容集差异 + schema 差异"双口径重导。
- **N5 dnd5e 6.x 不会自动迁移带 manifest+download 的模块 pack**(`_shouldMigrateCompendium` 判定),17 packs 必须在 v14 管线重导(2,449 条);JournalEntry pack 永不自动迁移。schema 级内存转换可兜底展示,但 AE `ac.calc` 键不改写。
- **N6 dnd5e 5.3.3 官方 verified 14**——栈 A 的合法性来源。
- **N7 模块启用写入被服务端过滤**:in-game `settings.set('core','moduleConfiguration')` 对 system-不兼容模块会被 `#t` 回写禁用(不是 bug,是设计);raw set 也不落库,须走真实表单/流程。ops 自动化里启用模块要做兼容性预检。
- **N8 PoC-A**:core 14 上 `MeasuredTemplate` CRUD 实测通过(circle 20ft,集合/层渲染/删除正常;distance 按场景网格换算)。
- **N9 PoC-B(KD-3 判定)**:dnd5e 6.0.3 下 fireball(target.template sphere 20ft 声明结构与 5.3.3 同构)按系统同款 regionData 构造 **circle shape Region**,`region.polygonTree.testPoint({x,y}, 1)` 目标判定几何精确(圆心与 204px 内 token 判内,305/388/326px 判外,半径 288px=20ft),清理干净。**KD-3 结论:Region 可覆盖模板 AoE 目标计算,SDK 模板 action 可保留契约、底层按系统代际映射(midi 的 computeTargetsFromTemplate 本就双轨接受模板/Region)**。
- **N10 AbilityTemplate 入口仍在**:`dnd5e.canvas.AbilityTemplate.fromActivity(activity)` 返回放置预览对象(drawPreview/_finishPlacement 族),`target.template` 声明与 usage 键(`create.measuredTemplate`)两版一致——内容数据不用改。

## 4. 修正后的估算与里程碑重排(建议,待评审)

**策略改动:两级迁移,栈 A 先行。**

| 里程碑 | 内容 | 估算(人周) | 变化 |
|---|---|---|---|
| M1′ pin/基建(core 14 + **dnd5e 5.3.3 不动** + midi 14/dae 14 + Node 24) | community-distribution 双字段(core 换 14,system 留 5.3.3)、Node 24 五平台、skills、intl 策展(midi/dae latest 即栈 A 闭包) | ~1 | 基本不变 |
| M2′ SDK/工具面 @栈 A | 版本断言改造、webmcp verified 14、测试 mock 13.351→14.368(system 仍 5.3.3);模板 action **不用重写**(PoC-A) | 1–1.5 | **大降**(原 2–4) |
| M4′ auto2014 @栈 A | 22.5K 行 runtime 的核心级核查:删 renderActorDirectory5e 死注册、effect 校验拒绝的旧世界清洗工具、QA farm v14 槽 + 70 快照重跑 | 1–2 | **大降**(原 2–4):hook 面 48/49 intact、DND5E 全局/模板/chat 全不变 |
| M5′ 发布(core-14 线 GA) | desktop 0.6.x、COS 生产世界在栈 A 上迁移演练(单向,备份先行) | 1 | 不变 |
| **M6(新)dnd5e 6.0.x 系统迁移** | **外部阻塞:等 midi-qol 支持 dnd5e 6.x**;届时做 B5/B6/N2/N4/PoC-B 落地 + 2,449 条 pack 重导(N5)+ parity 双口径重导 + advancement 行为回归 | 3–5 | 从原 M2/M3/M4 中拆出,总量近似但后置 |

合计:栈 A 全家族 **≈4–5.5 人周**(原方案 9–14 的前半),M6 后置到 tposney 发版。原"等生态沉淀"的等待被栈 A 消化,团队在等待期可交付 core-14 线。

## 5. 基线快照与证据指针

- 私有仓 `docs/migration/baseline-pack-digest.json` SHA256 `07864ef00c80…4e2d9491f4e`(M0 时点 F13 参考基线)
- schema diff:`D:\apps\fvtt\v14-spike\schema-diff-v14.md`;hook/API 对照:`hook-diff-v14.md`
- 迁移日志:`D:\FVTT_DATA_V14\Logs\`(debug/error.2026-09-21.log)
- 环境/登录拓扑:`D:\apps\fvtt\v14-stack-README.md`

## 6. M0 遗留与紧后工单

1. 栈 A 端到端验证(金本位新副本 + dnd5e 5.3.3 + midi 14 + auto2014 0.4.0 装入 v14 栈)——当前副本已被 6.0.3 单向迁移,须重开副本。
2. 旧 effect 校验拒绝(20+ 条/auraeffects.aura 类)清单化与清洗策略(装 auraeffects 2.1.1 后可能自愈,待验证)。
3. display-vision 的 CanvasVisibility patch 在 core 14 的复核(小模块项)。
4. midi-qol dnd5e 6.x 支持盯哨:**盯 `dnd6` 分支**(不是 v14 分支)——该分支最后提交 2026-09-15(dnd5e 6.0 发布后 5 天),tposney 已在移植;其 package/module.json 的 `relationships.systems` 上限放开(现仍 5.3.99)即为发版前兆;配套社区工单 #1573/#1579 在催。历史模式:`dnd3`/`v12dnd4`/`v13`/`v14`/`dnd6` 分支名即"每次大版本都跟"的证据。M6 排期按"manifest 放开 + 2–4 周 beta 沉淀"估(参照 4.x 大重构先例)。

## 7. 补充:依赖线兼容上限盘点(2026-09-21,官方 manifest 实测)

以本模块 `recommends` 全线(含 midi 的 requires:socketlib/lib-wrapper)逐个拉取官方 manifest:

| 模块 | 最新版 | core 兼容 | dnd5e 兼容 | v14 现状 |
|---|---|---|---|---|
| ActiveAuras | 0.12.7 | 12–**13(max)** | — | 无 v14 版 |
| times-up | 13.1.9 | 12–13.999 | — | **作者声明永不出 v14**(功能归 core+dae) |
| midi-qol | 14.0.12 | 14–14.999 | **5.2.4–5.3.99** | dnd5e 6.x 未支持(全线真瓶颈) |
| dae | 14.0.14 | verified 14.367 | 未声明 | ✅ |
| socketlib / lib-wrapper | v1.1.4 / 1.13.5.1 | verified 14 | — | ✅ |
| auraeffects | 2.1.1 | **min 14 / max 14** | — | 按核心代际分线(1.5.2=F13 线) |
| ATL | v1.1.1(即我方钉版) | verified 13,无上限 | — | 14 可载未验证 |
| itemacro | 1.9.0 | verified 11,无上限 | — | 可载 |
| foundryvtt-actor-studio | 未查 | — | — | 低风险待查 |

**三档天花板:**
- 完整线原样:**FVTT 13.351 + dnd5e 5.3.3(= 当前基线即天花板)**,被 ActiveAuras(max 13)+ times-up(永不 v14)双钉死;
- 去 times-up(core+dae 吸收,作者背书):仍钉 core 13(ActiveAuras);
- 再去 ActiveAuras:**FVTT 14.368 + dnd5e 5.3.3**(midi 14/dae 14/socketlib/lib-wrapper/auraeffects 2.1.1 全通);
- dnd5e 6.x:全线无人支持,等 midi-qol。

**对 §4 的修正**:栈 A 成立条件 = 去 times-up + 解 ActiveAuras。ActiveAuras 是 recommends 非 requires,51 hook 无其专属 hook,光环归一/尺寸同步为我方 runtime 自有逻辑,替代深度待专项实测(光环实际施加引擎归属)。M4′ 估算 +0.5–1 人周。

## 8. 补充:ActiveAuras 替代路线评估(auraeffects 化,2026-09-21)

代码证据(runtime automation.js):双引擎现状——ActiveAuras 15 处(token 邻近光环异步引擎:`waitForActiveAurasStable` 信号量、updateToken 让位;**模板锚定光环**:`flags.ActiveAuras.IsAura` ×2 + zone 成员追踪);auraeffects 12 处(effect 类型 `auraeffects.aura`、`fromAura` 源/副本区分、socketlib RPC `applyAuraEffects`/`deleteEffects` 被我方直接调用)。

**结论:可替代,方向正确,但属"光环引擎统一"改造(估 3–5 人天),非开关替换。**
- token 光环:AE 2.1.1 全面覆盖且更强(墙阻挡、best-formula 取最优、可视化、token 附着 Region 计算);作者为 dnd5e 系统贡献者,v14-only 线与系统 Region 化同频。
- **gap ①(最大)**:模板/绘图锚定光环(区域效应)在 AE 无现成等价——需以"我方 zone 成员追踪(本就自有)+ AE applyAuraEffects / v14 RegionBehavior"重建,是新代码;v14+dnd5e6 法术模板即 Region,语义反而更顺。
- gap ②:15 处 AA 集成点(信号量/applied 副本/让位/清理绕补)全部重写或删除。
- gap ③:存量世界 AA flag 光环(effect `flags.ActiveAuras.*`、模板 `IsAura`)转 AE 配置;我方 2,449 条 pack 受影响极小(catalogue 仅 1 处注释)。
- 验收项:下一轮金本位副本实测加"保护光环 + 一个 zone 法术在 v14 走通"。
