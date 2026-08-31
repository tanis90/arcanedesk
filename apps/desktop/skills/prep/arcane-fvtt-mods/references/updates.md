# 检查 Arcane 镜像 mod 更新

## 1. 获取全局当前索引并对比本地

确认 Foundry Data 目录后运行：

```text
mod-manager catalog --data-dir <Foundry Data 目录>
```

helper 会无缓存读取固定的 OSS `index.json`，只选 `module.json` 包，并扫描
`<数据目录>/Data/modules/*/module.json`。它不会把 `group=system` 的 system 当成 mod。

`rows` 只包含本机已安装且能在 Arcane 索引中精确按 id 找到的 module，状态含义：

- `update`：镜像版本高于本地；
- `current`：版本相同；
- `local-newer`：本地版本更高，不降级；
- `unknown`：版本格式无法安全排序，只展示差异，不自动升级。

`notInMirror` 是本地存在但索引没有的 module；不能据此宣称它们没有官方更新。

## 2. 给用户变更表格

至少展示：

| mod | 本地版本 | Arcane 镜像版本 | 状态 | 下载体积 | SHA256 |
|---|---:|---:|---|---:|---|

表格前写明索引的 `generated` 时间。SHA256 可以显示前 12 位，但真正 stage/commit 必须使用完整值。
默认突出 `update` 行；`current` 可折叠成一句汇总。说明 `notInMirror` 只是不由该镜像追踪。

表格后询问用户要升级全部 `update`，还是点名选择。询问中要写出预计总下载量、备份目录规则，
以及正在运行的 Foundry 会在全部下载校验完成后停服一次并恢复。不要升级 `local-newer` 或
`unknown`，除非用户看过差异后明确要求准确的目标版本。

## 3. 用户确认后升级

对选中的每个条目先执行 `inspect`，检查 manifest 与 required dependencies；再按
[install.md](install.md) 的 `stage` 流程下载。全部选择项 staging 成功且 SHA256 匹配后：

1. 记录当前 world id、目标 mod active 状态与启动参数；
2. 精确停止 Foundry 一次；
3. 逐项 `commit`，每项都传自己的 `expected-current-version`；
4. 用原 world id 重启一次；
5. 回读所有升级项的 version；原本 active 的还要验证 active 仍为 true。

某项 staging 失败时不要停服，也不要提交其他项，先给出失败表。某项 commit 失败时停止后续
提交，保留已成功项和每项 backup，报告当前磁盘状态；不要自行降级或删除备份。
