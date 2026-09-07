# 备团／跑团实施与验收记录

依据：[唯一技术方案](./foundry-prep-play-technical-plan.md)、[auto pack TODO](./todo.md)、[休息 TODO](./foundry-rest-todo.md)。
本文只记录实施证据和未完成工作，不另定产品合同。

分支：`codex/foundry-prep-play`，独立 worktree 基线 `9107c09`。未修改原主线工作目录或 auto pack。

## 当前状态

整体未完成。跑团工具、共享能力及备团搜索／Actor 基本读写已激活；图片、Scene 工具与完整验收尚未完成。

| 方案项 | 实施状态与剩余工作 |
| --- | --- |
| M0 基线／工具矩阵 | 集中 allowlist 与真实 Pi active set 检查已通过；跑团实际 7 个工具，备团当前阶段 16 个，后续加两个 Scene 工具到 18；性能基线待测 |
| M1 共享上下文 | SDK 全量 Token、结构引用，服务失效标记、operation 查询、动态动作引用映射及工具激活完成；待真实世界验收 |
| M1 状态 | SDK 源保护、原生结束专注、目标解析、四态、严格 schema、中英文别名、绑定来源服务及工具激活完成；待真实系统验证 |
| M1 操作记录 | JSONL、派发前落盘、去重、重启不重放、服务调用和会话删除清理已实现并测试 |
| M1 环境绑定 | 消息入队时固定读取 world/Scene/selection、输入日志元数据、已消费输入绑定已接入；真实 Pi 工具集合通过，真实页面并发仍待验收 |
| M2 跑团执行 | executeAction、普通 narrative-only 法术、非战斗执行、回合约束、引用解析和新工具激活完成；待完整参数覆盖与真实世界验收 |
| M3 备团 Actor | 搜索、get/create/update/grant、局部 readRef、图片上传与同步已接入；真实世界验收待完成 |
| M4 备团 Scene | Scene get/apply、背景图片、分组 Token 布局与局部回读已接入；真实世界验收待完成 |
| M5 召唤 | auto pack 只记录 AUTO-001；新 executeAction 已在扣费前拒绝召唤放置，不调用旧同先攻协议；真实组合仍待验收 |
| Prompt／UI／遥测 | 已改跑团名称、提示词、执行摘要与工具分类，历史旧工具仍可显示；新增内容工具随各阶段补充 |
| 完整验收 | 全仓 npm run verify 通过；已发现的合同审计项、真实测试世界及性能对比待完成 |

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

## 下一步

M1/M2 新工具已加入 active set；主入口显式传 SDK action 并集，SDK 默认四项保持。
图片管线、Actor 图片同步和 Scene get/apply 已接入；下一步做整体方案审计、全仓 verify、真实世界及性能验收。

M2 的完整发现→执行链路已建立，但仍需审计实际能力定义完整性与结构失效覆盖，
以及独立视觉入口是否可复用；动态结果不得携带重定义。
最后推进 M3/M4 和全套验收。真实世界验收仅使用测试世界；若缺用户授权的连接或测试材料，
先完成其它独立工作，再说明具体所需操作。

## 方案审计增量

- 第一轮全仓 verify 通过了源码、链接、类型、单测和构建阶段，在 packed consumer 检查失败：
  smoke gate 仍锁定旧 28 个 actions 和旧 runtime hash。已改为当前 39 项合同，保留默认四项断言，
  并比较打包 runtime 的实际源码哈希、声明哈希和工作区规范源码，避免仅更新常量掩盖旧包。
- foundry_play_context 的 view 字面量由实现中的 scene 修回唯一方案规定的 current，默认行为不变。
  world_status 补充 ready、模块版本和入口能力摘要；安装旧 auto pack 不会被报告为支持新召唤。
- 修正后完整 npm run verify 返回 exit 0：源码/文档检查、全仓类型检查、Desktop 437 项、SDK 74 项、
  CLI 232 项、WebMCP 24 项测试、构建，以及安装 tarball 后的 consumer/runtime/CLI 验证通过。
  该结果证明当前自动化门禁通过，不代表下列审计项或真实世界/性能验收已经完成。
- 仍需关闭的审计项：结构指纹目前包含整个 Item/Activity flags，可能被运行记录影响；
  Activity 名称/伤害等合同变化也需纳入。普通状态、资源消耗不能因此导致反复重读。
- 既有 declaredRiderOptionsV2 会按当前 active buff 效果过滤目录，须核查新一次性静态快照在
  后续效果变化时能否保持完整合同；不要为了修复此项扩大职业动作范围或修改 auto pack。
- 还需核查步骤回执 not_started 的合同拼写和 summary 字段、重投在 readRef/actionRef 失效后
  是否仍返回原操作结果，以及叙事法术独立动画入口的包侧依赖。现有测试不能替代这些证明。
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
