# 六题职业成长 benchmark 首轮结果

24 次既定试跑已终止并只读审计：6题 × 2模型 × 2臂，每组合一次。下表为统一 v3 验收器对原快照的重判，没有重跑模型、没有替模型修卡。

通过仅指已编码配置检查及按时完成；不认证完整起始装备、语言和实战自动化。详见[使用手册](prep-character-benchmark-manual.md)、[验收修订记录](prep-character-benchmark-audit.md)与[逐项JSON](prep-character-pilot-regrade-v3.json)。

供应商错误 1 次，超时 4 次，均保留为原始尝试，没有重放到成功。供应商错误不能归因于模型车卡能力。

## 逐题结果

每格为“秒 / 调用数 / 自动通过”。Qwen、DeepSeek 均 thinking high。A1 四次上限180秒，其余300秒，体验目标120秒。超时耗时是截断值，不是完成耗时。

| 题目 | Qwen JS | Qwen 查询工具 | DeepSeek JS | DeepSeek 查询工具 |
| --- | --- | --- | --- | --- |
| A1 | 180.0 / 15 / 超时 | 180.0 / 9 / 超时 | 164.3 / 31 / 通过 | 146.7 / 26 / 未通过 |
| A2 | 184.9 / 15 / 未通过 | 300.0 / 14 / 超时 | 121.6 / 20 / 未通过 | 141.3 / 30 / 未通过 |
| A3 | 300.0 / 16 / 超时 | 260.7 / 18 / 未通过 | 104.9 / 20 / 未通过 | 110.6 / 22 / 未通过 |
| B1 | 226.3 / 17 / 未通过 | 221.0 / 16 / 未通过 | 118.5 / 25 / 通过 | 145.5 / 22 / 通过 |
| B2 | 199.5 / 14 / 未通过 | 142.0 / 12 / 未通过 | 105.2 / 26 / 通过 | 133.6 / 16 / 通过 |
| B3 | 270.9 / 18 / 未通过 | 291.4 / 16 / 未通过 | 143.5 / 24 / 通过 | 97.6 / 19 / 供应商错误 |

## 按上限和任务类型分组

| 模型 | 组/上限 | 臂 | 自动通过 | 120秒内通过 |
| --- | --- | --- | --- | --- |
| Qwen | A1/180秒 | JS | 0/1 | 0/1 |
| Qwen | A1/180秒 | 查询工具 | 0/1 | 0/1 |
| Qwen | A2–A3/300秒 | JS | 0/2 | 0/2 |
| Qwen | A2–A3/300秒 | 查询工具 | 0/2 | 0/2 |
| Qwen | B/300秒 | JS | 0/3 | 0/3 |
| Qwen | B/300秒 | 查询工具 | 0/3 | 0/3 |
| DeepSeek | A1/180秒 | JS | 1/1 | 0/1 |
| DeepSeek | A1/180秒 | 查询工具 | 0/1 | 0/1 |
| DeepSeek | A2–A3/300秒 | JS | 0/2 | 0/2 |
| DeepSeek | A2–A3/300秒 | 查询工具 | 0/2 | 0/2 |
| DeepSeek | B/300秒 | JS | 3/3 | 2/3 |
| DeepSeek | B/300秒 | 查询工具 | 2/3 | 0/3 |

## 未通过项

| 模型/题目/臂 | 硬检查未通过项 |
| --- | --- |
| Qwen A1 JS | 超时；actor.exists |
| Qwen A1 查询工具 | 超时；class.level, feature.evocation-savant, features.level-ceiling, hp.full, movement.walk, saves.granted, skills.selected, spells.prepared |
| DeepSeek A1 查询工具 | skills.abilities |
| Qwen A2 JS | class.level, class.subclass, feature.martial-archetype, features.level-ceiling, abilities.legal, hp.full, movement.walk, saves.granted, skills.abilities |
| Qwen A2 查询工具 | 超时；feature.extra-attack, abilities.legal, saves.granted, skills.selected, skills.abilities |
| DeepSeek A2 查询工具 | skills.abilities |
| DeepSeek A2 JS | movement.walk, skills.abilities |
| Qwen A3 JS | 超时；class.level, abilities.legal, hp.full, movement.walk, saves.granted, skills.abilities, spells.caster, spells.cantrips, spells.book, spells.prepared, resource.channel-divinity, armor.effective |
| Qwen A3 查询工具 | abilities.legal, saves.granted, skills.selected, spells.cantrips, spells.book, spells.prepared |
| DeepSeek A3 查询工具 | skills.abilities |
| DeepSeek A3 JS | saves.granted, skills.abilities, resource.channel-divinity |
| Qwen B1 JS | feature.extra-attack, saves.granted, skills.selected |
| Qwen B1 查询工具 | feature.extra-attack, saves.granted, skills.abilities |
| Qwen B2 JS | skills.abilities, skills.expertise |
| Qwen B2 查询工具 | saves.granted, skills.selected, skills.expertise |
| Qwen B3 JS | feature.evocation-savant, saves.granted, skills.selected, resource.arcane-recovery |
| Qwen B3 查询工具 | feature.evocation-savant, feature.sculpt-spells, abilities.increment, saves.granted, skills.selected, spells.book, spells.prepared |
| DeepSeek B3 查询工具 | 供应商错误；saves.granted, skills.selected |

## 解读边界

- 原 v2 的来源识别、NPC种族和复制内容检查存在误判；最终表不使用其原始通过数。
- 技能关联属性是旧验收和部分参考卡共同遗漏的真实问题。数量正确不代表技能加值正确。
- 用户修订后，法术书逐级获取分布只作为诊断，不因三个三环法术拒绝五级法师。总数、职业列表、最高环阶、准备数、法术位和火球活动继续检查。
- 每组合一次且供应商不同，只能用于定位问题。不能据此宣布查询工具稳定提速，也不能把跨供应商延迟当模型能力。
- 本轮模型输入仍是冻结的 v2 共用默认；新默认 skill 已同步用户放宽口径，后续运行须作为新输入版本记录。历史180秒超时不补跑、不改记300秒。

## 复现与证据

所有试次 thinking：high。工具臂实际查询调用数：A1/Qwen=1，A1/DeepSeek=1，A2/Qwen=1，A2/DeepSeek=1，A3/Qwen=1，A3/DeepSeek=2，B1/Qwen=1，B1/DeepSeek=1，B2/Qwen=2，B2/DeepSeek=1，B3/Qwen=1，B3/DeepSeek=1。

验收器 SHA256：031b1079ff07a2b5aa62eb4a41ae807034960b9097e754d44fb7f08cfc91ba1f。逐项JSON保留快照、输入和规则元数据指纹以及Actor ID。原始报告、终止快照和会话轨迹存于私有 profile，按手册归档，不提交凭据。
