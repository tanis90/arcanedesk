# ArcaneDesk 服务器部署方案（Docker 化 FVTT + 远程 skill 运维）

- 状态：设计提案（待评审）
- 日期：2026-09-18
- 分支：`docs/server-deploy-plan`（自 main 切出）
- 前置阅读：`apps/desktop/distribution/oss-release-contract.md`、`apps/desktop/docs/i18n-plan.md`（region 体系）

## 0. TL;DR

现在的部署模型是"一切都在用户本机"：desktop 内置 Node 22.23.2 与 FVTT 本体（用户自供）、skill 部署到 `userData/skills/active`、mod 从 arcane-mirror 装进本机数据目录。本方案新增**服务器部署轨道**：一台服务器（国内=阿里云 ECS，海外=任意 VPS/Cloudflare）上用 Docker 跑同样的 FVTT 栈，desktop 与 agent skills 远程运维它。

三个核心决策：

1. **镜像既不是"只含 FVTT"，也不是"全含"，而是"安装器 + 运行时"**：Foundry 本体**绝不烤进镜像**（EULA 禁止再分发，且与我们既有 user-supplied-only 政策一致），首启时从挂载 zip / 限时 URL 装进卷；mod/dnd5e **也不烤**，运行时从 arcane-mirror 索引装进数据卷。镜像只含：钉版 Node 22.23.2、region 配置、mod-manager bootstrap、幂等入口脚本、健康检查。
2. **分发不走 registry**：为单个薄镜像养 registry（Docker Hub / GHCR / 自建 `registry:2` / ACR——个人版实测已收费、企业版开匿名拉取 564 元/月起）都不划算。镜像 `docker save` 成 gzip 压缩包，作为**普通 mirror 制品**放进现有 OSS(cn)/R2(intl) 桶，部署 skill 在目标机上下载 → SHA256 校验 → `docker load` 展开加载。供应链协议（不可变 revision + latest 指针 + cache-bust HEAD 验收）与 mod zip / skill bundle 完全同一套。
3. **先探测再执行**：新 skill `arcane-fvtt-server` 先探测本机/目标机（端口 30000、进程、数据目录、docker 容器），命中裸机部署→沿用 `arcane-fvtt-ops` 继续运维；命中已有容器→远程 ops；什么都没有→Docker 部署。

## 1. 现状盘点（本机部署链路）

| 环节 | 实现 | 关键文件 |
|---|---|---|
| FVTT 本体获取 | 用户自供（限时 URL / 本地安装包），版本钉 13.351 | `distribution/community-distribution.json:12,34-50` |
| Node 运行时 | 22.23.2 四平台 SHA256 钉死，构建期打进包、运行期解压 | `distribution/community-distribution.json:14-33`、`scripts/prepare-bundled-node.mjs`、`src/main/fvtt-ops-runtime.mjs` |
| skill 部署 | 包内基线 + OSS/R2 OTA（latest.json 指针 → 不可变 revision 包，逐文件 SHA256） | `src/main/skills-updater.mjs`、`scripts/publish-skills.mjs` |
| region 双轨 | 构建期 flavor（cn/intl），单一事实源默认值表 | `src/main/region.mjs:19-51` |
| mod 安装 | mod-manager stage/commit，索引 bytes+sha256 字节级校验 | `skills/prep/arcane-fvtt-mods/scripts/mod-manager.mjs:1211-1218` |
| 本机 ops | 探测 30000 → 启停 → 日志判定 | `skills/prep-intl/arcane-fvtt-ops/SKILL.md:30-63` |
| 连接 | 内嵌面板（URL + cookie，executeJavaScript 注入 SDK）；CLI 走 CDP | `src/main/main.js:59,322-412`、`packages/fvtt-cli/src/cli.ts:226-227` |

服务器轨道要复用的资产全部已在 main：region 表、skills 指针协议、mod 索引与校验、ops 探测逻辑、数据目录契约（`Config/`、`Data/`、`Logs/`、`.arcane-*`）。

## 2. 核心决策：镜像里放什么

问题：自己打 arcane 镜像，只含 FVTT，还是干脆包含所有要下载的东西（mod 等）？

**答案：都不。镜像 = 安装器 + 运行时；Foundry 本体与 mod 都在运行时进卷。**

| 内容 | 进镜像？ | 理由 |
|---|---|---|
| Foundry VTT 13.351 本体 | ❌ | ① EULA 禁止再分发软件本体（felddy 镜像 10M+ pulls 也是"fetcher"模式，不烤本体）；② 我们自己的政策就是 user-supplied-only（`community-distribution.json:6`）；③ 烤进去=每次 FVTT 升级重发镜像，且公开镜像仓上分发付费软件有下架/封号风险 |
| Node 22.23.2 | ✅ | 已有四平台 SHA256 清单，直接复用校验；基础镜像选 Debian slim + 官方 node 22.23.2，或从 nodejs.org dist 下载后钉 SHA256（与 `prepare-bundled-node.mjs` 同源同校验） |
| dnd5e 5.3.3 + mod（cn 35 包 / intl 5 包） | ❌（运行时装） | ① mod 走 M3 周更管线，烤进镜像意味着每周重建镜像 + 用户重拉 GB 级层（仅 JB2A 就数百 MB）；② 数据卷持久化后 mod 只在首装/升级时下载一次，与镜像生命周期解耦；③ arcane-mirror 已有字节级供应链校验，装进卷与烤进层安全等价；④ cn 从 OSS 北京、intl 从 R2 拉取都很快，没有"下载不动"问题 |
| mod-manager.mjs | ✅（bootstrap 副本） | 从 `skills/prep/arcane-fvtt-mods/scripts/` 构建期单源复制，带 bundle revision 戳；容器首启可用它装 dnd5e/mods。skill OTA 更新后镜像内副本允许落后——入口脚本启动时比对 skill 通道 `latest.json` revision，新则拉取 bundle 内 scripts 子集自更新（复用 skills-updater 的指针+SHA256 协议），版本写 receipt |
| region 配置 | ✅ | `ARCANE_REGION=cn|intl` 环境变量决定 mod 索引端点（复用 `region.mjs` 默认值表的镜像内等价物，禁止在业务代码分叉） |
| 入口脚本 + healthcheck | ✅ | 见 §4 |

**为什么留一个 `-full` 胖变体（后期可选项，不进 v1）**：把 dnd5e + mod 预装进数据卷镜像，仅服务离线/气隙部署。代价是镜像 GB 级 + 周更节奏，v1 不做。

### Foundry 本体获取的三条路（容器内，入口脚本按序尝试）

1. **挂载 zip**（国内推荐）：用户把 `foundryvtt-13.351.zip` 放宿主机，compose 挂到 `/arcane/incoming/`。国内访问 foundryvtt.com 不稳定，用户本就要自备安装包，这条路径摩擦最小。
2. **限时 URL**：`FOUNDRY_RELEASE_URL` 环境变量（foundryvtt.com Purchased Licenses 页的限时下载链）。镜像内对该 URL 不做任何缓存/再分发，下载完成即弃。
3. **凭证获取**（felddy 模式，`FOUNDRY_USERNAME/PASSWORD`）：仅作为 intl 便利选项，文档标注凭证风险。**license key 永不入日志**（平移 ops skill 现有纪律）。

安装目标 `/arcane/foundry/<version>/`（独立卷），入口脚本幂等：校验 main.js 结构 + 版本号与钉版一致才放行，否则报错拒启。

## 3. 探测-再-执行（deploy 决策树）

新 skill：`arcane-fvtt-server`（cn/intl 双语，走 composer 覆盖树）。首步永远是探测，探测结果决定动作：

```
探测（local 或 --target ssh:user@host）
├─ A. 本机 30000 在监听 / runtime/foundry 目录存在（现有 ops 探测逻辑）
│     → 已有本机裸机部署：不部署，直接 arcane-fvtt-ops 继续运维（现状不变）
├─ B. 目标机 30000 在监听
│   ├─ B1. 进程是容器内 node main.js（docker ps 命中 arcane 镜像）
│   │     → 已有服务器容器部署：远程 ops（ssh + docker exec），必要时升级镜像 tag
│   └─ B2. 进程是裸机 node（无容器包裹）
│         → 已有服务器裸机部署：远程 ops（ssh 直执，等价现有 ops 平移）
├─ C. 目标机有 docker 但无容器
│     → 用户没选 → Docker 部署（默认轨道）：装 compose → 拉镜像 → up → 健康等待
│       → 建 world 用户 + 设默认密码 → 交付：服务器 URL、GM 初始凭据、玩家 join 链接
└─ D. 目标机无 docker
      → 先装 docker（cn 用阿里云镜像源装 docker-ce；装不上再回退裸机安装路径）
```

探测手段与现有 ops 对齐：`curl http://<host>:30000/api/status`（返回 `version/world/systemVersion`）、端口进程定位、数据目录列举。SSH 凭证走用户本机 ssh-agent / 密钥，skill 永不存储密码。

### 目标接入：统一 SSH，不感知云厂商

**不做任何云厂商集成**：不调 ECS/OpenAPI、不在 desktop 里存云 AccessKey、不按厂商分支。阿里云、腾讯云、华为云、AWS、甲骨文、自有 NAS、公司内网机——只要是个能 SSH 的 Linux，走完全相同的路径。厂商差异在 SSH 会话内收敛为三个现场探测，而不是三套代码：

| 差异点 | 处理（SSH 会话内探测，每次部署现测） |
|---|---|
| 发行版/包管理器 | `cat /etc/os-release` → apt/yum 分支，决定 docker-ce 安装命令（国内网络用阿里云 docker-ce 镜像源） |
| 网络位置 | 对候选源做 HEAD 连通性/延迟探测（docker 安装源：mirrors.aliyun.com vs download.docker.com），选可达源 |
| 防火墙/安全组 | 唯一出现"云知识"的地方，且只是**诊断文案**：health check 不通且 30000 未对外时提示"若服务器在阿里云/腾讯云等，需在控制台安全组放行 30000/TCP"——绝不自动开端口 |

**下载源选择跟 app 的 region flavor，不跟服务器物理位置**：cn 包（不管服务器在哪家云）一律 OSS 北京、intl 包一律 R2——与 mod 索引同源同纪律（`region.mjs` 单一事实源，业务代码零 if）。边缘情况（cn 包用户买海外 VPS，访问 OSS 稍慢）v1 接受；若实测成痛点，再加"双源 HEAD 探测选快者"的 fallback，属小改。

SSH 凭证纪律（平移现有 ops 安全纪律）：

- 用系统 `ssh`（Windows 10+ 自带 OpenSSH client）+ `~/.ssh/config` 别名 + ssh-agent；skill 只持有目标别名，永不存储密码/私钥、永不改 known_hosts。
- 首次连接的 host key 确认由用户完成，skill **不自动 accept**——部署会话遇到新 fingerprint 时展示给用户核对后再继续。
- 目标机范围：v1 仅 Linux（x64/arm64，覆盖全部主流云）。本机 Docker Desktop（Windows/macOS）作为 local target 扩展列 M4 可选。

### 首次接入引导：secrets 不过 agent

核心原则一句话：**私钥材料永不进入 agent 上下文**。用户把 key 粘贴给 LLM 这条路明确堵死（skill 纪律条款）：会话记录会被持久化/快照重放（本仓库就有会话快照机制）、agent 为执行不得不把 key 落到临时文件会制造不可控副本——与我们"license key 永不打印、skill 永不存密码"是同一条纪律线。

key 放哪不是我们发明特殊位置，就是**操作系统标准位置**，认证由系统 OpenSSH 完成，agent 只碰别名：

```
~/.ssh/id_ed25519(.pub)   私钥/公钥——用户自己 ssh-keygen 生成，agent 可探测存在性、可读 .pub（非机密），永不读私钥内容
~/.ssh/config             Host 别名 + HostName/User/Port/IdentityFile——纯配置非机密，skill 可代写
ssh-agent                 passphrase 解锁一次（Windows 用 OpenSSH Authentication Agent 服务），之后 ssh 别名免交互
```

**首次接入流程（skill 引导，每步给用户可直接复制的命令，用户在自己终端跑）**：

1. skill 检查 `~/.ssh/id_ed25519` 是否存在（只看存在性）→ 无则给用户 `ssh-keygen -t ed25519` 命令自己跑，passphrase 由用户自选。
2. skill 读 `id_ed25519.pub` **公钥内容展示给用户**（公钥可公开），指引用户去云控制台绑定（阿里云 ECS 创建时可绑密钥对，或安全设置里注入公钥）——和 license 激活一样，浏览器里的动作归用户。
3. skill 代写 `~/.ssh/config` 别名块（追加前展示内容，纯配置），用户 `ssh-add` 解锁一次。
4. host key 确认：skill `ssh-keyscan` 取 fingerprint 展示，用户口头确认后 skill 才把条目追加进 known_hosts（TOFU + 人工核对，仍不算"自动 accept"）。
5. 验证：`ssh <alias> 'echo ok'` 通了才进探测-再-执行决策树。

密码登录（sshpass 之类）v1 明确不支持：agent 无法安全持有密码，交互式密码提示在非 TTY 下也不可用——只有公钥路径。若用户坚持"把私钥发给你，你帮我配"，skill 拒绝并回到上面的引导流程；这个拒绝话术与"agent 永不代填 EULA/license"同一模板。

后续（M4 可选）：desktop 做一个连接管理 UI（选择/新建目标、测连通、显示 fingerprint），但即便如此私钥材料也只进 OS keychain/agent，不进 LLM 上下文——UI 改善的是引导体验，不改变 secrets 边界。

## 4. 镜像与编排设计

### Dockerfile 骨架（放在 `apps/desktop/distribution/server-image/`）

```dockerfile
FROM node:22.23.2-slim          # 版本=community-distribution.json core.node 大版本线
COPY build/region-defaults.mjs /arcane/    # region.mjs 默认值表的镜像内等价物
COPY build/mod-manager/ /arcane/mod-manager/   # 构建期从 skills 单源复制 + revision 戳
COPY build/entrypoint.mjs healthcheck.mjs /arcane/
ENV ARCANE_DATA=/arcane/data ARCANE_FOUNDRY=/arcane/foundry
VOLUME ["/arcane/foundry", "/arcane/data"]
HEALTHCHECK CMD node /arcane/healthcheck.mjs   # GET /api/status 断言 version==13.351
ENTRYPOINT ["node", "/arcane/entrypoint.mjs"]
```

入口脚本职责（幂等，每次启动都跑）：核对本体版本 → 缺则按 §2 三路获取 → 首启调 mod-manager 按 region 索引装 dnd5e 5.3.3 + 策展 mod → 清 `options.json.lock` → `node main.js --dataPath=/arcane/data`。数据目录结构与本机完全同构（`Config/Data/Logs/.arcane-*`），mod 升级备份、receipt 机制原样生效。

### compose 要点

- 卷：`foundry`（本体）、`data`（数据目录）。**升级 FVTT = 换镜像 tag + 新本体版本目录，数据卷不动**。
- 端口：**30000 默认直接对公网开放**——服务器部署的全部意义就是让玩家远程登录；安全边界是 FVTT 自带的用户/权限体系（world 用户 + 密码 + adminKey），不是把端口藏起来。文档附可选 TLS 反代示例（不改变默认）。
- **默认不含 chromium sidecar**：ArcaneDesk 的控制通道（内嵌面板 + executeJavaScript 注入 SDK）走的就是公网 30000，与玩家同一入口，无需额外暴露面。
- 镜像引用用**本地 tag**（`docker load` 后即持有 `arcane/arcane-fvtt:13.351-r<N>`），compose 引用该 tag；防漂移靠发布物的 SHA256 钉版（见下）。

### 版本与发布物

- tag：`arcane/arcane-fvtt:13.351-r<N>`，N=镜像配方 revision（配方文件改动必 bump，同 skill bundle revision 纪律）。
- 发布物 `server-release.json`：tarball 的 bytes+SHA256、**镜像 image ID**（config digest，`docker load` 后 `docker inspect` 比对）、配方 revision、foundry/node/dnd5e 版本、mod-manager 对应 skill revision、minAppVersion、sizeGate 上限。
- 校验链：下载 tarball 按清单 bytes+SHA256 逐字节核对（mod-manager `stageModule` 同款）→ `docker load` → `docker inspect` 断言 image ID 与清单一致 → 才允许 `compose up`。

## 5. 分发：镜像压缩包进 mirror，skill 展开

**不建 registry**。询价结论（2026-09 查证）摆在那：ACR 个人版实际开通已要收费（官方文档仍写"公测限额免费"，且 2026-02 起函数计算已不允许跨地域拉个人版镜像，功能持续收缩）；企业版经济版 45 元/月**关闭公共匿名拉取**，开匿名拉取从基础版 564 元/月起；腾讯云 TCR 个人版/华为云 SWR 虽仍免费但有同样的转收费风险；自建 `registry:2` 要养域名、证书、单点——**为这一个镜像都不值得**。而 Docker Hub 对国内拉取方向不可用。

镜像本身足够薄（不含 Foundry 本体、不含 mod，只有 Node 基础层 + 脚本，tar.gz 预计 100-150MB，与 desktop 安装包 227MB 同量级），完全不需要 registry 的层去重/增量拉取生态。所以：

**发布物 = `docker save | gzip` 的镜像压缩包，作为普通制品进现有桶**：

```
cn  OSS arcane-package:
  desktop/arcane-desk/server/<revision>/arcane-fvtt-<tag>.tar.gz   # 不可变
  desktop/arcane-desk/server/<revision>/{server-release.json, docker-compose.yml, README.md}
  desktop/arcane-desk/server/latest.json                            # 唯一可变指针
intl R2 arcane-desk-intl（dl.arcanedesk.app）:
  desktop/arcane-desk-intl/server/...（同构）
```

协议完全照搬 skills 通道（`publish-skills.mjs` 模式）：不可变对象禁重传、指针只允许指向更老 revision、HEAD 验收带 `_cb=` cache-bust（吸取 8c902ec 边缘负缓存事故）。CI 设 **sizeGate**（tar.gz 超 300MB 直接失败），防止镜像悄悄变胖。

**部署/升级流程（`arcane-fvtt-server` skill 在目标机上执行，不经用户本机中转）**：

1. `curl` 指针 `latest.json` → 取 `server-release.json` →（升级时 `minAppVersion`/revision 门）。
2. 服务器上直接下载 tar.gz（cn 从 OSS 北京、intl 从 R2，都快）→ 按**清单 bytes+SHA256 逐字节校验**（mod-manager `stageModule` 同款纪律）。
3. `docker load` → `docker inspect` 断言 image ID 与清单一致 → `docker compose up -d`。
4. 升级后清理旧 tag 镜像（`docker image rm` 旧 revision，skill 负责），避免磁盘堆积。

为什么这条链是安全的：registry pull 的信任来自 registry 域名 + manifest 签名；tarball 链的信任来自**我们自己索引钉死的 SHA256 + image ID 双断言**——与我们分发 dnd5e zip（107MB）、desktop 安装包完全同一信任模型，甚至比匿名 `docker pull` 更强。未来若用户明确要 `docker pull` 体验，加一条 CI 步骤推 Docker Hub 即可（intl 受益），不影响本通道。

docker 本体的安装在探测 D 分支处理（cn 用阿里云源装 docker-ce）；用户侧零 registry 概念、零加速器配置——"arcane mirror 是唯一第一方镜像"纪律保持完整。

region 接线：`region.mjs` 默认值表加 `serverDeployBaseUrl`（cn=OSS 前缀 / intl=R2 前缀），desktop 经 `ARCANE_SERVER_RELEASE_BASE` 注入 skill 子进程——与 `ARCANE_MOD_INDEX_URL` 完全同一接线模式（`main.js:43-45`），业务代码零 if(region) 分支。

## 6. 版本与能力对齐表（服务器部署必须等于本机基线）

| 组件 | 钉版值 | 服务器轨道来源 |
|---|---|---|
| Foundry VTT | 13.351 | 用户自供（§2 三路），入口脚本断言 |
| Node | 22.23.2（镜像内）/ 24.x 仅开发 | 镜像基础层 |
| dnd5e | 5.3.3 | region mod 索引（cn OSS / intl R2） |
| mod 集 | cn 35 包 / intl 5 包（dae 13.0.29、midi-qol 13.0.65…） | 同上，索引 generated 时间戳即版本 |
| mod-manager | = skill bundle revision（cn 10 / intl 1） | 镜像 bootstrap + 启动自更新 |
| skill 文本 | 同 revision | 不变：skill 仍在 desktop agent 侧，本方案不改 skill 分发 |
| desktop App | 0.4.3 / Electron 44 / pi 0.84.3 | 不变（desktop 仍是控制面） |

对齐机制沿用四道闸：发布时远端指针必须更旧、不可变对象禁重传、`minAppVersion` 三段 semver 门、PR 改配方必 bump revision（照 `check-skills-revision.mjs` 加 `check-server-image-revision.mjs`）。

## 7. 连接模型（远程能力对齐）

| 通道 | 本机现状 | 服务器轨道 | 改造量 |
|---|---|---|---|
| 内嵌面板 + foundry-sdk | `ARCANE_FOUNDRY_URL \|\| http://localhost:30000`（`main.js:59`），WebContentsView 加载页面 + executeJavaScript 注入 SDK | 指向 `http://<server>:30000` 即可，SDK 全部能力（协议/预检/写中断）不依赖 Foundry 在哪。**ArcaneDesk 以 gamemaster 账号直连 `<server>/game` 操作**：面板打开服务器 URL，GM 登录一次后会话 cookie 由现有记忆/回填机制（`main.js:265-291,382-387`）持久化，之后直达 /game | ~0（URL 已是 env；补一个连接设置 UI） |
| 玩家入口 | 不适用（本机单人） | **`http://<server>:30000/join`**——玩家选自己的用户、输密码进入。部署完成后 skill 把 join 链接整理进交付信息，由 GM 自己分发给玩家 | 0 |
| 账号与权限 | FVTT world 用户体系 | FVTT 自带权限体系就是安全边界：部署 skill 首次部署时建 world 用户并**设好默认密码**（GM 账号强随机初始密码；可选预建玩家账号），完成后把初始凭据告知用户并提示首登后修改。adminKey 由 FVTT 首启自动随机生成，维持"永不打印"纪律 | 中：skill 新增账户初始化步骤（经 SDK 以 GM 会话设置，或首启前预置 world 用户数据） |
| ops（启停/日志/探测） | 本机 shell | `ssh <target> docker exec` / 直执 | skill 增加 target 抽象（local \| ssh），ops/mods 两个 skill 扩展 |
| mod 安装/升级 | mod-manager 本机直跑 | 同一二进制在容器内跑（`docker exec arcane-fvtt node /arcane/mod-manager/mod-manager.mjs …`），索引端点由容器 region 决定 | 低：参数透传，`--index-url` 机制现成 |
| CLI CDP 通道（QA） | 本机 Chromium 9230 | 服务器部署默认**不需要**——面板通道已覆盖 ArcaneDesk 全部控制能力。仅独立 CLI 的 QA 流程需要 CDP：可选 compose profile 起 chromium sidecar，其调试端口**必须**绑容器 loopback、经 SSH 隧道使用（CDP 能完全控制浏览器会话、绕过 FVTT 权限体系，绝不可公网暴露） | 中：文档 + compose profile，CLI 代码零改（仍连 127.0.0.1:9230） |
| license 激活 | 用户浏览器内完成 | 不变：用户开远程面板完成激活/EULA，会话态存服务器 Config 卷 | 0（政策平移） |

## 8. CI/CD 与发布流程

新增 `.github/workflows/arcane-server-image.yml`（workflow_dispatch，region 矩阵 cn/intl）：

1. 检查配方 revision 递增（照 skills-publish 纪律）。
2. 构建：单源复制 mod-manager（来自 skills 树）→ docker build → 本地起容器冒烟（挂测试 zip、假索引、断言 `/api/status`）。
3. `docker save | gzip` 出 tar.gz（**sizeGate：>300MB 直接失败**），记录 SHA256 与 image ID，生成 `server-release.json`。
4. tar.gz + `server-release.json` + compose 上传 OSS/R2（不可变 revision 目录）→ HEAD 验收（带 `_cb=` cache-bust，吸取 8c902ec 边缘负缓存事故）→ 切 `latest.json` 指针。

与 skill 发布的联动：skills-publish 成功后可选触发 server-image 重建（mod-manager 单源跟随），或依赖入口脚本启动自更新兜底——v1 先做后者（简单），联动重建列 M3。

## 9. 分支与里程碑

分支 `feat/server-deploy`（实现时自 main 切；若 intl M4 skill packs 已合入则直接受益于 composer 双语机制，未合入也不阻塞——镜像轨道不依赖 skill 双语）。

- **M1 镜像与发布**：Dockerfile/入口/healthcheck、compose、镜像 tar.gz 发布物与 CI（save/gzip/sizeGate/指针协议）、版本闸。
- **M2 deploy skill**：`arcane-fvtt-server`（探测-再-执行决策树、Docker 部署、world 用户与默认密码初始化、连接信息与玩家 join 链接交付）。
- **M3 远程运维**：ops/mods skill 的 target 抽象（local\|ssh）、mod-manager 容器内执行、skill↔镜像联动重建。
- **M4 增强（可选）**：CLI QA 用 chromium sidecar profile（CDP 仅 SSH 隧道）、`-full` 离线镜像变体、TLS 反代一键化、服务器侧 headless agent（远期，desktop 仍是控制面）。

## 10. 风险与合规

| 风险 | 缓解 |
|---|---|
| EULA：再分发 Foundry 本体 | 镜像不含本体；限时 URL 不缓存不复述；license key 永不入日志/遥测（现有纪律平移） |
| 国内拉不动 Docker Hub | 全流程**无 `docker pull`**：tar.gz 从 OSS 直下、skill `docker load` 展开；docker 安装用阿里云源 |
| 升级全量重下 tar.gz（无层增量） | 镜像 sizeGate 钉 300MB 内 + 升级低频；`docker load` 同 tag 原子覆盖，旧 revision 由 skill 清理防磁盘堆积 |
| 镜像被替换/供应链 | 清单钉 tarball SHA256 + image ID **双断言**（比匿名 registry pull 更强）；镜像内容单源（region 表/mod-manager/skills 树）；全链 HEAD 验收复用 |
| CDP 暴露公网 | sidecar 只绑容器 loopback，仅 SSH 隧道可达；不进默认 compose profile |
| 数据目录双层坑（Data/Data） | 卷挂载点钉 `<data-dir>` 契约，healthcheck 校验 `Data/systems` 层级 |
| 公网暴露 30000 | **这是部署目的，不是风险项**：玩家要远程登录。安全边界=FVTT 自带权限体系——部署 skill 强制 GM 初始密码强随机并提示首登修改；adminKey 随机生成且永不打印；真正绝不可暴露的是 CDP 调试端口（绕过 FVTT 权限，仅 QA sidecar + SSH 隧道场景存在）；TLS 反代作可选文档不默认 |
