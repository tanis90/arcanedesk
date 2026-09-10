# SRD 5.1 知识来源审查与组织提案

日期：2026-09-09。状态：来源调研与有限数据审查完成；现已按用户后续决定落地“SKILL.md索引 + 原文文件”，没有实现查询器，没有模型收益结论。下文第3—6节保留调研时提案；交付以第7节和唯一技术方案为准。

本提案承接[唯一技术方案](foundry-prep-play-technical-plan.md)中的 NPC 创建实验；实测元数据见[审查记录](srd-knowledge-source-audit.json)。此前“将 PDF 按章节拆分就能用”的建议没有来源检查依据，本文件替代该假设。

## 1. 查到了什么

本次通过互联网检索并浅克隆四个仓库，只读取文件，没有运行其安装或构建脚本。固定的 commit 在审查 JSON 中。没有必要先用 MinerU 重解析整本：已有可以直接审查的文本。官方 PDF 仍用来裁决疑点，不能由社区转换结果取代。

可复核脚本：[audit-srd-sources.mjs](../test/audit-srd-sources.mjs)。将四个仓库按 `5thsrd`、`5e-database`、`cc-srd`、`srd-builder` 命名放在同一目录，并检出审查记录中的提交，然后运行 `node apps/desktop/test/audit-srd-sources.mjs <该目录>`；结果写入该目录的 `audit-results.json`。脚本只读取候选资料并写审查结果，不安装或执行上游代码。字符/字节统计受换行约定影响，复核语义以表格值和源提交为准。

| 来源 | 实际检查到的结构 | 建议用途与限制 |
| --- | --- | --- |
| [vitusventure/5thSRD](https://github.com/vitusventure/5thSRD) | `docs/` 中976个 Markdown 文件，总计1,619,926字节，含索引/网站支持页；职业目录13文件、法术320、怪物318，均含 index。职业按文件，法术/怪物按条目；正文兼有表格和散文 | 第一候选文本底座。许可证声明 SRD 5.1 / CC BY 4.0；抽查表格可读，但不是完整验证的官方转录。不能直接将网站目录当成 agent 检索方案 |
| [5e-bits/5e-database](https://github.com/5e-bits/5e-database) | `src/2014/en/` 中分类 JSON：12职业、290等级记录（含子职记录，不能当成290个职业等级）、319法术、334怪物、6规则入口、33规则章节；用 index 与 API URL 相互引用 | 精确数据和交叉校验候选，可直接离线读取 JSON，不需运行 MongoDB 或 REST 服务。README 声明代码 MIT、底层资料 OGL；不是看到 MIT 就认为资料可无条件复制。纳入产品前单独核对许可与来源，不作为第一版必须打包的依赖 |
| [Tabyltop/CC-SRD](https://github.com/Tabyltop/CC-SRD) | 全书 HTML/TXT/JSON。JSON 为13,353个排版块，带 page、x/y、subelements；其中446个 table 类型块不等于446张完整规则表 | 可作为保留页位置信息的转录参考，不是已建好的实体知识库。首条 License 字段写 CC-BY-SA-4.0，而 Attribution/README 写 CC-BY-4.0，存在元数据矛盾，暂不直接采用 |
| [wolftales/srd-builder](https://github.com/wolftales/srd-builder) | 有规则抽取流水线、schema、fixture 和 provenance 清单；清单区分原文抽取、推导、人工补充及修正 | 可借鉴质量追踪方法。本次没有重建/验证发布数据。其 provenance 明确包含推导和作者增补，不能默认所有 JSON 字段都是 SRD 原文 |

官方底稿：[SRD 5.1 CC PDF](https://www.dndbeyond.com/attachments/39j2li89/SRD5.1-CCBY4.0License.pdf)，403页。官方文本索引中，PDF第52页有 Wizard 表，第53页继续 Preparing and Casting Spells。即使原文确有标题和表格，规则论述也跨页，按页切块会拆开依据；普通文本抽取还可能丢失表头的分组关系。没有声称已完成全书排版检查或逐页验证。本次未调用 MinerU CLI，因为找到了现成转换来源；后续疑点可对指定页使用已安装的 `mineru-open-api` 精确抽取并回看原页，不用全书 OCR 重做已有文本。

## 2. 已实际完成的抽查

- 读取 `5thSRD/docs/character/classes/wizard.md`：完整20行等级表，与 Preparing and Casting Spells、Spellcasting Ability、Spellbook、Arcane Recovery、子职内容同文件。约2614个英文空白分词，不能视为一个很小的提示片段。
- 读取 `spellcasting/what_is_a_spell.md`、`casting_a_spell.md`：分别约956、2310词。加上法师全文与 Fireball（143词）约6023词；“把相关章节全读一遍”仍然可能显著增加上下文。
- 上述四个文件没有 Markdown 链接，虽然正文含有对职业表、其他规则的自然语言引用。网站索引则使用 `/character/classes/wizard/` 一类根路径，离线 read 不能直接按这个路径读取。
- 法师表还存在 `3nd` 这样的排版/拼写瑕疵。该拼写不影响本次数字对比，但说明不能将转换质量视为已经验收。
- 对比 Markdown 与 JSON 中 bard、cleric、druid、paladin、ranger、sorcerer、wizard 的20级普通法术位表，1100个实际存在的列单元格无差异。比较方法：破折号按0，JSON 缺失施法字段按0；只比较 Markdown 中存在的环位列。没有比较邪术师契约魔法、兼职、特性或全部正文。两份社区资料可能共享来源，不能算两个独立官方证据。
- `5e-SRD-Levels.json` 的 `wizard-5` 明确列出1至9环的4/3/2/0/0/0/0/0/0；`Classes.json` 的 wizard 则包含施法说明、熟练项、装备选项与等级入口。这是分散在不同记录里的信息，不是读一个 class 对象就齐了。
- `5thSRD/.../monsters/mage.md` 和数据库的 `mage` 是具备九级施法能力的现成 NPC，CR为6；`classes/wizard` 是职业规则。这里说明的是本次抽查的2014资料，不能反推此前 benchmark 采用的2024 FVTT Mage 内容。
- 两库怪物数量不同（Markdown目录去掉index为317，JSON为334），本次没有逐项解释差集。不能直接拼接成更大的“官方全集”，也不能只凭条目数量判定哪份正确。

## 3. 第一版组织：保留原资料，建立可追溯的查询单元

倾向采用5thSRD的固定提交作为文本候选；用官方原文复核关键表格和疑点。5e-database暂作审查对照，不同时维护两套“最终答案”。暂不制作完整中文译本，不引入全量自动知识图谱、向量数据库或在线服务器。

以下是拟议构建产物，不是声称上游已有这些文件：

```text
rules/srd-5.1/
  source-manifest.json       # 仓库commit、源路径/hash、版本、署名与许可
  source/                   # 原始Markdown，只读、保留差异可追踪
  catalog.json              # 可查询单元目录、类型、名称、别名、正文位置
  sections.jsonl            # 按原始标题提取的正文及父标题，不生成规则摘要
  tables.json               # 表头/行标题/单元格/原文位置，不丢上下文
  relations.json            # 已确认的引用关系，注明原文引用还是人工导航
  corrections.json          # 局部纠错及其官方依据；不静默改source
  NOTICE.md
SKILL.md                    # 只讲如何查询、判定适用范围、核对实际结果
```

构建时从实际标题生成片段，但保留整个源文件可回读。同一表的表头、行标题、脚注是一个整体；“施法位”表要绑定所属职业及解释它的段落。不会按固定字数切断表格，也不会把全文每段都视为独立、无需上下文的规则。

目录中的名称要区分类型，例如：

```text
srd51:class:wizard                         职业 Wizard（中文别名：法师）
srd51:class:wizard:table:progression        原职业进度表
srd51:class:wizard:preparing-casting        原标题 Preparing and Casting Spells
srd51:monster:mage                         NPC数据块 Mage（不能当成职业）
srd51:spell:fireball                       法术 Fireball
```

中文别名只用于召回，不改英文原文。`法师` 必须允许召回 Wizard 与 Mage 两种类型，并在结果中标明差异；不能建立一个全局“法师=Mage”的映射。FVTT compendium UUID 另由素材搜索取得，规则资料不会假设某个世界安装了什么包。

原文引用与导航建议分开：原文明确“见Wizard表”可建立引用边；“创建施法NPC时建议一起看施法等级说明”是产品导航，不冒充规则事实。先只补验证任务需要的导航关系，不要求人工连完全部词条。遇到未解析引用应保留文本并标为 unresolved，不让模型以为所有依赖已齐。

## 4. Agent 最终读到什么

建议先做skill配套本地只读查询脚本，使用现有shell执行；不先增加模型工具数。两种操作足够验证：按类型/别名查候选；按稳定ID一次读取多个片段/表格行。直接命中的类型和名称允许同一请求返回正文，以减少“查目录→读文件→再查表”的往返。具体CLI/API仍待原型测试，不预设自然语言自动规划器。

例如模型提出“查看 Wizard 的等级5资源、准备规则和 Fireball”，返回的证据可以是：

```text
资料：SRD 5.1 / 2014，固定来源提交
对象：class Wizard；表格条件：Wizard level=5
字段：cantrips known=4；slots by spell level 1..9 = 4,3,2,0,0,0,0,0,0
附带：原表列名、该行、Preparing and Casting Spells原段落
另项：Fireball原条目及其法术等级
出处：各项源文件、标题、行范围、hash；未验证PDF页码不填写
范围提示：这是职业进度；不是任意Mage怪物卡、兼职或房规的通用模板
```

这里只展示结果的组织方式，不新增一条手写“五级法师答案”。数字应从经过检查的表格读取，段落应从source截取。查询器不生成“这个NPC完全正确”的结论，模型仍负责判断规则是否适用于DM请求，并独立比较FVTT实际状态。

资源包大小由实际基准决定。本次四篇整读约6023词说明有压缩读取范围的必要，但不能现在承诺某个token预算一定够。超预算必须显式返回剩余片段ID或分页；不能静默截掉限制条件。片段缺少解释时可展开完整父章节。

## 5. 不能忽略的复杂度

1. **适用范围先于数值。** 用户已选NPC卡，不能因此强制补齐玩家职业升级流程。施法等级、角色等级、CR、法术环位分别是什么，以及本次需求借用哪部分职业规则，要显式区分；不要为获得+3熟练加值擅自把NPC改成CR5。
2. **条件与例外。** 普通施法、契约魔法、兼职、天生施法不同。仅抽出“某等级→某行”可能在其他场景应用错误；返回表格所属机制与相关条件，不用一个通用slots表覆盖所有对象。
3. **来源覆盖不等于游戏全部规则。** SRD遗漏的扩展内容不可由模型默补为“SRD规定”；世界素材、房规和扩展来源另标范围。SRD里的专有名词也不一定对应当前模块中的双语标题。
4. **转换质量。** 表头位置、跨页段落、破折号与数字、网站额外metadata和根链接均需处理。检测到冲突要回官方原文，并记录纠错依据。单次schema合法或多个库相同，不等于内容正确。
5. **维护成本。** 固定提交，更新时按差异审查受影响条目、关系及表格。保留已知未验证区域，不建立“整个库已正确”的假象。
6. **模型使用行为。** 可查并不意味着会查，读到也不意味着理解。必须记录查询与依据、错误修复、误改正确数据、上下文和耗时，不能只测命中率。

## 6. 如何证明有用，然后再扩展

先将现成资料作为候选整体快照登记，但仅将验证过的查询单元标记 verified。未逐项验证的正文仍可检索，明确其转录状态，不能用“verified=false”表示规则本身无效。

第一阶段测试数据与检索，不操作世界：

- 对普通职业进度表、契约魔法与兼职各抽不同等级，验证表头/行值及适用对象，扩展覆盖用例不能都围绕法师5级。
- 对 Wizard / Mage 的同名混淆、已知法术 / 准备法术 / 法术位的区别做查询测试。
- 校验索引与文件位置、批量取文、引用未解析时的披露、长输出不静默截断。
- 将模型看到的错误配置与正确配置混合，要求指出支持判断的来源：不能只奖励“发现错误”，还要统计把正确数据改坏的情况。

第二阶段接回原NPC创建benchmark：冻结模型/供应商/思考参数；同工具、同题目与验收，对照有无规则资料。生产查包skill在两臂保持一致，避免把搜索路由与规则知识同时改动。三对交错只能作为初筛，保留全部失败；成功率、120秒内成功率、规则读取成本和总往返一起看。

第三阶段才扩大覆盖/优化查询入口。若准确率没有改善，先区分“未查询、未召回、误解、误写、误恢复”，不要盲目增加资料或继续裁剪skill。当前没有授权的新自动迭代goal，也未开始付费模型实验。

## 7. 实际交付：索引skill，不封装查询器

用户后续决定先使用现有PowerShell/read查询，明确要求SKILL.md既是index，也说明如何查。已新增[arcane-dnd5e-rules](../skills/prep/arcane-dnd5e-rules/SKILL.md)，通过现有prep bundle分发；revision由8递增到9，App包校验名单同步加入新skill。没有生产工具或模型接口变化。

- 入口提供中文分类索引、12职业和9种族路径，以及施法、装备、NPC、状态与通用规则导航；共55个本地Markdown链接。名称与描述通过既有skill loader可发现。
- 954份英文规则正文，共1,576,337个UTF-8字节，来自上述固定5thSRD提交。只标准化LF、排除index/search/privacy网站页面、将monster_rules.md中3个网站导航根链接改成绝对URL。原文数值、表格和规则段落不重写。授权署名随包保留在NOTICE.md。
- 没有照搬上游需要建站生成的目录链接，没有自定义规则JSON、检索脚本、向量库或LLM答案摘要。使用一次shell合并查找，随后read真实路径；支持环境已有rg，不要求安装。
- 入口明确区分Wizard/Mage、角色等级/施法等级/CR，保留DM设定和NPC范围，鼓励按规则依据检查实际数据。不会因资料中收录休息或职业规则而新增操作接口。
- 构建审计数据[源文件清单](srd-skill-source-manifest.json)留在docs，不随skill占用运行时空间。文件hash按LF规范化，后续更新需更新来源、审查差异并递增bundle版本，不能悄悄覆盖规则正文。
- 新增测试检查954个正文hash、所有本地链接、tar分发迁移完整性，以及真实Pi技能发现只返回一个skill、提示词不包含规则正文。实际模型是否会查、读对和提速仍需独立benchmark；此前pack-skill实验入口不会自动获得本规则skill，比较时应显式记录注入配置。
