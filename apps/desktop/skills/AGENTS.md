# Skills 目录约定

- 修改任何 skill 前，先读 `../docs/skill-design-contract.md`（用户身份、交互预算、决策
  三分法、读写分层与安全底线）；与契约冲突的改动，先改契约再改 skill。
- `prep/` 下所有文件会被全量打进 App 并发布到 OSS bundle（`../../scripts/publish-skills.mjs`
  的 `collectSkillFiles`，无排除规则）：只放运行时必需文件；设计文档、决策记录放
  `../docs/`，不要放进 `prep/`。
- bundle 会被激活到 userData 脱离 App 树运行，所以包内脚本必须自包含：相对导入不得
  逃逸出 `prep/`，裸导入只允许 node builtins 或 `arcane-fvtt-mods/scripts/node_modules/`
  下的 vendored 依赖（发布由 `publish-skills.mjs` 的 `assertSkillsSelfContained` 拒发，
  PR 由 `skills-self-contained.test.mjs` 拦截）。
- `arcane-fvtt-mods/scripts/archive-zip.mjs` 是 `../../scripts/archive-zip.mjs` 的 vendored
  副本，必须保持字节一致；vendored 依赖（yauzl、pend）版本必须与根 `package-lock.json`
  一致。两者都由 `skills-self-contained.test.mjs` 强制。
- skill 文本变更后把 `prep/bundle.json` 的 `revision` 单调递增（PR 上由 CI 的
  `skills-revision` job 强制检查，见 `../../scripts/check-skills-revision.mjs`），并在
  `apps/desktop` 跑 `npm run verify:source && npm test`。
