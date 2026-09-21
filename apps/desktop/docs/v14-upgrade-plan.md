# ArcaneDesk Foundry V14 升级总体技术方案

- 状态:设计提案(待评审)
- 日期:2026-09-21
- 范围:`arcanedesk`(SDK / CLI / WebMCP / Desktop)、`arcanedesk-fvtt-mods-private`(auto2014 全量流水线,含公开导出仓 `arcanedesk-fvtt-mods`)
- 前置阅读:`apps/desktop/docs/server-deploy-plan.md`(部署链)、`apps/desktop/distribution/intl-mod-curation.json`(F13 策展现状)、私有仓 `docs/migration/`(内容基线)

## 0. TL;DR

把全家族从 **Foundry 13.351 + dnd5e 5.3.3 + Node 22.23.2** 升级到 **Foundry 14.368 + dnd5e 6.0.3 + Node 24**。总量约 **9–14 人周**;两到三人并行时墙钟 **6–10 周**。

三个结构性事实决定了方案形态:

1. **V14 与 V13 的 Node 要求互斥**(V14 必须 Node 24+,V13 不兼容 Node 24)——双栈必须物理隔离,F13 生产线与 v14 升级线各自独立目录/数据目录/端口,无法共享运行时。
2. **V14 移除了 MeasuredTemplate 这个核心文档类型**(改为 Region-based templates + Behaviors)——SDK runtime、fvtt-cli、auto 模块的全部模板 AoE 逻辑(MeasuredTemplate 6 处调用、`canvas.templates`、midi 的 `computeTargetsFromTemplates`)不是"适配"而是**重写**。这是单项最大的未知风险。
3. **dnd5e 6.0 改了数据 schema**(AC 列表化、chat message flags 迁入 system 字段、activities API 变更)——私有仓 17 packs / 2,449 条 compendium 内容按 5.3.3 schema 构建,需整体迁移重验;186 条法术配方 parity 基线要对着 6.0.3 官方包重建。

总体策略:**双线并行,F13 线冻结维护,v14 线分支推进**。auto 模块私有仓当前有在飞工作(22,521 行 runtime 含未提交的 features/registry + 牧师内容),**先收尾落地再开 v14 线**是第 0 步。

## 1. 目标基线与锁版策略

### 1.1 版本表(2026-09-21 调研)

| 组件 | F13 现基线 | v14 目标 | 目标版本 | 备注 |
|---|---|---|---|---|
| Foundry VTT | 13.351 | ✅ | **14.368**(2026-09-16) | v14 最新 stable;不能应用内升级,须卸载重装 |
| dnd5e | 5.3.3 | ✅ | **6.0.3**(2026-09-17) | 6.0 仅支持 v14+;5.3.3 是 F13 末版 |
| midi-qol | 13.0.63 | ✅ | 14.0.12 | verified 14.357 |
| dae | 13.0.28 | ✅ | 14.0.14 | verified 14.367,作者明示 v14 支持还新 |
| Node.js | 22.23.2 | ✅ | Node 24 最新 LTS | 具体小版本 M1 钉版时定(五平台 SHA256) |
| Dice So Nice | 5.2.5(钉旧) | ✅ | v14 线最新(M1 定版) | 现钉 5.2.5 正是为避开 v14 主线 |
| times-up / socketlib / lib-wrapper | 13.x | ✅ | v14 对应版(M1 核实) | intl 策展闭包成员 |
| CPR / GPS(outside-sys 研究参考) | 1.5.44 / 2.1.44 | ✅ | 2.0.2+ / 新版 | 仅研究参考,非运行时依赖 |

### 1.2 移动靶锁版纪律

dnd5e 6.0 于 2026-09-10 发布,一周内连出 3 个 patch;midi-qol 14.0.12、dae 14.0.14 也都是上周发布。整条 v14 生态仍在高频变动期。因此:

- **钉版单一来源**不变:`apps/desktop/distribution/community-distribution.json`(下游 pins.mjs / entrypoint / healthcheck / mod 索引 / skills 全部同源);
- **重钉节点**固定为每个里程碑入口(M2/M4/M5 进入时各重钉一次),里程碑中途不追版;
- **M4(auto runtime 深水区)刻意晚进场**,给 dnd5e 6.0.x 与 midi-qol 14.0.x 留 2–4 周沉淀期;期间并行推进不受其影响的 M1(pin 链)、M3(内容层);
- M0 产出的破坏面清单与 digest 基线是"靶子动了没有"的判定器。

## 2. 已确认破坏面清单

调研已核实的版本耦合点(不含 M0 待实测项):

| # | 变更 | 我们的受影响点 | 严重度 |
|---|---|---|---|
| B1 | Node 22 → 24,与 V13 互斥 | 本机 D 盘 COS(13.351)与 v14 环境必须分目录分端口;QA farm 槽位镜像重做;desktop 内置 Node 运行时五平台 SHA256 全换 | 高(但机械) |
| B2 | **MeasuredTemplate 文档类型移除**,改 Region-based templates(Behaviors、可挂 Token) | SDK runtime 6 处 `MeasuredTemplate`;fvtt-cli `canvas.templates.preview.children`、模板预览交互;auto runtime `canvas.scene.templates`;midi `computeTargetsFromTemplates`;AoE 法术自动目标链;`COS-valentin-hunger-of-hadar-regression` 等回归用例 | **最高** |
| B3 | Scene Levels 多层场景:vision/movement/combat 跨层,canvas/perception 重构 | `arcane-common-display-vision` 的 CanvasVisibility getter patch(手写 `Object.defineProperty` 覆盖 `CONFIG.Canvas.groups.visibility.groupClass` 原型)、`canvas.perception.update` | 高 |
| B4 | Active Effects V2(compendium 存储、改 token、新过期控制) | auto/dae 深耦合的 effects 生命周期(51 处 Hooks 含 pre/Create/DeleteActiveEffect) | 中,随 B7 实测 |
| B5 | dnd5e 6.0 schema:AC 改 `system.attributes.ac.calcs/formulas` 列表、`CONFIG.DND5E.senses` 变配置对象、`bloodied.threshold` 变百分比、chat flags 迁移(`flags.dnd5e.item/activity.* → system.item/activity.*`、`targets → system.targets`、`originatingMessage → system.origin`) | 2,449 条 pack(凡 effect 指向 `ac.calc/ac.formula` 的必须改 ADD 语义);runtime 读 chat/activities 的全部路径;historical 先例:`system.abilities.dex.save → system.abilities.dex.bonuses.save` 迁移 | 高 |
| B6 | dnd5e 6.0 activities/chat API:`Activity#applicableEffects` 返回 profiles、usage chat buttons 新描述符、`getAssociatedItem()/getAssociatedActivity()` 取代旧 getter、`getCardData` 结构化 | SDK runtime 的 activity 遍历(`collectActionCandidatesV2` 遍历 `item.system.activities`)、使用完成信号、auto 的 card 渲染路径 | 中高 |
| B7 | dnd5e 6.0 advancement **行为**变化:升级链不再跳步、改职业等级不再重跑后续 advancement(无 API 改名记录) | `actorAdvance`/`advancementPlan` 全链路行为重验;`arcanedesk-subclass-temp`/`arcanedesk-race-clone` 克隆流程;`SPELL_BUDGET_TABLE`(注明 verified against 5.3.3)重新核对 | 高 |
| B8 | midi-qol 13 → 14、dae 13 → 14 大版本 | auto 的 51 处 Hooks(`midi-qol.postCleanup/targetingComplete/preCheckSaves`、`dae.modifySpecials`)、`MidiQOL.completeItemUse`、`midi.getDistance/checkDistance/checkActivityRange/canSee`;SDK runtime 同面 | 高(M0 实测定量) |
| B9 | V14 不能应用内升级(卸载重装,独立 User Data) | `arcane-fvtt-setup` skill 安装流;下载指引反转:现指引"不要用默认 Recommended、选 Older Stable→13.351",v14 线变回"Recommended 即正确"(Node.JS 平台下拉仍要盯) | 中 |
| B10 | 两处版本全等断言:`actorDamageMigrate`/`actorBilingualSync` 的 `game.version !== manifest.foundryVersion` → throw | 升级即断,须改断言语义(见 KD-2) | 低(必改项) |
| B11 | manifest 硬上限:auto 模块 `maximum 13.999`/dnd5e `5.3.99`;display-vision、spells-2014 `maximum 13`;`spell-runtime/availability.mjs:10` 的 `generation !== 13` 硬门禁 | v14 下直接拒载/拒执行 | 低(必改项) |
| B12 | 世界单向迁移(13→14 不可回退) | COS 迁移演练与用户指引;现有"被 14.x 打开过即拒迁"门禁保留并扩展为 v14 线同款纪律 | 流程性 |

## 3. 总体策略:双线并行

```
F13 生产线(main)——冻结维护,所有已发布验证主张的基线
  └─ 0.5.x 维护线:只修缺陷,不动版本面,直至 v14 线 GA

v14 升级线(docs/v14-upgrade 分支族)
  ├─ arcanedesk:        M1 pin 链 → M2 SDK/工具面 ─┐
  ├─ fvtt-mods-private: M3 内容层(并行)──────────┤→ M4 auto runtime → M5 集成发布
  └─ 环境:              M0 spike / QA farm v14 槽
```

- **硬切,不做 runtime 双版本分支**(KD-1):21K 行 runtime 维护两套 generation 分支不可行;SDK preflight 增加 `generation` 上报,发布以版本线区分(F13 用 0.5.x,v14 用 0.6.x 起)。
- **环境物理隔离**:本机新增独立 v14 数据目录(端口沿用 QA farm 规则但独立槽段),D 盘 13.351 COS 不动;`arcane-fvtt-ops` 探测逻辑按数据目录区分双栈。
- **世界迁移纪律**:复用 `.arcane-world-backups`,先备份后迁移,任一世界只允许单向进 v14;`arcane-fvtt-server` 的 coreVersion 门禁改为"目标线版本区间"检查。

## 4. 关键决策点(KD,评审时定)

| KD | 问题 | 建议 |
|---|---|---|
| KD-1 | SDK/工具面是否双 generation 支持 | **硬切**。0.6.x = v14-only;0.5.x = F13 维护线。理由:双分支使每个 runtime 改动成本 ×2,与冻结字节的 runtimeHash 机制冲突 |
| KD-2 | 版本断言语义 | `game.version !== manifest.foundryVersion` 全等断言改为 **generation 全等 + build ≥ 钉版**,防 14.369+ 出现时误拒;`systemVersion` 同理放宽到 minor 线 |
| KD-3 | 模板 action 契约 | **保留对外 action/工具语义名**,底层重写为 Region 模板;agent 可见的 schema 文档更新措辞。若 M0 PoC 证明 Region 语义无法覆盖模板 AoE 自动目标(目标集合计算不等价),则升级为契约变更评审 |
| KD-4 | 2,449 条 pack 双轨还是重建 | **v14-only 重建**,模块版本 0.5.0 起;F13 已发布 0.4.0 冻结不再动 |
| KD-5 | intl 策展双线 | F13 线策展冻结(直连钉旧版不再跟);v14 线重新评估整条依赖闭包(midi-qol/dae/socketlib/lib-wrapper/times-up/dnd5e 6.0.3)。dnd5e 已转 foundryvtt 官方仓,URL 稳定性与 mirror 策略重查(现策展注明 5.3.3 自指 URL 指向 master 可变分支才需 mirror) |
| KD-6 | desktop 内置 Node 24 选版 | 选当前 Node 24 LTS 最新,M1 时定具体小版本并锁五平台 SHA256;同轮验证 desktop 自身构建链(Node 24 构建 Electron 应用无回归) |
| KD-7 | 研究参考(CPR/GPS/DSN)升级 | CPR 2.0.2+、GPS 新版、DSN v14 线;only research,outside-sys 同步更新钉版 |

## 5. 工作分解(WBS)

### M0 破坏面 spike(1 周,可立即启动)

目的:把 §2 清单里"待实测"的项变成精确到文件的工单,产出修正后的 M1–M5 计划。

- 搭 v14 + Node 24 独立环境;COS 世界副本迁移演练(验证单向迁移与备份流程)。
- midi-qol 14.0.12 / dae 14.0.14 hook 面 diff:对照 auto runtime 的 51 处 `Hooks.on` 逐个确认存在性/签名变化。
- dnd5e 6.0.3 官方 pack schema diff:对 2,449 条 pack 的字段面出差异报告(重点:`ac.calc` 指向、chat flags、senses)。
- **Region 模板 PoC**:挑一个 AoE 法术(建议 Hunger of Hadar,有现成回归用例)在 v14 走通"放置 → 目标集合计算 → 伤害"全链,验证 KD-3 可行性。
- `AdvancementManager`/`registry.spellLists`/`registry.dependents` 在 6.0.3 的 API 存在性核对(6.0 release notes 无改名记录,行为变化需实测)。
- 产出:`v14-breakage-register.md`(精确文件级)、修正估算、digest 基线快照。

### M1 基建与 pin 链(约 1 周,与 M0 后半并行)

- `community-distribution.json`:foundry 14.368、Node 24 五平台 SHA256、windowsInstaller 14.368.0(体积/SHA256/NSIS 静默参数全部重验)、dnd5e 6.0.3 license 记录。
- `build-server-image.mjs` → `pins.mjs` → `entrypoint.mjs`(三段版本断言复核:v14 package.json 版本格式)/ `healthcheck.mjs`。
- 测试随改:`fvtt-skills.test.mjs`、`fvtt-mod-manager.test.mjs`、`make-fake-foundry-zip`、`prepare-intl-index.test.mjs`。
- skills SOP:`arcane-fvtt-setup`(B9 安装流反转)/ `arcane-fvtt-ops`(双栈探测)/ `arcane-fvtt-server`(门禁重写)。
- intl 策展 v14 线:依赖闭包重评估 + dnd5e 6.0.3 mirror 策略(KD-5)。
- QA farm v14 槽位(Node 24 镜像,30100+N 端口规则不变,数据目录与镜像按栈区分)。

### M2 SDK 与工具面(2–4 周,关键路径)

- `packages/foundry-sdk/src/runtime-source.ts`(冻结字节单行串)+ `runtime-helpers.ts`(1,772 行镜像)双源同步改造;先把 hash 重算/双源一致性校验脚本化,再动内容。
- B10 断言改造(KD-2);webmcp `module.template.json` → `verified: 14`。
- dnd5e API 面:`AdvancementManager.forNewItem/flowsForLevel`、`registry.spellLists.forType`、activities 遍历、chat 读取路径(B5/B6)、`SPELL_BUDGET_TABLE` 对 6.0.3 重核、`dnd5e.postUseActivity` hook 存在性。
- B2 模板重写:SDK 6 处 + fvtt-cli `canvas.templates`/坐标交互/`MeasuredTemplate` → Region 语义(KD-3)。
- midi-qol 面:`completeItemUse`、`getDistance/checkDistance/checkActivityRange/canSee/computeTargetsFromTemplates` 的 14.x 对应。
- 测试重写:`foundry-runtime.test.ts`(6,519 行,29 处 stubGlobal,5 处 13.351 mock → 14.368)、`play-context.test.mjs` 沙盒、webmcp mock、desktop 相关。
- 桌面工具面:`foundry-tools.js` 的 `foundry_actor_advance` 等 schema 描述文案随行为重验更新。

### M3 auto 模块内容层(2–3 周,与 M2 并行,不受 midi-qol 影响)

- pack schema 迁移:2,449 条(17 packs)按 B5 差异报告改;`foundry-pack-builder` LevelDB 序列化复核。
- `build-arcane-paladin-module.mjs`(2,405 行,第 2,113 行版本块):manifest 解除 13.999/5.3.99 封顶 → v14/6.x,模块版本 0.5.0。
- `validate-arcane-paladin-module.mjs`(14,686 行)按 6.0 schema 更新校验规则。
- parity 基线重建:`verify-public-spell-mechanics.mjs` 的 186 法术逐字段 parity 对 6.0.3 官方包重导;`baseline-pack-digest.json` / `rebuilt-pack-digest.json` 重算。
- 召唤内容:22 profiles / 19 recipes / 8 pools 的 schema 面 + `registry.dependents` 生命周期实测(M0 结论跟进)。

### M4 auto 模块 runtime 层(2–4 周,前置:M2 经验 + 生态沉淀 2–4 周)

- **前置第 0 步(本周即做)**:私有仓在飞工作(features/registry + 牧师,22,521 行 vs 导出 22,115 行)在 F13 线落地、导出、CI 绿,再开 v14 分支。
- 22,521 行 runtime 按 hook 组分批迁移(midi 组 / dae 组 / effects 组 / canvas 组 / summon 组),每批在 QA farm v14 槽跑对应 QA 快照。
- manifest 上限解除随 M3 的构建器改动生效;ATL v1.1.1 / auraeffects 1.5.2 等 recommends 重钉 v14 兼容版。
- DSN 动画集成重验(DSN v14 线,`verify-animation-locale.mjs` 等);`outside-sys` 参考更新(KD-7)。
- `qa-cantrips/` 70 份 QA 快照全量重跑;`combat-agent-realistic-benchmark.md` 在 v14 + COS 副本重落基线(Mode A/B)。
- 公开仓同步:manifest 上限、`availability.mjs` generation 门禁、导出与 CI。

### M5 集成验收与发布(1–2 周)

- desktop 0.6.x 走完整发布链(prepare/finalize、`oss-release-contract`、release.json/feed;注意 0.5.0 cn 事故的基座新鲜度守卫对新链同样生效)。
- COS 全量迁移演练:备份 → 迁移 → 双基准(prep-benchmark + 战斗基准)重跑;验收记录按 `acceptance-audit-history.md` 惯例归档。
- 文档全量:baseline 声明从"13.351/5.3.3"叙事切到双线叙事(F13 冻结主张 + v14 新基线);README/技能描述/skills 索引。
- 止损评审:对照 §6 风险表决定 GA 或延长维护双线。

### 工期与依赖

| 里程碑 | 工期 | 依赖 | 可并行性 |
|---|---|---|---|
| M0 spike | 1 周 | — | 立即启动 |
| M1 基建 | 1 周 | M0 过半 | 与 M2 前半并行 |
| M2 SDK/工具面 | 2–4 周 | M0 | 关键路径 |
| M3 内容层 | 2–3 周 | M0 | 与 M2 全程并行 |
| M4 auto runtime | 2–4 周 | M2 + 生态沉淀 2–4 周 | 单线 |
| M5 发布 | 1–2 周 | M2+M3+M4 | — |

单人串行 9–14 周;两人并行(M2 一人、M3+M4 一人)墙钟约 **6–10 周**,其中含刻意等待的沉淀期。

## 6. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| dnd5e 6.0.x / midi-qol 14.x 高频 churn,迁移期再破坏 | 高 | 中 | §1.2 锁版纪律;M4 晚进场;digest 基线判定"靶子动了没有" |
| Region 模板与 MeasuredTemplate 语义不等价,AoE 自动目标链重写超预期 | 中 | **高** | M0 单法术 PoC 前置;不等价则 KD-3 升级为契约变更,提前评审 |
| midi-qol 14 内部 hook 面大改,51 处 hook 重接工作量超估 | 中 | 高 | M0 diff 实测定量后再承诺 M4 工期 |
| 21K runtime 未知未知(5.3.3+midi13 假设散布全文) | 高 | 中 | 按 hook 组分批 + 每批 QA 快照;M4 预算留 1 周缓冲 |
| advancement 行为变化(B7)使 actorAdvance 语义漂移 | 中 | 中 | M2 中行为级重验 + receipt 对比;必要时 0.6.0 的工具描述显式声明行为差异 |
| 双栈运维负担(Node 互斥)引发误操作 | 中 | 中 | 目录/端口/skills 双 profile 显式化;ops 探测按数据目录判栈 |
| F13 基准主张在过渡期被质疑 | 低 | 低 | 明确"F13 冻结基线 + v14 重落"双叙事,不混用 |
| 世界迁移事故(单向不可回退) | 低 | 高 | 强制 `.arcane-world-backups` + 拒迁门禁保留;COS 迁移只在 M5 演练后执行 |
| dnd5e 6.1 再改 schema | 中 | 中 | pack builder 可重入 + digest 基线;升级线分支保留重生成能力 |

## 7. 验收标准(DoD)

- **M0**:破坏面清单文件级评审通过;Region PoC 给出 KD-3 结论;修正工期获认。
- **M1**:QA farm v14 槽起 COS 副本;`npm run verify`(desktop)在 v14 pin 链下绿。
- **M2**:仓库 `npm run verify` 全绿;COS v14 副本实测 action 抽样面(actorAdvance/executeTurn/模板类/读类)receipt 0 error;webmcp 在 v14 页面注册成功。
- **M3**:17 packs / 2,449 条新旧 digest 对账报告(允许 schema 迁移导致的预期差异,逐类列明);186 法术 parity 对 6.0.3 全绿;私有仓 CI 绿。
- **M4**:70 QA 快照重跑全绿;战斗基准 Mode A/B 在 v14 落新基线并归档。
- **M5**:发布链全量演练;双基准报告;文档切换双线叙事;止损评审结论。

## 8. 立即行动项(本周)

1. 私有仓在飞工作收尾:features/registry + 牧师内容在 F13 线落地、导出公开仓、CI 绿(开 v14 分支的前提)。
2. 启动 M0:申请/搭建 v14 + Node 24 独立环境与 COS 世界副本。
3. 本方案评审(重点:KD-1 至 KD-7,尤其 KD-3 的 PoC 结论回填)。
