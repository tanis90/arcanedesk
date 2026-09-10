# DeepSeek灰度模型补充小测

2026-09-09。Qwen3.7-plus仍为主基线；本轮仅旁路试跑用户指定 `deepseek-v4.1-flash-expires-on-0910`，不替换默认模型、不合并供应商速度统计。

预登记：本地COS、同一法师NPC题、相同17工具、NPC指南与查包指南，一对无规则skill→有规则skill，thinking high、180秒硬上限和120秒体验目标；沿用9项验收，不重放失败任务。候选增加规则目录与读取路由，比较入口 `--comparison=rules-ablation --samples=1 --cases=npc_wizard`。

独立私有profile `arcane-prep-play-deepseek-gray-qa`，API key通过既有safeStorage加密保存，不进仓库。Qwen profile保持原样。正式任务前一次最小连通探测：POST https://api.deepseek.com/chat/completions，显式 `thinking.type=enabled`、`reasoning_effort=high`，200，返回精确模型名且有reasoning_content，562ms。此探测不计入任务耗时。

Pi已有按DeepSeek endpoint识别的thinking及reasoning_content回传适配，测试配置标记model.reasoning=true，未改生产适配。基准记录器补充记录实际payload.thinking，仍只读观测；真实任务请求配置以结果为准。一般接口语义参考[DeepSeek思考模式官方文档](https://api-docs.deepseek.com/guides/thinking_mode/)，灰度模型能否接受参数以实测为准。

两条已完成。原报告 `benchmark-1788931373311.json`，关键数据及会话索引见[结果JSON](prep-deepseek-gray-pilot-results.json)。历史Qwen对照见[三对规则消融记录](prep-rules-ablation-results.md)，其供应商与采样时段不同，不能将差异都归于模型本身。

| 配置 | DeepSeek耗时 | 调用 / 模型工具轮次 | 原9项验收 | Qwen历史耗时（每臂3次） |
| --- | --- | --- | --- | --- |
| 无规则skill | 53.08秒 | 17 / 14 | 通过 | 117.60、154.05、151.54秒，均通过 |
| 有规则skill | 121.61秒 | 30 / 23 | 通过 | 180.01超时、180.02超时、135.16秒通过 |

本次DeepSeek两条都在180秒内完成，只有无资料条在120秒内完成。实际每次请求均 `thinking.type=enabled`、`reasoning_effort=high`。Qwen仅有thinking开关，high不代表两家相等的思考预算。工具/runtime、指南、规则目录hash和同臂归一化system prompt均与Qwen对照一致；计时不包含前置连通探测。

无规则条读取NPC与查包指南；检索图片目录、创建后检查现有NPC施法数据、修正法术位，17调用无工具错误。用于施法比较的是伊娃夫人、卡西米尔和夜鬼婆。工具执行累计2.46秒，墙钟53.08秒，速度优势并非来自更少调用。

有规则条读取索引及Wizard/Human/Fireball，还用PowerShell定位规则内容，反复对比合集素材；创建后两次读回访问不存在的字段导致 `Cannot read properties of undefined (reading 'value')`。随后按名称找到已有对象继续检查，修正技能键与来源版本，没有重复创建。工具执行累计5.22秒；输出用量28605（供应商另报告reasoning18460），无规则条输出11439（reasoning5583），保留供应商原统计，不把reasoning再重复加到output。最终9项均通过，不代表完整职业规则认证。

发现一个世界隔离限制：有规则条显式读取前一条保留NPC的name/img/prototype图片/ring来找形象素材。该次调用未读取职业与法术位数据，但两臂并非独立世界快照；不能把当前结果视为完全隔离的消融实验。保持原始结果，不为此重跑或清理用户世界。

结论：此模型和官方接口组合值得保留为补充候选；单对显示完成速度有潜力，尚不能宣称稳定优于Qwen。规则skill本对增加68.53秒和13次调用，没有新增验收收益，与此前Qwen实验方向相似，但仍不足以否定规则知识库的普遍价值。Qwen继续作为主基线，本轮不扩大样本、不修改skill或auto pack。迭代同步到[唯一技术方案第21节](foundry-prep-play-technical-plan.md#21-deepseek灰度模型补充小测2026-09-09)。

## 补充人工审查：无规则条不能称为全对

用户追问完整正确性后，检查原始创建脚本、最终报告和验收快照：INT18、施法等级5、4/3/2法术位、四个戏法、HP32和已装备长棍均符合本次核心要求；HP32对应CON14按法师固定升级取值计算。仍发现以下未被九项检查覆盖的问题，不追改原评分：

- 未配置人类步行速度：创建输入没有movement，快照只有空的movement配置，未填人类30尺。
- 直接写CR5，但无挑战等级评估依据；五级施法者不能直接推导CR5。本次不另行给出未经评估的替代CR。
- 最终回复断言法术条目没有activities，实际快照中火球术有save活动、火焰箭有attack活动，属于模型读回理解或汇报错误，并非实际丢失活动。
- 未实跑施法或武器攻击，不声称整卡机制闭环；按用户约定不把完整PC职业构建或不稳定职业动作作为NPC本轮硬评分。

因此53.08秒的结论应表述为“核心九项通过、仍有未覆盖的配置遗漏及汇报错误”，不能表述为全对。人工审查不修改原始角色、原始报告或既定胜负。
