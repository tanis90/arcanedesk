# OSS 镜像契约(as-built,2026-08-20 起生效)

> 操作手册(怎么打包/上传)见 `apps/desktop/docs/oss-mirror-arcane-package.md`。
> 本文件是**约束**:上传者、装机脚本、桌面端内置配置三方共同遵守的接口。

## 事实

- Bucket:`arcane-package`(北京区,标准存储 LRS,公共读匿名禁写——已实测验证)
- Base URL:`https://arcane-package.oss-cn-beijing.aliyuncs.com`
- 机器可读索引:`/index.json`(36 个包的 id/version/group/bytes/sha256/zipUrl/manifestUrl,**文件事实的唯一权威**)
- 布局:`packages/<id>/<version>/<id>-<version>.zip` + 同目录 `module.json`;dnd5e 系统在 `packages/dnd5e/5.3.3/`(装 `Data/systems/`)

## 规则

1. **路径版本化、永不可变**:同一路径绝不覆盖;发新版 = 新目录 + 重生成 index.json
2. **文件即哈希**:index.json 里的 sha256 与对象一一对应,重打包/重压缩必须同步重生成 index.json
3. **上传完成 ≠ 交付完成**:每次上传后跑一次全量校验——遍历 index.json,对每个 zipUrl/manifestUrl 发 HEAD,状态码必须 200 且 zip 的 content-length 等于 `bytes`。(2026-08-20 事故:首传 35 个包只有 2 个真实在桶里,其余全部 404,index.json 先于文件发布了)
3b. **index.json 更新必须 If-Match 乐观锁**:发布方 fetch(记 ETag)→ 增改 → 条件 PUT,412 冲突时重取重合并(至多 3 次)。多个写方(公开库 CI、私有库 CI、本机世界/profile 发布)并存时以此收敛,不得无条件覆盖。实施于 mods 仓库 `tools/oss-mirror-publish.mjs`(2026-09-28 起的正源,SDK 认证;桌面仓库旧 CLI 版已退役)。

4. baseUrl / 布局 / bucket 任何变更:先改 `apps/desktop/src/main/region.mjs`(桌面端注入的镜像索引地址默认值表,测试锁定字面量)并发版,再动 OSS
5. **镜像 manifest 面向 Foundry "URL 安装"**:每个版本目录 manifest(模块为 `module.json`,系统为 `system.json`)的 `download`/`manifest` 字段必须指向本桶地址。`add`(mods 仓库 `tools/oss-mirror-publish.mjs`,2026-09-28 起的正源)自动改写,`verify` 审计指向并期望全量 `oss`。历史勘误:2026-08-30 原地重写 `monks-common-display@13.01` 的 manifest(download 原指向 GitHub;zip 未变),是对规则 1 的唯一一次有记录例外;同日晚间 `fix-all` 将其余全部 34 个 manifest(含 dnd5e 的 `system.json`)一次性迁移为本桶指向,此后新版本一律由 `add` 直接以 OSS 指向发布。

## 分工

- **profile 声明**(arcanedesk-ops 仓库 `infra/mirror/`,发布进 index.json 的 `profiles[]`)= 策略:默认安装集
- **index.json**(bucket)= 事实:每个工件的大小、SHA256、URL
- Agent 装机流程按 `arcane-fvtt-setup` skill 同时读取索引与 profile,交叉校验版本一致后才下载

## 待补

- `dnd5e_classpack/4.4.0/`(待 T2 决策:版权灰度 vs 中文怪物数据源)
