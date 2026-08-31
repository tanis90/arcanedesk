# Arcane Desk Runtime and Packaging Contract

## Packaged resources

安装包包含：

- Electron 主进程、preload 与 renderer；
- `@earendil-works/pi-coding-agent` 及生产依赖；
- `@arcanedesk/foundry-sdk`；
- 从 workspace 依赖准备的 marked、highlight.js、KaTeX 与 Mermaid 静态资源；
- `system-prompts/combat.md` 与 `system-prompts/prep.md`，以及公开用户 skills；
- `community-distribution.json`；
- 当前平台的官方 Node 22.23.2 归档、许可证说明与 SHA256 manifest。

安装包不包含 Foundry VTT、license key、用户世界、Arcane 托管镜像、预制世界、私有模块、
发布凭据、维护者上传工具或第三方商业内容。

## Community distribution

`distribution/community-distribution.json` 是社区构建唯一随包 profile：

- Foundry Core 只能由用户提供官方购买下载或 timed URL；
- 默认 system/module/world 列表全部为空；
- dnd5e 条目只保留上游出处与许可证记录，不充当安装来源或校验基准；
- 没有代理池、第三方镜像或官方私有服务依赖；system/module/world 内容在运行时统一从
  arcane mirror 的 OSS 索引解析安装；
- mirror 未收录的第三方内容需用户确认一次风险提示后安装；所有下载先落盘校验再安装。

## Writable data

程序资源视为不可变。配置、会话、下载与运行时写到 Electron `userData` 或用户明确选择的
目录。API Key 使用操作系统 secret storage 保护；renderer 只接收掩码。

## Direct dependencies

生产直接依赖在 `package.json#dependencies` 中声明。Electron、electron-builder、TypeScript
和类型包只用于开发/打包。仓库使用根 lockfile，不在 workspace 内维护第二份 lockfile。

## Release gates

```bash
npm --workspace arcane-desktop run verify:source
npm --workspace arcane-desktop test
npm --workspace arcane-desktop run typecheck
npm --workspace arcane-desktop run dist:dir
npm --workspace arcane-desktop run verify:package -- "<Resources/app>"
```

正式公开分发还需要 Windows 签名、macOS 签名与公证、依赖审计、许可证清单、SBOM、
checksums，以及在无开发仓库/全局 Node 的干净机器上完成 smoke test。
