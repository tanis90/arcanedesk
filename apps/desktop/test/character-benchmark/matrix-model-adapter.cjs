// Matrix benchmark adapter: model-driven runs of the e2e advance matrix cases
// (spec: apps/desktop/docs/foundry-prep-e2e-matrix-spec.md §6, cases defined in
// scripts/e2e-advance-matrix.mjs). Free-play prompts pin only class/subclass/
// race-or-monster/level plus the mandated actor name; judging is a choice-agnostic
// final-state oracle. Expectations come from a probe advancement-plan at setup time —
// the same plan the model should use, so judge and tool share one source of truth.
const crypto = require("node:crypto");

// MVP 三案（spec §6.1）：覆盖三条最不同的路径——非施法+子职业选择槽 / 法术书+种族
// 戏法 / NPC 复制建档。与 scripts/e2e-advance-matrix.mjs 的 A5/A12/C1 同配置。
const MATRIX_CASES = [
  { id: "A5", kind: "character", cls: "fighter", clsName: "战士", subclassMatch: "战斗大师", race: "high-elf", raceName: "高等精灵", level: 5, maxSpellLevel: 0 },
  { id: "A12", kind: "character", cls: "wizard", clsName: "法师", subclassMatch: "塑能", race: "high-elf", raceName: "高等精灵", level: 5, maxSpellLevel: 3 },
  { id: "C1", kind: "npc", monsterQuery: "werewolf", monsterName: "狼人 Werewolf", cls: "fighter", clsName: "战士", subclassMatch: "勇士", subclassTitle: "冠军勇士", level: 5, maxSpellLevel: 0 },
];

const ids = MATRIX_CASES.map(c => c.id);
const byId = id => MATRIX_CASES.find(c => c.id === id);

// 自由发挥教义：prompt 只给 职业/子职业/种族或怪物/等级 四个硬约束 + 命名 + 完成标准指针。
// 属性/技能/法术/装备全部模型自选（对照组同 prompt，公平性由同文保证）。
function prompt(id, label) {
  const c = byId(id);
  if (c.kind === "npc") {
    return `复制 dnd5e.monsters 合集中的 2014 版狼人（Werewolf），给副本追加 ${c.level} 级${c.clsName}职业等级，子职选${c.subclassTitle ?? c.subclassMatch}。属性调整、技能、装备等所有未点名选项由你自行合理决定。命名为“${label}”。先读取 character-benchmark 共享默认。只创建这一张卡，不修改已有角色。`;
  }
  return `按2014版规则，创建一张玩家角色卡（character）：${c.level} 级的${c.raceName}${c.clsName}，子职选${c.subclassMatch}。属性、技能、法术、装备等所有未点名选项由你自行合理决定。命名为“${label}”。先读取 character-benchmark 共享默认。只创建这一张卡，不修改已有角色。`;
}

// ── 纯函数判定器（无 evaluate 依赖，可单测）──────────────────────────────────
// snapshot 字段见 verify() 的页内采集；expectations 字段见 setup() 的 probe plan。
// 所有检查选择无关：不 pin 具体属性分配、具体技能/法术选择，只查恒等式与计数。
function judgeState(cfg, expectations, snapshot, sourceBefore) {
  const checks = [];
  const check = (id, ok, expected, observed) => checks.push({ id, priority: "core", ok: !!ok, expected, observed });
  if (!snapshot) { check("actor.exists", false, "exactly one actor with the mandated name", null); return { ok: false, checks }; }
  check("actor.type", snapshot.type === (cfg.kind === "npc" ? "npc" : "character"), cfg.kind, snapshot.type);
  const items = snapshot.items ?? [];
  const cls = items.find(i => i.type === "class" && i.identifier === cfg.cls);
  check("class.item", !!cls, cfg.cls, items.filter(i => i.type === "class").map(i => i.identifier));
  check("class.levels", cls?.levels === cfg.level, cfg.level, cls?.levels ?? null);
  const sub = items.find(i => i.type === "subclass");
  check("subclass.item", !!sub && sub.sourceId === expectations.subclassUuid, expectations.subclassUuid, sub ? { sourceId: sub.sourceId ?? null, name: sub.name } : null);
  if (cfg.kind !== "npc") {
    const race = items.find(i => i.type === "race");
    check("race.item", !!race && race.sourceId === expectations.raceUuid, expectations.raceUuid, race ? { sourceId: race.sourceId ?? null, name: race.name } : null);
  }
  // 属性：自由分配但须合法——总和守恒（标准数组 72 + 种族加成 + ASI 点数），
  // 单项不超 20。NPC 方向相反：原属性保留，只允许 ASI 增量。
  const abSum = Object.values(snapshot.abilities ?? {}).reduce((a, b) => a + b, 0);
  if (cfg.kind === "npc") {
    const deltas = Object.entries(snapshot.abilities ?? {}).map(([ab, v]) => v - (sourceBefore?.abilities?.[ab] ?? v));
    const deltaSum = deltas.reduce((a, b) => a + b, 0);
    check("abilities.preserved", deltas.every(d => d >= 0 && d <= 2) && deltaSum === expectations.asiPoints,
      `仅 ASI +${expectations.asiPoints}（单项 ≤2）`, { deltas, before: sourceBefore?.abilities });
  } else {
    const expectSum = 72 + expectations.racialSum + expectations.asiPoints;
    check("abilities.sum", abSum === expectSum, expectSum, abSum);
    const over = Object.entries(snapshot.abilities ?? {}).filter(([, v]) => v > 20 || v < 3);
    check("abilities.range", over.length === 0, "3..20", over);
  }
  // HP：character 首级满骰 + 后续均值；NPC 每级体型骰均值、无首级满骰。conMod 从终态读。
  const conMod = Math.floor(((snapshot.abilities?.con ?? 10) - 10) / 2);
  const hd = expectations.hitDie;
  const expectHp = cfg.kind === "npc"
    ? (sourceBefore?.hpMax ?? 0) + cfg.level * (Math.floor(hd / 2) + 1 + conMod)
    : hd + conMod + (cfg.level - 1) * (Math.floor(hd / 2) + 1 + conMod);
  check("hp.max", snapshot.hp?.max === expectHp, expectHp, snapshot.hp?.max ?? null);
  check("hp.full", snapshot.hp?.value === snapshot.hp?.max, "value === max", snapshot.hp);
  // 法术（仅施法案）：戏法总数 = 职业预算 + 种族白送；book/known 按预算；环级不超预算上限
  const budget = expectations.spellBudget;
  if (budget && (budget.cantrips !== undefined || budget.book !== undefined || budget.known !== undefined || budget.fullList)) {
    const spells = items.filter(i => i.type === "spell");
    const cantrips = spells.filter(i => i.level === 0).length;
    const expectCantrips = (budget.cantrips ?? 0) + (expectations.racialCantrips ?? 0);
    if (budget.cantrips !== undefined) check("spells.cantrips", cantrips === expectCantrips, expectCantrips, cantrips);
    const leveled = spells.filter(i => (i.level ?? 0) >= 1);
    if (budget.book !== undefined) check("spells.book", leveled.length === budget.book, budget.book, leveled.length);
    if (budget.known !== undefined) check("spells.known", leveled.length === budget.known, budget.known, leveled.length);
    if (budget.fullList) check("spells.fullList", leveled.length === budget.fullList.count, budget.fullList.count, leveled.length);
    const maxSlot = expectations.maxSpellLevel;
    if (Number.isFinite(maxSlot) && maxSlot > 0) {
      const overleveled = leveled.filter(i => i.level > maxSlot).map(i => i.name);
      check("spells.levelCap", overleveled.length === 0, `level ≤ ${maxSlot}`, overleveled);
    }
  }
  // 技能：熟练数 = 职业选择数 + 种族/来源自带；职业自选部分须落在 plan 枚举的池内
  const profSkills = Object.entries(snapshot.skills ?? {}).filter(([, v]) => v >= 1).map(([k]) => k);
  const baseSkills = cfg.kind === "npc" ? (sourceBefore?.skills ?? []) : [];
  const expectCount = baseSkills.length + expectations.skillPickCount;
  check("skills.count", profSkills.length === expectCount, expectCount, profSkills);
  const pool = new Set(expectations.skillPool ?? []);
  const picked = profSkills.filter(k => !baseSkills.includes(k));
  const outside = picked.filter(k => !pool.has(k));
  if (pool.size) check("skills.pool", outside.length === 0, "picks within class pool", outside);
  // NPC：来源条目逐条保留（按名称+类型）
  if (cfg.kind === "npc" && sourceBefore) {
    const now = new Set(items.map(i => `${i.type}:${i.name}`));
    const missing = (sourceBefore.items ?? []).filter(i => !now.has(`${i.type}:${i.name}`)).map(i => i.name);
    check("preservation.items", missing.length === 0, "all source items retained", missing);
  }
  return { ok: checks.every(c => c.ok), checks };
}

module.exports = (evaluate, { runtimeSource } = {}) => {
  if (!runtimeSource) throw Error("matrix adapter needs runtimeSource for the probe plan");
  const runRuntime = (action, args) => evaluate(`(async()=>{const fn=${runtimeSource};return await fn(${JSON.stringify(action)},${JSON.stringify(args)},{});})()`);
  const caseOf = id => { const c = byId(id); if (!c) throw Error("Unknown matrix case: " + id); return c; };
  return {
    verifier: { version: "matrix-v1", sha256: crypto.createHash("sha256").update(require("node:fs").readFileSync(__filename)).digest("hex"), dependencyHashes: {} },
    ids,
    prompt,
    // setup：probe 建卡 → 跑 advancement-plan 拿期望 → 删 probe。模型全程看不到 probe。
    async setup(id, label) {
      const cfg = caseOf(id);
      const probeName = `${label}-probe`;
      // 目录解析（arcane 优先已由 browse 去重保证），怪物来源 arcane 包优先、回退 dnd5e.monsters
      await evaluate(`(async()=>{ for (const a of game.actors.filter(x=>x.name===${JSON.stringify(probeName)})) await a.delete(); return true; })()`);
      const classUuid = await (async () => {
        const r = await runRuntime("compendiumBrowse", { scope: "compendium", type: "class" });
        const hit = (r.candidates ?? []).find(e => e.identifier === cfg.cls && e.rules === "2014");
        if (!hit) throw Error(`class catalog 无 2014 ${cfg.cls}`);
        return hit.uuid;
      })();
      const raceUuid = cfg.kind === "npc" ? null : await (async () => {
        const r = await runRuntime("compendiumBrowse", { scope: "compendium", type: "race" });
        const hit = (r.candidates ?? []).find(e => e.identifier === cfg.race && e.rules === "2014");
        if (!hit) throw Error(`race catalog 无 2014 ${cfg.race}`);
        return hit.uuid;
      })();
      const monsterUuid = cfg.kind === "npc" ? await evaluate(`(async()=>{
        const hits=[]; for (const pack of game.packs) { if (pack.metadata.type!=="Actor") continue;
          const idx=await pack.getIndex(); const h=idx.find(e=>String(e.name).toLowerCase().includes(${JSON.stringify(cfg.monsterQuery)}));
          if (h) hits.push({packId:pack.metadata.id, uuid:"Compendium."+pack.metadata.id+".Actor."+h._id, name:h.name}); }
        const pick=hits.find(h=>h.packId.includes("arcane")) ?? hits.find(h=>h.packId==="dnd5e.monsters") ?? null;
        if(!pick) throw Error("monster source not found: "+${JSON.stringify(cfg.monsterQuery)});
        return pick.uuid; })()`) : null;
      // probe 建档
      const probeUuid = await evaluate(`(async()=>{
        if (${JSON.stringify(monsterUuid)}) { const src=await fromUuid(${JSON.stringify(monsterUuid)}); const data=src.toObject(); delete data._id; data.name=${JSON.stringify(probeName)};
          for (const it of data.items??[]) delete it._id;
          const a=await Actor.create(data); return a.uuid; }
        const a=await Actor.create({name:${JSON.stringify(probeName)},type:"character"}); return a.uuid; })()`);
      try {
        const poolPlan = await runRuntime("advancementPlan", { actorUuid: probeUuid, classUuid, ...(raceUuid ? { raceUuid } : {}), characterLevel: cfg.level });
        const subReq = (poolPlan.choiceRequirements ?? []).find(r => r.valueFormat === "subclass-uuid");
        const subclassUuid = (subReq?.candidates ?? []).find(u => (subReq.candidateNames?.[u] ?? "").includes(cfg.subclassMatch));
        if (!subclassUuid) throw Error(`probe plan 子职业池无「${cfg.subclassMatch}」`);
        const plan = await runRuntime("advancementPlan", { actorUuid: probeUuid, classUuid, subclassUuid, ...(raceUuid ? { raceUuid } : {}), characterLevel: cfg.level });
        if (plan.status !== "completed") throw Error(`probe plan ${plan.status}: ${plan.message ?? ""}`);
        const uncovered = plan.coverage?.uncoveredRequiredSteps ?? [];
        if (uncovered.length) throw Error(`probe plan 存在未覆盖步骤，不适合自由发挥判定: ${uncovered.join("; ")}`);
        // 期望字段：技能池/ASI 点数/种族固定加成/种族戏法/生命骰/法术环上限
        const derived = await evaluate(`(async()=>{
          const cls=await fromUuid(${JSON.stringify(classUuid)});
          const hd=parseInt(String(cls?.system?.hd?.denomination??"").replace(/^d/i,""),10)||null;
          let racialSum=0, racialCantrips=0;
          if (${JSON.stringify(raceUuid)}) { const race=await fromUuid(${JSON.stringify(raceUuid)});
            for (const adv of race?.system?.advancement??[]) {
              if (adv.type==="AbilityScoreImprovement") {
                const fixed=adv.configuration?.fixed??{}; for (const v of Object.values(fixed)) racialSum+=Number(v)||0;
                racialSum+=Number(adv.configuration?.points??0)||0; }
              if (adv.type==="ItemChoice") { const r=adv.configuration?.restriction??{};
                if ((r.type==="spell"||!r.type) && String(r.level)==="0") racialCantrips+=Number(adv.configuration?.choices?.["0"]?.count??adv.configuration?.choices?.[0]?.count??1)||0; } } }
          return { hd, racialSum, racialCantrips }; })()`);
        const skillReqs = (plan.choiceRequirements ?? []).filter(r => r.valueFormat === "trait-key" && (r.candidates ?? []).every(k => k.startsWith("skills:")) && r.mode !== "expertise");
        const asiPoints = (plan.choiceRequirements ?? []).filter(r => r.valueFormat === "asi-assignment" || r.valueFormat === "asi-or-feat").reduce((a, r) => a + r.count, 0);
        const budget = plan.spellBudget ?? null;
        const expectations = {
          classUuid, subclassUuid, raceUuid, monsterUuid,
          spellBudget: budget, maxSpellLevel: cfg.maxSpellLevel,
          skillPickCount: skillReqs.reduce((a, r) => a + r.count, 0),
          skillPool: [...new Set(skillReqs.flatMap(r => (r.candidates ?? []).map(k => k.replace(/^skills:/, ""))))],
          asiPoints, hitDie: derived.hd, racialSum: derived.racialSum, racialCantrips: derived.racialCantrips,
        };
        const sourceBefore = cfg.kind === "npc" ? await evaluate(`(async()=>{ const a=game.actors.find(x=>x.name===${JSON.stringify(probeName)});
          return { hpMax: a.system.attributes.hp.max,
            abilities: Object.fromEntries(Object.entries(a.system.abilities).map(([k,v])=>[k,v.value])),
            skills: Object.entries(a.system.skills??{}).filter(([,s])=>(s.value??0)>=1).map(([k])=>k),
            items: a.items.map(i=>({type:i.type,name:i.name})) }; })()`) : null;
        return { name: label, caseId: id, expectations, sourceBefore, monsterUuid };
      } finally {
        await evaluate(`(async()=>{ for (const a of game.actors.filter(x=>x.name===${JSON.stringify(probeName)})) await a.delete(); return true; })()`);
      }
    },
    // verify：终态快照 + 纯函数判定。双臂同标准。
    async verify(id, f) {
      const cfg = caseOf(id);
      const snapshot = await evaluate(`(async()=>{
        const xs=game.actors.filter(a=>a.name===${JSON.stringify(f.name)});
        if (xs.length!==1) return xs.length===0?null:{duplicate:xs.length};
        const a=xs[0];
        return { type:a.type,
          abilities:Object.fromEntries(Object.entries(a.system.abilities).map(([k,v])=>[k,v.value])),
          hp:{value:a.system.attributes.hp.value,max:a.system.attributes.hp.max},
          skills:Object.fromEntries(Object.entries(a.system.skills??{}).filter(([,s])=>(s.value??0)>0).map(([k,s])=>[k,s.value])),
          items:a.items.map(i=>({type:i.type,name:i.name,identifier:i.system?.identifier??null,level:i.system?.level??null,levels:i.system?.levels??null,sourceId:i.flags?.dnd5e?.sourceId??null})) }; })()`);
      if (snapshot?.duplicate) return { ok: false, checks: [{ id: "actor.unique", priority: "core", ok: false, expected: 1, observed: snapshot.duplicate }] };
      return judgeState(cfg, f.expectations, snapshot, f.sourceBefore);
    },
  };
};
module.exports.matrixCaseIds = ids;
module.exports.judgeState = judgeState;
module.exports.MATRIX_CASES = MATRIX_CASES;
