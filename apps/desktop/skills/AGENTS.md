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
- `prep-intl/` 是 intl 构建的英文覆盖树：只放 `prep/` 原创散文（.md）的英文译文和
  自己的 `bundle.json`（独立 revision 计数，变更同样必须 bump）。不得放置 `prep/`
  中不存在的游离文件，译文不得含 CJK 字符；`prep/` 散文改动后必须同步译文。构建时由
  `../../scripts/compose-intl-skills.mjs` 组合两树并强制以上门禁。
- skill 的 `name` 是稳定标识：欢迎页 chip 以 `/skill:<name>` 形式引用了
  `arcane-fvtt-setup` 和 `arcane-module-reader`（见 `../src/shared/i18n/messages.js` 的
  `welcome.*.prompt`）。改名或删除 skill 必须同步这些引用，否则 chip 的显式加载会落空。
