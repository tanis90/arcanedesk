# Foundry 备团与跑团工具：唯一技术方案

日期：2026-09-07。状态：实施方案，功能尚未实现。

本文完整定义本轮要做的产品行为、工具合同、实现架构、兼容迁移和验收要求。
本文是本轮工作的唯一实施依据，不依赖此前 spec、架构讨论或风险评估稿。
既有安装/运维、安全和会话架构文档继续适用于各自领域，不另行定义本文工具行为。

延期事项：[短休/长休 TODO](./foundry-rest-todo.md)。两种模式本轮均不实现休息接口、
内部休息服务或通过 execute_action 使用的休息动作；该 TODO 不属于本轮交付承诺。

### auto pack 协作纪律

auto pack 正在独立重构。本轮只允许只读查看其实现，不实际修改 auto pack 的源码、
编译器、生成物、版本或发布配置，也不安装/发布修改版、不迁移其世界数据。
发现任何需要 auto pack 配合的变更，先记录到 [auto pack TODO](./todo.md)：
写清背景、需求、改造思路、App/SDK 依赖与未满足时的行为、后续验收条件。
同一事项持续更新，不把待讨论 API 当作已经存在或已获包侧确认的合同。

本纪律也适用于第 8 节的取消召唤同先攻，以及后续休息、专注或完成回执中发现的包侧依赖。
第 8 节保留目标与协议草案，不能据此授权修改 auto pack；包侧工作交由其重构工作统筹，
只有用户后续明确恢复包侧实施后才可修改。休息相关细节继续由休息 TODO 记录并互相链接。
App/SDK 可推进不依赖包改动的部分和兼容检查；依赖缺失时在首次写入/扣费前明确拒绝，
不复制包内规则、注入补丁、绕过检查或用旧同先攻协议冒充新召唤能力。
这些待办不阻塞无关能力交付，但依赖未满足的功能必须标记未完成，不能宣称整份方案已交付。

## 1. 目标与边界

把高频 Foundry 操作封装成固定工具，减少模型临时写 JavaScript、选择 API、搬运 ID、
管理技术参数和重复回读的成本。DM 负责裁定，agent 负责落实。

| 模式 | 产品名称 | 负责什么 |
| --- | --- | --- |
| prep | 备团 / Prep | 内容制作、角色与场景编辑、资料整理、安装运维 |
| combat | 跑团 / Play | 探索、扮演、休整和战斗中的法术、攻击、状态、资源操作 |

保留内部 `combat` key、历史目录和会话模式标记，只修改产品显示名称。
是否正在战斗由 Foundry 世界状态决定，不新增探索/战斗开关，不自动切换聊天模式。
保留主线已有的会话模型隔离、多会话驻留、任务调度、通知、资源等待和取消行为。

最终行为：

- 备团的常见角色/场景任务无需生成页面 JS。
- 跑团的明确状态指令通常一次工具调用完成。
- 没开战也能查角色能力、施法和执行明确的攻击。
- 角色关注范围：有战斗取本场参战 Token，无战斗取当前 Scene 全部 Token。
- 关注范围一次返回完整静态信息与能力，后续只读轻量动态状态；不逐角色查询能力。
- 执行者必须是关注范围内的 Token；叙事施法正确记账，可用动画则展示，无动画也完成。
- 门、锁、地点等无需全部实体化；法术的叙事结果由 DM 决定。
- 召唤保留原生放置，取消自建同先攻绑定；DM 用普通战斗跟踪器参战、独立掷先攻。
- 专注何时结束由 DM 下指令，不新增自主到期、回合 tick 或跨战斗清理系统。

不做：完整无 Token Activity/Midi 自动化、通用门锁/物品目标模型、职业动作新实现、
反应/插入 workflow、仪式与长时间施法协议、世界时间管理、战术裁判、自动开战、
所有 Document 的 CRUD、任意脚本 passthrough。Walls/Lights 等场景写入留待后续。
已有职业相关能力不在本轮重构范围，不把它们当新功能承诺，也不顺手删除旧行为。

## 2. 最终工具清单与数量

### 2.1 模式矩阵

| 工具 | effect | 备团 | 跑团 | 变化/用途 |
| --- | --- | --- | --- | --- |
| foundry_open | interface | ✓ | ✓ | 保留连接与登录停机点 |
| foundry_screenshot | read | ✓ | — | 保留视觉诊断 |
| browser_evaluate | unknown/write-capable | ✓ | — | 仅备团保留高级路径 |
| world_status | read | ✓ | ✓ | 开放给备团；固定诊断替代跑团 JS |
| foundry_play_context | read | ✓ | ✓ | 替换 combat_turn_context，无战斗也能读现场 |
| foundry_conditions_set | write | ✓ | ✓ | 新增状态设置/移除与结束专注 |
| foundry_content_search | read | ✓ | — | 新增世界/合集内容搜索 |
| foundry_actor_get | read | ✓ | — | 新增角色编辑前读取 |
| foundry_actor_create | write | ✓ | — | 新增空白/合集角色创建 |
| foundry_actor_update | write | ✓ | — | 新增有限字段与图片/Token 更新 |
| foundry_actor_grant_items | write | ✓ | — | 新增从合集授物 |
| foundry_scene_get | read | ✓ | — | 新增明确场景读取 |
| foundry_scene_apply | write | ✓ | — | 新增场景元数据、背景、批量 Token |
| foundry_static_context | read | — | ✓ | 保留 combat_battle_context 的一次重上下文协议，扩展无战斗场景范围 |
| foundry_execute_action | write | — | ✓ | 替换 combat_execute_turn，兼容战斗与叙事使用 |

备团保留原三个 Foundry 工具，增加七项核心能力（search、actor get/create/update/grant、
scene get/apply）和三个共享入口（world_status、play_context、conditions_set），
共十三个 Foundry 工具。另保留平台 read/edit/write/powershell 或 bash。

跑团固定六个 Foundry 工具：open、world_status、play_context、static_context、
execute_action、conditions_set。相对原六工具：移除 browser_evaluate，
替换三个战斗名称，新增状态，数量不变。不同时注册旧名称作为模型可见别名。

主线已存在的 `request_user_input` 是通用会话工具，两个模式均保留，不计入六个
Foundry 领域工具；因此主线合并后的实际跑团 active set 是七个，备团是十八个。
测试必须核对真实总集合，不能以“领域六个”掩盖额外注册。

### 2.2 唯一工具可见性来源

所有自定义定义通过 Pi `customTools` 注册；`TOOL_NAMES_BY_MODE` 精确清单传入
Pi `tools`，同时控制 builtin/custom。取消 combat null=所有 custom 的扩大语义。
`buildTools()` 不按模式过滤核心定义；模式差异只在 allowlist、prompt 和 policy。
shell 继续由同名 custom override 提供应用管理的 Node 环境。

会话 attach 后校验 `session.getActiveToolNames()` 与清单集合完全相同，未知名称、
漏注册、多注册均失败。分阶段开发只加入已经实现的工具，不预注册占位名称。
`excludeTools` 仅用于紧急禁用，不替代模式清单。不为普通开战/结束战斗动态装卸工具。

## 3. 架构与职责

```mermaid
flowchart TD
  A[备团 / 跑团 AgentHost] --> B[Pi 精确工具清单]
  B --> C[工具 schema 与模式 policy]
  C --> D[Desktop typed Foundry services]
  D --> E[主线资源协调器 foundry:page]
  E --> F[共享 DirectFoundryRuntime / SDK 队列]
  F --> G[固定页面 Runtime]
  G --> H[Foundry Documents / dnd5e / Midi]
  G --> I[Arcane 模块原生召唤适配]
```

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 模型工具 | 领域输入、短说明、结果呈现 | 拼 JS、通用 SDK action 名、Base64、技术请求身份 |
| mode policy | 工具可见性、审批偏好、回合执行限制 | 复制一套 prep/play 业务实现 |
| Desktop services | 精确引用、内部请求身份、本地资源读取、结果映射与编排 | 自己执行 Foundry 文档方法 |
| 资源协调器 | 页面/工作目录资源互斥、等待提示、取消、实际操作生命周期 | 世界外所有 GM 操作的全局锁 |
| SDK | typed action、preflight、允许 action、串行队列、dispatch 与中断语义 | 模型工具选择和 UI 模式 |
| 固定 Runtime | 执行时重新检查对象/资源、受限读写、实际回读 | 模型提供的代码、叙事裁定 |
| 自动化模块 | 现有法术/攻击 hooks 与召唤原生集成 | 强制施法者与召唤物同先攻的新协议 |

每 App 仍共享一个 Runtime client。复用主线 `withResources`、`foundry:page`、
`callForSession` 与 AsyncLocalStorage 的归属传递，不能恢复为每模式新建 client。
资源锁在最外层取一次，组合服务调用无锁内部 SDK 方法，禁止嵌套获取同一页面锁。
图片操作同时需要工作目录资源时一次申请所需资源集合，避免先锁文件再等页面的死锁。

SDK 单 action 串行不等于多个 action 的事务。状态/记账采用单次固定组合 action；
图片、角色创建等多阶段操作由服务持有外层资源租约，记录每步结果并重新核查必要身份。
取消/超时后底层未停止时，沿用主线实际操作保留资源机制，不因模型收到响应就解锁。
本轮不增加优先级队列、后台时间管理器或另一套恢复锁。

## 4. 公共模型合同

### 4.1 精确身份与有限输入

新 schema 全部 `additionalProperties: false`，采用可判别 union，拒绝不属于分支的字段。
ID/UUID/ref 最多 256 字符，名称 256，搜索 query 256；枚举固定，数值必须有限。
写目标最终是精确 UUID/ID；模糊匹配只用于搜索结果，不直接决定写入。

```ts
type Source =
  | { kind: "actor"; actorUuid: string }
  | { kind: "token"; tokenUuid: string }
  | { kind: "selected" }
  | { kind: "name"; name: string; scope: "focus" | "actors" };

type DataImage =
  | { kind: "local"; sourcePath: string }
  | { kind: "foundry"; dataPath: string };

interface ActorImageInput {
  image: DataImage;
  syncPlacedTokens?: boolean; // default false
}

interface CompendiumGrant {
  packId: string;
  entryId: string;
  expectedName?: string;
  expectedType?: string;
  quantity?: number; // integer 1..999
  equipped?: boolean;
}
```

Source.name 只允许完整名称或已有配置别名的唯一匹配，scope 固定搜索边界；重名返回
至多五个候选，首次写前停止。focus 是本场参战 Token 或无战斗时当前 Scene 全部 Token。
跑团只接受 focus 内的 token/selected/name，不接受独立世界 Actor 引用或 actors scope；
不从世界 Actor、配置队伍或其它 Scene 补充角色。不建设 roster 配置与队伍发现功能。
actor/actors 仅供备团编辑和备团的共享状态操作，仍可处理未放图的世界角色。

selected 绑定消息提交时的受控 Token 快照，不混用 targeted tokens；用于单一施法者
时必须唯一，批量状态则允许展开。引用场景 Token 时保留其实际 synthetic Actor；
不能把 unlinked Token 的消耗或状态写到同源世界 Actor。

### 4.2 技术参数不交给模型

Desktop 注入 `requestId`、会话/任务/toolCall 身份、绑定 world、必要 scene 和当前回合
证据；模型 schema 不暴露这些字段。读取的 UUID 与动作引用可直接用于下一步。
消息所属会话、世界、选中目标不随当前可见聊天或用户后来点选改变。
world 绑定包含 Foundry origin 与 worldId，避免不同服务器的同名/同 ID 世界相互混淆。
在用户消息入队时固定代码读取轻量 page/world/selection 身份，写入该输入的宿主元数据，
不将整场景注入 prompt；当时未连接则记录空身份，不能执行时猜测 selected 指向。

只有备团“基于刚读到的内容进行编辑”使用 `readRef`。readRef 是会话内不透明句柄，
保存目标与读取投影；Runtime 在写前核对本次涉及字段/嵌入对象的摘要。无关 HP 变化
不使图片编辑失效；普通状态/扣费/攻击不要求 readRef 或全 Actor revision。
引用失效或涉及未读取字段时重新读取相应投影，不让模型拼 fingerprint。

### 4.3 统一写结果

```ts
type StepReceipt = {
  step: string;
  targets: string[];                 // exact UUIDs
  state: "completed" | "not_started" | "unknown";
  summary: string;
};

type WriteResult =
  | { status: "completed"; operationRef: string;
      steps: StepReceipt[]; verification: Verification; warnings: string[] }
  | { status: "rejected"; operationRef: string;
      code: string; message: string; candidates?: Candidate[] }
  | { status: "partial"; operationRef: string; retry: false;
      steps: StepReceipt[]; message: string }
  | { status: "indeterminate"; operationRef: string; retry: false;
      steps: StepReceipt[]; message: string };
```

Verification 为每个 typed action 的明确结果投影：编辑字段 before/after、创建 UUID、
状态 before/after、资源变化、召唤成员等；不是任意完整文档。Candidate 只含精确引用、
name、type 与必要区分信息。旧 executeTurn v2 外层保持兼容，Desktop 映射为该结果。

rejected 保证没有世界/资源副作用；partial 是已确认部分完成；indeterminate 是派发后
不能确认结果。后两者禁止自动重放，即使参数看似幂等。completed 已含所需核验，
除保留的战斗后 turn 回读外，不要求模型再读一次来重复验证。

### 4.4 轻量操作记录

复用会话/任务持久化边界，新增本地 operation 记录，主键为 session/task/toolCall，
存储 requestId、world、参数摘要、dispatch 标记、步骤和结果，不存图片二进制。
文件位于 `userData/foundry-operations/<sessionId>.jsonl`，串行追加；创建目录/落盘失败时
在 dispatch 前拒绝写入。按会话删除流程一并清理，不与用户项目内容混放。
派发前先落记录；同 toolCall 重复投递返回原结果或原不确定状态，不再次写入。
不同的新命令不按参数去重。重启时有 dispatch 无终态的记录标为不确定，禁止自动续写。
创建文档额外在 flags.arcanedesk 保存 requestId，用于按精确身份回查重复创建。
不建通用 world ledger 或分布式事务。掉线时仅有扣费余额不足以证明是哪次请求造成，
不能凭余额猜成功后恢复发送。readRef/actionRef 重启后失效，操作记录仍可查询。

## 5. 备团内容工具合同与执行

以下参数除注明可选外必填；UUID 必须属于绑定 world 或允许的 Compendium。

### 5.1 foundry_content_search

输入：`scope: world|compendium`、`documentType: Actor|Item|Scene`、`query`；可选
`packIds`（最多 20）、`actorType`、`itemType`、`limit`（默认 20，最大 100）、`cursor`。
首版组合仅 world Actor/Scene、compendium Actor/Item；其它组合返回 INPUT_INVALID。
输出精确 UUID/id/name/type；合集另含 packId/entryId/package。有限分页，不扫全文后
把全部文档送给模型。来源模组、角色类型等足够消歧即可。

### 5.2 foundry_actor_get

输入 `actorUuid`；可选 `include: [items,resources,prototypeToken,sceneTokens]`、
`limit`（默认 30，最大 100）及对应分页 cursor。默认 summary：name/type/folder/img
和关键 HP/AC。输出 readRef；完整 Item/system 原文不作为默认结果。
sceneTokens 读取该世界各 Scene 中真正指向目标 Actor 的 Token，区分 linked/unlinked。

### 5.3 foundry_actor_create

输入 `source: {kind:blank,actorType:character|npc} | {kind:compendium,packId,entryId}`、
`name`；可选 `folderId`、`image: ActorImageInput`、`initialItems: CompendiumGrant[]`。
initialItems 最多 50。folder 必须是已有 Actor folder；不按名称自动创建目录。

流程：解析合集与资源 → 检查同名/同 request → 建 Actor → 设置图片 → 授初始物品
→ 最小回读。全部可预检项在首次写前检查。同名返回已有候选，不随意再建；DM 可改名
后再次请求。同一来源创建不同名字允许。Actor 已建而后续失败返回 partial 和 UUID，
不删除已建角色、不重新创建。初始图片同已有角色图片规则。

### 5.4 foundry_actor_update

输入 `actorUuid`、`readRef`、非空 `changes`。白名单：

```ts
interface ActorChanges {
  name?: string;
  folderId?: string | null;
  image?: ActorImageInput;
  prototypeToken?: {
    name?: string;
    width?: number; height?: number; // >0, <=100
    disposition?: -1 | 0 | 1;
  };
  dnd5e?: {
    hp?: { value?: number; max?: number; temp?: number };
    ac?: { flat?: number };
  };
}
```

不暴露任意 dotted patch。HP 非负且 value 不超过修改后的 max；临时 HP 非负；flat AC
仅适用于当前配置支持的模式，不能只写 flat 后声称派生 AC 已改变。超出支持范围拒绝，
具体数值由 Runtime 检查实际 system 字段，不自动裁定“合理属性”。
image 更新 actor.img、prototypeToken.texture.src；Token Ring 已启用时同步 subject
texture，不擅自启用 ring。syncPlacedTokens=true 时只更新绑定 Actor 的存量 Token
图片/ring，不能覆盖其独立名称、尺寸、位置。范围在回执列出，逐文档报告部分完成。

### 5.5 foundry_actor_grant_items

输入 `actorUuid`、`readRef`、`items: CompendiumGrant[]`（1..50）。
只从精确 pack/entry 获取，不接受完整 Item 文档。校验数量、类型、expectedName/Type。
复用来源追踪和批量 createEmbeddedDocuments；同来源已存在时返回 skippedExisting，
不默认叠加数量，不自动替换已有物品。读取 projection 必须包含相关嵌入 Item 身份；
真正需要调整既有数量或重复授予时明确说明首版范围，不能偷偷重复创建。

### 5.6 foundry_scene_get

输入 `sceneUuid`；可选 `include: [tokens,walls,lights,tiles,notes,sounds]`、limit/cursor。
默认元数据、背景、尺寸、网格、active 与 readRef。显式读取目标 Scene，不依赖当前
canvas。placeables 分类型分页，默认 50、最大 100，不把整张大场景返回。
读类型可以宽于首版写类型。

### 5.7 foundry_scene_apply

create 分支输入 `operation:create` 和 scene；update 分支另要求 sceneUuid/readRef。
scene 白名单：name、active、background:DataImage、width、height、grid。
grid 为 type/size/distance/units；尺寸、网格类型和范围使用实际 Foundry 支持值验证。
create 必须有 name，缺省尺寸/网格使用系统默认；update 未提供字段保持原值。

```ts
interface TokenPlacement {
  actorUuid: string;
  x: number; y: number; // scene pixel coordinates
  name?: string;
  hidden?: boolean;
  disposition?: -1 | 0 | 1;
  width?: number; height?: number;
  elevation?: number;
  actorLink?: boolean;
}
interface TokenPlacementUpdate {
  tokenId: string;
  changes: { x?: number; y?: number; name?: string; hidden?: boolean;
    disposition?: -1 | 0 | 1; width?: number; height?: number; elevation?: number };
}
interface TokenLayout {
  create?: TokenPlacement[];
  update?: TokenPlacementUpdate[];
  deleteIds?: string[];
}
```

tokens 为可选 TokenLayout；合计至多 100 个操作，ID 不可重复或同时 update/delete。
actorLink 缺省继承 actor prototypeToken，不强制设 false。坐标/尺寸有限且通过系统验证。
流程：预检/准备背景 → 创建或更新 scene → 按 create/update/delete 分组批量写 Token
→ 必要回读 → 若 active=true，最后激活。顺序固定、逐组记结果，不循环单 Token API。
删除是 destructive 操作，审批摘要明确数量；第一版不删除 Actor/Scene。
create Scene 与 Token 都记录请求来源，导航不确定时可查已创建对象，不盲目重建。
不写 walls/lights/tiles/notes/sounds；后续在同一工具加可选段，不增加 CRUD 工具矩阵。

### 5.8 图片与本地资源

本地 sourcePath 最大 4096 字符；Desktop realpath 校验在用户 prep cwd 内，拒绝目录
穿越、符号链接越界。首版 png/jpeg/webp，单文件至多 10 MiB；校验真实格式与大小。
模型不读取/传 Base64。SDK 内部有界上传到 Data 的 `arcanedesk/assets/<hash>.<ext>`，
默认不覆盖不同内容；成功后保存稳定 Data 相对路径，不写系统绝对路径。
dataPath 同样只接受有效 Data 相对路径，拒绝外部 URL、绝对路径与 `..`。
无法上传/文件不在围栏时返回原因，不用 shell 越界搬运。工具输出不包含二进制内容。

## 6. 共享世界、现场与状态

### 6.1 world_status

保持无参数。输出 world ID/title、system/version、Foundry version、GM/ready、
必要模块与 capability 摘要。未就绪等待采用既有上限；失败由固定代码返回 URL/page
ready/runtime 状态，不让跑团模型写诊断 JS。
foundry_open 遇到 /join 保持登录停机点，由用户登录，禁止自动提交凭据或轮询登录。

### 6.2 foundry_play_context

输入 `{view:current}`（默认）、`{view:turn}` 或 `{view:operation,operationRef}`。
current 自动读取同一关注范围的动态状态：有效战斗取参战 Token，无战斗取当前 Scene
所有 Token。turn 保留战斗回合的读取语义，无有效回合时返回 turn:null 和场景动态状态。
返回范围标识、Token 身份、HP/资源/状态、当前行动者与 availableActionIds 等轻量信息；
不返回完整能力定义、input schema、描述或静态角色卡，不引入逐角色读取分支。
轻量指每个对象只读必要动态字段，不是截断 Token 数量；静态/动态关注名单必须一致。
operation 只查本会话已知操作记录和已确认结果，不执行恢复写，不枚举别的会话记录。

静态上下文与动态上下文的动作标识由服务维持稳定映射，不每次读取重新生成引用。
模型从一次完整静态上下文获得定义，后续通过轻量可用 ID 判断当前可执行动作；
不能为了查 ID 再逐角色获取能力。状态/记账不强制读动态上下文，战斗动作保留最新 turn 前置读。

### 6.3 foundry_conditions_set

输入 `targets: Source[]`（1..20）、`conditions: [{key,active:boolean}]`（1..8）。
selected 作为批量选择时必须是唯一 selector，展开后仍最多 20；相同实际 Actor 去重。
重复矛盾的 key/active 拒绝。key 由受支持 system ID/版本化中英文别名精确解析，
不靠名称猜自定义效果，也不把全部 CONFIG.statusEffects 放进 prompt。

只提供明确有/无，不提供 toggle，不混入 HP patch。执行内部解析目标、预检、读取
当前状态、设置、回读。已满足条件为 noop，不重复创建。linked Token 共享 Actor
影响在回执说明；unlinked 只写实际 synthetic Actor。

普通状态使用验证过的系统入口。去状态不能删除承载其它属性/状态的整个效果；
复杂来源返回 SOURCE_MANAGED 和来源说明，不假称解除。仅纯手动标记可直接去除。
专注是明确支持的特殊分支：active=false 对系统专注调用正式结束入口；对手动标记
直接去标记。系统已关联的清理属于此次命令结果；无关联资料不猜着删模板/召唤物。
active=true 仅手动标记，不模拟施法、不创建资源/法术依赖关系。
输出实际对象与 key 的 before/after/noop、剩余来源和 warnings；不返回完整 effects。

不新增专注检定、倒计时、回合/战斗结束监听；新手动标记等待 DM 移除。
既有 system/Midi 已有自动化不被本轮静默禁用，agent 也不把实际已变状态自动恢复。

## 7. 角色动作发现与执行

### 7.1 foundry_static_context

输入保持无参数，不增加 scope/source/query/limit/cursor 分支。它是静态上下文工具，
不是能力搜索工具；foundry_static_context 的名称替换不改变原 battle_context 的核心职责。

Runtime 自动确定关注范围：

- 有有效战斗：使用本场 combatants 的 Token，完整保留原 battleContextDataV2 的
  参战者、阵营、static blocks、完整 action 目录和 input 合同，一场战斗开始时读一次。
- 无有效战斗：枚举当前 Scene 文档的全部 Token，同一次调用返回全部角色静态信息与
  完整能力目录。包含隐藏/未选中的 Token，不按玩家队伍、友敌或是否当前可见筛选。
  无 Actor 的 Token 仍返回身份和空能力说明；不去世界里找替代 Actor。

输出范围标识（world、scene、可选 combat）、完整 Token 名单，以及各 Token 的静态
角色数据和全部受支持动作定义（稳定 actionRef、名称/type、input 合同、执行路径）。
完整重上下文直接进入模型对话上下文，不能仅在宿主缓存后让模型反复按角色取片段。
非战斗首次读取较慢可以接受，不用分页、Top-N 或逐角色查询换取首次响应速度。
如果超过实际传输/上下文硬上限，明确报告，不能静默截断后称为“全部”。

之后只调用 foundry_play_context 获取动态状态，不重复传静态描述与参数合同。
切换 Scene、开始新战斗或结束战斗导致范围改变时，下一次需要能力前重新读一次重上下文。
同一范围内新增/删除 Token、相关 Item/Activity 被替换等确实使快照失效时，轻量读取
或执行返回明确失效信号，按需重建一次；普通 HP/资源/状态、回合变化不触发重读。
已存在历史的会话恢复时，如宿主引用失效则重建一次，不重放旧写调用。

actionRef 必须绑定 world、scene、source Token、实际 Actor、Item、可选 Activity 和
合同版本；执行时确认 Token 仍在当前关注范围，再检查最新资源，不接受世界 Actor 旁路。
对有 Token 且可明确计算普通消耗的 Spell Item，可返回仅 narrative 引用，不强行
要求 utility Activity。反应/职业动作不作为本轮新增可执行项，限制随静态目录说明。

### 7.2 foundry_execute_action 模型输入

```ts
type ExecuteInput =
  | { actionRef: string; targetTokenUuids?: string[];
      input?: ActivityInput; resolution?: "auto" | "narrative"; advance?: boolean }
  | { actions: Array<{actionRef:string;targetTokenUuids?:string[];input?:ActivityInput}>;
      advance?: boolean };
```

批量 1..20，仅现有战斗同一行动者序列，拒绝同时传单次和批量字段；非战斗一次一个。
召唤必须单次。resolution 默认 auto，批量不支持 narrative。advance 默认 false，
无有效战斗时 true 拒绝；DM 明确要求结束回合时才能传。首版不增加纯 advance-only
分支，保留现有执行后推进语义，原生界面仍可单独推进。

ActivityInput 沿用稳定已支持合同：spellLevel、attackRollMode、selections、allocation、
declaredRiders、targetSpec。字段只在该动作 input 合同允许时生效；新 wrapper 不接受
任意 extras。selections key/value 由目录列出的有限集合验证；allocation 是精确目标
与数量，declaredRiders 只兼容已有声明。目标模式仍 self/selected-targets/placed-template，
不为门锁补新实体模式。既有兼容字段在旧 SDK v2 保持行为，不扩大新工具输入范围。

source 来自 actionRef，execute 不允许另传 source 替换角色。
工具描述只讲用户意图；技术 requestId、world、turn、资源池选择由服务/Runtime 处理。

### 7.3 决定路径后再写

1. 解析引用，检查 world/source/Item、实际战斗关联与必要资源。
2. 选择既有自动化或叙事记账，构造固定执行计划。
3. 执行前完成可检查的输入、余额、目标与能力校验。
4. 执行并按路径核验，写操作记录，返回准确结果。

auto 优先既有受支持系统/Midi 流程。施法者必须有关注范围内 Token；写前已知无实体目标且属于可记账的
普通叙事法术时进入 narrative；不能把缺失伤害目标、反应、未知消耗或无效配置都
当成可静默兜底。攻击/真正放置召唤不无提示降为“记账成功”。
DM 明确只记录施法可用 narrative，即使该法术也能自动化；此路径明确不结算伤害/放置。
调用原生流程后即使失败/超时，也不能改路径再扣一次。不存在“先试，再补扣”策略。

### 7.4 自动化路径

从 executeTurnV2Data 提取共同的动作定位、参数/资源检查、performUseAction 和回执
核心；Turn policy 只负责当前行动者与推进。非战斗使用明确 source，仍复用现有
攻击/法术流程与实际 Token，不建设完整无 Token Activity 执行。

普通攻击继续由系统/Midi 完成命中、弹药、伤害等，不自行计算 HP 或推断优势。
无 combat 的明确攻击不自动开战；“开战并攻击”顺序未明确时交 DM/宏处理。
正在有效回合内只允许当前行动者主动执行，不能用 narrative 绕过回合限制。

现有 execute 完成后仍由 play_context(view=turn) 获取战斗实际变化，不把旧原生
执行响应误当完整伤害状态。新 wrapper 先保留这个已知协议；合并后置回读是独立
性能优化，不在本轮混入行为变更。

### 7.5 叙事记账路径

用于 DM 主导的易容术/敲击术等：要求关注范围内施法者 Token、真实拥有的 Spell Item 和可识别消耗。
复用已有资源池解析；普通 spell slots 与明确升环、已支持池按实际配置扣除；
确认无消耗则不扣。拒绝不明确/不足资源，不自动升环、换池或增加上限。
只需小范围 Actor 消耗服务，不需要完整 actor-only Activity adapter。

单次固定 Runtime 内：读余额 → 一次受限 Actor 更新/受支持纯消耗入口 → 回读。
用纯消耗入口时必须证明不会重复施法/hook 消耗；不能调用完整 Item use 后再手扣。
已绑定 Token 且独立视觉入口可用时播放动画，不触发第二次 Item use；无动画时跳过视觉。
Token 消失/离开关注范围时在扣费前拒绝，不降成无 Token 记账；扣费后消失则报告已扣费与未播放。
动画失败为 warning，记账仍 completed。回执区分“已记施法与消耗”和“已自动结算”。
不宣称门已解锁、画像已变或 NPC 已受骗；不创建对应实体。

仪式/长施法时间由 DM 线下处理，本工具不计时/推进时间。明确提出暂不支持用法时
说明限制，不能把仪式偷偷按普通扣位处理。纯叙事施法不自行创建专注生命周期；
DM 需要状态标记时使用 conditions_set。

## 8. 召唤改造：去掉同先攻依赖

本轮采用原生召唤放置后，DM 用普通战斗跟踪器加入战斗并独立投先攻。
没有 Combat 或先攻不再是召唤失败；不自动创建 Combatant，不提供同先攻开关，
不开发“探索召唤后开战时重新绑定施法者先攻”的状态机。

原生 dnd5e Summon 提供选择和场景放置；Foundry 核心战斗跟踪器提供投先攻。
这是减少自定义维护的流程选择，不是对所有召唤法术规则的断言。
参考：[dnd5e Summon](https://github.com/foundryvtt/dnd5e/wiki/Activity-Type-Summon)、
[Foundry Combat](https://foundryvtt.com/article/combat/)。

### 8.1 模块侧待办（本轮只记录，不实施）

以下为交给 auto pack 重构工作的需求与改造草案，追踪于 [AUTO-001](./todo.md#auto-001-召唤解除同先攻与战斗依赖)。
具体函数位置和接口以重构后的实际实现重新核对，本轮不修改该包。

公开模块 `packages/auto2014-runtime/src/automation.js`：

- prepareNativeSummonUse 保留 GM、实际 source Token、场景、profile、请求身份、
  数量和权限检查，移除 source Combatant/有限 initiative 的必需条件。
- finalizeNativeSummonCore 以确切放置 Token、所有权、来源、资源及已有原生完成
  信号收尾，不再调用 nativeSummonEnsureCombatants、复制 inheritedInitiative、
  保存/恢复同先攻特殊游标或要求 active Combat。
- 不新增生命周期监听器。已存在且正常工作的来源/系统依赖保留；移除只为同先攻
  建立的条件。遗留召唤物已有 Combatant 不自动删除/重掷，新召唤走新规则。
- 编译器/emitter 和输出 marker 同步新协议；Actor 上复制的旧 Item 不能假设自动更新。

### 8.2 协议版本化草案（待包侧确认）

建议模块新增 capability `nativeSummonPlacementV2`，采用新 API
`finalizeNativeSummonPlacement`，不在旧 finalizeNativeSummonUse 下悄悄改变回执。
新 marker 明确 `combatBinding: "manual"`，新 schema 显式识别，不向旧严格 marker
随意塞额外字段；编译器和 SDK parser 同时更新。

新 placement 回执包含 schema、requestId、sourceActorUuid/sourceTokenUuid、
activityUuid/profileId、expected/placed/skippedCount、members[{tokenUuid}]、
消息/workflow 引用（如有）、已确认资源/来源和 warnings；不要求 Combatant/initiative。
DM 跳过全部放置时资源可能已消耗，报告“已施法，放置跳过”，不假称已有实体；
用户要求放置但只放部分时返回 partial，禁止自动重施。

旧 API/SDK executeTurn v2 继续服务旧调用方，旧战斗行为不被新结构字段破坏；
新 executeAction 只有新 capability+匹配 marker 才调用新放置协议。旧版本组合
在首次写前返回 CAPABILITY_UNAVAILABLE，明确需要更新模块/角色数据，不能先扣费。
发布验收必须测试旧/新模块、旧/新 Actor Item 的矩阵；不批量迁移玩家世界数据。

## 9. 最小环境校验与恢复

只检查与本次命令相关的身份和条件；不要求世界整体快照不变。

| 变化 | 行为 |
| --- | --- |
| 发消息时选 A，执行前选 B | selected 使用提交快照中的 A；回执写实际名称 |
| “当前人攻击”读到 A 后已转 B | 校验捕获的 combat/currentCombatant/round/turn，零写拒绝 |
| 无关角色 HP/状态变化 | 不阻止本次状态/记账，不重载整个目录 |
| 资源已被 DM 用掉 | 读取当前余额，不用模型记忆；不足拒绝 |
| 换世界 | 绑定 world 不匹配拒绝，不按名字找新世界替身 |
| 刷新后仍同世界 | 写前重新定位精确对象；已派发的不确定请求不重放 |
| 切场景 | 重建新范围的静态上下文；旧来源不在关注范围则零写拒绝，叙事记账也不能绕过 |
| 来源 Token 删除/离开关注范围 | 不再发现或执行，不回退世界 Actor 扣费 |
| 排队时开战 | 检查 source 的实际关联回合；非当前人拒绝，未开始 tracker 不等于战斗 |
| 只切 App 会话 | 请求仍属于原会话/任务/对象，不能随当前可见会话漂移 |

不只看全局 game.combat 是否非空：对相关 Scene/实际 Actor 检查真正进行中的战斗。
关联不唯一时说明，不默选；其它场景独立战斗不应阻止无关联角色的叙事记账。
所有检查在排队结束、实际 dispatch 前执行，审批等待后再验一次必要条件。
外部 GM 不受本地锁保护；遇到实际并发冲突回读并报告，不循环把世界改回旧状态。

派发前取消是零写；派发后中止/超时/导航沿用四态。动画与可选展示失败不等于扣费失败。
恢复仅能查看原 operation 与实际对象；不能自动重放 partial/indeterminate，也不能
用 browser_evaluate 做同一次失败写的替代通道。

## 10. Prompt、审批、回执与性能

跑团 prompt 按意图短路：状态直接 set。休息由 DM 在 Foundry 原生界面操作，不在静态
上下文注入休息动作，也不通过 execute_action 或属性 patch 模拟休息。使用能力前若当前范围尚无有效
静态快照，调用 static_context 一次获取全部重上下文；不按指令逐角色查询能力。
非战斗后续从已有目录选动作直接 execute；战斗后续每次最新 turn、execute、战斗后
turn 回读，不重复静态目录。旧“每条指令必读
turn”的描述必须同步缩小，不让工具说明重新阻塞状态/叙事快速路径。
成功回执一行；复杂 partial/indeterminate 只说明已确认结果与需要 DM 处理的部分。

备团 prompt 和 actor skill 更新结构化优先；未覆盖的 Journal/高级内容仍可用受控
browser_evaluate，但不能在结构化写不确定后换 JS 重试。安装/迁移等已有 skill 流程不变。
跑团不注册 JS/shell/文件工具，诊断走 world_status 固定实现。

read 无写审批；write 经统一入口，但默认明确指令不额外弹确认，尊重已有
ARCANE_APPROVALS/用户设置。删除 Token 等 destructive 摘要明确对象数量。
审批拒绝/缺目标通过通用现有交互入口处理，不新增专门审批工具。

遥测按 session/task 归属记录 tool、effect、模型可见调用数、耗时、队列等待、
Runtime 耗时、人工等待、结果状态和已提供的 token 用量；不记录完整角色文档、路径
内容或图片。不能把“少工具”直接当作已证实思考更快。

## 11. 实施文件与 SDK action 划分

以下新文件名是本方案的目标拆分，不是声称已经存在。无需修改 Pi SDK。

| 区域 | 修改方式 |
| --- | --- |
| apps/desktop/src/main/agent-host.js | 保留主线会话生命周期，注册工具工厂、精确 allowlist、工具归属与审批 |
| apps/desktop/src/main/main.js | 注入同一 services/runtime/resources，保留主线 session registry/scheduler |
| apps/desktop/src/main/foundry-tools.js（新增） | TypeBox schema、说明、tool→service 映射，无 raw Runtime passthrough |
| apps/desktop/src/main/foundry-services.js（新增） | 引用解析、注入调用上下文、编排/核验映射，显式业务方法 |
| apps/desktop/src/main/foundry-operation-store.js（新增） | 轻量本地操作记录与查询，接入会话持久化根目录 |
| apps/desktop/src/main/foundry-assets.js（新增） | cwd realpath 校验、有界图片读取、hash 路径 |
| direct-foundry-runtime.js / scheduling | 显式可配置新 action allowlist，复用页面资源锁/排队和会话归属 |
| packages/foundry-sdk/src/contracts.ts | 新 typed action map、effect、输入/输出类型；旧四默认 action 不变 |
| packages/foundry-sdk/src/runtime-helpers.ts | 共用身份/成本/目标/动作计划校验；不加入模式 UI 判断 |
| packages/foundry-sdk/src/runtime-source.ts | 固定执行实现并同步 hash/source drift gate，不在 Desktop 复制 runtime |
| system-prompts/combat.md / prep.md | 改模式职责与工具协议；文件 combat.md 名称可保留 |
| renderer/i18n/global types/telemetry | 显示“跑团”、新结果卡片、operation 及实际目标展示 |
| 自动化模块 runtime/compiler | 本轮只读；第 8 节需求记录到 auto pack TODO，由包侧重构统筹，当前不修改 |

SDK 新稳定 actions：`contentSearch`、`actorRead`、`actorCreate`、`actorEdit`、
`actorGrantItems`、`sceneRead`、`sceneApply`、`playContext`、`staticContext`、
`executeAction`、`conditionsSet`。`worldInfo` 复用；`assetUpload` 补有界
typed 合同供内部使用。action 与模型工具不要求一一对应。
已有 actorSearch/Get/Update、AddItemsFromCompendium、sceneSnapshot 等可被内部复用，
但旧泛型调用方合同不被强制替换；sceneApply 内部采用批量嵌入 Document API。
executeAction 内含自动化/记账两个固定分支，不另暴露一个任意消费/patch 模型工具。

默认 SAFE_DIRECT_ACTIONS 保持 worldInfo/battleContext/turnContext/executeTurn。
Desktop 明确传应用所需 action 并集，工具只调用具体 service 方法；不能开启全部
ALL_DIRECT_ACTIONS。新写 action 都声明 write，进入原中断不可重试路径。

## 12. 分阶段交付与迁移

| 阶段 | 交付 | 完成门槛 |
| --- | --- | --- |
| M0 基线整合 | 将 spec 分支 Pi allowlist 基线合入最新主线；建立工具矩阵与性能基线 | 不回退模型/语言、多会话、通用提问、资源协调；真实 Pi active set 通过 |
| M1 共享能力 | world_status、play_context、conditions_set、operation 记录 | 无 combat 状态一次调用，结束专注、选择快照/精确身份通过 |
| M2 跑团执行 | static_context、execute_action、叙事记账、普通非战斗攻击 | 参战/Scene 全量重上下文一次读取，后续轻量；有 Token 的叙事施法；旧战斗回归通过 |
| M3 备团 Actor | 搜索、actor get/create/update/grant、图片同步 | 角色创建/授物/改图无需 JS，局部 readRef 和 partial 正确 |
| M4 备团 Scene | scene get/apply、背景和批量 Token | 非当前 Scene、批量布局、删除与回读通过 |
| M5 召唤简化（等待包侧） | 本轮记录 AUTO-001 和实现 App/SDK 写前能力检查；包侧就绪后再对接 placement 协议 | 当前验证缺能力零写拒绝；完整完成仍需有无 combat 放置、不继承先攻及版本/旧 Item 矩阵通过 |

阶段是依赖和验收顺序，非排期承诺；模块改造本轮仅记录 TODO，不实际实施。
每阶段只注册已实现工具。M2 必须同时交付发现与执行，不只改名称留下半条链路。
M5 前新入口对未支持召唤清楚拒绝，不先扣位；全部阶段完成才是本方案完整交付。

实现前先同步最新主线，保留其未提交修改，不用旧 agent-host.js 全文件覆盖。
本分支曾在 eb75fbd 完成工具注册基线，不代表最新主线已经包含它；按实际 diff 整合。
旧会话历史中的工具调用照常展示但不重放；新 attach 使用新工具集，旧 actionRef 失效。
运行中会话不热换 schema。内部 combat mode/会话目录继续兼容，显示名更改不搬 JSONL。
模块升级不自动迁移世界/角色数据，受影响 Item 按已授权备团流程更新后重新发现。

## 13. 验收与性能门槛

### 13.1 自动化测试

- Pi 真实 session 的 prep/play 完整 active names，包括 builtin/request_user_input；
  prep-only 不泄漏、共享工具同实现、未知名称 attach 失败。
- 所有新 schema 的边界/unknown fields、effect、固定 Runtime source/hash 同步。
- world/UUID/selected 快照、unlinked Actor、重名、相关 turn 改变、资源不足零写。
- 状态 set/noop/来源效果、DM 结束专注；不引入自动生命周期事件监听。
- 记账只扣一次：原生派发失败不切 narrative、动画失败不重扣、同 toolCall 重投不写。
- 创建/授物/场景布局 partial 和回读；图片越界/过大/格式错误拒绝。
- 资源锁等待/取消、真实底层未结束时租约保留、无嵌套死锁、会话切换不串归属。
- 两模式均不注册休息工具，静态上下文不注入休息动作；新旧召唤 capability/marker/receipt
  组合与旧 executeTurn 回归。包侧未就绪时可用 fixture 验证合同和零写拒绝，不能替代真实召唤验收。

### 13.2 真实世界验收

固定记录 Foundry、dnd5e、Midi、Arcane 模块版本及最小真实 Item/Activity fixture；
当前代码检查不代表这些组合已验证。使用受控测试世界，不直接在玩家世界试错。

| 用户任务 | 必须确认 |
| --- | --- |
| 搜索合集怪物并创建改名 NPC | 精确来源、无重复创建、回执 UUID |
| 授武器/物品、更新头像 | 已存在来源不重复；prototype/ring/所选存量同步正确 |
| 创建背景/网格/多个 Token 的 Scene | 无 JS、明确 Scene、按批写入、部分成功可查 |
| 选中两人加倒地、指定角色去中毒 | 正常一次调用；选中变化不串人；不删除不相关效果 |
| DM 要求断专注 | 真正结束相应专注或去手动标记，准确报告系统关联结果 |
| 易容术、无实体门的敲击术 | 施法者必须有范围内 Token；正确消耗，不要求门/锁文档或动画存在 |
| 无 Token 的世界角色 | 不出现在跑团静态能力范围，不能执行或扣费；备团内容编辑不受影响 |
| 一次近战、远程及法术攻击 | 命中/伤害/弹药/资源正确，不自动开战或推断优势 |
| 有/无 combat 召唤（等待包侧） | 包侧未就绪时首次扣费前拒绝；就绪后验收原生放置、不要求/复制先攻、不强制参战，DM 可普通投先攻 |
| 超时/刷新/仅聊天卡/模块后处理失败 | 不把提交当完成，不补扣，不重施，原 operation 可查 |

### 13.3 流畅度

固定同一模型、推理档位、世界与模块组合；冷连接、热连接、人工等待分开记录。
交错基线/新版本，每样本至少十次，比较模型可见调用数、token、p50/p95 总时长、
队列/Runtime/人工等待。只记录供应商实际提供的 reasoning token，不臆测思考时间。

- 状态：明确目标/支持状态时一次工具调用，无 battle 目录和额外验证读。
- 同一战斗首次一次重上下文包含所有参战者完整能力；后续多个回合只读动态状态，
  无逐角色能力查询、无反复传 action schema，原 battle_context 协议不得退化。
- 无战斗一次返回当前 Scene 全部 Token 静态能力；超过 30/100 个也不能自动分页截断。
  非战斗首次完整快照→执行两次；同范围有效快照下后续使用一次 execute。
- 切 Scene/新战斗需要一次新快照；Token/Item 确实变化按失效信号刷新，无关状态变化不刷新。
- 既有战斗：调用数不增加；p50/p95 超基线 10% 时扩大样本定位，不带明显回归发布。
- 备团创建/授物/场景任务不调用 browser_evaluate；结果紧凑且有限分页。

10% 是回归门槛而非已测结论。无法执行的旧非战斗场景不编造提速百分比，
另外与备团 JS 完成同一任务的路径比较。全文所述功能/性能均须按本节验证后才能标完成。
