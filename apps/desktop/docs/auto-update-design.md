# Desktop Auto-Update Design

> 状态：技术方案（未实施，已按评审结论修订定稿）。基于 `windows-local-signing`
> 分支的先签后发链路撰写。
> 前提已成立：Windows Certum OV 本地签名（sign-windows.mjs + `--signed-dir`）、
> macOS Developer ID 签名 + 公证（CI）、OSS(cn)/R2(intl) 双轨发布均已在 0.4.3 跑通。
> 修订要点：feed 文件命名模型按 electron-updater 6.8.9 dist 实证修正（每 channel
> 2 个 feed、双架构同文件，见 §8）；补齐 `app-update.yml` 打包硬依赖；应用侧交互
> 定稿为「药丸只开门、动作全在浮层」；本期浮层不含更新说明入口（官网无 release 页）。

## 1. 背景与目标

现状：0.4.3 已完成首个双平台签名发布，但用户没有任何应用内更新通道——新版本只能
手动去下载页拿安装包。每次发版的触达成本 = 全量用户手动重装。

目标：已安装用户在应用内完成「得知新版本 → 下载（带进度）→ 重启安装」，全程不
离开应用；发布侧沿用现有先签后发纪律与不可变存储契约，不新增人工步骤。

### 非目标（本期明确不做）

- 差分/增量下载（NSIS blockmap）：签名后 blockmap 需重算，收益不确定，electron-updater
  缺 blockmap 时自动回落全量下载。留作后续优化。
- Linux 更新、强制更新 / 远程 kill switch、版本停用（deprecation）标记。
- 任何静默动作：不自动下载（`autoDownload = false`）、退出时也不顺手安装
  （`autoInstallOnAppQuit = false`）。检查到更新只点亮左上角常驻标记，下载与
  安装的每一步都由用户在浮层里显式点击触发；安装包 150MB+ 量级，不该替用户决定。
- CI 内 Windows 签名：Certum 云证书私钥不可导出，纪律仍是本地先签后发。
- 应用内 changelog：官网（arcanedesk-web，Astro）经核实无 release/changelog 页，
  本期浮层不含更新说明入口；字段化 changelog（release.json `releaseNotes` →
  feed 透传 → 浮层内渲染，electron-updater 原生支持）留作后续。

## 2. 选型：electron-updater（generic provider）

采用 [electron-updater](https://www.npmjs.com/package/electron-updater) 6.x
（与 electron-builder 26 同代，安装时锁 minor），generic provider + 程序化
`setFeedURL`，不用 electron-builder 的 publish 体系。

理由：

- NSIS 静默更新与 macOS Squirrel zip 更新是它的一等公民，恰好覆盖我们的
  `--win nsis zip` / `--mac dmg zip` 产物形态。
- 下载完成后先校验 feed 里的 sha512 再执行安装，校验失败拒装——与「feed 按
  实际发布字节生成」的纪律正好闭环。
- 不要求 CI 持有签名能力：feed 在发布期由 publish-release.mjs 生成，签名后的
  字节走 `--signed-dir` overlay 之后才计算哈希。

否决项：

- 自研更新器（把 skills-updater 的模式复制到 app 级）：要自己处理替换运行中的
  二进制、安装器静默参数、断点续传、回滚、签名校验，风险远大于收益。app 更新
  与 skill 下发不同级：失败即用户失联。
- Electron 内置 `autoUpdater`：不支持 Windows NSIS，mac 侧要求编译期绑定
  update server，与自管存储模型不合。

## 3. 更新源布局（OSS / R2）

沿用现有「版本目录不可变 + 稳定 key 可覆写」契约（见
`distribution/oss-release-contract.md` 与 release-runbook），新增一组稳定 feed key，
channel 编码进路径，与 `latest.json` 同批切换：

```text
desktop/arcane-desk[-intl]/                         ← region 前缀，两 flavor 独立
  latest.json                                       ← 现有：官网/手动下载指针（不动）
  releases/<id>/<platform>/<file>                   ← 现有：不可变版本目录（不动）
  update/<channel>/                                 ← 新增：可覆写、no-cache
    latest.yml        ← windows：x64 + arm64 共用，files[] 列两个 exe
    latest-mac.yml    ← macos：x64 + arm64 共用，files[] 列两个 zip
```

feed 文件命名是 electron-updater 的客户端契约，已按 6.8.9 dist 实证（§8）：
**频道文件名只由平台决定，架构不进文件名**——Windows 各架构一律请求 `latest.yml`，
macOS 一律请求 `latest-mac.yml`。架构选择在下载阶段发生：electron-updater 按
`process.arch` 匹配 `files[].url` 路径名选件，匹配不到时回退取第一个文件。
因此每个 feed 必须列齐该平台全部架构产物——单架构 feed 会让另一架构**静默装错
包**（如 arm64 装上 x64），比 404 更糟，不得按架构拆文件。

feed 内容（windows 为例）：

```yaml
version: 0.4.4
path: ../../releases/<id>/windows-x64/Arcane-Desk-0.4.4-win-x64.exe
sha512: <base64 of sha512>          # electron-updater 契约：base64
releaseDate: 2026-09-24T00:00:00Z
files:
  - url: ../../releases/<id>/windows-x64/Arcane-Desk-0.4.4-win-x64.exe
    sha512: <base64 of sha512>
    size: <bytes>
  - url: ../../releases/<id>/windows-arm64/Arcane-Desk-0.4.4-win-arm64.exe
    sha512: <base64 of sha512>
    size: <bytes>
```

要点：

- `files[].url` / `path` 用**相对路径** `../../releases/<id>/<platform>/<file>`，
  electron-updater 以 feed 基址按 URL 标准解析（`new URL(path, baseUrl)`），
  落到不可变版本目录。不引入绝对 URL，安装包字节保持单副本存储，feed 内容
  不含任何可指到桶外的地址。
- 同目录同时生成顶层 `path`/`sha512` 与 `files[]`，兼容 electron-updater 6.x 的
  读取路径（`files[]` 非空时优先）。
- Windows feed 只引用 NSIS `.exe`，mac feed 只引用 `.zip`（Squirrel 用 zip，
  dmg 仍服务首次安装的手动下载）；每个 feed 覆盖该平台全部架构。
- feed 对象 `Cache-Control: no-cache`，与 `latest.json` 同口径；R2 前面的
  Cloudflare 负缓存问题（2026-09-11 M3 首发事故）双保险：发布侧沿用
  publish-release.mjs verifyUrl 的 cache-buster 验证，客户端侧 electron-updater
  对频道文件请求默认自带 `?noCache=` 随机查询（`isAddNoCacheQuery`，未设鉴权
  头时为 true）。
- `latest.json` 与 feed yml 的分工：前者继续服务发布元数据与手动下载页，后者
  只服务 electron-updater。两者在同一个「切 latest」动作里一起写入、一起 verify，
  永不各自漂移；回滚（`--promote-release` 旧版本）同理。

## 4. 发布侧变更：publish-release.mjs

所有改动集中在唯一发布入口，CI 腿与本地先签后发腿自动同时获得。

1. **哈希扩展**：staging 循环里与 sha256 一并计算 sha512（base64），写入
   release.json 的 `files[]` 条目（新增字段，读侧向后兼容；`distribution/releases/<id>.json`
   回写同步获得）。桶内已发布版本的 release.json 属不可变对象，**永不回填**——
   存量版本处理见第 3 点。
2. **签名态入账**：release.json 顶层新增 `windowsInstallersSigned: boolean`，
   由本次发布是否发生 `--signed-dir` 对 `.exe` 的覆盖推导（`applySignedOverlay`
   已有该信息）。
3. **feed 生成与上传时机 = 切 latest 时**（每 channel 生成 2 个 feed）：
   - 常规发布（不带 `--skip-latest`）：在 `latest.json` 上传的同一步，生成
     `latest.yml` + `latest-mac.yml` 一并上传 + verify；任一失败视为发布失败，
     不得公告。
   - `--promote-release`：从桶里读 release.json（0.4.4 起已含每文件 bytes/sha512
     与 `windowsInstallersSigned`），重新生成 2 个 feed 并上传。回滚旧版本 =
     对旧 releaseId 重新 promote，feed 自动回指，无需额外机制。
   - `--skip-latest`（CI staging 上传）：不写 feed。随手 dispatch 不影响线上
     更新通道，与现有 skip-latest 语义一致。
   - **存量版本（0.4.3）**：其桶内 release.json 无 sha512 字段且不可变，promote
     无法为它重生成 feed。一次性处理：用本地已签名字节（仓库根
     `github-release-assets-{cn,intl}/`）计算 sha512，本地生成该版本的 2 个
     feed 并直接上传 + verify（脚本提供 `--backfill-feeds <release-id>`，步骤
     同时记入 runbook）。仅 0.4.3 需要，0.4.4 起无此问题。**已定（2026-09-20）：
     M1 阶段即对 cn/intl 两桶执行回填上传**——0.4.3 客户端没有 updater、不消费
     feed，上传为零线上风险，价值是提前用真桶验证「生成→上传→verify」全链路。
4. **未签名门禁（关键）**：切 latest 时若本次发布含 Windows NSIS `.exe` 且
   `windowsInstallersSigned === false`，默认**硬失败**——拒绝把未签名更新推给
   已安装用户（feed 是推送到用户手里的通道，比下载页敏感得多）。显式
   `--allow-unsigned-feed` 才能越过，仅限应急。注意这是对现有 CI 发布腿
   （skip_oss=false）promote 步骤的**有意行为变更**：那条腿发的是未签名
   Windows 件，今后走到切 latest 会在此处被拦下，符合 D5 先签后发纪律。
5. **纯函数 + 单测**：feed yml 构造（输入 release manifest → 2 个 yml 字符串，
   `files[]` 覆盖平台全架构）、sha512 计算、相对路径拼接拆成可测纯函数，进
   `apps/desktop/test/`。

## 5. 应用侧变更

### 5.1 新增 `src/main/app-updater.mjs`

命名避开已有的 skills-updater（那是 skill 通道，不是 app 通道）。

- electron-updater 是 CJS 包，在 ESM 主进程里用 default interop 取
  `autoUpdater`（`import updater from "electron-updater"`）。
- **`app-update.yml` 是硬依赖**：下载阶段 electron-updater 必读
  `resources/app-update.yml` 的 `updaterCacheDirName`（`loadUpdateConfig` 是裸
  readFile，缺文件 ENOENT）；`setFeedURL` 只覆盖 provider——check 能跑、下载必
  炸。因不走 builder publish，electron-builder 不会生成该文件，由
  prepare-desktop-release.mjs 生成占位文件并经 extraResources 落盘（见 5.4）。
- 仅 `app.isPackaged` 时启用；dev 运行 no-op + 一行日志（本地 E2E 用环境变量
  打开，见 §7）。
- feed URL：`regionConfig().updateFeedBaseUrl` + `/<channel>/`。channel 读取
  构建期已烘进 `generated/desktop-release.json` 的既有 `channel` 字段
  （prepare-desktop-release.mjs，env `ARCANE_RELEASE_CHANNEL`，CI 发布显式传
  `private-beta`；本地默认 `development` → feed 404 → 静默无更新，dev 包天然
  安全，不新增环境变量）。**不设置 electron-updater 的 channel 属性**（那会改
  请求的文件名前缀），channel 只编码在 URL 路径里，客户端始终请求
  `latest*.yml`。
- 参数：`autoDownload = false`、`autoInstallOnAppQuit = false`、
  `disableDifferentialDownload = true`（不发 blockmap，免 404 噪音）、
  `allowDowngrade = false`。
- 行为：启动后延迟 30s + 随机抖动自动 check 一次，之后每 24h 一次；check 的
  唯一可见副作用是点亮更新标记（见 §5.3），不下载、不弹打扰式通知。手动
  「检查更新」入口随时可用。
- 事件 → 状态机：`checking-for-update` / `update-available` /
  `update-not-available` / `download-progress` / `update-downloaded` / `error`
  归并为单一状态对象，`webContents.send("update:state", …)` 推给渲染层；
  下载完成进入 `downloaded` 后，`install` 动作调用 `quitAndInstall()`。
- **ready 跨启动恢复**：状态不落盘。重启后例行 check 重新 `update-available`，
  用户再点下载时 `downloadUpdate` 命中 `pending/` 缓存（version + sha512 匹配）
  直接发 `update-downloaded`，秒回 ready；仅 check 不会重新发 downloaded 事件。
- **install 状态守卫**：`update:install` 仅在 ready 态执行 `quitAndInstall`，
  否则返回当前状态（未下载时 quitAndInstall 会抛）。
- 状态查询 IPC 幂等可重入：渲染层刷新后主动拉一次当前状态。

### 5.2 `src/main/main.js`

app ready 后初始化 AppUpdater；注册四个 IPC handler，遵循现有
`isTrustedChatIpc` 信任模式：

- `update:check` → 手动触发 checkForUpdates
- `update:download` → downloadUpdate（重复调用幂等：已在下载则返回当前状态）
- `update:install` → quitAndInstall（带 §5.1 状态守卫）
- `update:state` → 当前状态快照（渲染层刷新/重开后主动拉取，不依赖事件时机）

### 5.3 `preload.cjs` / 渲染层

- preload `contextBridge` 增加 `checkUpdates()` / `downloadUpdate()` /
  `installUpdate()` / `onUpdateState(cb)` / `updateState()`。
- **交互模型（评审定稿）：药丸 = 常驻状态指示 + 浮层唯一入口；动作全在浮层。**
  更新检查的唯一可见副作用是点亮 chat header 左上角品牌区（index.html
  `.chat-header` 的 `.brand`，☰ 与 wordmark 旁）的更新标记。不弹 toast、不发
  系统通知。药丸可点击，但点击**只负责展开/收起浮层**，绝不在 available 态
  直接触发下载。
- **浮层 = 决策面板**：承载版本对比与全部动作（下载 / 重试 / 重启安装）。
  available 态浮层给出版本对比与 `[ Download update ]`，用户点下载才进入
  downloading。下载与安装永远是两次显式点击——用户第一下点击的意图可能只是
  「看看新版是什么」，不该直接花 150MB 流量。
- **收起规则**：动作点击后按钮短暂忙碌反馈（约 1.5s）→ 浮层自动收起；点药丸
  切换、点浮层外、按 Esc 也可关闭。收起不取消下载（下载无取消 API，唯一中断
  方式是退出应用，中途退出丢进度，下版重下）。ready 不自动弹开——药丸变 ✓
  即全部通知。用户始终不点，标记跨启动常驻：每次启动例行 check 重新发现同一
  更新，无需额外持久化。
- **浮层内容（定稿，本期无更新说明入口）**：当前版本 → 新版本号、下载进度
  （已下载/总量 + 速度）、完成后的「重启并更新」、失败原因与重试。官网
  （arcanedesk-web）经核实无 release/changelog 页，「What's new」链接无目标，
  本期不放；版本号即本期全部有效信息。changelog 字段化（release.json
  `releaseNotes` → feed 透传 → 浮层内渲染）留作后续。
- **error 态出口**：失败原因 + 重试 + 「去官网手动下载」（`websiteUrl` 现成，
  cn/intl 各配）。Windows 证书轮换导致签名校验失败（见 §11）时这是保底通道。
- **前端实现细节**：frameless 窗口 header 是 `-webkit-app-region: drag`，
  药丸与浮层内按钮必须加入 no-drag 名单（对齐现有 button/.chip/.seg-switch
  先例）；`header-tight` 窄窗 wordmark 隐藏时需定对齐策略；全部文案走 i18n
  （cn/intl 双语）；浅色/深色双主题样式。
- 标记与浮层形态（ASCII 示意，最终视觉以设计评审为准）：

  ```text
  无更新      ☰  ✦ ArcaneDesk
  available   ☰  ✦ ArcaneDesk  (↑ 0.4.4)
  downloading ☰  ✦ ArcaneDesk  (↑ 47%)
  ready       ☰  ✦ ArcaneDesk  (↑ ✓)
  error       ☰  ✦ ArcaneDesk  (↑ !)

  浮层 available               浮层 downloading             浮层 ready
  ┌─ Update ────────────────┐  ┌─ Update ────────────────┐  ┌─ Update ────────────────┐
  │ Current 0.4.3 → New 0.4.4│  │ Current 0.4.3 → New 0.4.4│  │ Current 0.4.3 → New 0.4.4│
  │                         │  │ ↓ 68.2/145.3 MB 7.9 MB/s│  │ Downloaded & verified   │
  │ [   Download update   ] │  │ [██████░░░░░░░░░░░░] 47%│  │ [  Restart and update ] │
  └─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
  ```
- 设置面板保留「软件更新」小节：当前版本 + 手动「检查更新」（无更新时的
  确认入口，含 checking 转圈与结果反馈），不承担更新流程主入口。
- mac 上 `quitAndInstall()` 与 Squirrel 的语义：点击「重启并更新」后退出即
  换装重启；Windows NSIS assisted 安装器（oneClick: false）被更新流程以
  静默模式运行，沿用注册表记录的原安装目录（用户首装自选的目录不丢），
  per-user 安装无需提权。

### 5.4 配置与打包

- `region.mjs`：`REGION_DEFAULTS` 两 flavor 各加
  `updateFeedBaseUrl`（cn =
  `https://arcane-package.oss-cn-beijing.aliyuncs.com/desktop/arcane-desk/update`，
  intl = `https://dl.arcanedesk.app/desktop/arcane-desk-intl/update`），并登记
  对应 `ARCANE_*` 环境变量覆盖键（本地 E2E 与运维联调用，对齐
  skillsUpdateBaseUrl 先例）。业务代码不出现 if(region) 分支的纪律不变。
- `prepare-desktop-release.mjs`：新增生成 `generated/app-update.yml`
  （`provider: generic`、`url: https://127.0.0.1/` 占位、`updaterCacheDirName:
  arcane-desk`，无凭证无发布语义，运行期被 setFeedURL 覆盖）；channel 写入
  已存在（`ARCANE_RELEASE_CHANNEL`），不动。
- `apps/desktop/package.json`：dependencies 增加 `electron-updater`；
  `build.extraResources` 增加 `generated/app-update.yml → app-update.yml`；
  有 build 配置变更，但不启用 builder publish。
- `verify-package.mjs`：`requiredFiles` 补录 electron-updater 的打包产物路径
  （如 `node_modules/electron-updater/out/main.js` 与 package.json）及打包后
  `resources/app-update.yml` 的存在性，过打包白名单门禁。
- `desktop-release-metadata.mjs` 的 `directDependencyPackages` 运行时校验自动
  覆盖新依赖。

## 6. 安全与信任模型

对齐 skills-updater 的通道纪律（那是远程代码下发，本通道同级敏感——更新替换的
是 app 本体）：

- feed 与安装包全量 HTTPS；feed 基址只来自 region 默认值 / 显式环境变量，feed
  内容里只有相对路径，URL 解析后仍落在同一桶前缀内，无任意外跳能力。
- sha512 钉死：electron-updater 下载完成后先校验后安装，不匹配拒装；feed 按
  实际（已签名）字节在发布期生成，先签后发在此闭环。
- Windows 安装器本身带 Authenticode + RFC3161 时间戳；§4 的未签名门禁保证
  未签名 exe 进不了 feed。
- mac：Squirrel 校验更新包内 app 的 Developer ID 签名；zip 由 CI 签名后打包，
  字节被 sha512 钉死。
- feed 写权限即发布凭证（RAM / R2 key 均无 Delete），与 latest.json 同级保护；
  版本目录不可变纪律不变，feed 只是指针。`update/<channel>/*.yml` 作为新的
  可变对象类写进 oss-release-contract.md（见 §9）。
- 打包内置的 `app-update.yml` 只含占位 url 与缓存目录名，无凭证、无发布语义，
  运行期被 setFeedURL 整体覆盖。
- 不降级（allowDowngrade = false），版本号保持三段 semver（0.4.x），
  electron-updater 按语义化版本比较。

## 7. 测试与验收

- **单元**：feed yml 构造（2 个文件、`files[]` 覆盖平台全架构）、sha512 base64、
  相对路径拼接、region→feed URL 映射、channel 读取；进
  `apps/desktop/test/*.test.mjs`（node --test 既有模式）。
- **本地 E2E（Windows 全流程）**：本地连建两个版本（如 0.4.90 → 0.4.91），
  `ARCANE_UPDATE_FEED_BASE_URL` 指向本地 loopback http server（已对
  electron-updater 6.8.9 dist 确认无 https 强制，loopback HTTP 可行；仍沿用
  skills-updater 的显式主机白名单纪律），装旧版、发新版 feed，验证
  检查 → 下载 → 重启安装 → 版本变更，生产通道零接触。
- **E2E 必验清单**（按 §8 实证结论设计）：
  - 双架构选件：arm64 客户端请求 `latest.yml` 后拿到的是 arm64 包（findFile
    按 process.arch 匹配，不允许回退到 x64）；
  - ready 跨启动：下载完成后重启应用，再点下载秒回 ready（pending 缓存命中）；
  - install 守卫：未 ready 调 `update:install` 无副作用；
  - 浮层交互：动作点击后自动收起、下载中关浮层不停、ready 不自动弹开。
- **真机矩阵**：win-x64 / mac-x64 / mac-arm64 × cn / intl（feed 指向各自 region
  桶）。**win-arm64 真机不在手（2026-09-20 确认），接受降级**：首期该架构只做
  构建侧保障——产物构建、CI 通过、feed 双架构照常发布（选件正确性由 §8
  findFile 机制 + 本地 E2E 覆盖逻辑），真机验收推迟到设备到位后随后续版本补验。
  Windows 侧另验 assisted NSIS（oneClick: false + 自定义安装目录）下
  quitAndInstall 换装后目录保持。
- **runbook**：release-runbook.md 增补——feed 对象与切换语义、回滚操作不变
  （promote 即回滚）、0.4.3 存量版本 feed 回填步骤、`--allow-unsigned-feed`
  应急口径、以及存量用户说明。

## 8. 选型验证记录（electron-updater 6.8.9 dist 实证，原 spike 已完成）

对锁定版本 electron-updater 6.8.9 的发布包直接验证，结论如下：

- **频道文件名只由平台决定**：`getChannelFilePrefix()` —— Windows 一律
  `latest.yml`，macOS 一律 `latest-mac.yml`，**架构不进文件名**（
  `latest-arm64.yml` / `latest-arm64-mac.yml` 客户端永不请求；issue #6643
  是 electron-builder 发布侧的演进，与客户端请求行为无关）。架构选择在下载
  阶段：`findFile()` 按 `process.arch` 匹配 `files[].url` 路径名，匹配不到
  回退取第一个文件 → 单架构 feed 会让另一架构静默装错包。这是 §3「双架构
  同文件」的依据。
- **`files[].url` 相对路径可行**：`resolveFiles` 以 feed 基址按
  `new URL(path, baseUrl)` 解析，`../../releases/...` 成立且不越出桶前缀。
- **sha512 契约**：base64（hashFile 默认 base64 编码）；`files[]` 与顶层
  `path`/`sha512` 双写兼容，`files[]` 非空时优先。
- **缓存双保险**：频道文件请求默认带 `?noCache=` 随机查询（
  `isAddNoCacheQuery`，未设鉴权头时为 true）。
- **无 https 强制**：运行时不对 feed URL 做协议校验，loopback HTTP E2E 可行。
- **下载缓存**：`pending/` 目录 + `update-info.json`，按 version + sha512
  命中；跨启动重新 downloadUpdate 命中缓存直接 `update-downloaded`。
- **app-update.yml 必需**：下载阶段读 `resources/app-update.yml` 的
  `updaterCacheDirName`（`loadUpdateConfig` 裸 readFile，缺失 ENOENT），
  `setFeedURL` 不替代它 → 已在 §5.4 落打包方案。
- **Windows 签名校验**：NsisUpdater 用 `app-update.yml` 的 `publisherName`
  比对安装包 Authenticode 主体；`publisherName` 为空（当前 CI 构建不签名）
  时校验跳过 → 现状无证书钉扎，防线 = sha512 + §4 未签名门禁（见 §11 风险）。
- **留真机/E2E 复核**：quitAndInstall 在 assisted NSIS + 自定义安装目录下的
  目录保持；Squirrel 在 arm64 Mac 上的 zip 选择（Rosetta 判定）。

## 9. 变更清单（文件级）

| 文件 | 变更 | 内容 |
| --- | --- | --- |
| `apps/desktop/package.json` | 修改 | dependencies + electron-updater；extraResources + app-update.yml（有 build 配置变更，但不启用 builder publish） |
| `apps/desktop/scripts/publish-release.mjs` | 修改 | sha512 计算、`windowsInstallersSigned` 入账、feed 生成（2 个）/上传/verify（切 latest 路径）、promote 扩展、0.4.3 存量版本 feed 回填（`--backfill-feeds`）、未签名门禁 + `--allow-unsigned-feed` |
| `apps/desktop/src/main/app-updater.mjs` | 新增 | electron-updater 封装：状态机、定时 check、下载/安装动作与守卫 |
| `apps/desktop/src/main/main.js` | 修改 | 初始化 AppUpdater + `update:check/download/install/state` 四个 IPC |
| `apps/desktop/preload.cjs` | 修改 | bridge 增加 update 五个方法 |
| `apps/desktop/src/renderer/chat.js`（+ index.html） | 修改 | header 品牌区常驻更新标记（frameless no-drag 处理）+ 决策浮层 + 设置面板「软件更新」小节 + i18n 文案 |
| `apps/desktop/src/main/region.mjs` | 修改 | 两 flavor `updateFeedBaseUrl` + 环境变量覆盖键 |
| `apps/desktop/scripts/prepare-desktop-release.mjs` | 修改 | 生成 `generated/app-update.yml`（channel 写入已存在，不动） |
| `apps/desktop/scripts/verify-package.mjs` | 修改 | requiredFiles 补录 electron-updater 产物与 resources/app-update.yml |
| `apps/desktop/distribution/oss-release-contract.md` | 修改 | `update/<channel>/*.yml` 列为新的可变对象类；回滚语义段落同步更新（原「仅 latest.json」表述） |
| `apps/desktop/test/app-update-feed.test.mjs`（新增）等 | 新增 | feed 构造与映射单测 |
| `apps/desktop/docs/release-runbook.md` | 修改 | feed 语义、回滚、0.4.3 回填、应急口径、存量用户说明 |
| `.github/workflows/arcane-desktop-release.yml` | 不改 | publish 腿行为被 §4 门禁有意收紧；如确需 CI 切 latest，显式传 `--allow-unsigned-feed` |

## 10. 里程碑

- **M1 发布侧**（可独立合入）：publish-release.mjs 的 sha512 / feed 生成（2 个）/
  门禁 + 单测；拿 0.4.3 字节 dry-run 验证（本地资产在仓库根
  `github-release-assets-*`），不切 latest、不影响线上。
- **M2 应用侧**：app-updater.mjs + IPC + 左上角更新标记与决策浮层 + 设置面板
  小节 + app-update.yml 打包 + verify-package 补录。
- **M3 E2E**：本地双版本全流程 + 四平台真机矩阵 + runbook 增补。
- **M4 试点**：下一个正式版本（0.4.4+）带 updater 发布。**存量 0.4.3 用户需
  手动升级一次**（bootstrap：旧包里没有 updater），此后版本才真正自动。

## 11. 风险与开放问题

- 存量用户 bootstrap：不可避免的一次手动升级，发布公告里说明（公告渠道承载
  更新说明文字，应用内本期无入口）。
- ~~feed 文件命名与 electron-updater 版本的匹配~~ → 已按 6.8.9 dist 实证并定稿
  （§8），残留风险仅真机回归项。
- **Windows 证书轮换**：若未来把签名挪进 CI，`app-update.yml` 出现
  `publisherName` 后，Certum 证书换发导致签名主体变化会使自动更新链整链断裂
  （ERR_UPDATER_INVALID_SIGNATURE）。缓解：签名主体保持稳定的证书续期策略；
  error 态浮层提供「去官网手动下载」出口（§5.3）。
- 官网无 release 页：本期浮层不含更新说明入口是设计决策（非疏漏）；字段化
  changelog 落地时浮层内渲染，不依赖外链目标。
- 安装包体积（Electron + mermaid + node runtime，150MB+ 量级）带来的下载
  体验：本期接受全量下载；差分（blockmap 发布期重算）留作后续。中途退出丢
  下载进度（无断点续传）。
- ~~win-arm64 真机是否在手~~ → 2026-09-20 确认不在手，接受降级：首期只做
  构建侧保障，真机验收设备到位后补（§7）。
- 更新结果的遥测上报（check/download/install 成败）：可跟随 skills-updater
  的 onRefreshResult 先例接现有遥测入口，非本期必需。
