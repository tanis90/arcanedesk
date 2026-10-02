// mt-agent-runtime v0.5.0
(async (action, args, options) => {
    // 握手常量（内联，勿引用模块作用域；与文件头 RUNTIME 保持同步）
    const RUNTIME_META = { name: "mt-agent-runtime", version: "0.5.0", protocolVersion: 2 };
    const g = globalThis;

    if (typeof action !== "string" || !action) {
      throw new Error("INVALID_ACTION: action must be a non-empty string");
    }
    if (!["worldInfo", "doctor", "staticContext", "playContext", "battleContext", "turnContext",
      "actorRead", "sceneRead", "contentSearch", "compendiumBrowse",
      "actorCreate", "actorEdit", "actorGrantItems", "sceneApply", "imageApply", "conditionsSet",
      "executeTurn", "executeAction"].includes(action)) {
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
    // availability/block 词汇：az isActionAvailableV2/actionBlockV2 移植（arcane flags 纯
    // 数据面；本桌无作者 → 恒默认值，见文件头降级声明）
    const executableActionCandidatesV2 = function executableActionCandidatesV2(actor) {
      return collectActionCandidatesV2(actor).filter((candidate) =>
        isAgentCallableActionV2(candidate.item, candidate.activity)
        && isActionAvailableV2(actor, candidate.activity)
        && !actionBlockV2(actor, candidate.item, candidate.activity));
    };
    function playActiveBuffRiderIds(actor) {
      const moduleId = "arcane-dnd5e-2014-automation";
      const activeArtifacts = new Set(collectionValues(actor?.effects).filter((effect) => effect?.disabled !== true)
        .flatMap((effect) => collectionValues(effect.flags?.[moduleId]?.compilerArtifactIds)));
      return [...new Set(collectionValues(actor?.items).filter((item) => item?.type === "spell")
        .filter((item) => activeArtifacts.has(item.flags?.[moduleId]?.declaredActiveBuff?.requiredArtifactId))
        .map((item) => cleanText(item.flags?.[moduleId]?.declaredActiveBuff?.identifier ?? item.system?.identifier)).filter(Boolean))];
    }
    function concentrationNameV2(actor) {
      // M4 起读真 effects（statuses 派生集）；无专注效果时 null
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
    function actionDefinitionV2(actor, entry, includeInactiveBuffs = false) {
      // az 第 3 参 includeInactiveBuffs：static 手册（heavy）传 true——把未激活的 buff 骑手
      // 也列进 declaredRiders（带 requiresArtifactId 供 DM 预判）；执行路径不传（只认已激活）
      const declaredRiders = declaredRiderOptionsV2(actor, entry, includeInactiveBuffs);
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
        ...(declaredRiders.length ? { declaredRiders } : {}),
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
    // 叙事法术槽位（az playNarrativeCost：M5 起经 resolveNativeSpellSlotConsumption——
    // CONFIG.DND5E.spellcasting 键位优先，缺席回退单职业直读，见文件头）
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
      const method = spellMethodOf(item);
      if (!method || !["spell", "pact", "atwill"].includes(method)) throw new Error("Unknown spell resource method");
      const consumes = activity?.consumption?.spellSlot ?? (level > 0 && method !== "atwill");
      if (!consumes || level === 0) {
        if (spellLevel !== undefined) throw new Error("No spell slot to upcast");
        return null;
      }
      const slot = resolveNativeSpellSlotConsumption(item, { consumption: { spellSlot: true } }, actor,
        g.CONFIG?.DND5E?.spellcasting, spellLevel);
      if (!slot || !Number.isFinite(slot.value) || !Number.isFinite(slot.max)) throw new Error("Unknown spell slot pool");
      return slot;
    }
    // 动作手册：activity 目录 + 无 activity 法术的叙事条目（az playTokenActions 语义）。
    // M5：activity 条目加 az 的 isAgentCallableActionV2 契约过滤（unsupported 契约不入册，
    // 与 availableActionIds/executeTurn 寻址同一空间）；heavy 手册带未激活 buff 骑手词汇
    function playTokenActions(doc) {
      const actor = doc.actor;
      if (!actor) return [];
      const definitions = [];
      for (const entry of tokenActionEntries(doc)) {
        if (!entry.activityId || entry.inputContract?.supported !== true) continue;
        const item = findItem(actor, entry.itemId);
        const activity = item ? findActivity(item, entry.activityId) : null;
        if (!item || !activity || !isAgentCallableActionV2(item, activity)) continue;
        if (!playTimingSupported(item, activity)) continue;
        const definition = actionDefinitionV2(actor, entry, true);
        const problem = actionConfigProblemV2(item, activity);
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
    // sceneWhenIdle：无战斗分支口径。读面（playContext/staticContext）保持 M2 目标集口径
    // （空焦点合法）；写面（K5 conditionsSet）传 true——az 原版无战斗焦点=全场景 token，
    // combat 模式的焦点守卫在无战斗时以场景为单位，否则空目标集会拒绝一切写入。
    function playFocus(sceneWhenIdle = false) {
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
        tokens = sceneWhenIdle ? collectionValues(scene?.tokens)
          : [...setValues(game.user?.targets), ...collectionValues(g.canvas?.tokens?.controlled)]
            .map(tokenDocument).filter(Boolean);
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
        : ["activeBuffRiderIds:pre-M4"];
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
          activeBuffRiderIds: actor ? playActiveBuffRiderIds(actor) : [] };
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
            if (!item || !entryActivity || !isAgentCallableActionV2(item, entryActivity)) return null;
            const configProblem = actionConfigProblemV2(item, entryActivity);
            if (configProblem) definition.warnings = [configProblem];
            return definition;
          }).filter(Boolean),
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
      };
    }

    // =========================================================================
    // prep 投影（actorRead / sceneRead；readState 指纹是 M3 写守卫的输入）
    // =========================================================================
    // az loopbackOrigin：loopback 等价拼写（localhost/127.0.0.1/[::1] 同协议同端口）归一为
    // 127.0.0.1 再比较——形似主机名（localhost.evil.example）被 $ 锚拒绝（K5 移植，M3 全部
    // 写 action 的世界守卫同步受益）
    function loopbackOrigin(origin) {
      if (typeof origin !== "string") return origin;
      const match = origin.match(/^(https?:\/\/)(?:localhost|127[.]0[.]0[.]1|\[::1])(:[0-9]+)?$/i);
      return match ? match[1] + "127.0.0.1" + (match[2] ?? "") : origin;
    }
    function prepWorld(world) {
      if (!world || loopbackOrigin(world.origin) !== loopbackOrigin(g.location?.origin ?? null) || world.id !== (game.world?.id ?? null)) {
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
    // M3 写集 A（J4–J7）+ 写安全脚手架（J8）。四态回执（az contracts.ts:629-632）：
    //   rejected  {status, code, message}             —— 开写前守卫失败
    //   completed {status, steps, verification, warnings}
    //   partial / indeterminate {status, retry:false, steps, message}
    // 写 ack = shim 的 doc.create/update/createEmbeddedDocuments 等 promise（hub.invoke
    // 应答即服务端已收）；随后 az 同款读回复核：逐步比对实际值，落定才 completed。
    // 各 action 自捕获异常转回执（az actorEditData/sceneApplyData 同款，不向宿主抛）。
    // =========================================================================
    function writeErrorMessage(error) {
      return String(error?.message ?? error);
    }
    function writeReject(error) {
      return { status: "rejected", code: writeErrorMessage(error).split(":")[0], message: writeErrorMessage(error) };
    }
    function writeInputGuard(input, action) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("INPUT_INVALID: " + action + " arguments required");
      }
    }
    // az prepObject：写集入参字段白名单（未知字段拒绝）
    function writePrepObject(value, keys) {
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !keys.includes(key))) {
        throw new Error("INPUT_INVALID: unsupported fields");
      }
      return value;
    }
    const WRITE_ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];
    function prepAbilityScores(value) {
      const abilities = writePrepObject(value, WRITE_ABILITY_KEYS);
      for (const score of Object.values(abilities)) {
        if (!Number.isInteger(score) || score < 1 || score > 20) {
          throw new Error("INPUT_INVALID: ability scores are integers 1..20");
        }
      }
      return abilities;
    }
    // az prepDataImage + prepPrepareImage 的 dataPath-only 子集：真字节上传依赖
    // FilePicker.upload（shim 桩无此面）——带 upload 即 CAPABILITY_UNAVAILABLE（M6 边界）
    function prepDataImage(image) {
      writePrepObject(image, ["dataPath", "syncPlacedTokens", "upload"]);
      const dataPath = image.dataPath;
      if (typeof dataPath !== "string" || !dataPath.trim() || dataPath.length > 512 || dataPath.includes("..")) {
        throw new Error("INPUT_INVALID: image dataPath required");
      }
      return dataPath.trim();
    }
    async function prepPrepareImage(image) {
      const dataPath = prepDataImage(image);
      if (image.upload && typeof g.FilePicker?.upload !== "function") {
        throw new Error("CAPABILITY_UNAVAILABLE: image upload requires FilePicker.upload (dataPath only in this shim)");
      }
      return { dataPath };
    }
    // az prepImagePatch：token 图像字段（ring 启用时同步 subject 贴图）
    function prepImagePatch(token, img, prefix = "") {
      return { [prefix + "texture.src"]: img,
        ...(token?.ring?.enabled ? { [prefix + "ring.subject.texture"]: img } : {}) };
    }
    // az prepCheckRead：actorEdit/actorGrantItems 的 readState 守卫。身份缺失/不符 →
    // READ_REF_INVALID（宿主 foundry-services.js:88 同码预检）；受影响字段漂移 →
    // READ_REF_STALE。此处 throw，由各 action 统一转 rejected 回执。
    function prepCheckRead(actor, state, keys) {
      if (!state || state.actorUuid !== actor.uuid) throw new Error("READ_REF_INVALID: read this Actor first");
      prepWorld(state.world);
      const current = prepActorFields(actor, state.include);
      for (const key of keys) {
        if (!(key in state.fields) || JSON.stringify(state.fields[key]) !== JSON.stringify(current[key])) {
          throw new Error("READ_REF_STALE: reread affected field " + key);
        }
      }
    }
    // az prepCheckSceneRead：sceneApply(update) 的场景字段 + token 成员/指纹守卫
    function prepCheckSceneRead(scene, state, keys, layout) {
      if (!state || state.sceneUuid !== scene.uuid) throw new Error("READ_REF_INVALID: read this Scene first");
      prepWorld(state.world);
      const fields = prepSceneFields(scene);
      for (const key of keys) {
        if (!(key in state.fields) || JSON.stringify(state.fields[key]) !== JSON.stringify(fields[key])) {
          throw new Error("READ_REF_STALE: Scene field changed " + key);
        }
      }
      if ((layout.update.length || layout.deleteIds.length) && !state.tokens) {
        throw new Error("READ_REF_INVALID: read tokens before editing or deleting them");
      }
      for (const entry of layout.update) {
        const before = state.tokens?.find((token) => token.id === entry.tokenId);
        const token = scene.tokens?.get?.(entry.tokenId);
        if (!before || !token) throw new Error("READ_REF_STALE: Token membership changed");
        const now = prepPlacementFields(token);
        for (const key of Object.keys(entry.changes)) {
          if (JSON.stringify(before.fields[key]) !== JSON.stringify(now[key])) {
            throw new Error("READ_REF_STALE: Token field changed " + key);
          }
        }
      }
      for (const id of layout.deleteIds) {
        const before = state.tokens?.find((token) => token.id === id);
        const token = scene.tokens?.get?.(id);
        if (!before || !token || before.fingerprint !== prepSceneTokenState(token).fingerprint) {
          throw new Error("READ_REF_STALE: Token to delete changed");
        }
      }
    }
    // az compendiumDocument 的 shim 适配：pack.getDocument 返回纯数据对象（无
    // documentName 静态面）——文档类型以 pack 元数据 type 判定
    async function compendiumWriteDocument(packId, entryId, documentName) {
      const pack = game.packs?.get?.(cleanText(packId));
      if (!pack) throw new Error("PACK_NOT_FOUND: compendium pack not found: " + packId);
      const document = await pack.getDocument(cleanText(entryId));
      if (!document) throw new Error("SOURCE_NOT_FOUND: compendium entry not found: " + packId + "/" + entryId);
      if ((document.documentName ?? pack.metadata?.type ?? pack.documentName) !== documentName) {
        throw new Error("SOURCE_MISMATCH: " + documentName + " source required");
      }
      return document;
    }
    function writePlainData(source) {
      return typeof source?.toObject === "function" ? source.toObject() : JSON.parse(JSON.stringify(source));
    }
    // az prepPrepareGrants：CompendiumGrant[] → 待授予计划（期望名/型漂移守卫 + 批内去重）
    async function prepPrepareGrants(entries) {
      if (!Array.isArray(entries) || entries.length > 50) throw new Error("INPUT_INVALID: at most 50 grants");
      const plans = [];
      for (const entry of entries) {
        writePrepObject(entry, ["uuid", "packId", "entryId", "expectedName", "expectedType", "quantity", "equipped"]);
        if ((entry.uuid && (entry.packId || entry.entryId)) || (!entry.uuid && (!entry.packId || !entry.entryId))) {
          throw new Error("INPUT_INVALID: supply uuid or packId+entryId");
        }
        let source, sourceUuid, sourceName = null, sourceType = null;
        if (entry.uuid) {
          source = await g.fromUuid(entry.uuid);
          if (!source) throw new Error("SOURCE_NOT_FOUND: compendium Item not found: " + entry.uuid);
          // shim fromUuid 对 Compendium 返回纯数据（无 documentName）——按 uuid 文档段判型
          const isItem = source.documentName === "Item"
            || (source.documentName == null && String(entry.uuid).split(".")[3] === "Item");
          if (!isItem) throw new Error("SOURCE_MISMATCH: not an Item (" + entry.uuid + ")");
          sourceUuid = entry.uuid;
        } else {
          source = await compendiumWriteDocument(entry.packId, entry.entryId, "Item");
          sourceUuid = "Compendium." + cleanText(entry.packId) + ".Item." + cleanText(entry.entryId);
        }
        sourceName = source.name;
        sourceType = source.type;
        if (entry.expectedName && entry.expectedName !== source.name) {
          throw new Error("SOURCE_MISMATCH: expectedName " + JSON.stringify(entry.expectedName)
            + " but " + sourceUuid + " is " + JSON.stringify(source.name));
        }
        if (entry.expectedType && entry.expectedType !== source.type) {
          throw new Error("SOURCE_MISMATCH: expectedType " + JSON.stringify(entry.expectedType)
            + " but " + sourceUuid + " is " + JSON.stringify(source.type));
        }
        if (plans.some((plan) => plan.sourceUuid === sourceUuid)) continue;
        const data = writePlainData(source);
        delete data._id; delete data.folder;
        if (entry.quantity !== undefined) {
          if (!Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 999
            || !data.system || !("quantity" in data.system)) throw new Error("INPUT_INVALID: unsupported quantity");
          data.system.quantity = entry.quantity;
        }
        if (entry.equipped !== undefined) {
          if (typeof entry.equipped !== "boolean" || !data.system || !("equipped" in data.system)) {
            throw new Error("INPUT_INVALID: unsupported equipped state");
          }
          data.system.equipped = entry.equipped;
        }
        data.flags ??= {};
        data.flags.arcanedesk = { ...data.flags.arcanedesk, sourceUuid };
        data.flags.dnd5e = { ...data.flags.dnd5e, sourceId: sourceUuid };
        plans.push({ sourceUuid, sourceName, sourceType, data });
      }
      return plans;
    }
    // 授予源身份匹配：sourceUuid 优先；item flags 在 shim 的 REST 信封序列化面
    // （#persistEmbedded）与广播回声重建（rebuildEmbeddedCollection）中丢失时，退化为
    // 名称+类型匹配（会话内去重口径；同名异源物品会被误判已授——见文件头降级声明，
    // 信封携带 item flags 后恢复 az 精确语义）
    function grantMatchesPlan(item, plan) {
      return item.sourceUuid === plan.sourceUuid
        || (item.sourceUuid == null && item.name === plan.sourceName && item.type === plan.sourceType);
    }
    // az prepApplyGrants：按源身份去重后创建嵌入 Item（requestId 幂等标记随授）
    async function prepApplyGrants(actor, plans, requestId) {
      const existing = collectionValues(actor.items).map(prepItemIdentity), skippedExisting = [], pending = [];
      for (const plan of plans) {
        const prior = existing.filter((item) => grantMatchesPlan(item, plan));
        if (prior.length) skippedExisting.push(...prior);
        else { plan.data.flags.arcanedesk.requestId = requestId; pending.push(plan); }
      }
      const created = pending.length ? await actor.createEmbeddedDocuments("Item", pending.map((plan) => plan.data)) : [];
      return { created: collectionValues(created).map(prepItemIdentity), skippedExisting, expected: pending.length };
    }
    function prepImageTargets(actor, state) {
      if (!state?.include?.includes("sceneTokens") || !Array.isArray(state.sceneTokens)) {
        throw new Error("READ_REF_INVALID: read sceneTokens before synchronizing placed images");
      }
      const current = prepSceneTokens(actor);
      const shape = (values) => values
        .map((token) => ({ uuid: token.uuid, actorUuid: token.actorUuid, actorLink: token.actorLink, image: token.image }))
        .sort((a, b) => a.uuid.localeCompare(b.uuid));
      if (JSON.stringify(shape(current)) !== JSON.stringify(shape(state.sceneTokens))) {
        throw new Error("READ_REF_STALE: placed Token image or membership changed");
      }
      return collectionValues(game.scenes).flatMap((scene) => collectionValues(scene.tokens))
        .filter((token) => current.some((entry) => entry.uuid === token.uuid))
        .map((token) => ({ token, before: prepTokenImageFields(token), actorId: token.actorId, actorLink: token.actorLink }));
    }
    // az prepSyncTokenImages 的 shim 适配：嵌入 token 的 update() 不落库——经父场景
    // updateEmbeddedDocuments 持久化（REST 信封 + 广播）
    async function prepSyncTokenImages(tokens, img, world, steps) {
      for (const planned of tokens) {
        const { token } = planned;
        const step = { step: "token-image", targets: [token.uuid], state: "not-started" };
        steps.push(step);
        try {
          prepWorld(world);
          const present = collectionValues(game.scenes).some((scene) => collectionValues(scene.tokens).includes(token));
          if (!present || token.actorId !== planned.actorId || token.actorLink !== planned.actorLink
            || JSON.stringify(prepTokenImageFields(token)) !== JSON.stringify(planned.before)) {
            throw new Error("READ_REF_STALE: Token changed before synchronization");
          }
          const patch = prepImagePatch(token, img);
          step.state = "unknown";
          const scene = token.parent ?? token.scene;
          if (scene?.updateEmbeddedDocuments) await scene.updateEmbeddedDocuments("Token", [{ _id: token.id, ...patch }]);
          else await token.update({ ...patch });
          const actual = prepTokenImageFields(token);
          if (Object.entries(patch).every(([key, value]) => actual[key] === value)) step.state = "completed";
        } catch (error) { step.message = writeErrorMessage(error); break; }
      }
      const reported = new Set(steps.filter((step) => step.step === "token-image").flatMap((step) => step.targets));
      for (const { token } of tokens) {
        if (!reported.has(token.uuid)) steps.push({ step: "token-image", targets: [token.uuid], state: "not-started" });
      }
    }

    // —— J4 actorCreate（az actorCreateData；blank | compendium 源 + abilities +
    //    initialItems + dataPath 图像 + 幂等恢复 + 重名守卫）——
    async function actorCreateData(input) {
      let started = false, createdActor = null;
      const steps = [], warnings = [];
      try {
        writeInputGuard(input, "actorCreate");
        prepWorld(input.world);
        if (!input.requestId || typeof input.name !== "string" || !input.name.trim() || input.name.length > 256) {
          throw new Error("INPUT_INVALID: name and request identity required");
        }
        const prototypeName = input.prototypeToken === undefined ? undefined
          : writePrepObject(input.prototypeToken, ["name"]).name;
        if (input.prototypeToken !== undefined
          && (typeof prototypeName !== "string" || !prototypeName.trim() || prototypeName.length > 256)) {
          throw new Error("INPUT_INVALID: prototype Token name required");
        }
        // 降级：无 folder 语义——非空 folderId 记 warning 跳过（az prepFolder 校验后写入）
        if (input.folderId != null) warnings.push("folders-absent:folderId-ignored");
        let data, sourceUuid = null;
        if (input.source?.kind === "blank" && ["character", "npc"].includes(input.source.actorType)) {
          data = { type: input.source.actorType };
        } else if (input.source?.kind === "compendium") {
          const source = await compendiumWriteDocument(input.source.packId, input.source.entryId, "Actor");
          data = writePlainData(source);
          delete data._id; delete data.folder;
          sourceUuid = "Compendium." + cleanText(input.source.packId) + ".Actor." + cleanText(input.source.entryId);
        } else throw new Error("INPUT_INVALID: Actor source required");
        // 基础能力随创建落位（az 注释：种族/ASI 增量叠加在基础值上）
        const abilityScores = input.dnd5e === undefined ? null
          : prepAbilityScores(writePrepObject(input.dnd5e, ["abilities"]).abilities ?? {});
        if (abilityScores && Object.keys(abilityScores).length) {
          data.system ??= {};
          const abilities = data.system.abilities ?? {};
          for (const [key, score] of Object.entries(abilityScores)) {
            abilities[key] = { ...(abilities[key] ?? {}), value: score };
          }
          data.system.abilities = abilities;
        }
        const plans = await prepPrepareGrants(input.initialItems ?? []);
        const preparedImage = input.image ? await prepPrepareImage(input.image) : null;
        const imagePath = preparedImage?.dataPath ?? null;
        prepWorld(input.world);
        // 幂等恢复：同 requestId 的 Actor 已在世 → completed 引用返回（宿主 operationStore
        // 重放回放原回执；无宿主的页内口径，见文件头偏差声明）
        const recovered = collectionValues(game.actors)
          .find((actor) => actor.flags?.arcanedesk?.requestId === input.requestId);
        if (recovered) return {
          status: "completed",
          steps: [{ step: "create-actor", state: "completed", targets: [recovered.uuid], recovered: true }],
          verification: [{ actorUuid: recovered.uuid, name: recovered.name, type: recovered.type, recovered: true }],
          warnings: [...warnings, "requestId-replay:recovered-existing-actor"],
        };
        const collisions = collectionValues(game.actors).filter((actor) => actor.name === input.name);
        if (collisions.length) return {
          status: "rejected", code: "NAME_COLLISION", message: "Actor name already exists",
          candidates: collisions.slice(0, 5).map((actor) => ({ uuid: actor.uuid, name: actor.name, type: actor.type })),
        };
        data.name = input.name;
        if (prototypeName !== undefined) data.prototypeToken = { ...data.prototypeToken, name: prototypeName };
        data.flags ??= {};
        data.flags.arcanedesk = { ...data.flags.arcanedesk, requestId: input.requestId, ...(sourceUuid ? { sourceUuid } : {}) };
        started = true;
        createdActor = await (g.CONFIG?.Actor?.documentClass ?? g.Actor).create(data, { renderSheet: false });
        if (!createdActor?.uuid) throw new Error("Actor creation was not confirmed");
        steps.push({ step: "create-actor", state: "completed", targets: [createdActor.uuid], name: createdActor.name });
        // shim 适配：create 载荷的 prototypeToken 被数据模型快照丢弃（活实例为合成
        // getter）——经 update 点路径补写（REST 落库 + toObject 可见）；az 为一次性载荷
        if (prototypeName !== undefined) {
          await createdActor.update({ "prototypeToken.name": prototypeName });
          const confirmed = createdActor.toObject?.().prototypeToken?.name === prototypeName;
          steps.push({ step: "prototypeToken.name", targets: [createdActor.uuid], state: confirmed ? "completed" : "unknown" });
          if (!confirmed) return { status: "partial", retry: false, steps, message: "Actor created; prototype Token name was not confirmed" };
        }
        if (imagePath) {
          prepWorld(input.world);
          const patch = { img: imagePath, ...prepImagePatch(createdActor.prototypeToken, imagePath, "prototypeToken.") };
          await createdActor.update({ ...patch });
          // 验证以持久化源为准（prototypeToken 活实例是合成 getter，见文件头降级）
          const persistedToken = createdActor.toObject?.().prototypeToken ?? {};
          const confirmed = createdActor.img === imagePath && (!("prototypeToken.texture.src" in patch) || persistedToken.texture?.src === imagePath);
          steps.push({ step: "actor-image", targets: [createdActor.uuid], state: confirmed ? "completed" : "unknown", dataPath: imagePath });
          if (!confirmed) return { status: "partial", retry: false, steps, message: "Actor created; image update was not confirmed" };
        }
        if (plans.length) {
          const result = await prepApplyGrants(createdActor, plans, input.requestId);
          steps.push({ step: "grant-items",
            state: result.created.length === result.expected ? "completed" : "unknown",
            targets: [createdActor.uuid], created: result.created, skippedExisting: result.skippedExisting });
          if (result.created.length !== result.expected) {
            return { status: "partial", retry: false, steps, message: "Actor created; some initial Items were not confirmed" };
          }
        }
        return {
          status: "completed", steps, warnings,
          verification: [{
            actorUuid: createdActor.uuid, name: createdActor.name, type: createdActor.type,
            ...(prototypeName !== undefined
              ? { prototypeToken: { name: createdActor.toObject?.().prototypeToken?.name ?? null } } : {}),
            ...(abilityScores && Object.keys(abilityScores).length ? { abilities: abilityScores } : {}),
          }],
        };
      } catch (error) {
        return started
          ? { status: createdActor || steps.some((step) => step.state === "completed") ? "partial" : "indeterminate",
              retry: false, steps, message: writeErrorMessage(error) }
          : writeReject(error);
      }
    }

    // —— J5 actorEdit（az actorEditData；有界变更 + readState 守卫 + 读回复核）——
    async function actorEditData(input) {
      let started = false;
      const steps = [], warnings = [];
      try {
        writeInputGuard(input, "actorEdit");
        prepWorld(input.world);
        const actor = await prepActor(input.actorUuid);
        const changes = writePrepObject(input.changes, ["name", "folderId", "prototypeToken", "dnd5e", "image"]);
        const patch = {};
        let imageTargets = [], imagePath = null;
        if (changes.image) {
          const preparedImage = await prepPrepareImage(changes.image);
          imagePath = preparedImage.dataPath;
          Object.assign(patch, { img: imagePath }, prepImagePatch(actor.prototypeToken, imagePath, "prototypeToken."));
          if (changes.image.syncPlacedTokens) imageTargets = prepImageTargets(actor, input.readState);
        }
        if ("name" in changes) {
          if (typeof changes.name !== "string" || !changes.name.trim() || changes.name.length > 256) {
            throw new Error("INPUT_INVALID: name required");
          }
          patch.name = changes.name;
        }
        // 降级：无 folder 语义——az 写 folder；此处记 warning 跳过（不当失败）
        if ("folderId" in changes && changes.folderId != null) warnings.push("folders-absent:folderId-ignored");
        if (changes.prototypeToken) {
          for (const [key, value] of Object.entries(writePrepObject(changes.prototypeToken, ["name", "width", "height", "disposition"]))) {
            if (key === "name" ? typeof value !== "string" || value.length > 256
              : key === "disposition" ? ![-1, 0, 1].includes(value)
              : !Number.isFinite(value) || value <= 0 || value > 100) {
              throw new Error("INPUT_INVALID: invalid prototype Token field");
            }
            patch["prototypeToken." + key] = value;
          }
        }
        if (changes.dnd5e) {
          writePrepObject(changes.dnd5e, ["hp", "ac", "abilities"]);
          if (changes.dnd5e.hp) {
            const hp = writePrepObject(changes.dnd5e.hp, ["value", "max", "temp"]);
            for (const [key, value] of Object.entries(hp)) {
              if (!Number.isFinite(value) || value < 0) throw new Error("INPUT_INVALID: invalid HP");
              patch["system.attributes.hp." + key] = value;
            }
            if ((hp.value ?? actor.system?.attributes?.hp?.value) > (hp.max ?? actor.system?.attributes?.hp?.max)) {
              throw new Error("INPUT_INVALID: HP exceeds maximum");
            }
          }
          if (changes.dnd5e.ac) {
            const ac = writePrepObject(changes.dnd5e.ac, ["flat"]);
            if (!Number.isFinite(ac.flat) || !["flat", "natural"].includes(actor.system?.attributes?.ac?.calc)) {
              throw new Error("INPUT_INVALID: Actor does not use flat AC");
            }
            patch["system.attributes.ac.flat"] = ac.flat;
          }
          if (changes.dnd5e.abilities) {
            for (const [key, score] of Object.entries(prepAbilityScores(changes.dnd5e.abilities))) {
              patch["system.abilities." + key + ".value"] = score;
            }
          }
        }
        const keys = Object.keys(patch);
        if (!keys.length) throw new Error("INPUT_INVALID: empty changes");
        prepCheckRead(actor, input.readState, [...keys,
          ...(changes.image ? ["prototypeToken.ring.enabled"] : []),
          ...(changes.dnd5e?.ac ? ["system.attributes.ac.calc"] : [])]);
        started = true;
        await actor.update({ ...patch });
        // 读回复核：prototypeToken.* 以持久化源为准（活实例是合成 getter，文件头降级）
        const after = prepActorFields(actor, input.readState?.include ?? []);
        const persistedToken = actor.toObject?.().prototypeToken ?? {};
        const dotWalk = (node, path) => String(path).split(".")
          .reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), node);
        for (const key of keys) {
          if (key.startsWith("prototypeToken.")) {
            after[key] = dotWalk(persistedToken, key.slice("prototypeToken.".length)) ?? null;
          }
        }
        for (const key of keys) {
          steps.push({ step: key, targets: [actor.uuid],
            state: JSON.stringify(after[key]) === JSON.stringify(patch[key]) ? "completed" : "unknown",
            before: input.readState?.fields?.[key], after: after[key] });
        }
        if (imagePath && imageTargets.length) await prepSyncTokenImages(imageTargets, imagePath, input.world, steps);
        return steps.every((step) => step.state === "completed")
          ? { status: "completed", steps, verification: steps, warnings }
          : { status: "partial", retry: false, steps, message: "Actor update did not fully settle" };
      } catch (error) {
        return started
          ? { status: steps.some((step) => step.state === "completed") ? "partial" : "indeterminate",
              retry: false, steps, message: writeErrorMessage(error) }
          : writeReject(error);
      }
    }

    // —— J6 actorGrantItems（az actorGrantData；source 去重 + 期望漂移守卫）——
    async function actorGrantData(input) {
      let started = false;
      const steps = [];
      try {
        writeInputGuard(input, "actorGrantItems");
        prepWorld(input.world);
        const actor = await prepActor(input.actorUuid);
        if (!input.readState?.items || !input.items?.length || !input.requestId) {
          throw new Error("READ_REF_INVALID: read items before granting");
        }
        prepCheckRead(actor, input.readState, []);
        const plans = await prepPrepareGrants(input.items);
        prepWorld(input.world);
        // 只比对涉及的 source 身份（az：无关的 HP/其他物品可自由变化）
        for (const plan of plans) {
          const before = input.readState.items
            .filter((item) => grantMatchesPlan(item, plan)).map((item) => item.id).sort();
          const now = collectionValues(actor.items).map(prepItemIdentity)
            .filter((item) => grantMatchesPlan(item, plan)).map((item) => item.id).sort();
          if (JSON.stringify(before) !== JSON.stringify(now)) {
            throw new Error("READ_REF_STALE: source Item membership changed");
          }
        }
        started = true;
        const result = await prepApplyGrants(actor, plans, input.requestId);
        const actual = result.created
          .filter((item) => (actor.items?.get?.(item.id) ?? null) !== null);
        steps.push({ step: "grant-items", targets: [actor.uuid],
          state: actual.length === result.expected ? "completed" : "unknown",
          created: actual, skippedExisting: result.skippedExisting });
        return actual.length === result.expected
          ? { status: "completed", steps, verification: steps, warnings: [] }
          : { status: "partial", retry: false, steps, message: "Some Items were not confirmed" };
      } catch (error) {
        return started
          ? { status: "indeterminate", retry: false, steps, message: writeErrorMessage(error) }
          : writeReject(error);
      }
    }

    // —— J7 sceneApply（az sceneApplyData；create | update + token 增删改 + activate 收尾）——
    function expandWritePatch(patch) {
      const out = {};
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split(".");
        let node = out;
        for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] ??= {};
        node[parts[parts.length - 1]] = value;
      }
      return out;
    }
    function prepPlacementPatch(changes, create = false) {
      writePrepObject(changes, create
        ? ["actorUuid", "x", "y", "name", "hidden", "disposition", "width", "height", "elevation", "actorLink"]
        : ["x", "y", "name", "hidden", "disposition", "width", "height", "elevation"]);
      const patch = {};
      for (const [key, value] of Object.entries(changes)) {
        if (key === "actorUuid") continue;
        if (key === "name" ? typeof value !== "string" || !value.trim() || value.length > 256
          : ["hidden", "actorLink"].includes(key) ? typeof value !== "boolean"
          : key === "disposition" ? ![-1, 0, 1].includes(value)
          : !Number.isFinite(value) || (["width", "height"].includes(key) && value <= 0)) {
          throw new Error("INPUT_INVALID: invalid Token placement " + key);
        }
        patch[key] = value;
      }
      if (!Object.keys(patch).length || (create && (!Number.isFinite(changes.x) || !Number.isFinite(changes.y)))) {
        throw new Error("INPUT_INVALID: Token position or changes required");
      }
      return patch;
    }
    function prototypeFingerprintOf(actor) {
      const prototype = actor.prototypeToken ?? {};
      return fnv1a64Hex(JSON.stringify(prototype.toObject ? prototype.toObject() : prototype));
    }
    async function sceneApplyData(input) {
      let started = false, scene = null;
      const steps = [];
      try {
        writeInputGuard(input, "sceneApply");
        writePrepObject(input, ["operation", "sceneUuid", "readState", "scene", "tokens", "world", "requestId"]);
        prepWorld(input.world);
        if (!["create", "update"].includes(input.operation) || !input.requestId) {
          throw new Error("INPUT_INVALID: Scene operation and request identity required");
        }
        const create = input.operation === "create";
        const changes = writePrepObject(input.scene ?? {}, ["name", "active", "background", "width", "height", "grid"]);
        const patch = {};
        if (create && (input.sceneUuid || input.readState)) {
          throw new Error("INPUT_INVALID: create does not accept existing Scene handles");
        }
        if (!create) scene = await prepScene(input.sceneUuid);
        if (create || "name" in changes) {
          if (typeof changes.name !== "string" || !changes.name.trim() || changes.name.length > 256) {
            throw new Error("INPUT_INVALID: Scene name required");
          }
          patch.name = changes.name;
        }
        for (const key of ["width", "height"]) if (key in changes) {
          if (!Number.isInteger(changes[key]) || changes[key] <= 0) {
            throw new Error("INPUT_INVALID: Scene dimensions must be positive integers");
          }
          patch[key] = changes[key];
        }
        if ("active" in changes && typeof changes.active !== "boolean") throw new Error("INPUT_INVALID: active must be boolean");
        if (changes.active === false) patch.active = false;
        if (changes.grid) {
          for (const [key, value] of Object.entries(writePrepObject(changes.grid, ["type", "size", "distance", "units"]))) {
            if (key === "type" ? !Object.values(g.CONST?.GRID_TYPES ?? {}).includes(value)
              : key === "units" ? typeof value !== "string" || value.length > 256
              : !Number.isFinite(value) || value <= 0) {
              throw new Error("INPUT_INVALID: unsupported grid " + key);
            }
            patch["grid." + key] = value;
          }
        }
        if (changes.background) {
          const prepared = await prepPrepareImage(changes.background);
          patch["background.src"] = prepared.dataPath;
        }
        const raw = writePrepObject(input.tokens ?? {}, ["create", "update", "deleteIds"]);
        const layout = { create: raw.create ?? [], update: raw.update ?? [], deleteIds: raw.deleteIds ?? [] };
        if (Object.values(layout).some((value) => !Array.isArray(value))
          || layout.create.length + layout.update.length + layout.deleteIds.length > 100) {
          throw new Error("INPUT_INVALID: at most 100 Token operations");
        }
        if (create && (layout.update.length || layout.deleteIds.length)) {
          throw new Error("INPUT_INVALID: new Scenes have no Tokens to update/delete");
        }
        const ids = [...layout.update.map((entry) => entry?.tokenId), ...layout.deleteIds];
        if (ids.some((id) => typeof id !== "string" || !id || id.length > 256) || new Set(ids).size !== ids.length) {
          throw new Error("INPUT_INVALID: duplicate or conflicting Token IDs");
        }
        if (!create && !Object.keys(patch).length && changes.active !== true && !ids.length && !layout.create.length) {
          throw new Error("INPUT_INVALID: empty Scene changes");
        }
        const SceneClass = g.CONFIG?.Scene?.documentClass ?? g.Scene;
        // （az 在此 prepValidateDocument：native strict 校验——shim 无 validate 面，
        // 上方形状校验承担，见文件头降级声明）
        const creations = [];
        for (const entry of layout.create) {
          const placement = prepPlacementPatch(entry, true);
          const actor = await prepActor(entry.actorUuid);
          // shim 适配：无 actor.getTokenDocument——放置字段 + 演员原型直构 token 数据
          const prototype = actor.prototypeToken ?? {};
          const prototypeName = typeof prototype.name === "string" && prototype.name.trim() ? prototype.name : actor.name;
          creations.push({
            actor,
            prototypeFingerprint: prototypeFingerprintOf(actor),
            data: {
              name: placement.name ?? prototypeName,
              x: placement.x, y: placement.y,
              ...(placement.width !== undefined ? { width: placement.width } : {}),
              ...(placement.height !== undefined ? { height: placement.height } : {}),
              ...(placement.disposition !== undefined ? { disposition: placement.disposition } : {}),
              ...(placement.elevation !== undefined ? { elevation: placement.elevation } : {}),
              ...(placement.hidden !== undefined ? { hidden: placement.hidden } : {}),
              actorId: actor.id,
              actorLink: entry.actorLink === false ? false : true,
              ...(actor.img ? { texture: { src: actor.img } } : {}),
              flags: { arcanedesk: { requestId: input.requestId, sourceActorUuid: actor.uuid } },
            },
          });
        }
        const updates = [];
        for (const entry of layout.update) {
          writePrepObject(entry, ["tokenId", "changes"]);
          const token = scene.tokens?.get?.(entry.tokenId);
          if (!token) throw new Error("TOKEN_NOT_FOUND: Token not in requested Scene");
          updates.push({ _id: entry.tokenId, ...prepPlacementPatch(entry.changes) });
        }
        for (const id of layout.deleteIds) {
          if (!scene.tokens?.get?.(id)) throw new Error("TOKEN_NOT_FOUND: Token not in requested Scene");
        }
        const keys = [...Object.keys(patch), ...("active" in changes ? ["active"] : []),
          ...(layout.create.length ? ["width", "height", "grid.type", "grid.size", "grid.distance", "grid.units"] : [])];
        if (!create) prepCheckSceneRead(scene, input.readState, keys, layout);
        if (create) {
          // 幂等恢复（completed 引用返回，见文件头偏差声明）+ 重名守卫（az checkCreate）
          const recovered = collectionValues(game.scenes)
            .find((value) => value.flags?.arcanedesk?.requestId === input.requestId);
          if (recovered) return {
            status: "completed",
            steps: [{ step: "create-scene", state: "completed", targets: [recovered.uuid], recovered: true }],
            verification: [{ sceneUuid: recovered.uuid, ...prepSceneFields(recovered),
              tokenCount: collectionValues(recovered.tokens).length, recovered: true }],
            warnings: ["requestId-replay:recovered-existing-scene"],
          };
          if (collectionValues(game.scenes).some((value) => value.name === changes.name)) {
            throw new Error("NAME_COLLISION: Scene name already exists");
          }
        }
        prepWorld(input.world);
        for (const { actor, prototypeFingerprint } of creations) {
          const again = await prepActor(actor.uuid);
          if (again !== actor || prototypeFingerprintOf(again) !== prototypeFingerprint) {
            throw new Error("ACTOR_CHANGED: placement Actor or prototype changed");
          }
        }
        if (create) {
          started = true;
          const step = { step: "create-scene", targets: [], state: "unknown" };
          steps.push(step);
          scene = await SceneClass.create({ ...expandWritePatch(patch), active: false,
            flags: { arcanedesk: { requestId: input.requestId } } });
          if (!scene?.uuid) throw new Error("Scene creation not confirmed");
          step.targets = [scene.uuid];
          const actual = prepSceneFields(scene);
          if (!Object.entries(patch).every(([key, value]) => actual[key] === value)) {
            throw new Error("Scene creation metadata did not settle");
          }
          step.state = "completed";
        } else if (Object.keys(patch).length) {
          started = true;
          const step = { step: "update-scene", targets: [scene.uuid], state: "unknown" };
          steps.push(step);
          await scene.update({ ...patch });
          const actual = prepSceneFields(scene);
          const confirmed = Object.entries(patch).every(([key, value]) => actual[key] === value);
          step.state = confirmed ? "completed" : "unknown";
          if (!confirmed) throw new Error("Scene metadata did not settle");
        }
        if (creations.length) {
          prepWorld(input.world); started = true;
          const step = { step: "create-tokens", targets: [scene.uuid], state: "unknown", count: creations.length };
          steps.push(step);
          const documents = await scene.createEmbeddedDocuments("Token", creations.map((entry) => entry.data));
          const created = collectionValues(documents);
          const confirmed = created.length === creations.length
            && new Set(created.map((token) => token.id)).size === created.length
            && created.every((token) => token.flags?.arcanedesk?.requestId === input.requestId)
            && creations.every((entry, index) => !!created[index] && Object.entries(entry.data)
              .every(([key, value]) => key === "flags" || JSON.stringify(created[index][key] ?? null) === JSON.stringify(value ?? null)));
          step.targets = created.map((token) => token.uuid);
          step.state = confirmed ? "completed" : "unknown";
          if (!confirmed) throw new Error("Token creation did not settle");
        }
        if (updates.length) {
          prepWorld(input.world);
          prepCheckSceneRead(scene, input.readState, [], { update: layout.update, deleteIds: [] });
          started = true;
          const step = { step: "update-tokens",
            targets: updates.map((entry) => scene.uuid + ".Token." + entry._id), state: "unknown" };
          steps.push(step);
          await scene.updateEmbeddedDocuments("Token", updates.map((entry) => ({ ...entry })));
          const confirmed = updates.every((entry) => {
            const actual = prepPlacementFields(scene.tokens.get(entry._id) ?? {});
            return Object.entries(entry).every(([key, value]) => key === "_id" || actual[key] === value);
          });
          step.state = confirmed ? "completed" : "unknown";
          if (!confirmed) throw new Error("Token update did not settle");
        }
        if (layout.deleteIds.length) {
          prepWorld(input.world);
          prepCheckSceneRead(scene, input.readState, [], { update: [], deleteIds: layout.deleteIds });
          started = true;
          const step = { step: "delete-tokens",
            targets: layout.deleteIds.map((id) => scene.uuid + ".Token." + id), state: "unknown" };
          steps.push(step);
          await scene.deleteEmbeddedDocuments("Token", layout.deleteIds);
          const confirmed = layout.deleteIds.every((id) => !scene.tokens.has(id));
          step.state = confirmed ? "completed" : "unknown";
          if (!confirmed) throw new Error("Token deletion did not settle");
        }
        if (changes.active === true) {
          prepWorld(input.world); started = true;
          const step = { step: "activate-scene", targets: [scene.uuid], state: "unknown" };
          steps.push(step);
          // az scene.activate() 的 shim 适配：active 标志唯一化 + canvas 视图切换
          for (const other of collectionValues(game.scenes)) {
            if (other !== scene && other.active === true) await other.update({ active: false });
          }
          await scene.update({ active: true });
          g.__MT_CANVAS_SEMANTICS__?.viewScene?.(scene);
          step.state = scene.active === true && g.canvas?.scene?.id === scene.id ? "completed" : "unknown";
          if (step.state !== "completed") throw new Error("Scene activation did not settle");
        }
        return { status: "completed", steps,
          verification: [{ sceneUuid: scene.uuid, ...prepSceneFields(scene),
            tokenCount: collectionValues(scene.tokens).length }],
          warnings: [] };
      } catch (error) {
        return started
          ? { status: steps.some((step) => step.state === "completed") ? "partial" : "indeterminate",
              retry: false, steps, message: writeErrorMessage(error) }
          : writeReject(error);
      }
    }

    // —— imageApply（az imageApplyData；dataPath-only——Actor 走 actorEdit 全链（含
    //    syncPlacedTokens），Item 直写 img；upload 一律 CAPABILITY_UNAVAILABLE）——
    async function imageApplyData(input) {
      let started = false, dataPath;
      const steps = [];
      try {
        writeInputGuard(input, "imageApply");
        writePrepObject(input, ["image", "targetUuid", "syncPlacedTokens", "world", "requestId"]);
        prepWorld(input.world);
        if (input.syncPlacedTokens !== undefined && typeof input.syncPlacedTokens !== "boolean") {
          throw new Error("INPUT_INVALID: syncPlacedTokens must be boolean");
        }
        let doc = null, docName = null;
        if (input.targetUuid !== undefined) {
          if (typeof input.targetUuid !== "string" || !input.targetUuid || input.targetUuid.length > 256
            || input.targetUuid.startsWith("Compendium.")) {
            throw new Error("INPUT_INVALID: exact world document UUID required");
          }
          doc = await g.fromUuid(input.targetUuid);
          // shim 适配：dnd5e 的 Item5e/MidiActor 实例不带 documentName 静态面——
          // 世界集合成员身份 + uuid 链形状双重兜底判型（M2 prepActor 同款口径）
          const targetParts = String(input.targetUuid).split(".");
          const targetKind = targetParts[0] === "Actor" && targetParts.length === 2 ? "Actor"
            : (targetParts[0] === "Item" && targetParts.length === 2)
              || (targetParts.length === 4 && targetParts[2] === "Item") ? "Item" : null;
          docName = typeof doc?.documentName === "string" ? doc.documentName
            : doc && collectionValues(game.actors).includes(doc) ? "Actor"
            : targetKind;
          if (!doc || doc.uuid !== input.targetUuid || !["Actor", "Item"].includes(docName)) {
            // 降级：JournalEntryPage 图页（az 支持）在 shim 无语义面——一并拒绝
            throw new Error("IMAGE_TARGET_UNSUPPORTED: use a world Actor or Item; JournalEntryPage targets are unsupported in this shim");
          }
        }
        if (input.syncPlacedTokens && docName !== "Actor") {
          throw new Error("INPUT_INVALID: syncPlacedTokens requires an Actor target");
        }
        if (docName === "Actor") {
          // az：Actor 目标复用 actorEdit 全链——页内先做一次新 actorRead 取 readState
          const { readState } = await actorReadData({ actorUuid: doc.uuid,
            include: ["prototypeToken", ...(input.syncPlacedTokens ? ["sceneTokens"] : [])] });
          const image = { ...input.image, syncPlacedTokens: !!input.syncPlacedTokens };
          const result = await actorEditData({ actorUuid: doc.uuid, readState, world: input.world,
            requestId: input.requestId, changes: { image } });
          return { ...result, ...(result.status !== "rejected" ? { dataPath: input.image.dataPath } : {}) };
        }
        const prepared = await prepPrepareImage(input.image);
        dataPath = prepared.dataPath;
        if (doc) {
          const before = doc.img ?? null;
          const step = { step: "document-image", targets: [doc.uuid], state: "unknown", before };
          steps.push(step);
          started = true;
          // shim 适配：嵌入 Item 的 update() 不落库——经父文档 updateEmbeddedDocuments
          if (doc.parent?.updateEmbeddedDocuments) {
            await doc.parent.updateEmbeddedDocuments("Item", [{ _id: doc.id, img: dataPath }]);
          } else {
            await doc.update({ img: dataPath });
          }
          prepWorld(input.world);
          step.after = doc.img ?? null;
          if (step.after === dataPath) step.state = "completed";
        }
        return steps.every((step) => step.state === "completed")
          ? { status: "completed", dataPath, steps, verification: [{ dataPath, targetUuid: doc?.uuid ?? null }], warnings: [] }
          : { status: "partial", dataPath, retry: false, steps, message: "Image application did not fully settle" };
      } catch (error) {
        return started
          ? { status: steps.some((step) => step.state === "completed") ? "partial" : "indeterminate",
              ...(dataPath ? { dataPath } : {}), retry: false, steps, message: writeErrorMessage(error) }
          : writeReject(error);
      }
    }

    // —— K5 conditionsSet（az conditionsSetData 逐段移植；M4b 写集收官）——
    // shim 适配①：世界/嵌入文档实例不带 documentName 实例面（真 Foundry 有 getter，shim 只有
    // 类静态）——documentNameOf 以实例面优先，世界集合成员身份 + uuid 链形状兜底（M2
    // prepActor / imageApply 同款口径）。适配②：写路径的无战斗焦点取 az 语义（全场景 token，
    // playFocus(true)），读面保留 M2 目标集口径。适配③：game.actors.get 经 worldFind 兜底。
    function documentNameOf(doc) {
      if (typeof doc?.documentName === "string") return doc.documentName;
      if (collectionValues(game.actors).includes(doc)) return "Actor";
      const parts = typeof doc?.uuid === "string" ? doc.uuid.split(".") : [];
      if (parts[0] === "Scene" && parts.length === 2) return "Scene";
      if (parts[0] === "Scene" && parts.length === 4 && parts[2] === "Token") return "Token";
      if (parts[0] === "Actor" && parts.length === 2) return "Actor";
      return null;
    }
    async function conditionsSetData(input) {
      const reject = (code, message) => ({ status: "rejected", code, message });
      const conditions = input?.conditions;
      if (!Array.isArray(input?.targets) || !input.targets.length || input.targets.length > 20
        || !Array.isArray(conditions) || !conditions.length || conditions.length > 8
        || conditions.some((entry) => !entry || typeof entry.key !== "string" || typeof entry.active !== "boolean")
        || new Set(conditions.map((entry) => entry.key)).size !== conditions.length) {
        return reject("INPUT_INVALID", "Expected exact actors and distinct explicit condition states");
      }
      if (!["prep", "combat"].includes(input.mode)) return reject("INPUT_INVALID", "Missing mode policy");
      const sceneFocus = input.mode === "combat" || input.targets.some((target) => target?.scope === "focus");
      let focus;
      try {
        prepWorld(input.world);
        focus = sceneFocus ? playFocus(true) : { tokens: [] };
      } catch (error) { return reject(writeErrorMessage(error).split(":")[0], writeErrorMessage(error)); }
      const supported = new Set(collectionValues(g.CONFIG?.statusEffects).map((effect) => effect.id));
      if (conditions.some((entry) => !supported.has(entry.key))) return reject("CONDITION_UNSUPPORTED", "Unknown system condition");
      const actors = [], bindings = [];
      const selected = input.targets.filter((target) => target?.kind === "selected");
      if (selected.length && input.targets.length !== 1) return reject("INPUT_INVALID", "selected must be the only selector");
      const selectors = selected.length
        ? (input.selectedTokenUuids ?? []).map((tokenUuid) => ({ kind: "token", tokenUuid })) : input.targets;
      if (!selectors.length || selectors.length > 20) return reject("INPUT_INVALID", "Expected 1..20 targets in the submitted selection");
      try { for (const target of selectors) {
        let actor = null, document = null;
        if (target?.kind === "actor" && input.mode === "prep" && typeof target.actorUuid === "string") {
          document = await g.fromUuid(target.actorUuid);
          if (documentNameOf(document) === "Actor" && document.uuid === target.actorUuid) actor = document;
        } else if (target?.kind === "token" && typeof target.tokenUuid === "string") {
          document = await g.fromUuid(target.tokenUuid);
          if (documentNameOf(document) === "Token" && document.uuid === target.tokenUuid) {
            if (input.mode === "combat" && !focus.tokens.some((token) => token.uuid === document.uuid)) {
              return reject("SOURCE_OUT_OF_FOCUS", "Token is outside the current focus");
            }
            actor = document.actor;
          }
        } else if (target?.kind === "name" && typeof target.name === "string" && target.name.length <= 256) {
          let candidates;
          if (target.scope === "actors" && input.mode === "prep") {
            candidates = collectionValues(game.actors).filter((value) => value.name === target.name);
          } else if (target.scope === "focus") {
            candidates = focus.tokens.filter((token) => token.name === target.name || token.actor?.name === target.name);
          } else return reject("INPUT_INVALID", "Invalid name search scope");
          if (candidates.length > 1) return { ...reject("TARGET_AMBIGUOUS", "More than one exact target name"),
            candidates: candidates.slice(0, 5).map((value) => ({ uuid: value.uuid, name: value.name })) };
          document = candidates[0];
          actor = documentNameOf(document) === "Actor" ? document : document?.actor;
        } else return reject("INPUT_INVALID", "Invalid target selector for this mode");
        if (!actor || documentNameOf(actor) !== "Actor" || actor.pack) return reject("ACTOR_NOT_FOUND", "Target has no actual Actor");
        bindings.push({ document, actor, focusBound: input.mode === "combat" || target.scope === "focus" });
        if (!actors.some((value) => value.uuid === actor.uuid)) actors.push(actor);
      }
      } catch (error) { return reject("SOURCE_RESOLUTION_FAILED", writeErrorMessage(error)); }
      const checkBindings = () => {
        prepWorld(input.world);
        if (!game.ready || !game.user?.isGM) throw new Error("WORLD_NOT_READY: ready GM context required");
        const currentFocus = bindings.some((binding) => binding.focusBound) ? playFocus(true) : null;
        for (const { document, actor, focusBound } of bindings) {
          if (documentNameOf(document) === "Token") {
            if (document.actor !== actor || (document.parent?.tokens && document.parent.tokens.get(document.id) !== document)) throw new Error("SOURCE_CHANGED: bound Token changed");
            if (focusBound && !currentFocus.tokens.some((token) => token.uuid === document.uuid && token.actor === actor)) throw new Error("SOURCE_OUT_OF_FOCUS: bound Token left current focus");
          } else if (actor.id && game.actors && !actor.isToken && worldFind(game.actors, actor.id) !== actor) throw new Error("SOURCE_CHANGED: bound Actor changed");
        }
      };
      try { checkBindings(); } catch (error) { return reject(writeErrorMessage(error).split(":")[0], writeErrorMessage(error)); }
      // az effectState 指纹 / manual 判定：手写状态标记 = 无 origin + 无 changes + 单状态 +
      // flags 只含 core/arcanedesk（dae 仅空 specialDuration 元数据）
      const effectState = (effect) => JSON.stringify([effect.uuid, effect.origin, effect.disabled, setValues(effect.statuses).sort(), effect.changes, effect.flags]);
      const manual = (effect) => !effect.origin && collectionValues(effect.changes).length === 0
        && setValues(effect.statuses).length === 1
        && Object.entries(effect.flags ?? {}).every(([key, value]) => key === "core" || key === "arcanedesk"
          || (key === "dae" && value && Object.keys(value).every((field) => field === "specialDuration")
            && Array.isArray(value.specialDuration) && value.specialDuration.length === 0));
      const steps = [];
      const plans = [];
      for (const actor of actors) for (const condition of conditions) {
        const effects = collectionValues(actor.effects).filter((effect) => !effect.disabled && setValues(effect.statuses).includes(condition.key));
        const before = setValues(actor.statuses).includes(condition.key) || effects.length > 0;
        const plan = { actor, condition, before, effects, effectStates: effects.map(effectState), end: [] };
        if (before && !condition.active) {
          for (const effect of effects) {
            if (manual(effect)) continue;
            if (condition.key === "concentrating" && collectionValues(actor.concentration?.effects).includes(effect)
              && typeof actor.endConcentration === "function") plan.end.push(effect);
            else return reject("SOURCE_MANAGED", "Condition is provided by effect " + (effect.uuid ?? effect.name));
          }
          if (!effects.length) return reject("SOURCE_MANAGED", "Condition source is not an editable manual effect");
        }
        if (!before && condition.active && typeof actor.toggleStatusEffect !== "function") {
          return reject("CAPABILITY_UNAVAILABLE", "Native status setting is unavailable");
        }
        plans.push(plan);
      }
      let started = false;
      try {
        for (const plan of plans) {
          checkBindings();
          const { actor, condition, effects, end } = plan;
          const currentEffects = collectionValues(actor.effects).filter((effect) => !effect.disabled && setValues(effect.statuses).includes(condition.key));
          const before = setValues(actor.statuses).includes(condition.key) || currentEffects.length > 0;
          const needsWrite = before !== condition.active;
          if (needsWrite && (before !== plan.before || JSON.stringify(currentEffects.map(effectState)) !== JSON.stringify(plan.effectStates))) throw new Error("CONDITION_CHANGED: condition sources changed before writing");
          const step = { step: "condition", targets: [actor.uuid], state: needsWrite ? "unknown" : "completed",
            key: condition.key, before, after: needsWrite ? null : before, noop: !needsWrite, summary: (actor.name ?? actor.uuid) + ": " + condition.key };
          steps.push(step);
          if (needsWrite) {
            if (condition.active) { started = true; await actor.toggleStatusEffect(condition.key, { active: true }); }
            else for (const [index, effect] of effects.entries()) {
              checkBindings();
              if (!collectionValues(actor.effects).includes(effect)) continue;
              if (effectState(effect) !== plan.effectStates[index]) throw new Error("CONDITION_CHANGED: effect changed before removal");
              if (end.includes(effect)) {
                if (!collectionValues(actor.concentration?.effects).includes(effect)) throw new Error("SOURCE_MANAGED: concentration association changed");
                started = true; await actor.endConcentration(effect);
              } else {
                if (!manual(effect)) throw new Error("SOURCE_MANAGED: effect is no longer a manual marker");
                started = true; await effect.delete();
              }
            }
          }
          checkBindings();
          const after = setValues(actor.statuses).includes(condition.key)
            || collectionValues(actor.effects).some((effect) => !effect.disabled && setValues(effect.statuses).includes(condition.key));
          step.after = after; step.state = after === condition.active ? "completed" : "unknown";
          step.summary += "=" + after;
          if (after !== condition.active) return { status: "partial", retry: false, steps,
            message: "The native condition change did not settle. Do not retry automatically." };
        }
        return { status: "completed", steps, verification: steps.map(({ targets, key, before, after, noop }) => ({ targets, key, before, after, noop })), warnings: [] };
      } catch (error) {
        if (!started) return reject(writeErrorMessage(error).split(":")[0], writeErrorMessage(error));
        return { status: steps.some((step) => step.state === "completed" && !step.noop) ? "partial" : "indeterminate",
          retry: false, steps, message: writeErrorMessage(error) + ". Do not retry automatically." };
      }
    }

    // =========================================================================
    // M5 executeTurn / executeAction（az executeTurnV2Data / executeActionData 逐段移植；
    // 语义规格 = az packages/foundry-sdk/test/execute-action.test.mjs，平价线
    // tools/stage8-m5-parity.mjs）。相对 az 原版的 shim 适配/降级（逐条）：
    //   - native summon 不移植（一期边界外，M6 候选；见文件头）——performUseAction 内 az
    //     的 summon 终端 API/hooks/flight 控制整块不存在；summon 类 activity 在
    //     executeAction 前置 CAPABILITY_UNAVAILABLE、在 executeTurn 不可寻址。
    //   - usageConfig 不带 midiOptions.targetsToUse：我们捆绑的 midi 13.x
    //     completeActivityUse 对 Set 调 .map（TypeError）——targetUuids 单路传入，midi
    //     自行归一（az 双路语义等价）。
    //   - performUseAction 的源 actor 取 placeable.actor ?? tokenDocument 面（shim 的
    //     canvas placeable 不总带 actor 代理）。
    //   - interaction/choiceDefault/nativeSummon marker/selectionConstraints 词汇不解析
    //     （flags 在本桌无作者）——deriveActivityInputContract 取 az 的 dnd5e 原生推导
    //     分支，allocation 输入恒拒（az 无 flags 时同码同文案）。
    //   - az 的 thrown-attack 对话框抑制（suppressDefaultThrownAttackDialog）保留——
    //     纯 dnd5e 数据面（properties "thr" + midiProperties.forceRollDialog）。
    //   - executeAction 的焦点与 contextRef 同源（本 runtime 读面 M2 目标集口径）；
    //     az 原版无战斗焦点=全场景 token（见文件头 playFocus 注释）。
    //   - playTimingSupported 沿用 M2 口径（比 az 多拒 legendary/mythic——az 允许）。
    // =========================================================================
    function isAgentCallableActionV2(item, activity) {
      return isAgentCallableActivityV2(activity)
        && deriveActivityInputContract(item, activity).supported === true;
    }
    // az deriveActivityInputContract 的无 arcane-interaction 子集：模板/自身/选目标/不支持
    // 四路 dnd5e 原生推导 + required/optional/target/template/range 全字段（M2 的
    // deriveActivityInputContractLite 继续承担 staticContext/battleContext 输出面）
    function deriveActivityInputContract(item, activity) {
      const text = (value) => String(value ?? "").trim();
      const itemTarget = item?.system?.target ?? {};
      const activityTarget = activity?.target ?? {};
      const rawActivityTarget = activity?._source?.target ?? activityTarget;
      const activityOverridesTarget = activityTarget?.override === true || rawActivityTarget?.override === true;
      const target = activityOverridesTarget ? activityTarget : itemTarget;
      const rawTarget = activityOverridesTarget ? rawActivityTarget : (item?._source?.system?.target ?? itemTarget);
      const itemRange = item?.system?.range ?? {};
      const activityRange = activity?.range ?? {};
      const range = activityRange?.override === true ? activityRange : itemRange;
      const template = target?.template ?? {};
      const affects = target?.affects ?? {};
      const rawAffectsCount = rawTarget?.affects?.count;
      const rawAffectsCountText = typeof rawAffectsCount === "string" ? rawAffectsCount.trim() : "";
      const affectsCountFormula = rawAffectsCountText && !Number.isFinite(Number(rawAffectsCountText))
        ? rawAffectsCountText : null;
      const templateType = text(template?.type);
      const affectsType = text(affects?.type);
      const activityType = text(activity?.type);
      const rangeUnits = text(range?.units);
      let runtimeTargeting = "unsupported";
      let source = "dnd5e-target";
      if (templateType) runtimeTargeting = "template";
      else if (affectsType === "self") runtimeTargeting = "self";
      else if (["creature", "ally", "enemy", "token"].includes(affectsType)) runtimeTargeting = "tokens";
      else if (["space", "object", "item", "none"].includes(affectsType)) {
        // az：这些目标类型需要 token id 之外的输入面——协议未开放前保持不支持
        runtimeTargeting = "unsupported";
      } else if (rangeUnits === "self") {
        runtimeTargeting = "self";
        source = "dnd5e-range";
      } else if (["attack", "save", "damage", "heal"].includes(activityType)) {
        runtimeTargeting = "tokens";
        source = "activity-type-fallback";
      }
      let origin = null;
      let placement = null;
      if (runtimeTargeting === "template") {
        // az：midi 只自动放置 self 的半径/方半径延展；其余形状要人选方向/落点
        if (rangeUnits === "self" && ["radius", "squareRadius"].includes(templateType)) {
          origin = "self-centered";
          placement = "self";
        } else if (rangeUnits === "self") {
          origin = "self-directional";
          placement = "manual";
        } else {
          origin = "manual-point";
          placement = "manual";
        }
      }
      const mode = runtimeTargeting === "tokens" ? "selected-targets"
        : runtimeTargeting === "template" ? (placement === "self" ? "self" : "placed-template")
          : runtimeTargeting;
      const supported = ["selected-targets", "placed-template", "self"].includes(mode);
      return {
        version: 2,
        mode,
        source,
        supported,
        execution: mode === "placed-template" ? "wait-for-human" : supported ? "immediate" : "not-implemented",
        required: mode === "selected-targets" ? ["targetTokenIds"] : [],
        optional: activityType === "attack" ? ["input.attackRollMode"] : [],
        selections: [],
        resolution: null,
        selectionConstraints: [],
        choiceDefault: null,
        target: {
          type: affectsType,
          count: affects?.count ?? null,
          countFormula: affectsCountFormula,
          choice: affects?.choice ?? false,
          special: affects?.special ?? "",
        },
        template: templateType
          ? {
            type: templateType,
            count: template?.count ?? 1,
            size: template?.size ?? null,
            width: template?.width ?? null,
            height: template?.height ?? null,
            units: template?.units ?? rangeUnits ?? "",
            contiguous: template?.contiguous ?? false,
            origin,
            placement,
          }
          : null,
        range: {
          value: range?.value ?? null,
          long: range?.long ?? null,
          units: rangeUnits,
          special: range?.special ?? "",
        },
      };
    }
    function resolveRequiredSelectionsForContract(useArgs, inputContract) {
      const definitions = Array.isArray(inputContract?.selections) ? inputContract.selections : [];
      const provided = useArgs?.selections;
      if (provided !== undefined && (!provided || typeof provided !== "object" || Array.isArray(provided))) {
        throw new Error("selections must be an object");
      }
      const values = provided ?? {};
      const known = new Set(definitions.map((definition) => String(definition?.id ?? "")));
      const unknown = Object.keys(values).filter((key) => !known.has(key));
      if (unknown.length > 0) throw new Error("Unknown selections: " + unknown.join(", "));
      const resolved = {};
      for (const definition of definitions) {
        const id = String(definition?.id ?? "");
        const value = values[id];
        if (definition?.required === true && typeof value !== "string") {
          throw new Error("Missing required selection input.selections." + id);
        }
        if (value === undefined) continue;
        const allowed = Array.isArray(definition?.values) ? definition.values.map((entry) => String(entry?.value ?? "")) : [];
        if (!allowed.includes(value)) throw new Error("Invalid selection input.selections." + id + ": " + String(value));
        resolved[id] = value;
      }
      return resolved;
    }
    function resolveTargetSpecForContract(useArgs, inputContract) {
      const values = (value) => {
        if (value === undefined || value === null) return [];
        return Array.isArray(value) ? value : [value];
      };
      const legacyTokenIds = values(useArgs?.targetTokenIds).map(String).filter(Boolean);
      const provided = useArgs?.targetSpec;
      if (provided !== undefined && (!provided || typeof provided !== "object" || Array.isArray(provided))) {
        throw new Error("targetSpec must be an object");
      }
      const contractMode = String(inputContract?.mode ?? "unknown");
      const hasSelfPlacedTemplate = !!inputContract?.template?.type && inputContract?.template?.placement === "self";
      const runtimeMode = contractMode === "selected-targets" ? "tokens"
        : contractMode === "placed-template" || (contractMode === "self" && hasSelfPlacedTemplate) ? "template"
          : contractMode;
      let targetSpec = provided ? { ...provided } : null;
      if (!targetSpec && legacyTokenIds.length) {
        if (contractMode !== "selected-targets") {
          throw new Error("targetTokenIds are only accepted for selected-targets actions");
        }
        targetSpec = { mode: "tokens", tokenIds: legacyTokenIds, legacy: true };
      }
      if (!targetSpec && runtimeMode === "template") {
        targetSpec = { mode: "template", placement: inputContract?.template?.placement ?? "manual" };
      }
      if (!targetSpec && runtimeMode === "self") targetSpec = { mode: "self" };
      if (!targetSpec) throw new Error("targetTokenIds are required for selected-targets actions");
      const requestedRawMode = String(targetSpec.mode ?? "").trim();
      const requestedMode = requestedRawMode === "selected-targets" ? "tokens"
        : requestedRawMode === "placed-template" ? "template" : requestedRawMode;
      const gmDeclaredTemplateTargets = contractMode === "placed-template"
        && requestedMode === "tokens" && targetSpec.geometry === "gm-declared";
      if (requestedMode !== runtimeMode && !gmDeclaredTemplateTargets) {
        throw new Error("targetSpec.mode " + requestedRawMode + " does not match action inputContract.mode " + contractMode);
      }
      if (requestedMode === "tokens") {
        const tokenIds = values(targetSpec.tokenIds ?? legacyTokenIds).map(String).filter(Boolean);
        const defaultPolicy = targetSpec.defaultPolicy;
        if (!tokenIds.length && !defaultPolicy) {
          throw new Error("targetSpec.tokenIds must contain at least one token id");
        }
        return {
          mode: "tokens",
          tokenIds,
          geometry: targetSpec.geometry ?? (targetSpec.legacy ? "legacy-explicit" : "explicit"),
          defaultPolicy: defaultPolicy ? { ...defaultPolicy } : null,
          placement: null,
          createMeasuredTemplate: false,
          bypassedTemplateGeometry: gmDeclaredTemplateTargets,
          inputMode: contractMode,
        };
      }
      if (requestedMode === "template") {
        if (legacyTokenIds.length) {
          throw new Error("targetTokenIds are forbidden for template placement; use targetSpec.mode=template or an explicit geometry=gm-declared bypass");
        }
        const placement = String(targetSpec.placement ?? inputContract?.template?.placement ?? "manual");
        if (!["manual", "self"].includes(placement)) throw new Error("targetSpec.placement must be manual or self");
        return {
          mode: "template",
          tokenIds: [],
          geometry: "measured-template",
          placement,
          createMeasuredTemplate: true,
          bypassedTemplateGeometry: false,
          inputMode: contractMode,
        };
      }
      if (requestedMode === "self") {
        if (legacyTokenIds.length) throw new Error("targetTokenIds are forbidden for self actions");
        return {
          mode: "self",
          tokenIds: ["self"],
          geometry: "self",
          placement: null,
          createMeasuredTemplate: false,
          bypassedTemplateGeometry: false,
          inputMode: contractMode,
        };
      }
      throw new Error("CLI target mode " + requestedMode + " is not implemented; inspect inputContract before executing");
    }
    function resolveDefaultChosenTokens(sourceToken, inputContract) {
      const policy = inputContract?.choiceDefault;
      if (!policy || policy.cardinality !== "any") return [];
      const sourceDoc = tokenDocument(sourceToken);
      const sourceDisposition = Number(sourceDoc?.disposition ?? 0);
      const rangeValue = Number(inputContract?.range?.value);
      const rangeUnits = cleanText(inputContract?.range?.units);
      const maxDistance = Number.isFinite(rangeValue) && rangeValue > 0
        ? rangeUnits === "mi" ? rangeValue * 5280 : rangeValue : null;
      const midi = g.MidiQOL;
      const canSee = (from, to) => {
        if (typeof midi?.canSee === "function") return midi.canSee(from, to) !== false;
        return tokenDocument(to)?.hidden !== true;
      };
      return sceneTokens().filter((token) => {
        const doc = tokenDocument(token);
        if (!doc?.id || !token?.actor) return false;
        const isSelf = doc.id === sourceDoc?.id;
        if (isSelf && policy.includeSelf !== true) return false;
        const disposition = Number(doc.disposition ?? 0);
        if (sourceDisposition === 0 || disposition === 0) return false;
        if (policy.targetPolicy === "same-disposition-all" && disposition !== sourceDisposition) return false;
        if (policy.targetPolicy === "opposing-disposition-all" && Math.sign(disposition) === Math.sign(sourceDisposition)) return false;
        if (!["same-disposition-all", "opposing-disposition-all"].includes(policy.targetPolicy)) return false;
        if (maxDistance !== null && tokenWithinDistance(sourceToken, token, maxDistance) !== true) return false;
        if (policy.requiresSourceCanSeeTarget === true && !canSee(sourceToken, token)) return false;
        if (policy.requiresTargetCanSeeSource === true && !canSee(token, sourceToken)) return false;
        return true;
      });
    }
    function materializeDefaultTargetResolution(sourceToken, inputContract, targetResolution) {
      if (targetResolution?.mode !== "tokens" || !targetResolution?.defaultPolicy) return targetResolution;
      const tokens = resolveDefaultChosenTokens(sourceToken, inputContract);
      if (!tokens.length) throw new Error("No eligible default targets");
      return {
        ...targetResolution,
        tokenIds: tokens.map((token) => tokenDocument(token)?.id).filter(Boolean),
        geometry: "default-choice",
      };
    }
    function resolveActivityTargetCountLimit(item, inputContract, requestedSpellLevel) {
      const positiveFinite = (value) => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : null;
      };
      const preparedCount = positiveFinite(inputContract?.target?.count);
      const formula = String(inputContract?.target?.countFormula ?? "").trim();
      if (!formula) return preparedCount;
      const baseLevel = Number(item?.system?.level);
      const explicitLevel = Number(requestedSpellLevel);
      const itemLevel = requestedSpellLevel !== undefined && Number.isInteger(explicitLevel)
        ? explicitLevel : baseLevel;
      if (!Number.isInteger(itemLevel) || itemLevel < 0) return preparedCount;
      const expression = formula.replace(/@item\.level\b/g, String(itemLevel)).replace(/\s+/g, "");
      const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
      if (!expression || tokens.join("") !== expression) return preparedCount;
      let position = 0;
      function parsePrimary() {
        const token = tokens[position];
        if (token === "(") {
          position += 1;
          const value = parseExpression();
          if (tokens[position] !== ")") return Number.NaN;
          position += 1;
          return value;
        }
        if (!token || !/^\d+(?:\.\d+)?$/.test(token)) return Number.NaN;
        position += 1;
        return Number(token);
      }
      function parseUnary() {
        const token = tokens[position];
        if (token === "+" || token === "-") {
          position += 1;
          const value = parseUnary();
          return token === "-" ? -value : value;
        }
        return parsePrimary();
      }
      function parseProduct() {
        let value = parseUnary();
        while (tokens[position] === "*" || tokens[position] === "/") {
          const operator = tokens[position];
          position += 1;
          const right = parseUnary();
          value = operator === "*" ? value * right : value / right;
        }
        return value;
      }
      function parseExpression() {
        let value = parseProduct();
        while (tokens[position] === "+" || tokens[position] === "-") {
          const operator = tokens[position];
          position += 1;
          const right = parseProduct();
          value = operator === "+" ? value + right : value - right;
        }
        return value;
      }
      const resolved = parseExpression();
      if (position !== tokens.length || !Number.isFinite(resolved) || resolved <= 0) return preparedCount;
      return Math.floor(resolved);
    }
    function measureTokenDistanceWithFoundry(runtime, fromToken, toToken) {
      if (!fromToken || !toToken) return null;
      const midi = runtime?.MidiQOL;
      if (typeof midi?.getDistance === "function") {
        try {
          const distance = Number(midi.getDistance(fromToken, toToken, { wallsBlock: false, includeCover: false }));
          if (Number.isFinite(distance)) return distance >= 0 ? distance : null;
        } catch { /* 落到网格测量 */ }
      }
      const canvas = runtime?.canvas;
      const grid = canvas?.grid;
      if (typeof grid?.measurePath !== "function") return null;
      const centerOf = (tokenLike) => {
        const document = tokenLike?.document ?? tokenLike;
        const placeable = tokenLike?.center ? tokenLike
          : document?.object?.center ? document.object
            : canvas?.tokens?.get?.(document?.id) ?? null;
        const centerX = Number(placeable?.center?.x);
        const centerY = Number(placeable?.center?.y);
        if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
          return { x: centerX, y: centerY, elevation: Number(document?.elevation ?? 0) };
        }
        const gridSize = Number(canvas?.dimensions?.size ?? canvas?.scene?.grid?.size);
        const x = Number(document?.x);
        const y = Number(document?.y);
        if (!Number.isFinite(gridSize) || gridSize <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
          x: x + (Number(document?.width ?? 1) * gridSize) / 2,
          y: y + (Number(document?.height ?? 1) * gridSize) / 2,
          elevation: Number(document?.elevation ?? 0),
        };
      };
      const from = centerOf(fromToken);
      const to = centerOf(toToken);
      if (!from || !to) return null;
      try {
        const distance = Number(grid.measurePath([from, to], {})?.distance);
        return Number.isFinite(distance) && distance >= 0 ? distance : null;
      } catch { return null; }
    }
    function isTokenWithinDistanceWithFoundry(runtime, fromToken, toToken, maxDistance) {
      if (!fromToken || !toToken || !Number.isFinite(maxDistance) || maxDistance < 0) return null;
      const midi = runtime?.MidiQOL;
      if (typeof midi?.checkDistance === "function") {
        try {
          const result = midi.checkDistance(fromToken, toToken, maxDistance, { wallsBlock: false, includeCover: false });
          if (typeof result === "boolean") return result;
        } catch { /* 落到共享距离适配器 */ }
      }
      const distance = measureTokenDistanceWithFoundry(runtime, fromToken, toToken);
      return distance === null ? null : distance <= maxDistance;
    }
    function tokenWithinDistance(fromToken, toToken, maxDistance) {
      return isTokenWithinDistanceWithFoundry(g, fromToken, toToken, maxDistance);
    }
    function checkActivityTargetRangeWithFoundry(runtime, activity, sourceToken, targetTokens) {
      const checkActivityRange = runtime?.MidiQOL?.checkActivityRange;
      if (typeof checkActivityRange !== "function") return "unavailable";
      try {
        const result = checkActivityRange(activity, sourceToken, new Set(targetTokens), false)?.result;
        if (result === "fail") return "invalid";
        if (result === "normal" || result === "dis") return "valid";
      } catch { /* 调用方落到低层距离适配器 */ }
      return "unavailable";
    }
    // az validateTargetResolutionForContract 的无 selectionConstraints 子集（词汇依赖
    // arcane interaction flags，本桌无作者——az 无 flags 时同行为）：数量上限 + midi 射程
    // 检查 + 合同射程回退（tokenWithinDistance）
    function validateTargetResolutionForContract(sourceToken, item, activity, inputContract, targetResolution,
      requestedSpellLevel, projectileResolution = null) {
      if (targetResolution?.mode !== "tokens") return targetResolution;
      const ids = collectionValues(targetResolution.tokenIds).map(String).filter(Boolean);
      const count = resolveActivityTargetCountLimit(item, inputContract, requestedSpellLevel);
      if (count !== null && ids.length > count && !projectileResolution) {
        throw new Error("Selected target count exceeds action maximum of " + count);
      }
      const targetTokens = ids.map((id) => (id === "self" ? sourceToken : findToken(id))).filter(Boolean);
      const activityRangeCheck = checkActivityTargetRangeWithFoundry(g, activity, sourceToken, targetTokens);
      if (activityRangeCheck === "invalid") {
        throw new Error("Target selection is outside the action's allowed range or line of effect");
      }
      const rangeValue = Number(inputContract?.range?.value);
      const longRangeValue = Number(inputContract?.range?.long);
      const rangeUnits = cleanText(inputContract?.range?.units);
      const furthestRange = Math.max(
        Number.isFinite(rangeValue) && rangeValue > 0 ? rangeValue : 0,
        Number.isFinite(longRangeValue) && longRangeValue > 0 ? longRangeValue : 0,
      );
      const maxDistance = furthestRange > 0 ? (rangeUnits === "mi" ? furthestRange * 5280 : furthestRange) : null;
      if (maxDistance !== null) {
        for (const id of ids) {
          const token = id === "self" ? sourceToken : findToken(id);
          if (!token) continue;
          const withinDistance = tokenWithinDistance(sourceToken, token, maxDistance);
          if (withinDistance === false || (withinDistance === null && activityRangeCheck !== "valid")) {
            throw new Error("Target token is outside action range: " + id);
          }
        }
      }
      return targetResolution;
    }
    // shim 适配：shim 不在构造期跑系统 _migrateData（会重写 legacy damage.parts 破坏
    // CompatSheet 等旧消费面，browser-verify F4 实测）——旧版 preparation.mode →
    // system.method 的归一在此读面兜底（az 真堆栈活模型已带 method；prepared/always→spell，
    // 其余模式直取，与 dnd5e #migratePreparation 同口径）
    function spellMethodOf(item) {
      const method = String(item?.system?.method ?? "").trim();
      if (method) return method;
      const mode = String(item?.system?._source?.preparation?.mode
        ?? item?._source?.system?.preparation?.mode ?? "").trim();
      if (mode === "prepared" || mode === "always") return "spell";
      return mode || null;
    }
    function resolveNativeSpellSlotConsumption(item, activity, actor, spellcastingConfig, requestedSpellLevel) {
      const hasRequestedSpellLevel = requestedSpellLevel !== undefined;
      if (item?.type !== "spell" || !activity?.consumption?.spellSlot) {
        if (hasRequestedSpellLevel) throw new Error("spellLevel is only valid for spell-slot-consuming spell activities");
        return null;
      }
      const method = spellMethodOf(item);
      const baseLevel = Number(item?.system?.level ?? 0);
      let level = baseLevel;
      if (hasRequestedSpellLevel) {
        if (typeof requestedSpellLevel !== "number" || !Number.isInteger(requestedSpellLevel)
          || requestedSpellLevel < 1 || requestedSpellLevel > 9) {
          throw new Error("spellLevel must be an integer from 1 to 9");
        }
        if (method !== "spell") throw new Error("spellLevel is only supported for ordinary spell slots");
        if (!Number.isInteger(baseLevel) || baseLevel < 1 || requestedSpellLevel < baseLevel) {
          throw new Error("spellLevel " + requestedSpellLevel + " cannot be lower than the spell's base level " + baseLevel);
        }
        level = requestedSpellLevel;
      }
      const spellcasting = spellcastingConfig?.[method];
      const key = spellcasting?.getSpellSlotKey?.(level) ?? (method === "spell" ? `spell${level}` : method);
      const slot = actor?.system?.spells?.[key];
      if (!slot) {
        if (hasRequestedSpellLevel) throw new Error("Spell slot " + key + " is not available on this actor");
        return null;
      }
      return {
        key,
        value: Number(slot.value ?? 0),
        max: Number(slot.max ?? 0),
        level: Number(slot.level ?? level),
      };
    }
    // 降级：independent-projectiles 词汇来自 arcane interaction flags（本桌无作者）——
    // resolution 恒 null，allocation 输入一律拒绝（az 无 flags 时同码同文案）
    function resolveIndependentProjectileAllocationV2(item, inputContract, targetTokenIds, allocation) {
      if (inputContract?.resolution?.type !== "independent-projectiles") {
        if (allocation !== undefined) throw new Error("input.allocation is only valid for independent-projectiles actions");
        return null;
      }
      return null;
    }
    function featureDeclaredRiderOptionsV2(items) {
      const moduleId = "arcane-dnd5e-2014-automation";
      const values = Array.isArray(items) ? items : [];
      return values.flatMap((item) => {
        const declaration = item?.flags?.[moduleId]?.declaredRider;
        if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) return [];
        const id = String(declaration.id ?? declaration.identifier ?? item?.system?.identifier ?? "").trim();
        if (!id) return [];
        const declaredConsumes = String(declaration.consumes ?? "").trim();
        const explicitConsumes = declaredConsumes === "none" ? "" : declaredConsumes;
        const divineSmiteCompatibility = id === "divine-smite" && String(declaration.consumesOn ?? "").trim() === "hit";
        const consumes = explicitConsumes || (divineSmiteCompatibility ? "spell-slot-on-hit" : "");
        const rawMinimum = Number(declaration.minSpellLevel ?? 1);
        const minSpellLevel = Number.isInteger(rawMinimum) && rawMinimum >= 1 ? rawMinimum : 1;
        const name = String(item?.name ?? declaration.name ?? id).trim() || id;
        const resource = String(declaration.resource ?? "").trim();
        const attackType = String(declaration.attackType ?? "").trim();
        return [{
          id,
          name,
          ...(consumes ? { consumes } : {}),
          ...(consumes === "spell-slot-on-hit" ? { minSpellLevel } : {}),
          ...(resource ? { resource } : {}),
          inputPath: "input.declaredRiders",
          ...(attackType ? { attackType } : {}),
        }];
      });
    }
    function declaredRiderOptionsV2(actor, entry, includeInactiveBuffs = false) {
      const actionItem = actor?.items?.get?.(entry.itemId)
        ?? collectionValues(actor?.items).find((item) => item?.id === entry.itemId);
      if (actionItem?.type !== "weapon" || entry.type !== "attack") return [];
      const activity = activities(actionItem).find((candidate) => (candidate?.id ?? candidate?._id) === entry.activityId);
      const attackText = [
        activity?.attack?.type?.value,
        activity?.attack?.type,
        activity?.attack?.classification,
        actionItem.system?.actionType,
        actionItem.system?.type?.value,
      ].filter(Boolean).join(" ").toLowerCase();
      const melee = /melee|mwak|simplem|martialm/.test(attackText);
      const ranged = /ranged|rwak|simpler|martialr/.test(attackText);
      const attackTypeMatches = (declaration) => {
        if (declaration?.attackType === "melee") return melee;
        if (declaration?.attackType === "ranged") return ranged;
        return true;
      };
      const featureRiders = featureDeclaredRiderOptionsV2(collectionValues(actor?.items))
        .filter((option) => attackTypeMatches(option))
        .map((option) => {
          const result = { ...option };
          delete result.attackType;
          return result;
        });
      const spellSlotRiders = collectionValues(actor?.items)
        .filter((item) => item?.type === "spell")
        .map((item) => ({ item, declaration: item?.flags?.["arcane-dnd5e-2014-automation"]?.declaredWeaponSpellRider }))
        .filter(({ declaration }) => declaration && typeof declaration === "object")
        .filter(({ declaration }) => attackTypeMatches(declaration))
        .map(({ item, declaration }) => ({
          id: cleanText(declaration.identifier ?? item.system?.identifier),
          name: item.name ?? declaration.identifier,
          minSpellLevel: Number(declaration.minSpellLevel ?? item.system?.level ?? 1),
          consumes: "spell-slot-on-hit",
          inputPath: "input.declaredRiders",
        }))
        .filter((option) => option.id);
      const activeBuffRiders = collectionValues(actor?.items)
        .filter((item) => item?.type === "spell")
        .map((item) => ({ item, declaration: item?.flags?.["arcane-dnd5e-2014-automation"]?.declaredActiveBuff }))
        .filter(({ declaration }) => declaration && typeof declaration === "object")
        .filter(({ declaration }) => attackTypeMatches(declaration))
        .filter(({ declaration }) => includeInactiveBuffs
          || collectionValues(actor?.effects).some((effect) => effect?.disabled !== true
            && collectionValues(effect?.flags?.["arcane-dnd5e-2014-automation"]?.compilerArtifactIds)
              .includes(declaration.requiredArtifactId)))
        .map(({ item, declaration }) => ({
          id: cleanText(declaration.identifier ?? item.system?.identifier),
          name: item.name ?? declaration.identifier,
          consumes: "active-buff-on-attack",
          ...(includeInactiveBuffs ? { requiresArtifactId: declaration.requiredArtifactId } : {}),
          resource: "none",
          inputPath: "input.declaredRiders",
        }))
        .filter((option) => option.id);
      const unique = [];
      const seenIds = new Set();
      for (const option of [...featureRiders, ...spellSlotRiders, ...activeBuffRiders]) {
        if (seenIds.has(option.id)) continue;
        seenIds.add(option.id);
        unique.push(option);
      }
      return unique;
    }
    function resolveDeclaredRiderRequestsV2(requests, options, spellSlots) {
      if (requests === undefined) return [];
      if (!Array.isArray(requests)) throw new Error("input.declaredRiders must be an array");
      const available = new Map((Array.isArray(options) ? options : [])
        .filter((option) => option && String(option.id ?? "").trim())
        .map((option) => [String(option.id).trim(), option]));
      const seen = new Set();
      const seenConsumptionKinds = new Set();
      const reservedSlots = new Map();
      return requests.map((request) => {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          throw new Error("Each input.declaredRiders entry must be an object");
        }
        const id = String(request.id ?? request.identifier ?? "").trim();
        if (!id) throw new Error("Each declared rider requires id");
        if (seen.has(id)) throw new Error("Duplicate declared rider " + id);
        seen.add(id);
        const option = available.get(id);
        if (!option) throw new Error("Declared rider " + id + " is not available for this action");
        const declaredConsumptionKind = String(option.consumes ?? "").trim();
        const consumptionKind = declaredConsumptionKind === "none" ? "" : declaredConsumptionKind;
        if (consumptionKind && seenConsumptionKinds.has(consumptionKind)) {
          throw new Error("Only one declared rider consuming " + consumptionKind + " may be used with one attack");
        }
        if (consumptionKind) seenConsumptionKinds.add(consumptionKind);
        if (consumptionKind !== "spell-slot-on-hit") {
          if (request.spellLevel !== undefined || request.level !== undefined) {
            throw new Error("Declared rider " + id + " does not accept spellLevel");
          }
          return { id };
        }
        const minimum = Number(option.minSpellLevel ?? 1);
        const rawLevel = request.spellLevel ?? request.level ?? minimum;
        if (typeof rawLevel !== "number" || !Number.isInteger(rawLevel) || rawLevel < 1 || rawLevel > 9) {
          throw new Error("Declared rider " + id + " spellLevel must be an integer from 1 to 9");
        }
        if (rawLevel < minimum) {
          throw new Error("Declared rider " + id + " spellLevel " + rawLevel + " cannot be lower than " + minimum);
        }
        const key = "spell" + rawLevel;
        const slot = spellSlots?.[key];
        const reserved = reservedSlots.get(key) ?? 0;
        if (!slot || Number(slot.value ?? 0) <= reserved) {
          throw new Error("No " + key + " spell slots remain for declared rider " + id);
        }
        reservedSlots.set(key, reserved + 1);
        return { id, spellLevel: rawLevel };
      });
    }
    function validateDeclaredRiderPlanV2(riderGroups) {
      const spellSlotRiders = (Array.isArray(riderGroups) ? riderGroups : [])
        .flatMap((group) => (Array.isArray(group) ? group : []))
        .filter((rider) => rider?.spellLevel !== undefined);
      if (spellSlotRiders.length > 1) {
        throw new Error("Only one spell-slot-on-hit declared rider may be used in one execute-turn");
      }
    }
    function isActionAvailableV2(actor, activity) {
      const availability = activity?.flags?.["arcane-dnd5e-2014-automation"]?.availability ?? {};
      const requiredIdentifier = String(availability.requiresEffectIdentifier ?? "").trim();
      const requiredArtifactId = String(availability.requiresArtifactId ?? "").trim();
      if (!requiredIdentifier && !requiredArtifactId) return true;
      return collectionValues(actor?.effects).some((effect) => {
        if (effect?.disabled === true || effect?.active === false || effect?.isSuppressed === true) return false;
        const arcaneFlags = effect?.flags?.["arcane-dnd5e-2014-automation"] ?? {};
        const identifier = String(arcaneFlags.identifier ?? arcaneFlags.effectIdentifier ?? "").trim();
        const artifactIds = Array.isArray(arcaneFlags.compilerArtifactIds)
          ? arcaneFlags.compilerArtifactIds.map((value) => String(value)) : [];
        return (!requiredIdentifier || identifier === requiredIdentifier)
          && (!requiredArtifactId || artifactIds.includes(requiredArtifactId));
      });
    }
    function actionBlockV2(actor, item, activity) {
      const activationType = effectiveActivityActivationTypeV2(item, activity);
      const isSpell = item?.type === "spell";
      const isAttack = activity?.type === "attack";
      const isReaction = activationType === "reaction";
      const isAction = activationType === "action";
      if (!actor || (!isSpell && !isAttack && !isReaction && !isAction)) return null;
      for (const effect of collectionValues(actor?.effects)) {
        if (effect?.disabled === true || effect?.active === false || effect?.isSuppressed === true) continue;
        const rawKinds = effect?.flags?.["arcane-dnd5e-2014-automation"]?.blockedActionKinds;
        const kinds = rawKinds instanceof Set ? Array.from(rawKinds) : Array.isArray(rawKinds) ? rawKinds : [];
        const kind = isSpell && kinds.includes("spell") ? "spell"
          : isAttack && kinds.includes("attack") ? "attack"
            : isReaction && kinds.includes("reaction") ? "reaction"
              : isAction && kinds.includes("action") ? "action" : null;
        if (kind) {
          return {
            kind,
            effectId: effect?.id == null ? null : String(effect.id),
            effectName: effect?.name == null ? (effect?.label == null ? null : String(effect.label)) : String(effect.name),
          };
        }
      }
      return null;
    }
    function stripHtml(html) {
      if (!html) return "";
      const div = document.createElement("div");
      div.innerHTML = String(html);
      return (div.textContent || div.innerText || "").replace(/\s+/g, " ").trim();
    }
    function findRecentItemCard({ since, sourceTokenId, itemId, itemName }) {
      const messages = Array.from(game.messages ?? []).reverse();
      return messages.find((message) => {
        if ((message.timestamp ?? 0) < since) return false;
        const speaker = message.speaker ?? {};
        const flags = message.flags ?? {};
        const midiItemId = flags["midi-qol"]?.itemId ?? flags["dnd5e"]?.item?.id;
        const dndItemName = flags["dnd5e"]?.item?.name;
        return (!sourceTokenId || speaker.token === sourceTokenId)
          && (midiItemId === itemId || dndItemName === itemName || stripHtml(message.content).includes(itemName));
      }) ?? null;
    }
    function activityMode(activity) {
      const raw = activity?.flags?.["arcane-dnd5e-2014-automation"]?.mode;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const value = cleanText(raw.value ?? raw.id ?? raw.key ?? raw.damageType);
      if (!value && raw.default !== true) return null;
      return {
        value: value || null,
        ...(cleanText(raw.damageType) ? { damageType: cleanText(raw.damageType) } : {}),
        default: raw.default === true,
      };
    }
    function damageFormulaOf(part, fallbackTypes) {
      const number = part?.number ?? null;
      const denomination = part?.denomination ?? null;
      const bonus = cleanText(part?.bonus ?? "");
      let formula = "";
      if (number && denomination) formula = number + "d" + denomination;
      if (bonus) formula = formula ? formula + (bonus.startsWith("-") ? bonus : "+" + bonus) : bonus;
      const types = setValues(part?.types);
      return { formula, number, denomination, bonus, types: types.length ? types : fallbackTypes };
    }
    function serializeActivityUse(item, activity) {
      const baseTypes = setValues(item?.system?.damage?.base?.types);
      const parts = collectionValues(activity?.damage?.parts);
      const inputContract = deriveActivityInputContract(item, activity);
      return {
        activityId: activity?.id ?? activity?._id ?? null,
        activityName: activity?.name ?? null,
        mode: activityMode(activity),
        type: activity?.type ?? null,
        activation: effectiveActivityActivationTypeV2(item, activity) || null,
        range: {
          value: activity?.range?.value ?? item?.system?.range?.value ?? null,
          long: activity?.range?.long ?? item?.system?.range?.long ?? null,
          units: activity?.range?.units ?? item?.system?.range?.units ?? null,
          label: activity?.range?.labels?.range ?? null,
        },
        target: {
          type: inputContract.target.type,
          count: inputContract.target.count,
          prompt: activity?.target?.prompt ?? null,
          template: inputContract.template,
        },
        inputContract,
        attack: activity?.attack
          ? {
            ability: activity.attack.ability ?? "",
            type: activity.attack.type?.value ?? "",
            classification: activity.attack.type?.classification ?? "",
            bonus: activity.attack.bonus ?? "",
          }
          : null,
        save: activity?.save
          ? {
            ability: setValues(activity.save.ability),
            dc: activity.save.dc?.value ?? null,
            formula: activity.save.dc?.formula ?? "",
            calculation: activity.save.dc?.calculation ?? "",
          }
          : null,
        damage: parts.map((part) => damageFormulaOf(part, part?.base ? baseTypes : [])),
        consumption: {
          spellSlot: activity?.consumption?.spellSlot ?? null,
          targets: collectionValues(activity?.consumption?.targets).map((target) => ({
            type: target?.type ?? "",
            target: target?.target ?? "",
            value: target?.value ?? "",
          })),
        },
        warnings: activityWarnings(item, activity),
      };
    }
    function activityWarnings(item, activity) {
      const warnings = [];
      const targets = collectionValues(activity?.consumption?.targets);
      const hasEmptyItemUses = targets.some((target) => target?.type === "itemUses" && !cleanText(target?.target));
      const maxUses = String(item?.system?.uses?.max ?? "");
      if (hasEmptyItemUses && (maxUses === "0" || maxUses === "")) warnings.push("consumes-empty-itemUses-target");
      if (activity?.target?.prompt === true) warnings.push("prompts-for-target");
      if (activities(item).length > 1) warnings.push("multiple-activities");
      return warnings;
    }
    function serializeTokenLite(tokenLike) {
      const token = tokenObject(tokenLike);
      const doc = tokenDocument(tokenLike);
      const actor = token?.actor ?? doc?.actor ?? null;
      const hp = actor?.system?.attributes?.hp ?? {};
      const ac = actor?.system?.attributes?.ac ?? {};
      const effects = collectionValues(actor?.effects).map((effect) => ({
        id: effect.id ?? null,
        name: effect.name ?? effect.label ?? null,
        icon: effect.icon ?? null,
        disabled: !!effect.disabled,
        statuses: setValues(effect.statuses),
        duration: effect.duration
          ? {
            type: effect.duration.type ?? null,
            rounds: effect.duration.rounds ?? null,
            turns: effect.duration.turns ?? null,
            remaining: effect.duration.remaining ?? null,
          }
          : null,
      }));
      return {
        id: doc?.id ?? token?.id ?? null,
        uuid: doc?.uuid ?? null,
        name: doc?.name ?? token?.name ?? null,
        actorId: actor?.id ?? doc?.actorId ?? null,
        actorName: actor?.name ?? null,
        actorType: actor?.type ?? null,
        x: doc?.x ?? token?.x ?? null,
        y: doc?.y ?? token?.y ?? null,
        width: doc?.width ?? null,
        height: doc?.height ?? null,
        hidden: !!doc?.hidden,
        disposition: doc?.disposition ?? null,
        elevation: doc?.elevation ?? null,
        img: doc?.texture?.src ?? token?.texture?.src ?? null,
        hp: { value: hp.value ?? null, max: hp.max ?? null, temp: hp.temp ?? 0, tempmax: hp.tempmax ?? 0 },
        ac: { value: ac.value ?? null, calc: ac.calc ?? null, flat: ac.flat ?? null },
        effects,
        statuses: setValues(actor?.statuses),
      };
    }
    function tokenState(tokenLike) {
      const token = serializeTokenLite(tokenLike);
      return {
        tokenId: token.id,
        name: token.name,
        hp: token.hp,
        effects: token.effects.map((effect) => effect.name).filter(Boolean),
        statuses: token.statuses,
      };
    }
    function diffTokenState(before, after) {
      const beforeEffects = new Set(before.effects ?? []);
      const afterEffects = new Set(after.effects ?? []);
      const beforeStatuses = new Set(before.statuses ?? []);
      const afterStatuses = new Set(after.statuses ?? []);
      return {
        tokenId: after.tokenId,
        name: after.name,
        hpBefore: before.hp?.value ?? null,
        hpAfter: after.hp?.value ?? null,
        tempHpBefore: before.hp?.temp ?? 0,
        tempHpAfter: after.hp?.temp ?? 0,
        hpDelta: (after.hp?.value ?? 0) - (before.hp?.value ?? 0),
        tempHpDelta: (after.hp?.temp ?? 0) - (before.hp?.temp ?? 0),
        effectsAdded: [...afterEffects].filter((name) => !beforeEffects.has(name)),
        effectsRemoved: [...beforeEffects].filter((name) => !afterEffects.has(name)),
        statusesAdded: [...afterStatuses].filter((name) => !beforeStatuses.has(name)),
        statusesRemoved: [...beforeStatuses].filter((name) => !afterStatuses.has(name)),
      };
    }
    function buildActivityUseCreateOptions(targetResolution) {
      // 模板活动自带交互放置（activity.target.prompt）——同时强设 create.measuredTemplate
      // 会启动第二次 use 工作流（双模板双消耗），az 注释同款
      if (targetResolution?.mode === "template") return {};
      return { create: { measuredTemplate: false } };
    }
    function suppressDefaultThrownAttackDialog(item, activity) {
      const properties = item?.system?.properties;
      const isThrownWeapon = properties?.has?.("thr") === true
        || collectionValues(properties).some((property) => cleanText(property) === "thr");
      const midiProperties = activity?.midiProperties;
      if (activity?.type !== "attack" || !isThrownWeapon || !midiProperties || typeof midiProperties !== "object") {
        return () => undefined;
      }
      const itemActivitySource = item?._source?.system?.activities?.[activity?.id];
      const containers = [midiProperties, activity?._source?.midiProperties, itemActivitySource?.midiProperties]
        .filter((entry, index, all) => entry && typeof entry === "object" && all.indexOf(entry) === index);
      const explicit = containers.map((entry) => entry.forceRollDialog).find((value) => value && value !== "default");
      if (explicit) return () => undefined;
      const previous = containers.map((entry) => ({
        entry,
        hadValue: Object.prototype.hasOwnProperty.call(entry, "forceRollDialog"),
        value: entry.forceRollDialog,
      }));
      const restore = () => {
        for (const { entry, hadValue, value } of previous) {
          if (hadValue) entry.forceRollDialog = value;
          else delete entry.forceRollDialog;
        }
      };
      try {
        // midi 对每个可投掷武器强开配置对话框（即使 completeItemUse 显式非交互）——
        // execute-turn 期间保持系统首选攻击模式，只压掉这个隐式对话框；本地模型覆写
        // 绝不持久化，也不覆写显式契约（az 注释同款）
        for (const { entry } of previous) entry.forceRollDialog = "never";
      } catch (error) {
        restore();
        throw new Error("ACTION_MISCONFIGURED: Could not suppress the default thrown-weapon attack dialog: "
          + cleanText(error?.message ?? error));
      }
      if (previous.some(({ entry }) => entry.forceRollDialog !== "never")) {
        restore();
        throw new Error("ACTION_MISCONFIGURED: Could not suppress the default thrown-weapon attack dialog");
      }
      return restore;
    }
    // —— performUseAction（az 同名函数移植，native summon 分支整体缺席，见段首注释；
    //    签名固定 async function performUseAction(useArgs = {})——stage8-m5-parity 以
    //    字符串替换注入测试桩）——
    async function performUseAction(useArgs = {}) {
      const totalStart = performance.now();
      const timings = {};
      let mark = totalStart;
      function split(name) {
        const now = performance.now();
        timings[name] = Math.round((now - mark) * 10) / 10;
        mark = now;
      }
      const sourceToken = findToken(useArgs?.sourceTokenId);
      if (!sourceToken) throw new Error("Source token not found: " + useArgs?.sourceTokenId);
      // shim 适配：placeable.actor 可缺席——文档面兜底（az 直读 sourceToken.actor）
      const sourceActor = sourceToken.actor ?? tokenDocument(sourceToken)?.actor ?? null;
      const item = sourceActor?.items?.get?.(useArgs?.itemId)
        ?? findItem(sourceActor, useArgs?.itemId ?? useArgs?.itemIdentifier);
      if (!item) throw new Error("Item not found: " + (useArgs?.itemId ?? useArgs?.itemIdentifier));
      const activity = findActivity(item, useArgs?.activityId ?? useArgs?.activityIdentifier);
      if (!isActionAvailableV2(sourceActor, activity)) throw new Error("Action is not currently available");
      const actionBlock = actionBlockV2(sourceActor, item, activity);
      if (actionBlock) {
        throw new Error("ACTION_BLOCKED: " + (item.name ?? activity?.name ?? actionBlock.kind)
          + " is blocked by " + (actionBlock.effectName ?? "an active effect"));
      }
      const inputContract = deriveActivityInputContract(item, activity);
      const selections = resolveRequiredSelectionsForContract(useArgs, inputContract);
      const hasRequestedSpellLevel = useArgs?.spellLevel !== undefined;
      const unresolvedTargetResolution = materializeDefaultTargetResolution(
        sourceToken,
        inputContract,
        resolveTargetSpecForContract(useArgs, inputContract),
      );
      const configProblem = actionConfigProblemV2(item, activity);
      if (unresolvedTargetResolution?.bypassedTemplateGeometry !== true && configProblem) {
        throw new Error("ACTION_MISCONFIGURED: " + configProblem);
      }
      const nativeSpellSlotBefore = resolveNativeSpellSlotConsumption(
        item, activity, sourceActor, g.CONFIG?.DND5E?.spellcasting,
        hasRequestedSpellLevel ? useArgs.spellLevel : undefined,
      );
      const effectiveSpellLevel = nativeSpellSlotBefore?.level ?? (hasRequestedSpellLevel ? useArgs.spellLevel : undefined);
      if (nativeSpellSlotBefore && nativeSpellSlotBefore.value <= 0) {
        throw new Error("No " + nativeSpellSlotBefore.key + " spell slots remain for " + item.name);
      }
      const projectileResolution = resolveIndependentProjectileAllocationV2(
        item, inputContract, unresolvedTargetResolution?.tokenIds, useArgs?.allocation, effectiveSpellLevel,
      );
      const targetResolution = validateTargetResolutionForContract(
        sourceToken, item, activity, inputContract, unresolvedTargetResolution, effectiveSpellLevel, projectileResolution,
      );
      split("resolveSourceItemActivityMs");
      const targetTokens = collectionValues(targetResolution.tokenIds).map((id) => {
        const token = cleanText(id) === "self" ? sourceToken : findToken(id);
        if (!token) throw new Error("Target token not found: " + id);
        return token;
      });
      const initialWorkflowTargetTokens = projectileResolution
        ? targetTokens.filter((token) => tokenDocument(token)?.id === projectileResolution.primaryTargetId)
        : targetTokens;
      if (projectileResolution && initialWorkflowTargetTokens.length !== 1) {
        throw new Error("Independent projectile primary target could not be resolved");
      }
      const beforeByTokenId = new Map(sceneTokens().map((token) => [tokenDocument(token)?.id, tokenState(token)]));
      const templateIdsBefore = new Set(collectionValues(currentScene()?.templates)
        .map((template) => template?.id).filter(Boolean));
      const targetUuids = initialWorkflowTargetTokens.map((token) => tokenDocument(token)?.uuid).filter(Boolean);
      const sourceTokenUuid = cleanText(tokenDocument(sourceToken)?.uuid);
      const targetIds = initialWorkflowTargetTokens.map((token) => tokenDocument(token)?.id).filter(Boolean);
      if (g.canvas?.tokens?.setTargets) g.canvas.tokens.setTargets(targetIds);
      else if (game.user?.updateTokenTargets) game.user.updateTokenTargets(targetIds);
      split("prepareTargetsAndBeforeStateMs");

      const midi = g.MidiQOL;
      if (!midi?.completeItemUse) throw new Error("MidiQOL.completeItemUse is not available");
      const startedAt = Date.now();
      const attackRollMode = useArgs?.attackRollMode ?? "normal";
      const attackRollOptions = attackRollMode === "advantage" ? { advantage: true, disadvantage: false }
        : attackRollMode === "disadvantage" ? { advantage: false, disadvantage: true } : {};
      const declaredRiders = Array.isArray(useArgs?.declaredRiders)
        ? useArgs.declaredRiders.map((rider) => ({ ...rider })) : [];
      const fastForwardWorkflow = targetResolution.mode !== "template";
      const usageConfig = {
        chooseActivity: false,
        configure: false,
        createMessage: true,
        arcaneDeclaredRiders: declaredRiders,
        declaredRiders,
        arcaneSelections: selections,
        ...(hasRequestedSpellLevel && nativeSpellSlotBefore ? { spell: { slot: nativeSpellSlotBefore.key } } : {}),
        ...buildActivityUseCreateOptions(targetResolution),
        midiOptions: {
          activityId: activity?.id,
          arcaneDeclaredRiders: declaredRiders,
          arcaneSelections: selections,
          targetUuids,
          // shim 适配：midi 13.x completeActivityUse 对 Set 调 .map——targetsToUse 不传
          // （midi 由 targetUuids 自行归一），见段首注释
          ignoreUserTargets: fastForwardWorkflow,
          fastForward: fastForwardWorkflow,
          ...(hasRequestedSpellLevel ? { spellLevel: Number(useArgs.spellLevel) } : {}),
          ...attackRollOptions,
          workflowOptions: {
            arcaneDeclaredRiders: declaredRiders,
            arcaneSelections: selections,
            targetUuids,
            sourceTokenUuid,
            targetConfirmation: "none",
            ...(fastForwardWorkflow
              ? {
                autoRollAttack: true,
                autoRollDamage: "onHit",
                fastForwardAttack: true,
                fastForwardDamage: true,
              }
              : {}),
            ...attackRollOptions,
          },
        },
      };
      const restoreThrownAttackDialog = suppressDefaultThrownAttackDialog(item, activity);
      const completeItemUseStart = performance.now();
      const requestedActionTimeoutMs = Number(useArgs?.actionTimeoutMs);
      const actionTimeoutMs = Number.isFinite(requestedActionTimeoutMs) && requestedActionTimeoutMs > 0
        ? Math.max(1000, requestedActionTimeoutMs) : 15000;
      let workflowTimedOut = false;
      let workflow = null;
      let primaryTimeoutId = null;
      try {
        if (useArgs?.factSink) useArgs.factSink.started = true;
        workflow = await Promise.race([
          midi.completeItemUse(item, usageConfig, { configure: false }, {}),
          new Promise((resolve) => {
            primaryTimeoutId = setTimeout(() => {
              workflowTimedOut = true;
              resolve(null);
            }, actionTimeoutMs);
          }),
        ]);
      } finally {
        if (primaryTimeoutId !== null) clearTimeout(primaryTimeoutId);
        restoreThrownAttackDialog();
      }
      const workflowAborted = workflow?.aborted === true;
      const workflowCompleted = !!workflow && !workflowTimedOut && !workflowAborted;
      let nativeSpellSlotReconciled = false;
      if (workflowCompleted && nativeSpellSlotBefore) {
        const currentValue = Number(sourceActor?.system?.spells?.[nativeSpellSlotBefore.key]?.value ?? 0);
        if (currentValue === nativeSpellSlotBefore.value) {
          await sourceActor.update({
            ["system.spells." + nativeSpellSlotBefore.key + ".value"]: Math.max(nativeSpellSlotBefore.value - 1, 0),
          });
          nativeSpellSlotReconciled = true;
        }
      }
      timings.completeItemUseMs = Math.round((performance.now() - completeItemUseStart) * 10) / 10;
      mark = performance.now();
      const recentItemCard = workflow
        ? null
        : findRecentItemCard({
          since: startedAt,
          sourceTokenId: tokenDocument(sourceToken)?.id,
          itemId: item.id,
          itemName: item.name,
        });
      split("findRecentItemCardMs");
      const requestedPostDelayMs = Number(useArgs?.postDelayMs ?? 0);
      const postDelayStart = performance.now();
      await new Promise((resolve) => setTimeout(resolve, requestedPostDelayMs));
      timings.postDelayMs = Math.round((performance.now() - postDelayStart) * 10) / 10;
      mark = performance.now();
      const workflowTargetTokens = collectionValues(workflow?.targets).map((target) => tokenObject(target)).filter(Boolean);
      const newMeasuredTemplateDocuments = collectionValues(currentScene()?.templates)
        .filter((template) => !templateIdsBefore.has(template?.id));
      let templateTargetingWarning = null;
      const computeTemplateTargets = (templates) => {
        if (targetResolution.mode !== "template" || !templates.length) return [];
        if (typeof midi?.computeTargetsFromTemplates !== "function") {
          templateTargetingWarning = "midi-qol-template-target-computation-unavailable";
          return [];
        }
        try {
          return collectionValues(midi.computeTargetsFromTemplates(
            templates, tokenDocument(sourceToken)?.uuid ?? "", false, "any", "always",
          )).map((target) => tokenObject(target)).filter(Boolean);
        } catch (error) {
          templateTargetingWarning = "midi-qol-template-target-computation-failed:" + cleanText(error?.message ?? error);
          return [];
        }
      };
      const templateTargetTokens = computeTemplateTargets(newMeasuredTemplateDocuments);
      const observedTargets = [];
      const observedTargetIds = new Set();
      for (const token of [...targetTokens, ...workflowTargetTokens, ...templateTargetTokens]) {
        const tokenId = tokenDocument(token)?.id;
        if (!tokenId || observedTargetIds.has(tokenId)) continue;
        observedTargetIds.add(tokenId);
        observedTargets.push(token);
      }
      const measuredTemplates = newMeasuredTemplateDocuments.map((template) => {
        const memberTokens = computeTemplateTargets([template]);
        return {
          id: template?.id ?? null,
          uuid: template?.uuid ?? null,
          type: template?.t ?? template?.type ?? null,
          x: template?.x ?? null,
          y: template?.y ?? null,
          distance: template?.distance ?? null,
          width: template?.width ?? null,
          direction: template?.direction ?? null,
          angle: template?.angle ?? null,
          targetTokenIds: memberTokens.map((token) => tokenDocument(token)?.id).filter(Boolean),
          targets: memberTokens.map((token) => ({
            tokenId: tokenDocument(token)?.id ?? null,
            tokenName: token?.name ?? null,
            actorId: token?.actor?.id ?? null,
            actorName: token?.actor?.name ?? null,
          })),
        };
      });
      const resolvedTargetResolution = targetResolution.mode === "template"
        ? {
          ...targetResolution,
          tokenIds: templateTargetTokens.map((token) => tokenDocument(token)?.id).filter(Boolean),
          computedBy: "midi-qol-template-geometry",
        }
        : targetResolution;
      split("afterStateAndDiffPrepMs");
      const itemCardId = workflow?.itemCardId
        ?? (typeof workflow?.id === "string" && workflow.id.startsWith("ChatMessage.")
          ? workflow.id.slice("ChatMessage.".length)
          : workflow?.id)
        ?? recentItemCard?.id
        ?? null;
      return {
        success: workflowCompleted || !!recentItemCard,
        status: workflowAborted ? "aborted"
          : workflowCompleted ? "completed"
            : recentItemCard ? "submitted" : "no-workflow",
        source: {
          tokenId: tokenDocument(sourceToken)?.id,
          tokenName: sourceToken.name,
          actorId: sourceActor?.id ?? null,
          actorName: sourceActor?.name ?? null,
        },
        item: { id: item.id, name: item.name, type: item.type },
        activity: activity ? serializeActivityUse(item, activity) : null,
        targetResolution: resolvedTargetResolution,
        measuredTemplates,
        itemCardId,
        workflowId: workflow?.id ?? null,
        attacks: collectionValues(workflow?.attacks).map((attack) => ({
          total: attack?.total ?? null,
          hit: attack?.hit ?? null,
        })),
        damageRolled: collectionValues(workflow?.damageRolls).map((roll) => ({
          formula: roll?.formula ?? null,
          total: roll?.total ?? null,
        })),
        resourceConsumption: nativeSpellSlotBefore
          ? {
            spellSlot: {
              key: nativeSpellSlotBefore.key,
              level: nativeSpellSlotBefore.level,
              before: nativeSpellSlotBefore.value,
              after: Number(sourceActor?.system?.spells?.[nativeSpellSlotBefore.key]?.value ?? 0),
              reconciled: nativeSpellSlotReconciled,
            },
          }
          : null,
        tokenDiffs: observedTargets.map((token) => {
          const tokenId = tokenDocument(token)?.id;
          return diffTokenState(beforeByTokenId.get(tokenId), tokenState(token));
        }),
        warnings: [
          ...activityWarnings(item, activity),
          ...(templateTargetingWarning ? [templateTargetingWarning] : []),
          ...(!workflow && !recentItemCard ? ["midi-qol-returned-no-workflow"] : []),
          ...(workflowAborted ? ["midi-qol-workflow-aborted"] : []),
          ...(workflowTimedOut ? ["complete-item-use-timeout"] : []),
        ],
        timings: {
          ...timings,
          requestedPostDelayMs,
          totalMs: Math.round((performance.now() - totalStart) * 10) / 10,
        },
      };
    }
    function locateActionByIdV2(actor, actionId, mode) {
      const wanted = String(actionId ?? "");
      if (!wanted) return null;
      for (const candidate of collectActionCandidatesV2(actor, mode)) {
        if (candidate.actionId === wanted) return candidate;
      }
      return null;
    }
    function actionOwnerCombatantV2(combat, actionId) {
      for (const combatant of collectionValues(combat?.combatants)) {
        const token = findToken(combatant.tokenId) ?? tokenObject(combatant.token);
        const actor = token?.actor ?? tokenDocument(token)?.actor ?? null;
        if (!actor) continue;
        const located = locateActionByIdV2(actor, actionId);
        if (located && isAgentCallableActionV2(located.item, located.activity)) return combatant;
      }
      return null;
    }
    function serializeTurnResponseV2(facts) {
      const actions = facts?.actions ?? [];
      const requested = actions.length;
      const completedCount = actions.filter((action) => action.completed).length;
      const anyStarted = actions.some((action) => action.started);
      const unstartedError = actions.find((action) => !action.started && !action.completed
        && typeof action.error === "string" && action.error.trim() && action.error !== "not-attempted")?.error?.trim();
      const advanceState = !facts?.advanceRequested ? "not-requested"
        : facts?.advanceCompleted ? "completed" : "not-completed";
      if (facts?.rejectedCode && !anyStarted && !facts?.advanceStarted) {
        const rejectedMessage = facts.rejectedMessage?.trim();
        return {
          status: "rejected",
          code: facts.rejectedCode,
          ...(rejectedMessage ? { message: rejectedMessage } : {}),
        };
      }
      const unconfirmedAction = actions.some((action) => action.started && !action.completed);
      const unconfirmedAdvance = !!facts?.advanceRequested && !!facts?.advanceStarted && !facts?.advanceCompleted;
      if (completedCount === requested && !unconfirmedAction) {
        if (!facts?.advanceRequested || facts?.advanceCompleted) {
          const receipt = requested === 1 ? actions[0]?.receipt : null;
          return receipt ? { status: "completed", receipt } : { status: "completed" };
        }
        if (unconfirmedAdvance) return { status: "indeterminate", retry: false };
        return {
          status: "partial",
          completed: completedCount,
          requested,
          advance: advanceState,
          retry: false,
        };
      }
      if (completedCount > 0) {
        return {
          status: "partial",
          completed: completedCount,
          requested,
          advance: advanceState,
          retry: false,
          ...(unstartedError ? { message: unstartedError } : {}),
        };
      }
      if (unconfirmedAction || unconfirmedAdvance) return { status: "indeterminate", retry: false };
      // 无一开动且无 schema 拒绝记录：按拒绝输入处理（防御兜底；调用方应显式记 rejectedCode）
      return {
        status: "rejected",
        code: facts?.rejectedCode ?? "INPUT_INVALID",
        ...(unstartedError ? { message: unstartedError } : {}),
      };
    }
    function rejectTurnV2(code, advanceRequested, message = null) {
      return serializeTurnResponseV2({
        rejectedCode: code,
        rejectedMessage: cleanText(message),
        actions: [],
        advanceRequested: !!advanceRequested,
        advanceStarted: false,
        advanceCompleted: false,
      });
    }
    function turnActionSpecsV2(executeArgs) {
      if (executeArgs?.actions !== undefined) {
        if (!Array.isArray(executeArgs.actions) || !executeArgs.actions.length) return null;
        return executeArgs.actions;
      }
      if (executeArgs?.actionId !== undefined) {
        return [{
          actionId: executeArgs.actionId,
          targetTokenIds: executeArgs.targetTokenIds,
          input: executeArgs.input,
        }];
      }
      return null;
    }
    function validTurnActionSpecV2(spec) {
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) return false;
      if (!cleanText(spec.actionId)) return false;
      if (spec.targetTokenIds !== undefined && !Array.isArray(spec.targetTokenIds)) return false;
      if (spec.input !== undefined && (typeof spec.input !== "object" || spec.input === null || Array.isArray(spec.input))) return false;
      if (spec.input?.attackRollMode !== undefined
        && !["normal", "advantage", "disadvantage"].includes(spec.input.attackRollMode)) return false;
      if (spec.input?.declaredRiders !== undefined) {
        if (!Array.isArray(spec.input.declaredRiders)) return false;
        if (spec.input.declaredRiders.some((rider) =>
          !rider || typeof rider !== "object" || Array.isArray(rider) || !cleanText(rider.id ?? rider.identifier))) return false;
      }
      if (spec.input?.selections !== undefined
        && (!spec.input.selections || typeof spec.input.selections !== "object" || Array.isArray(spec.input.selections))) {
        return false;
      }
      if (spec.input?.allocation !== undefined && !Array.isArray(spec.input.allocation)) return false;
      return true;
    }
    // —— executeTurn（az executeTurnV2Data 移植；playExecution 供 executeAction 的非战斗
    //    路径内部分发——显式 sourceToken + combat，不查 game.combat）——
    async function executeTurnData(executeArgs = {}, playExecution = null) {
      const advanceRequested = executeArgs?.advance === true || executeArgs?.advance === "true";
      const combat = playExecution ? playExecution.combat : game.combat ?? null;
      if (!combat && !playExecution) return rejectTurnV2("BATTLE_NOT_ACTIVE", advanceRequested);
      const specs = turnActionSpecsV2(executeArgs);
      if (!specs) return rejectTurnV2("INPUT_INVALID", advanceRequested);
      for (const spec of specs) {
        if (!validTurnActionSpecV2(spec)) return rejectTurnV2("INPUT_INVALID", advanceRequested);
      }
      const activeCombatant = combat?.combatant ?? null;
      const sourceToken = playExecution?.sourceToken
        ?? (activeCombatant ? (findToken(activeCombatant.tokenId) ?? tokenObject(activeCombatant.token)) : null);
      const actor = sourceToken?.actor ?? tokenDocument(sourceToken)?.actor ?? null;
      if ((!activeCombatant && !playExecution) || !actor) return rejectTurnV2("BATTLE_NOT_ACTIVE", advanceRequested);
      const plans = [];
      for (const spec of specs) {
        const located = locateActionByIdV2(actor, spec.actionId);
        if (!located) {
          const owner = combat ? actionOwnerCombatantV2(combat, spec.actionId) : null;
          return rejectTurnV2(owner ? "ACTOR_NOT_ACTIVE" : "ACTION_NOT_FOUND", advanceRequested);
        }
        if (!isAgentCallableActionV2(located.item, located.activity)) {
          return rejectTurnV2("ACTION_NOT_FOUND", advanceRequested);
        }
        const contract = deriveActivityInputContract(located.item, located.activity);
        if (spec.input?.attackRollMode !== undefined && !contract.optional?.includes("input.attackRollMode")) {
          return rejectTurnV2("INPUT_INVALID", advanceRequested, "input.attackRollMode is not supported by this action");
        }
        const specTargetSpec = spec.input?.targetSpec;
        let targetResolution;
        let declaredRiders;
        try {
          resolveRequiredSelectionsForContract({ selections: spec.input?.selections }, contract);
          targetResolution = resolveTargetSpecForContract({ targetTokenIds: spec.targetTokenIds, targetSpec: specTargetSpec }, contract);
          resolveNativeSpellSlotConsumption(
            located.item, located.activity, actor, g.CONFIG?.DND5E?.spellcasting, spec.input?.spellLevel,
          );
          resolveIndependentProjectileAllocationV2(
            located.item, contract, targetResolution?.tokenIds, spec.input?.allocation, spec.input?.spellLevel,
          );
          declaredRiders = resolveDeclaredRiderRequestsV2(
            spec.input?.declaredRiders,
            declaredRiderOptionsV2(actor, {
              itemId: located.itemId,
              activityId: located.activityId,
              type: located.activity?.type,
            }),
            actor?.system?.spells ?? {},
          );
        } catch (error) {
          return rejectTurnV2("INPUT_INVALID", advanceRequested, error?.message ?? error);
        }
        const isTokensOverride = targetResolution?.bypassedTemplateGeometry === true;
        const targetSpec = specTargetSpec;
        if (!isTokensOverride && actionConfigProblemV2(located.item, located.activity)) {
          return rejectTurnV2("ACTION_MISCONFIGURED", advanceRequested);
        }
        plans.push({ spec, located, targetSpec, declaredRiders });
      }
      try {
        validateDeclaredRiderPlanV2(plans.map((plan) => plan.declaredRiders));
      } catch (error) {
        return rejectTurnV2("INPUT_INVALID", advanceRequested, error?.message ?? error);
      }
      const facts = {
        actions: [],
        advanceRequested,
        advanceStarted: false,
        advanceCompleted: false,
      };
      let aborted = false;
      for (const plan of plans) {
        if (aborted) {
          facts.actions.push({ actionId: plan.spec.actionId, started: false, completed: false, error: "not-attempted" });
          continue;
        }
        const fact = { actionId: plan.spec.actionId, started: false, completed: false, error: null, receipt: null };
        facts.actions.push(fact);
        const sink = { started: false };
        const actionBlock = actionBlockV2(actor, plan.located.item, plan.located.activity);
        if (actionBlock) {
          fact.error = "ACTION_BLOCKED";
          if (!facts.actions.slice(0, -1).some((action) => action.started)) {
            facts.rejectedCode = "ACTION_BLOCKED";
          }
          aborted = true;
          continue;
        }
        try {
          const result = await performUseAction({
            sourceTokenId: tokenDocument(sourceToken)?.id,
            itemId: plan.located.itemId,
            activityId: plan.located.activityId,
            targetTokenIds: plan.spec.targetTokenIds,
            targetSpec: plan.targetSpec,
            attackRollMode: plan.spec.input?.attackRollMode,
            declaredRiders: plan.declaredRiders,
            selections: plan.spec.input?.selections,
            allocation: plan.spec.input?.allocation,
            spellLevel: plan.spec.input?.spellLevel,
            actionTimeoutMs: executeArgs?.actionTimeoutMs,
            factSink: sink,
          });
          fact.started = sink.started;
          fact.completed = result?.status === "completed";
          if (!fact.completed) {
            fact.error = result?.status ?? "unknown";
            aborted = true;
          }
        } catch (error) {
          fact.started = sink.started;
          fact.error = cleanText(error?.message ?? error);
          const rejectedCode = fact.error.startsWith("ACTION_BLOCKED:")
            ? "ACTION_BLOCKED"
            : fact.error.startsWith("ACTION_MISCONFIGURED:")
              ? "ACTION_MISCONFIGURED"
              : null;
          if (!fact.started && !facts.actions.slice(0, -1).some((action) => action.started) && rejectedCode) {
            facts.rejectedCode = rejectedCode;
            facts.rejectedMessage = fact.error;
          }
          aborted = true;
        }
      }
      const allCompleted = facts.actions.length === plans.length && facts.actions.every((action) => action.completed);
      if (advanceRequested && allCompleted) {
        const before = { round: combat.round, turn: combat.turn };
        facts.advanceStarted = true;
        try {
          await combat.nextTurn();
          facts.advanceCompleted = true;
        } catch (error) {
          const active = game.combat;
          if (active && (active.round !== before.round || active.turn !== before.turn)) {
            facts.advanceCompleted = true;
          }
        }
      }
      return serializeTurnResponseV2(facts);
    }
    // —— executeAction（az executeActionData 移植；PlayExecuteInput → narrative 扣资源或
    //    分发 executeTurn native 路径；世界/contextRef/turn/焦点四重校验零写守卫）——
    async function executeActionData(input) {
      const reject = (code, message) => ({ status: "rejected", code, message });
      let focus, live;
      try { focus = playFocus(); live = playReadContext(false); }
      catch (error) { return reject(String(error.message).split(":")[0], String(error.message)); }
      if (!input.world
        || (loopbackOrigin(input.world.origin) !== loopbackOrigin(focus.scope.world.origin)
          || input.world.id !== focus.scope.world.id)) return reject("WORLD_CHANGED", "Bound world changed");
      if (input.contextRef !== live.contextRef) return reject("STATIC_CONTEXT_STALE", "Refresh static context once");
      const specs = input.resolvedActions;
      if (!Array.isArray(specs) || !specs.length || specs.length > 20 || (!focus.combat && specs.length !== 1)) {
        return reject("INPUT_INVALID", "Expected one noncombat action or a combat sequence");
      }
      if (input.advance && !focus.combat) return reject("INPUT_INVALID", "Cannot advance without an active combat");
      if (focus.combat && JSON.stringify(input.turn) !== JSON.stringify(live.turn)) {
        return reject("TURN_CHANGED", "Read the current turn before acting");
      }
      const plans = [];
      for (const spec of specs) {
        const doc = focus.tokens.find((token) => token.uuid === spec.sourceTokenUuid);
        if (!doc?.actor || doc.actor.uuid !== spec.actorUuid) {
          return reject("SOURCE_OUT_OF_FOCUS", "Exact source Token or Actor is no longer available");
        }
        if (focus.combat && focus.combat.combatant?.tokenId !== doc.id) {
          return reject("ACTOR_NOT_ACTIVE", "Source is not the current combatant");
        }
        if (plans.length && plans[0].doc.id !== doc.id) {
          return reject("INPUT_INVALID", "A sequence must use one source Token");
        }
        const item = doc.actor.items?.get?.(spec.itemId) ?? findItem(doc.actor, spec.itemId);
        if (!item) return reject("ACTION_NOT_FOUND", "Item is no longer owned");
        const activity = spec.activityId ? activities(item).find((value) => (value.id ?? value._id) === spec.activityId) : null;
        if (spec.activityId && !activity) return reject("ACTION_NOT_FOUND", "Activity no longer exists");
        if (!playTimingSupported(item, activity)) {
          return reject("CASTING_TIMING_UNSUPPORTED", "Reactions and long casting times are not supported by Play execution; no resources consumed");
        }
        const definition = { id: spec.actionId, itemId: spec.itemId, activityId: spec.activityId };
        if (playActionRef(focus.scope, doc, definition) !== spec.actionRef) {
          return reject("ACTION_NOT_FOUND", "Invalid action reference");
        }
        if (activity?.type === "summon") {
          return reject("CAPABILITY_UNAVAILABLE", "Summon placement awaits the auto pack protocol change (AUTO-001); no resources consumed");
        }
        const narrative = input.resolution === "narrative" || spec.actionId === "narrative:" + item.id
          || (activity?.type === "utility" && !spec.targetTokenUuids?.length && !spec.input?.targetSpec
            && deriveActivityInputContract(item, activity).mode === "selected-targets");
        if (narrative && specs.length !== 1) return reject("INPUT_INVALID", "Narrative spells require a single action");
        if (!narrative && (!activity || locateActionByIdV2(doc.actor, spec.actionId)?.activityId !== spec.activityId)) {
          return reject("ACTION_NOT_FOUND", "Unsupported action identity");
        }
        if (spec.input && Object.keys(spec.input).some((key) =>
          !["spellLevel", "attackRollMode", "selections", "allocation", "declaredRiders", "targetSpec"].includes(key))) {
          return reject("INPUT_INVALID", "Unknown activity input");
        }
        const targetTokenIds = [];
        for (const uuid of spec.targetTokenUuids ?? []) {
          const target = collectionValues(currentScene()?.tokens).find((token) => token.uuid === uuid);
          if (!target) return reject("TARGET_NOT_FOUND", "Target Token is no longer in the current Scene");
          targetTokenIds.push(target.id);
        }
        let cost;
        if (narrative) {
          if (Object.keys(spec.input ?? {}).some((key) => key !== "spellLevel") || targetTokenIds.length) {
            return reject("INPUT_INVALID", "Narrative records consumption only");
          }
          try { cost = playNarrativeCost(item, activity, doc.actor, spec.input?.spellLevel); }
          catch (error) { return reject("CONSUMPTION_UNSUPPORTED", error.message); }
          if (cost && cost.value < 1) return reject("RESOURCE_INSUFFICIENT", "No spell slots remain in the requested pool");
        }
        plans.push({ spec, doc, item, activity, narrative, cost, targetTokenIds });
      }
      const plan = plans[0];
      if (plan.narrative) {
        const steps = [];
        try {
          if (plan.cost) {
            const key = "system.spells." + plan.cost.key + ".value";
            await plan.doc.actor.update({ [key]: plan.cost.value - 1 });
            const after = Number(plan.doc.actor.system.spells[plan.cost.key]?.value);
            steps.push({ step: "spell-consumption", targets: [plan.doc.actor.uuid],
              state: after === plan.cost.value - 1 ? "completed" : "unknown",
              pool: plan.cost.key, before: plan.cost.value, after });
            if (after !== plan.cost.value - 1) {
              return { status: "indeterminate", retry: false, steps, message: "Consumption could not be confirmed; do not retry" };
            }
          }
          if (input.advance) {
            const before = { round: focus.combat.round, index: focus.combat.turn };
            try {
              await focus.combat.nextTurn();
              steps.push({ step: "advance", targets: [focus.combat.id], state: "completed", before,
                after: { round: focus.combat.round, index: focus.combat.turn } });
            } catch {
              return { status: "partial", retry: false, steps, message: "Spell recorded; turn advancement could not be confirmed. Do not repeat the spell." };
            }
          }
          return { status: "completed", steps, verification: steps,
            warnings: ["Narrative spell recorded; fictional outcome is decided by the DM. No independent animation adapter is available."] };
        } catch (error) {
          return { status: "indeterminate", retry: false, steps, message: "Consumption interrupted; do not retry" };
        }
      }
      return executeTurnData(
        {
          actions: plans.map((plan) => ({
            actionId: plan.spec.actionId,
            targetTokenIds: plan.targetTokenIds,
            input: plan.spec.input,
          })),
          advance: input.advance === true,
        },
        { sourceToken: tokenObject(plan.doc), combat: focus.combat },
      );
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
    if (action === "compendiumBrowse") return await compendiumBrowseData(args);
    // M3/M4b 写集：各 action 自捕获异常转四态回执（az actorEditData/sceneApplyData/conditionsSetData 同款，不向宿主抛）；GM 门在入口统一把守
    if (action === "actorCreate") return await actorCreateData(args);
    if (action === "actorEdit") return await actorEditData(args);
    if (action === "actorGrantItems") return await actorGrantData(args);
    if (action === "sceneApply") return await sceneApplyData(args);
    if (action === "imageApply") return await imageApplyData(args);
    if (action === "conditionsSet") return await conditionsSetData(args);
    // M5 战斗集：executeTurn/executeAction 自包异常为回执（rejected/partial/indeterminate），
    // 不向宿主抛；GM 门在入口统一把守
    if (action === "executeTurn") return await executeTurnData(args);
    return await executeActionData(args);
  })
