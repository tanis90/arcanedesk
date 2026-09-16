# 备团／跑团实施与验收记录

依据：[唯一技术方案](./foundry-prep-play-technical-plan.md)、[auto pack TODO](./todo.md)、[休息 TODO](./foundry-rest-todo.md)。
本文保留历史实施与验收证据，不另定产品合同或当前计划。
每轮当前进度、工具演进决策和剩余事项统一维护在 [唯一技术方案第 14 节](foundry-prep-play-technical-plan.md#14-迭代计划进度与决策记录)。

分支：`codex/foundry-prep-play`，独立 worktree 基线 `9107c09`。未修改原主线工作目录或 auto pack。

## 当前状态

本轮 App/SDK 范围已实现，并通过下述 QA-A 功能、真实模型和热连接战斗回归验收。
auto pack 改造按约定仅交接 TODO：召唤新协议、可选独立视觉入口不宣称已经可用；短休／长休不实施。
结论仅覆盖列明的版本组合与测试条件。下文“增量”与 QA 记录保留历史检查结果，当前状态以唯一技术方案为准。

后续 [100 次备团工具消融 benchmark](./prep-prompt-benchmark.md) 已完成：授物提速明确，其他任务表现混合，
不能宣称整体提速。最终世界结果工具组 50/50、JS 组 48/50 正确；工具组仍有 8 次 JS 回退。
批量创建 Token 的返回顺序导致两次错误 indeterminate 回执，模型读回后完成任务；此 SDK 缺陷待修复，
具体复现与建议见 benchmark 的正确性问题一节，不属于 auto pack 改造。

| 方案项 | 实施状态与剩余工作 |
| --- | --- |
| M0 基线／工具矩阵 | 真实 Pi active set 通过；跑团 7、备团 18；修正后的 10 组交错战斗对比通过 |
| M1 共享上下文 | 全量 Token、结构引用及轻量动态映射通过；真实模型首次重读、同会话后续轻读通过 |
| M1 状态 | 真实双人上下状态、幂等、来源保护和原生结束专注通过；模型状态任务各一次调用 |
| M1 操作记录 | JSONL、派发前落盘、去重、重启不重放、服务调用和会话删除清理已实现并测试 |
| M1 环境绑定 | 入队固定 world/Scene/selection；真实页面排队改选 10 次不串目标，重载后的已知操作不重放 |
| M2 跑团执行 | 非战斗易容术／敲击术、近战／远程／法术攻击、战斗执行与推进通过；故障回执不重扣 |
| M3 备团 Actor | 真实合集导入、授物去重、改图和 linked/unlinked/ring 同步通过；模型无需 JS |
| M4 备团 Scene | 真实非当前 Scene 的背景／网格／Token 创建、更新与删除通过；模型批量创建无需 JS |
| M5 召唤 | 本轮写前拒绝通过；旧包未提供认可 marker，模型不发现该召唤；包侧完整集成留在 AUTO-001 |
| Prompt／UI／遥测 | 已改跑团名称、提示词、执行摘要与工具分类，历史旧工具仍可显示；新增内容工具随各阶段补充 |
| 完整验收 | 全仓 verify、QA-A 功能／故障注入／真实模型场景及热连接战斗回归通过；包侧事项继续延期 |

## 已有证据

- SDK 新测试：125 个隐藏／未渲染 Scene Token 全量、Actorless Token、静态／动态名单一致，
  当前 Scene 有效战斗与其它 Scene 隔离、歧义战斗拒绝；资源／状态不使结构引用失效，Token/Item 变化会失效。
- 状态测试：显式 set 幂等、重复 Actor 去重、来源效果零写拒绝、系统专注结束与手动标记区分、
  world/关注范围校验、派发后失败不冒充 rejected。
- 操作记录 4 项测试通过：重复投递一次执行、已完成结果重启恢复、派发中重启不重放、
  落盘失败零派发、下游失败不重试、调用身份冲突拒绝。
- Desktop 全套 412 项测试通过；Desktop typecheck 和 source boundary 通过。
  这些是基础回归证据，不能证明尚未接入的产品功能可用。
- SDK 旧四默认 actions 与原 battleContext/turnContext/executeTurn 行为保留；
  目标解析调整后 43 项 SDK 测试全部通过，包括提交时选择 UUID 与跑团禁止独立 Actor 旁路。

## 后续边界

用户已指定 QA-A，授权空密码 GM 登录，并指定 Kimi K2.7 HighSpeed 做性能验收。
以后替换 Foundry／dnd5e／Midi／auto pack 版本时重跑对应集成测试；包侧完成后再接召唤和可选视觉。
当前已完成项目见下述证据，不将已知旧包缺能力标作 App 实现失败，也不冒充已实现的召唤能力。

## QA-A 环境交接

- 用户指定使用 `fvtt-qa-farm` skill 和 QA-A。使用现有镜像对应的干净 worktree
  `C:/Users/yangqi/code/Arcane-Desk/.worktrees/chat-bubbles-farm-a-baseline` 中的 Docker 脚本。
- 固定环境候选为 `29d9906ed8ecc8366e29e6b621db2921f44eb6c5`，镜像为
  `sha256:056b124107bc9450e657e2061237ae4baad40d550542420e86ebb189ee015eb2`。
  这是测试环境／模块基线，不是本次 App/SDK 实现版本；本次已提交实现为 `ba350d0`。
- `validate-config.ps1` 通过；`start-slots.ps1 -Slots A -Replace` 从同一固定镜像重建可丢弃的
  QA-A，返回 running/healthy，内置隔离校验通过：`Mounts=[]`、仅 loopback 30101、world `cos-a`。
  QA-B 和 primary 未操作；未构建或改写 auto pack。
- 镜像标签声明 Foundry 13.351.0、dnd5e 5.3.3、Arcane 模块 0.3.18；实际启用模块和 Midi
  版本仍须登录后读取，不能用镜像标签代替运行态验收。
- GM Chrome 已通过 `slot-chrome.ps1 -Slot A -Role GM` 打开，独立 CDP 9231。
  单次只读检查确认 `/join`、world `cos-a`、`game.ready=false`，页面标题 COS-QA-A。
  随后用户明确授权本轮及后续 QA-A 空密码 GM 登录，已登录；该授权只用于 QA 环境。

## QA-A 真实验收增量

- 运行态确认 Foundry 13.351、dnd5e 5.3.3、Midi 13.0.63、DAE 13.0.28、Times Up 13.1.9、
  Arcane 0.3.18。没有改写任何模块代码或 pack。
- 新增 opt-in runner `apps/desktop/test/review-prep-play-qa.mjs`，固定要求显式传入 QA-A origin、
  CDP 9231 和 cos-a；每次派发前保存记录，失败不重放，保留 fixture UUID。使用本分支 SDK 原始
  runtime，真实 Foundry Document／Midi；这是 SDK 层证据，不冒充已通过完整模型流程。
- `prep-play-1788782298272.json`（本机 Temp）通过：精确合集来源导入 Wolf、改名和 prototype 名、
  授物去重、Scene 创建／Token 移动与删除、激活、无 Token Actor 排除、两人上下中毒、倒地幂等，
  linked/unlinked Token 图片与启用圆环同步且位置／名称／hidden 不变、真实 PNG 解码／上传／复用、
  Scene 背景和网格更新、真实 dnd5e 专注结束，以及非战斗近战／长弓／光导箭与战斗内执行和推进。
- 易容术和敲击术使用明确 narrative 记账分支；一环／二环分别只扣一次，无门文档、无战斗，
  资源变化不使静态上下文失效。该证据不表示易容术的原生 transform 或动画已经验收。
- 攻击以 Midi RollComplete 命中／伤害记录与实际 HP 对照；长弓扣一支箭，光导箭扣一环位。
  世界原有另一个 Scene 的战斗，测试确认新非战斗攻击不创建新 Combat，也不误用其它 Scene 战斗。
- 真实环境发现并修正：Foundry 原地展开 update 参数导致回读误报；Token 生成改走原生
  getTokenDocument，并为 linked ActorDelta 补空集合进行严格校验；更新仅校验实际更改字段；
  图片回读使用持久化字段并关闭图片切换动画，避免画布过渡值导致误报；允许 DAE 的空
  specialDuration 元数据，仍保护真实来源／触发效果。对应回归测试已加入。
- 石像鬼中毒测试出现原生免疫清理竞态，回执保守报告 indeterminate，未重试该次移除。
  确认 fixture 的 poisoned immunity 后，正常状态矩阵改用精确 Wolf；未修改怪物免疫规则。
- 独立模型 QA 配置使用生产 ProviderStore／Electron safeStorage 保存用户提供的密钥，仓库、报告
  和日志不保存密钥。官方模型列表接口确认 `kimi-for-coding-highspeed` 可用。
- 首轮真实模型预跑发现 Kimi 拒绝根联合 schema，补 `type: object` 仍被拒绝。最终将 provider
  可见根 schema 展开为普通 object，原精确联合留在宿主入口校验；分支互斥、必填组合和未知字段
  仍在获取绑定／审批／派发前验证。没有修改模型参数形状，也没有放宽实际写入合同。
- 实际宿主图片服务此前返回整个 navigation-safe 结果，现提取其 dimensions value，并在解码未完成时
  写前拒绝。补充实际 AgentHost 服务工厂测试；真实模型上传场景继续验证这条路径。
- Kimi 的 Pi 会话 thinkingLevel 在两版均为 off，供应商仍实际返回 reasoning token；本轮标为
  provider-default，不声称 high 推理档位，不以 token 数冒充思考耗时。

## 模型流畅度验收

- 基线 App/SDK 为独立 detached worktree `9107c09`，新版为本分支工作区；使用同一 Pi 依赖、
  同一 QA-A／模块／角色／动作和 Kimi 模型，两版真实 AgentHost、系统提示词、工具集合及 Runtime。
  CDP 只承担 Electron 页面 transport，不模拟模型响应或 Foundry 写入。
- `benchmark-1788783373029.json`：10 组交错、每版每组首次和后续指令各一次，共 40 轮完成。
  首次 p50 基线 8127 ms／新版 11581 ms（+42.5%），p95 14003／24205 ms（+72.9%）；
  后续 p50 5799／5776 ms（-0.4%），p95 7093／6052 ms（-14.7%），均为 3 次工具调用。
  这轮首次回归未通过发布门槛，不能只引用后续指标宣称整体提速。
- 首次慢的可解释路径：4 个新版样本先读 turn 再读 static，后者清除了 turn 证据，首次 execute
  被 TURN_CONTEXT_REQUIRED 零写拒绝，再轻读后执行成功；没有重复攻击。提示词与静态工具说明现明确
  static → turn → execute → turn，并在用户已声明连接就绪时直接工作。修正后另采 10 组，不混合统计。
- 两轮均为热连接，首次能力上下文与后续指令分组；人工等待为零。尚未测独立冷连接，
  供应商 reasoning 为实际计数，无法据此得到单独思考时长。预跑 API 拒绝与浏览器只读启动超时
  不计入成功样本。报告保存在本机 Temp，仓库仅留脱敏统计和可复现 runner。
- 修正后 `benchmark-1788783832924.json` 的另 10 组全部完成（40 轮）。首次每个新版样本均为
  static → turn → execute → turn，没有缺回合证据拒绝；后续均为 turn → execute → turn，
  没有重复重读。结果如下，10 个样本的 p95 为样本最大值，不能据此宣称稳定的尾延迟提速。

| 热连接指令 | 基线 p50 / p95（ms） | 新版 p50 / p95（ms） | 平均工具数（基线 → 新版） |
| --- | --- | --- | --- |
| 首次能力上下文 | 9109 / 15972 | 8795 / 10230 | 4.7 → 4 |
| 同会话后续 | 5875 / 6215 | 5759 / 6157 | 3 → 3 |

- 首次总输入含 cache 的均值 31136 → 24911 token，输出 890 → 732，实际 reasoning 741 → 555；
  后续分别为 37094 → 29409、300 → 282、178 → 129。p50/p95 无超过 10% 回归；
  结论是这组样本未拖慢既有战斗路径，而非已证明所有场景思考明显加速。
- Runtime 调用有独立 duration 记录；runner 未单独埋点排队时间，不能把串行负载直接当作
  队列耗时为零。页面重连和人为争用测试另外记录在下节；不把它们拼成同一模型负载的延迟分解。
- 备团模型先前在完成授物后使用 JS 查看 equipped，因为物品投影缺少该字段。actor_get 的 items
  现补 quantity/equipped；readRef 仍只捕获 Item 身份，数量消耗不使授物引用失效。
  提示词明确已核验回执和结构化查询的用途，不增加工具或跑团重上下文。

## 本轮最终验收证据

- 全仓 `npm run verify` 返回 0：Desktop 443、SDK 84、CLI 232、WebMCP 24 项通过，
  类型、源码边界、runtime hash、构建和安装 tarball 后的消费验证通过。
- `benchmark-1788784760300.json`：真实 Kimi／AgentHost 场景全部通过，备团 18／跑团 7 个实际工具。
  创建 Wolf、授 Rapier 并装备、真实本地 PNG 经生产宿主解码上传、创建背景／网格／两个 Token
  的非当前 Scene、同来源重复授物跳过；这些任务未调用 browser_evaluate。
  双人上下倒地各一次 conditions_set；非战斗易容术是 static＋execute，后续敲击术仅 execute，
  分别只扣一个正确环级法术位；来源管理的倒地零写拒绝且保留原效果。
- `benchmark-1788784945600.json`：真实旧包 Summon Beast 的发现缺口及有／无战斗写前拒绝，
  详见 AUTO-001。真实叙事扣位后由 QA transport 丢失响应，回执 indeterminate；
  同 ID 重投与服务重启均不再次派发，4 个法术位仅变为 3。
- `prep-play-reconnect-1788784965040.json`：10 次已登录 GM 页面重载至世界／canvas 就绪，
  p50 6485 ms、p95 7029 ms；热就绪读取 p50 51 ms、p95 69 ms。
  这是已有浏览器缓存／热服务器的页面重连，独立记录，不混进模型指令延迟；不是全新机器或空缓存启动。
  `benchmark-1788785054319.json` 确认真实页面重载后，重建服务查询并重投原操作仍零派发，法术位仍为 3。
- `benchmark-1788785191875.json`：10 次真实选择快照／共享页面租约测试。入队固定 A，阻塞写入，
  把画布选择改成 B 后释放租约；实际写入始终是 A，B 不变。单独记录排队 p50 1.47 ms／p95 2.71 ms，
  Runtime p50 95 ms／p95 169 ms。人为阻塞仅覆盖改选窗口，这些数值不表示繁忙多会话的排队分布。
- `benchmark-1788785381949.json`：仅针对 QA fixture Item，在内存 Midi 调用边界注入三种故障，
  finally 恢复原函数，未改 auto pack、模块文件或 Item 数据。真实聊天卡生成但无 workflow 时，
  indeterminate 且不扣位；真实光导箭执行后注入异常，HP 496→483、法术位 3→2，仅调用一次；
  无完成信号直至超时，indeterminate 且不扣位。三种均未转 narrative、未补扣或重施。
  故障来源是受控 QA 注入，不声称当前模块自然发生了这些错误。

这些 JSON 位于本机 Temp（模型测试在 `arcane-prep-play-model-qa` 子目录），不含密钥。
仓库保留统计和 opt-in runner，不提交完整模型会话或世界资料。

复现入口：`test/review-prep-play-qa.mjs` 验 SDK 真实世界；
`test/fixtures/prep-play-model-benchmark.cjs` 由 Electron main 运行，接受 `--qa-root`、`--qa-report`、
`--baseline` 和 `--samples=10`，默认比较两版真实模型；也可单独传 `--scenarios=true`、
`--edge-cases=true`、`--queue-checks=true` 或 `--native-faults=true`。备团场景还需
`ARCANE_QA_NODE` 指向可用 Node。`--edge-cases=true --replay-report=<原边界报告>` 验证重启恢复；
`test/review-prep-play-connection.mjs --qa-a-reload` 单独验证重连。
必须先按 QA Farm skill 核验 QA-A，配置独立加密 provider，并运行 SDK runner 生成带所有权的 fixture 报告。
不要让这些真实 runner 与 `verify`／SDK build 并行：构建会重建 dist，可能干扰正在启动的测试进程。

收尾时再次通过 QA-A 隔离验证（同一 committed image、Mounts=[]），随后按 skill 执行
`stop-slots.ps1 -Slots A`，已删除 qafarm-a 与本轮可丢弃世界并停止 GM Chrome。
QA-B 保持原来的 exited 状态，primary 未操作；加密模型配置和脱敏测试报告保留在本机 Temp。

## 方案审计增量

- 第一轮全仓 verify 通过了源码、链接、类型、单测和构建阶段，在 packed consumer 检查失败：
  smoke gate 仍锁定旧 28 个 actions 和旧 runtime hash。已改为当前 39 项合同，保留默认四项断言，
  并比较打包 runtime 的实际源码哈希、声明哈希和工作区规范源码，避免仅更新常量掩盖旧包。
- foundry_play_context 的 view 字面量由实现中的 scene 修回唯一方案规定的 current，默认行为不变。
  world_status 补充 ready、模块版本和入口能力摘要；安装旧 auto pack 不会被报告为支持新召唤。
- 修正后完整 npm run verify 返回 exit 0：源码/文档检查、全仓类型检查、Desktop 437 项、SDK 74 项、
  CLI 232 项、WebMCP 24 项测试、构建，以及安装 tarball 后的 consumer/runtime/CLI 验证通过。
  该结果证明当前自动化门禁通过，不代表下列审计项或真实世界/性能验收已经完成。
- 结构指纹改为已有合同实际使用的 flags 白名单，补齐 Activity 名称、伤害、使用次数上限等结构字段，
  Set/Map 内容也参与判定。测试证明运行回执、spent、HP/slots/状态不使快照失效，合同变化会失效。
- 新静态目录提前列出已有 active buff rider 和 requiresArtifactId；轻量读只返回 activeBuffRiderIds。
  测试证明先读目录、后激活/结束效果不需重建；未激活时声明 rider 仍在写前拒绝。
  旧 battleContext/executeTurn 使用原默认行为，不新增职业动作，也不改 auto pack。
- 操作日志新增原始模型输入摘要；写服务先查同 task/toolCall 的历史结果，再解析引用和申请资源。
  重启丢失 readRef/连接身份后仍返回原结果，同 ID 改参数拒绝。旧日志缺少摘要时保守返回原 operationRef
  的不确定提示，绝不派发。日志仍不保存原始输入或图片数据。
- Desktop 持久化前统一步骤 not_started/summary，并适配旧原生执行四态；完成仅代表原生执行确认，
  不把它写成命中/伤害后状态，战斗后 turn 读取保留。上传路径独立放 dataPaths，不冒充文档 UUID。
- 叙事消耗现拒绝 Item/Activity 的公式或非零有限次数；新增测试证明未知消耗不会进入目录或扣位。
  独立动画入口的包侧依赖仍需按真实模块组合核查；
  当前 auto pack 导出的 API 未找到纯视觉入口，不调用可能产生游戏效果的脚本来伪装动画。
- 本轮上下文/重投/回执修正后完整 verify 通过：Desktop 441 项、SDK 76 项、CLI 232 项、WebMCP 24 项，
  构建和 packed consumer 均通过。随后补充有限次数公式的守卫，SDK 构建及 16 项上下文/执行定向测试通过。
- conditionsSet 已在异步 UUID 解析后、每次实际写入前、回读前复检 world/GM/当前关注范围和 Token 绑定。
  移除前比较效果身份与来源，来源改变则停止；已达到目标的状态为 noop。未知步骤 after=null，
  不把写前状态当回读值。10 项状态测试覆盖解析期间换世界/场景、批量中途来源变化及写后世界变化。
- 新 Play 目录及执行入口拒绝反应与 minute/hour/day/round 长施法时序，既有 SDK executeTurn 不改。
  原生 utility Activity 不再绕过叙事路径的时序限制；测试确认目录不提供、旧引用也不能派发或扣位。
- 备团明确 Actor/Token 状态操作不依赖当前 Combat 是否歧义；查询错误在首次写前返回 rejected。
- 上述修正后完整 npm run verify 返回 exit 0：Desktop 441 项、SDK 81 项、CLI 232 项、
  WebMCP 24 项测试通过，类型／源码／文档检查、构建及 packed consumer 验证均通过。
- 真实环境记录中的 test001 隔离副本仍在，但本次检查 loopback 30219 没有监听、modules 目录为空，
  尚未定位 Foundry 安装目录。已向用户询问安装目录或可写的隔离测试世界地址；不读取密码，
  不修改/安装 auto pack。真实世界与固定模型的性能验收尚未完成。

## 图片资源读取增量

- 新增 foundry-assets.js：本地文件 realpath 围栏、目录 junction 越界拒绝、10 MiB 有界读取、
  读取前后文件变化检查、PNG/JPEG/WebP 字节识别、强制解码结果校验和 SHA-256 稳定 Data 路径。
- Data 图片路径单独校验，拒绝绝对路径、URL、编码绕过与父目录片段；图片 bytes 仅供内部上传使用。
- 4 项定向测试通过，覆盖路径与 junction、大小上限、伪格式、解码失败和按内容生成路径；
  Desktop typecheck 与 source boundary 通过。解码测试当前使用注入接口，尚未验证真实 Chromium 解码器。
- 本地图片现已接入宿主一次申请的 cwd/page 资源租约，并通过固定 Chromium 解码读取支持三种格式。
  图片只在内部派发时编码，模型 schema、回执和操作日志均不含二进制内容。
- Runtime 在首次写前检查目标、相关读取字段与上传哈希；上传至固定 hash 路径，已有内容校验一致
  则复用，不一致则停止、不覆盖。上传后重新核查 world/Actor/相关字段，回读远端内容确认哈希。
  HTTP LAN 页面的 SHA-256 后备实现通过不同块长与 padding 边界的标准 Node 哈希对比。
- Actor create 在创建后设置图片、再授初始 Items；edit 同步头像和 prototype texture，并只同步
  已启用 Ring 的 subject。可选跨 Scene 同步 linked/unlinked Token 图片，不改名称、尺寸或布局。
  每个 Token 写入前再查图片与绑定是否变化，失败停止后续步骤，回执区分 completed/unknown/not-started。
- SDK 68 项测试通过；图片／服务／schema 定向测试通过，覆盖一次组合租约、内部编码不泄露、
  同 toolCall 单次派发、同内容复用、冲突不覆盖、局部 readRef 与逐文档 partial。
- 本增量后的 Desktop 全量 436 项测试通过；typecheck、source boundary、55 份 Markdown 链接及
  diff 空白检查通过。实际工具数保持跑团 7、备团 16，剩余两项 Scene 工具接入后备团为 18。
- Scene get/apply 后续接入见下节；真实 Foundry 上传、Ring 和 Chromium 解码仍待验收，不能标记 M3/M4 完成。

## Scene 工具增量

- sceneRead 按明确 Scene UUID 读取，不依赖 canvas；默认返回场景元数据，按需读取六类 placeables。
  每类默认 50、最大 100 条，nextCursors 给出仍有后续结果的类型；翻页沿用同一 Scene/include。
  readState 仅由宿主保存，模型拿会话 readRef；Token 删除还比较读取时文档指纹。
- sceneApply 在首次写前检查全量输入、合集外的精确 Actor 引用、重复/冲突 ID、100 项总上限，
  并通过实际 Scene/Token Document 构造、clone 和 validate 检查字段；不自己猜系统接受的范围。
- 场景 metadata、背景、Token create/update/delete 按组顺序执行，激活最后执行。
  Token 创建继承 prototype actorLink；新 Scene/Token 带 requestId，重复创建请求不会再建。
  图片上传后重查 world、Scene、局部字段和 Actor prototype，再进入文档写入。
- 每组派发前记录 unknown，回读确认才改 completed；后续失败保留已完成 UUID 和未知批次。
  布局变更比较本次触及字段，无关 hidden 等变化不阻止 x 坐标更新；删除要求文档未变。
- 两个 Scene 工具已激活，复用内容服务、图片租约和操作日志；审批摘要明确创建/更新/删除数量。
  真实 Pi 会话验证备团实际 18 个、跑团 7 个工具，旧 SDK 四默认 action 保持。
- Scene 的 5 项定向测试与宿主服务/schema/真实 Pi 激活测试通过；这些使用 Document fixture，
  尚不能证明实际 Foundry 原生字段兼容性、背景上传、布局与激活验收通过。
- 本增量后的 SDK 73 项、CLI 232 项、Desktop 437 项全量回归通过；Desktop typecheck/source boundary、
  Markdown 链接及 diff 空白检查通过。下一阶段执行全仓 verify，并逐项审计和真实验收。

## 跑团执行增量

- 新 SDK executeAction 只接受宿主从静态快照解析的动作身份；检查 world、contextRef、
  当前回合、source Token/Actor、Item/Activity，再决定 narrative 或原生路径。
- 旧 executeTurn 核心增加内部显式来源参数，旧 SDK 入口行为不变；新非战斗入口复用同一执行核。
- 普通 spell/pact/atwill 且消耗明确的叙事 Spell 可记账；额外 uses/消耗目标、未知方法和反应时序
  不静默处理。独立视觉 adapter 尚未接入，当前回执明确无动画，不冒充完整自动结算。
- 服务将动态可用 ID 映射到缓存中的 actionRef，不向动态结果重复塞入能力定义；
  narrative-only 能力按资源是否足够显示。一次战斗执行后旧 turn 证据失效。
- 新测试覆盖无 Activity 法术扣位、上下文／Token／回合失效、资源不足、非战斗推进拒绝、
  派发后失败不补扣、召唤零写拒绝、叙事成功而推进失败返回 partial。
- 非战斗攻击的新测试在原生执行函数边界注入 fixture，证明路由与来源；它不替代真实攻击验收。
  旧 CLI 232 项执行回归通过，最新 SDK 52 项测试通过；动态资源映射和工具服务的 7 项定向测试通过。
- 此增量之后已完成新工具激活，见下节；仍不把当前执行基础视作方案完成。

## 工具激活与备团搜索增量

- buildTools 注册全部自定义定义，TOOL_NAMES_BY_MODE/activeToolNames 是唯一激活来源。
  attach 校验真实 session.getActiveToolNames；未知／缺失／多余名称使 attach 失败。
- 跑团六个领域工具加 request_user_input，共 7 个；新 attach 不再暴露旧 combat_* 名称和页面 JS。
  备团当前已实现 7 个领域工具、通用提问和 4 个平台工具，共 12 个；后续增加剩余 6 项内容工具。
- 中英文界面改为跑团／Play，内部 combat key、历史目录和 prompt 文件名不变。
  Prompt 保留一次重上下文、状态直接 set、战斗前后轻读及不确定结果不重试。
- 真实 Pi 的 prep/play session 激活测试通过；工具切换后 Desktop 429 项全量回归通过。
  后续 UI 摘要与搜索接入后的 typecheck、真实 Pi 激活及 schema 定向测试通过。
- contentSearch 使用 world Actor/Scene 和 compendium Actor/Item 的限定组合，结果包含精确 UUID、
  packId/entryId/package；测试覆盖 105 条结果的分页、来源保留、游标错用、包类型和边界拒绝。
  SDK 最新 55 项测试通过；没有调用 auto pack 写接口。

## Actor 工具增量

- actorRead 提供 summary、items/resources/prototypeToken/sceneTokens 投影和分页；readState 只在
  宿主保存，模型获得会话内 readRef。场景 Token 投影跨 Scene，保留 linked/unlinked 身份。
- actorEdit 只允许 name/folder、prototype name/size/disposition、HP 和受支持 flat AC。
  按触及字段比较读取值；未读取字段或相关字段已变则拒绝，无关 HP 变化不妨碍改名。
- actorCreate 支持空白／合集来源、已有 Actor 文件夹、初始授物；首次写前解析所有来源并检查同名。
  Actor 与授予 Item 留存请求身份和精确来源；已建 Actor 的后续失败返回 partial，不删除或重建。
- actorGrantItems 预检来源与数量／装备字段，单次批量创建；同来源已存在返回 skippedExisting，
  不叠加数量、不替换。readRef 只比较本次相关来源身份，无关物品变化不阻止操作。
- 创建／编辑／授物共享本地操作记录、world 绑定、页面资源租约和 requestId；工具清单中已激活。
  图片字段的后续接入见上节；真实世界验收尚未完成，不能据当前基本读写标记 M3 完成。
- SDK 61 项测试通过，含 6 项 Actor 场景；宿主服务与真实 Pi 激活 10 项定向测试通过。
  Desktop typecheck、source boundary、Markdown 链接及 diff 空白检查通过。

## 宿主绑定增量

- 入队启动固定身份读取；日志持久化后才向首轮模型投递。元数据写失败阻止模型启动。
- 工具绑定最近已消费的输入，尚未消费的 steering 不改变当前目标；审批前固定绑定。
- 停止发生在身份读取期间时，读取结束也不会再启动模型；取消输入的元数据落盘结束后才允许删除会话。
- 状态服务只持有一层已有页面资源租约，通过 callForSession 保持遥测归属；操作查询不读页面。
- 相关定向测试通过，覆盖快照、歧义边界、状态别名、原始输入绑定、取消、删除和 schema。
- 首次全量回归发现旧停止测试把新增身份读取当作慢写；已区分 fixture 的固定读取与实际写入，
  并补充停止期间身份读取的回归测试。修复后 Desktop 全套 424 项通过；typecheck、source boundary、
  Markdown 链接和 diff 空白检查通过。仍未完成模型工具激活与真实世界验收。
