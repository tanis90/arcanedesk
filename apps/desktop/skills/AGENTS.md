# Skills 目录约定

- 修改任何 skill 前，先读 `../docs/skill-design-contract.md`（用户身份、交互预算、决策
  三分法、读写分层与安全底线）；与契约冲突的改动，先改契约再改 skill。
- `prep/` 下所有文件会被全量打进 App 并发布到 OSS bundle（`../../scripts/publish-skills.mjs`
  的 `collectSkillFiles`，无排除规则）：只放运行时必需文件；设计文档、决策记录放
  `../docs/`，不要放进 `prep/`。
- skill 文本变更后把 `prep/bundle.json` 的 `revision` 单调递增（PR 上由 CI 的
  `skills-revision` job 强制检查，见 `../../scripts/check-skills-revision.mjs`），并在
  `apps/desktop` 跑 `npm run verify:source && npm test`。
