# deepseek benchmark 使用手册（matrix suite）

本文说明如何用 deepseek（provider `deepseek-for-benchmark`，model `deepseek-flash`）
跑备团工具 benchmark。当前主推 **matrix suite**（自由发挥车卡矩阵，spec 见
[foundry-prep-e2e-matrix-spec.md](foundry-prep-e2e-matrix-spec.md) §6）；旧的
catalog comparison（A/B 六案）命令相同、换 `comparison` 字段即可。

benchmark 比较同一模型两臂：`matrix_tool`（生产 prep 工具 + 三份 skill）vs
`matrix_js`（同 prompt，只有 browser_evaluate）。判定与臂无关：probe 期望 +
终态快照，全部检查选择无关。

## 1. 前置条件

1. **世界在线**：本地 COS 世界 `http://127.0.0.1:30002/game`，CDP 端口 9230，
   恰好一个已登录 GM 的 `/game` 标签页。模块须含 `arcane-agent-bridge` 与
   `arcane-dnd5e-2014-automation`（缺模块时工具调用会报
   `Unsupported direct action`）。
   - 注意隔离：**9233/30001 是另一窗口的 world（arcane-demo），不要碰**。
2. **QA profile**：`C:/qa/kimi-a3`。provider 的 baseUrl 与 key 通过应用界面
   预配置，加密存于 profile 的 ProviderStore。**不要把 key 写进 suite 配置、
   命令行或仓库。**
3. **依赖已构建**：从仓库根执行过安装与构建（desktop / foundry-sdk /
   fvtt-cli），本机有 Electron（可用 `ARCANE_QA_ELECTRON` 指定）。
4. **环境变量**（target `local-cos` 默认指向本机 30000/COS 世界，必须覆盖）：
   `ARCANE_FVTT_ORIGIN=http://127.0.0.1:30002`、`ARCANE_FVTT_CDP_PORT=9230`。
   目标世界 id 不是 `COS` 时（如 docker qa-farm 的世界）再加
   `ARCANE_FVTT_WORLD_ID=<世界id>`——fixture 守卫会校验 `game.world.id`。

## 2. 三步跑法

### ① 生成 fixture 报告（世界隔离对象 + 切到测试场景）

```bash
ARCANE_FVTT_ORIGIN=http://127.0.0.1:30002 ARCANE_FVTT_CDP_PORT=9230 \
  node apps/desktop/test/setup-prep-benchmark.mjs --target=local-cos
```

输出形如 `{"status":"completed","output":".../prep-benchmark-fixture-<ts>.json"}`，
把 output 路径填进 suite 配置。fixture 里含世界 id/模块清单快照；世界重建或
模块大变后要重新生成。

### ② 写 suite 配置（例：`C:/qa/suite-v9-matrix.json`）

```json
{
  "fixtureReport": "C:/Users/yangqi/AppData/Local/Temp/prep-benchmark-fixture-<ts>.json",
  "outputDir": "C:/qa/batch-v9-matrix-<ts>",
  "comparison": "matrix",
  "taskTimeoutMs": 300000,
  "cases": ["A5", "A12", "C1"],
  "models": [
    { "profile": "C:/qa/kimi-a3", "provider": "deepseek-for-benchmark", "model": "deepseek-flash" }
  ]
}
```

- `cases`：matrix MVP 为 A5（高等精灵×战斗大师）、A12（高等精灵×塑能法师）、
  C1（狼人+战士 5）。省略则跑全部已定义案。
- `taskTimeoutMs`：单案上限 120000–300000ms。裸 JS 臂几乎总是顶到上限。
- `outputDir` 必须不存在：已有 manifest 的批次不会被重放，换目录名起新批。

### ③ 启动（先 dry-run 验证计划）

```bash
node apps/desktop/test/character-benchmark/run-suite.mjs --config=C:/qa/suite-v9-matrix.json --dry-run
ARCANE_FVTT_ORIGIN=http://127.0.0.1:30002 ARCANE_FVTT_CDP_PORT=9230 \
  node apps/desktop/test/character-benchmark/run-suite.mjs --config=C:/qa/suite-v9-matrix.json
```

run-suite 串行跑 `cases × models × 双臂`，每案一个 Electron 子进程，跑完自动
接 audit（只读复核）。单案单臂调试可直跑启动器：

```bash
node apps/desktop/test/run-prep-benchmark.mjs --qa-root=C:/qa/kimi-a3 \
  --qa-report=<fixture 路径> --target=local-cos --provider=deepseek-for-benchmark \
  --model=deepseek-flash --comparison=matrix --cases=A12 --samples=1 \
  --thinking=high --task-timeout-ms=300000 --arm-only=matrix_tool
```

（直跑也要带上面两个 env。matrix comparison 不要传 `--character-suite`。）

## 3. 结果怎么读

- `outputDir/manifest.json`：批次状态与每 trial 的报告路径、exitCode。
  js 臂验收不过/超时属预期，exitCode=1 不等于 harness 故障。
- `<profile>/benchmark-<ts>.json`：trial 全量（prompt hash、工具调用序列、
  usage、verification 明细）。`benchmark-<ts>-audit.json` 是同判定的只读复核。
- `<profile>/benchmark-<ts>/<sample>-<case>-<arm>/agent-trace.jsonl`：
  逐事件轨迹（模型思考、工具入参/回执、耗时），分析迭代数用它。
- 关键字段：`success`（终态判定全过）、`taskState`（completed/stopped）、
  `ms`、`tools.length`、`browser_evaluate` 计数（js 回退强度）、
  `verification.checks` 里 `ok:false` 的项。
- 矩阵案验收后**不自动删卡**（retainedForReview），世界里 `PB<runId>-*`
  命名的卡人工审查后手动清理。

## 4. 纪律（硬性）

1. **指纹冻结**：批次运行中修改任何被指纹的文件（适配器、fixture、skill、
   run-suite 等，清单见 run-suite.mjs）会触发 inputs-changed 中止。要改就先
   让批次结束。
2. **audit 不覆盖**：`audit-model.mjs` 拒绝覆盖已存在的 `-audit.json`。
   修正判定器后要重判：把旧 audit 改名存档（如 `-audit-v1.json`），用修正后
   的期望重跑 audit。期望重推导只读合集/怪物源，不碰模型建的卡。
3. **裸 JS 臂钉死**：同一模型+同一套案例的裸 JS 基线跑一轮即钉死存档，
   之后迭代工具只重跑工具臂。
4. **串行一个批次**：同一 QA profile 同时只跑一批（报告按文件名唯一识别）。

## 5. MVP 首轮数据（2026-09-17，deepseek-flash，3 案×双臂）

| 案 | matrix_js | matrix_tool |
|---|---|---|
| A5 战斗大师战士 5 | 超时 300s，50 调用（28 eval），缺子职业/种族条目 | 104s，18 调用（2 eval）；技能自选与种族固定熟练重复（判 fail） |
| A12 塑能法师 5 | 超时 300s，39 调用（37 eval），9 项检查全崩 | 54s，17 调用（0 eval），**全过** |
| C1 狼人+战士 5 | 超时 300s，73 调用（27 eval），卡未建成 | 62s，17 调用（4 eval），**全过** |

工具臂 2/3 全过、另一案是质量瑕疵而非错卡；裸 JS 臂 0/3 且全部顶满超时。
首轮发现并已修：判定器两处口径（种族固定技能熟练、NPC 体型骰 HP）曾误报
工具臂失败，修正后重判（旧 audit 已存档为 `-audit-v1.json`）。

## 6. 已知限制与后续

- 只覆盖 MVP 3 案；32 案全量待 `MATRIX_CASES` 补全（与 e2e 核心矩阵同构）。
- probe plan 若报 `uncoveredRequiredSteps`，该案 setup 直接失败（不适合自由
  发挥判定），先补工具覆盖再进矩阵。
- 单批 6 trial 约 20–30 分钟；挂后台跑即可，中途不要动被指纹的文件。

## 7. 下一步：32 案全量怎么跑起来

### 7.1 补全案例定义（纯数据，无新代码）

把 `matrix-model-adapter.cjs` 的 `MATRIX_CASES` 从 3 案扩到 32 案，与
`scripts/e2e-advance-matrix.mjs` 的核心矩阵同构（13 A + 18 B + 1 C）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `id` | e2e 同名 | A1–A13 / B1–B18 / C1 |
| `kind` | e2e `npc` | `"character"` 或 `"npc"` |
| `cls` / `subclassMatch` | e2e `cls` / `subclass` | subclassMatch 是对 probe 池 `candidateNames` 做 includes 的中文片段 |
| `race` / `raceName` | e2e `race` + 自配中文名 | raceName 只用于 prompt |
| `level` | 固定 5 | |
| `maxSpellLevel` | e2e 同名 | 0=不施法；圣武士/游侠/奇械师 2；全施法者 3 |

不需要 e2e 的 `primary`/`spells` 字段：自由发挥不 pin 属性分配，法术判定直接
读 probe 的 spellBudget（book/known/fullList 判定器已通用）。

注意三个别名坑（probe 池里的名字与通称不同）：A9 盗贼池里叫「盗贼 Thief」、
A13 炼金师叫「炼金师 Alchemist」、B 轴勇士叫「勇士 Champion」——includes
中文部分即可命中，无需特殊处理。

B 轴 18 种族中文名（prompt 用）：human 人类、variant-human 变体人类、
hill-dwarf 丘陵矮人、mountain-dwarf 山地矮人、high-elf 高等精灵、wood-elf
木精灵、drow 卓尔、lightfoot-halfling 轻足半身人、stout-halfling 壮心半身人、
forest-gnome 森林侏儒、rock-gnome 岩侏儒、half-elf 半精灵、half-orc 半兽人、
dragonborn 龙裔、tiefling 提夫林、tiefling-levistus 提夫林（勒维斯图斯）、
aasimar-mpmm 阿斯莫、kender-dsotdq 坎德人。

### 7.2 先跑 probe 自检，再开模型批次

扩完后先把 32 案的 setup（probe 建档 + plan 期望推导）全部干跑一遍——这步
不调用模型、只读合集，几分钟内暴露"哪些案 probe 不过"。把
`tmp-preflight-matrix.mjs` 的案例列表改成遍历 `matrixCaseIds` 即可。e2e
32/32 全绿已证明所有案 plan 可达 completed 且无未覆盖步骤，probe 预期全过；
若有不过的，先修工具/内容包，不要带病开批。

**在别的世界/实例上跑（如 docker qa-farm）时多三件事**：① 镜像世界里
`arcane-dnd5e-2014-automation` 必须已**启用**（装了≠启用，未启用时工具报
`Unsupported direct action`）；② 用 `ARCANE_FVTT_WORLD_ID` 覆盖世界 id；
③ arcane 内容包版本可能与开发世界有漂移——probe 期望按当下世界现算会吸收
大部分差异，但与历史批次横向对比时记得这个混杂变量。

### 7.3 跑批策略：双臂全量一次，之后只迭代工具臂

1. **基线批（钉死）**：32 案 × 双臂 = 64 trial。裸 JS 臂几乎必定顶满 300s
   超时，单批总时长约 4 小时，建议拆 3 批跑（A 轴 / B 轴 / C 轴各一个
   outputDir，cases 字段分批）。跑完裸 JS 臂永久钉死，不再重跑。
2. **迭代批**：之后每次改工具/skill 只重跑 `matrix_tool` 臂。suite 层不支持
   单臂过滤，用单案直跑（§2.③ 的 `--arm-only=matrix_tool`）或临时多模型
   空挂方式绕——更推荐前者，逐案快。
3. 结果汇总写回本文档 §5 表格，标注判定器版本（matrixVerifier.sha256 在
   报告里）。

### 7.4 预期会撞的边界（先知道，别当 harness 故障）

- **专长替代 ASI**：judge 的 `abilities.sum` 期望按"ASI 全加属性"算
  （asiPoints 来自 plan 的 asi-or-feat 槽）。自由发挥下模型可能选专长
  （尤其 B2 变体人类），属性总和会少 2 → 误报。届时决策：判定器接受
  "专长 item + 属性少 2"等价，或在 prompt 钉死"属性提升选属性"。
- **种族法术案**（B7 卓尔、B15/B16 提夫林）：fighter 无 spellBudget，法术
  检查块整体跳过，种族自带法术不计数——这是刻意放宽，不是漏洞。
- **A9 游荡者专精槽**：expertise 不进 skillPickCount（判定器已过滤
  `mode==="expertise"`），但熟练值 ≥2 的技能会被 skills.count 算作熟练——
  专精加倍后 value=2 仍计数一次，口径正确。
- probe 的怪物解析：本世界无 arcane 怪物包，C 轴固定回退 dnd5e.monsters。

### 7.5 扩展层（全职业×全子职业约 120 案）

等 32 案双臂数据稳定后再谈。前置：内容数据已知清单（e2e 扩展层登记的那些）
要先消化，否则模型会大量撞上空池/缺条目，测的是内容缺口而不是工具。
