# Desktop 离线模块构建器

模块实现的开发真源在私有模组仓库的 public/，经审核导出到公开 `arcanedesk-fvtt-mods` 的 foundry-pack-builder。Desktop 只从公开提交生成运行副本，不能直接修改其源码或原生依赖。当前 source.json 固定公开提交 b1292ca6e6e873af3fd9079d7f67f432bad71e19；根 package-lock.json 固定 classic-level、fflate 及其传递依赖。

维护文件位于 `scripts/module-builder-vendor/`，生成器是 `scripts/vendor-module-builder.mjs`。更新时先审查公开提交并修改 source.json；在仓库根目录执行 `npm ci --ignore-scripts`，使用 lockfile 的 npm 完整性校验安装依赖。然后对精确检出该公开提交的仓库运行：

```text
node apps/desktop/scripts/vendor-module-builder.mjs --source <公开模组仓库路径>
node apps/desktop/scripts/vendor-module-builder.mjs --check
```

生成器不会覆盖已有不同输出。已有副本与源和锁定依赖逐字节一致时，可复核并更新回执；有真实文件差异时拒绝覆盖，需另外准备可审阅的替换。生成目录是 `apps/desktop/skills/prep/arcane-fvtt-mods/scripts/node_modules/@arcanedesk/foundry-pack-builder`，不能把其他 ZIP 安装器依赖当成可替换内容。

生成过程比对公开包与固定 Git 提交的字节，选择运行文件、许可证与预编译文件，不带测试、构建源码或游戏内容。receipt.json 记录全部文件 SHA256 和根锁文件中实际依赖子图的 SHA256。CI 测试及 skill 发布前验证该回执；CI 不刷新它。`.gitattributes` 禁止 Git 改写生成副本换行。升级必须审查 source、lock、receipt 和生成文件差异，并增加 skill revision。

当前原生目标是 Windows x64、macOS x64/arm64 通用预编译文件，以及 Linux x64 CI。运行时使用 App 提供的 Node 24，不运行 npm 或原生编译工具。新增平台必须补充预编译目标并在对应平台验证；不以本机检查代替跨平台证据。

`bundle-inspect` 只读已准备的 arcane-module-bundle v1 的身份和输入哈希；`bundle-build` 锁定该哈希并调用同一 writeModuleBundle/writeModuleArchive。构建输出是新目录和 ZIP，不更改现有 Foundry，也不执行输入中的脚本。它不编译任意第三方原始内容，不授予内容分发权。

测试将完整 skill 复制到仓库外，清空 NODE_PATH，在子进程里构建原创内容并核对合集描述与 ZIP 回执，确保不会回退到工作区依赖。Windows 原生 DLL 在进程存活期间不能删除，因此独立导入测试也使用子进程并等退出后清理。

CLI 入口比较解析后的真实路径，避免 macOS 临时目录 /var 与 /private/var 的别名导致命令静默退出。脱离仓库测试通过目录符号链接（Windows junction）调用入口，覆盖这一问题；作为库导入时仍不执行 CLI。

## 本次验证

完整仓库 `npm run verify` 通过，其中 Desktop 415 项测试通过。实际 Auto 2014 0.4.0 的已准备输入在复制到仓库外的 skill 中完成 bundle-inspect、bundle-build、local-inspect、local-stage、commit；822 个安装文件逐字节匹配 ZIP，17 个合集和 2449 条记录符合模组仓库审核基线。完整输入与产物均留在私有测试目录，没有发布或更改生产世界。

这验证已准备内容的离线装配和安装，不代表任意原始第三方内容可自动编译，也不替代实际发行包及 Foundry 运行时验收。
