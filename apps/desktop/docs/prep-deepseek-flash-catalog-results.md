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
- UUID grant/import is now implemented in the existing grant tool: the public contract accepts either UUID or legacy `packId+entryId`; the runtime resolves UUIDs with `fromUuid`, rejects missing sources, and retains native `toObject()` cloning. SDK actor-content regression: **19/19 passed** after rebuild.

### Next release sequence

1. Add UUID-or-pack reference validation to the existing grant tool, preserving legacy callers.
2. Add runtime tests for UUID resolution, mismatch rejection, native source flags, and idempotent read-back.
3. Update prep skill instructions to prefer UUID and state which Actor fields are system defaults versus spec-required values.
4. Run the full A1-B3 benchmark five paired times on the same COS world, preserving each manifest and trace.
5. Publish aggregate pass rate, variance, tool adoption, latency, and failure traces before deciding production rollout.


## Five-run execution checkpoint (2026-09-11)

The first five-run batch was started against local COS. Run 1 completed 9/12 audited trials (A1-A3 and B1 both arms, B2 JS). B2 tool produced a settled business report but the provider returned a batch-level failure afterward, so the runner paused before B3. The manifest is preserved at `C:\Users\yangqi\AppData\Local\Temp\deepseek-flash-5x-20260911\run-1b\manifest.json`. This is recorded as an infrastructure/provider interruption, not a model pass/fail; the five-run aggregate is therefore not yet valid.


### Continuation result

The isolated B3 continuation completed both arms successfully: `resume-b3-2/manifest.json`, 2/2 audited. The original run remains paused at B2 tool provider interruption with 9/10 settled/audited entries (B2 tool report exists but runner classified the batch as provider failure). No aggregate 5-run score is claimed because the first run is incomplete and the remaining four runs have not been executed.


## Analysis of available runs (2026-09-11)

The available post-change run cannot establish a tool benefit. The compact projection change had a fixture defect: `progressionView` was referenced but not defined in the benchmark fixture. Traces show repeated `ReferenceError: progressionView is not defined` from `foundry_content_list`. Consequently catalog-tool trials received partial tool failures, and the observed failures (A1 spellbook 10 vs 14; B1 fighting-style missing) are confounded by the broken fixture.

Before this defect is corrected, the paired post-change data is: JS 5/5 business passes among A1-A3/B1/B2 (B3 JS also passed in the continuation), while tool trials include A1 and B1 business failures, B2 provider failure, and B3 timeout. This is evidence that the tool did not improve the model in this run, but it is **not** evidence that the catalog design itself hurts performance: the tool path was partly broken and the model also used it inconsistently. Tool latency was usually higher when exploration occurred (for example A3 tool 261s vs JS 185s; B3 tool timed out at 300s), indicating the current skill/tool surface adds search cost without a reliable correctness gain.

The valid conclusion is: keep the UUID-verified import and compact catalog design, fix and retest the fixture first, then compare at least five clean paired runs. Do not use the current contaminated batch to claim an LLM performance improvement or regression.


## Tool-only validation after eval-scope fix (2026-09-14)

After injecting `progressionView` into the browser evaluation scope, A1 completed successfully (114s) and its trace contained no catalog-list ReferenceError. The follow-up loop produced A2 as a provider/fixture-guard failure and did not yield valid business trials for A3-B3 because the QA-A fixture guard rejected the reused profile. These are harness lifecycle failures, not catalog correctness results. The remaining work is to isolate a fresh provider profile per case (or reset the QA fixture guard) and rerun A2-B3; only then can this loop certify the tool.


## Clean tool-only rerun after scope fix

Using separate profiles, A1, A2, B1 and B2 each reached a returned state and passed the business verifier. None emitted a catalog-tool error. A3 timed out with provider error; its catalog calls were clean, while browser/powershell calls failed. This supports treating remaining failures as model/provider execution instability rather than a catalog implementation defect. B3 remains to be rerun in a clean profile.


## Final tool-only loop checkpoint (2026-09-14)

With independent profiles and the browser-scope fix, the clean tool-only checks are: A1 pass, A2 pass, A3 provider timeout (no catalog error), B1 pass, B2 pass, B3 pass. The catalog tool emitted no `progressionView` or catalog execution error in the valid returned trials. A3 remains a model/provider timeout and is retained as an infrastructure-confounded result.

This closes the repair loop for the identified catalog defect. A future performance claim still requires a clean paired multi-run comparison; this tool-only smoke run certifies execution stability, not LLM uplift.
