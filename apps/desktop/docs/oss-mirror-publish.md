# Arcane Package Mirror 发布工具

维护 `oss://arcane-package` 镜像(布局与规则见
`apps/desktop/distribution/oss-mirror-contract.md`,包清单见
`apps/desktop/docs/oss-mirror-arcane-package.md`)。

```bash
# 发布新包(zip 根目录必须是 module.json;manifest 用原始上游版,工具会改写指向 OSS)
node apps/desktop/scripts/oss-mirror-publish.mjs add \
  --id combat-tracker-dock --version 4.1.8 --group ui \
  --zip <id>-<version>.zip --manifest <src>/module.json

# 把既有包的 manifest download/manifest 改写为本桶地址(Foundry URL 安装不绕回 GitHub)
node apps/desktop/scripts/oss-mirror-publish.mjs fix-manifest --id <id> --version <v>

# 从索引移除一个包(不改版本目录;--delete-objects 连对象一起删,默认只摘索引)
node apps/desktop/scripts/oss-mirror-publish.mjs remove --id <id> --version <v> --delete-objects

# 一次性迁移索引里所有非 OSS 指向的 manifest;结束时打印原始 URL JSON 数组作为回滚参照
node apps/desktop/scripts/oss-mirror-publish.mjs fix-all

# 契约第 3 条:全量 HEAD + content-length + manifest id/version 校验,附 download 指向审计
node apps/desktop/scripts/oss-mirror-publish.mjs verify
```

## 行为约定

- `add` 拒绝覆盖已存在的 id+version(不可变路径);新版本 = 新目录 + 重生成 `index.json`。
- `remove` 只摘索引条目、不碰版本目录;对象删除需显式 `--delete-objects`。被任何
  profile 的 `modules[]` 引用的 id 拒绝移除,除非 `--force`。
- `index.json` 保持既有格式:2 空格缩进、CRLF、按 `group/id` 排序、`Cache-Control: no-cache`。
- 每次上传后自动跑全量校验;`add` 对新包额外做下载回读 sha256 深检。
- zip 与 manifest 对象不带 Cache-Control(与既有对象一致,路径本身不可变)。

## 凭证

- 本机:aliyun CLI 当前 profile(`~/.aliyun/config.json`,OAuth;过期自动 refresh)。
  可执行文件自动探测 winget 安装路径,或用 `ALIYUN_BIN` 覆盖。
- 不再使用 ossutil(`~/.aliyun/ossutil.exe` 读不懂 CLI 的 OAuth profile)和历史
  `arcane-package.conf` profile。
