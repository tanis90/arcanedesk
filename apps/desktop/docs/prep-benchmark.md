# ArcaneDesk 备团 Agent benchmark

本文件维护测试使用方法；工具演进计划与每轮进度统一见 [唯一技术方案第 14 节](foundry-prep-play-technical-plan.md#14-迭代计划进度与决策记录)。

本套件用于持续评估真实 AgentHost / Pi / 模型操作 Foundry 的效率与正确性。它不是 SDK 微基准，
也不包含聊天 UI 渲染耗时。入口、用例和图片随仓库保存，账号配置与原始会话留在本机。

当前版本为 **prep-v1-draft2**：六题运行代码已落地，新增图片题尚未完成真实模型验收，不能视为已冻结的正式基线。
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
精确清理 setup 对象。完整 fixture 流程尚待本地真实验收，不能对既有角色做通配清理。

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
`kimi-for-coding-highspeed`。当前 runner 明确校验这一组合；不读取主 App profile，不在命令行传密钥。
需要其他模型时先扩展配置与报告身份，另建模型基线，不能只改报告中的模型名。

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
统计文件的 controlArm 标识对照组；兼容字段 js 在此模式存放 baseline 数据，不代表裸 JS。
默认使用本地安装的 Electron；若需其他路径，设置 ARCANE_QA_ELECTRON。启动器自动提供 ARCANE_QA_NODE，
以隐藏窗口启动 Electron main。不能只用 node 执行 Electron fixture。无需旧 baseline worktree。
运行期间不要重建 SDK、改变模型配置、修改当前 Scene、操作测试对象或同时跑其他模型测试。

## 固定任务与世界验收

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

## 冻结 v1 前剩余验收

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
