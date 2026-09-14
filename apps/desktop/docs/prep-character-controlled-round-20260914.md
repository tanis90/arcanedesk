# Character benchmark controlled round — 2026-09-14

本轮固定为 Character 创建，DeepSeek Flash、thinking=high、300 秒上限、COS world（Foundry 13.351 / dnd5e 5.3.3），每个 case 每个 arm 一次。JS/native arm 与 catalog-tool arm 使用相同 prompt/skill；区别只有 catalog 查询方式。审计使用 Character v5 verifier，并在只读回读中验证角色类型和派生字段。

| Case | JS/native | Catalog tool | 结论 |
|---|---:|---:|---|
| A1 wizard | 261.0s，**通过** | 180.1s，失败（核心检查未通过） | JS 完成；tool 更快但施法、法师特性、Arcane Recovery 未完整写入 |
| A2 fighter | 255.6s，**通过** | 156.3s，**通过** | 两臂都完成，tool 快 99.3s |
| A3 cleric | 300.0s，超时失败 | 200.8s，失败（核心检查未通过） | JS 在超时前未完成；tool 完成但缺少子职特性、Channel Divinity 等资源 |

通过定义是模型任务完成、Actor 唯一且为 `character`，并通过配置、技能、法术、资源、来源和回读检查。A3 的 JS 结果不是审计序列化故障：修复后的快照可读，但角色确实缺少上述字段。旧的 `Object reference chain is too long` 已定位并修复为 HitDiceManager 活对象误返回，不能再作为模型失败原因。

## 结果判断

这组结果不能证明 catalog 工具提升了完成度：通过率为 JS 2/3、tool 1/3。它显示工具臂的执行时间明显更短（A1 -81s、A2 -99s、A3 -99s），但 A1/A3 的失败发生在“拿到来源后如何把职业/子职的自动授予和施法资源落到 Character”这一写入阶段，而不是浏览器前台速度或 catalog 搜索耗时。A3 两臂都失败，说明模型/skill 对高阶子职资源的执行能力仍是主要瓶颈；A1 仅 tool 失败，说明 tool 返回的来源信息或模型对其消费方式仍可能影响写入完整度。

## 可复现证据

- JS A1/A2：`benchmark-1789362397160-audit.json`、`benchmark-1789362688330-audit.json`
- Tool A1/A2/A3：`benchmark-1789363280479-audit.json`
- 实验代码和 Character skill 改动在本提交中；工具实现未改动。
