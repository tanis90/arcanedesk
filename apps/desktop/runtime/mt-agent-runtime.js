// mt-agent-runtime v0.4.0
(async (action, args, options) => {
    // 握手常量（内联，勿引用模块作用域；与文件头 RUNTIME 保持同步）
    const RUNTIME_META = { name: "mt-agent-runtime", version: "0.4.0", protocolVersion: 2 };
    const g = globalThis;

    if (typeof action !== "string" || !action) {
      throw new Error("INVALID_ACTION: action must be a non-empty string");
    }
    if (!["worldInfo", "doctor", "staticContext", "playContext", "battleContext", "turnContext",
      "actorRead", "sceneRead", "contentSearch", "compendiumBrowse",
      "actorCreate", "actorEdit", "actorGrantItems", "sceneApply", "imageApply", "conditionsSet"].includes(action)) {
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
    return await conditionsSetData(args);
  })
