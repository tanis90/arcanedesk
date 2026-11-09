# A3 验收 diff 与 trace 复核（2026-09-14）

本分析读取已保存的两臂原始 trace、首次只读 audit、Actor 快照、模型实际读取的 skill。没有重跑模型、修改测试角色或覆盖原始评分。原报告把 feature 检查失败解释为“缺少特性”不准确：存在性、来源身份与实际可用性必须分开。

## 验收失败到底是什么

| 项目 | 快照中的实际内容 | 失败机制 |
|---|---|---|
| Spellcasting | 两臂都有“施法（牧师）”，identifier=spellcasting-cleric | 验收期待 spellcasting，且来源别名依赖 compendiumSource；不能解释成未导入 |
| Channel Divinity / Turn Undead | 两臂都有对应 feat | `_stats.compendiumSource=null`，来源身份检查失败；不是存在性失败 |
| Disciple of Life / Preserve Life | 两臂都有对应 feat，保留活动/宏数据 | 来源 identifier 为空，导入后 compendiumSource 也为空，验收无法匹配 |
| Bonus Proficiency | 两臂 armorProf 都含 hvy；工具臂的 Life Domain 原生 Trait advancement 也明确授予 armor:hvy | 验收要求独立 bonus-proficiency feat；该来源以 Trait 表达，表示方式未被接受 |
| Channel Divinity 使用次数 | 两臂均 max="", spent=0, effective value=0；工具臂同时验证 class scale=1 | 这是实际资源配置未完成，不只是来源匹配问题 |

`verify-v3.cjs` 的 feature 检查把存在、UUID/别名和 description 合并为一个布尔值；`features.level-ceiling` 又仅检查能由 compendiumSource 识别的别名。JS 角色实际额外导入了 Blessed Healer，子职 advancement 明确其 level=6，但该检查仍通过。这说明当前评分同时存在表示方式误判与漏判。

两臂的复制函数都是原生 getDocument/fromUuid → toObject → Actor.create(items)。没有调用 foundry_actor_grant_items，也没有在复制函数里显式写入来源 UUID。快照证明 compendiumSource 为 null；skill 虽要求 preserve，却没明确源文档的 toObject 不保证携带可用来源标记。缺失来源身份应单独评分，而不是报告为“能力不存在”。

## 工具臂：明确看到问题，却把来源保留当成不修复的理由

- sequence 43（13.3s）：查询 Life Domain detail，并按 cleric/life-domain/level 3 查询 classFeature list。
- sequence 113（102.5s）：用已查到 UUID 创建 Character，包含职业、子职、种族、6 个职业/子职 feat。
- sequence 137：回读每个 Item 的 uses；Channel Divinity 显示 max 空、value 0。
- sequence 140（153.1s）：已注意到该资源异常，并开始检查 scale。
- sequence 142：读到 scale.cleric.channel-divinity.value="1"，而 cdItem.max=""、value=0。职业 scale 存在，并不会自动把一个空 uses.max 接到该 scale。
- sequence 144（168.9s）：模型根据 list 返回确认源 Channel Divinity 缺少 max，认为补 uses.max 会“发明来源配置”，选择保留空值并披露限制。
- sequence 167（200.8s）：以完成状态结束，最终报告明确写出未添加 uses.max；没有满足 benchmark 的 full resources。

这是一次错误的完成判断：来源结构应保留，但具体任务已要求资源配置完整。源模板缺少资源连接不代表任务不需要资源。后续应验证并说明如何在导入副本上使用原生 uses.max 连接已有 scale，以及验证实际消耗目标；本分析未执行战斗，不宣称消耗自动化已证明。

## JS 臂：查内部实现耗时，角色创建太晚，修复未完成

- 约 35–73s 反复检查 AdvancementManager、apply、自动执行与私有流程。
- 约 82–138s 继续查 HP preparation、CharacterData 和 HP advancement 格式。
- 约 170–213s 检查 MappingField、技能、工具等字段结构。
- sequence 197（230.4s）才执行 Actor.create。
- 约 239–270s 发现技能数据异常并回读；第 300s 超时停止，修复尚未执行。

最终快照：ins/rel 的 ability 为 dex；速度 0；spellcasting 为空；法术位 max 已原生得到 4/2，但当前 value=0/0；法术 attack/DC=2/10。HP 30/30 已正确。另有漏判：额外导入 level 6 的 Blessed Healer，且把矮人毒素抗性写进 di（免疫），而非 dr（抗性）。

## 实际 skill 中的错误承诺

模型实际读取的 arcane-actor-update SKILL.md 第 37–40、52 行说省略 skills[key].ability 后系统会按 CONFIG 初始化。两臂恰好对显式传入的技能对象只写 value，随后这些技能成为 dex；未显式传入的其他技能仍正常。工具臂核对 CONFIG med=wis、rel=int 后进行了修复，JS 臂没来得及完成。不能归因于世界刻意破坏 CONFIG，也不能继续把“整个技能对象省略”和“传入部分技能对象但省略 ability”视为同一种默认行为。

同一 skill 第 16、55 行笼统承诺 HP/资源由系统处理；Character guide 则要求先配置 HP advancement 和来源依赖，却缺少可直接照做的原生字段例子。模型因此重新阅读源码，并在“保留来源”与“补齐资源”之间反复推测。benchmark 自身明确要求 full resources，模型的最终选择与该要求冲突。

## 时间与工具证据

JS：49 次 browser_evaluate，累计工具执行约 2.85s；全部工具累计约 3.05s，任务总计 300s。

工具臂：17 次 search、3 次 list、4 次 detail、16 次 browser_evaluate；catalog 累计约 4.15s，browser_evaluate 约 2.41s，全部工具累计约 6.62s，任务总计 200.8s。

这些是 trace start/end 的累计耗时（并行调用会相加），不是精确的用户墙钟分解。它们足以说明本次执行中浏览器/查询工具没有占据时间大头；剩余主要是模型/provider 生成、等待和回合调度，不能仅凭该日志再拆成模型纯思考秒数。

本轮 A3 工具臂确实更接近完成：正确筛掉 6 级特性，并完成技能/速度/HP/法术位的修复。两臂仍失败，但不能用未经拆分的 feature 失败数证明工具没有帮助。更不能把仅新增 catalog 查询工具的本轮结果称为 grant/import 写工具的效果。

## 原始证据

以下为作者本机的 benchmark 产物路径（临时目录，不随仓库分发，仅留档备查）：

- js trace: `C:/Users/yangqi/AppData/Local/Temp/deepseek-character-benchmark-20260914/benchmark-1789362688330/0-A3-native_skill_catalog_js/agent-trace.jsonl`
- js snapshot: `C:/Users/yangqi/AppData/Local/Temp/deepseek-character-benchmark-20260914/benchmark-1789362688330/audit/A3-native_skill_catalog_js-snapshot.json`
- tool trace: `C:/Users/yangqi/AppData/Local/Temp/deepseek-character-benchmark-20260914/benchmark-1789363280479/0-A3-native_skill_catalog_tool/agent-trace.jsonl`
- tool snapshot: `C:/Users/yangqi/AppData/Local/Temp/deepseek-character-benchmark-20260914/benchmark-1789363280479/audit/A3-native_skill_catalog_tool-snapshot.json`
