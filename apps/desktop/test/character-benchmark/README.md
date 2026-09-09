# 职业成长 benchmark

六题：A组纯车卡，B组怪物追加职业。Qwen/DeepSeek首轮24次尝试及审计已完成；操作方法见[使用手册](../../docs/prep-character-benchmark-manual.md)，结果见[首轮报告](../../docs/prep-character-pilot-results.md)。

## 入口

- run-suite.mjs --config=<私有配置> --dry-run：检查24试次的串行计划，不调用模型。
- run-suite.mjs --config=<私有配置>：调用真实AgentHost/Pi，终止后只读审计。
- run-review.mjs：首次创建v3六张参考卡；已有回执仅用 --verify-only。
- audit-model.mjs <原报告>：只读保存终止试次快照，保留原报告。
- regrade-v3.mjs <manifest> --out=<JSON>：重判原快照，不重跑模型。
- render-pilot-results.mjs <重判JSON> <输出MD>：生成固定24组合首轮表。
- audit-pilot.mjs <manifest> <重判JSON>：核对完整性和指纹。

## 数据与版本

cases.cjs保存实际任务正文与参考卡的一组选择；模型只通过adapter获取任务、来源UUID和唯一名称，不获得参考答案。skill/SKILL.md提供两臂共用默认。对照组仍有搜索、授予物品、图片等工具；候选只多foundry_build_query。

新运行默认v3验收与任务默认，300秒硬上限、120秒体验目标。verify.cjs保留v2原判定，verify-v3.cjs为当前判定；报告记录版本与hash。audit按原报告选择判定版本，修订评分用独立regrade。

history/character-skill-v2.md与history/pilot-controls-v2.json保存首轮旧输入和超时调整证据，不再参与新运行。首轮四次180秒、其余300秒，不混算。run-pilot.mjs是该历史批次的一次性编排，勿用它启动新实验。

sources.json定位参考来源；source-aliases-v3.json保存已审核能力来源；spell-metadata.json保存319条固定SRD5.1元数据。规则数据只用于验收，不额外注入模型。runtime.cjs创建器已修正技能关联属性并使用体型骰追加HP；新参考卡为v3，旧卡不覆盖。

## 检查

~~~powershell
node apps/desktop/test/character-benchmark/policy.test.mjs
node apps/desktop/test/character-benchmark/verify-v3.test.mjs
node apps/desktop/test/character-benchmark/adapter.test.mjs
node apps/desktop/test/character-benchmark/verify-review.test.mjs
node apps/desktop/test/character-benchmark/verify-v3-preservation.test.mjs
~~~

前3项可离线运行；后2项需本机v3参考快照，首次先运行run-review。可用 --artifacts 指定归档目录。历史v2回归可用 verify-review.test.mjs --verifier=v2，不能将旧正例通过当成v3通过。

通过表示已编码配置满足，非全功能自动化认证。法术逐级获取分布只作诊断；未知来源、语言、完整装备组合和实际职业动作须单列人工审查。CR重评未实现，auto pack不改动。

[任务合同](../../docs/prep-character-benchmark-cases-v1.md) · [验收修订](../../docs/prep-character-benchmark-audit.md) · [唯一技术方案](../../docs/foundry-prep-play-technical-plan.md)

最新输入版本：character-v4-source-query-defaults，共用skill已统一完成标准，foundry_build_query v2返回实际导入来源并支持选定子职；验收器仍为v3。旧首轮结果不能代表这一版的模型表现，详见技术方案第28节。
