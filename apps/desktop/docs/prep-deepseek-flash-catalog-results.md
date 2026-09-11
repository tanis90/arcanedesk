# DeepSeek Flash / COS 内容目录试验

测试日期：2026-09-10；状态核对：2026-09-11。目标 <http://127.0.0.1:30002/game>，COS，Foundry13.351/dnd5e5.3.3。官方 deepseek-flash，high thinking，300秒，六题各两臂。12次全部终态并独立审计；其中A2工具臂超时，不能算成功，即使终态卡片配置检查通过。原始数据与指纹见 [结果JSON](prep-deepseek-flash-catalog-results.json)。

| 题目 | JS 秒/调用/通过 | Catalog 秒/调用/通过 |
|---|---|---|
| A1 | 113.55 / 28 / 否 | 100.70 / 18 / 是 |
| A2 | 118.60 / 24 / 是 | 300.02 / 44 / 否（超时） |
| A3 | 193.46 / 27 / 否 | 213.90 / 36 / 否 |
| B1 | 145.41 / 25 / 是 | 111.23 / 18 / 是 |
| B2 | 100.45 / 17 / 是 | 141.28 / 19 / 是 |
| B3 | 200.88 / 32 / 是 | 139.64 / 24 / 是 |

总通过率两臂均4/6。查询工具未改善本轮总正确率；A1工具臂通过而JS失败，A2反向。每组合只一次且JS固定先跑，因此耗时不能作稳定因果归因。

轨迹初审：A1工具臂两次spell list（首次 class=Wizard 因大小写失败，重试wizard成功）；成功返回约78,215字符，输出仍偏大。A2只用3次search，未调用classFeature list，之后反复探索advancement与NPC API直到超时。B1只用2次search；B2/B3完全没用目录工具。六个工具试次均未使用detail，亦未使用classFeature list。因此B3更快不能解释为“工具被调用后提速”；本轮尤其反映采用率不足。

目前不支持扩大生产工具面或宣称LLM收益已成立。优先修正入口说明与标识符大小写，让模型知道classFeature list替代哪些来源探索；保持源数据/完整机制可读，再审查列表重复数据。A2的写入后API探索和A3种族/步速错误不能仅靠加更多查询字段解决。需要单独冻结下一版，保留本轮成绩，验证是否实际调用查询并减少错误，再决定生产接入。以上是初审；尚未完成逐条调用归因和修复后复测。

## Full A1-B3 rerun on D:\\FVTT_DATA COS (2026-09-11)

- Target: `http://127.0.0.1:30000`, world `COS`, Foundry 13.351, dnd5e 5.3.3; login and readiness verified with `packages/fvtt-cli` over Chrome CDP 9230.
- Batch: `C:\\Users\\yangqi\\AppData\\Local\\Temp\\deepseek-flash-full-178910\\manifest.json`.
- JS arm passed 6/6. Catalog-tool arm passed 4/6: A2, B1, B2, B3 passed; A1 failed `hp.full,movement.walk`; A3 failed `skills.abilities,resource.channel-divinity`.
- Catalog calls occurred in 4/6 tool trials and 0/6 JS trials. Tool arm call counts were A1 0, A2 19 catalog calls, A3 1, B1 0, B2 2, B3 0.
- Mean elapsed time: JS 205.3s; tool 189.6s. This is one paired batch, so it is directional rather than a stable performance estimate.
- Interpretation: exposing catalog tools does not automatically improve every task. It helped A2/B2 where the model actively searched for exact content, but did not improve A1/A3 and sometimes caused extra exploration or incorrect grants. Keep the tools, tighten the skill around when to search, exact source/UUID verification, and stop conditions; do not expand the catalog surface without another controlled batch.

## Iteration checkpoint (2026-09-11)

- Catalog `classFeature` list now returns a compact `progression` projection (class, subclass, race, grants, spell access/tables, unresolved references). Full progression remains available only with `includeProgressionDetail:true` or via `detail`.
- This keeps the benchmark-relevant progression signal while avoiding a default 35 KB payload dominated by raw document/system/effect/uses fields.
- Verification: content-catalog, trace capture, skill-content, publisher, and self-contained bundle tests: **25 passed**.
- UUID grant/import remains the next implementation gate: the public contract must accept either a verified UUID or legacy `packId+entryId`; the runtime must resolve with `fromUuid`, verify Document type/name, then clone native `toObject()` data. No benchmark claim is made for that gate until its runtime test passes.

### Next release sequence

1. Add UUID-or-pack reference validation to the existing grant tool, preserving legacy callers.
2. Add runtime tests for UUID resolution, mismatch rejection, native source flags, and idempotent read-back.
3. Update prep skill instructions to prefer UUID and state which Actor fields are system defaults versus spec-required values.
4. Run the full A1-B3 benchmark five paired times on the same COS world, preserving each manifest and trace.
5. Publish aggregate pass rate, variance, tool adoption, latency, and failure traces before deciding production rollout.
