# 备团模式 Web Search 产品需求（PRD）

> 状态：草案（待评审）。日期：2026-09-17。
> 背景调研见 `prep-web-search-research.md`（供应商对比与决策依据）；本文只定义产品要做什么、
> 页面怎么变、验收标准是什么。调研中的价格与条款在实施前需再次核对。

## 1. 背景与目标

备团（prep）过程中 DM 需要查规则、模组、Foundry/dnd5e 文档和近期资讯，当前助手没有联网
能力。目标：给备团模式提供一个**稳定、与模型无关的 `web_search` 工具**，搜索执行方可配置
（Arcane Spark 中转或用户自带 key），并守住调研文档确立的三条底线：

- 开源发行版默认不产生 Arcane 运营费用：新用户默认 Arcane Spark 模式——未登录 Spark
  时只有在自己配了 DeepSeek key 的情况下才会外发；两者都没有时不注册工具、零请求零费用。
- "模型决定何时搜索"与"由哪个服务执行搜索"分离；不静默跟随当前模型换用付费上游。
- 搜索与网页读取是两个工具，职责分离：`web_search` 只返回标题/链接/摘要，`web_fetch`
  才抓取单页正文；模型先用搜索定位、摘要不足时才抓取。

M2 补充（2026-10-20）：用户已经为自己的聊天模型配了 **DeepSeek key** 时，搜索自动复用
那把 key 直连 DeepSeek 官方 tools API，扣用户自己的账单，无需在「联网搜索」页再配置一次。

M8 补充（2026-10-20）：新增 `web_fetch` 工具，沿用与 `web_search` **完全相同**的接入
优先级——用户自己的 DeepSeek key 优先直连 `api.deepseek.com/v1/tools/fetch`，否则 CN
Spark 模式走 relay `/v1/fetch`，其余情况工具不进池。结果上限 64KB（与搜索的 16KB 分离）。

M10 补充（2026-10-21）：两处后端调整。① **Brave 后端整体下架**，不再是产品选项
（adapter、`BYOK_ENDPOINTS` 登记、设置页选项与文案均已删除）；自带搜索服务只剩
智谱 z-ai 与 DeepSeek 两种。② **智谱 adapter 增加网页阅读能力**：`web_fetch` 在
byok=zai 时调智谱网页阅读 API（`POST {search 端点同目录}/reader`），因此现在所有
BYOK 后端（zai/deepseek）与 Spark relay 都同时支持 `web_search` 与 `web_fetch`。

## 2. 总体方案

```text
prep agent
   -> web_search（Arcane 自有工具契约，defineTool 注册，仅 prep profile 可见）
      ├─ DeepSeek 直连：用户自己的 DeepSeek 聊天 key → POST api.deepseek.com/v1/tools/search
      ├─ Arcane Spark：同一把 Spark key 调 POST /v1/search（服务端选上游、计量、熔断）
      └─ BYOK 直连：智谱 z-ai / DeepSeek 自有 key（P1），Kimi / OpenAI（P2）
```

**接入优先级**（M2 起，用户拍板）：spark 模式（产品默认）下，① 用户在模型页配了自己的
DeepSeek key → 自动走 DeepSeek 直连；② 否则有 Arcane Spark key → 走既有 relay 路径；
③ 都没有 → 工具不注入。`off` / `byok` / `custom` 是用户的显式选择，自动接入不覆盖它们。

adapter 实现参考 `code-yeongyu/pi-websearch`（MIT，© 2026 Yeongyu）的 provider 模块
（每个 backend 是 `buildRequest` + `normalizeResponse` 纯函数，逐个移植并收入
THIRD_PARTY_NOTICES）。**不加载 pi extension 本体**：ArcaneDesk 的工具由 `AgentHost`
自建，allowlist、遥测、截断必须在自己手里。

Spark `/v1/search` 的响应字段采用智谱 web_search 结构（`search_results[].{title,url,
content,publish_date}`），使 Spark adapter 与 z-ai BYOK adapter 共享同一份解析代码；
对外仍宣称 Arcane 自有契约，换上游不动客户端。

## 3. 产品变更清单

| # | 变更 | 类型 | 阶段 |
| --- | --- | --- | --- |
| 1 | 备团 agent 新增 `web_search` 工具（combat 不注册） | 工具 | P0 起逐步 |
| 2 | 设置 modal 新增「联网搜索」tab（后端选择 / key 管理） | 设置页 | P1 |
| 3 | 设置页「探知珠」状态行 + 模式卡（选卡即保存，无确认弹窗） | 设置页 | P1 |
| 4 | 聊天流中 web_search 工具卡片与来源引用渲染 | 聊天 UI | P1 |
| 5 | 「本轮已用 N 次搜索」状态行（无独立剩余额度展示） | 聊天 UI | P1 |
| 6 | Spark 服务端 `/v1/search`：计量、熔断、z-ai 主 + DeepSeek 备 | 服务端 | P1 |
| 7 | Kimi / OpenAI key 复用（检测 + 一键确认启用） | 设置页 | P2 |
| 8 | `web_fetch`：抓取单页正文（http(s) only、64KB 上限） | 工具 | M8 |
| 9 | i18n：双语文案、结构化错误、区域化默认端点 | 全局 | P1 |
| 10 | 用户自带 DeepSeek 聊天 key 自动接管搜索（无需二次配置） | 搜索 | M2 |
| 11 | `web_fetch` 工具 + prep prompt 用法约束 | 工具 | M8 |
| 12 | Brave 后端整体下架（adapter、端点登记、设置页选项与文案移除） | 搜索 | M10 |
| 13 | 智谱 z-ai adapter 增加网页阅读（`web_fetch` 走 `/reader`） | 搜索 | M10 |

## 4. 工具契约

模型只看到一个普通 function tool：

```json
{
  "name": "web_search",
  "arguments": {
    "query": "Foundry VTT v13 dnd5e 5.3.4 更新说明",
    "count": 5,
    "freshness": "month",
    "domains": ["foundryvtt.com"]
  }
}
```

返回统一结构（供应商私有字段不进上下文）：

```json
{
  "results": [
    { "title": "…", "url": "https://…", "snippet": "…", "source": "…", "publishedAt": "2026-08-30" }
  ],
  "meta": { "backend": "zhipu", "requestId": "…", "truncated": false, "warnings": [] }
}
```

- `count` 默认 5，上限 20；`freshness`/`domains` 当前后端不支持时必须在 `meta.warnings`
  显式说明，不得静默忽略。
- host 侧只保留 **run 级去重缓存 + 用量透明展示**，不设任何客户端次数上限。窗口 = 同一条
  用户消息引发的整条 agent 链（避免与单次模型 turn 的并行工具调用混淆）：
  - 同会话同 query（归一化：trim + 折叠空白 + ASCII 小写）命中缓存直接复用，不重复执行、
    不重复计费；
  - 每轮已执行次数经 `search_usage` 事件喂给 UI 用量行，只做透明展示，不拦截调用；
  - 成本计量在 Spark 服务端（§7），客户端不做计费判断。
- `snippet` 允许缺失（DeepSeek 上游常见）；`title + url` 永远存在。
- 单条 `snippet` 截断到 1000 字符，整个 toolResult 截断到 16 KB（会话 JSONL 持久化成本；
  保留上限是为了防止上下文爆炸，不是成本控制）。

## 5. 搜索后端与设置页

### 5.1 设置 modal 新增 tab

在「模型 / 语音 / 通用」旁新增「联网搜索」tab（`pane-search`），沿用语音页的
Spark / BYOK 双路径布局与 key 掩码语义（renderer 只见 `•••`，只有"保持原值/覆盖"）：

```text
┌─ 设置 ────────────────────────────────────────────────── ✕ ─┐
│  [模型]  [语音]  [联网搜索]  [通用]                            │
├──────────────────────────────────────────────────────────────┤
│  联网搜索（备团）                                            │
│                                                              │
│  (●) 探知涟漪   已通过 Arcane Spark 启用 · 计入 Spark 账单   │
│  ( 金色=就绪 / 暗=关闭 / 橙=缺凭据 )                         │
│                                                              │
│  [○ 关闭        ]  [● Arcane Spark   ]  ← 四张模式卡,        │
│  [○ 自带搜索服务]  [○ 自定义端点    ]     点选即保存          │
│                                                              │
│  ┌─ 自带 Key 模式的凭据区(选中才展开) ─────────────────┐    │
│  │  搜索服务  [智谱 z-ai ▾]                            │    │
│  │  API Key   [••••••••••••]        [ 保存凭据 ]      │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  开启后仅发送检索所需关键词；结果存本地会话。                  │
└──────────────────────────────────────────────────────────────┘
```

- 「检测到…一键启用」文案按当前 provider 动态生成；这是**显式动作**，不是默认勾选。
  provider 判定复用 pi-websearch native 路由的映射表（`kimi-coding` → kimi `/v1/search`、
  `openai gpt-*` → Responses `web_search` 等），映射在 ArcaneDesk 侧自行维护。
- 未配置任何后端时本 tab 顶部即显示引导文案，聊天页不出现搜索入口。
- 所有新增文案进 i18n（`ss.*` 命名空间，要求见 §9）。

### 5.2 后端矩阵

| 模式 | 凭据 | 行为 | 阶段 |
| --- | --- | --- | --- |
| DeepSeek 自动接入（spark 模式内，优先级 1） | 用户自己的 DeepSeek 聊天 key（模型页已配） | 主进程直连 `POST https://api.deepseek.com/v1/tools/search`，扣用户自己的 DeepSeek 账单；无需在搜索页二次配置 | M2 |
| Arcane Spark（新用户默认；优先级 2） | 复用 Spark key | 调 `POST /v1/search`，用量并入 Spark 统一计量与账单；未登录 Spark 时工具不注册、零请求 | P1 |
| 关闭 | — | 不注册 `web_search`；优先级最高，自动接入不会把它打开 | P1 |
| 智谱 z-ai | 用户按量 key | 主进程直连 web_search API（search_std/pro）；`web_fetch` 走同一 key 的智谱网页阅读 API（search 端点同目录 `/reader`） | P1 / M10 |
| DeepSeek（显式 BYOK） | 用户搜索页填的 DeepSeek key | 同 DeepSeek 直连契约，key 走搜索页自己的 credential target | M2 |
| Kimi 复用 | 现有 kimi-coding key | 调 `api.kimi.com/coding/v1/search`（见 §8 条款待确认） | P2 |
| OpenAI 复用 | 现有 openai key | Responses `web_search`（按次计费，UI 明示） | P2 |
| 自定义 | 用户 endpoint+key | Arcane 公开的 Search 兼容契约（可指自建 SearXNG 网关） | P1 |

所有已上线后端（Spark relay、智谱 z-ai、DeepSeek 直连、自定义兼容端点）都同时具备搜索与
抓取能力；`backendSupportsFetch()` 的能力门控保留，只为将来"只搜不抓"的后端（P2 的 Kimi /
OpenAI Responses）预留——那时 `web_fetch` 不进工具池，而不是给用户一个永远
`notConfigured` 的工具。Brave 后端已于 2026-10 下架，不在矩阵内。

自动接入的边界：只按**端点 origin 匹配**（`api.deepseek.com`），要求该 provider 的
credential target 校验通过；匹配不到就回到 Spark，绝不把 key 发给未绑定的 host。凭据在
每次工具 execute 时重新解析，因此会话进行中保存/删除 DeepSeek key，下一次搜索即生效
（工具池本身在 `attach()` 时构建，不热更新——已注册的工具不会被移除，新增能力需等下一次
`attach()`／新会话）。

### 5.3 启用即知情（无确认弹窗）

打开搜索 = 用户知道查询关键词会发给所选接收方，**不再设"同意一次"流程**：
披露收敛为设置页底部一行常驻说明（`ss.note.privacy`：仅发送检索所需关键词；
结果（标题/链接/摘要）保存在本地会话记录）。安全边界不靠弹窗，靠：

- prep system prompt 的查询最小化约束（禁止 secret/绝对路径/隐私数据/大段原文）；
- credential-target 绑定：换后端/换 endpoint 时旧 Key 不跨接收方复用
  （KEY_REENTRY_REQUIRED），用户重新输入即视为明知接收方；
- 主进程独占执行：renderer 无 key 明文，请求只从主进程发出。

## 6. 会话内体验

聊天流中的工具卡片与用量提示（复用现有 tool 卡片样式）：

```text
│ ┌ 🔎 web_search  "foundry v13 dnd5e 5.3.4 更新说明"          ┐ │
│ │   5 条结果 · 1.2s · 智谱                                     │ │
│ ├──────────────────────────────────────────────────────────┤ │
│ │  1. dnd5e system 5.3.4 release — foundryvtt.com  08-30     │ │
│ │  2. …                                                      │ │
│ └──────────────────────────────────────────────────────────┘ │
│  助手回答中的来源 [1][2] 渲染为可点击链接                        │
│  ── 本轮已用 2 次搜索 · Arcane Spark ──                          │
```

- 卡片默认折叠为标题行，点击展开结果列表；每条结果「在外部浏览器打开」按钮。
- 助手回答必须以可点击链接引用来源（system prompt 约束）；渲染层把 `ref_n`/序号映射回 URL。
- 用量行只显示本轮次数与 backend（DeepSeek / Spark / BYOK 同规则）；**不展示独立搜索剩余
  额度**——Spark 模式的搜索用量并入 Spark 统一计量与账单，与语音/模型用量合并呈现；
  DeepSeek 走势必在设置页探知珠明示「计入你的 DeepSeek 账单」。
- 错误态：429（服务端预算熔断）显示"搜索服务暂时不可用，请稍后再试"并给出设置入口；后端
  不可用自动降级链（Spark 服务端处理）在 `meta.warnings` 里留痕。DeepSeek 直连的上游错误面
  （401/402/403/404/408/413/429/5xx）经同一 `fetchJson` 收敛：401/403 → `authFailed`，
  402/429 → `quotaExceeded`，其余 → `backendUnavailable`，用户面文案复用 `err.search.*`。

### 6.1 DeepSeek tools API 契约（M2）

```http
POST https://api.deepseek.com/v1/tools/search
Authorization: Bearer <用户的 DeepSeek key>
Content-Type: application/json

{"query":"…","count":5,"need_content":true}
→ 条目含 snippet(100–200 字) / summary(600–800 字) / date / rerank_score / authority，
  无 request_id
```

- `query` ≤ 128 字符（域名过滤拼成 `site:` 后缀后整体截断，后缀优先保留）；`count` 1–50，
  客户端仍按工具契约收敛到 1–20。
- 契约不支持 `freshness`：传了就按能力声明在 `meta.warnings` 显式告警，不静默忽略。
- 映射：`title`←`title|name`，`url`←`url|link`，`snippet`←`snippet|summary|content`，
  `publishedAt`←`date|publish_date`，`source`←`media|source|authority`。
- 无 `request_id`，`meta.requestId` 恒为 `null`；`normalize.js` 的 1000 字符 / 16KB 截断照旧。

### 6.2 `web_fetch` 工具契约（M8）

```json
{ "name": "web_fetch", "arguments": { "url": "https://foundryvtt.com/releases/" } }
```

返回：

```json
{
  "title": "…", "url": "https://…", "content": "…markdown…",
  "meta": { "backend": "deepseek", "requestId": "…", "truncated": false }
}
```

**URL 校验（桌面端与 relay 同一套语法规则）**：`url` 必填字符串、去空白后非空、
≤ 8192 字符、scheme 只能是 `http`/`https`、必须有 host、不得含 `user:pass@`。桌面端自己
先拦 `file:` / `data:` / `javascript:` / 自定义 app scheme——这类本地 scheme 永远不该出现在
网络工具参数里。**不做**私网 IP / localhost / 端口 / 重定向链校验：抓取发生在上游（DeepSeek、
智谱或 relay），客户端不解析域名、不建连目标站（同 relay 的设计结论）。

**结果上限 64KB（Q7）**：与搜索的 16KB 分离。抓取是单篇正文、用途是精读，预算应更大；
但仍必须有上限——超限按 UTF-8 字节截正文（不切碎多字节字符）并置 `meta.truncated=true`，
`title`/`url` 永不截断。

**抓取上游**（前两条沿用 `web_search` 的接入优先级，其余是显式 byok/custom）：

| 条件 | 端点 | 凭据 |
| --- | --- | --- |
| spark 模式 + 用户自己的 DeepSeek key | `POST https://api.deepseek.com/v1/tools/fetch`，体 `{"url"}` | 用户自己的 key |
| spark 模式 + 仅 Spark key（CN） | `POST {sparkBase}/v1/fetch`，体 `{"url"}` | Spark key（relay 计量） |
| byok = 智谱 z-ai（M10） | `POST {search 端点同目录}/reader`，体 `{"url"}`；默认由 `https://open.bigmodel.cn/api/paas/v4/web_search` 推出 `.../v4/reader`；响应 `{request_id, reader_result:{title, url, content}}`，空 `content` 映射为 `fetch_unavailable`；超时 25s | 搜索页填的智谱 key |
| byok = DeepSeek | `POST https://api.deepseek.com/v1/tools/fetch` | 搜索页自己的 DeepSeek key（credential target 隔离） |
| custom 模式 | `POST {customBaseUrl 推导}/v1/fetch`，体 `{"url"}` | 端点自己的 key |
| `off` / 无凭据 | 工具不进池 | — |

**错误面**：`400 bad_request`（我方漏校验）、`404 fetch_unavailable`（页面不存在/无法提取，
**含 relay 尚未部署时的 404**）、`413 page_too_large`、`422 fetch_blocked`（站点禁止抓取）、
`429/503 + Retry-After`（relay 刻意避开 429，桌面端映射为 `rateLimited` 而非"额度耗尽"）、
`504 upstream_timeout`。全部映射到 `err.fetch.*`，并给模型一段可执行指引（换来源/改用摘要/
不要连续重试同一 URL）。

## 7. Spark 服务端 `/v1/search`

```http
POST /v1/search
Authorization: Bearer <arcane-spark-key>
Content-Type: application/json

{"query":"…","count":5,"freshness":"month","domains":[]}
```

服务端职责（详见调研文档，此处为产品验收口径）：

- 上游：**z-ai（智谱）为主**，DeepSeek（Anthropic 端点 `web_search_20260209`，单次模型 turn）
  为降级/实验档；中国/海外端点区域选择在服务端。
- 计量：搜索 unit 并入 Spark 统一计量与账单，**不设用户可见的独立搜索额度**（DeepSeek 档按
  调用次数近似折算，标记 `approximate: true`）；客户端不设次数上限（§4），成本限速只在
  服务端按 unit 执行、运营侧可调参，不依赖客户端发版。
- 错误码：`429 quota_exceeded` / `503 backend_unavailable`，稳定可编程。
- 熔断（运营侧防护，不对用户呈现为套餐额度）：每 key 每分钟/每日上限 + 全局日预算 kill
  switch。2026-10-20 起移除日限，仅保留计量。

## 8. 安全、隐私与合规

- **凭据边界**：搜索 key 与 provider/voice key 相同待遇——`safeStorage` 加密持久化，仅主进程
  读写，renderer 只接触掩码；自定义 endpoint 遵循现有 HTTPS/loopback 与 credential-target 规则。
- **查询最小化**：prep system prompt 明确禁止发送 secret、token、绝对路径、私密 NPC/玩家
  信息和大段原文；只发检索所需关键词。
- **内容不信任**：snippet 是数据不是指令；system prompt 要求忽略网页内嵌的提示注入。
- **持久化**：toolResult 按第 4 节上限截断后进会话 JSONL；搜索摘要只存"截断摘要 + URL"，
  抓取正文按 64KB 截断，设置页注明结果保存在本地会话记录。
- **遥测**：只记录 backend family、成功/错误、耗时、结果数、search units；不记录 query、
  snippet、完整 URL。
- **条款待确认项**（沿用调研文档）：Kimi Coding Plan 第三方客户端资格；智谱 Coding Plan
  MCP 不在本期范围。（Brave 结果存储权一项随 Brave 后端 2026-10 下架而关闭；如恢复该
  后端需重新评估。）

## 9. i18n 与区域

### 9.1 界面文案（zh-CN / en-US）

- 新增文案统一进 `shared/i18n/messages.js` 字典的 `ss.*` 命名空间（跟随 `sm.*` / `sv.*`
  惯例），两语言**同步交付**；缺 key 沿用现有回落（zh-CN FALLBACK），但验收以两语言齐全
  为准。设置 tab、模式卡、工具卡片、用量行、错误态、引导文案全部走 `t()` / `data-i18n`，
  禁止硬编码字符串。
- 含变量的文案（"本轮已用 {count} 次搜索"）用现有 `{param}` 插值，不在代码里拼接句子。
- en-US 文案普遍长于中文：设置行、模式卡、卡片在 en-US 下必须完整显示，不截断、不溢出、
  不换行破坏布局。
- **主进程错误结构化**：搜索 adapter 的失败以 `{key, params}` 形态经 IPC 上抛，由 renderer
  `fmtIpc` 本地化；上游返回的原始报错不直接展示给用户，只进日志与遥测。错误 key 需要
  覆盖：凭据缺失、429 预算熔断、后端不可用、超时、取消、空结果。

### 9.2 格式化与币种

- `publishedAt` 按 locale 呈现（zh-CN `08-30`；en-US 按产品现有日期惯例，如 `Aug 30, 2026`）；
  上游给什么就用什么字符串时（如 Kimi 的 `page_age` 原文），原样透传不猜测解析。
- 费用展示按后端币种原样（智谱 ¥、DeepSeek / OpenAI $），不做汇率换算；状态行与模式卡
  文案随所选后端切换币种与单位。

### 9.3 不翻译面（沿用 i18n-plan 边界）

- 发给 LLM 的 system prompt 增量（查询最小化、引用要求、注入防护、query 语言指引）属于
  提示词面，不进 UI 字典，与 `system-prompts/prep.md` 同一维护方式。
- 搜索结果的 title/snippet、助手回答、会话记录属用户/模型数据，不翻译、不回译。
- query 语言由模型自行决定；prompt 只给指引（中文资料用中文 query、英文技术文档用英文
  query），UI 不强制。

### 9.4 区域化默认值（衔接 intl 打包）

- 智谱 BYOK 的默认端点按发行区域选择：国内版默认 `api.bigmodel.cn`，国际版默认
  `api.z.ai`（同一 adapter、不同 base URL 与币种文案）；自定义端点始终可覆盖。该差异项
  放入现有 intl overlay/regional layout 维护，**不硬编码在 adapter 代码里**。
- Spark `/v1/search` 的中国/海外上游与端点路由由服务端按 key 区域处理，desktop 不感知、
  不因区域改变工具契约。
- 区域差异只影响"默认值"，不产生区域功能裁剪：任一发行区域都保留全部后端模式。

## 10. 分阶段交付

**P0（契约与质量 POC，不发布）**
1. `AgentHost` 注册 prep-only `web_search`，接 mock + 智谱按量 + Brave adapter（Brave 已于
   2026-10 随后端整体下架删除，此处为历史记录）。
2. 跑 50–100 条真实备团 query（中文规则/模组、英文 Foundry 官方文档、指定域名、空结果），
   记录 top-5 有效率、权威来源占比、p50/p95、费用；国内/海外网络各一次。
3. 验证取消、超时、429、空结果、会话恢复、引用渲染。

**P1（开源 BYOK + Spark 首发）**
1. 设置页「联网搜索」tab、SearchStore、首次外发确认、用量行。
2. 发布 Spark / 智谱 / 自定义三种模式（首发时另有 Brave，Brave 后端已于 2026-10 下架）；未配置
   不注册工具。
3. Spark `/v1/search` 上线（z-ai 主 + 熔断 + 遥测）。
4. i18n 随功能同批交付：`ss.*` 双语文案、结构化错误、智谱区域默认端点进 intl overlay。

**M8（网页正文读取，已完成）**
1. `web_fetch` 工具：http(s) only、64KB 上限、DeepSeek 直连 / CN relay 两条上游。

**M10（后端调整，已完成）**
1. Brave 后端整体下架：删除 adapter、`BYOK_ENDPOINTS.brave`、设置页选项与 i18n 文案。
2. 智谱 z-ai 增加 `fetch()`：走智谱网页阅读 API（search 端点同目录 `/reader`，超时 25s，
   空正文映射为 `fetch_unavailable`）；至此所有 BYOK 后端与 Spark relay 均支持搜索 + 抓取。

**P2（key 复用）**
1. Kimi / OpenAI 检测 + 一键确认启用（条款确认后）。
2. DeepSeek 上游转正或淘汰（依据 P0/P1 质量 A/B 数据）。

## 11. 验收标准

1. 全新安装、未配置搜索：设置 tab 引导清晰，备团/combat 会话均无 `web_search` / `web_fetch`
   工具，无任何搜索或抓取网络请求。
2. 防护与计量：同一 query 重复调用命中缓存且不重复计费；同轮内不出现任何客户端次数上限
   或预算提示，用量行如实显示本轮已执行次数；服务端返回 429（服务端熔断）时 UI 显示对应
   文案与设置入口；Spark 搜索用量并入统一计量，无独立剩余额度展示。
3. BYOK 模式：key 以掩码显示、重启后保持；换 endpoint 需重新确认；renderer 侧代码路径
   无法取得明文 key。
4. 引用：含搜索结果的回答中每条引用可点击跳转原始 URL；会话恢复后引用仍有效。
5. 持久化：单条搜索 toolResult ≤ 16 KB、单条抓取 toolResult ≤ 64 KB；JSONL 恢复会话不丢失
   结果列表与正文。
6. 启用无弹窗：模式卡选卡即保存即生效；探知珠状态行如实呈现接收方与计费；未登录
   Spark（或 BYOK 未存 key）时工具不注册、零网络请求。
6b. DeepSeek 自动接入：模型页已配 DeepSeek key 时，spark 模式下 `web_search` 直接调
   `api.deepseek.com/v1/tools/search` 且只带用户自己的 key（不经过 Spark 中转）；未配时
   回落 Spark relay；`off`/`byok`/`custom` 不受影响；探知珠显示「计入你的 DeepSeek 账单」；
   会话中保存/删除该 key，下一次搜索即改变走向（无需重开会话）。
6c. `web_fetch`：与 `web_search` 同一条凭据优先级（spark 模式下 DeepSeek key 优先，否则 CN
   relay）；byok 模式下 zai/deepseek 均可用（zai 走智谱网页阅读 API `/reader`，空正文报
   `fetch_unavailable`）；只接受 http(s) 绝对 URL，`file:`/`data:`/`javascript:` 在发请求前
   即拒绝；relay 未部署时 404 显示可恢复指引而不是错误崩溃；正文超 64KB 时截断并标
   `truncated`；combat 模式不提供该工具。
7. i18n：新增文案 zh-CN / en-US 齐全（`ss.*`、`err.fetch.*`）；en-US 下设置行、模式卡、工具卡片完整显示
   不截断不溢出；主进程搜索错误经 `fmtIpc` 本地化，UI 不出现上游原始报错；`publishedAt`
   与费用币种按 locale/后端呈现；国内/国际发行包的智谱默认端点随区域 overlay 生效。

## 12. 非目标

- 不做通用浏览器/自动操作 Bing 网页（调研文档已否决）。
- 不做模型原生 server tool 直通（Kimi `$web_search` builtin、GLM `type:"web_search"`）；
  Kimi 走独立 `/search` 端点。
- 不因「当前选中哪个聊天模型」而更换搜索上游。唯一的自动联动是按**端点 origin** 复用
  用户自己已经配置的 DeepSeek key（同一把 key、同一个接收方、同一份账单）；其余上游仍需
  用户在「联网搜索」页显式选择。`off` 模式优先级最高，自动接入不会把搜索重新打开。
- combat 模式不提供 `web_search` / `web_fetch`。
- 不做完整网页抓取工程（JS 渲染、反爬绕过、多页爬取、站内镜像）；`web_fetch` 只读取
  上游已提取的单页正文。
- 不在本期做搜索结果的历史聚合/研究工作台。
