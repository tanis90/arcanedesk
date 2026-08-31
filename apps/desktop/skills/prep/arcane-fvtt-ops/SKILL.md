---
name: arcane-fvtt-ops
description: 运维本机的 Foundry VTT(FVTT)服务器。当用户要求启动/停止/重启本地 Foundry、查看 FVTT 日志、排查端口 30000 占用、切换或进入世界(world)、处理 options.json.lock 锁文件、或询问"Foundry 起着没/能不能连上"时使用。全新安装、升级、迁移机器、备份世界等场景改用 arcane-fvtt-setup;本 skill 只管既有实例的启停与排障。
---

# Arcane FVTT 本地运维

**先探测,不假设。** 每台机器的安装位置、数据目录、世界列表都不同。使用当前平台 shell 检查 Arcane Node、用户指定或常见位置里的 Foundry 安装、30000 端口和数据目录；不要递归扫描整块磁盘。探测结果只在本次会话有效,换机器或重装后重新探测。

App 会在 Agent 会话启动前安装并校验随包携带的 FVTT Ops Node。当前会话中 `ARCANE_FVTT_NODE` 是其绝对路径,Node 所在目录也位于会话 `PATH` 首位,因此普通的 `node`/`npm` 会解析到同一版本；这不修改用户或系统 PATH。诊断时可核对：

Windows PowerShell：

```powershell
$env:ARCANE_FVTT_NODE
& $env:ARCANE_FVTT_NODE --version
(Get-Command node -ErrorAction Stop).Source
```

macOS / Linux Bash：

```bash
printf '%s\n' "$ARCANE_FVTT_NODE"
"$ARCANE_FVTT_NODE" --version
command -v node
```

不要切换到系统 Node、nvm 或自行安装其他 Node。实际启动 Foundry 时使用 `ARCANE_FVTT_NODE` 的绝对路径,不要仅依赖命令名解析。环境变量缺失、路径不存在或版本不是 App 发行清单要求的版本时停止，建议重启或更新 Arcane Desk，不要自行修复 Node。

## 探测(最先做,一次拿全)

macOS / Linux Bash：

```bash
# 服务器起着没:200/302 = 起着
curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:30000; echo

# 占 30000 的进程 PID(停服只杀这个 PID,不要批量杀 node——MCP bridge、本 app 也是 node)
lsof -iTCP:30000 -sTCP:LISTEN

# 默认数据目录和已有世界
ls -d ~/Library/Application\ Support/FoundryVTT 2>/dev/null
ls "<数据目录>/Data/worlds"
```

Windows PowerShell：

```powershell
# 服务器起着没:200/302 = 起着
try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:30000).StatusCode } catch { "unreachable" }

# 占 30000 的进程 PID；只处理 OwningProcess，不批量杀 node
Get-NetTCPConnection -LocalPort 30000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess

# 默认数据目录和已有世界
$arcaneDataDir = Join-Path $env:LOCALAPPDATA "FoundryVTT"
Test-Path -LiteralPath $arcaneDataDir
Get-ChildItem -LiteralPath (Join-Path $arcaneDataDir "Data\worlds") -Directory -ErrorAction SilentlyContinue |
  Select-Object Name, FullName
```

地址默认 `http://127.0.0.1:30000`。数据目录下的关键子目录是 `Config`(`options.json`)、`Data/modules`、`Data/worlds` 和 `Logs`。

Headless 入口是实际安装中的 `resources/app/main.js` 或 Node 分发包里的 `main.js`。先检查用户给出的准确安装位置，再检查平台常见位置和用户明确提到的父目录；从相邻 `package.json` 验证 Foundry 版本。Node 路径取 `ARCANE_FVTT_NODE`，不要从 skill 位置反推 App 安装目录。

## 启动

**默认 headless 启动**——只起服务器,配合 Arcane Desk 右侧面板使用,不弹独立窗口。启动前必须已经从探测结果得到真实的 Node、`main.js`、数据目录和世界 id。

macOS / Linux Bash：

```bash
rm -f "<数据目录>/Config/options.json.lock"
cd "<main.js 所在目录>" && nohup "<Node绝对路径>" main.js --dataPath="<数据目录>" --world=<世界id> > /tmp/fvtt.log 2>&1 &
```

Windows PowerShell：

```powershell
$arcaneNode = $env:ARCANE_FVTT_NODE
$arcaneMain = "<main.js 绝对路径>"
$arcaneDataDir = "<数据目录>"
$arcaneWorld = "<世界id>"
$arcaneLogOut = Join-Path $env:TEMP "arcane-fvtt.out.log"
$arcaneLogErr = Join-Path $env:TEMP "arcane-fvtt.err.log"
$arcaneArgs = @(
  ('"{0}"' -f $arcaneMain)
  ('--dataPath="{0}"' -f $arcaneDataDir)
  ('--world="{0}"' -f $arcaneWorld)
)

Remove-Item -LiteralPath (Join-Path $arcaneDataDir "Config\options.json.lock") -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $arcaneNode `
  -ArgumentList $arcaneArgs `
  -WorkingDirectory (Split-Path -Parent $arcaneMain) `
  -RedirectStandardOutput $arcaneLogOut `
  -RedirectStandardError $arcaneLogErr `
  -WindowStyle Hidden `
  -PassThru | Select-Object Id, Path
```

- `--world` 可省略:省略则停在 Setup 页,带上则启动后直接进世界。
- 首次或切世界后启动要等 25-30 秒(migration + 世界加载),再检查 HTTP 和端口。
- dmg 装的 GUI 版也能 headless：`main.js` 在 `.app/Contents/Resources/app/main.js`，用 `ARCANE_FVTT_NODE` 运行。若出现 quarantine 相关原生模块错误（经 setup 流程安装的副本已在首启前清除 quarantine，该错误只可能出现在未经 setup 流程的存量副本上），先验签并确认准确 App 路径；只有用户明确授权后才按 setup skill 的 macOS 流程定点清除 quarantine。不要重签/去签包内文件，也不要用 `ELECTRON_RUN_AS_NODE`。
- `ARCANE_FVTT_NODE` 不可用时不要改用系统 Node。需要临时交互使用可 `open "/Applications/Foundry Virtual Tabletop.app"`，但应同时报告 Arcane runtime 异常。
- 不要直接执行 `.app` 里的二进制做版本检查。Electron 会前台启动整个 app，stdout 管道关闭后可能因 EPIPE 崩溃；版本检查读取 `Contents/Resources/app/package.json`。

## 停止 / 重启

macOS / Linux Bash：

```bash
# 拿到 PID 后优雅停,别用 -9
kill <PID>
```

Windows PowerShell：

```powershell
# 先用 Get-NetTCPConnection 核对 PID
taskkill.exe /PID <PID> /T
# 进程不退出时再强制终止
taskkill.exe /PID <PID> /T /F
```

重启 = 停止 → 确认端口释放 → 清锁 → 启动。

## 看日志

macOS / Linux Bash：

```bash
ls -t "<数据目录>/Logs"/debug*.log | head -1 | xargs tail -80
ls -t "<数据目录>/Logs"/error*.log | head -1 | xargs tail -80
```

Windows PowerShell：

```powershell
$arcaneLogs = Join-Path "<数据目录>" "Logs"
Get-ChildItem -LiteralPath $arcaneLogs -Filter "debug*.log" -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content -Tail 80
Get-ChildItem -LiteralPath $arcaneLogs -Filter "error*.log" -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content -Tail 80
```

健康启动的标志行是 `Server started and listening on port 30000`。

## 页面视觉诊断

端口、HTTP 和日志先完成探测；只有这些证据不能解释用户看到的页面时，才调用 `foundry_open` 打开或复用右侧 Foundry 面板，再调用一次 `foundry_screenshot` 查看当前可见 viewport。适合确认：

- Setup、Join、License、migration、Critical Failure 或长期不消失的加载层；
- 阻塞操作的对话框、角色卡、目标选择或模板放置界面；
- 黑屏、缺贴图、Canvas 未渲染、token 位置、墙体/光照等视觉异常；
- 运维修改或 reload 后，页面是否产生预期的可见变化。

截图只提供视觉证据。精确的 URL、`game.ready`、世界 id、Document 内容和日志仍用 `foundry_open`、`browser_evaluate` 或 shell 回读；不要从像素猜测隐藏状态或精确数值。不要轮询截图，也不要在每一步后机械调用；通常问题现场一次、修复后一次已经足够。

当前模型不支持图片时不要反复调用截图，改用页面状态、DOM 和日志诊断。用户正在输入密码或其他凭据时不得截图；截图工具也不得用于索取、读取或传递凭据。

## 纪律

- 本地数据视为用户数据；备份或删除前先备份，不要在聊天里打印 license 或完整 `options.json`。
- 有副作用的操作(停服、清锁、改配置)执行前用一句话说明要做什么。
- 只终止已确认监听 30000 的 Foundry PID，不批量终止 Node、Electron 或 PowerShell 进程。
