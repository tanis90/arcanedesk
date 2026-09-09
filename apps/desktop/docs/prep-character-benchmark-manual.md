> 当前新批次：输入 character-v7-reviewed-growth，查询 v6，默认验收 v4，300秒、thinking high。下面旧v3参考卡命令用于历史控制；新模型通过model-adapter自动使用v4。v2/v3验收文件保留原样，不能把旧结果冒充新批次。
>
> 新增必跑检查：`node apps/desktop/test/character-benchmark/verify-v4.test.mjs`。v4只新增经审核的塑能学者子职描述等价表示，须同时有准确来源、标题和规则内容；伪造来源、删规则、错误职业不能通过。
>
> 本机新批次配置：`$env:TEMP\character-reviewed-v7-config.json`（无密钥）。启动：`node apps/desktop/test/character-benchmark/run-suite.mjs --config="$env:TEMP\character-reviewed-v7-config.json"`。加`--dry-run`只列计划，不调用模型。现配置为六题×两模型×两臂，共24次，Qwen基线/DeepSeek对照。运行中修改已冻结输入会暂停；不得覆盖已有manifest或自动重跑失败试次。

# 职业成长 benchmark 使用手册

这套 benchmark 比较“相同 skill + 原生 JS 查询”和“相同 skill + foundry_build_query”，两臂保留相同写入能力。A 组纯车卡、B 组怪物追加职业，各三题。默认开启 thinking high。它测试实际 AgentHost/Pi 会话在 FVTT 中产出的卡，不用伪造模型回复。

首轮 24 次试跑与只读审计已完成，包含 4 次超时和 1 次供应商错误。新运行默认使用 v3 验收与任务默认；原 v2 判定器和输入保留，整轮快照已统一重判。结果见[首轮报告](prep-character-pilot-results.md)。详见[任务合同](prep-character-benchmark-cases-v1.md)、[验收修订记录](prep-character-benchmark-audit.md)、[唯一技术方案](foundry-prep-play-technical-plan.md)。

## 1. 环境准备

本轮验证环境为 Windows、本地 COS、Foundry 13.351、dnd5e 5.3.3，使用原生 2014 合集及 arcane-dnd5e-2014-automation。当前脚本的世界保护固定为 COS；其他世界须显式适配并重新验证，不能只改 URL 就当成同一环境。

1. 从仓库根目录执行命令，安装项目依赖并按仓库步骤构建 desktop/SDK/fvtt-cli。需要本机 Electron；可用 ARCANE_QA_ELECTRON 指定已有 Electron 可执行文件。
2. 用受控 Chrome 打开 http://127.0.0.1:30000/game，CDP 9230，登录 GM。使用试验世界，运行会创建角色和隔离场景，不在实际游戏进行时运行。
3. 为两个供应商准备独立私有测试 profile，通过应用既有 ProviderStore 保存加密凭据。不要把 API key 写进 benchmark 配置、命令行或仓库。
4. 准备环境 fixture 报告。已有对象仍有效时复用；首次运行可用以下命令创建隔离对象并切到测试场景：

~~~powershell
node apps/desktop/test/setup-prep-benchmark.mjs --target=local-cos
~~~

记录输出的报告路径。模型配置例中的 provider ID 是私有 profile 内的标识，须与本机实际配置对应。

## 2. 先验证参考卡与验收器

~~~powershell
node apps/desktop/test/character-benchmark/policy.test.mjs
node apps/desktop/test/character-benchmark/verify-v3.test.mjs
~~~

第二条使用仓库内真实脱敏快照，离线验证 auto pack/NPC 表示、真实技能错误，以及伪造来源、越级、资源耗尽、法术列表和攻击活动等反例。

需要新建参考卡时：

~~~powershell
node apps/desktop/test/character-benchmark/run-review.mjs --run=character-review-20260909-v3
~~~

默认写入本机 TEMP 下同名目录，保存六张卡的回执、只读快照和逐项检查。已有回执必须只读复核：

~~~powershell
node apps/desktop/test/character-benchmark/run-review.mjs --run=character-review-20260909-v3 --verify-only
~~~

创建后运行以下回归（默认读取上述 v3 目录）：

~~~powershell
node apps/desktop/test/character-benchmark/verify-review.test.mjs
node apps/desktop/test/character-benchmark/verify-v3-preservation.test.mjs
node apps/desktop/test/character-benchmark/adapter.test.mjs
~~~

可用 --out 指定归档位置、--cases=A1 指定尚未创建的题、--port 指定 CDP。写入失败时先查世界中的 benchReview runId/caseId 和日志；没有回执不代表没有创建，禁止直接重放。旧 v1/v2 卡和回执保留，不能覆盖成新版本结果。

参考卡是用来审查验收标准的样例，不是提供给模型的答案。模型会话禁止读取其他 benchmark 卡。

## 3. 完整模型批次

私有 suite.json 示例（不含凭据）：

~~~json
{
  "fixtureReport": "C:/qa/fixture.json",
  "outputDir": "C:/qa/character-run-001",
  "taskTimeoutMs": 300000,
  "models": [
    {"profile": "C:/qa/qwen", "provider": "qa-aliyun-token-plan", "model": "qwen3.7-plus"},
    {"profile": "C:/qa/deepseek", "provider": "qa-deepseek-gray", "model": "deepseek-v4.1-flash-expires-on-0910"}
  ]
}
~~~

~~~powershell
node apps/desktop/test/character-benchmark/run-suite.mjs --config=C:/qa/suite.json --dry-run
node apps/desktop/test/character-benchmark/run-suite.mjs --config=C:/qa/suite.json
~~~

dry-run 只列计划，不调用模型或世界。默认 6 题 × 2 模型 × 2 臂 = 24 试次，串行执行；第二模型反转工具/JS 顺序。每次新建 Pi 会话、唯一任务目录和角色名称。输出目录已有 manifest 时拒绝运行，防止重复提交。可在配置中指定 cases 数组，只选择尚未运行的题。

单独运行一个尚未提交的组合：

~~~powershell
node apps/desktop/test/run-prep-benchmark.mjs --qa-root=C:/qa/qwen --qa-report=C:/qa/fixture.json --target=local-cos --provider=qa-aliyun-token-plan --model=qwen3.7-plus --comparison=build-query --character-suite --cases=A1 --samples=1 --thinking=high --task-timeout-ms=300000 --arm-only=native_skill_build_tool
~~~

JS 臂为 native_skill_build_js。不要在同一世界并行运行多个批次。灰度模型到期或供应商变化时，记录新模型/端点/日期作为新实验条件，不能直接拼成原基线。

## 4. 时间与停止规则

120 秒是体验目标，初期 300 秒为硬上限。超时即使留下完整卡也不算按时成功；超时后的快照用于诊断，不用重判改写耗时。

首轮 A1 四次实际上限 180 秒，随后按用户要求对新试次放宽到 300 秒。必须按实际上限分开报告，不能混成一个通过率或用超时耗时冒充完成耗时。历史控制文件已归档到 history/pilot-controls-v2.json，不再隐式覆盖新运行。正式新批次使用明确的命令行/config 上限，character-suite 默认300秒。

观察进程时的等待超时不等于模型终止。批次暂停时，先检查现有进程、报告中的 taskState、每个工具的结束状态。供应商故障、工具状态不确定时先处理，不重复提交。只有前次终止且写入已核清，才能继续尚未提交的组合。

## 5. 结果在哪里，如何重新验收

私有 profile 下的 benchmark-时间戳.json 是原报告：任务文本、模型/供应商、thinking、skill 和查询工具指纹、调用列表、耗时、逐项原判定。对应目录保存任务资料，会话轨迹在该 profile 的 benchmark-agent/sessions 下。完整 profile 含私有配置，不提交。

批次 manifest 标记每次报告和审计路径。终止后只读审计：

~~~powershell
node apps/desktop/test/character-benchmark/audit-model.mjs C:/qa/qwen/benchmark-时间戳.json
~~~

审计输出独立的 -audit.json 与每张卡的 snapshot.json；不要在修改卡后覆盖第一次审计来冒充原始产物。

无需重新请求模型，就能用修订验收器检查留存快照：

~~~powershell
node apps/desktop/test/character-benchmark/regrade-v3.mjs C:/qa/character-run-001/manifest.json --out=C:/qa/character-run-001/regrade-v3.json
~~~

可用 render-pilot-results.mjs <重判JSON> <输出MD> 生成首轮24次对照表；audit-pilot.mjs <manifest> <重判JSON> 核对终止状态、唯一组合、共同输入、工具差异和快照hash。它们面向这一轮固定24组合，不用于把任意不同批次混算。

记录 verifier、来源别名、法术元数据、policy 和每张快照的 hash。原始分数不覆盖。报告自动通过只表示全部已编码配置满足，并且任务按时正常结束；不表示实战自动化全部可用。核心通过、全部配置通过、120秒目标分别报告。

完整起始装备、语言、未知扩展来源、其他 NPC 等价实现、最终说明和全部自动化属于明确的人工审查范围，见任务合同。机器未覆盖的等价表示应标为待人工判断，不能只因 JSON 形状不同就认定模型错误。

## 6. 设计与迭代纪律

- 固定任务与共用默认。不能把工具组独占的信息当作对照组隐藏考题；两臂仅改变待测查询能力。
- 以独立规则、确认默认、固定来源和最终有效字段验收。不要把查询工具输出当标准答案，也不要只查名字或字段是否存在。
- 首轮每组合一次用于暴露问题，不能得出稳定速度排名。基准稳定后做交错重复样本，比较同模型、同供应商、同上限；同时报告通过数、中位数、尾部耗时与失败原因。
- 修正误判要有真实证据、合法正例和错误反例。新增检查后所有已保存试次用同一版本重判；明确阶段性结论被什么新证据替代。
- 参考创建器也可能错。本轮它与模型均遇到技能关联属性默认陷阱，因此参考卡不能自证正确。
- 不以优化成绩为由删掉失败题，不重试到成功后只保留最好一次。
- 不改 auto pack。发现需求，只在 [todo](todo.md) 写背景、需求、改造思路。CR 重评未实现，休息工具不在本轮范围。

迁移系统或 auto pack 版本前先重做来源/参考卡核验。sources.json 是来源定位，source-aliases-v3.json 是经过审核的能力映射；spell-metadata.json 是固定 SRD5.1 元数据，build-spell-metadata.mjs 可从仓库规则资料重建。它们服务验收，不额外注入被测模型。

对照组并非完全无工具：搜索、授予物品、图片等17个共同工具仍可用；候选仅额外开放foundry_build_query。

本次修正参考卡的ID、HP、熟练和快照指纹见[参考卡v3记录](prep-character-review-v3.json)。

最新输入版本：character-v4-source-query-defaults，共用skill已统一完成标准，foundry_build_query v2返回实际导入来源并支持选定子职；验收器仍为v3。旧首轮结果不能代表这一版的模型表现，详见技术方案第28节。
