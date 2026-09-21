# ArcaneDesk Foundry V14 升级总体技术方案

- 状态:**暂缓执行,触发器制重启**(M0 spike 已完成,2026-09-21 评审结论:放一放)
- 日期:2026-09-21(v2,并入 M0 全部调研数据;v1 的执行计划转为重启手册)
- 范围:`arcanedesk`(SDK / CLI / WebMCP / Desktop)、`arcanedesk-fvtt-mods-private`(auto2014 全量流水线,含公开导出仓 `arcanedesk-fvtt-mods`)
- 前置阅读与证据:`apps/desktop/docs/v14-breakage-register.md`(M0 破坏面登记册,含 §7 依赖线上限、§8 auraeffects 化评估)、`D:\apps\fvtt\v14-spike\`(schema/hook diff 工件)、`D:\apps\fvtt\v14-stack-README.md`(v14 QA 栈拓扑)

## 0. TL;DR:决策与依据

**决策:放一放。** M0 完成后,四个已核实的事实支持暂缓:

1. **全栈目标当前不可达成**:我们目标用户群(dnd5e + midi 自动化)被 midi-qol × dnd5e 6.x 阻塞——midi v14 线(14.0.12)钉 dnd5e ≤5.3.99,v14 服务端还会强制禁用 system-不兼容模块(实测);适配分支 `dnd6` 刚起步(最后提交 9-15,manifest 未放开)。
2. **无用户压力**:官方年报(2026-05)V13 仍占 62.97% 多数,V14 仅 12.92%(stable 后 6 周);该社区长尾很重(V12 在 V13 stable 一年多后仍占 19%)——F13 线服务多数用户的时间窗比预想长得多。
3. **升 core 14 有前置改造**:完整依赖线被 ActiveAuras(`maximum: 13`,无 v14 版)与 times-up(作者声明永无 v14)钉死在 core 13;栈 A(core 14 + dnd5e 5.3.3)可行,但需先做 auraeffects 化(3–5 人天)与 times-up 吸收,而其增量价值在 midi dnd6 落地前有限。
4. **等待成本极低**:M0 已备好 v14 QA 栈、金本位快照、精确到文件的破坏面登记册与工单——触发器命中即可开工,无沉没风险。

**重启触发器(任一命中即按 §3 重启手册执行):**

| # | 触发器 | 检查方式(暂缓期每两周) |
|---|---|---|
| T1(主) | midi `dnd6` 分支 manifest 的 `relationships.systems` 上限放开 + 2–4 周 beta 沉淀 | `curl https://gitlab.com/tposney/midi-qol/-/raw/dnd6/package/module.json` |
| T2 | dnd5e 用户群 v14 占比成实质多数(官方 2027 年报 / Forge 把 v14 设为推荐版本) | foundryvtt.com 年报、Forge 博客 |
| T3 | dnd5e 5.3.x 停止安全修复,或出现明确的 v14-only 需求(Scene Levels 等) | dnd5e releases、产品需求 |
| T4 | 自身运维需要(如 server-deploy 线依赖 core 14 特性) | 内部 |

## 1. M0 调研数据(全部实测核实,2026-09-21)

### 1.1 生态与采用率(官方 Year in Review 六周年版,2026-05-23)

| 指标 | 数值 | 对我们的含义 |
|---|---|---|
| V14 占比 | 12.92%(stable 后 6 周) | 增长快但尚非主流;9 月无官方更新数据 |
| V13 占比 | 62.97%(stable 后 14 个月) | F13 线在可见期内服务多数用户 |
| V12 / V11 | 18.76% / 15.35%(年报口径混合,趋势参考) | 社区长尾重,代际 profile 产品形态被坐实 |
| dnd5e | 62.68% 安装 / **52.11% 最常玩** | 我们的市场就是主战场 |
| 模块 v14 兼容 | 1,590 / 5,338(约 30%) | 生态在迁,但未过半 |
| Forge | 4 月时未推荐 v14 | Forge 用户群迁移被主动压制 |

### 1.2 破坏面修订(v1 B1–B12 的 M0 判定)

三条 headline(证据见登记册):

1. **B2 撤销**:"V14 移除 MeasuredTemplate"是误报——core 14.368 模板类健在,PoC-A 实测创建/渲染/删除全链可用。换 Region 的是 dnd5e 6.x 的放置产物(声明层 `target.template` 两版同构,内容不用改)。
2. **B8 大幅下修**:49 个 hook 中 48 intact、0 改名、1 死注册(`renderActorDirectory5e`);SDK 的 13 个 MidiQOL API 全部健在;midi v14 用"模板 + 同 id 背书 Region"双轨,`computeTargetsFromTemplates` 无需改写。注意三个动态派发陷阱会骗过静态 grep(登记册 hook-diff §0)。
3. **新增 N 系**(登记册 §3):v14 admin API 缩水(仅 `/api/status`,世界启动回归 options.json + **自动加载闸门要求 world.json verified ≥ core**)、POST 全域 CSRF(须带 Origin)、`DND5E` 全局 6.x 移除→`CONFIG.DND5E`、`forType(type, identifier)` 双参但单参兼容、**SRD 内容集漂移**(6.0.3 spells 320 条无 Hunger of Hadar;wizard 列表 204 vs 5.3.3 的 219)、**模块 pack 带 manifest+download 永不自动迁移**(2,449 条必须在 v14 管线重导)。

其余确认项:dnd5e schema 变更(AC 列表化/chat flags→system/senses 对象化/bloodied 百分比/activities API)源码逐项坐实,但我方命中极小(ac.calc 仅 catalogue 1 处 AE + SDK 6 处,chat 迁移键全仓 0 命中);advancement **API 完好**(`forNewItem`/`flowsForLevel` 运行时确认),仅 `#synthesizeSteps` 行为变化(逐级不跳步);Region PoC-B 判定 KD-3 **可行**(`polygonTree.testPoint({x,y},1)` 几何精确)。

### 1.3 依赖线兼容上限(官方 manifest 实测,登记册 §7)

| 档位 | 天花板 | 阻塞点 |
|---|---|---|
| 完整线原样(含 ActiveAuras + times-up) | **FVTT 13.351 + dnd5e 5.3.3(= 当前基线)** | ActiveAuras max 13;times-up 永无 v14 |
| 去 times-up(core+dae 吸收,作者背书) | 仍 core 13 | ActiveAuras |
| 再去 ActiveAuras(auraeffects 化,3–5 人天) | **FVTT 14.368 + dnd5e 5.3.3**(栈 A) | midi 钉 dnd5e ≤5.3.99 |
| dnd5e 6.x | 全线无人支持 | 等 midi `dnd6`(分支在途,9-15 有提交) |

替代路线已评估(登记册 §8):times-up 由 core + dae 14 官方吸收;ActiveAuras → auraeffects 化可行且更强(墙阻挡/best-formula/Region 原生),**最大 gap 是模板锚定光环(zone)需以自有成员追踪 + RegionBehavior 重建**;存量世界 AA flag 光环需转换(2,449 条自有 pack 受影响极小)。

### 1.4 midi-qol dnd6 在途信号

- `dnd6` 分支最后提交 **2026-09-15**(dnd5e 6.0 发布后 5 天);其 package manifest 上限仍 5.3.99(早期阶段);
- 社区工单 #1579(9-12)在催,作者知悉;
- 历史模式:`dnd3`/`v12dnd4`/`v13`/`v14`/`dnd6`——dnd5e 每次大版本 midi 都跟进(含 4.x activities 大重构),预期节奏为 manifest 放开 + 数周至一两个月 beta 抖动。

### 1.5 迁移演练实测(登记册 §1)

金本位 1.007GB 只读快照未污染;副本核心迁移 1 秒完成、系统迁移全量执行、**单向性坐实**(不可回 F13);`rulesVersion=legacy`(2014 线)迁移后保留;20 条旧 effect 校验拒绝(`auraeffects.aura` 类,装 auraeffects 2.1.1 后可能自愈,待验证);GM 空密码登录复现 F13 套路。

## 2. 暂缓期维持项(低成本,持续执行)

1. **v14 QA 栈保留**:`D:\apps\fvtt\foundryvtt-14.368` + 私有 Node 24.21.0 + `D:\FVTT_DATA_V14`(marker 闸门)+ 四模块,不删不升级,README 为准。
2. **AGENTS.md 隔离纪律持续生效**:F13 资产(`D:\FVTT_DATA`/30000 族/slot 0)只读;金本位只读;单向迁移红线。v14 世界副本(`cos-v14qa-20260921`)已被 dnd5e 6.0.3 迁移,仅作 6.x 观察用,**不可再用于栈 A 验证**(需另开金本位副本)。
3. **金本位刷新**:暂缓期内 COS 有实质变更或每月节点,重制快照(robocopy 约 1 分钟,代价极低)。
4. **观察哨(每两周,对应 §0 触发器)**:dnd6 manifest、Forge 推荐版本、ActiveAuras/times-up 后继动态、dnd5e 5.3.x 是否仍有修复、官方年报(2027-05)。
5. **F13 生产线正常推进**,不受本方案影响。

## 3. 重启手册(触发器命中后启用)

### 3.1 两级路径与修正估算

**栈 A(core 14.368 + dnd5e 5.3.3 + midi 14.0.12 + dae 14.0.14,去 times-up + auraeffects 化):**

| 里程碑 | 内容 | 估算 |
|---|---|---|
| M1′ pin/基建 | community-distribution core 换 14、Node 24 五平台、skills、intl 策展(栈 A 闭包) | ~1 周 |
| M2′ SDK/工具面@栈 A | 版本断言改造、webmcp verified 14、测试 mock 13.351→14.368(system 留 5.3.3);模板 action 不用重写 | 1–1.5 周 |
| M4′ auto2014@栈 A | 删死注册、旧 effect 清洗工具、**auraeffects 化(3–5 人天)+ times-up 移除验证**、QA farm v14 槽 + 70 快照重跑 | 1.5–3 周 |
| M5′ 发布 | desktop 0.6.x、COS 生产世界栈 A 迁移演练(备份先行) | ~1 周 |
| **合计** | | **4.5–6.5 人周** |

**M6(dnd5e 6.0.x 系统迁移,主触发器 T1 后):**pack 按 6.0.3 重导(2,449 条,含 SRD 内容集漂移双口径 parity)、SDK `ac.calc→calcs`/`DND5E→CONFIG.DND5E`、region 映射落地(KD-3 已验证)、advancement 行为回归、战斗链路对 midi dnd6 联调。估 **3–5 人周**。M6 中不依赖 midi 的工单(pack 重导、SDK 字段面)可在触发前预备性开工。

### 3.2 既有设计决策(维持,细节见 v1 与登记册)

- 双线并行:F13 0.5.x 维护线 + v14 0.6.x 线;单应用 + 代际环境 profile 产品形态(年报长尾数据坐实)。
- KD-1 硬切开发线;KD-2 断言改 generation+最低版;**KD-3 已验证可行**(Region 可覆盖模板 AoE,契约保留);KD-4 pack v14-only 重建;KD-5 intl 双线策展;KD-6 Node 24 选版;KD-7 研究参考升级。
- 验收纪律:每里程碑 DoD、benchmark 重落、验收记录归档,以登记册 §4/§6/§7/§8 工单为执行清单。

## 4. 变更记录

- 2026-09-21 v2:M0 完成,并入全部调研数据;评审结论由"两级迁移、栈 A 先行"改为**暂缓执行、触发器制重启**;执行计划转为重启手册。
- 2026-09-21 v1:总体技术方案(双线策略、六里程碑 WBS、B1–B12 破坏面)。
