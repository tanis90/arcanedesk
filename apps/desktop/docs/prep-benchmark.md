# ArcaneDesk 备团 Agent benchmark

本文件维护测试使用方法；工具演进计划与每轮进度统一见 [唯一技术方案第 14 节](foundry-prep-play-technical-plan.md#14-迭代计划进度与决策记录)。

本套件用于持续评估真实 AgentHost / Pi / 模型操作 Foundry 的效率与正确性。它不是 SDK 微基准，
也不包含聊天 UI 渲染耗时。入口、用例和图片随仓库保存，账号配置与原始会话留在本机。

当前版本为 **prep-v1-draft**：六题运行代码已落地，新增图片题尚未完成真实模型验收，不能视为已冻结的正式基线。
早期五题、100 次中性 prompt 实验见 [历史报告](prep-prompt-benchmark.md)，不能与新版本直接混算。

## 快速使用

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
| conditions | 两位角色上倒地／中毒，第三人不变 | 两人状态成立，第三人没有新增目标状态 |
| upload_image | 本地图片维护到 Actor／原型／存量 Token | HTTP 读取、SHA-256、图片解码、引用一致、Token 布局和其他角色图片不变 |

完整自然语言 prompt 和 setup/verify/cleanup 代码在
[prep-prompt-benchmark.cjs](../test/fixtures/prep-prompt-benchmark.cjs)。两组需求相同，仅替换对象名及各自本地路径。
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

- 在 QA-A 实跑新增图片题的两组，确认本地读取、上传、哈希验证和清理；再跑 120 次生产模式正式基线。
- 状态题增加无关预置效果与重复效果验收；当前只检查最终状态集合，不能保证中途未误删后恢复。
- 授物补来源保留与二次幂等，场景补原型继承检查。增强验收须升级 suiteVersion。
- 确认共享页面 JS 全局声明的隔离策略：当前每题新模型会话，但页面 JS 上下文沿用，顶层 const 可残留。
  不能把相关语法碰撞全部归因于 FVTT 知识不足。
- 若要测每次冷上传，应另设资产隔离/清理协议，不能混用当前内容复用场景的耗时。

这些限制明确解决并完成实跑后，才能把 draft 标记为稳定 v1；历史报告始终保留。
