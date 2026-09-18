# ArcaneDesk 服务器部署方案（Docker 化 FVTT + 远程 skill 运维）

- 状态：设计提案（待评审）
- 日期：2026-09-18
- 分支：`docs/server-deploy-plan`（自 main 切出）
- 前置阅读：`apps/desktop/distribution/oss-release-contract.md`、`apps/desktop/docs/i18n-plan.md`（region 体系）

## 0. TL;DR

现在的部署模型是"一切都在用户本机"：desktop 内置 Node 22.23.2 与 FVTT 本体（用户自供）、skill 部署到 `userData/skills/active`、mod 从 arcane-mirror 装进本机数据目录。本方案新增**服务器部署轨道**：一台服务器（国内=阿里云 ECS，海外=任意 VPS/Cloudflare）上用 Docker 跑同样的 FVTT 栈，desktop 与 agent skills 远程运维它。

三个核心决策：

1. **镜像既不是"只含 FVTT"，也不是"全含"，而是"安装器 + 运行时"**：Foundry 本体**绝不烤进镜像**（EULA 禁止再分发，且与我们既有 user-supplied-only 政策一致），首启时从挂载 zip / 限时 URL 装进卷；mod/dnd5e **也不烤**，运行时从 arcane-mirror 索引装进数据卷。镜像只含：钉版 Node 22.23.2、region 配置、mod-manager bootstrap、幂等入口脚本、健康检查。
2. **分发双轨**：国内在自有阿里云 ECS 上**自建 registry**（`registry:2` + 已备案域名 `*.arcanedesk.bitterbebop.cn` + 既有证书同步，存储后端走 OSS，即 arcane-mirror 新增成员，解决 Docker Hub 拉不动；ACR 个人版实测已要收费、企业版开匿名拉取 564 元/月起，托管路线不划算）；海外走 Docker Hub 主出口 + GHCR 双推；Cloudflare R2 **不做 registry**（S3 协议≠OCI registry 协议），只继续承担 compose/部署清单/文档分发。
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
│     → 用户没选 → Docker 部署（默认轨道）：装 compose → 拉镜像 → up → 健康等待 → 回填连接
└─ D. 目标机无 docker
      → 先装 docker（cn 用阿里云镜像源装 docker-ce；装不上再回退裸机安装路径）
```

探测手段与现有 ops 对齐：`curl http://<host>:30000/api/status`（返回 `version/world/systemVersion`）、端口进程定位、数据目录列举。SSH 凭证走用户本机 ssh-agent / 密钥，skill 永不存储密码。

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
- 端口：仅暴露 30000（建议文档给出可选 caddy/nginx TLS 反代示例，不默认）。
- 可选 sidecar（M4 后期）：headless Chromium 开 `--remote-debugging-port=9230` 绑容器内 loopback，配合 SSH 隧道供 CLI CDP 通道使用（见 §7）。
- 镜像引用用 **digest 钉版**（`image: registry.../arcane-fvtt@sha256:...`），digest 由部署清单下发，防 tag 漂移。

### tag 策略

- `arcane-fvtt:13.351-r<N>`：不可变，N=镜像配方 revision（配方文件改动必 bump，同 skill bundle revision 纪律）。
- `arcane-fvtt:13.351` / `:13`：浮动指针。
- 发布物：`server-release.json`（image digest、配方 revision、foundry/node/dnd5e 版本、mod-manager 对应 skill revision、minAppVersion）。

## 5. 分发渠道

### 国内：自有 ECS 上自建 registry（arcane-mirror 新增成员）

托管 registry 的询价结论（2026-09 实测/查证）：

| 方案 | 状态 | 结论 |
|---|---|---|
| ACR 个人版 | 官方文档仍写"公测限额免费"，但实际开通已要收费（控制台实测）；且 2026-02 起函数计算已不允许跨地域拉个人版镜像，功能持续收缩 | 不押注 |
| ACR 企业版经济版 | 45 元/月，但**公共匿名拉取关闭** | 不适用——用户在自己服务器拉镜像不可能登录我们的阿里云账号 |
| ACR 企业版基础版+ | 564 元/月起才开匿名拉取 | v1 阶段不值 |
| 腾讯云 TCR 个人版 / 华为云 SWR | 目前仍免费限额 + 支持公开匿名拉取 | 备选；跨云拆分基础设施，且与 ACR 个人版同样面临"免费转收费"风险 |
| **自建 registry:2（推荐）** | 边际成本≈0 | 见下 |

**推荐：在自有阿里云 ECS 上跑 Docker 官方 `registry:2`**。前提全部现成：

- 机器：`arcane-fvtt-ecs` 等已在运 ECS（cn mod 镜像重打包已在用），SSH 别名与连接权威定义见 arcanedesk-ops `SETUP.md`/`MIGRATION.md:28-29`。
- 域名：`arcanedesk.bitterbebop.cn` 已备案、已有证书同步服务（`infra/site/cdn-cert-sync`），加 `docker.arcanedesk.bitterbebop.cn` 子域 + 443 即可，TLS 证书走同一工作流。
- 存储：registry:2 的 S3 存储驱动指向 `arcane-package` 桶（OSS 兼容 S3 endpoint，镜像层落 `docker/registry/` 前缀），ECS 侧近无状态，重启/迁移干净。
- 量级匹配：拉取只发生在用户部署/升级时（单镜像数百 MB、月拉取次数量级小），单节点 ECS 的可用性完全够；Docker Hub 副本始终是并行出口。

arcan-mirror 侧新增：

- 自建 registry 一个（上述 ECS + 域名 + OSS 后端），匿名公开拉取，写入凭证仅 CI 持有（RAM 限定 `docker/registry/*` 前缀 Put/Get，照 `oss-release-contract.md` 的凭证纪律）。
- OSS `arcane-package` 桶新前缀 `desktop/arcane-desk/server/<revision>/{docker-compose.yml, server-release.json, README}` + 唯一可变指针 `desktop/arcane-desk/server/latest.json`（完全复用 skills 通道的"不可变对象 + 指针 + HEAD 验收 + cache-bust"协议，`publish-skills.mjs` 模式照搬）。
- `region.mjs` 默认值表加 `serverDeployBaseUrl`（OSS 前缀）与 `serverImageRegistry`（cn=自建 registry / intl=Docker Hub）。
- CI 推送：GitHub Actions 海外 runner 构建后 `docker push` 双写 Docker Hub + 自建 registry——推送方向海外→国内畅通，只有拉取方向被墙，自建 registry 恰好解决。

降级链（写进部署 skill 文档，不进自动逻辑）：自建 registry 不可达 → 提示用户配代理直连 Docker Hub（同 digest 同镜像）；第三方加速器（docker.1ms.run 等）不进官方路径（违背"arcane mirror 是唯一第一方镜像"纪律）。

### 海外：Docker Hub 主出口 + GHCR 双推

- Docker Hub 原生可用；免费匿名拉取有限速，但桌面用户量级下足够，且镜像只在部署/升级时拉一次。
- 同一次 CI 双推 `ghcr.io/<org>/arcane-fvtt`（GitHub Actions 凭证现成），作为 Docker Hub 政策/限速风险的备份出口；部署清单可带 fallback 顺序。
- **R2 为什么不做 registry**：R2 是 S3 兼容对象存储，说不了 OCI Distribution 协议（`/v2/` manifest/token 语义）；要用 R2 存层必须包一层 Worker 实现只读 registry（社区有 docker-hub 代理先例），工程收益低于 Docker Hub+GHCR 双出口。R2 继续做它擅长的事：compose、部署清单、文档、（既有）mod 索引。若未来 Docker Hub 出现政策风险，Worker 只读 registry 列为后备方案再评估。

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
| 内嵌面板 + foundry-sdk | `ARCANE_FOUNDRY_URL \|\| http://localhost:30000`（`main.js:59`），WebContentsView 加载页面 + executeJavaScript 注入 SDK | 指向 `http://<server>:30000` 即可，SDK 全部能力（协议/预检/写中断）不依赖 Foundry 在哪 | ~0（URL 已是 env；补一个连接设置 UI + TLS 选项） |
| ops（启停/日志/探测） | 本机 shell | `ssh <target> docker exec` / 直执 | skill 增加 target 抽象（local \| ssh），ops/mods 两个 skill 扩展 |
| mod 安装/升级 | mod-manager 本机直跑 | 同一二进制在容器内跑（`docker exec arcane-fvtt node /arcane/mod-manager/mod-manager.mjs …`），索引端点由容器 region 决定 | 低：参数透传，`--index-url` 机制现成 |
| CLI CDP 通道（QA） | 本机 Chromium 9230 | compose 可选 chromium sidecar，CDP 只绑容器 loopback；用户本机 `ssh -L 9230:localhost:9230` 隧道后体验完全一致，CDP 不暴露公网 | 中：文档 + compose profile，CLI 代码零改（仍连 127.0.0.1:9230） |
| license 激活 | 用户浏览器内完成 | 不变：用户开远程面板完成激活/EULA，会话态存服务器 Config 卷 | 0（政策平移） |

## 8. CI/CD 与发布流程

新增 `.github/workflows/arcane-server-image.yml`（workflow_dispatch，region 矩阵 cn/intl）：

1. 检查配方 revision 递增（照 skills-publish 纪律）。
2. 构建：单源复制 mod-manager（来自 skills 树）→ docker build → 本地起容器冒烟（挂测试 zip、假索引、断言 `/api/status`）。
3. 双推 Docker Hub +（cn）自建 registry /（intl）GHCR，记录 digest。
4. `server-release.json` + compose 上传 OSS/R2（不可变 revision 目录）→ HEAD 验收（带 `_cb=` cache-bust，吸取 8c902ec 边缘负缓存事故）→ 切 `latest.json` 指针。

与 skill 发布的联动：skills-publish 成功后可选触发 server-image 重建（mod-manager 单源跟随），或依赖入口脚本启动自更新兜底——v1 先做后者（简单），联动重建列 M3。

## 9. 分支与里程碑

分支 `feat/server-deploy`（实现时自 main 切；若 intl M4 skill packs 已合入则直接受益于 composer 双语机制，未合入也不阻塞——镜像轨道不依赖 skill 双语）。

- **M1 镜像与发布**：Dockerfile/入口/healthcheck、compose、自建 registry 落地（ECS + 域名 + OSS 后端）、CI 双推自建 registry+DockerHub、server-release 指针协议、版本闸。
- **M2 deploy skill**：`arcane-fvtt-server`（探测-再-执行决策树、Docker 部署、连接信息回填 desktop）。
- **M3 远程运维**：ops/mods skill 的 target 抽象（local\|ssh）、mod-manager 容器内执行、skill↔镜像联动重建。
- **M4 增强（可选）**：chromium sidecar + CDP 隧道文档、`-full` 离线镜像变体、TLS 反代一键化、服务器侧 headless agent（远期，desktop 仍是控制面）。

## 10. 风险与合规

| 风险 | 缓解 |
|---|---|
| EULA：再分发 Foundry 本体 | 镜像不含本体；限时 URL 不缓存不复述；license key 永不入日志/遥测（现有纪律平移） |
| 国内拉不动 Docker Hub | 自建 registry 直拉 + compose/清单走 OSS；docker 安装本身用阿里云源 |
| 自建 registry 单点（ECS 宕机/证书过期） | 拉取只发生在部署/升级时点，非运行时依赖；证书复用 cdn-cert-sync 工作流；Docker Hub 同 digest 副本兜底；未来量大可无痛迁 ACR 企业版（基础版起支持匿名拉取） |
| tag 漂移/供应链 | digest 钉版下发；镜像内容单源（region 表/mod-manager/skills 树）；全链 SHA256 + HEAD 验收复用 |
| CDP 暴露公网 | sidecar 只绑容器 loopback，仅 SSH 隧道可达；不进默认 compose profile |
| 数据目录双层坑（Data/Data） | 卷挂载点钉 `<data-dir>` 契约，healthcheck 校验 `Data/systems` 层级 |
| 服务器 30000 裸暴露 | 文档默认建议反代/TLS 或仅绑内网/SSH 隧道访问面板 |
