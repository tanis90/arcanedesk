# Skill 设计契约

状态：生效中。约束对象：本仓库所有面向用户的 agent skill（`apps/desktop/skills/prep/` 下）。
修改任何 skill 前先读本文；与本文冲突的改动，先改本文再改 skill。

分工：`SKILL.md` 是运行时操作手册，写进 agent 上下文，每个字都占 token；本文是设计期契约，
不进 App 包也不进发布 bundle。SKILL.md 里每一个用户交互、默认值和安全声明，都应能在本文
找到归属类别（第 3 节）或决策记录（第 6 节）。

## 1. 用户身份

目标用户是不懂技术的小白 DM。

- 不知道 Node、SHA256、manifest、数据目录是什么，也没有能力判断它们。
- 不应被要求做任何技术判断。问小白技术问题等于转嫁责任，还会训练他无脑点"是"。
- 他能完成的是点击类操作：按图文指引复制链接、拖入文件、点弹窗、在网页里按步骤操作。

## 2. 交互预算

每个 skill 先声明自己的用户交互预算：一次完整任务允许几个交互点，每个交互点必须满足
"只有他能做"（法律/账户/系统边界）或"一句话能答"（合并后的信任决策）。除此之外不得再有
提问、确认或选择；新增任何交互前，先论证为什么不能归入预算内已有交互点。

参考实现是 `arcane-fvtt-setup` 的 4 点：给物料 → 确认计划 → OS 弹窗 → 浏览器收尾。

## 3. 决策三分法

每个候选交互先归类：

- **A 类 法律/账户/系统边界**：必须人来。agent 的职责是保姆化指引，把认知负担降到接近零。
- **B 类 信任决策**：合并进执行计划，随确认门一次确认，不单问。
- **C 类 技术细节**：不问。用默认值 + 可逆操作 + 事后报告替代询问。

## 4. 读写分层与确认门

需要用户确认计划的 skill，按角色而不是大小划分读写：

- **读**：本地物料的哈希/签名/结构检查、HEAD 请求拿体积、小 JSON 元数据（索引、manifest、
  profile）。注意"读远端索引"常伴随落盘缓存，只要不产生对用户可见状态的变更就算读。
- **写**：任何载荷压缩包下载（哪怕几 KB）、解压、目标目录创建/变更、服务停启。

确认门之前只准读。计划展示装什么、版本、总量、准确路径（不存在的标"将新建"），用户一句
"可以/继续"放行。确认针对这份计划的版本、体积、哈希与路径：执行端用机器可校验的方式锁死
计划（如 `--expected-*` 参数），远端漂移由工具拒绝，不再问用户；计划变了（重新解析出不同
结果）必须重新展示并再次确认。用户临时说"跳过某部分"等于改计划，按新计划重新确认。

## 5. 安全底线

交互精简不触碰以下纪律：

- 不代取付费工件、license，不代替用户同意 EULA。
- 不绕过 UAC / Gatekeeper / 安全软件；静默安装不得用于绕过提权。
- 不静默覆盖用户已有的安装、内容与数据；自动备份策略必须"备份成功才继续、备份位置写进报告"。
- 所有下载先落盘、验证，再按已确认的计划使用；不执行网络响应。
- 不打印 license key、完整配置文件或凭据。

## 6. 决策记录

已拍板的具体决策按 skill 归档，一行一条：决策 + 一句理由。改决策先改这里。

### arcane-dnd5e-rules（2026-09-09）

- 用户交互预算0：读取随包提供的SRD资料、选择查询路径属于C类技术细节，不要求DM确认。
- SKILL.md兼任规则索引和查询说明；通过已有read/shell查本地Markdown，不新增查询脚本或工具，不预装完整正文到系统提示。
- 来源固定为5thSRD的SRD 5.1文本快照，附来源/署名；规则正文与本地分发调整分开记录。查不到的扩展规则不当成SRD事实。
- 区分职业、NPC数据块及FVTT实现；依据规则核对实际状态，不要求模型盲信工具，也不把玩家角色完整升级流程强加给NPC。

### arcane-fvtt-setup / arcane-fvtt-mods（2026-08-31）

- Demo 环境默认安装：用户说"帮我装 Foundry"即含 Demo world 及 profile 解析出的
  system/modules，不二次询问；一个 world 体积很小，多问一次的打扰大于收益。OSS 尚未发布
  world 时不猜 URL，Core 安装独立成功即可交接。
- 清单外第三方 mod：先查 arcane mirror 索引；未收录的给一次大白话风险提示（含官网
  arcanedesk.bitterbebop.cn 收录反馈渠道），用户确认后照装。小白没有能力也没有兴趣判断
  第三方包安全性，反复问只会训练无脑点"是"。哈希由 agent 计算核对、写进报告，不把 hex 串
  交给用户判断。
- mirror 有的内容全部走 mirror（含 dnd5e）：`community-distribution.json` 的 GitHub 条目
  降级为出处/许可证记录，不是安装来源或校验基准。禁止混链校验——mirror ZIP 为重打包，
  哈希本就不同，混链必产生误报。
- setup 交互预算定为 4 点：给付费物料 / 确认安装计划 / OS 弹窗 / 浏览器收尾。
  旧版"交付物料即授权整个计划"让下载在确认前开始，不符合"先看一眼再动"的预期。
- 目录推导规则：用户只给一个位置视为父目录，Core = `<父目录>\FoundryVTT-<版本>`、
  Data = `<父目录>\foundry-data`；明确分开指定的原样采用并各自校验；只说 Data 位置的
  Data 用它、Core 用默认。均不反问——路径推导是 C 类，默认值 + 报告足够。
- 只读旗标 `--allow-missing-data-dir` 不做全局容忍：仅 setup 全新安装流程的只读命令使用，
  输出带 `dataDirExists` 标记；stage/commit 永远严格。既有实例场景目录不存在时的硬报错是
  刻意的错误路径警报器。
- 路径表述纪律：所有路径用完整形态（`<数据目录>/Data/systems/<id>`），禁止 `Data/systems`
  裸简写——外层数据目录与内层 `Data/` 同名，简写已在真实会话中导致 system 装错层级。
  装完必须从最终绝对路径回读 manifest（id/version），当场验收。
- 逐次下载确认、无预声明哈希时再确认、单项超 250 MB 确认：全部取消，并入计划确认门。
- 覆盖冲突：自动时间戳备份即授权，备份成功才继续，备份位置写进报告。

### arcane-module-reader（2026-08-31）

- 交互预算恒定 1 次：CLI 就绪后先跑 `auth --show`（纯本地查询）探测，按结果二选一——
  已配置 Token 只问上传确认；未配置则把上传披露和"精准/免 Token"选择合并成一句。
  注册引导算那一次提问的延续，不算新交互点。已导入模组重新导入 0 次提问。
- MinerU CLI 安装是 C 类自治：只用两个官方 URL、先落盘并亲自读脚本、执行后无条件计算
  SHA256 作为本次安装指纹写进报告（CDN 不提供发布方校验值，不宣称匹配官方哈希）。
  不让用户审批脚本内容或哈希串——那是把技术责任转嫁回小白。
- 删除">100 页整本/分段"二选一：按所选模式直接跑（精准整本；免 Token 以 20 页分段），
  事后报告分段数与占位符页码范围。精准模式降级为出现实际质量问题时的事后建议话术，
  不打断流程等回答。
- Token 持久化是流程的一部分，不是可选项：用户发来 Token 后，agent 用 stdin 管道写入
  `mineru-open-api auth`（既有 `config.yaml` 先时间戳备份，`auth` 覆盖不留副本），
  再用 `auth --show` 回读验证掩码首尾，并明确告诉用户"下次新对话不用再注册"。
  `MINERU_TOKEN` 环境变量只是临时手段，不允许作为默认交付形态。
- `extract` 运行中遇 HTTP 401 / `msgCode A0211`（Token 失效）：不打断流程，降级免
  Token 分段跑完，报告说明并建议按持久化流程更新 Token。
- 上传同意以"上下文里有没有回答记录"为准：agent 上下文里已有用户回答那次提问的记录
  就不再问，后续文档直接沿用；没有记录才在第一次上传前问。不按"每份文档"重复问——
  用户见过一次即知情，不同意就不会再把 PDF 交给模型，反复问是打扰。表述上不给模型
  发明"会话边界"概念，只让它检查自己上下文里有没有记录。用户只说"导入"不视为同意
  第三方云上传。

### 发现工具三分：browse / plan / search（2026-09-15）

- `foundry_content_list` 拆为 `foundry_advancement_plan`（升级计划唯一来源）与
  `foundry_compendium_browse`（条件枚举 + uuids 读全文，吸收旧 detail）；`foundry_content_search`
  收窄为身份解析兜底。硬切换无别名——与 main 的差异是探索性质，定稿即可破坏性变更。
- 车卡发现三次拿全：browse type:"class" → plan → browse type:"race"；目录按
  rules+identifier 去重、arcane 模块包优先、2014/2024 双版本各自成行；rules 参数不传，
  由 classUuid 锚定推导。理由：实证模型在 search 中文名与 50/页翻页上浪费轮次，目录化
  把"找身份"从模糊搜索变为一次枚举。
- 写路径回执即对账：advance/grant_items 的 verification 回执就是验收依据，禁止裸 eval
  回读自检同一结果——旧"回读 actor.items 数数"教义只适用于裸 JS 授予回退路径。
- 建档写工具（actor_create/update/grant_items）补进 skill 教学：工具早已激活但零教学，
  实证 A1/A2 模型零调用；装备与法师法术书统一走 advance 的 additionalItems 单次写入。
- 完整 spec 见 `foundry-prep-tools-spec.md`（含 A1-A3 预期路径与验收标准）。

### 准备施法者全法术列表（2026-09-15）

- 用户裁决：准备施法者（2014 牧/德/圣/奇械）建卡时直接授满理论上能会的全部法术——他们
  规则上"会"整个职业法术列表，"准备 N 个"是长休时的页签标记，留给 DM 与玩家在游戏中
  自行协商；工具不管理准备（与 2026-09-14 的 prepared 决议一致：那不是数量管理）。
  法师不受此影响：法术书是独立的已知子集概念（book 照旧）。
- `spellBudget.fullList: {maxLevel, count, candidates}`：枚举来自模块合集包法术文档上的
  `flags.<moduleId>.spellClasses`（模块 build 时从 donor 法术表注入，522/522 全覆盖，
  含非 SRD 条目），运行时按职业 identifier + 最高法术位环（progression 环位表硬编码）
  过滤，不再硬编码法术清单；2024 包无此标注，2024 职业维持不下发（已知限制）。
- `actorAdvance` 新增 `fullSpellList: true` 开关：落地后按列表自动授予（≤50 一批、按来源
  UUID 去重——领域法术不会叠双），模型无需回抄 30+ 个 uuid；非 fullList 职业传此开关在
  任何写入前以 INPUT_INVALID 拒绝。list 侧仍下发完整 candidates：模型看得见将授什么。
- benchmark 语义同步：该教义进公共 skill（两臂共享）；A3 期望从"6 个点名准备法术 + 4 个
  领域法术 = 10"改为"2014 牧师 ≤2 环全列表 = 34"（SRD 32 + 典礼术/借鉴才学，验收器按
  计数制，非 SRD 条目不参与 known-membership 校验）。

### arcane-actor-update（2026-09-14）

- 法术授予不置 `system.prepared`：dnd5e 5.3.3 源码确认 prepared 只是法术书页签标记，
  无任何 usage/施放闸门；置准备是额外写操作且会把"合集默认值"覆写漂移。保持默认即可，
  用户明确要求才设置。character benchmark 校验同步移除 prepared 断言（降级为诊断项）。

### 建档属性与候选池水合（2026-09-15）

- 基础属性建档主路径是 `actor_create` 的 `dnd5e.abilities`（六属性整数 1..20）：实测种族
  与 ASI 加成不是 ActiveEffect，而是 advance 执行时对基础值做加法（两张自测卡
  abilityEffects 全空、数值逐项对得上），SET 型写入必须先于 advance——create 结构性保证
  顺序，不靠教义约束。`actor_update` 的 abilities 是 SET 语义修正路径：advance 之后写入
  必须含种族/ASI 的最终基础值。readRef 覆盖六个 `system.abilities.*.value`（actor_get
  默认下发），写前必读纪律不变。
- plan 的 `choiceRequirements` 统一水合 `candidateNames`：pool-uuid 从合集 index 取名、
  trait-key 走 dnd5e `Trait.keyLabel` 本地化（子职业池已有名）。模型在 plan 出口即可做
  语义选择，废掉"候选只有 uuid 再发 uuids-browse 水合"的强制往返（自测每案 +1 次）。
- 0 级建档的 advance 收尾自动把 `hp.value` 拉到派生好的 `hp.max`（只拉不压、回执
  `hpFill:{before,after}` 可见）：value 是 HP 步用各步当时体质调整值累加的定格历史，
  max 是 prepare 用最终体质重算的派生值，车卡中途种族 ASI 必然让两条通道对不上
  （dnd5e 源码实证；prepare 只有 min(value,max) 钳制，少了不补）。界定签名用
  "advance 前 details.level === 0"——0 级角色没有战斗史，拉满不抹任何真实状态；
  既有角色（≥1 级）升级不动当前 HP（规则语义是 max 增量同步加 value，系统已正确实现）。
  无新入参：车卡场景终态恒为满血，中间累加是纯噪声，不需要模型传旗标。

### foundry_content_list spellBudget（2026-09-14）

- `contentList(type=classFeature)` 新增 advisory 字段 `spellBudget: {ability, progression,
  cantrips?, known?, book?}`，数值全部来自 SDK runtime 硬编码的 SRD 规则表（2014/2024 两版
  + TCE 奇械），按 `source.rules` 或 classUuid 含 `classes24` 判版本、按 identifier 查表。
  非施法职业返回 null；0 值字段省略（如 1 级游侠 known=0 不下发）。
- 用户裁决：prepared 数量与公式一律不下发——准备只是页签标记，工具不管理准备；法师只发
  法术书（6+2×(L−1)，两版同公式），不发 2024 Max Prepared；第三施法者（奥法骑士/诡术贼）
  v1 放弃。法术位不进表：dnd5e 按 progression 自动计算（含兼职混合规则），重复下发只会
  与系统漂移。
- full-list 职业（牧/德/圣/奇械）发 ability/progression/cantrips + fullList（见 2026-09-15 记录）；
  known 仅 2014 诗/术/契/游；book 仅法师。Actor Studio 的 2024 列照抄 2014 有误，其数值未采用；表数值
  以 dnd5e 5.3.3 两版职业 advancement 与 TCE 奇械实测为准。
- 配套引导：`arcane-content-catalog` 重写对齐现行工具（原稿写的是实验 fixture 的旧参数面：
  小写 class/subclass、classEligible 三字段、不存在的 foundry_content_detail；fixture 侧
  与自身工具一致，不动）；`arcane-actor-update` 新增工具流与数量契约（budget→候选→对账→
  回读，环位上限从 advance 后角色的 spellN.max>0 读）。character benchmark 公共 skill
  不再直接给法术书公式（原 6+2×(L−1)=14），让工具臂 spellBudget 的优势在评测中显形，
  不与历史报告求可比（用户裁决）。

### subclass-uuid 候选池（2026-09-14）

- `choiceRequirements` 中 `valueFormat:"subclass-uuid"` 的要求现挂 `candidates`（uuid）+
  `candidateNames`（名称映射）。机制照 Actor Studio：扫合集 index 按 `system.classIdentifier
  === 职业 identifier` 过滤；但它用配置包列表（默认只有 `dnd5e.subclasses`），我们扫全部
  Item 包按 `type==="subclass"` 过滤——实测 2024 子职业住在 `dnd5e.classes24` 包内部、
  2014 全集在模块包（120 条，系统 SRD 包只有 12 条）。条目带显式 `source.rules` 且与职业
  规则版本冲突才排除，缺失规则字段的保留。
- skill 配套两段流程：先不带 subclassUuid 拿计划与候选池，定下后带它重调 list——子职业
  自身的授予/选择步骤（`subclass:` 前缀）才进输出，`actorAdvanceArgs` 才带上它。

### arcane-actor-update（2026-09-01）

- 由 `arcane-actor-images` 扩scope改名而来：头像/token 规则原样保留，新增人物条目授予。
- 法术、职业特性、专长等条目的默认来源是 arcane-dnd5e-2014-automation 模块的合集包
  （`game.packs` 中 `metadata.packageName === "arcane-dnd5e-2014-automation"`，id 已在真实
  世界实测确认）：条目数据必须与 pack 内文档一致，凭记忆手写会产生字段漂移；拿不到再回退
  `dnd5e.*` 自带包并报告来源，不打断流程反问。条目名中英双语，匹配必须兼容单一语言片段。
- 授予条目是常规页面写操作，遵循检查、最小修改、回读，不新增交互点。

### arcane-module-reader（2026-09-01）

- 交互预算由恒定 1 次上调为恒定 2 次：新增「图解提议」——每本模组资料库建成后，
  随最终报告末尾问一次要不要出几张关键图（报告不悬空等回答）；用户说要，再把
  Mermaid 图单独发一条消息进对话。上传同意的答案沿用、图解的答案不沿用：前者是
  信任决策，见过即知情；后者是每本模组各自的价值问题。重新导入不提议，最终报告
  附一句事后建议。
- 不教模型提取/阅读流程：建库时模型已通读全文，画图要不要再读由它自决。skill 只
  约束产物——图菜单（总览/骨架/线索/关系/拓扑，每张只回答一个问题）、每条边要有
  原文依据、≤15 节点、跨图同物同名。
