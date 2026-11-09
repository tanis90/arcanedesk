# Arcane Package Mirror 发布工具（已迁移）

> **2026-09-28 迁移**：`apps/desktop/scripts/oss-mirror-publish.mjs` 已退役，正源移至
> [arcanedesk-fvtt-mods 仓库](https://github.com/tanis90/arcanedesk-fvtt-mods) 的
> `tools/oss-mirror-publish.mjs`（SDK 认证 + index.json If-Match 乐观锁）。自有 mod 的
> packages 段发布已由该仓库的两条 CI 管线接管（公开模块 mirror-release、内部包
> mirror-internal），不再有桌面仓库侧的手动发布流程。
>
> 本文件保留为指针。契约（布局与规则，含新增的 If-Match 条款）仍在
> `apps/desktop/distribution/oss-mirror-contract.md`；包清单见
> `apps/desktop/docs/oss-mirror-arcane-package.md`；世界/profile 发布流程不变
> （`prepare-world-profile.mjs`）。
>
> 旧命令（add / fix-manifest / fix-all / remove）不再提供。应急手动操作走
> arcane-admin 身份的 aliyun CLI；删除对象仍是 admin 手动流程。
