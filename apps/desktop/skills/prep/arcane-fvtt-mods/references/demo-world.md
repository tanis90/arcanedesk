# Arcane Demo world 与环境 Profile

`arcane-demo` 不随 Desktop 打包。world、环境 profile 和 package 是三条独立发布线：

- `worlds` 条目只描述不可变的 world manifest/ZIP，并用 `defaultProfile` 选择环境；world 内容变化时才发新 world 版本。
- `profiles` 条目指向不可变的 `foundry-environment-profile`；profile 只列 system/module id，不列版本。system/module ID 集合或 profile 语义元数据变化时才加 revision。
- `packages` 是 OSS 已验收的当前 `stable` 快照；某个包推进 stable 不要求重打包 world，也不要求修改 profile。

skill 不固定 world 版本、Core 版本、profile revision、system/module id 或包版本。每次操作必须读取同一份
全局 `index.json` 快照，用 world 的 `defaultProfile` 找到 profile，再把 profile id 与 manifest
`relationships.requires` 递归解析到该快照中的精确 stable 包。这里的 stable 是 Arcane OSS 已验收版本，
不是上游最新版本。

## 1. 只读检查

确认 Foundry Data 目录后执行：

```text
mod-manager world-inspect --world-id arcane-demo --data-dir <Foundry Data 目录>
```

若用户问所有已发布 world 的更新，可先执行：

```text
mod-manager world-catalog --data-dir <Foundry Data 目录>
```

`index.json` 没有目标 world/profile/package 时只说明发布数据不完整；不要回退到 Desktop 内置清单，
也不要猜 OSS 路径。检查本机 Core 是否符合 world manifest 的兼容性与 `coreVersion` 要求；不符合时先路由到
`arcane-fvtt-setup` 安装或切换 Core，不能让 Foundry 用错配 Core 自动迁移 Demo。

展示以下变更表；依赖很多时可把完全相同的 module 折叠为数量汇总：

| 类型 | id | 本地版本 | OSS stable 版本 | 动作 | 下载体积 | SHA256 |
|---|---|---:|---:|---|---:|---|

动作含 missing、current、upgrade、local-newer、unknown、duplicate。`duplicate` / `unknown` 必须先处理；
`local-newer` 默认保留，绝不为了匹配 profile 而降级。表后给出 `plannedArchiveBytes`、world 版本和 SHA256、
profile id/revision/SHA256、索引 `generated` 及完整解析集合 `resolutionSha256`。明确区分：

- 只有 package 变更：不替换、不重置、不备份 world；
- world 变更：旧 world 整体备份后重置，内容不做 merge；
- profile revision 变更：只代表包 id 集合变化，本身不是可安装目录。

## 2. 取得安装授权

用户在准确计划后说“安装”“升级”“重置”或“继续”，视为授权该计划，不重复询问。

- 只有 package missing/upgrade：说明将备份并替换这些全局 `Data/systems` / `Data/modules`，可能影响其他 world；
  不要声称 Demo world 会被重置。
- world missing：称为“安装 Arcane Demo”。
- world upgrade：称为“备份并重置 Arcane Demo 到 <version>”，并明确 Actor、Item、Journal、Scene、聊天和数据库
  不会自动合并。
- world 或 package 为 `local-newer`：默认不降级；用户必须另行明确要求特定旧版本，而当前 profile 流程不提供该降级。

全部下载可在 Foundry 运行时完成 staging；实际替换前只停服一次。

## 3. 下载并校验 staging

把 `world-inspect` 返回的稳定字段原样传回，防止确认后远端指针变化：

```text
mod-manager world-stage --world-id arcane-demo --data-dir <Data目录> --expected-world-version <version> --expected-world-sha256 <world SHA256> --expected-profile-id <profile id> --expected-profile-revision <revision> --expected-profile-sha256 <profile SHA256> --expected-index-generated <generated> --expected-resolution-sha256 <resolutionSha256>
```

`world-stage` 重新读取索引、world manifest 和 profile，重新解析当前 stable 包，只下载状态为 missing/upgrade
的 system、modules 和 world。外部 manifest、ZIP 和 archive 根 manifest 依次通过 URL、身份、bytes、SHA256
与安全路径校验；archive 内上游 URL 可以不同，helper 会在包身份和 ZIP 哈希通过后用已验证的外部 manifest
规范化 staging。任一项失败时 helper 删除本次 staging，现有 Foundry 内容保持不变，不要停服。

将返回的 `dependencyReplacements`、实际 staging 总量与确认计划核对。`resolutionSha256` 覆盖索引 generation、
world/profile 哈希及解析后每个包的版本、URL、manifest/ZIP bytes 与 SHA256；任一变化时重新 inspect，
不绕过 helper 的拒绝。

## 4. 一次停服并事务提交

记录当前 Core、Data、端口和 world id，再按 `arcane-fvtt-ops` 精确停止监听端口的 Foundry PID。然后执行：

```text
mod-manager world-commit --stage-dir <stageDir> --data-dir <Data目录> --expected-current-version <version-or-none>
```

未安装 world 时传字面量 `none`。helper 会再次验证 staging 和所有本地包/world 快照，把全部 incoming 内容准备好
后才开始替换。变更的 modules/system 备份到 `Data/.arcane-mod-backups/`；只有 world 本体确实变化时才备份到
`Data/.arcane-world-backups/<id>/`。中途失败会尝试回滚已开始的替换；不要删除报告的 incoming、backup 或
rollback 路径。

提交完成后 helper 写入 `Data/.arcane-managed/profiles/<profile-id>.json` receipt，记录本次 profile、world、
解析到的精确包版本/哈希及实际安装版本。receipt 只用于审计，不锁住未来 stable，也不能代替下一次读取 OSS 索引。

## 5. 启动与验收

使用 world 要求的 Core 与同一 Data 目录启动，安装/重置 world 时追加 `--world=arcane-demo`。等待 ready GM 页面后只读回验：

- `game.world.id`、`game.world.version` 与 `game.version`；
- `game.system.id` 和当前安装版本；
- 本次解析到的 module 的版本与 `active`；
- receipt 中 `matchesResolvedVersion=false` 的保留本地新版是否符合用户预期。

Demo 工件应携带自己的 module configuration，但新加入 profile 的 module 不一定已在既有 world 启用。若某项未启用，
不直接改数据库或内部 settings；报告差异并让用户在 Manage Modules 中确认。最后列出 package/world 的安装或替换项、
完整备份路径、world/profile/package SHA256、receipt 路径，以及 Demo 是否已成功启动。
