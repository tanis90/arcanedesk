// mt-agent-runtime v0.2.0
(async (action, args, options) => {
    // 握手常量（内联，勿引用模块作用域；与文件头 RUNTIME 保持同步）
    const RUNTIME_META = { name: "mt-agent-runtime", version: "0.2.0", protocolVersion: 2 };
    const g = globalThis;

    if (typeof action !== "string" || !action) {
      throw new Error("INVALID_ACTION: action must be a non-empty string");
    }
    if (!["worldInfo", "doctor", "staticContext", "playContext", "battleContext", "turnContext",
      "actorRead", "sceneRead", "contentSearch", "compendiumBrowse"].includes(action)) {
      throw new Error("ACTION_UNKNOWN: " + action);
    }
    // 原版 requireReady 同序：game 在位 → game.ready → GM 门（只读集，门保持 M1 语义）
    const game = g.game;
    if (!game) throw new Error("ACTION_REJECTED: Foundry game object is not available");
    if (!game.ready) throw new Error("ACTION_REJECTED: Foundry game is not ready");
    if (options?.requireGM !== false && !game.user?.isGM) {
      throw new Error("ACTION_FORBIDDEN: GM user is required");
    }

    // =========================================================================
    // 通用辅助（az runtime 同名函数的移植/适配；只依赖页面全局）
    // =========================================================================
    function cleanText(value) {
      return typeof value === "string" ? value.trim() : "";
    }
    function lower(value) {
      return cleanText(value).toLocaleLowerCase();
    }
    function collectionValues(collection) {
      if (!collection) return [];
      if (typeof collection.values === "function") return Array.from(collection.values());
      if (Array.isArray(collection)) return collection;
      return Object.values(collection);
    }
    function setValues(value) {
      if (!value) return [];
      if (typeof value.values === "function") return Array.from(value.values());
      if (Array.isArray(value)) return value;
      if (typeof value === "object") return Object.keys(value).filter((key) => value[key]);
      return [];
    }
    function tokenDocument(tokenLike) {
      return tokenLike?.document ?? tokenLike;
    }
    function tokenObject(tokenLike) {
      const doc = tokenDocument(tokenLike);
      return doc ? (g.canvas?.tokens?.get?.(doc.id) ?? tokenLike) : null;
    }
    function currentScene() {
      return g.canvas?.scene ?? collectionValues(game.scenes).find((s) => s?.active === true) ?? null;
    }
    function sceneTokens() {
      return Array.from(g.canvas?.tokens?.placeables ?? []);
    }
    function findToken(identifier) {
      const value = cleanText(identifier);
      if (!value) return null;
      const valueLower = lower(value);
      return sceneTokens().find((token) => {
        const doc = tokenDocument(token);
        return (
          doc?.id === value ||
          doc?.uuid === value ||
          token?.id === value ||
          lower(doc?.name ?? token?.name) === valueLower ||
          lower(token?.name).includes(valueLower)
        );
      }) ?? null;
    }
    function findItem(actor, itemId) {
      return collectionValues(actor?.items).find((item) => item?.id === itemId) ?? null;
    }
    function activities(item) {
      return collectionValues(item?.system?.activities).filter(Boolean);
    }
    function findActivity(item, activityId) {
      return activities(item).find((value) => (value?.id ?? value?._id) === activityId) ?? null;
    }
    // 世界集合解析：M3 J3 起 worldCollectionStub.get 是真实现——get 优先，find 兜底
    // （防御非 stub 集合/旧部署页）
    function worldFind(collection, id) {
      if (!collection || id == null) return undefined;
      const byGet = collection.get?.(id);
      if (byGet !== undefined) return byGet;
      if (typeof collection.find === "function") return collection.find((d) => d?._id === id || d?.id === id);
      return undefined;
    }
    // packId：真实 Foundry 的 pack.collection 是字符串包名；shim 的 collection 是空 Collection
    // 实例——取 metadata.id（两者内容一致："<package>.<name>"）
    function packIdOf(pack) {
      return typeof pack?.collection === "string" ? pack.collection
        : (pack?.metadata?.id ?? (pack?.metadata ? pack.metadata.package + "." + pack.metadata.name : null));
    }
    const fnv1a64Hex = function fnv1a64Hex(value) {
      const text = String(value ?? "");
      let hash = BigInt("0xcbf29ce484222325");
      const prime = BigInt("0x100000001b3");
      const mask = BigInt("0xffffffffffffffff");
      for (let i = 0; i < text.length; i++) {
        hash ^= BigInt(text.charCodeAt(i));
        hash = (hash * prime) & mask;
      }
      return hash.toString(16).padStart(16, "0");
    };
    const actionIdMaterialV2 = function actionIdMaterialV2(actorUuid, itemId, activityId, mode) {
      return ["action-v2", actorUuid ?? "", itemId ?? "", activityId ?? "", mode || "default"].join("\0");
    };
    const actionIdV2 = function actionIdV2(actorUuid, itemId, activityId, mode) {
      return "a2_" + fnv1a64Hex(actionIdMaterialV2(actorUuid, itemId, activityId, mode));
    };
    const collectActionCandidatesV2 = function collectActionCandidatesV2(actor, mode) {
      const actorUuid = actor?.uuid ?? "";
      const candidates = [];
      for (const item of collectionValues(actor?.items)) {
        if (!item) continue;
        for (const activity of activities(item)) {
          const activityId = activity?.id ?? activity?._id ?? null;
          candidates.push({
            actionId: actionIdV2(actorUuid, item.id, activityId, mode),
            itemId: item.id, activityId, item, activity,
          });
        }
      }
      return candidates;
    };
    // 可执行判定：az 词汇 attack/save/damage/heal/utility（summon 需 arcane 模块 marker——
    // 我们不加载模块，summon 恒不可执行）。SRD 打包物自带 midiProperties（automationOnly）。
    const isAgentCallableActivityV2 = function isAgentCallableActivityV2(activity) {
      const type = String(activity?.type ?? "");
      return ["attack", "save", "damage", "heal", "utility"].includes(type)
        && activity?.midiProperties?.automationOnly !== true
        && activity?.isOverTimeFlag !== true;
    };
    // availability 直报：az 的 isActionAvailableV2/actionBlockV2 全部依赖 arcane 模块
    // availability flags / ActiveEffect 层——两者在 M2 边界外（无模块、effects 空），
    // 语义退化为「无门槛 = 可用」，见文件头降级声明。
    const executableActionCandidatesV2 = function executableActionCandidatesV2(actor) {
      return collectActionCandidatesV2(actor).filter((candidate) =>
        isAgentCallableActivityV2(candidate.activity));
    };
    function concentrationNameV2(actor) {
      // M4 前无 ActiveEffect 语义层，恒 null（degraded 直报，不伪造）
      for (const effect of collectionValues(actor?.effects)) {
        const statuses = setValues(effect?.statuses);
        if (!statuses.includes("concentrating")) continue;
        return cleanText(effect?.name ?? effect?.label) || "concentrating";
      }
      return null;
    }
    function spellResourcesV2(actor) {
      const spells = actor?.system?.spells ?? {};
      const resources = {};
      for (const [key, slot] of Object.entries(spells)) {
        if (!slot || typeof slot !== "object") continue;
        if (slot.value === undefined && slot.max === undefined) continue;
        resources[key] = slot.value ?? 0;
      }
      return resources;
    }
    function staticBlockV2(actor) {
      const attributes = actor?.system?.attributes ?? {};
      const senses = attributes.senses ?? {};
      const details = actor?.system?.details ?? {};
      return {
        maxHp: attributes.hp?.max ?? null,
        ac: attributes.ac?.value ?? attributes.ac?.flat ?? null,
        speed: attributes.movement?.walk ?? null,
        senses: Object.entries(senses)
          .filter(([, value]) => typeof value === "number" && value > 0)
          .map(([key, value]) => key + ":" + value),
        traits: [details.type?.value ?? details.race ?? null].filter(Boolean),
      };
    }
    function sideV2(disposition) {
      if (disposition >= 1) return "party";
      if (disposition <= -1) return "hostile";
      return "neutral";
    }
    function effectiveActivityActivationTypeV2(item, activity) {
      const itemType = String(item?.system?.activation?.type ?? "").trim();
      const activityType = String(activity?.activation?.type ?? "").trim()
        || String(activity?._source?.activation?.type ?? "").trim();
      const overrides = activity?.activation?.override === true
        || activity?._source?.activation?.override === true;
      return overrides ? (activityType || itemType) : (itemType || activityType);
    }
    // 简化版输入契约（az deriveActivityInputContract 的 M2 只读子集）：
    // mode = placed-template | self | selected-targets；supported 恒 true（midi 直报口径，
    // 执行期的模板/召唤拒绝决策归 M5 executeTurn）。
    function deriveActivityInputContractLite(item, activity) {
      const itemTarget = item?.system?.target ?? {};
      const activityTarget = activity?.target ?? {};
      const target = activityTarget?.override === true ? activityTarget : itemTarget;
      const affectsType = String(target?.affects?.type ?? target?.type ?? "");
      const mode = target?.template?.type
        ? "placed-template"
        : (affectsType === "self" ? "self" : "selected-targets");
      const optional = (item?.type === "spell" && Number(item.system?.level) > 0
        && activity?.consumption?.scaling?.allowed) ? ["input.spellLevel"] : [];
      return { supported: true, mode, target: { type: affectsType || null, count: target?.affects?.count ?? null }, optional };
    }
    function damagePartFormula(part) {
      const number = part?.number ?? null;
      const denomination = part?.denomination ?? null;
      const bonus = cleanText(part?.bonus ?? "");
      let formula = "";
      if (number && denomination) formula = number + "d" + denomination;
      if (bonus) formula = formula ? formula + (bonus.startsWith("-") ? bonus : "+" + bonus) : bonus;
      return formula || null;
    }
    function serializeActivityEntry(item, activity) {
      const contract = deriveActivityInputContractLite(item, activity);
      return {
        itemId: item.id,
        itemName: item.name,
        itemType: item.type,
        activityId: activity?.id ?? activity?._id ?? null,
        activityName: activity?.name ?? null,
        type: activity?.type ?? null,
        activation: effectiveActivityActivationTypeV2(item, activity) || null,
        range: {
          value: activity?.range?.value ?? item?.system?.range?.value ?? null,
          long: activity?.range?.long ?? item?.system?.range?.long ?? null,
          units: activity?.range?.units ?? item?.system?.range?.units ?? null,
          label: activity?.range?.labels?.range ?? null,
        },
        target: {
          type: contract.target.type,
          count: contract.target.count,
          prompt: activity?.target?.prompt ?? null,
        },
        damage: collectionValues(activity?.damage?.parts).map((part) => ({ formula: damagePartFormula(part) })),
        inputContract: contract,
      };
    }
    function tokenActionEntries(tokenLike) {
      const doc = tokenDocument(tokenLike);
      const actor = doc?.actor ?? null;
      const entries = [];
      if (!actor) return entries;
      for (const item of collectionValues(actor.items)) {
        for (const activity of activities(item)) {
          if (!isAgentCallableActivityV2(activity)) continue;
          entries.push(serializeActivityEntry(item, activity));
        }
      }
      return entries;
    }
    function actionSummaryV2(entry) {
      const parts = [entry.type ?? "action"];
      if (entry.activation) parts.push(entry.activation);
      const rangeLabel = entry.range?.label ?? (entry.range?.value ? entry.range.value + " " + (entry.range.units ?? "") : null);
      if (rangeLabel) parts.push(cleanText(rangeLabel));
      const damage = entry.damage.map((part) => part?.formula).filter(Boolean);
      if (damage.length) parts.push(damage.join(" + "));
      return parts.join("; ");
    }
    function actionDefinitionV2(actor, entry) {
      return {
        id: actionIdV2(actor?.uuid, entry.itemId, entry.activityId),
        itemId: entry.itemId ?? null,
        itemName: entry.itemName ?? null,
        name: entry.itemName + (entry.activityName && entry.activityName !== entry.itemName ? " (" + entry.activityName + ")" : ""),
        kind: entry.type ?? null,
        summary: actionSummaryV2(entry),
        target: {
          kind: entry.target?.type ?? null,
          count: entry.target?.count ?? null,
          range: entry.range?.value ?? null,
        },
        input: entry.inputContract ?? {},
      };
    }
    // 配置告警（az actionConfigProblemV2 的无模块子集：只查模板面，arcane interaction
    // 契约分支整体不存在）
    function actionConfigProblemV2(item, activity) {
      const itemTarget = item?.system?.target ?? {};
      const activityTarget = activity?.target ?? {};
      const effectiveTarget = activityTarget?.override === true ? activityTarget : itemTarget;
      if (deriveActivityInputContractLite(item, activity).mode === "placed-template") {
        if (!effectiveTarget?.template?.type) return "placed-template-missing-template";
        if (activityTarget?.prompt !== true) return "template-prompt-disabled";
      }
      return null;
    }
    function playTimingSupported(item, activity) {
      const timing = activity?.activation?.type ?? item?.system?.activation?.type;
      return !["reaction", "minute", "hour", "day", "round", "legendary", "mythic"].includes(timing);
    }
    // 叙事法术槽位（az playNarrativeCost 的单职业直读版，见文件头降级声明）
    function playNarrativeCost(item, activity, actor, spellLevel) {
      if (item?.type !== "spell") throw new Error("Narrative execution requires a spell");
      const activation = activity?.activation?.type ?? item.system?.activation?.type;
      if (activation && !["action", "bonus", "special"].includes(activation)) throw new Error("Unsupported casting timing");
      const hasLimitedUses = (uses) => {
        const raw = uses?.max;
        if (raw == null || String(raw).trim() === "") return false;
        return !Number.isFinite(Number(raw)) || Number(raw) !== 0;
      };
      if (hasLimitedUses(item.system?.uses) || hasLimitedUses(activity?.uses)
        || collectionValues(activity?.consumption?.targets).length) {
        throw new Error("Narrative consumption has additional resources");
      }
      const level = Number(item.system?.level);
      if (!Number.isInteger(level) || level < 0 || level > 9) throw new Error("Unknown spell level");
      const method = item.system?.method;
      if (!method || !["spell", "pact", "atwill"].includes(method)) throw new Error("Unknown spell resource method");
      const consumes = activity?.consumption?.spellSlot ?? (level > 0 && method !== "atwill");
      if (!consumes || level === 0) {
        if (spellLevel !== undefined) throw new Error("No spell slot to upcast");
        return null;
      }
      const key = "spell" + level;
      const pool = actor?.system?.spells?.[key];
      if (!pool || !Number.isFinite(pool.value) || !Number.isFinite(pool.max)) throw new Error("Unknown spell slot pool");
      return { key, value: pool.value, max: pool.max };
    }
    // 动作手册：activity 目录 + 无 activity 法术的叙事条目（az playTokenActions 语义；
    // declaredRider 词汇依赖 arcane 模块，恒省略）
    function playTokenActions(doc) {
      const actor = doc.actor;
      if (!actor) return [];
      const definitions = [];
      for (const entry of tokenActionEntries(doc)) {
        if (!entry.activityId || entry.inputContract?.supported !== true) continue;
        const item = findItem(actor, entry.itemId);
        const activity = item ? findActivity(item, entry.activityId) : null;
        if (!playTimingSupported(item, activity)) continue;
        const definition = actionDefinitionV2(actor, entry);
        const problem = item && activity ? actionConfigProblemV2(item, activity) : null;
        definitions.push({ ...definition, activityId: entry.activityId,
          ...(problem ? { warnings: [problem] } : {}) });
      }
      for (const item of collectionValues(actor.items)) {
        if (item.type !== "spell" || definitions.some((definition) => definition.itemId === item.id)) continue;
        const itemActivities = activities(item);
        if (itemActivities.some((activity) => ["summon", "attack", "damage", "save"].includes(String(activity?.type ?? "")))) continue;
        const activity = itemActivities[0] ?? null;
        let cost = null;
        try { cost = playNarrativeCost(item, activity, actor); } catch { continue; }
        definitions.push({ id: "narrative:" + item.id, itemId: item.id, activityId: activity?.id ?? activity?._id ?? null,
          itemName: item.name, name: item.name, kind: "spell", summary: "Record narrative spell consumption; DM resolves fiction",
          target: { kind: "narrative", count: null, range: null },
          input: { optional: cost && item.system.method === "spell" ? ["input.spellLevel"] : [] },
          resource: cost ? { kind: "spellSlot", key: cost.key } : { kind: "none" }, resolution: "narrative" });
      }
      return definitions;
    }
    function playActionRef(scope, doc, definition) {
      return "play:v1:" + fnv1a64Hex(JSON.stringify([
        scope.world, scope.sceneUuid, doc.uuid ?? doc.id, doc.actor?.uuid ?? doc.actor?.id,
        definition.itemId, definition.activityId, definition.id,
      ]));
    }
    // —— play 焦点（az playFocus；无战斗分支按 M2 指令改为 目标集+选中 placeables）——
    function playFocus() {
      const scene = currentScene();
      const sceneId = scene?.id ?? null;
      const combatSceneId = (combat) => combat?.scene?.id
        ?? (typeof combat?.scene === "string" ? combat.scene : null)
        ?? combat?.sceneId ?? null;
      const started = (combat) => combat?.started === true
        || (combat?.started == null && Number(combat?.round) > 0);
      const combats = collectionValues(game.combats ?? (game.combat ? [game.combat] : [])).filter(started);
      let candidates = combats.filter((combat) => combat.isActive === true);
      if (!candidates.length) {
        candidates = combats
          .filter((combat) => combatSceneId(combat) == null || combatSceneId(combat) === sceneId)
          .sort((a, b) => (b._stats?.modifiedTime ?? 0) - (a._stats?.modifiedTime ?? 0));
      }
      if (candidates.length > 1) throw new Error("AMBIGUOUS_COMBAT: more than one started combat is visible here");
      const combat = candidates[0] ?? null;
      let tokens;
      if (combat) {
        tokens = collectionValues(combat.combatants)
          .map((entry) => (scene?.tokens?.get ? scene.tokens.get(entry.tokenId) : undefined) ?? entry.token)
          .filter(Boolean);
      } else {
        const picked = [...setValues(game.user?.targets), ...collectionValues(g.canvas?.tokens?.controlled)];
        tokens = picked.map(tokenDocument).filter(Boolean);
      }
      const unique = [...new Map(tokens.map((token) => {
        const doc = tokenDocument(token);
        return [doc?.id ?? doc?.uuid, doc];
      })).values()].filter(Boolean);
      return {
        scope: { world: { origin: g.location?.origin ?? null, id: game.world?.id ?? null },
          sceneUuid: scene?.uuid ?? (scene?.id ? "Scene." + scene.id : null), combatId: combat?.id ?? null },
        combat, tokens: unique,
      };
    }
    // 指纹材料：与 az playItemStructure 同目的（身份+能力结构，不含易变 uses/HP），但活动取
    // 干净投影（shim 的 Activity 实例带 parent 引用，直接 stringify 会带出环）
    function activityStructure(activity) {
      return [activity?.id ?? activity?._id ?? null, activity?.name ?? null, activity?.type ?? null,
        activity?.activation?.type ?? null, activity?.target?.template?.type ?? null,
        activity?.target?.affects?.count ?? null, activity?.range?.value ?? null,
        activity?.consumption?.spellSlot === true, activity?.midiProperties?.automationOnly === true];
    }
    function playItemStructure(item) {
      const system = item?.system ?? {};
      return [item?.id, item?.type, item?.name, system?.identifier ?? null, system?.level ?? null,
        collectionValues(system?.activities).map(activityStructure)];
    }
    function playReadContext(heavy) {
      const focus = playFocus();
      const degraded = heavy ? ["availability:arcane-flags-absent"]
        : ["conditions:pre-M4", "concentration:pre-M4", "activeBuffRiderIds:pre-M4"];
      const combatants = focus.tokens.map((doc) => {
        const actor = doc.actor ?? null;
        const identity = {
          tokenUuid: doc.uuid ?? focus.scope.sceneUuid + ".Token." + doc.id,
          tokenId: doc.id, actorUuid: actor?.uuid ?? null, actorId: actor?.id ?? null,
          name: doc.name ?? actor?.name ?? null,
        };
        if (heavy) return { ...identity, side: sideV2(doc.disposition), static: actor ? staticBlockV2(actor) : null,
          actions: playTokenActions(doc).map((definition) => ({ ...definition,
            actionRef: playActionRef(focus.scope, doc, definition), resolution: definition.resolution ?? "auto" })),
          ...(!actor ? { warnings: ["TOKEN_HAS_NO_ACTOR"] } : {}) };
        return { ...identity,
          hp: { value: actor?.system?.attributes?.hp?.value ?? null,
            temp: actor?.system?.attributes?.hp?.temp ?? 0 },
          resources: actor ? spellResourcesV2(actor) : {}, conditions: setValues(actor?.statuses),
          concentration: actor ? concentrationNameV2(actor) : null, visible: !doc.hidden,
          defeated: !!collectionValues(focus.combat?.combatants).find((entry) => entry.tokenId === doc.id)?.defeated,
          availableActionIds: actor ? executableActionCandidatesV2(actor).map((candidate) => candidate.actionId) : [],
          activeBuffRiderIds: [] };
      });
      // 指纹只哈希身份与能力结构，绝不哈希易变的 uses/slots/HP/conditions
      const structure = focus.tokens.map((doc) => [doc.id, doc.name, doc.disposition,
        doc.actor?.uuid ?? doc.actor?.id ?? null, collectionValues(doc.actor?.items).map(playItemStructure)]);
      const contextRef = "context:v1:" + fnv1a64Hex(JSON.stringify([focus.scope, structure], (_key, value) => {
        const kind = Object.prototype.toString.call(value);
        if (kind === "[object Set]") return Array.from(value).sort();
        if (kind === "[object Map]") return Array.from(value.entries()).sort(([a], [b]) => String(a).localeCompare(String(b)));
        return value;
      }));
      const active = focus.combat?.combatant;
      return { schema: "arcane.play.v1", scope: focus.scope, contextRef,
        turn: focus.combat ? { round: focus.combat.round, index: focus.combat.turn,
          tokenId: active?.tokenId ?? null, actorId: active?.actorId ?? null } : null,
        combatants, degraded };
    }
    function battleContextDataV2() {
      const combat = game.combat ?? null;
      if (!combat) {
        // az 原版无战斗时抛 "No active combat"（无 CODE 前缀）；我们按 CODE: message 约定加码
        throw new Error("NO_ACTIVE_COMBAT: battleContext requires a running combat (turnContext reports ended when idle)");
      }
      const combatants = [];
      for (const combatant of collectionValues(combat.combatants)) {
        const token = findToken(combatant.tokenId) ?? tokenObject(combatant.token);
        const doc = tokenDocument(token);
        const actor = doc?.actor ?? combatant?.actor ?? null;
        if (!doc?.id || !actor) continue;
        const entries = tokenActionEntries(token).filter((entry) =>
          entry.activityId && entry.inputContract?.supported === true);
        combatants.push({
          actorId: actor.id,
          tokenId: doc.id,
          name: doc.name ?? token?.name ?? actor.name ?? null,
          side: sideV2(doc.disposition),
          static: staticBlockV2(actor),
          actions: entries.map((entry) => {
            const definition = actionDefinitionV2(actor, entry);
            const item = findItem(actor, entry.itemId);
            const entryActivity = item ? findActivity(item, entry.activityId) : null;
            const configProblem = item && entryActivity ? actionConfigProblemV2(item, entryActivity) : null;
            if (configProblem) definition.warnings = [configProblem];
            return definition;
          }),
        });
      }
      return { schema: "arcane.turn.v2", battleId: combat.id, combatants,
        degraded: ["availability:arcane-flags-absent"] };
    }
    function turnContextDataV2() {
      const combat = game.combat ?? null;
      if (!combat) return { schema: "arcane.turn.v2", battleId: null, ended: true };
      const active = combat.combatant ?? null;
      const activeToken = active ? (findToken(active.tokenId) ?? tokenObject(active.token)) : null;
      const activeActor = activeToken?.actor ?? tokenDocument(activeToken)?.actor ?? active?.actor ?? null;
      const combatants = [];
      for (const combatant of collectionValues(combat.combatants)) {
        const token = findToken(combatant.tokenId) ?? tokenObject(combatant.token);
        const doc = tokenDocument(token);
        const actor = doc?.actor ?? combatant?.actor ?? null;
        if (!doc?.id) continue;
        combatants.push({
          actorId: actor?.id ?? combatant.actorId ?? null,
          tokenId: doc.id,
          name: combatant.name ?? doc.name ?? null,
          hp: { value: actor?.system?.attributes?.hp?.value ?? null,
            temp: actor?.system?.attributes?.hp?.temp ?? 0 },
          conditions: setValues(actor?.statuses),
          concentration: concentrationNameV2(actor),
          defeated: !!combatant.defeated,
          visible: !doc.hidden,
        });
      }
      return {
        schema: "arcane.turn.v2",
        battleId: combat.id,
        ended: false,
        turn: {
          round: combat.round ?? 0,
          index: combat.turn ?? null,
          actorId: activeActor?.id ?? active?.actorId ?? null,
          tokenId: active?.tokenId ?? null,
          name: active?.name ?? null,
        },
        actor: activeActor ? {
          hp: { value: activeActor.system?.attributes?.hp?.value ?? null,
            temp: activeActor.system?.attributes?.hp?.temp ?? 0 },
          resources: spellResourcesV2(activeActor),
          conditions: setValues(activeActor.statuses),
          concentration: concentrationNameV2(activeActor),
          availableActionIds: executableActionCandidatesV2(activeActor).map((candidate) => candidate.actionId),
        } : null,
        combatants,
        degraded: ["conditions:pre-M4", "concentration:pre-M4"],
      };
    }

    // =========================================================================
    // prep 投影（actorRead / sceneRead；readState 指纹是 M3 写守卫的输入）
    // =========================================================================
    function prepWorld(world) {
      if (!world || world.origin !== (g.location?.origin ?? null) || world.id !== (game.world?.id ?? null)) {
        throw new Error("WORLD_CHANGED: bound world mismatch");
      }
    }
    async function prepActor(uuid) {
      if (typeof uuid !== "string" || !uuid || uuid.length > 256) throw new Error("INPUT_INVALID: exact Actor UUID required");
      const resolved = await g.fromUuid(uuid);
      // shim 适配：midi 的 MidiActor 不带 documentName 静态面——以世界集合成员身份兜底判定
      const actor = resolved && (resolved.documentName === "Actor"
        || collectionValues(game.actors).includes(resolved)) ? resolved : null;
      if (!actor || actor.uuid !== uuid || actor.pack) {
        throw new Error("ACTOR_NOT_FOUND: exact world Actor required");
      }
      return actor;
    }
    function prepTokenImageFields(token, prefix = "") {
      token = typeof token?.toObject === "function" ? token.toObject() : token;
      return { [prefix + "texture.src"]: token?.texture?.src ?? null,
        [prefix + "ring.enabled"]: token?.ring?.enabled ?? false,
        [prefix + "ring.subject.texture"]: token?.ring?.subject?.texture ?? null };
    }
    function prepActorFields(actor, include = []) {
      const hp = actor.system?.attributes?.hp ?? {}, ac = actor.system?.attributes?.ac ?? {};
      const fields = { name: actor.name,
        // 降级：game.folders 不存在（M3 前无 folder 语义）——folder 恒 null
        folder: actor.folder?.id ?? actor.folder ?? null, img: actor.img ?? null,
        "system.attributes.hp.value": hp.value ?? null, "system.attributes.hp.max": hp.max ?? null,
        "system.attributes.hp.temp": hp.temp ?? null, "system.attributes.ac.flat": ac.flat ?? null,
        "system.attributes.ac.calc": ac.calc ?? null };
      for (const abl of ["str", "dex", "con", "int", "wis", "cha"]) {
        fields["system.abilities." + abl + ".value"] = actor.system?.abilities?.[abl]?.value ?? null;
      }
      if (include.includes("prototypeToken")) {
        for (const key of ["name", "width", "height", "disposition"]) {
          fields["prototypeToken." + key] = actor.prototypeToken?.[key] ?? null;
        }
        Object.assign(fields, prepTokenImageFields(actor.prototypeToken, "prototypeToken."));
      }
      return fields;
    }
    function prepItemIdentity(item) {
      return { id: item.id, uuid: item.uuid, name: item.name, type: item.type,
        sourceUuid: item.flags?.arcanedesk?.sourceUuid ?? item._stats?.compendiumSource
          ?? item.flags?.dnd5e?.sourceId ?? item.flags?.core?.sourceId ?? null };
    }
    function prepSceneTokens(actor) {
      return collectionValues(game.scenes).flatMap((scene) => collectionValues(scene.tokens)
        .filter((token) => token.actor?.uuid === actor.uuid || (!actor.isToken && token.actorId === actor.id))
        .map((token) => ({ uuid: token.uuid, sceneUuid: scene.uuid, id: token.id, name: token.name,
          actorUuid: token.actor?.uuid ?? null, actorLink: !!token.actorLink, image: prepTokenImageFields(token) })));
    }
    async function actorReadData(input) {
      if (!input || typeof input !== "object") throw new Error("INPUT_INVALID: actorRead arguments required");
      const actor = await prepActor(input.actorUuid);
      const include = input.include ?? [];
      if (!Array.isArray(include) || include.some((key) => !["items", "resources", "prototypeToken", "sceneTokens"].includes(key))) {
        throw new Error("INPUT_INVALID: unknown projection");
      }
      const limit = input.limit ?? 30;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INPUT_INVALID: limit must be 1..100");
      const signature = fnv1a64Hex(JSON.stringify([actor.uuid, include]));
      let offset = 0;
      if (input.cursor) {
        const parts = String(input.cursor).split(":");
        if (parts.length !== 4 || parts[0] !== "actor" || parts[1] !== "v1" || parts[2] !== signature || !/^\d+$/.test(parts[3])) {
          throw new Error("INPUT_INVALID: projection cursor mismatch");
        }
        offset = Number(parts[3]);
        if (!Number.isSafeInteger(offset)) throw new Error("INPUT_INVALID: invalid offset");
      }
      const fields = prepActorFields(actor, include);
      const allItems = collectionValues(actor.items).map(prepItemIdentity);
      const tokens = include.includes("sceneTokens") ? prepSceneTokens(actor) : [];
      const result = { actorUuid: actor.uuid, name: actor.name, type: actor.type, folderId: fields.folder,
        img: fields.img,
        hp: { value: fields["system.attributes.hp.value"], max: fields["system.attributes.hp.max"], temp: fields["system.attributes.hp.temp"] },
        ac: actor.system?.attributes?.ac?.value ?? fields["system.attributes.ac.flat"],
        readState: { actorUuid: actor.uuid, world: { origin: g.location?.origin, id: game.world?.id },
          include, fields,
          ...(include.includes("items") ? { items: allItems } : {}),
          ...(include.includes("sceneTokens") ? { sceneTokens: tokens } : {}) } };
      if (include.includes("items")) {
        result.items = collectionValues(actor.items).slice(offset, offset + limit).map((item) => ({
          ...prepItemIdentity(item),
          quantity: typeof item.system?.quantity === "number" ? item.system.quantity : null,
          equipped: typeof item.system?.equipped === "boolean" ? item.system.equipped : null,
        }));
      }
      if (include.includes("sceneTokens")) result.sceneTokens = tokens.slice(offset, offset + limit);
      if (include.includes("resources")) result.resources = spellResourcesV2(actor);
      if (include.includes("prototypeToken")) {
        result.prototypeToken = Object.fromEntries(Object.entries(fields)
          .filter(([key]) => key.startsWith("prototypeToken."))
          .map(([key, value]) => [key.slice(15), value]));
      }
      const total = Math.max(include.includes("items") ? allItems.length : 0, tokens.length);
      result.nextCursor = offset + limit < total ? "actor:v1:" + signature + ":" + (offset + limit) : null;
      return result;
    }
    async function prepScene(uuid) {
      if (typeof uuid !== "string" || !uuid || uuid.length > 256) throw new Error("INPUT_INVALID: exact Scene UUID required");
      const resolved = await g.fromUuid(uuid);
      // shim 适配：dnd5e Scene5e 不带 documentName 静态面——以世界集合成员身份兜底判定
      const scene = resolved && (resolved.documentName === "Scene"
        || collectionValues(game.scenes).includes(resolved)) ? resolved : null;
      if (!scene || scene.uuid !== uuid || scene.pack) {
        throw new Error("SCENE_NOT_FOUND: exact world Scene required");
      }
      return scene;
    }
    function prepSceneFields(scene) {
      const fields = { name: scene.name, active: !!scene.active, width: scene.width, height: scene.height,
        "background.src": scene.background?.src ?? null };
      for (const key of ["type", "size", "distance", "units"]) fields["grid." + key] = scene.grid?.[key] ?? null;
      return fields;
    }
    function prepPlacementFields(token) {
      const fields = {};
      for (const key of ["name", "x", "y", "hidden", "disposition", "width", "height", "elevation", "actorId", "actorLink"]) {
        fields[key] = token[key] ?? null;
      }
      return fields;
    }
    function prepSceneTokenState(token) {
      return { id: token.id, uuid: token.uuid, fields: prepPlacementFields(token),
        fingerprint: fnv1a64Hex(JSON.stringify(token.toObject())) };
    }
    async function sceneReadData(input) {
      if (!input || typeof input !== "object") throw new Error("INPUT_INVALID: sceneRead arguments required");
      for (const key of Object.keys(input)) {
        if (!["sceneUuid", "include", "limit", "cursor"].includes(key)) throw new Error("INPUT_INVALID: unsupported fields");
      }
      const scene = await prepScene(input.sceneUuid);
      const include = input.include ?? [];
      const limit = input.limit ?? 50;
      if (!Array.isArray(include) || new Set(include).size !== include.length
        || include.some((key) => !["tokens", "walls", "lights", "tiles", "notes", "sounds"].includes(key))
        || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("INPUT_INVALID: invalid Scene projection or page size");
      }
      const signature = fnv1a64Hex(JSON.stringify([scene.uuid, include]));
      let offset = 0;
      if (input.cursor !== undefined) {
        const parts = String(input.cursor).split(":");
        if (parts.length !== 4 || parts[0] !== "scene" || parts[1] !== "v1" || parts[2] !== signature
          || !/^\d+$/.test(parts[3]) || !Number.isSafeInteger(Number(parts[3]))) {
          throw new Error("INPUT_INVALID: Scene cursor mismatch");
        }
        offset = Number(parts[3]);
      }
      const fields = prepSceneFields(scene);
      // 降级：lights/tiles/notes/sounds 在 shim 侧是未规格化裸数据——按 M2 声明报空集合
      const DEGRADED_PLACEABLES = ["lights", "tiles", "notes", "sounds"];
      const result = { sceneUuid: scene.uuid, ...fields, placeables: {}, nextCursors: {},
        readState: { sceneUuid: scene.uuid, world: { origin: g.location?.origin, id: game.world.id },
          fields, include,
          ...(include.includes("tokens") ? { tokens: collectionValues(scene.tokens).map(prepSceneTokenState) } : {}) },
        ...(include.some((key) => DEGRADED_PLACEABLES.includes(key)) ? { degraded: DEGRADED_PLACEABLES.filter((key) => include.includes(key)).map((key) => key + ":pre-M4") } : {}) };
      for (const key of include) {
        const entries = DEGRADED_PLACEABLES.includes(key) ? [] : collectionValues(scene[key]);
        result.placeables[key] = entries.slice(offset, offset + limit).map((doc) => {
          const value = { id: doc.id, uuid: doc.uuid };
          const keys = { tokens: ["name", "x", "y", "hidden", "disposition", "width", "height", "elevation", "actorId", "actorLink"],
            walls: ["c", "door", "ds", "move", "sight"] }[key];
          for (const field of keys) if (doc[field] !== undefined) value[field] = doc[field];
          return value;
        });
        result.nextCursors[key] = offset + limit < entries.length ? "scene:v1:" + signature + ":" + (offset + limit) : null;
      }
      return result;
    }

    // =========================================================================
    // contentSearch / compendiumBrowse
    // =========================================================================
    async function contentSearchData(input) {
      const { scope, documentType, query, packIds, actorType, itemType } = input ?? {};
      if (!((scope === "world" && ["Actor", "Scene"].includes(documentType))
        || (scope === "compendium" && ["Actor", "Item"].includes(documentType)))
        || typeof query !== "string" || query.length > 256
        || (packIds !== undefined && (!Array.isArray(packIds) || packIds.length > 20
          || packIds.some((id) => typeof id !== "string" || id.length > 256)))
        || (actorType && documentType !== "Actor") || (itemType && documentType !== "Item")) {
        throw new Error("INPUT_INVALID: unsupported content search");
      }
      const limit = input.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INPUT_INVALID: limit must be 1..100");
      const signature = fnv1a64Hex(JSON.stringify([scope, documentType, query, packIds ?? null, actorType ?? null, itemType ?? null]));
      let offset = 0;
      if (input.cursor !== undefined) {
        const parts = String(input.cursor).split(":");
        if (parts.length !== 4 || parts[0] !== "search" || parts[1] !== "v1" || parts[2] !== signature
          || !/^\d+$/.test(parts[3])) {
          throw new Error("INPUT_INVALID: cursor does not match this query");
        }
        offset = Number(parts[3]);
        if (!Number.isSafeInteger(offset)) throw new Error("INPUT_INVALID: invalid cursor offset");
      }
      const normalizedQuery = query.toLocaleLowerCase();
      const identifierQuery = normalizedQuery.replace(/[^\p{L}\p{N}]+/gu, "");
      const matches = (value) => (String(value.name ?? "").toLocaleLowerCase().includes(normalizedQuery)
        || (documentType === "Item" && identifierQuery.length > 0
          && String(value.system?.identifier ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").includes(identifierQuery)))
        && (!actorType || value.type === actorType) && (!itemType || value.type === itemType);
      const entries = [];
      if (scope === "world") {
        if (packIds !== undefined) throw new Error("INPUT_INVALID: packIds are compendium-only");
        for (const value of collectionValues(documentType === "Actor" ? game.actors : game.scenes)) {
          if (matches(value)) entries.push({ uuid: value.uuid, id: value.id, name: value.name, type: value.type ?? documentType, documentType });
        }
      } else {
        const packs = collectionValues(game.packs).filter((pack) => (pack.documentName ?? pack.metadata?.type) === documentType
          && (!packIds || packIds.includes(packIdOf(pack))));
        if (packIds?.some((id) => !packs.some((pack) => packIdOf(pack) === id))) {
          throw new Error("PACK_NOT_FOUND: requested pack is missing or has another document type");
        }
        for (const pack of packs) {
          // shim 的 getIndex 忽略 fields 参数（索引本就是瘦身面，字段已覆盖 type/system.identifier）
          const index = await pack.getIndex({ fields: documentType === "Item" ? ["type", "system.identifier"] : ["type"] });
          for (const value of collectionValues(index)) {
            if (matches(value)) {
              const id = value._id ?? value.id;
              entries.push({ uuid: "Compendium." + packIdOf(pack) + "." + documentType + "." + id,
                id, entryId: id, name: value.name, type: value.type ?? documentType, documentType,
                packId: packIdOf(pack), package: pack.metadata?.packageName ?? pack.metadata?.package ?? String(packIdOf(pack)).split(".")[0] });
            }
          }
        }
      }
      entries.sort((a, b) => String(a.uuid).localeCompare(String(b.uuid)));
      return { entries: entries.slice(offset, offset + limit), total: entries.length,
        nextCursor: offset + limit < entries.length ? "search:v1:" + signature + ":" + (offset + limit) : null };
    }
    // 降级：无 arcane 模块包——preferExistingRow 退化为「先扫到者胜」的去重
    function preferExistingRow(existing) {
      return !!existing;
    }
    async function contentListCandidates(input, type) {
      const rules = input.rules === undefined ? null : String(input.rules);
      if (rules !== null && !["2014", "2024"].includes(rules)) throw new Error("INPUT_INVALID: rules must be 2014 or 2024");
      const page = input.page ?? 1, pageSize = input.pageSize ?? 20;
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
        throw new Error("INPUT_INVALID: page/pageSize (1..50) required");
      }
      const maxLevel = input.maxLevel === undefined ? null : input.maxLevel;
      if (maxLevel !== null && (!Number.isInteger(maxLevel) || maxLevel < 0 || maxLevel > 9)) {
        throw new Error("INPUT_INVALID: maxLevel must be 0..9");
      }
      const itemTypes = ["weapon", "equipment", "consumable", "tool", "loot", "container", "ammo"];
      const itemType = input.itemType === undefined ? null : String(input.itemType);
      if (itemType !== null && !itemTypes.includes(itemType)) throw new Error("INPUT_INVALID: itemType must be a native Item type");
      const query = String(input.query ?? "").trim().toLocaleLowerCase();
      // 标点不敏感匹配："Explorer's Pack" 必须能以 identifier "explorers-pack" 命中
      const identifierQuery = query.replace(/[^\p{L}\p{N}]+/gu, "");
      const names = input.names === undefined ? null : input.names;
      if (names !== null && (!Array.isArray(names) || !names.length || names.length > 50
        || names.some((name) => typeof name !== "string" || !name.trim()))) {
        throw new Error("INPUT_INVALID: names must be 1..50 non-empty strings");
      }
      if (names !== null && query) throw new Error("INPUT_INVALID: use either query or names, not both");
      let classIdentifier = null, spellListIdentifiers = null;
      if (type === "spell" && input.classUuid !== undefined) {
        // shim 的 fromUuid 对 Compendium 返回纯数据对象（无 documentName）——以 type 判定
        const classSource = await g.fromUuid(input.classUuid).catch(() => null);
        if (!classSource || classSource.type !== "class" || !isCompendiumUuid(input.classUuid)) {
          throw new Error("SOURCE_NOT_FOUND: exact compendium class required");
        }
        classIdentifier = classSource.system?.identifier ?? null;
        // dnd5e registry 的职业表标识符集合（spellClasses 模块注解缺失时的回退路径）
        const listEntry = classIdentifier ? g.dnd5e?.registry?.spellLists?.forType?.("class:" + classIdentifier) : null;
        spellListIdentifiers = listEntry?.identifiers ?? null;
      }
      const byKey = new Map();
      for (const pack of collectionValues(game.packs)) {
        if (pack?.metadata?.type !== "Item") continue;
        const packId = packIdOf(pack);
        const index = await pack.getIndex({ fields: ["type", "system.identifier", "system.level", "system.source.rules", "flags"] }).catch(() => null);
        if (!index) continue;
        for (const value of collectionValues(index)) {
          if (type === "spell" && value.type !== "spell") continue;
          if (type === "item" && !itemTypes.includes(value.type)) continue;
          if (itemType !== null && value.type !== itemType) continue;
          if (maxLevel !== null && type === "spell" && (value.system?.level ?? 99) > maxLevel) continue;
          const entryRules = value.system?.source?.rules ?? (String(packId).endsWith("24") ? "2024" : "2014");
          if (rules !== null && entryRules !== rules) continue;
          if (names === null && query && !String(value.name ?? "").toLocaleLowerCase().includes(query)
            && !(identifierQuery && String(value.system?.identifier ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").includes(identifierQuery))) continue;
          const id = value._id ?? value.id;
          const uuid = "Compendium." + packId + ".Item." + id;
          const key = entryRules + ":" + (value.system?.identifier ?? uuid);
          if (preferExistingRow(byKey.get(key))) continue;
          let eligibility;
          if (type === "spell" && classIdentifier) {
            // spellClasses 模块注解缺失（降级声明）——registry 标识符集合为准
            const onList = spellListIdentifiers?.has?.(value.system?.identifier);
            eligibility = onList ? "legal" : "name-match";
          }
          byKey.set(key, { uuid, name: value.name, identifier: value.system?.identifier ?? null,
            type: value.type ?? null, level: value.system?.level ?? null,
            packId, entryId: id, ...(eligibility ? { eligibility } : {}) });
        }
      }
      const matches = [...byKey.values()];
      matches.sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || String(a.name).localeCompare(String(b.name)));
      if (names !== null) {
        const resolutions = names.map((raw) => {
          const nameQuery = raw.trim().toLocaleLowerCase();
          const nameIdentifier = nameQuery.replace(/[^\p{L}\p{N}]+/gu, "");
          const hits = matches.filter((row) => String(row.name ?? "").toLocaleLowerCase().includes(nameQuery)
            || (nameIdentifier && String(row.identifier ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").includes(nameIdentifier)));
          const exact = (row) => (String(row.name ?? "").toLocaleLowerCase() === nameQuery
            || String(row.identifier ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === nameIdentifier) ? 0 : 1;
          hits.sort((a, b) => exact(a) - exact(b));
          return { query: raw, status: hits.length === 0 ? "miss" : hits.length === 1 ? "unique" : "ambiguous",
            total: hits.length, candidates: hits.slice(0, 10) };
        });
        return { status: "completed", resolutions, total: resolutions.length, warnings: ["spellClasses-annotation-absent:eligency-by-registry-fallback"] };
      }
      const total = matches.length, start = (page - 1) * pageSize;
      return { status: "completed", candidates: matches.slice(start, start + pageSize), total, page,
        nextPage: start + pageSize < total ? page + 1 : null,
        warnings: type === "spell" ? ["spellClasses-annotation-absent:eligibility-by-registry-fallback"] : [] };
    }
    async function contentListCatalog(input, type) {
      if (input.names !== undefined) throw new Error("INPUT_INVALID: names mode resolves spell/item candidates; class/subclass/race catalogs fit on one page");
      const rules = input.rules === undefined ? null : String(input.rules);
      if (rules !== null && !["2014", "2024"].includes(rules)) throw new Error("INPUT_INVALID: rules must be 2014 or 2024");
      let classIdentifier = null;
      if (type === "subclass" && input.classUuid !== undefined) {
        // shim 的 fromUuid 对 Compendium 返回纯数据对象（无 documentName）——以 type 判定
        const classSource = await g.fromUuid(input.classUuid).catch(() => null);
        if (!classSource || classSource.type !== "class" || !isCompendiumUuid(input.classUuid)) {
          throw new Error("SOURCE_NOT_FOUND: exact compendium class required");
        }
        classIdentifier = classSource.system?.identifier ?? null;
      }
      const byIdentifier = new Map();
      for (const pack of collectionValues(game.packs)) {
        if (pack?.metadata?.type !== "Item") continue;
        const packId = packIdOf(pack);
        const index = await pack.getIndex({ fields: ["type", "system.identifier", "system.classIdentifier", "system.source.rules"] });
        for (const entry of collectionValues(index)) {
          if (entry.type !== type) continue;
          const entryRules = entry.system?.source?.rules ?? (String(packId).endsWith("24") ? "2024" : "2014");
          if (rules !== null && entryRules !== rules) continue;
          if (classIdentifier !== null && entry.system?.classIdentifier !== classIdentifier) continue;
          const record = { uuid: "Compendium." + packId + ".Item." + (entry._id ?? entry.id), name: entry.name,
            identifier: entry.system?.identifier ?? null, packId, rules: entryRules,
            ...(entry.system?.classIdentifier ? { classIdentifier: entry.system.classIdentifier } : {}) };
          const key = entryRules + ":" + (record.identifier ?? record.uuid);
          if (preferExistingRow(byIdentifier.get(key))) continue;
          byIdentifier.set(key, record);
        }
      }
      const candidates = [...byIdentifier.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { status: "completed", candidates, total: candidates.length, warnings: [] };
    }
    function isCompendiumUuid(uuid) {
      return typeof uuid === "string" && uuid.startsWith("Compendium.");
    }
    async function compendiumBrowseData(input) {
      try {
        if (input?.world !== undefined) prepWorld(input.world);
        if (input?.scope !== "compendium") throw new Error("INPUT_INVALID: compendium browse required");
        // uuids 模式：全量文档（语义选择/对账专用；shim 的 fromUuid 对 Compendium 返回纯数据
        // 对象——pack/uuid 字段从入参推导补齐）
        if (input.uuids !== undefined) {
          if (!Array.isArray(input.uuids) || !input.uuids.length || input.uuids.length > 20
            || input.uuids.some((u) => typeof u !== "string" || !isCompendiumUuid(u))) {
            throw new Error("INPUT_INVALID: uuids must be 1..20 Compendium document UUIDs");
          }
          const documents = [];
          for (const uuid of input.uuids) {
            const doc = await g.fromUuid(uuid);
            if (!doc) throw new Error("SOURCE_NOT_FOUND: exact compendium document required: " + uuid);
            const parts = String(uuid).split(".");
            const packId = typeof doc.pack === "string" ? doc.pack : parts[1] + "." + parts[2];
            const system = doc.system ?? {};
            documents.push({ uuid, name: doc.name, type: doc.type ?? doc.documentName ?? null, packId,
              summary: { identifier: system.identifier ?? null, level: system.level ?? null,
                ...(system.classIdentifier ? { classIdentifier: system.classIdentifier } : {}) },
              document: typeof doc.toObject === "function" ? doc.toObject() : JSON.parse(JSON.stringify(doc)) });
          }
          return { status: "completed", documents, total: documents.length, warnings: [] };
        }
        const type = String(input?.type ?? "");
        const known = ["spell", "item", "class", "subclass", "race"];
        if (!known.includes(type)) throw new Error("INPUT_INVALID: browse type " + known.join("/") + " required");
        return ["class", "subclass", "race"].includes(type) ? await contentListCatalog(input, type) : await contentListCandidates(input, type);
      } catch (error) {
        return { status: "rejected", code: String(error?.message ?? error).split(":")[0], message: String(error?.message ?? error) };
      }
    }

    // =========================================================================
    // worldInfo / doctor（M2：modules 形状对齐 az——Record<string, boolean> + moduleVersions）
    // =========================================================================
    const world = { id: game.world?.id ?? null, title: game.world?.title ?? null };
    const system = {
      id: game.system?.id ?? null,
      title: game.system?.title ?? game.system?.id ?? null,
      version: game.system?.version ?? null,
    };
    const user = { id: game.user?.id ?? null, name: game.user?.name ?? null, isGM: !!game.user?.isGM };
    const moduleList = [];
    const modules = {};
    const moduleVersions = {};
    try {
      for (const m of collectionValues(game.modules)) {
        if (!m?.id) continue;
        modules[m.id] = m.active !== false;
        moduleVersions[m.id] = m.version ?? null;
        moduleList.push({ id: m.id, version: m.version ?? null, active: m.active !== false });
      }
    } catch { /* 模块集合形态异常按空集上报，不阻断只读 action */ }
    // capabilities：az WorldInfo 契约 8 键（summonPlacement 恒 false——AUTO-001 边界）
    const capabilities = {
      nativeActionEntryAvailable: typeof g.MidiQOL?.completeItemUse === "function",
      narrativeSpellConsumption: system.id === "dnd5e",
      conditionSetEntryAvailable: typeof g.CONFIG?.Actor?.documentClass?.prototype?.toggleStatusEffect === "function",
      prepActorDocuments: typeof g.CONFIG?.Actor?.documentClass?.create === "function",
      prepSceneDocuments: typeof g.CONFIG?.Scene?.documentClass?.create === "function",
      imageUploadEntryAvailable: typeof g.FilePicker !== "undefined" && typeof g.FilePicker?.upload === "function",
      summonPlacement: false,
      summonDependency: "AUTO-001",
    };
    const shim = {
      midiQOL: capabilities.nativeActionEntryAvailable,
      dae: !!g.DAE,
      socketlib: !!g.socketlib,
      canvasSurface: !!g.__MT_CANVAS_SEMANTICS__,
      combatSurface: !!g.__MT_COMBAT__,
      worldReady: !!g.__MT_READY__,
    };
    const page = { path: g.location?.pathname ?? null };

    if (action === "doctor") {
      return {
        runtime: RUNTIME_META,
        world, system, user,
        modules: moduleList,
        moduleVersions,
        versions: {
          system: system.version,
          shim: game.version ?? null,
          foundryRelease: game.release?.version ?? null,
          modules: moduleVersions,
        },
        presence: {
          midiQOL: shim.midiQOL,
          canvasSurface: shim.canvasSurface,
          canvasRendered: !!g.__MT_CANVAS_RENDER__,
          combatSurface: shim.combatSurface,
          activeCombat: !!game.combat,
          directories: !!g.document?.getElementById?.("app-dirs"),
        },
        ready: { gameReady: !!game.ready, worldReady: shim.worldReady },
        page,
      };
    }

    if (action === "worldInfo") {
      return { runtime: RUNTIME_META, world, system, user, ready: !!game.ready,
        modules, moduleVersions, moduleList, capabilities, shim, page };
    }

    if (action === "staticContext") return playReadContext(true);
    if (action === "playContext") return playReadContext(false);
    if (action === "battleContext") return battleContextDataV2();
    if (action === "turnContext") return turnContextDataV2();
    if (action === "actorRead") return await actorReadData(args);
    if (action === "sceneRead") return await sceneReadData(args);
    if (action === "contentSearch") return await contentSearchData(args);
    return await compendiumBrowseData(args);
  })
