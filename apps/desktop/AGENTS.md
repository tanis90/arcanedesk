# Desktop 应用约定

- **Release 构建必须显式走 `private-beta` channel**：channel 由
  `scripts/prepare-desktop-release.mjs` 在构建期烘进
  `generated/desktop-release.json`（env `ARCANE_RELEASE_CHANNEL`），运行期客户端据此
  拼 feed URL（`update/<channel>/latest.yml`，见 `src/main/app-updater.mjs` 与
  `docs/auto-update-design.md`）。不设环境变量时默认 `development`——该目录永不发布
  feed，客户端 404 后按「无更新」静默处理，用户永远收不到更新。2026-09-22 的 0.6.0
  发布事故即源于此：包烙 `development`、feed 发 `private-beta`，两端无校验静默错配。
  现已在三处硬校验，绕不过去：
  - CI（`.github/workflows/arcane-desktop-release.yml`）构建 mac 包时显式设
    `ARCANE_RELEASE_CHANNEL=private-beta`，verify 步骤带 `--expected-channel`；
  - 本机 Windows 发布腿（`scripts/build-windows-release.mjs`）同样显式设置并在
    verify-package 时校验；
  - `publish-release.mjs`（主发布流与 `--finalize`）对比包内烙入 channel 与
    `--channel`，不一致直接拒发。
- 手工发布（不走上述两条腿时）仍需自检：`unzip -p <安装包>
  resources/app/generated/desktop-release.json` 确认 `channel` 字段为
  `private-beta`，且与 publish 的 `--channel` 一致。
