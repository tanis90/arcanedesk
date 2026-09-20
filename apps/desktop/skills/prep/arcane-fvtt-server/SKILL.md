---
name: arcane-fvtt-server
description: 在远程 Linux 服务器上部署或接管 Foundry VTT(FVTT)。当用户说"我买了台服务器/阿里云/腾讯云 ECS,帮我把 Foundry 装上去"、"部署到服务器"、"连上我的服务器"时使用;含首次 SSH 接入引导、探测服务器现状(已装/裸机/容器/全新)、Docker 镜像部署、冲突处理(迁移或并行新起一套)。已部署服务器的日常启停/日志排障归 arcane-fvtt-ops(远程模式);本机安装归 arcane-fvtt-setup。
---

# Arcane FVTT 服务器部署与接管

**先探测,再执行。** 用户说不清服务器上有什么;SSH 连上后跑只读探测序列(见
references/deploy.md §1),用事实决定动作,不问可探测的问题。

**用户交互预算:5 点。** 一次完整部署最多消耗:①接入时问三个事实(哪家云/公网
IP/密码还是 .pem);②用户自己终端跑一条公钥安装命令(输 yes + 服务器密码);
③冲突三选一(仅当探测发现冲突);④"装了但停着——帮你启动?";⑤激活面板里
用户自己填 adminKey + license key。其余一切(发行版、docker 有无、下载源、
安全组引导)都是 skill 侧探测与并行提示,不占交互点。

## 硬规则

- **私钥材料永不进入对话。** 用户提出把 key 粘贴进来时拒绝并回到引导流程
  (references/ssh-onboarding.md 末尾的拒绝话术)。密码只在用户自己终端里输给
  ssh;license key/adminKey 只在面板表单里填。SSH 细节见该文档。
- **全程零 `docker pull`、零 registry、零加速器配置。** 镜像 tar.gz 从
  arcane mirror 下载(端点由 `ARCANE_SERVER_RELEASE_BASE` 注入,缺省回落
  region 默认),SHA256 校验后 `docker load`。第三方源只允许 docker 安装
  降级链里的包仓库,且仅当第一方镜像不可达。
- **Foundry 本体用户自供。** 引导用户从 foundryvtt.com → Purchased Licenses →
  Versions 选 **Older Stable** → 13.351 → Operating System 选 **Node.JS** 下载
  zip(references/deploy.md §3 有三要素话术);绝不猜测或代填付费下载 URL。
- **30000 对公网开放是部署目的。** 安全边界是 FVTT 用户/密码体系;真正绝不可
  暴露的是 CDP 调试端口。安全组放行引导在镜像下载窗口并行做,不当成失败兜底。

## 流程

1. **接入**(首次):references/ssh-onboarding.md——问三个事实,skill 自备密钥,
   用户跑唯一一条命令,skill 收尾写别名并验证。已配过 `arcane-server` 别名则
   直接探测。
2. **探测**:references/deploy.md §1 的 P1-P7 只读序列,秒级完成。产出:现状
   分级(本机已装/服务器在跑[容器|裸机]/装了没跑/全新)、版本漂移清单、资源
   与可装性结论。
3. **分支**:
   - 本机 30000 在监听 → 已有本机部署,转 arcane-fvtt-ops,不部署。
   - 服务器在跑、基线一致(13.351/5.3.3/Node 22/arcane 容器) → 直接接管运维。
   - 任何冲突(版本漂移/别人的容器/不认识的布局) → 三选一问用户:**迁移**(旧
     数据搬进我们的 Docker 部署,原样保留当退路;世界被 14.x 打开过的拒迁)、
     **新起一套**(旧的不动,arcane 以 30001 并行)、**按现状维持**(裸机纪律,
     references/deploy.md §6)。
   - 装了没跑 → 问一句"帮你启动?"后按原拉起方式启动。
   - 全新 → Docker 部署(默认轨道)。
4. **部署**:references/deploy.md §2-§5——docker 安装四层降级、镜像下载校验
   `docker load`、compose up、V1-V3 三层网络验证、安全组并行引导。
5. **激活收尾**:调 `foundry_open <服务器URL>` 打开远程面板(连接目标是对话
   状态,面板记住上次地址);用户自己填 adminKey + license key + EULA;skill
   轮询 `/api/status` 确认 world 加载、`systemVersion=5.3.3` 后交付:服务器
   URL、GM 初始凭据(world 用户初始化在激活+世界首启**之后**才做,经 SDK 以
   GM 会话设置强随机初始密码并提示首登修改)、玩家 join 链接
   (`http://<IP>:30000/join`)。
