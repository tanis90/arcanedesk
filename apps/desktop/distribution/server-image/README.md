# arcane-fvtt 服务器镜像包

本目录是 arcane 服务器轨道的发布物（由 `scripts/build-server-image.mjs` 产出、
`scripts/publish-server-image.mjs` 发布到 region 对应的对象存储）。完整设计见
`apps/desktop/docs/server-deploy-plan.md`。

## 内容

| 文件 | 说明 |
|---|---|
| `arcane-fvtt-<tag>-<arch>.tar.gz` | 镜像压缩包（`docker save \| gzip`），`docker load` 展开；按架构各一份 |
| `server-release.json` | 发布清单：每架构的 bytes/SHA256/image ID、钉版值、mod-manager 对应 skill revision |
| `docker-compose.yml` | 编排模板（30000 公网直开、双卷、restart 策略） |
| `README.md` | 本文件 |

## 校验链（部署 skill 自动执行）

下载 tar.gz → 按 `server-release.json` 的 bytes+SHA256 逐字节核对 →
`docker load` → `docker inspect` 断言 image ID 与清单一致 → `docker compose up -d`。
整条链不出现 `docker pull`。

## Foundry 本体（不随包分发）

镜像不含 Foundry 本体（EULA + user-supplied-only）。首启需要：
`foundryvtt-<版本>.zip`（foundryvtt.com → Purchased Licenses → Versions 选
**Older Stable** → Operating System 选 **Node.JS**）放进 `incoming/`，或提供
限时下载链（Timed URL，5 分钟有效）。
