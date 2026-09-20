# 部署执行手册(探测 / Docker / 镜像通道 / 验证 / 冲突 / 裸机)

## §1 探测序列(连入后,全部只读、零写入、秒级)

能探测的绝不问用户。顺序固定,后一步在前一步结果上收敛。非 root 用户先
`sudo -n true` 探免密 sudo,不可用则请用户处理(`ss -p`/`docker` 需要权限)。

| # | 命令(SSH 在目标机执行) | 判定 |
|---|---|---|
| P1 | `curl -sS -m 3 http://127.0.0.1:30000/api/status`(**loopback**,不受安全组影响) | 在不在跑;JSON 给 version/world/systemVersion |
| P2 | `ss -tlnp \| grep -w 30000` + `ps -eo args \| grep 'main.js --dataPath'` + `/proc/<PID>/{cmdline,cwd,exe}`(exe 加 `--version`) | 安装目录、数据目录、--world、cwd、实际 Node 版本 |
| P3 | `docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'` | 我们的容器 / 别人的容器(felddy 等)/ 停着的容器;arcane 容器认 compose 标签与 `/arcane` 路径 |
| P4 | `systemctl list-unit-files \| grep -iE 'foundry\|fvtt'` + `systemctl cat <unit>` | systemd 服务停着(unit 的 ExecStart 同样暴露 --dataPath) |
| P5 | `find /root /home /opt /srv -maxdepth 4 \( -name options.json -path '*/Config/*' \) -o -name main.js 2>/dev/null` | 已安装未运行痕迹:`Config/options.json` 是数据目录铁标记 |
| P6 | `docker --version`、`docker compose version`、`systemctl is-active docker`、root/docker 组 | docker 现成还是要装 |
| P7 | `cat /etc/os-release`、`uname -m`、`nproc`、`free -h`、`df -h` | 发行版、架构、内存(≥2G)、磁盘(≥10G) |

**基线一致 = 13.351 / dnd5e 5.3.3 / Node 22.x / arcane 容器。** 一致则零打扰直接
运维;任何偏差(版本、dnd5e、Node、非 arcane 容器、不认识的布局)走 §5 冲突
三选一。P1 空、P4/P5 有痕迹 → 残余问点("帮你启动?");P1-P5 全空 → 全新机,
直接部署,不问任何问题(用户发起本 skill 即意图声明)。

## §2 Docker 安装(四层降级,失败自动落层)

装前预检(只读):os-release 支持矩阵(Ubuntu 20.04+/Debian 11+/Alibaba Cloud
Linux 2/3/Rocky/Alma 8+/Anolis/openEuler;不认识 → 跳兜底)、`uname -r`(≥4.x
最好;3.10 标记受限)、`uname -m`(x86_64/aarch64)、`systemd-detect-virt`
(**openvz/lxc 高危**,无独立内核,docker 大概率起不来,直接走兜底话术)、
`/proc/filesystems` 有 overlay、`sudo -n true`、`df /var/lib` ≥10G、残留
docker 包先清理。

1. docker-ce 官方仓库:cn 走 `https://mirrors.aliyun.com/docker-ce`(apt/yum),
   intl 走 download.docker.com。
2. 发行版自带包:Ubuntu/Debian 的 `docker.io`、Alibaba Cloud Linux 的 `docker`。
   我们只用 `docker load + run`,不需要最新版。
3. 静态二进制自管:`docker-<ver>-<arch>.tgz` 解压 `/usr/local/bin` + 自写
   systemd unit。同前缀的 `runtime/` 静态包来自我们 mirror 的 server 目录
   (server-release.json 同目录),第三层零外部依赖。
4. 兜底二选一:裸机安装(§6)或建议控制台"更换操作系统"到 Ubuntu 22.04/24.04
   (全新机 P1-P5 全空 = 无任何数据,重装零损失,往往比硬装快)。

装后验证(免 pull):`docker info` → `docker load` 我们的 tar.gz →
`docker run --rm <镜像> node --version` 断言 22.23.2(我们的镜像就是
hello-world)→ `compose up`。整条链不出现 `docker pull`。

## §3 Foundry 本体(用户自供,三要素话术)

下载入口只有一个:登录 foundryvtt.com → 用户资料 → **Purchased Licenses** 标签页
(`/releases` 页只是发行说明,没有下载按钮)。指导用户:

1. **Versions 下拉**:默认 "Recommended"(最新稳定版)——**不要用默认**,选
   "Older Stable" → 本方案钉版 13.351(与 server-release.json 的 foundry 字段
   比对;我们 bump 钉版时以该字段为准提示新版本号)。
2. **Operating System 下拉**:**Node.JS**(跨平台构建,专用服务器定位)。13.338
   起 "Linux" 与 "Node.JS" 是两个独立选项——不是 Linux 桌面构建,更不是
   Windows/macOS 安装包。
3. **交付**:zip 由用户 `scp` 到服务器 `/var/lib/arcane/staging/`;或点
   **Timed URL**(5 分钟过期)立即交给 skill 在服务器侧 curl。

skill 预检:`unzip -p <zip> resources/app/package.json` 读版本比对(容器入口
还有 main.js 结构校验兜底,版本不符拒启)。**世界单向迁移警告**:世界被更新版本
打开过即单向迁移,迁移前置检查源世界最后运行的 coreVersion ≤13.351。

## §4 镜像通道与部署(默认轨道)

端点:`ARCANE_SERVER_RELEASE_BASE`(App 注入)> region 默认(cn OSS / intl R2,
见 vendor-map.md §下载源)。流程:

1. `curl` `latest.json` → `<revision>/server-release.json` → 按 `uname -m` 选
   架构条目。
2. 服务器侧下载 tar.gz(curl 模板)→ **bytes+SHA256 逐字节校验**。
3. `docker load` → `docker inspect` 断言 image ID 与清单一致 → 才允许起容器。
4. compose(up):30000 公网直开、双卷(foundry/data)、`restart:
   unless-stopped`、incoming 挂载放用户 zip、`ARCANE_REGION` 按 flavor。
5. 首启等待:入口脚本装本体+首启 dnd5e(从 region mod 索引,字节级校验),健康
   判据 `/api/status` 返回钉版版本号。
6. **V1-V3 网络验证**:
   - V1 容器 HEALTHCHECK(内置);
   - V2 宿主机 `curl 127.0.0.1:30000/api/status`(不是 exec 进容器)→ 端口映射;
   - V3 **用户本机** `curl http://<IP>:30000/api/status` → 完整公网路径。
   V2 通而 V3 不通 ≈ 安全组(vendor-map.md 话术)。
7. 收尾:`options.json` 的 `hostname` 写公网 IP(游戏内邀请链接才会指对);
   `foundry_open <服务器URL>` 打开面板;用户填 adminKey + license;skill 轮询
   `/api/status` 至 world 加载、`systemVersion=5.3.3`;之后做 world 用户与
   GM 强随机初始密码(经 SDK 以 GM 会话设置,或预置 world 用户数据),最后
   交付:服务器 URL、GM 凭据、玩家 join 链接 `http://<IP>:30000/join`。

升级 = 同链路新 revision:`docker load` 新 tar.gz → 改 `.env` 的 tag →
`compose up -d` → 旧 revision 镜像由 skill `docker image rm` 清理。

## §5 冲突处理(三选一,固定话术)

> 你服务器上已经有一套 Foundry(<探测到的版本/世界/数据目录>),但它和我们
> 验证过的组合(13.351 + dnd5e 5.3.3)不一致。三个选择:
> 1. **迁移**:把你的世界和 mod 数据搬进我们的 Docker 部署,旧的原样保留当退路;
> 2. **新起一套**:旧的一点不动,我另起一套全新的 arcane 部署(换个端口并行跑),
>    你比较后自己定用哪个;
> 3. **按现状维持**:我不碰它,直接在现有这套上继续运维(部分能力受版本漂移影响)。

**迁移**:前置检查源世界 coreVersion ≤13.351(被 14.x 打开过即拒迁,选项只剩
维持/等基线升级)→ /proc 恢复拉起方式 → 按原方式停旧服 → `rsync` 数据目录
(`Config/ + Data/` 含 `.arcane-*`)进我们的数据卷 → `compose up` →
`/api/status` 断言 world 一致 → 漂移项走 mod-manager 正常升级对齐(有备份有
receipt)→ 旧安装原样保留,用户确认后另行清理(清理前 tar 备份,不主动删)。

**并行**:arcane 以 `30000→30001` 端口映射 up;用户验收后切换——停旧服、arcane
改回 30000、玩家链接不变。并存期间磁盘/内存翻倍,P7 先把关。

## §6 裸机纪律("按现状维持"与 docker 装不上时)

1. 按现状运维:启停/日志/探测不重启进程,跑在什么 Node 上都零风险,不擅自换
   运行时。
2. 完整恢复启动上下文(走哪条路都要):`/proc/<PID>/cmdline`(node 路径+参数+
   `--dataPath`)、`/proc/<PID>/cwd`、`/proc/<PID>/exe --version`;拉起方式
   systemd → pm2 → tmux/screen → nohup 逐级判定。**停服/重启必须用同一拉起
   方式**,绝不裸 kill。
3. Node 漂移在冲突问法里一起报告;用户选维持且日后想治理:钉版
   `node-v22.23.2-linux-<arch>.tar.gz`(nodejs.org,SHA256 见
   community-distribution.json,linux-x64/arm64 条目)装到
   `/opt/arcane/runtime/node/22.23.2/` → 停服 → 切 `arcane-foundry.service`
   (我们创建的 unit,`--dataPath` 沿用原数据目录)→ `/api/status` 验证 →
   原拉起方式留作回滚。
4. 全新裸机(docker 装不上):直接按 3 的布局装,不出现"系统 Node"变量。
