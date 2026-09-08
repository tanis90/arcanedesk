# ArcaneDesk 备团 Agent benchmark

本文件维护测试使用方法；工具演进计划与每轮进度统一见 [唯一技术方案第 14 节](foundry-prep-play-technical-plan.md#14-迭代计划进度与决策记录)。

本套件用于持续评估真实 AgentHost / Pi / 模型操作 Foundry 的效率与正确性。它不是 SDK 微基准，
也不包含聊天 UI 渲染耗时。入口、用例和图片随仓库保存，账号配置与原始会话留在本机。

基础六题为 **prep-v1-draft2**，已包含本地图片上传并完成真实模型实验；NPC 法师与狼人采用独立版本。
整体仍是 draft，剩余验收边界见本文后段，不能称为已冻结正式基线。
早期五题、100 次中性 prompt 实验见 [历史报告](prep-prompt-benchmark.md)，不能与新版本直接混算。

## 快速使用

2026-09-08 用户已指定改用本地 COS。使用 --target=local-cos 绑定 30000／9230／COS；
默认 --target=qa-a 仍绑定 30101／9231／cos-a。不能把两种环境的样本混作同一基线。
本地 COS 不运行 review-prep-play-qa 的战斗／故障场景；GM 登录后使用专用 Prep setup：

```powershell
node apps/desktop/test/setup-prep-benchmark.mjs --target=local-cos
# 把输出报告路径传给 --qa-report，其余 provider 配置同下文
npm run benchmark:prep -- --target=local-cos --qa-root=C:\qa\arcanedesk-benchmark --qa-report=C:\qa\fixture.json --samples=10
```

setup 只创建两个带 runId 标记的空白 NPC 和一个非激活场景，供本会话 view；不创建或修改 Combat。
报告保存原 viewed/active Scene 与精确 UUID。结果不确定不重放；结束后恢复原视图并按 UUID／runId
精确清理 setup 对象。该流程已用于本地实验；不能对既有角色做通配清理。

从仓库根目录执行，先安装仓库依赖并构建 SDK：

```powershell
npm ci
npm run build:sdk
npm run benchmark:prep -- --help
```

按本机 fvtt-qa-farm skill 启动隔离 QA-A，验证 Mounts=[]、镜像身份和 loopback 端口。
只使用 Foundry 30101、GM CDP 9231、world cos-a；登录 GM 后保留一个 /game 页面。
Farm 生命周期脚本属于 Foundry 环境仓库，须从其匹配镜像的干净提交执行，不在 App 仓库臆造路径。
不要使用 primary 或 QA-B。完成后按 skill 再验证隔离并停止 QA-A。

准备独立 QA profile，通过 App 的 ProviderStore 配置加密 provider `qa-kimi-coding`，选择
`kimi-for-coding-highspeed`（默认组合）。也可用 `--provider=<已配置ID> --model=<模型ID>` 选择独立 QA profile 中的模型，
例如已测的 qa-aliyun-token-plan / qwen3.7-plus；不读取主 App profile，不在命令行传密钥。
换供应商或模型时另建环境分组，不能把历史绝对耗时直接混作同一基线。

```powershell
# 生成当前 QA-A fixture；输出报告的绝对路径
node apps/desktop/test/review-prep-play-qa.mjs --origin http://127.0.0.1:30101 --cdp-port 9231 --world cos-a

# 替换这两个路径。qa-root 必须含已配置的 config/providers.json。
$qaProfile = 'C:\qa\arcanedesk-benchmark'
$fixtureReport = 'C:\qa\prep-play-current.json'
npm run benchmark:prep -- "--qa-root=$qaProfile" "--qa-report=$fixtureReport" --samples=10 --prompt-mode=production

# 使用运行器输出的最终报告路径
node apps/desktop/test/summarize-prep-prompt-benchmark.mjs C:\qa\arcanedesk-benchmark\benchmark-EXAMPLE.json
```

每题 10 组配对，共 120 次模型任务。快速诊断可用 --samples=1；这不是正式性能结论。
定向诊断可加 --cases=conditions（多个用例用英文逗号分隔）。工具迭代的单变量实验使用
--comparison=revision --baseline=<旧版本工作树> --prompt-mode=production；两组均开放工具，
分别加载旧／新 AgentHost 与 runtime，要求生产 prompt 文本相同。报告记录 baselineCommit 与候选提交。
汇总格式 summaryVersion=3 以 controlArm / candidateArm 标识两臂，统计放在 control / candidate 字段。
历史格式的 js / tools 字段不再用于新汇总；原始报告不变。
默认使用本地安装的 Electron；若需其他路径，设置 ARCANE_QA_ELECTRON。启动器自动提供 ARCANE_QA_NODE，
以隐藏窗口启动 Electron main。不能只用 node 执行 Electron fixture。无需旧 baseline worktree。
运行期间不要重建 SDK、改变模型配置、修改当前 Scene、操作测试对象或同时跑其他模型测试。

## 固定任务与世界验收

创建题的代表性与新增角色组合题设计见
[创建角色 benchmark 代表性审查](prep-character-benchmark-review.md)。新题已通过 `--cases=npc_wizard`
显式接入，当前版本 prep-npc-intent-draft2，单任务默认 180 秒硬超时、120 秒体验目标，结果保留供人工复核；
不算进现有 draft2 覆盖或成绩，默认六题与旧复制题继续保留。
首次结果见 [NPC 预检](prep-npc-wizard-pilot-results.json)，两组均有就绪验收缺口，不标记稳定基线。

NPC 原生 skill 工作流实验使用 `--comparison=native-skill --cases=npc_wizard --samples=2`。
两臂为 tools（原 18 工具）和 native_skill（隐藏 actor_create/update，保留 16 工具及真实加载的 skill）。
每题 skill 复制到该任务自己的工作目录，由资源加载器发现、由模型读取；读取计入任务耗时，记录正文 hash。
两个样本交换先后顺序；它改变了工具暴露和指引，不是单因素实验。实验指南位于
[fvtt-native-npc](../test/fixtures/prep-native-npc-skill/SKILL.md)，尚未安装到产品默认模式。
当前汇总器支持 js、revision、native-skill、skill-revision 四种对照。它只接受完整完成的报告；
中断与独立补齐的块需要保留逐次审计清单，不能直接拼接成伪完整配对。

只比较 skill 正文时使用 `--comparison=skill-revision --cases=npc_wizard --samples=2 --baseline-skill=<旧版SKILL.md>`。
两臂均使用相同 16 工具及原生路由，分别复制旧／当前正文，通过真实 skill 机制读取；报告记录各自 hash。
旧稿可从 51bb226 提取，当前合并指引仍为实验稿。[首次合并实验](prep-skill-batching-results.json)
两版各 1/2 通过，不能将减少调用等同于稳定可靠。

修正后的 loop 默认 180 秒硬超时、120 秒体验目标；分别统计正确完成率和 120 秒内正确完成率。历史 120/300 秒报告不改写。
`--task-timeout-ms` 可在 120000–300000 范围显式设置，仅在有数据说明默认上限失去区分度时用于后续配对块，
不得为单条失败临时延长。超时保留现场，timeout_abort 与 provider_error 分开记账。

| 用例 | 用户意图 | 当前独立验收 |
| --- | --- | --- |
| create_npc | 从 Wolf 创建 NPC，并设置角色和原型名；同名不重复 | 单个目标、两个名字、Wolf HP 与 Bite |
| grant_items | 同来源已有武器原样跳过，新武器授予并装备 | 数量、已有装备状态不变、新物品装备 |
| edit_image | 改名字、HP、固定 AC，同步已有 Data 图片 | Actor／原型／非当前 Scene Token 图片、布局与名字 |
| scene_layout | 非当前 Scene 移动、删除、创建 Token | 精确数量、角色、名字、坐标，未切换或激活 Scene |
| conditions | 两位角色上倒地／中毒，第三人不变 | 两人状态成立且无重复效果，第三人无新增状态；三人预置无关效果保留 |
| upload_image | 本地图片维护到 Actor／原型／存量 Token | HTTP 读取、SHA-256、图片解码、引用一致、Token 布局和其他角色图片不变 |

完整自然语言 prompt 与 setup/cleanup 在
[prep-prompt-benchmark.cjs](../test/fixtures/prep-prompt-benchmark.cjs)，独立验收在
[prep-benchmark-verifier.cjs](../test/fixtures/prep-benchmark-verifier.cjs)。两组需求相同，仅替换对象名及各自本地路径。
不提供 UUID、预写脚本或调用顺序。每次新模型会话、重新创建三位 NPC 与非当前 Scene；奇偶轮交换两组先后。

图片为 [benchmark20260508180804.jpg](../test/fixtures/prep-benchmark-assets/benchmark20260508180804.jpg)，
JPEG，231×223，5542 字节，SHA-256：
`b95e5064ce3d221ff17615e9caeea76ff285a87d25da9d6d7dfec27f1ace6785`。
运行器在计时外复制到每次备团目录，两组均有真实文件/shell能力，不依赖原用户 Pictures 路径。
图片很小，测的是操作链而非大文件带宽。上传资产留在可丢弃 QA-A 内，停止容器统一清除；
同一轮后续任务可能复用已存在的内容寻址资产，因此当前题目是本地图片维护流程，不宣称每次都是冷上传。

## 两种测试用途

- production（默认）：工具组保留真实生产 Prep prompt；JS 对照移除领域工具并使用中性原生 JS 指引。
  衡量生产工具配置相对 JS 的整体表现，**不是仅工具集合这一单变量的实验**。
  优化前后比较时，应比较同模式、同模型的工具组；JS 组用于观察环境波动和参考成本。
- neutral：两组相同中性约束，分别附结构化优先／原生 JS 路由；用于诊断工具自身说明的易用性。
  不与 production 的数字混算。两组仍使用实际 Pi 工具描述和相同候选产品实现。

## 指标与设计原则

1. 用户意图和验收独立于工具实现。允许合并接口或改参数，不为了新实现调题。
2. 先正确，再比较速度。最终世界验收与模型完成状态同时成立才成功；失败样本不能被快速响应掩盖。
3. 分题报告，不给混合总分。报告成功率、成功耗时 p50/p95、全部尝试均值、成功配对胜场、调用数、
   模型响应轮数、JS 回退、错误与不确定回执。10 个样本的 p95 就是最大值，不代表稳定尾分布。
4. 计时从提交指令到任务结束，包含模型、工具、回读、纠错与最终回复；fixture 准备和外部验收不计时。
   首次事件可能是推理或工具事件，不等于首个可见文字；reasoning token 不能换算成思考秒数。
5. 不偷偷替补失败。超时或不确定写入暂停并保存原始报告；先只读核验，不重放写入。
   --prep-resume=<failed-report> 只用于人工确认原任务结束后的剩余任务续跑；原任务与耗时保留。
   续跑必须使用同版本、同模型、同模式、同 fixture 环境与冻结产品代码。人工核验时间不计入任务耗时，报告必须披露暂停。
6. 题目、fixture 或验收变化即升级版本并重新建基线。代码、生产 prompt 可迭代，但要记录实际提交和模式。
7. 不用不稳定延迟作为默认 CI 阻断门槛。常规 CI 做离线检查；真实模型测试需要明确 QA 环境与供应商额度。
8. 不修改 auto pack。发现依赖包改造按 [TODO 纪律](todo.md) 交接；本套件只创建隔离世界测试对象。

报告包含候选 commit、suiteVersion、promptMode、模型、实际工具集合、prompt hash、图片 hash、环境和逐次数据。
原始 JSON 与会话存在 qa-root，可能含本地路径及世界内容，不自动提交；提交经过检查的统计摘要与结论。
任何“变快”结论都须附运行报告、提交身份、成功率及已知问题。

## 基线与供应商变更

运行器可传 `--provider=<providerId> --model=<modelId>`，必须与该私有 qa-root 的默认选择一致；
省略仍使用原 Kimi 配置。初始化脚本 prep-play-model-config.cjs 支持环境变量
ARCANE_QA_PROVIDER_ID、ARCANE_QA_MODEL_ID、ARCANE_QA_BASE_URL、ARCANE_QA_PROVIDER_KEY，
通过生产 SecretStorage 加密保存并用最小聊天请求预检。不同供应商使用独立 qa-root。
运行报告记录无密钥的 endpoint／providerId／model；[阿里云六类预检](prep-aliyun-pilot-results.json)只证明链路可用。

若原批次暂停后只补尚未执行的一臂，可显式 `--arm-only=tools`（或该 comparison 的有效对照臂），
必须另建报告、使用新 fixture，不能与 --prep-resume 同用，不能将结果伪装成原批次连续执行。
该单臂报告不是完整配对报告，不直接交给要求完整两臂的汇总器；须在人工审计摘要中关联原报告并披露暂停。
[Qwen 裸 JS／工具预检](prep-aliyun-js-tools-pilot-results.json)保留一次上传超时及单独工具臂补测。

基线分为两层：长期固定题目、fixture、验收协议和作为对照的代码版本；性能数值属于某次明确环境下的实验。
同名模型不是相同服务环境的证明，也不保证相同速度。即使供应商不变，也不能假设不同时段的耗时稳定。

每批应记录供应商 ID、endpoint／部署标识、模型实际 ID、套餐／服务档位、客户端有效推理设置、运行日期，
以及 AgentHost／SDK／产品提交、生产 prompt hash、工具 schema／说明版本、Foundry／系统／模块版本、
fixture 和图片 hash、连接预热与缓存策略。不记录密钥；供应商内部模型修订不可知时明确写 unknown。
当前报告尚未自动覆盖所有身份字段，缺失项须补实验清单，不能仅凭 model 名称认定环境一致。
顶层 provider-default 也不能替代逐次有效 thinking；推理 token 数不是推理耗时。

换供应商、endpoint、模型、套餐或推理设置后，新建环境分组。在该环境内重新运行同一冻结旧版和候选版，
按同题交错顺序完成至少 10 对初步样本；保持两臂除待测改动外的条件一致，冻结代码与提示。
若结论接近或波动明显，再预先确定追加完整配对批次，不能跑到出现有利结果就停止。
题目／验收变更则升级 suiteVersion，新旧结果不得直接合并。

例如：供应商 A 上旧版 12 秒、新版 9 秒；换 B 后旧版 8 秒、新版 7 秒。
应分别报告 A 内下降 25%、B 内下降 12.5%，不能拿 A 的 12 秒与 B 的 7 秒称工具提速 42%。
这些只是说明计算关系的假设数字；正式报告同时给成功率、耗时分布、逐对变化、调用次数、纠错与多余回读。
调用次数和错误类型更便于解释机制，但也受模型行为影响，不能视为完全跨供应商不变。

旧工具／新工具使用 comparison=revision，双方同一生产提示；裸 JS／工具使用 comparison=js，
仍属于完整工作流比较，不能把提示差异造成的收益全归因于工具。

供应商限额、鉴权或服务错误出现时，结算已完成调用、保存报告后暂停；未决写入保留现场，不重放。
受影响块不作工具延迟归因，失败留在运行可靠性记录中，不将失败从成功率分母静默移除。
任务最终成功也不抹去中途 provider error。恢复服务后另建完整配对块，保留原始失败记录和中断说明。
当前已增加错误分类／暂停及汇总计数，语法检查通过，真实错误路径尚待后续验证。

## 冻结 v1 前剩余验收

阶段组合验收及额度中断见 [唯一技术方案](foundry-prep-play-technical-plan.md#1412-保留组合验收已记录阶段结果暂停)。

- 2026-09-08 已按用户授权在本地 COS 完成图片预检及六类共 120 次生产模式对照。
  [统计与工具覆盖](prep-cos-benchmark-results.json)，[迭代结论](foundry-prep-play-technical-plan.md#146-本地-cos-全工具基线2026-09-08已完成)。
  这是完整 draft 基线；下面的协议缺口补齐前仍不标记稳定 v1。
- draft2 已增加状态题的无关预置效果与重复效果验收，4 项离线测试通过（正确结果、误删、重复、误伤第三人）；
  COS 已确认真实系统效果形态；解码异常回归加入后离线验收器共 5 项通过。
  只验收最终状态，不等于已追踪所有中途副作用。
- 授物补来源保留与二次幂等，场景补原型继承检查。增强验收须升级 suiteVersion。
- 确认共享页面 JS 全局声明的隔离策略：当前每题新模型会话，但页面 JS 上下文沿用，顶层 const 可残留。
  不能把相关语法碰撞全部归因于 FVTT 知识不足。
- 若要测每次冷上传，应另设资产隔离/清理协议，不能混用当前内容复用场景的耗时。

这些限制明确解决并完成实跑后，才能把 draft 标记为稳定 v1；历史报告始终保留。

## 完整覆盖与补验

不传 `--cases` 默认运行全部六类；图片题只能作为预检，不能代替全套。
也可分别传 `--cases=create_npc`、`grant_items`、`edit_image`、`scene_layout`、`conditions`、`upload_image`，
每类 `--samples=10`，按六份报告汇总；一类遇到不确定写入暂停，不影响后续独立类别。
必须保留未决任务，不能删掉失败或以补跑成功替换。

模型不一定主动调用全部工具。报告要附实际工具调用覆盖，未覆盖的运行时分支可独立补验：

```powershell
node apps/desktop/test/smoke-prep-read-status.mjs --target=local-cos --qa-report=<fixture-report>
```

该脚本使用专用 fixture 场景，验证世界信息、Token 关注集、轻重上下文和状态添加／移除／重复移除；
只创建并清理自身标记的 Actor、Token，失败则保留现场。功能补验不计入模型响应速度样本。
运行器在 120 秒保存超时并请求 abort，150 秒硬截止保留不确定结果；不自动重放或清理。

## 狼人迁移题

`--cases=npc_werewolf --comparison=skill-revision --baseline-skill=<冻结旧稿> --samples=1` 使用同一 16 工具对比两份冻结指南。新 loop 默认 180 秒硬超时，另计 120 秒内成功率。题目、来源预检与验收边界见[狼人迁移协议](prep-werewolf-transfer.md)。Evaluator 读取来源快照但不把位置或答案传给模型。NPC 与 fixture 保留，超时停止、不重放。

`--reverse-first` 交换首次两臂顺序，后续 sample 仍交替；实际次序记录在 experiment.arms。可用于中断后另开完整反向对照块，不能用它重放已完成或不确定写入。

## 固定 NPC 指南比较工具版本

使用 `--comparison=revision --native-npc --cases=npc_wizard --baseline=<冻结代码工作树>`。两臂都从当前实验 fixture 加载同一份指南，隐藏 actor_create/update，保留相同 16 工具和原生路由；分别加载 baseline/当前工作树的工具和 runtime。报告的 experiment.nativeNpc=true，逐次 skillHash 必须相同；同时记录 runtime 与工具文件 hash，尤其候选尚未提交时，不能只用 HEAD 标识它。不要在批次运行中修改 SDK、工具、指南或模型配置。

### 修正后的迭代协议

以[唯一技术方案 §14.26](foundry-prep-play-technical-plan.md#1426-修正后的-goal-与-loop)为准。每轮单因素，两臂各 3 次交错；迁移与既有题回归必须在冻结候选后执行。新增 `--thinking=off` 显式固定客户端档位；逐次 `modelConfiguration` 与 `requestModes` 保存模型能力和实际出站思考参数（不保存凭据或请求正文）。Qwen 基线校正后单独分组，不能与旧服务端默认思考报告混算提速。汇总 v3 新增 withinExperienceTarget / withinExperienceTargetRate。
