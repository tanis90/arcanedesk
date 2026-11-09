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
3b. **index.json 更新必须写后读回校验**:发布方 fetch → 增改 → PUT → 立即重读,基线条目与新增条目全部在场才算成功,否则从最新索引重取重合并(至多 3 次)。多重试不是条件写——阿里云 OSS PutObject 不支持 If-Match(平台限制,条件写特性仅有 If-None-Match:* 建新),不可误用;跨写方残余窗口为同秒并发,两条 CI 各自以 workflow concurrency group 串行化,与本机手动发布错峰。不可变对象的 forbid-overwrite 冲突按存储 ETag(MD5)与本方字节比对,一致则幂等重放,不一致硬失败。实施于 mods 仓库 `tools/oss-mirror-publish.mjs`(2026-09-28 起的正源,SDK 认证;桌面仓库旧 CLI 版已退役)。
