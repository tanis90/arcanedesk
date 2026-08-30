# 单个 mod 安装或升级

## 1. 只读检查

确认真实 Foundry Data 目录后运行：

```text
mod-manager inspect --manifest-url <HTTPS module.json URL> --data-dir <Foundry Data 目录>
```

解析 JSON 结果，向用户展示：id、title、目标版本、download URL、已知体积、SHA256 来源、现有
版本与目录、Foundry compatibility，以及 `requiredModules` 中缺失或版本不足的依赖。若
`kind` 不是 `module`、URL 非 HTTPS、manifest 字段不合法或本地有重复 id，停止。

若 dependency 也在 Arcane 索引中，可分别 `inspect` 后把它加入同一安装计划；否则请用户提供
依赖的官方 manifest。不要自动安装推荐项或可选项。

## 2. 说明并确认计划

下载或提交前说明：

- manifest 与 ZIP 的域名；
- module id、当前版本 → 目标版本；
- 目标 `Data/modules/<id>` 或已有同 id 目录；
- 索引给出的体积与 SHA256（没有则明确说“发布方哈希不可用”）；
- 已有目录将先备份；
- 正在运行的 Foundry 将在 staging 成功后停服，提交后恢复原世界；
- 新安装仍需用户在世界里手动启用。

取得明确同意后再继续。用户原话已经明确要求安装准确的 URL 时，可把上述信息作为执行前告知
并继续；遇到未声明哈希、依赖扩展或目标冲突仍要停下来确认。

## 3. 下载并验证到 staging

把 `inspect` 返回的稳定字段原样传回，防止确认后远端内容变化：

```text
mod-manager stage --manifest-url <URL> --expected-id <id> --expected-version <version> --expected-download-url <URL>
```

`stage` 只写 OS 临时目录。它会重新读取 manifest、下载 ZIP、计算 SHA256、安全解压，并核对
archive 内 `module.json`。检查返回的 `id`、`version`、`archiveSha256`、`archiveBytes`、
`trustedByMirrorIndex`、`stageDir` 和 `requiresSecondConfirmation`。

- 镜像索引包：bytes 与 SHA256 必须匹配；匹配后可按已确认计划继续。
- 非索引包：把计算 SHA256 和实际体积展示给用户，明确它只是本次下载指纹；用户确认后才提交。

## 4. 停服并提交

若 Foundry 正在运行，先记录当前 world id 与目标 mod 的 active 状态，再按 `arcane-fvtt-ops`
精确停服。调用：

```text
mod-manager commit --stage-dir <stageDir> --data-dir <Data目录> --expected-current-version <version-or-none>
```

非索引包还必须追加：

```text
--accept-sha256 <stage 返回的完整 SHA256>
```

`expected-current-version` 必须来自 `inspect`；未安装时传字面量 `none`。若提交前本地版本已经
变化，helper 会拒绝，重新 inspect 而不是强行覆盖。

提交成功后保存 JSON 返回值，尤其是 `target` 与 `backup`。失败时不要手动删除 incoming、
staging 或 backup；先报告 helper 的准确错误。

## 5. 重启与验收

原先运行着 Foundry 时，用同一 Core、Data 与 world id 启动。升级已启用的 mod 时，在 ready GM
世界用只读 `browser_evaluate` 回读：

```js
(() => {
  const mod = game.modules.get("<id>");
  return mod ? { id: mod.id, version: mod.version, active: mod.active } : null;
})()
```

新安装的 mod 即使重启后已被 Foundry 发现，也不要调用内部 API 改启用配置；提醒用户打开世界的
“管理模块 / Manage Modules”，启用目标与 required dependencies，然后刷新/重启世界。若用户
完成后要求核对，再回读 `version` 与 `active`。
