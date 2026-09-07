# 备团结构化工具与原生 JS 对比

本轮实现已提交为 `38b430b`。此实验不改产品行为，只评估同一版本开启／移除新增备团工具后的任务表现。
环境使用 QA-A，Kimi `kimi-for-coding-highspeed`，沿用独立加密 provider；auto pack 不修改。

## 预先确定的协议

- 两组均运行本分支真实 Prep AgentHost、Pi、模型、调度与 Foundry 页面。
  tools 组 18 个工具，js 组移除新增的 10 个领域工具，保留浏览器 JS、连接、截图、通用提问及文件／shell 工具。
- 两组使用相同的中性备团约束，分别附上“结构化优先”和“原生 Document API JS”的路由说明。
  Pi 仍生成各自实际工具的说明；不在 JS 组残留不存在的工具指导，也不给任一组预写脚本。
  这是受控工具消融实验，不冒充旧版／新版产品发布对比。
- 每类任务 10 组配对；每组在同一 QA-A 中重建相同初始状态，奇偶轮交换先后。
  每次都是新会话，避免前一次工具结果或脚本泄漏。每次结束在计时外精确清理测试对象。
- 用户 prompt 在两组完全相同；仅使用唯一测试对象名替换占位符。世界、模型、推理设置保持一致。
  不向模型提供 Actor/Token UUID、实现代码或工具调用顺序。
- 总耗时从提交用户指令到任务结束，包括读取、推理、执行、回读、纠错及最终回复；fixture 准备与独立正确性核验不计时。
  另记工具数、输入／缓存／输出／实际 reasoning token、首次事件、排队等待、追问及 JS 回退。
  首次事件可能是 reasoning/tool event，不能当作首个可见文字。
- 完成状态与世界实际结果同时正确才算成功。失败率与失败样本单列，不把失败的快响应算成提速；
  同时给所有尝试耗时、成功任务耗时和成功配对的相对变化。
- 不在正式采样中途调 prompt 或产品实现。先预跑排除测试适配器错误，再固定脚本采 100 个任务。
  写入结果不确定时保留证据并停止，不自动重放。供应商错误计入失败，不偷偷替补。

## 固定任务集

| 任务 | 相同用户要求 | 独立正确性检查 |
| --- | --- | --- |
| create_npc | 从 dnd5e.monsters 导入精确 Wolf，设置角色与原型 Token 名称 | 仅一个目标 NPC；名称、原型名、Wolf HP 与 Bite 能力；另外记录来源追踪信息 |
| grant_items | 授予 Rapier、Longbow；同来源已有物品原样跳过，新物品装备 | 预置 Rapier 不重复、不改变原装备状态；新增 Longbow 一件且装备 |
| edit_image | 改名、HP、固定 AC，使用现有 Data 图片同步头像／原型／存量 Token | 数值与图片一致，存量 Token 名称／位置／尺寸不变 |
| scene_layout | 非当前 Scene 移动两个 Token、删一个、再放两个 | 精确数量、名称、角色、坐标；不激活、不切 Scene |
| conditions | 指定两位世界角色倒地＋中毒，第三人不变 | 两人都有两个状态，第三人没有新增状态 |

本轮不含本地图片上传、地图创作、长文本剧情设计；不能把结果外推到这些任务。
连接为已登录热连接；10 个样本的 p95 是样本最大值，不代表稳定尾延迟分布。

## 运行方式

先按 `fvtt-qa-farm` skill 启动并核验 QA-A，再用 `review-prep-play-qa.mjs` 生成当前 fixture 报告。
由 Electron main 运行 `test/fixtures/prep-play-model-benchmark.cjs`，传入现有 `--qa-root`、
新的 `--qa-report`、基线目录 `--baseline`，以及 `--prep-benchmark=true --samples=10`。
宿主实现实际仅使用 candidate；baseline 参数是共享 harness 的启动约束，不参与这轮对比。
环境变量 `ARCANE_QA_NODE` 指向 Node；不得与重建 SDK dist 的 verify/build 同时运行。

统计入口：`node apps/desktop/test/summarize-prep-prompt-benchmark.mjs <report.json>`。
保存的报告没有密钥；完整模型会话和世界资料不提交仓库。

## 预跑记录

第一轮预跑暴露 CDP adapter 将整个脚本包成表达式，错误拒绝带尾分号的合法 JS。
已改为先执行固定身份 guard，再原样执行脚本，保留浏览器原生语义和实际错误反馈。
该预跑不计入统计。NPC 正确性不强制旧 JS 写入新增工具私有来源字段，避免验证标准偏袒工具组；
来源追踪单独记录，主要以明确请求的实际角色内容核验。

## 结果

正式采样完成后补充；当前不预设结构化工具更快。
