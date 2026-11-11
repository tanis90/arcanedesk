// 阶段8 M2（I1–I8）+ M3（J4–J8）+ M4b（K5）+ M5（executeTurn/executeAction）：ArcaneDesk
// 自写 agent runtime 的只读 + 写集 + 两个战斗 action。
// 宿主（foundry-sdk 客户端，az packages/foundry-sdk/src/client.ts:331 custom runtimeSource）
// 以「函数源串」装载本 runtime 替代 412KB Foundry 原版；契约沿用（ADR D8）：签名
// async (action, args, options)、protocolVersion 握手（az contracts.ts = 2）、错误码约定
// Error("CODE: message")、GM 门 = options.requireGM !== false && !game.user.isGM。
// 本模块无副作用，只注册两个句柄：
//   window.__MT_AGENT_RUNTIME__        —— 页内可直接调用的函数（调试/本仓库门槛）
//   window.__MT_AGENT_RUNTIME_SOURCE__ —— 函数源串（首行 `// mt-agent-runtime v0.8.0`
//     协议头 + 括号包裹表达式；az 端 `(source)(action,args,options)` 包装与裸 eval 均可求值）。
//   宿主装载路径：fetch 本文件 → 取源串（或按协议头行直取源体）→ 装载。
// 铁律：函数体只允许引用页面全局（globalThis 上的 game/canvas/fromUuid/location 等）——
// 源串会脱离本模块作用域求值，任何闭包捕获都会在宿主端 ReferenceError。因此握手常量
// 在函数体内内联（与下方 RUNTIME 保持同步；stage8-m2-verify 有三方一致性断言）。
//
// 大厅能力（lobby actions，2026-11-11）：mt compat lobby 页没有 game，本 runtime 在
// game/ready/GM 门之前薄分发 11 个 lobby action（lobbyImportInspect/Run/Status/Cancel、
// lobbyCampaignsList、lobbyPacksList/Read/DeletePreview/Delete、lobbyCampaignPacksGet/Update）
// 到 globalThis.__MT_LOBBY_SERVICE__——业务真源在 web/lobby-service.mjs（服务会脱离 DOM 执行，
// 不能 import 到这里）。动作语义/版本见 ../arcanedesk/apps/desktop/docs/lobby-actions-plan.md；服务未装配时
// CAPABILITY_UNAVAILABLE，绝不伪造成功。
//
// M2 语义源：az packages/foundry-sdk/src/runtime-source.ts（同 owner Apache-2.0，逻辑自由
// 移植，API 调用按本仓库 shim 实况适配）。契约形状以 az contracts.ts 为准：staticContext/
// playContext :634-675、battleContext :141-181、turnContext :183-221、actorRead :387-408、
// sceneRead :357-369、contentSearch :448-464、compendiumBrowse :479-591；M3 写集：
// actorCreate :421-426、actorEdit :427-433、actorGrantItems :409-411+434、sceneApply :370-385、
// imageApply :413-419+335、conditionsSet :621-627、PlayWriteReceipt :629-632。
// M4b（K5）：conditionsSet——az conditionsSetData 语义移植（显式状态幂等/DAE 守卫/解析期
// 世界焦点变更拒绝/写入期 CONDITION_CHANGED partial/SOURCE_MANAGED 零写/AMBIGUOUS_COMBAT/
// 专注两路），平价线 tools/stage8-m4b-parity.mjs 逐 case 对账 az conditions-set.test.mjs。
// M5：executeTurn（az executeTurnV2Data 移植）+ executeAction（az executeActionData 移植，
// 分发到 executeTurn 的 native 路径 + narrative 扣资源路径），契约 ExecuteTurnInput/
// ExecuteTurnReceipt/PlayExecuteInput（az contracts.ts :232-326、:593-612）；语义规格 =
// az test/execute-action.test.mjs，平价线 tools/stage8-m5-parity.mjs。native summon 是
// 一期边界外（M6 候选）：az 依赖 arcane-dnd5e-2014-automation 模块的 finalize/cancel
// API + AUTO-001 协议——不移植，summon 类 activity 在 executeAction 前置拒绝
// CAPABILITY_UNAVAILABLE（az 同码同文案）、在 executeTurn 不可寻址（ACTION_NOT_FOUND，
// az 对无 marker summon 同码）。M5 相对 az 原版的 shim 适配与降级见 M5 段首注释；另有一处
// 读面兜底：shim 不在构造期跑系统 _migrateData（会重写 legacy damage.parts 破坏旧消费面），
// 旧版 preparation.mode → system.method 的归一由 spellMethodOf 兜底（见该函数注释）。
//
// 阶段 11 M4：advancementPlan / actorAdvance（az 08/09 fragment 移植；契约 contracts.ts
// :446/:467/:552-570）。bySlot 槽位寻址（无共享桶）、全有或全无（缺任一必选零写入整拒：
// ADVANCEMENT_NEEDS_CHOICE 带 need/have；CHOICE_SLOT_UNKNOWN 列合法键）、HP 1 级 max 其余
// avg、绝不静默猜默认、subclass 走「未挂靠临时 item 枚举→写时重映射」、commit 镜像 dnd5e
// 原生四写 + canon 去噪、收尾 HP/法术位拉满 + 特性落地审计 warning + verification 回执。
// 平价线 = az test/actor-advance.test.mjs case 子集（tools/stage11-m4-verify.mjs 本地档）。
// shim 适配（2026-10-24 全授落地后）：fullSpellList 不再依赖模块注解包——职业归属源 =
// studio/spell-classes.json（2014）/ spell-classes24.json（2024）按规则版本加载，pack
// flags.<moduleId>.spellClasses 仅作兼容回退。全表准备职业（2014 cleric/druid/paladin/
// artificer、2024 cleric/druid/paladin/ranger）在 actorAdvance 后整表授予（默认未准备）；
// 映射缺失/无候选 → 前置闸 CAPABILITY_UNAVAILABLE（响亮失败，绝不静默零法术）；非准备
// 表职业仍 INPUT_INVALID（与 az 对非法职业同码同文案路径）。
//
// 阶段 12 M6-A：actorAdvance 的 additionalItems 法术按对应规则版本的职业映射校验合法性
//（classUuid = 目标职业 + 规则版本决定 2014/2024 面；未映射/映射面缺席 fail-open；违规
// SPELL_CLASS_MISMATCH 零写入整拒——assertAdditionalSpellClasses）。
//
// 阶段 12 M6-C：choices.hp 按级区分——只作用于目标级（掷骰结果整数或显式 "avg"），历史级
// 重放以卡面 class 物 HitPoints advancement 已存 value 为准（掷骰史不被平均化重写；数字越界
// 前置整拒 HP_ROLL_OUT_OF_RANGE 零写入）。默认路径（不传 choices.hp）输出与 M6-A/B 逐字节一致。
//
// Agent API 线 M1（task.md 核心契约「apiSurface action」）：读集 action apiSurface——
// 数据来源 = 页面全局 __MT_API_SURFACE__ 注册表（web/api-surface.mjs 装配：手写声明条目 +
// 工厂自动登记条目两级清单，revision 改清单即 +1；bootstrap 顶部静态 import 装入）。实现为
// 纯透传 query(args ?? {})（{prefix?} 过滤），返回体 { revision, defaultPolicy:"unverified",
// domains, entries } 原样上呈不改写。降级：句柄缺席（注册表未装配的构建/环境）抛
// CAPABILITY_UNAVAILABLE: api surface registry not installed——与 image upload 同码族
// （能力缺席，非输入错误）。GM 门与读集同口径：入口统一把守（默认 requireGM）。
//
// Agent API 线 M2（task.md 核心契约「pageEval action」，PRD §3.1）：兜底 eval 一等化 pageEval——
// 包 async 函数体 new Function 执行（顶层 await 可用；promise 一律 await 到底），**落定时刻**对
// SURFACE.snapshot()/diffSince 与 __SPIKE_REPORT__.missing 做 diff 随结果返回：成功
// {status:"completed", value, touched, missing}、失败（包体 throw/reject）{status:"rejected",
// code, message, touched, missing}。code 取既有码族（message 首段 "CODE: "，如 INPUT_INVALID）
// 或 Error.name（SyntaxError/TypeError/…）；value 走 JSON 往返（不可序列化 → rejected
// RESULT_NOT_SERIALIZABLE；无返回值/不可表原语 → value 缺席）；touched 注记从清单查出
// （undeclared 带域归属提示）。包体失败回投页面 error 通道（同步 dispatchEvent → report.mjs
// 既有 classify）——缺失特征既进统计面（PRD §3.2）又落进本回执 missing，不复制 classify 正则。
// **不做**沉降窗/残余缓冲/traceId（2026-10-16 拍板）：未 await 的副作用只由全局
// unhandledrejection/error 监听落统计面。GM 门与写集同档（入口统一把守，默认 requireGM）。
//
// 已知降级（与 docs/stage8-acceptance.md 降级声明一致；返回体 degraded 数组直报）：
//   - conditions/concentration：M4 ActiveEffect 语义层落地后已真值化（statuses 为真派生集，
//     concentrationNameV2 读真 effects）——pre-M4 降级标记已解除（M4b）。
//   - activeBuffRiderIds：M5 起真值化（az playActiveBuffRiderIds 移植——读 item/effect 的
//     arcane 模块 flags 纯数据面，无模块在场也能算）；degraded 标记按 m2 门槛钉保留，
//     语义 = 本桌无 arcane 模块作者、flags 仅手工可置。
//   - 动作目录 availability/declaredRider/block 词汇：全部按 flags 纯数据面判定（az 同名
//     函数移植）；我们不加载该模块——本桌 SRD 物无这些 flags，词汇恒为默认值。
//     battleContext/staticContext 的 degraded 标记（availability:arcane-flags-absent）保留，
//     语义 = 本桌无 arcane flags 作者。summon 类 activity 不入目录，interaction 契约声明
//     （choiceDefault/selectionConstraints/independent-projectiles）不解析——allocation
//     输入恒拒（az 无 flags 时同码）。
//   - sceneRead 的 lights/tiles/notes/sounds：shim 侧是未规格化裸数据，报空数组 + degraded。
//   - actorRead 的 folderId：game.folders 不存在（M3 前无 folder 语义），恒 null。
//   - 无战斗时的 play 焦点：az 用全场景 token；M2 按 M2 指令取 game.user.targets + 选中
//     placeables（空焦点是合法答案——空数组不是错误）。读面（playContext/staticContext）
//     与 M5 executeAction 的焦点/contextRef 同用此口径（客户端读到的 ref 与执行校验
//     同源）；K5 conditionsSet 的写面用 playFocus(true)（az 语义），两口径差异见
//     playFocus 注释。
//   - 叙事法术的槽位池：M5 起对齐 az——playNarrativeCost 经 resolveNativeSpellSlotConsumption
//     （CONFIG.DND5E.spellcasting.getSpellSlotKey 优先，缺席回退单职业 spell<level> 直读）。
//
// M3 写集已知降级/偏差（对照 az runtime，逐条在实现处标注）：
//   - upload 真字节：az 走 FilePicker.upload 落字节到 dataPath；shim 的静态面已实装
//     （页内素材库/缩略图，MT /api/files，TD-C），上传通道探针两要件（静态 upload + __MT_AUTH__
//     凭证）——无会话档（stub/本地）false：image/背景带 upload 仍 rejected CAPABILITY_UNAVAILABLE
//     （dataPath-only）；真实登录档 true（技术债⑤口径，见 prepPrepareImage）。载荷字节的落地仍由
//     调用面 dataPath 直引承担（本 runtime 不代发 POST）。docs/stage8-api-gap.md §3-D。
//   - folders：game.folders 缺席 —— actorCreate/actorEdit 的 folderId 记 warning 跳过
//     （az prepFolder 会写 folder）。
//   - prototypeToken 活实例是 shim 合成 getter（L3 起回读持久化源 _source.prototypeToken +
//     dnd5e 体型映射兜底，name 缺面才随 actor.name 派生）；写经 update 点路径落 _source/REST，
//     验证以 toObject() 持久化源为准（az 读活实例）。
//   - Actor items 的 REST 信封序列化面：阶段8 M4（5332f09）起 #persistEmbedded 信封已携带
//     item flags（J8 幂等标记随持久化走，云端广播回声重建经 ctor 数据展开恢复）——早期
//     「信封不携带 flags」的降级已解除；grantMatchesPlan 的名称+类型匹配保留为防御性兜底。
//   - requestId 幂等重放：az 页内分支返回 partial（"inspect instead"）+ 场景
//     REQUEST_ALREADY_APPLIED，真重放由宿主 operationStore 回放原回执；无宿主时本 runtime
//     以 completed + recovered 标记收口（J8 页内幂等口径，stage8-m3-verify 实测）。
//   - scene.activate()：shim 无此方法 —— active 标志唯一化（其余场景置 false）+
//     __MT_CANVAS_SEMANTICS__.viewScene 切画布，激活步以 canvas.scene.id 双重断言。
//   - az 的 prepValidateDocument（native strict 校验）在 shim 无 validate 面 —— 输入形状
//     校验承担同等职责。
//   - 守卫错误码沿用 az 词汇：READ_REF_INVALID（身份/缺失，宿主 foundry-services.js:88
//     同码预检）/ READ_REF_STALE（受影响字段漂移）。
(() => {
  const RUNTIME = { name: "mt-agent-runtime", version: "0.8.0", protocolVersion: 2 };

  window.__MT_AGENT_RUNTIME__ = async (action, args, options) => {
    // 握手常量（内联，勿引用模块作用域；与文件头 RUNTIME 保持同步）
    const RUNTIME_META = { name: "mt-agent-runtime", version: "0.8.0", protocolVersion: 2 };
    const g = globalThis;

    if (typeof action !== "string" || !action) {
      throw new Error("INVALID_ACTION: action must be a non-empty string");
    }
    // 大厅能力（../arcanedesk/apps/desktop/docs/lobby-actions-plan.md §3.2/§3.3）：源串脱离 ESM 闭包执行，不能捕获
    // lobby-service 的 import——只经页面全局句柄薄分发。lobby 页没有 game，故这组动作
    // 必须排在 game/ready/GM 门之前；服务自身按页面会话做鉴权与写门。
    const LOBBY_ACTIONS = ["lobbyImportInspect", "lobbyImportRun", "lobbyImportStatus", "lobbyImportCancel",
      "lobbyCampaignsList", "lobbyPacksList", "lobbyPackRead", "lobbyPacksDeletePreview", "lobbyPacksDelete",
      "lobbyCampaignPacksGet", "lobbyCampaignPacksUpdate"];
    if (LOBBY_ACTIONS.includes(action)) {
      const lobbyService = g.__MT_LOBBY_SERVICE__;
      if (!lobbyService || typeof lobbyService.dispatch !== "function") {
        throw new Error("CAPABILITY_UNAVAILABLE: lobby service is not installed");
      }
      return await lobbyService.dispatch(action, args ?? {});
    }
    if (!["worldInfo", "doctor", "apiSurface", "staticContext", "playContext", "battleContext", "turnContext",
      "actorRead", "sceneRead", "contentSearch", "compendiumBrowse",
      "actorCreate", "actorEdit", "actorGrantItems", "actorAdvance", "advancementPlan", "sceneApply", "imageApply", "conditionsSet",
      "executeTurn", "executeAction", "pageEval"].includes(action)) {
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
    // az preferExistingRow 两参形态（09 fragment）：arcane 模块包优先——本桌无 arcane 包，
    // isArcanePack 恒 false，单参调用（compendiumBrowse 既有位）退化为「先扫到者胜」，
    // 与旧实现行为等价（M4 起两处共用）
    function isArcanePack(packId) {
      return String(packId ?? "").startsWith("arcane-");
    }
    function preferExistingRow(existing, challengerPackId) {
      return !!existing && (isArcanePack(existing.packId) || !isArcanePack(challengerPackId));
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
      let classIdentifier = null, spellListIdentifiers = null, userScope = null;
      if (type === "spell" && input.classUuid !== undefined) {
        // shim 的 fromUuid 对 Compendium 返回纯数据对象（无 documentName）——以 type 判定
        const classSource = await g.fromUuid(input.classUuid).catch(() => null);
        if (!classSource || classSource.type !== "class" || !isCompendiumUuid(input.classUuid)) {
          throw new Error("SOURCE_NOT_FOUND: exact compendium class required");
        }
        classIdentifier = classSource.system?.identifier ?? null;
        // 用户职业：法术候选只扫同一 user-<module> 命名空间且启用的包，eligibility 读
        // flags.spellClasses 注解（不查 dnd5e registry，也不回退内置同名法术）
        userScope = userModuleScope(input.classUuid);
        if (userScope) {
          userScope.classIdentifier = classIdentifier;
          await assertUserPackGrantable(userScope.packId);
        }
        // dnd5e registry 的职业表标识符集合（spellClasses 模块注解缺失时的回退路径）
        const listEntry = !userScope && classIdentifier ? g.dnd5e?.registry?.spellLists?.forType?.("class:" + classIdentifier) : null;
        spellListIdentifiers = listEntry?.identifiers ?? null;
      }
      const byKey = new Map();
      for (const pack of collectionValues(game.packs)) {
        if (pack?.metadata?.type !== "Item") continue;
        const packId = packIdOf(pack);
        if (userScope && !userPackAllowed(packId, userScope)) continue;
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
            if (userScope) {
              // 注解缺席 fail-open（legal）；可验证且不匹配 → name-match（仍可搜索，不入职业表）
              const onList = userSpellOnClassList(value.flags, [lower(classIdentifier)]);
              eligibility = onList === false ? "name-match" : "legal";
            } else {
              // spellClasses 模块注解缺失（降级声明）——registry 标识符集合为准
              const onList = spellListIdentifiers?.has?.(value.system?.identifier);
              eligibility = onList ? "legal" : "name-match";
            }
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
        return { status: "completed", resolutions, total: resolutions.length,
          warnings: [userScope ? "userpack-scope:eligibility-by-flags" : "spellClasses-annotation-absent:eligency-by-registry-fallback"] };
      }
      const total = matches.length, start = (page - 1) * pageSize;
      return { status: "completed", candidates: matches.slice(start, start + pageSize), total, page,
        nextPage: start + pageSize < total ? page + 1 : null,
        warnings: type === "spell" ? [userScope ? "userpack-scope:eligibility-by-flags" : "spellClasses-annotation-absent:eligibility-by-registry-fallback"] : [] };
    }
    async function contentListCatalog(input, type) {
      if (input.names !== undefined) throw new Error("INPUT_INVALID: names mode resolves spell/item candidates; class/subclass/race catalogs fit on one page");
      const rules = input.rules === undefined ? null : String(input.rules);
      if (rules !== null && !["2014", "2024"].includes(rules)) throw new Error("INPUT_INVALID: rules must be 2014 or 2024");
      let classIdentifier = null, userScope = null;
      if (type === "subclass" && input.classUuid !== undefined) {
        // shim 的 fromUuid 对 Compendium 返回纯数据对象（无 documentName）——以 type 判定
        const classSource = await g.fromUuid(input.classUuid).catch(() => null);
        if (!classSource || classSource.type !== "class" || !isCompendiumUuid(input.classUuid)) {
          throw new Error("SOURCE_NOT_FOUND: exact compendium class required");
        }
        classIdentifier = classSource.system?.identifier ?? null;
        userScope = userModuleScope(input.classUuid);
        if (userScope) {
          userScope.classIdentifier = classIdentifier;
          await assertUserPackGrantable(userScope.packId);
        }
      }
      const byIdentifier = new Map();
      for (const pack of collectionValues(game.packs)) {
        if (pack?.metadata?.type !== "Item") continue;
        const packId = packIdOf(pack);
        if (userScope && !userPackAllowed(packId, userScope)) continue;
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
    // —— 用户内容包（`Compendium.user-<module>.<pack>.<Doc>.<id>`）——
    // 用户包与内置包同形进 game.packs。classUuid 落在 `user-<module>.<pack>` 时，全表授予、
    // ItemChoice 候选、子职业/职业查找只认同一 `user-<module>.` 命名空间且战役启用的包，
    // 绝不用 dnd5e 同名条目替代；内置 classUuid 的 userModuleScope 为 null，原逻辑逐字节不变。
    // 启用面复用 content-sources 的 refs 读面（页面全局转交；runtime 是函数源串，不能静态
    // import）。启用面缺席时只回退 game.settings 的 userPacks 旧档，不把 game.packs 存在当启用。
    function packIdFromUuid(uuid) {
      const parts = String(uuid ?? "").split(".");
      return parts[0] === "Compendium" && parts.length >= 4 ? parts[1] + "." + parts[2] : "";
    }
    function userModuleScope(uuid) {
      const packId = packIdFromUuid(uuid);
      if (!String(packId).startsWith("user-")) return null;
      const dot = packId.indexOf(".");
      const moduleId = dot > "user-".length ? packId.slice("user-".length, dot) : "";
      return moduleId ? { packId, moduleId, namespace: "user-" + moduleId + ".", classIdentifier: null } : null;
    }
    function userScopeForStep(uuid, classIdentifier) {
      const scope = userModuleScope(uuid);
      if (scope) scope.classIdentifier = classIdentifier ?? null;
      return scope;
    }
    function contentSourcesFace() {
      const face = g.__MT_CONTENT_SOURCES__;
      return face && typeof face.isPackEnabled === "function" ? face : null;
    }
    async function ensureUserPackRefs() {
      const face = contentSourcesFace();
      if (typeof face?.ensureCampaignPacks !== "function") return;
      try { await face.ensureCampaignPacks(); } catch { /* 读面失败 → isPackEnabled 自带回退 */ }
    }
    function userPackEnabled(packId) {
      const id = String(packId ?? "");
      const face = contentSourcesFace();
      if (face) {
        try { return face.isPackEnabled(id) !== false; } catch { /* 落到 settings 兜底 */ }
      }
      try {
        const cfg = game.settings?.get?.("mt.compendium", "enabledSources");
        return (cfg?.userPacks?.[id] ?? true) !== false;
      } catch { return true; }
    }
    function userPackAllowed(packId, scope) {
      return !!scope && String(packId ?? "").startsWith(scope.namespace) && userPackEnabled(packId);
    }
    // 停用用户包不得因 game.packs 残留继续授予（class/subclass/race 源与直接 ItemGrant
    // 同闸；启用面未知时 userPackEnabled 回退旧档，不误杀）
    async function assertUserPackGrantable(packId) {
      if (!String(packId ?? "").startsWith("user-")) return;
      await ensureUserPackRefs();
      if (!userPackEnabled(packId)) {
        throw new Error("CAPABILITY_UNAVAILABLE: user content pack is not enabled in this campaign: " + packId);
      }
    }
    // class/subclass/race 文档里的 ItemGrant/ItemChoice 引用（含子职业 -> 特性/法术）在
    // 解析期一次核验：停用用户包不得因 game.packs 残留继续授予。写前抛错 = 零写入整拒。
    async function assertAdvancementSourcesEnabled(datas) {
      const packIds = new Set();
      for (const data of datas) {
        if (!data) continue;
        for (const advancement of collectionValues(data.system?.advancement)) {
          const cfg = advancement?.configuration ?? {};
          const refs = [
            ...collectionValues(cfg.items).map((item) => (typeof item === "string" ? item : item?.uuid)),
            ...collectionValues(cfg.pool).map((item) => item?.uuid),
          ];
          for (const uuid of refs) {
            if (typeof uuid === "string" && uuid.startsWith("Compendium.")) {
              const packId = packIdFromUuid(uuid);
              if (packId) packIds.add(packId);
            }
          }
        }
      }
      for (const packId of packIds) await assertUserPackGrantable(packId);
    }
    function spellClassesFromFlags(flags) {
      for (const value of Object.values(flags ?? {})) {
        if (Array.isArray(value?.spellClasses)) return value.spellClasses;
      }
      return null;
    }
    function isSpellsPack(pack) {
      const name = String(pack?.metadata?.name ?? "").toLowerCase();
      return (name || String(packIdOf(pack) ?? "").split(".").pop().toLowerCase()) === "spells";
    }
    async function userPackPacksForScope(scope, { spellsOnly = false } = {}) {
      const packs = [];
      for (const pack of collectionValues(game.packs)) {
        if (pack?.metadata?.type !== "Item") continue;
        const packId = packIdOf(pack);
        if (!String(packId ?? "").startsWith(scope.namespace) || !userPackEnabled(packId)) continue;
        packs.push(pack);
      }
      if (!spellsOnly) return packs;
      // 「优先/限定本模块 spells」：模块有自己的 spells 包时只扫它；没有才退回同命名空间
      // 全部启用包（成员判定再按 flags.spellClasses 注解收窄）。
      const spellPacks = packs.filter((pack) => isSpellsPack(pack));
      return spellPacks.length ? spellPacks : packs;
    }
    function itemChoiceWantedClasses(cfg, scope) {
      const out = new Set();
      for (const listType of cfg?.restriction?.list ?? []) {
        const text = String(listType);
        const at = text.indexOf("class:");
        if (at >= 0) { const id = lower(text.slice(at + 6)); if (id) out.add(id); }
      }
      const fallback = lower(scope?.classIdentifier);
      if (!out.size && fallback) out.add(fallback);
      return [...out];
    }
    // 返回 true/false = 注解可验证；null = 无注解（调用方按 fail-open 放行）
    function userSpellOnClassList(flags, wanted) {
      const classes = spellClassesFromFlags(flags);
      if (!Array.isArray(classes) || !classes.length) return null;
      const set = new Set(classes.map((name) => lower(name)));
      return wanted.some((name) => set.has(name));
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
    // az prepDataImage + prepPrepareImage 的 dataPath-only 子集：真字节上传通道（az 的
    // image.upload：bytes → 目标路径落地）判据两要件（技术债⑤，TD-C 遗留口径）——① 静态入口
    // FilePicker.upload（bootstrap 素材库实装：位置参数形状，带凭证走 MT /api/files，POST 字节
    // → {path,url}）② 会话句柄 __MT_AUTH__ 的文件服务凭证（accessToken）。旧三要件把「az 字节
    // 应用链」也计入 —— 该链一期边界外，探针恒 false、能力面恒报不可用；TD-C 落地的静态 upload
    // 即通道本体，故改按「本环境能否上传字节」如实判定：stub/无会话档 false（带 upload 仍
    // CAPABILITY_UNAVAILABLE，dataPath-only），真实登录档 true。probe 只回答通道面；载荷字节的
    // 落地仍由调用面的 dataPath 直引承担（本 runtime 不代发 POST，见文件头 M3 写集降级注）。
    function imageUploadChannelAvailable() {
      return typeof g.FilePicker?.upload === "function" && !!g.__MT_AUTH__?.accessToken;
    }
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
      if (image.upload && !imageUploadChannelAvailable()) {
        throw new Error("CAPABILITY_UNAVAILABLE: image upload bytes cannot be applied in this shim (dataPath only)");
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
          await assertUserPackGrantable(packIdFromUuid(entry.uuid));
          source = await g.fromUuid(entry.uuid);
          if (!source) throw new Error("SOURCE_NOT_FOUND: compendium Item not found: " + entry.uuid);
          // shim fromUuid 对 Compendium 返回纯数据（无 documentName）——按 uuid 文档段判型
          const isItem = source.documentName === "Item"
            || (source.documentName == null && String(entry.uuid).split(".")[3] === "Item");
          if (!isItem) throw new Error("SOURCE_MISMATCH: not an Item (" + entry.uuid + ")");
          sourceUuid = entry.uuid;
        } else {
          await assertUserPackGrantable(cleanText(entry.packId));
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
        // 阶段18 M1：法术授予写面归一——dnd5e 5.3.3 卡面按 system.method 分组，pack 源是旧
        // schema（只有 preparation.mode），shim 落卡不跑系统迁移，method 缺失会被
        // _prepareSpellbook 强制归「天生施法」。与 engine.mjs shimApplySpellChanges /
        // spellMethodOf 读面同口径（#migratePreparation 语义）：mode "prepared"→"spell"、
        // 其余模式原样、完全没有 preparation → "spell"（studio 授予即法术书常规法术）；
        // prepared 数值化（"always"→2，布尔→0/1）。只补缺失，不覆盖既有值。
        if (sourceType === "spell") {
          data.system ??= {};
          const prep = data.system.preparation ?? null;
          const mode = typeof prep?.mode === "string" ? prep.mode.trim() : "";
          if (!String(data.system.method ?? "").trim()) {
            data.system.method = mode === "prepared" ? "spell" : (mode || "spell");
          }
          if (data.system.prepared === undefined) {
            data.system.prepared = mode === "always" ? 2 : (prep?.prepared === true ? 1 : 0);
          }
        }
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
    // 阶段 12 M6-A / 阶段 13 全授：职业-法术映射数据面——studio/spell-classes.json（2014 面）
    // 与 studio/spell-classes24.json（2024 面），tools/build-spell-classes.mjs 产物（仓内 SRD
    // 职业表页按 UUID 末段离线生成，值含小写 identifier）。两版 spell id 不重叠。
    // 缓存挂页面全局（源串求值环境无模块作用域，铁律见文件头），按规则版本各一份 Promise；
    // fetch 走页面相对路径（studio/play 页都在 web 根，两处都可解析）；任何加载失败
    //（404/Node 无头档无 location）→ null。null 只在 additionalItems 校验面 fail-open；
    // fullSpellList 自动全授面由 actorAdvance 前置闸以 CAPABILITY_UNAVAILABLE 响亮失败
    const SPELL_CLASS_MAP_PATHS = { "2014": "studio/spell-classes.json", "2024": "studio/spell-classes24.json" };
    function spellClassMapData(rulesVersion = "2014") {
      const face = rulesVersion === "2024" ? "2024" : "2014";
      if (!g.__MT_SPELL_CLASS_MAP_PROMISES__ || typeof g.__MT_SPELL_CLASS_MAP_PROMISES__ !== "object") {
        g.__MT_SPELL_CLASS_MAP_PROMISES__ = {};
      }
      const cache = g.__MT_SPELL_CLASS_MAP_PROMISES__;
      if (cache[face] === undefined) {
        cache[face] = (async () => {
          try {
            const base = g.location?.href;
            if (typeof base !== "string") return null;
            const fetchFn = typeof g.fetch === "function" ? g.fetch : null;
            if (!fetchFn) return null;
            const res = await fetchFn(new URL(SPELL_CLASS_MAP_PATHS[face], base).href);
            if (!res.ok) return null;
            const doc = await res.json();
            return doc?.bySpellId && typeof doc.bySpellId === "object" ? doc.bySpellId : null;
          } catch {
            return null;
          }
        })();
      }
      return cache[face];
    }
    // 校验：grant 计划里的法术必须落在本类表上（classUuid = 本次晋升的目标职业——建卡即
    // 所选职业、升级即目标职业；规则版本决定读 2014 还是 2024 面映射）。未映射法术/映射面
    // 缺席 → 放行（fail-open）；违规抛 SPELL_CLASS_MISMATCH——调用点在 commit 之前，整单
    // 拒绝零写入（与 expectedName 校验同位）
    async function assertAdditionalSpellClasses(grantPlans, classData, classUuid) {
      const wanted = new Set([classData?.name, classData?.system?.identifier]
        .filter(Boolean).map((v) => String(v).toLowerCase()));
      if (!wanted.size) return;
      const classScope = userModuleScope(classUuid);
      if (classScope) await ensureUserPackRefs();
      let bySpellId = null, mapLoaded = false;
      for (const plan of grantPlans) {
        if (plan.sourceType !== "spell") continue;
        const grantPackId = packIdFromUuid(plan.sourceUuid);
        const userGrant = String(grantPackId).startsWith("user-");
        // 用户职业 / 用户包法术：内置职业表不认识用户法术 id（同 id 还可能撞车），一律改用
        // 本包 flags.spellClasses 验证；无注解 = 无法验证 → 按原 fail-open 放行。
        if (classScope || userGrant) {
          const classes = spellClassesFromFlags(plan.data?.flags);
          if (Array.isArray(classes) && classes.length
            && !classes.some((c) => wanted.has(String(c).toLowerCase()))) {
            throw new Error("SPELL_CLASS_MISMATCH: " + JSON.stringify(plan.sourceName)
              + " is not on the " + JSON.stringify(String(classData?.name ?? "target class")) + " spell list");
          }
          continue;
        }
        if (!mapLoaded) { bySpellId = await spellClassMapData(classRulesVersion(classData, classUuid)); mapLoaded = true; }
        if (!bySpellId) continue;
        const classes = bySpellId[String(plan.sourceUuid ?? "").split(".").pop()];
        if (!classes) continue;
        if (!classes.some((c) => wanted.has(String(c).toLowerCase()))) {
          throw new Error("SPELL_CLASS_MISMATCH: " + JSON.stringify(plan.sourceName)
            + " is not on the " + JSON.stringify(String(classData?.name ?? "target class")) + " spell list");
        }
      }
    }
    // 授予源身份匹配：sourceUuid 优先；item flags 在 shim 的 REST 信封序列化面
    // （#persistEmbedded）与广播回声重建（rebuildEmbeddedCollection）中丢失时，退化为
    // 名称+类型匹配（会话内去重口径；同名异源物品会被误判已授——见文件头降级声明，
    // 信封携带 item flags 后恢复 az 精确语义）
    function grantMatchesPlan(item, plan) {
      return item.sourceUuid === plan.sourceUuid
        || (item.sourceUuid == null && item.name === plan.sourceName && item.type === plan.sourceType);
    }
    // 阶段18 M1：存量法术归类修复（幂等）——历史 additionalItems 授予落卡的法术缺
    // system.method，dnd5e 5.3.3 卡面把它们归「天生施法」。升级整单里顺带按写面同口径
    // 补齐卡上 method 缺失的法术；全部已正确 → 零写入零广播（幂等断言面）。
    async function repairLegacySpellMethods(actor) {
      const updates = [];
      for (const item of collectionValues(actor.items)) {
        if (item.type !== "spell") continue;
        const system = item.system ?? {};
        if (String(system.method ?? "").trim()) continue;
        const prep = system._source?.preparation ?? item._source?.system?.preparation ?? system.preparation ?? null;
        const mode = typeof prep?.mode === "string" ? prep.mode.trim() : "";
        updates.push({
          _id: item.id,
          "system.method": mode === "prepared" ? "spell" : (mode || "spell"),
          ...(system.prepared === undefined ? { "system.prepared": mode === "always" ? 2 : (prep?.prepared === true ? 1 : 0) } : {}),
        });
      }
      if (!updates.length) return { repaired: 0 };
      await actor.updateEmbeddedDocuments("Item", updates);
      return { repaired: updates.length };
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
    // —— advancement 授予法术的 legacy preparation 归一（2026-10-24，真栈 2024 cleric 同卡升级实证）——
    // dnd5e 的 SpellConfigurationData.migrateData（web/packages/dnd5e/dnd5e.mjs:41416-41431）把
    // 包源 `configuration.spell.preparation`（"always"/"prepared"/…）迁移成 method + prepared；
    // 而 applySpellChanges（:41443-41450）只在 `this.method` 存在时才写 system.method/prepared。
    // 本 shim 不跑系统 _migrateData（见 shim/data-model 构造器注记），实例上只剩 preparation、
    // method 为空 → always-prepared 的领域法术落卡时 prepared 停在 0。
    // 归一口径对齐 migrateData：preparation==="always" → method 缺省补 "spell"、prepared
    // 缺省补 2；其余 → method 缺省按 preparation（"prepared" 归一 "spell"）、prepared 缺省 0；
    // 随后删 preparation 键。**既有显式值优先**（method 非空 / prepared 非零原样保留）——真核
    // migrateData 的 `!("method" in source)` / `!("prepared" in source)` 判据在这里不可用：
    // shim 的 schema 默认已把两键填成 ""/0（见 shim/data-model 构造器），键存在性不再代表
    // 「作者显式给过」。非零值是可观测的显式作者意图；显式 0 与 schema 默认不可区分，一律按
    // migrateData 的缺省语义处理（always 补 2、其余补 0）。SRD 包 341 条 configuration.spell
    // 均无 method/prepared 与 preparation 并存，故实际数据面与真核等价。
    // applySpellChanges 读的是**实例的** this.method/this.prepared，故实例面必须同步写。
    function normalizeSpellConfiguration(configuration) {
      const spell = configuration?.spell;
      if (!spell || typeof spell !== "object") return false;
      const source = typeof spell.toObject === "function" && spell._source ? spell._source : spell;
      if (!source || typeof source !== "object") return false;
      const hasPreparation = Object.hasOwn(source, "preparation") || Object.hasOwn(spell, "preparation");
      if (!hasPreparation) return false;
      const preparation = source.preparation ?? spell.preparation;
      const explicitMethod = String(spell.method ?? source.method ?? "").trim();
      const explicitPrepared = Number(spell.prepared ?? source.prepared ?? 0) || 0;
      let changed = false;
      const write = (key, value) => {
        if (source[key] !== value) { source[key] = value; changed = true; }
        if (spell !== source && spell[key] !== value) {
          try { spell[key] = value; } catch { /* getter-only：源面已写，读面按源兜底 */ }
        }
      };
      if (preparation === "always") {
        write("method", explicitMethod || "spell");
        write("prepared", explicitPrepared > 0 ? explicitPrepared : 2);
      } else {
        const method = explicitMethod || (preparation ? (preparation === "prepared" ? "spell" : preparation) : "");
        if (method) write("method", method);
        write("prepared", explicitPrepared > 0 ? explicitPrepared : 0);
      }
      try { if (Object.hasOwn(source, "preparation")) { delete source.preparation; changed = true; } } catch { /* 只读 */ }
      try { if (spell !== source && Object.hasOwn(spell, "preparation")) delete spell.preparation; } catch { /* getter-only */ }
      return changed;
    }
    // —— commit 后同源法术合流（2026-10-24）——
    // dnd5e 原生 ItemGrant 的 `existing.has(uuid)` 只在**同一推进实例自己的 value.added[level]**
    // 里去重（dnd5e.mjs:41814）；领域法术（子职业 L3 ItemGrant）与 L1 全授落在同一张卡上时
    // 互不知情 → 同 sourceId 出现两份（真栈实证：Cure Wounds / Bless 各两份、34 而非 32）。
    // 合流放在 commit 之后、additionalItems/spellFill 之前：
    //   · commit 之前 → 后面 prepApplyGrants 的 existing 快照还看不到合流结果，spellFill 会按
    //     旧的重复集去算 skipped/created，回执与卡面不一致；
    //   · spellFill 之后 → 只能事后补救回执，卡面已脏且用户状态被覆盖。
    // 夹在两段授予之间时：卡上先只剩一份（后续 spellFill 的 sourceUuid 去重天然按单份计），
    // 且合流本身只动 type==="spell" 且**两份以上同 sourceUuid**的物品——非 spell 物与
    // 不同 sourceUuid 的物品结构上不进候选。
    // 爆炸半径闸：**只有本次 commit 新建的副本可以作为删除候选**。存量物（玩家手工拖的同
    // 法术、历史档双份、上一级全授）永不删除：保留者从存量里按准备状态选（always-prepared
    // prepared=2 > 已准备 1 > 其余），新副本只把更强的准备状态（2/1 不降级）、缺失的
    // method/sourceItem/advancement flags 补进保留者；没有存量时（同一次 commit 内部就产生
    // 重复）才在新物里按同一优先级留一删余。纯存量重复（本次无新副本）整组跳过、零写入。
    // newItemIds 由调用方传入（commit 前快照的差集）。
    function spellFillMergeKey(item) {
      const source = item?.flags?.arcanedesk?.sourceUuid ?? item?._stats?.compendiumSource
        ?? item?.flags?.dnd5e?.sourceId ?? item?.flags?.core?.sourceId ?? null;
      return String(source ?? "").trim() || null;
    }
    function spellMergeRank(item) {
      const prepared = Number(item?.system?.prepared ?? 0);
      return prepared >= 2 ? 3 : prepared === 1 ? 2 : 0;
    }
    async function mergeDuplicateGrantedSpells(actor, newItemIds = null) {
      const groups = new Map();
      for (const item of collectionValues(actor.items)) {
        if (item.type !== "spell") continue;
        const key = spellFillMergeKey(item);
        if (!key) continue; // 无源身份（手工建物/旧档）不参与——无据可判同源
        const list = groups.get(key);
        if (list) list.push(item); else groups.set(key, [item]);
      }
      const updates = [], removals = [], mergedSources = [];
      for (const [sourceUuid, list] of groups) {
        if (list.length < 2) continue;
        const created = newItemIds ? list.filter((item) => !newItemIds.has(item.id)) : list;
        const retained = newItemIds ? list.filter((item) => newItemIds.has(item.id)) : [];
        // 本次推进没有新建任何同源副本 → 不介入（纯存量重复）
        if (newItemIds && !created.length) continue;
        // 存量优先：不替用户删既有物。没有存量（同一次 commit 就产生重复）才从新物里选。
        const pool = retained.length ? retained : list;
        const ranked = [...pool].sort((a, b) => spellMergeRank(b) - spellMergeRank(a));
        const keeper = ranked[0];
        const duplicates = created.filter((item) => item !== keeper);
        if (!duplicates.length) continue;
        const donors = list.filter((item) => item !== keeper);
        const keeperSystem = keeper.system ?? (keeper.system = {});
        const patch = {};
        if (!String(keeperSystem.method ?? "").trim()) {
          const donor = donors.find((item) => String(item.system?.method ?? "").trim());
          if (donor) patch["system.method"] = donor.system.method;
        }
        const keeperPrepared = Number(keeperSystem.prepared ?? 0) || 0;
        const donorPrepared = donors.reduce((max, item) => Math.max(max, Number(item.system?.prepared ?? 0) || 0), 0);
        if (donorPrepared > keeperPrepared || keeperSystem.prepared === undefined || keeperSystem.prepared === null) {
          patch["system.prepared"] = Math.max(donorPrepared, keeperPrepared);
        }
        for (const [flagPatch, read] of [["system.sourceItem", (item) => item.system?.sourceItem],
          ["flags.dnd5e.advancementOrigin", (item) => item.flags?.dnd5e?.advancementOrigin],
          ["flags.dnd5e.advancementRoot", (item) => item.flags?.dnd5e?.advancementRoot],
          ["flags.dnd5e.sourceId", (item) => item.flags?.dnd5e?.sourceId],
          ["flags.core.sourceId", (item) => item.flags?.core?.sourceId],
          ["flags.arcanedesk.sourceUuid", (item) => item.flags?.arcanedesk?.sourceUuid]]) {
          const own = read(keeper);
          if (own !== undefined && own !== null && own !== "") continue;
          const donor = donors.map(read).find((value) => value !== undefined && value !== null && value !== "");
          if (donor !== undefined) patch[flagPatch] = donor;
        }
        if (Object.keys(patch).length) updates.push({ _id: keeper.id, ...patch });
        for (const duplicate of duplicates) removals.push(duplicate.id);
        mergedSources.push({ sourceUuid, count: list.length, kept: keeper.name ?? null,
          keptPrepared: patch["system.prepared"] ?? keeperSystem.prepared ?? null,
          retained: retained.length, removed: duplicates.map((item) => item.name ?? null) });
      }
      if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
      if (removals.length) await actor.deleteEmbeddedDocuments("Item", removals);
      return { merged: removals.length, updated: updates.length, sources: mergedSources };
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
        // shim 适配：create 载荷的 prototypeToken 曾被数据模型快照丢弃——快照回填（T1）后
        // 构造入参已留在 _source，此步由「功能补写」降级为「协议兼容步」（az 响应 steps
        // 形状保留；update 同值写入被 no-op diff 门静默跳过）；az 为一次性载荷
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
    // =========================================================================
    // —— 阶段 11 M4：advancementPlan / actorAdvance（az 08/09 fragment 移植）——
    // 契约 = az contracts.ts:446 ActorAdvanceInput / :467 AdvancementPlanInput /
    // :552-570 AdvancementPlanResult（bySlot 槽位寻址 / 全有或全无 / 四写 commit）。
    // shim 适配点（相对 az 参考实现）：
    //   - prepAdvancementSource 判型换 uuid 段嗅探（fromUuid 对 Compendium Item 返回
    //     ItemCls 实例：documentName 有、uuid/pack 与 Compendium 串不匹配——按段判型是
    //     既有先例 agent-runtime.js:1167-1172 的口径）；
    //   - getDocumentClass("Item") 换 g.CONFIG?.Item?.documentClass ?? g.Item（:1335 先例）；
    //   - 前置 shim 四桩（bootstrap.mjs）：Document#clone / Document#updateSource（items
    //     路由+dot-path）/ DataModelStub#updateSource（真深赋值+父级源镜像）/
    //     game.items.fromCompendium + fromUuid Compendium-Item 实例化 / clone.reset 别名。
    // =========================================================================
    // az prepPreservationSnapshot（07 fragment）：NPC 天生特质族快照——职业扩展绝不触碰，
    // commit 后 diff 进 verification.preservation
    function prepPreservationSnapshot(actor) {
      const sys = (actor.toObject?.() ?? actor)?.system ?? {};
      const out = {};
      for (const key of ["dr", "di", "dv", "ci", "cv", "senses", "size", "languages"]) {
        out["traits." + key] = sys.traits?.[key] ?? null;
      }
      out["details.type"] = sys.details?.type ?? null;
      out["attributes.movement"] = sys.attributes?.movement ?? null;
      return JSON.parse(JSON.stringify(out));
    }
    // az parseHitDieDenomination：职业 hit die（5.x system.hd.denomination "d6"；pre-3.x
    // system.hitDie）——每调用自源数据解析一次
    function parseHitDieDenomination(system) {
      const raw = system?.hd?.denomination ?? system?.hitDie ?? null;
      const value = parseInt(String(raw ?? "").replace(/^d/i, ""), 10);
      return Number.isFinite(value) ? value : null;
    }
    // az expandTraitPool：通配池键（"languages:*"）经系统特质注册表展开为具体键；具体池
    // 原样透传（Trait.mixedChoices 缺席时保持原键 + 前缀匹配兜底，见 matches()）
    async function expandTraitPool(pool) {
      if (!pool.some((key) => key.endsWith(":*"))) return pool;
      try {
        const Trait = g.dnd5e?.documents?.Trait;
        if (typeof Trait?.mixedChoices !== "function") return pool;
        const expanded = [...(await Trait.mixedChoices(new Set(pool))).asSet()];
        return expanded.length ? expanded : pool;
      } catch { return pool; }
    }
    // —— 种族血统 → 伤害抗性（dr）派生 ——
    // 只做结构识别，不认种族名/包名/颜色：同一 race 内恰好一组 feat 型 ItemChoice 与一组
    // 单池 dr Trait。每个候选 feat 的全部 activity damage.parts[].types 必须收敛到唯一伤害
    // 类型，且该类型在 dr 池中有唯一键（dr:<type>）；多候选映射同一类型合法。任一候选缺
    // activity/类型、映射歧义、组数或数量不符 → null，保留现有手动 dr 选择（绝不猜）。
    function activityDamageTypes(activity) {
      const types = new Set();
      for (const part of collectionValues(activity?.damage?.parts)) {
        const raw = part?.types;
        const list = Array.isArray(raw) ? raw : raw && typeof raw !== "string" ? collectionValues(raw) : [];
        for (const type of list) if (typeof type === "string" && type) types.add(type);
      }
      return types;
    }
    async function detectRaceDamageResistanceDerivation(ctx, managerSteps, scope) {
      const featGroups = [], drGroups = [];
      for (const step of managerSteps) {
        const advancement = step?.flow?.advancement;
        if (!advancement) continue;
        const kind = advancement.constructor.name;
        const cfg = advancement.configuration?.toObject?.() ?? advancement.configuration ?? {};
        if (kind === "ItemChoiceAdvancement" && cfg.type === "feat") {
          const level = step.flow.level ?? 1;
          const count = cfg.choices?.[level]?.count ?? cfg.choices?.[String(level)]?.count ?? 0;
          featGroups.push({ step, cfg, level, count });
        } else if (kind === "TraitAdvancement") {
          // 整个 Trait 必须恰有一个 dr 池，且为默认应用模式；dr + 其他池的混合 Trait
          //（或 upgrade/expertise 语义）不猜（仍旧手动选）
          const pools = Array.isArray(cfg.choices) ? cfg.choices : [];
          if (pools.length !== 1 || (cfg.mode ?? "default") !== "default") continue;
          const pool = Array.from(pools[0]?.pool ?? []).map(String);
          if (!pool.length || !pool.every((key) => key.startsWith("dr:"))) continue;
          drGroups.push({ step, cfg, count: pools[0]?.count ?? 0, pool });
        }
      }
      if (featGroups.length !== 1 || drGroups.length !== 1) return null;
      const feat = featGroups[0], dr = drGroups[0];
      if (feat.count < 1 || feat.count !== dr.count) return null;
      const rawCandidates = (feat.cfg.pool ?? [])
        .map((item) => (typeof item === "string" ? item : item?.uuid))
        .filter((uuid) => typeof uuid === "string" && uuid);
      // 与 ItemChoice 计划同一启用面：停用用户包里的候选不参与派生（也不可选）
      const candidates = scope
        ? rawCandidates.filter((uuid) => userPackAllowed(packIdFromUuid(uuid), scope))
        : rawCandidates;
      if (!candidates.length) return null;
      const byFeat = new Map();
      for (const uuid of candidates) {
        let doc = ctx.candidateDocs.get(uuid);
        if (doc === undefined) {
          doc = await g.fromUuid(uuid).catch(() => null);
          ctx.candidateDocs.set(uuid, doc);
        }
        if (!doc || doc.type !== "feat") return null;
        // 读源数据而非已准备模型：AttackActivity#prepareFinalData 会把 system.damage.base
        // 作为 base/locked 段注入 damage.parts（dnd5e.mjs:28152-28160），那不是血统
        // activity 自带的类型；源 activities 才是数据面真相。
        let source;
        try { source = writePlainData(doc); } catch { return null; }
        const damageTypes = new Set();
        for (const activity of collectionValues(source.system?.activities)) {
          for (const type of activityDamageTypes(activity)) damageTypes.add(type);
        }
        if (damageTypes.size !== 1) return null;
        const key = "dr:" + [...damageTypes][0];
        if (!dr.pool.includes(key)) return null;
        byFeat.set(uuid, key);
      }
      return { featStep: feat.step, drStep: dr.step, byFeat, grants: Array.from(dr.cfg.grants ?? []), count: feat.count };
    }
    // az normalizeAdvancementSteps：原生 AdvancementManager 步骤 → 计划/执行共用的解析面。
    // bySlot 槽位寻址：每个带选择的节点只读 choices.bySlot[自己的槽键]——无共享桶、无破坏性
    // take()、节点间无消费顺序（v9 半精灵事故在槽位寻址下结构性不可能）。
    async function normalizeAdvancementSteps(ctx, label, managerSteps, targetLevel, choices, subclassUuid, handledLevel = 0, scope = null) {
      const plan = { steps: [], automaticSteps: [], choiceRequirements: [], uncovered: [], unmet: [] }, ordinals = {};
      const bySlot = choices.bySlot ?? {};
      // race 计划/执行共用：血统 ItemChoice 可完整派生 dr 时才隐藏手动 dr 槽；识别面任何
      // 异常都回退到原手动逻辑（不因派生探测影响既有种族）
      const derivedDr = label === "race"
        ? await detectRaceDamageResistanceDerivation(ctx, managerSteps, scope).catch(() => null)
        : null;
      const slotValue = (key) => bySlot[key];
      const docFor = async (value) => {
        if (!ctx.candidateDocs.has(value)) ctx.candidateDocs.set(value, await g.fromUuid(value).catch(() => null));
        return ctx.candidateDocs.get(value);
      };
      for (const step of managerSteps) {
        const flow = step?.flow, advancement = flow?.advancement;
        if (!advancement) continue;
        const level = flow.level ?? 1, kind = advancement.constructor.name;
        if (label === "race" && level > targetLevel) continue;
        // handledLevel 语义（对齐真 dnd5e AdvancementManager：升到过的等级不再重放「选择」）。
        // 同职业升级时 enumerateAdvancementStepSets 按卡面同 identifier class 物等级算出
        // handledLevel；level ≤ handledLevel 的 class/subclass 步骤里——选择槽（trait 池/
        // ItemChoice/ASI 浮点）整段跳过：早已落卡，重列即幻影必填（ASI 重填再 +2 的 WIZ5
        // 复利事故）、重放即叠加。自动步骤保留：HitPoints/ScaleValue 是绝对值语义（HP 按
        // 全等级重算总额、scale 档位设置——注入的新 class 物靠它派生），ItemGrant/纯授予
        // Trait 幂等（重放即补授曾缺失的授予）；SubclassAdvancement
        // 的 apply 是 subclass 物的插入通道（克隆里旧物已被摘除，不重放提交后丢子职业），
        // 保留 apply 但不再列入 choiceRequirements（已有子职业由 runtime 从卡面派生补传）。
        const consumed = handledLevel > 0 && label !== "race" && level <= handledLevel;
        const key = label + ":" + level + ":" + kind, ordinal = ordinals[key] = (ordinals[key] ?? -1) + 1;
        const slot = key + ":" + ordinal, title = advancement.title ?? kind;
        const cfg = advancement.configuration?.toObject?.() ?? advancement.configuration ?? {};
        const entry = { slot, level, kind, advancement, step, dataFor: undefined, unmet: null };
        plan.steps.push(entry);
        if (kind === "HitPointsAdvancement") {
          // HP 永不是模型选择：角色 1 级取满骰、后续级取固定均值；NPC 扩展掷怪物体型骰
          // （ctx.hitDie 是演员自身 hd.denomination）且永不取 1 级满骰。choices.hp 是隐藏
          // 覆盖（掷骰 HP），因此不进计划的 choiceRequirements。
          // M6-C 按级区分：choices.hp 只作用于**目标级**（掷骰结果数字/显式 "avg"）；历史级
          // （level < targetLevel 的重放步）用卡面已存 value[level]（掷骰史不被平均化重写——
          // 数字史直传 dnd5e apply，"max"/"avg" 史与旧默认逐字节一致，对照组零变化），缺席才
          // 回退默认。choices.hp 数字越界由 actorAdvanceData 前置整拒（HP_ROLL_OUT_OF_RANGE）
          const historical = level !== targetLevel && ctx.hpHistory?.[level] !== undefined ? ctx.hpHistory[level] : undefined;
          const hpValue = level === targetLevel && choices.hp !== undefined ? choices.hp
            : historical !== undefined ? historical
            : (level === 1 && !ctx.isNpc ? "max" : "avg");
          entry.dataFor = { [level]: hpValue };
          const hitDie = ctx.hitDie;
          plan.automaticSteps.push({ slot, level, kind, label: title,
            summary: Number.isFinite(hitDie)
              ? (typeof hpValue === "number" ? "hp: rolled " + hpValue + " (d" + hitDie + ") + con mod"
                : level === 1 && !ctx.isNpc ? "hp: max hit die (" + hitDie + ") + con mod" : "hp: fixed " + (Math.floor(hitDie / 2) + 1) + " (d" + hitDie + " average) + con mod")
              : "hp: automatic system default" });
        } else if (kind === "TraitAdvancement") {
          const grants = Array.from(cfg.grants ?? []);
          const pools = (Array.isArray(cfg.choices) ? cfg.choices : []).map((c) => ({ count: c.count ?? 0, pool: Array.from(c.pool ?? []).map(String) }));
          // 模型可寻址池：skills/tools/languages、武器熟练、防御族 dr/di/ci/dv；其余
          //（armor/saves/senses）退原生默认（报 uncovered）待矩阵案例
          const isSupportedPool = (pool) => pool.some((k) => k.startsWith("skills:") || k.startsWith("tool:") || k.startsWith("languages:")
            || k.startsWith("weapon:") || k.startsWith("dr:") || k.startsWith("di:") || k.startsWith("ci:") || k.startsWith("dv:"));
          // 专家度槽必须重选更早槽（或卡面）已赋予熟练的特质；landedTraits 按步序累积
          //（同调用内的选择对后面的专家度校验可见——规则依赖，非桶消费）
          const expertiseMode = cfg.mode === "expertise";
          if (pools.length && pools.every((p) => isSupportedPool(p.pool))) {
            const derivedDrHere = !!derivedDr && step === derivedDr.drStep;
            if (derivedDrHere) {
              // 可完整派生的 dr 槽：不列需求、不接受手填（执行期按实际选中 feat 回填）；
              // 仍登记为合法 bySlot 键，调用方旧请求里的冲突 dr 值被静默忽略而非制造组合
              plan.derivedSlots = [slot + ".pool0"];
            }
            if (consumed) continue; // 已消耗级的选择槽：不重列（幻影必填）、不重放
            const chosen = [...grants];
            for (let index = 0; index < pools.length; index += 1) {
              const pool = pools[index], subslot = slot + ".pool" + index;
              if (derivedDrHere) continue;
              const expanded = await expandTraitPool(pool.pool);
              const matches = (value) => expanded.includes(value)
                || pool.pool.some((key) => key.endsWith(":*") && value.startsWith(key.slice(0, -1)));
              plan.choiceRequirements.push({ slot: subslot, level, kind, label: title, count: pool.count, valueFormat: "trait-key", candidates: expanded, required: true,
                ...(cfg.mode && cfg.mode !== "default" ? { mode: cfg.mode,
                  note: cfg.mode === "expertise" ? "every pick must already be proficient — on the sheet or chosen in an earlier skills/tools slot of this same call. Invalid picks reject the whole advance before any write" : undefined } : {}) });
              const raw = slotValue(subslot);
              let picked = null, problem = null;
              if (raw === undefined) { /* missing → need/have below */ }
              else if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) problem = "slot value must be an array of trait keys";
              else if (new Set(raw).size !== raw.length) problem = "duplicate values in slot";
              else {
                const outside = raw.filter((value) => !matches(value));
                if (outside.length) problem = "values outside candidate pool: " + outside.join(", ");
                else if (raw.length === pool.count) picked = raw;
              }
              if (picked) chosen.push(...picked);
              if (!picked) entry.unmet = problem
                ? { slot: subslot, label: title, kind, reason: problem }
                : { slot: subslot, label: title, kind, need: pool.count, have: Array.isArray(raw) ? raw.length : 0 };
              else if (expertiseMode) {
                const invalid = picked.filter((key) => !(ctx.landedTraits ?? new Set()).has(key));
                if (invalid.length) entry.unmet = { slot: subslot, label: title, kind,
                  reason: "expertise picks not proficient: " + invalid.join(", ") + " (also pick them in a skills/tools slot of this call, or choose proficient ones)" };
              } else if (cfg.mode === "default") {
                // 原生 UI 把已熟练特质标「selected」（不可选）。default 池重选不止浪费：
                // TraitAdvancement.apply 无条件写值 1，会把专家度（2）压回熟练（吟游诗人
                // 学识课训）。仅 skills:/tool: 带数值 0/1/2；集合族幂等。
                const redundant = picked.filter((key) => (key.startsWith("skills:") || key.startsWith("tool:"))
                  && (ctx.landedTraits ?? new Set()).has(key));
                if (redundant.length) entry.unmet = { slot: subslot, label: title, kind,
                  reason: "trait picks already proficient: " + redundant.join(", ") + " (on the sheet or chosen in an earlier slot of this call; a default-mode re-pick would overwrite expertise back to proficiency)" };
              }
            }
            if (!derivedDrHere) entry.dataFor = { chosen };
            // 赋熟练的槽按原生管理器的应用序扩展 landed 集，供后面的专家度校验
            if (!expertiseMode) {
              for (const key of chosen) {
                if (key.startsWith("skills:") || key.startsWith("tool:")) (ctx.landedTraits ??= new Set()).add(key);
              }
            }
          } else if (pools.length) {
            if (consumed) continue; // 已消耗级：不可枚举池不重列不重放
            plan.uncovered.push({ slot, level, kind, label: title, reason: "trait pools outside skills/tools/languages/dr/di/ci/dv fall back to native defaults" });
            entry.dataFor = await advancement.automaticApplicationValue(level, { initial: true });
            if (entry.dataFor === false || entry.dataFor == null) entry.unmet = { slot, label: title, kind, reason: "native default unavailable" };
            else plan.automaticSteps.push({ slot, level, kind, label: title, summary: "native default trait selection" });
          } else {
            entry.dataFor = { chosen: grants };
            plan.automaticSteps.push({ slot, level, kind, label: title, summary: "grant " + grants.length + " traits" });
          }
        } else if (kind === "ItemChoiceAdvancement") {
          const perLevel = cfg.choices?.[level] ?? cfg.choices?.[String(level)];
          const count = perLevel?.count ?? 0;
          if (!count) { plan.automaticSteps.push({ slot, level, kind, label: title, summary: "no choice at level " + level }); continue; }
          if (consumed) continue; // 已消耗级的选择槽：不重列（幻影必填）、不重放
          const rawPoolUuids = (cfg.pool ?? []).map((item) => item?.uuid).filter(Boolean);
          const hasPool = rawPoolUuids.length > 0;
          // 用户包步骤的显式 pool 也按启用面过滤：停用包的 UUID 不进候选/不接受提交
          const poolUuids = new Set(scope ? rawPoolUuids.filter((uuid) => userPackAllowed(packIdFromUuid(uuid), scope)) : rawPoolUuids);
          const restrictionLevel = parseInt(cfg.restriction?.level), restrictionLists = Array.from(cfg.restriction?.list ?? []).map(String);
          // 空池 = 「按 restriction 挑任意」——dnd5e 对高精灵戏法等的标准编码（pool:[],
          // restriction:{level:"0"}）；枚举同一集合让计划能回答「可以挑什么」。不可枚举形状
          //（level "available"、无 type）保持 candidates:null。
          const candidates = hasPool ? [...poolUuids] : await enumerateItemChoicePoolCandidates(cfg, ctx.rules, scope);
          plan.choiceRequirements.push({ slot, level, kind, label: title, count, valueFormat: "pool-uuid", candidates, required: true });
          const raw = slotValue(slot);
          let picked = null, problem = null;
          if (raw === undefined) { /* missing → need/have below */ }
          else if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) problem = "slot value must be an array of compendium UUIDs";
          else if (new Set(raw).size !== raw.length) problem = "duplicate values in slot";
          else if (raw.length === count) {
            const outside = [];
            for (const value of raw) {
              if (hasPool) { if (!poolUuids.has(value)) outside.push(value); continue; }
              const doc = await docFor(value);
              if (!doc || (doc.documentName !== undefined && doc.documentName !== "Item")
                || (cfg.type && doc.type !== cfg.type)) { outside.push(value); continue; }
              if (cfg.type === "spell" && !Number.isNaN(restrictionLevel) && doc.system?.level !== restrictionLevel) { outside.push(value); continue; }
              if (scope) {
                // 用户步骤：必须落在同一命名空间且启用的包；法术有注解时按目标职业校验，
                // 无注解 fail-open。不再查 dnd5e registry（用户法术不在内置表）。
                if (!userPackAllowed(packIdFromUuid(value), scope)) { outside.push(value); continue; }
                if (cfg.type === "spell") {
                  const wanted = itemChoiceWantedClasses(cfg, scope);
                  if (wanted.length && userSpellOnClassList(doc.flags, wanted) === false) { outside.push(value); continue; }
                }
                continue;
              }
              if (cfg.type === "spell" && restrictionLists.length) {
                const lists = restrictionLists.map((listType) => g.dnd5e?.registry?.spellLists?.forType?.(listType)).filter(Boolean);
                if (lists.length && !lists.some((list) => list.has?.(doc))) outside.push(value);
              }
            }
            if (outside.length) problem = "values outside candidate pool: " + outside.join(", ");
            else picked = raw;
          }
          if (!picked) entry.unmet = problem
            ? { slot, label: title, kind, reason: problem }
            : { slot, label: title, kind, need: count, have: Array.isArray(raw) ? raw.length : 0 };
          else entry.dataFor = { selected: picked };
        } else if (kind === "ItemGrantAdvancement") {
          const items = cfg.items ?? [], requiredItems = items.filter((item) => !item.optional).map((item) => item.uuid);
          const optional = items.filter((item) => item.optional).map((item) => item.uuid);
          if (cfg.optional) {
            plan.uncovered.push({ slot, level, kind, label: title, reason: "optional grant is not expressible in choices" });
            entry.unmet = { slot, label: title, kind, reason: "optional-grant-unsupported" };
          } else {
            entry.dataFor = { selected: requiredItems };
            plan.automaticSteps.push({ slot, level, kind, label: title, summary: "grant " + requiredItems.length + " items", optionalSkipped: optional.length ? optional : undefined });
          }
        } else if (kind === "SubclassAdvancement") {
          if (!consumed) plan.choiceRequirements.push({ slot, level, kind, label: title, count: 1, valueFormat: "subclass-uuid", required: true });
          // 已消耗级：apply 保留（subclass 物插入通道——克隆旧物已摘除），槽不列、不强制
          if (!subclassUuid) entry.unmet = consumed ? null : { slot, label: title, kind, reason: "subclassUuid" };
          else entry.dataFor = { uuid: subclassUuid };
        } else if (kind === "AbilityScoreImprovementAdvancement") {
          const fixed = cfg.fixed ?? {}, points = cfg.points ?? 0, cap = cfg.cap ?? 2, locked = new Set(cfg.locked ?? []);
          const fixedBonus = Object.fromEntries(Object.entries(fixed).filter(([, value]) => Number(value)).map(([ability, value]) => [ability, Number(value)]));
          const fixedTotal = Object.values(fixedBonus).reduce((total, value) => total + value, 0);
          const fixedSummary = fixedTotal
            ? "fixed ability bonuses: " + Object.entries(fixedBonus).map(([ability, value]) => ability + "+" + value).join(", ") : null;
          if (points <= 0) {
            // dnd5e 只在 options.initial 下注入 configuration.fixed，而我们避开 initial（它会
            // 丢弃别处的显式选择）；固定加值直接以 assignments 传入
            entry.dataFor = { type: "asi", assignments: { ...fixed } };
            plan.automaticSteps.push({ slot, level, kind, label: title, summary: fixedSummary ?? "no ability change" });
          } else {
            const allowFeat = !!advancement.allowFeat;
            // 固定+浮动混合（半精灵：cha+2 固定 + 2 浮动）：固定部分必须并入同一 assignments
            //——dnd5e 存 value.assignments = fixed + floating，其流程按 assignments 减 fixed
            // 算已花费点。我们的 apply 路径不传 options.initial，固定值永不自动应用（v9：
            // +2 cha 丢失）。
            if (fixedSummary) plan.automaticSteps.push({ slot, level, kind, label: title, summary: fixedSummary });
            if (consumed) continue; // 已消耗级的 ASI：不重列（幻影必填）、不重放（WIZ5 复利事故根因）
            plan.choiceRequirements.push({ slot, level, kind, label: title, count: points, valueFormat: allowFeat ? "asi-or-feat" : "asi-assignment", required: true, cap,
              ...(allowFeat ? { note: "fill with { abilityScore: {...} } (floating points only, fixed is automatic) or { feat: \"<uuid>\" }" } : {}) });
            const raw = slotValue(slot);
            const isObject = raw !== null && typeof raw === "object" && !Array.isArray(raw);
            const floating = isObject ? raw.abilityScore : null;
            const featUuid = isObject ? raw.feat : null;
            const needText = "abilityScore (" + points + " floating points, cap " + cap + ")" + (allowFeat ? " or one feat UUID" : "");
            if (raw === undefined) entry.unmet = { slot, label: title, kind, need: needText };
            else if (!isObject) entry.unmet = { slot, label: title, kind, reason: allowFeat ? "slot value must be { abilityScore: {...} } or { feat: \"<uuid>\" }" : "slot value must be { abilityScore: {...} }" };
            else if (floating && featUuid) entry.unmet = { slot, label: title, kind, reason: "provide either abilityScore or feat, not both" };
            else if (featUuid !== undefined && featUuid !== null) {
              if (typeof featUuid !== "string") entry.unmet = { slot, label: title, kind, reason: "feat must be a compendium UUID string" };
              else {
                // 用户 feats 包同样走启用闸：停用包不得因 game.packs 残留被 ASI 专长槽授予
                await assertUserPackGrantable(packIdFromUuid(featUuid));
                const doc = await docFor(featUuid);
                if (!doc || (doc.documentName !== undefined && doc.documentName !== "Item")) entry.unmet = { slot, label: title, kind, reason: "feat UUID does not resolve to an Item: " + featUuid };
                else entry.dataFor = { type: "feat", uuid: featUuid };
              }
            } else if (floating && typeof floating === "object" && !Array.isArray(floating)) {
              const abilities = g.CONFIG?.DND5E?.abilities, entries = Object.entries(floating);
              const invalid = entries.some(([ability, value]) => !Number.isInteger(value) || value < 1 || value > cap || locked.has(ability)
                || (abilities && !abilities[ability]));
              const total = entries.reduce((sum, [, value]) => sum + value, 0);
              if (invalid || total !== points) entry.unmet = { slot, label: title, kind,
                reason: "abilityScore must use valid unlocked abilities, <= " + cap + " each, totaling exactly " + points + " (floating points; fixed bonuses apply on top)" };
              else {
                const assignments = { ...fixedBonus };
                for (const [ability, value] of entries) assignments[ability] = (assignments[ability] ?? 0) + value;
                entry.dataFor = { type: "asi", assignments };
              }
            } else entry.unmet = { slot, label: title, kind, need: needText };
          }
        } else if (kind === "ScaleValueAdvancement") {
          entry.dataFor = await advancement.automaticApplicationValue(level, { initial: true });
          if (entry.dataFor === false || entry.dataFor === undefined || entry.dataFor === null) entry.unmet = { slot, label: title, kind, reason: "no native default" };
          else {
            // automaticApplicationValue 对 scale 恒 {}；每级骰/加值在 configuration.scale[level]
            //（{number, faces} 或 {value}）
            const perLevel = cfg.scale?.[level] ?? cfg.scale?.[String(level)];
            const rendered = perLevel?.faces ? (perLevel.number ?? 1) + "d" + perLevel.faces
              : perLevel?.value !== undefined ? String(perLevel.value) : null;
            plan.automaticSteps.push({ slot, level, kind, label: title, ...(rendered ? { summary: "scale: " + rendered } : {}) });
          }
        } else {
          entry.dataFor = await advancement.automaticApplicationValue(level, { initial: true });
          if (entry.dataFor === false || entry.dataFor === undefined || entry.dataFor === null) entry.unmet = { slot, label: title, kind, reason: "no native default" };
          else {
            // 无专属分支的类型（Size、ScaleValue、…）也要告诉模型会落什么：没有值则计划
            // 逼迫源读回（v4 A2 读人类种族 4 次找 size/scale 细节）
            let dataSummary;
            try { dataSummary = JSON.stringify(entry.dataFor); } catch { dataSummary = null; }
            plan.automaticSteps.push({ slot, level, kind, label: title,
              ...(dataSummary && dataSummary !== "{}" ? { summary: dataSummary.slice(0, 120) } : {}) });
          }
        }
        if (entry.unmet) plan.unmet.push(entry.unmet);
      }
      // 执行期派生：按该血统 ItemChoice 实际通过校验的选中 UUID 回填 dr:<type>；计划期
      // choices 为空（只隐藏手动槽）。映射不完整时 derivedDr 为 null，整段不执行。
      if (derivedDr) {
        const featEntry = plan.steps.find((entry) => entry.step === derivedDr.featStep);
        const selected = featEntry?.dataFor?.selected;
        if (Array.isArray(selected) && selected.length === derivedDr.count) {
          const derived = selected.map((uuid) => derivedDr.byFeat.get(uuid));
          if (derived.every(Boolean)) {
            const drEntry = plan.steps.find((entry) => entry.step === derivedDr.drStep);
            if (drEntry) drEntry.dataFor = { chosen: [...derivedDr.grants, ...new Set(derived)] };
          }
        }
      }
      return plan;
    }
    // az prepAdvancementSource 的 shim 适配：Compendium 源校验。fromUuid 对 Compendium Item
    // 返回 ItemCls 实例（M4 桩④-a）——documentName 有面，但 uuid getter 是文档链路径
    // （Document.<id>，无父链）与 Compendium 串不匹配、pack 无面：按 uuid 段嗅探判型
    //（agent-runtime.js:1167-1172 先例），数据经 writePlainData 归一。
    async function prepAdvancementSource(uuid, documentName) {
      if (typeof uuid !== "string" || !uuid || uuid.length > 256) throw new Error("INPUT_INVALID: source UUID required");
      const parts = uuid.split(".");
      if (!isCompendiumUuid(uuid) || parts[3] !== documentName) {
        throw new Error("SOURCE_NOT_FOUND: exact compendium " + documentName + " source required");
      }
      await assertUserPackGrantable(packIdFromUuid(uuid));
      const source = await g.fromUuid(uuid);
      if (!source) throw new Error("SOURCE_NOT_FOUND: exact compendium source required");
      const data = writePlainData(source);
      // shim 适配：本桌 SRD 包的 class 物仍存 legacy system.hitDice（"d10"），而实例化
      // toObject 会被 schema 默认 hd.denomination="d6" 污染（shim 不跑系统迁移，构造期
      // 只补默认值——真包无 legacy 键时默认值即真值）——legacy 键在场时以它为准覆写，
      // 等价 dnd5e 5.x 的 hitDice → hd.denomination 迁移语义。HitPoints 步骤与 ctx.hitDie
      // 都读 hd.denomination
      if (data.type === "class" && data.system?.hitDice) {
        data.system.hd = { ...(data.system.hd ?? {}), denomination: String(data.system.hitDice).replace(/^d/i, "d") };
      }
      return data;
    }
    // handledLevel：卡面已有同 identifier class 物时的当前职业等级（真 dnd5e 的「升到过的
    // 等级不重放」口径）。创建流/兼职（卡上无此职业）= 0，行为不变。
    function advancementHandledLevel(actor, classData) {
      const identifier = classData?.system?.identifier ?? null;
      if (!identifier) return 0;
      return Math.max(0, ...collectionValues(actor.items)
        .filter((item) => item.type === "class" && item.system?.identifier === identifier)
        .map((item) => Number(item.system?.levels) || 0));
    }
    // M6-C：卡面 class 物 HitPoints advancement 的已存 value 表（{level: "max"|"avg"|掷骰数}）。
    // 同职业升级重放 1..targetLevel 时历史级以此为准——掷骰史不被平均化重写（clone 里旧 class
    // 物已被摘除，注入的包源 advancement.value 恒空，历史必须从演员侧取）
    function actorHpHistory(actor, classData) {
      const identifier = classData?.system?.identifier ?? null;
      if (!identifier) return {};
      for (const item of collectionValues(actor.items)) {
        if (item.type !== "class" || item.system?.identifier !== identifier) continue;
        // 形状二态（feat-right-actor C 泳道建物迁移落地后）：包源 legacy `advancement` 是素数组，
        // 真核建物迁移（dnd5e.mjs ClassData._migrateData → AdvancementTemplate.#migrateStorage）
        // 会把它转成 {id: 条目} 映射；卡面物已迁移时裸 for...of 即「object is not iterable」。
        // collectionValues 数组/映射/集合三态通吃（同文件 activities()/advancementHandledLevel 口径）。
        for (const adv of collectionValues(item.system?._source?.advancement ?? item.system?.advancement)) {
          if (String(adv?.type ?? "") !== "HitPoints") continue;
          if (adv.value && typeof adv.value === "object" && !Array.isArray(adv.value)) return adv.value;
        }
      }
      return {};
    }
    // 同职业升级时从卡面派生子职业源（页面在计划不再列出 subclass 槽后不会再传 subclassUuid，
    // 而克隆里旧 subclass 物已被摘除、靠 SubclassAdvancement.apply 重插——不派生提交后丢子职业）
    function deriveActorSubclassUuid(actor, classData) {
      const identifier = classData?.system?.identifier ?? null;
      if (!identifier) return null;
      for (const item of collectionValues(actor.items)) {
        if (item.type !== "subclass" || (item.system?.classIdentifier ?? null) !== identifier) continue;
        const uuid = item.flags?.dnd5e?.sourceId ?? item.flags?.dnd5e?.advancementOrigin ?? null;
        if (typeof uuid === "string" && isCompendiumUuid(uuid)) return uuid;
      }
      return null;
    }
    // —— 2024 建卡线 M4：同职业升级重放的 characterLevel 基准修复 ——
    // 同职业升级走 forNewItem：class 物 levels 归零后从 1..targetLevel 重放，而
    // AdvancementManager.createLevelChangeSteps 的 characterLevel 仍按 actor.details.level + offset
    // 计算（actor 是卡面旧等级，offset 从 1 起）——重放出的种族流比真实角色等级高一档：
    // L1→L2 时 3 级物种特性（高等精灵「侦测魔法」、2014 提夫林「炼狱斥责」）提前入卡。
    // 该函数在 vendored dnd5e（web/packages/ 不入库）里，故按实例注入「重放前角色等级
    // 扣掉该职业旧等级」的基准：包装器只在设置了 __mtCharacterLevelBase 的那次调用里把
    // actor 视角换成基准等级，characterLevel = 基准 + offset = 真实角色等级；其余调用
    // （新兼职职业等）零变化。
    function installCharacterLevelBaseFix(Manager) {
      const proto = Manager?.prototype;
      if (!proto || proto.__mtCharacterLevelBaseFix) return;
      const original = proto.createLevelChangeSteps;
      proto.createLevelChangeSteps = function createLevelChangeStepsWithBase(...args) {
        const base = this.__mtCharacterLevelBase;
        if (!Number.isFinite(base)) return original.apply(this, args);
        const actor = this.actor;
        this.actor = { system: { details: { level: base } } };
        try { return original.apply(this, args); }
        finally { this.actor = actor; delete this.__mtCharacterLevelBase; }
      };
      proto.__mtCharacterLevelBaseFix = true;
    }
    // az enumerateAdvancementStepSets：class/race/subclass 三组步骤的枚举面。class 与 race
    // 共用一个工作克隆（逐源提交会互相删除对方刚加的物品）；subclass 走「未挂靠临时 item
    // 枚举→写时重映射」——插进克隆会出现双份子职业卡（各自 advancementOrigin 指向不同 id）。
    async function enumerateAdvancementStepSets(actor, { classData, raceData, raceSourceId = null, subclassData = null, targetLevel }) {
      const AdvancementManager = g.dnd5e?.applications?.advancement?.AdvancementManager;
      if (typeof AdvancementManager?.forNewItem !== "function" || typeof AdvancementManager.flowsForLevel !== "function") {
        throw new Error("CAPABILITY_UNAVAILABLE: dnd5e AdvancementManager is not available");
      }
      installCharacterLevelBaseFix(AdvancementManager);
      const classManager = AdvancementManager.forNewItem(actor, classData);
      const clone = classManager.clone;
      const classItem = classManager.steps.find((step) => step?.class?.item)?.class?.item
        ?? collectionValues(clone.items).find((item) => item.type === "class") ?? null;
      // —— D1 修复：primary 限定槽（classRestriction="primary"）升级重放整槽消失 ——
      // dnd5e 5.3.3 判定源考据（本仓副本 web/packages/dnd5e/dnd5e.mjs）：
      //   · Item5e#isOriginalClass 是 getter，不是字段（:23183-23186）：物须为 class 且已挂靠、
      //     parent.system.details.originalClass 非空，才返回 this.id === originalClass；其余恒
      //     null（未挂靠/非 class 物 → null；null 在下面的 primary 判定里是放行）。
      //   · Advancement#appliesToClass（:6605-6610）：classRestriction==="primary" 仅当
      //     [true, null].includes(isOriginalClass) 放行；"secondary" 反向（要求非原始职业）。
      //   · AdvancementManager.flowsForLevel（:7381）按 appliesToClass 过滤——forNewItem
      //     （:7161-7180）→ createLevelChangeSteps（:7337）在建步骤时就跑这个过滤，故槽在此
      //     整槽消失；只改 originalClass 而不重建步骤救不回已滤掉的槽。
      //   · forNewItem 注入克隆的 class 物持新 randomID，且仅当克隆 originalClass 为空才把
      //     originalClass 指给它（:7169-7171）；同职业升级时克隆沿袭旧物 id → 新物
      //     isOriginalClass=false → cleric/druid「选择戏法」、artificer 戏法等 primary 槽全被滤。
      // 等价面（dnd5e 语义的干净室重述）：卡面「原始职业」= actor.system.details.originalClass
      // 所指的 class 物（创建时的首职业——forNewItem 在克隆 originalClass 为空时指派，
      // :7169-7171；兼职业物随后追加不改它）。记录 id 指不到任何 class 物时（本 runtime 旧版
      // 升级 commit 删旧 class 物却不重指 originalClass，卡面会留悬挂 id），按 dnd5e 自身的
      // 补救口径重指派：Item5e#_onCreate 发现记录指不到物即 _assignPrimaryClass
      // （:13704-13707 → :39405-39409，等级最高的职业；同 dnd5e.mjs:13749-13751 的删除补救）。
      // 本 runtime 升级把旧 class 物摘出克隆、以新物 0..N 重放，故按 dnd5e 自身 forNewItem 的
      // 同款写法（:7169-7171）把克隆 originalClass 重指到新注入物；仅当目标职业确为原始职业
      // ——兼职追加的职业（"secondary"）不动，其 primary 槽保持过滤。重指后按原参数重建等级
      // 步骤：清空 steps + class 物等级归零 + 同函数重跑（此刻克隆状态与 forNewItem 首次建
      // 步骤时一致 → 除 primary 槽回流外零差异）。
      const classIdentifier = classData.system?.identifier ?? null;
      // 判据取「卡面」（演员侧）的 class 物：克隆此刻 = 卡面 + 本次注入的新 class 物，而注入物
      // 的 levels 已被 createLevelChangeSteps 尾步推到目标级（dnd5e.mjs:7357-7361），拿克隆
      // 当判据会把它自己算成「等级最高的职业」。
      const cardClassItems = collectionValues(actor.items).filter((item) => item.type === "class");
      const replacedClassItem = classIdentifier
        ? cardClassItems.find((item) => item.system?.identifier === classIdentifier) ?? null : null;
      const recordedPrimaryId = actor.system?.details?.originalClass ?? null;
      const reassignedPrimary = recordedPrimaryId
        ? [...cardClassItems].sort((a, b) => (Number(b.system?.levels) || 0) - (Number(a.system?.levels) || 0))[0] ?? null
        : null; // 记录为空（从未指派）不介入——保持 dnd5e getter 对 null 的放行语义
      const primaryClassId = cardClassItems.some((item) => item.id === recordedPrimaryId)
        ? recordedPrimaryId : reassignedPrimary?.id ?? null;
      if (classItem && primaryClassId && replacedClassItem?.id === primaryClassId) {
        clone.updateSource({ "system.details.originalClass": classItem.id });
        classManager.steps.length = 0;
        // 重放前角色等级 - 该职业旧等级 = 本次重放的角色等级基准（见 installCharacterLevelBaseFix）
        classManager.__mtCharacterLevelBase = Math.max(0,
          (Number(actor.system?.details?.level) || 0) - (Number(replacedClassItem?.system?.levels) || 0));
        classItem.updateSource({ "system.levels": 0 });
        classManager.createLevelChangeSteps(classItem, classData.system.levels ?? 1);
      }
      // shim 适配（二次升级同职业）：forNewItem 对克隆无脑加新 class 物（新 _id、levels 归零
      // 重走 1..N），克隆里既有的同标识符 class/race/subclass 物不摘除的话，commit 会在演员
      // 上留下双份职业卡（details.level = 旧 1 + 新 N）。az 参考实现同样有此结构（其 e2e 每
      // 职业只升一次未暴露）；此处按「同类型+同 identifier 只留本次注入的」摘旧——commit 的
      // remove 清单随之把旧卡从演员移除，多职业（异 identifier）不受影响
      {
        const identifiers = new Set([
          classData.system?.identifier ? "class:" + classData.system.identifier : null,
          raceData?.system?.identifier ? "race:" + raceData.system.identifier : null,
          subclassData?.system?.identifier ? "subclass:" + subclassData.system.identifier : null,
        ].filter(Boolean));
        const staleIds = [];
        for (const item of [...collectionValues(clone.items)]) {
          if (!["class", "race", "subclass"].includes(item.type)) continue;
          if (item.id === classItem?.id) continue;
          if (!identifiers.has(item.type + ":" + item.system?.identifier)) continue;
          clone.items.delete(item.id);
          staleIds.push(item.id);
        }
        if (staleIds.length) {
          try { clone._source.items = [...clone.items].map(persistEmbeddedItemEnvelope); } catch { /* _source 缺层忽略 */ }
          try { clone.prepareData(); } catch { /* 派生刷新尽力 */ }
        }
      }
      const stepSets = [{ label: "class", steps: classManager.steps }];
      if (raceData) {
        const raceCloneData = { ...raceData, _id: g.foundry?.utils?.randomID?.() ?? "arcanedesk-race-clone" };
        if (raceSourceId) raceCloneData.flags = { ...raceData.flags, dnd5e: { ...raceData.flags?.dnd5e, sourceId: raceSourceId } };
        clone.updateSource({ items: [raceCloneData] });
        const raceItem = clone.items.get(raceCloneData._id);
        const raceSteps = [];
        for (let level = 0; level <= targetLevel; level++) {
          for (const flow of AdvancementManager.flowsForLevel(raceItem, level)) raceSteps.push({ type: "forward", flow });
        }
        stepSets.push({ label: "race", steps: raceSteps });
      }
      if (subclassData) {
        // 临时 item 只为枚举存在——槽键按 flow 序派生，与计划交出的键一致；advance 的应用
        // 循环把这些条目重映射到真正插入的 item 上
        const subclassTempData = { ...subclassData, _id: g.foundry?.utils?.randomID?.() ?? "arcanedesk-subclass-temp" };
        subclassTempData.system = { ...subclassData.system, classIdentifier: classItem?.identifier ?? subclassTempData.system?.classIdentifier };
        // shim 适配：getDocumentClass("Item") → CONFIG.Item.documentClass（flowsForLevel 读
        // item.advancement.byLevel，要求真 Item5e 实例）
        const tempItem = new (g.CONFIG?.Item?.documentClass ?? g.Item)(subclassTempData, { parent: clone });
        const subclassSteps = [];
        for (let level = 1; level <= targetLevel; level++) {
          for (const flow of AdvancementManager.flowsForLevel(tempItem, level)) subclassSteps.push({ type: "forward", flow });
        }
        stepSets.push({ label: "subclass", steps: subclassSteps });
      }
      return { AdvancementManager, clone, classItem, stepSets, handledLevel: advancementHandledLevel(actor, classData) };
    }
    // az actorAdvanceData：解析期全量校验（缺任一必选零写入整拒）→ 克隆上逐步 apply →
    // commit 镜像 dnd5e 原生四写（actor.update isAdvancement + createEmbedded keepId +
    // updateEmbedded diff:false + deleteEmbedded）→ HP/法术位拉满 + 特性落地审计 + 回执
    async function actorAdvanceData(input) {
      let started = false; const steps = [], warnings = [];
      try {
        writeInputGuard(input, "actorAdvance");
        prepWorld(input.world);
        if (!input.requestId || !Number.isInteger(input.targetLevel) || input.targetLevel < 1 || input.targetLevel > 20) {
          throw new Error("INPUT_INVALID: targetLevel and request identity required");
        }
        const actor = await prepActor(input.actorUuid);
        if (actor.type !== "character" && actor.type !== "npc") {
          throw new Error("ACTOR_TYPE_UNSUPPORTED: actorAdvance requires a Character or NPC Actor");
        }
        const preLevel = actor.system?.details?.level ?? null;
        if (!input.readState?.items) throw new Error("READ_REF_INVALID: read Actor items before advancement");
        prepCheckRead(actor, input.readState, []);
        // 回执的六维前后对照基线：commit 前演员零触碰
        const abilitiesBefore = Object.fromEntries(Object.entries(actor.system?.abilities ?? {}).map(([key, ab]) => [key, ab?.value ?? null]));
        // 授予/保留物品计数基线（commit 追加 advancement 物品；additionalItems/spellFill 另记）
        const itemIdsBefore = new Set(collectionValues(actor.items).map((item) => item.id));
        // NPC 扩展基线：职业不得触碰的天生特质族——commit 后 diff 进 verification.preservation
        const preservationBefore = actor.type === "npc" ? prepPreservationSnapshot(actor) : null;
        const choices = input.choices ?? {};
        writePrepObject(choices, ["bySlot", "hp"]);
        if (choices.bySlot !== undefined) {
          if (!choices.bySlot || typeof choices.bySlot !== "object" || Array.isArray(choices.bySlot)) {
            throw new Error("INPUT_INVALID: choices.bySlot must be an object keyed by advancement_plan slot");
          }
          for (const [key, value] of Object.entries(choices.bySlot)) {
            if (!key || key.length > 256) throw new Error("INPUT_INVALID: choices.bySlot keys are plan slot strings");
            if (value === null || value === undefined) throw new Error("INPUT_INVALID: choices.bySlot[" + JSON.stringify(key) + "] must not be null");
          }
        }
        const classData = await prepAdvancementSource(input.classUuid, "Item");
        if (classData.type !== "class") throw new Error("SOURCE_MISMATCH: class Item required");
        classData.system ??= {}; classData.system.levels = input.targetLevel;
        classData.flags = { ...classData.flags, dnd5e: { ...classData.flags?.dnd5e, sourceId: input.classUuid } };
        const classUserScope = userScopeForStep(input.classUuid, classData.system?.identifier);
        // fullSpellList：全表准备职业（2014 cleric/druid/paladin/artificer、2024 cleric/
        // druid/paladin/ranger）在升级后授目标职业等级当前可用的全部本职业非戏法法术（默认
        // 未准备）；其他职业在任何写之前拒绝。前置闸语义（2026-10-24）：映射缺失/无候选
        // 绝不静默成功零法术——响亮失败 CAPABILITY_UNAVAILABLE（能力缺席，非输入错误）
        if (input.fullSpellList !== undefined && typeof input.fullSpellList !== "boolean") {
          throw new Error("INPUT_INVALID: fullSpellList must be a boolean");
        }
        const spellFillList = input.fullSpellList ? (await spellBudgetForClass(classData, input.targetLevel, input.classUuid))?.fullList ?? null : null;
        if (input.fullSpellList && !spellFillList?.count) {
          const rules = classRulesVersion(classData, input.classUuid);
          const identifier = String(classData.system?.identifier ?? "");
          const preparedList = !!SPELL_BUDGET_TABLE[rules]?.[identifier]?.fullList;
          if (!preparedList) {
            // 非准备表职业（wizard/bard/sorcerer/warlock/fighter…）保持 az 同码 INPUT_INVALID
            //（平价线 test 子集钉住）
            throw new Error("INPUT_INVALID: fullSpellList requires a prepared-list class with an annotated spell list");
          }
          const mapPath = SPELL_CLASS_MAP_PATHS[rules];
          const maxLevel = maxSlotLevelForProgression(classData.system?.spellcasting?.progression, input.targetLevel, rules);
          if (maxLevel < 1) {
            throw new Error("CAPABILITY_UNAVAILABLE: fullSpellList for " + JSON.stringify(identifier)
              + " at level " + input.targetLevel + " has no spell slots (" + rules + " progression) — nothing to fill");
          }
          if (classUserScope) {
            // 用户职业不读内置映射面：只报同命名空间启用包的扫描结果，不回退 dnd5e 法术
            await ensureUserPackRefs();
            const scanned = (await userPackPacksForScope(classUserScope, { spellsOnly: true })).map((pack) => packIdOf(pack));
            throw new Error("CAPABILITY_UNAVAILABLE: no " + rules + " " + JSON.stringify(identifier)
              + " spells of level 1-" + maxLevel + " found in the enabled user content packs ("
              + classUserScope.namespace + "*)"
              + (scanned.length ? " — scanned " + scanned.join(", ") : " — no enabled user spell pack"));
          }
          const bySpellId = await spellClassMapData(rules);
          if (!bySpellId) {
            throw new Error("CAPABILITY_UNAVAILABLE: fullSpellList requires the " + rules + " spell class map (" + mapPath
              + "), which this compat world could not load");
          }
          throw new Error("CAPABILITY_UNAVAILABLE: no " + rules + " " + JSON.stringify(identifier)
            + " spells of level 1-" + maxLevel + " found in the loaded spell packs (spell class map " + mapPath + " present)");
        }
        const raceData = input.raceUuid ? await prepAdvancementSource(input.raceUuid, "Item") : null;
        if (raceData && raceData.type !== "race") throw new Error("SOURCE_MISMATCH: race Item required");
        // 子职业源：显式传参优先；同职业升级未传时从卡面派生（handledLevel 语义下页面不再
        // 收到 subclass 槽，但克隆里旧 subclass 物已被摘除、apply 需要源来重插）
        const subclassUuid = input.subclassUuid ?? deriveActorSubclassUuid(actor, classData);
        // 子职业步骤与 class/race 同管道（只应用自动子职业步骤的旧扫除已去）：计划与 advance
        // 派生同一槽宇宙，计划交出的子职业选择键就是 advance 接受的键
        const subclassData = subclassUuid ? await prepAdvancementSource(subclassUuid, "Item") : null;
        if (subclassData && subclassData.type !== "subclass") throw new Error("SOURCE_MISMATCH: subclass Item required");
        await assertAdvancementSourcesEnabled([classData, subclassData, raceData]);
        // 任何世界写之前解析全部原生步骤的选择数据；任一必选缺失（class 或 race）→ 整单
        // 零写拒绝
        const ctx = {
          // 卡面已熟练特质；熟练槽在解析时扩展此集，同调用后面的专家度槽可合法重选
          landedTraits: new Set([...Object.entries(actor.system?.skills ?? {}).filter(([, sk]) => (sk?.value ?? 0) >= 1).map(([key]) => "skills:" + key),
            ...Object.entries(actor.system?.tools ?? {}).filter(([, tool]) => (tool?.value ?? 0) >= 1).map(([key]) => "tool:" + key)]),
          candidateDocs: new Map(), isNpc: actor.type === "npc",
          rules: classRulesVersion(classData, input.classUuid),
          // M6-C：卡面 HP 史（同职业升级的历史级重放基准，见 normalizeAdvancementSteps）
          hpHistory: actorHpHistory(actor, classData),
          hitDie: actor.type === "npc"
            ? (actor.system?.attributes?.hd?.denomination ?? parseHitDieDenomination(classData.system))
            : parseHitDieDenomination(classData.system) };
        // M6-C：choices.hp 前置校验（commit 前零写入）——形状（"avg"/"max" 或整数）+ 掷骰数
        // 范围（1..hitDie；越界 HP_ROLL_OUT_OF_RANGE——页面掷骰结果与骰面不符按数据错处理）。
        // "max" 是创建流 L1 满骰的既有契约（contract.mjs），只作用于目标级
        if (choices.hp !== undefined && choices.hp !== null) {
          if (choices.hp !== "avg" && choices.hp !== "max" && !Number.isInteger(choices.hp)) {
            throw new Error('INPUT_INVALID: choices.hp must be "avg", "max", or an integer hit die roll result');
          }
          if (Number.isInteger(choices.hp) && Number.isFinite(ctx.hitDie)
            && (choices.hp < 1 || choices.hp > ctx.hitDie)) {
            throw new Error("HP_ROLL_OUT_OF_RANGE: choices.hp " + choices.hp + " is outside the d" + ctx.hitDie + " hit die range (1-" + ctx.hitDie + ")");
          }
        }
        const { AdvancementManager, clone, classItem, stepSets, handledLevel } = await enumerateAdvancementStepSets(actor, {
          classData, raceData, raceSourceId: input.raceUuid ?? null, subclassData, targetLevel: input.targetLevel });
        const stepScope = (label) => label === "class" ? classUserScope
          : label === "subclass" ? userScopeForStep(subclassUuid, classData.system?.identifier)
          : label === "race" ? userScopeForStep(input.raceUuid, classData.system?.identifier) : null;
        const resolved = [];
        for (const { label, steps: managerSteps } of stepSets) {
          resolved.push(await normalizeAdvancementSteps(ctx, label, managerSteps, input.targetLevel, choices, subclassUuid, handledLevel, stepScope(label)));
        }
        // 未知槽拒绝：bySlot 键必须逐字来自本计划 choiceRequirements（取代旧的
        // UNCONSUMED_CHOICE 警告——槽位寻址的值不可能「剩下来」）。可完整派生的 dr 槽
        // 已不列需求，但旧请求/手填的该键仍接受并忽略——派生结果不可被覆盖。
        const validSlots = new Set(), derivedSlots = new Set();
        for (const plan of resolved) {
          for (const req of plan.choiceRequirements ?? []) {
            if (req.valueFormat !== "subclass-uuid") validSlots.add(req.slot);
          }
          for (const slot of plan.derivedSlots ?? []) derivedSlots.add(slot);
        }
        const unknownSlots = Object.keys(choices.bySlot ?? {}).filter((key) => !validSlots.has(key) && !derivedSlots.has(key));
        if (unknownSlots.length) {
          throw new Error("CHOICE_SLOT_UNKNOWN: " + unknownSlots.join(", ")
            + " — copy keys verbatim from advancement_plan choiceRequirements[].key (valid: " + [...validSlots].join(", ") + ")");
        }
        const unmet = resolved.flatMap((plan) => plan.unmet ?? []);
        if (unmet.length) {
          throw new Error("ADVANCEMENT_NEEDS_CHOICE: " + unmet.slice(0, 8).map((u) =>
            [u.slot, u.label, u.reason ?? ("need " + u.need + (u.have !== undefined ? ", have " + u.have : ""))].filter(Boolean).join(" ")).join("; "));
        }
        const commit = async () => {
          const object = clone.toObject(), items = object.items ?? []; delete object.items;
          const existing = new Map(collectionValues(actor.items).map((item) => [item.id, item]));
          const create = items.filter((item) => !existing.has(item._id));
          // dnd5e 原生管理器对每个既有物品 diff:false 重写，但克隆往返不是字节稳定（会物化
          // 空 flags.dnd5e 对象等），破坏复制怪物物品的字节保真。advancement 不指向既有物品，
          // 内容真变才重写。
          const canon = (value) => {
            if (Array.isArray(value)) return value.map(canon);
            if (value && typeof value === "object") {
              const out = {};
              for (const key of Object.keys(value).sort()) {
                const entry = canon(value[key]);
                if (entry === undefined) continue;
                if (entry && typeof entry === "object" && !Array.isArray(entry) && !Object.keys(entry).length) continue;
                out[key] = entry;
              }
              return out;
            }
            return value;
          };
          const update = items.filter((item) => {
            const current = existing.get(item._id);
            if (!current) return false;
            return JSON.stringify(canon(current.toObject())) !== JSON.stringify(canon(item));
          });
          const remove = collectionValues(actor.items).map((item) => item.id)
            .filter((id) => !items.some((item) => item._id === id));
          await actor.update(object, { isAdvancement: true });
          if (create.length) await actor.createEmbeddedDocuments("Item", create, { keepId: true, isAdvancement: true });
          if (update.length) await actor.updateEmbeddedDocuments("Item", update, { diff: false, recursive: false, isAdvancement: true });
          if (remove.length) await actor.deleteEmbeddedDocuments("Item", remove, { isAdvancement: true });
          started = true;
        };
        let subclassItemId = null, subclassAdvancements = null;
        // shim 适配：az 直接 entry.advancement.apply——真核心的 updateSource 不重建 system
        // 模型，实例恒挂当前模型上；本 shim 重准备会自 _source 重建（#initSystemModel），
        // 步骤前 class.item.updateSource({system.levels}) 即把实例连同其 _source 一起甩到
        // 脱管模型（镜像写进不进序列化的源）。apply 前按 id 重解析当前集合里的活实例。
        const liveAdvancement = (advancement) => {
          const item = advancement?.item ?? null;
          return item?.advancement?.byId?.[advancement.id] ?? advancement;
        };
        for (const [index, { label }] of stepSets.entries()) {
          const plan = resolved[index];
          for (const entry of plan.steps) {
            if (entry.dataFor === undefined) continue;
            if (entry.step?.class?.item) entry.step.class.item.updateSource({ "system.levels": entry.step.class.level });
            if (label === "subclass") {
              // 子职业条目解析自未挂靠临时 item；写必须走 SubclassAdvancement.apply 真正插入
              // 的 item——授予物品的 advancementOrigin（`${grantingItem.id}.${advancement.id}`）
              // 指向已提交的卡
              const realItem = subclassItemId ? clone.items.get(subclassItemId) : null;
              // M6-E 复审硬化：value.document 捕获+集合扫描双兜底后仍缺席 = 子职业物插入
              // 真失败——warn+continue 会把「特性没落卡的成功」伪装给门槛（M4 起长久 bug 的
              // 庇护所）。apply 循环在 commit 前，抛错即零写入整拒
              if (!realItem) throw new Error("SUBCLASS_ITEM_MISSING: subclass item absent from clone after apply (slot " + entry.slot + ")");
              if (!subclassAdvancements) {
                subclassAdvancements = new Map();
                for (let level = 1; level <= input.targetLevel; level++) {
                  for (const flow of AdvancementManager.flowsForLevel(realItem, level)) {
                    if (flow?.advancement) subclassAdvancements.set(flow.advancement.id, flow.advancement);
                  }
                }
              }
              const realAdvancement = subclassAdvancements.get(entry.advancement.id);
              // 同上：真插入物的 advancement 集与本计划同源同等级枚举，缺失即异常——整拒
              if (!realAdvancement) throw new Error("SUBCLASS_ADVANCEMENT_MISSING: " + entry.advancement.id + " not on inserted subclass item (slot " + entry.slot + ")");
              // legacy preparation 归一（见 normalizeSpellConfiguration）：apply 前对**活的
              // advancement 实例**的 configuration.spell 落 method/prepared，等价于真核在该
              // advancement 构造期跑的 SpellConfigurationData.migrateData。只动 spell 配置，
              // 无 configuration.spell 的 advancement（Trait/ASI/ItemChoice…）零触碰。
              try { normalizeSpellConfiguration(realAdvancement.configuration); } catch { /* 非模型配置保持原样 */ }
              await realAdvancement.apply(entry.level, entry.dataFor, { automatic: true });
              clone.reset();
              steps.push({ label, level: entry.level, kind: entry.kind, slot: entry.slot });
              continue;
            }
            // SubclassValueData.document 解析为已插入的 Item 文档而非裸 id
            const liveAdv = liveAdvancement(entry.advancement);
            // 同上（子职业分支注释）：apply 前的 legacy preparation 归一
            try { normalizeSpellConfiguration(liveAdv?.configuration); } catch { /* 非模型配置保持原样 */ }
            const applied = await liveAdv.apply(entry.level, entry.dataFor, { automatic: true });
            const subclassDoc = entry.kind === "SubclassAdvancement" && entry.dataFor?.uuid ? liveAdv.value?.document : null;
            const insertedSubclassId = typeof subclassDoc === "string" ? subclassDoc : subclassDoc?.id ?? null;
            if (insertedSubclassId) subclassItemId = insertedSubclassId;
            clone.reset();
            if (entry.kind === "SubclassAdvancement" && entry.dataFor?.uuid && !subclassItemId) {
              // shim 下 SubclassAdvancement.apply 的 updateSource 触发重准备、advancement 实例
              // 甩到脱管模型，value.document 捕获落空——按 identifier+classIdentifier 扫描克隆
              // 里刚插入的 subclass 物（race 物实证：updateSource 后集合立即可解析）
              const wantId = subclassData?.system?.identifier ?? null;
              const wantClass = classItem?.identifier ?? null;
              const inserted = collectionValues(clone.items).filter((item) => item.type === "subclass"
                && (!wantId || item.system?.identifier === wantId)
                && (!wantClass || !item.system?.classIdentifier || item.system.classIdentifier === wantClass));
              subclassItemId = inserted[0]?.id ?? null;
            }
            steps.push({ label, level: entry.level, kind: entry.kind, slot: entry.slot });
          }
        }
        // 管理器无 flow 的收尾步只钉职业等级；显式复现
        if (classItem) classItem.updateSource({ "system.levels": input.targetLevel });
        clone.reset();
        // 授予源只读校验；任何世界写之前解析——坏的 expectedName/uuid 整单拒绝而非半授予。
        // M6-A：法术类 grant 追加职业合法性校验（按目标职业的规则版本读对应映射面；未映射
        // fail-open；违规零写入整拒）
        const grantPlans = input.additionalItems?.length ? await prepPrepareGrants(input.additionalItems) : null;
        if (grantPlans) await assertAdditionalSpellClasses(grantPlans, classData, input.classUuid);
        await commit();
        // 同源法术合流（见 mergeDuplicateGrantedSpells 注）：commit 之后、additionalItems/
        // spellFill 之前——后续授予按合流后的单份去重，回执与卡面同源。放在存量 method 修复
        // 之前：先删掉多余副本，修复只处理留下的那一份（更少的写与广播）。
        const spellMerge = await mergeDuplicateGrantedSpells(actor, itemIdsBefore);
        // 阶段18 M1：存量法术归类修复随升级整单（幂等；回执 legacySpellRepair 披露修复数）
        const legacySpellRepair = await repairLegacySpellMethods(actor);
        // advancement 授予物品 = commit 前未见的 id。additionalItems/spellFill 在此快照后落
        // 地、各自记在 createdItems/spellFill 段——回执单独回答「额外攻击/偷袭落了没」
        const advancementItems = collectionValues(actor.items).filter((item) => !itemIdsBefore.has(item.id))
          .map((item) => {
            const activities = item.system?.activities, activityCount = activities ? (activities.size ?? Object.keys(activities).length) : 0;
            return { name: item.name ?? null, type: item.type ?? null, uuid: item.uuid,
              identifier: item.system?.identifier ?? null,
              ...(item.type === "spell" ? { level: item.system?.level ?? 0 } : {}),
              ...(activityCount ? { activities: activityCount } : {}) };
          });
        let grants = { created: [], skippedExisting: [] };
        if (grantPlans) grants = await prepApplyGrants(actor, grantPlans, input.requestId);
        let spellFill = null;
        if (spellFillList?.count) {
          const fillCreated = [], fillSkipped = [];
          for (let i = 0; i < spellFillList.candidates.length; i += 50) {
            const applied = await prepApplyGrants(actor, await prepPrepareGrants(spellFillList.candidates.slice(i, i + 50).map((candidate) => ({ uuid: candidate.uuid }))), input.requestId);
            fillCreated.push(...applied.created); fillSkipped.push(...applied.skippedExisting);
          }
          spellFill = { maxLevel: spellFillList.maxLevel, count: spellFillList.count, created: fillCreated, skippedExisting: fillSkipped };
        }
        prepWorld(input.world);
        // 全新角色（升级前 0 级）以满 HP 收尾：HitPointsAdvancement 按每步当时的 Con mod 累计
        // value 而 max 按最终值派生，升级中途的能力变化（种族 ASI）留下纯建卡漂移。只向上
        // 拉——既有角色（preLevel >= 1）HP 不动。NPC 扩展永不拉：value 原生按步累计、追踪
        // 已有伤害。
        let hpFill = null;
        const settledHp = actor.system?.attributes?.hp ?? {};
        if (preLevel === 0 && actor.type === "character" && Number.isFinite(settledHp.value) && Number.isFinite(settledHp.max) && settledHp.value < settledHp.max) {
          const hpBefore = settledHp.value, hpTarget = settledHp.max;
          await actor.update({ "system.attributes.hp.value": hpTarget });
          hpFill = { before: hpBefore, after: actor.system?.attributes?.hp?.value ?? hpTarget };
        }
        // 全新演员（角色建卡与 NPC 扩展）同样以满法术位收尾：槽位值追踪消耗，只在演员此前
        // 无职业等级时向上拉
        let slotFill = null;
        if (preLevel === 0) {
          const spellsNow = actor.system?.spells ?? {}, slotBefore = {}, slotUpdate = {};
          for (const [key, slot] of Object.entries(spellsNow)) {
            if (!/^(spell\d|pact)$/.test(key)) continue;
            const max = slot?.max ?? 0, value = slot?.value ?? 0;
            if (max > 0 && value < max) { slotBefore[key] = value; slotUpdate["system.spells." + key + ".value"] = max; }
          }
          if (Object.keys(slotUpdate).length) {
            await actor.update(slotUpdate);
            slotFill = { before: slotBefore, after: Object.fromEntries(Object.keys(slotBefore).map((key) => [key, actor.system?.spells?.[key]?.value ?? null])) };
          }
        }
        // 特性落地审计：原生 apply 静默丢弃落不住的——非熟练目标上的专家度（1→2 而非 0→2）、
        // 字段在此演员类型上不存在的授予（dnd5e 5.3 NPCData 无 traits.armorProf/weaponProf）。
        // 逐一上报让模型披露或重规划，而非手工补丁或翻数据模型。
        const traitFamilies = g.CONFIG?.DND5E?.traits ?? null;
        const setHas = (container, sub) => container?.value?.has?.(sub) ?? container?.has?.(sub)
          ?? (Array.isArray(container?.value) && container.value.includes(sub))
          ?? (Array.isArray(container) && container.includes(sub)) ?? false;
        const traitLanded = (key) => {
          if (!traitFamilies) return null;
          // dnd5e 特质值存叶段（weapon:sim:dagger 落 "dagger"、languages:standard:common 落
          // "common"），全余段与叶都接受
          const parts = String(key).split(":"), seg = parts[0], sub = parts.slice(1).join(":"), leaf = parts[parts.length - 1];
          const has = (container) => setHas(container, sub) || (leaf !== sub && setHas(container, leaf));
          if (seg === "skills") return (actor.system?.skills?.[leaf]?.value ?? 0) >= 1;
          if (seg === "tool") return (actor.system?.tools?.[sub]?.value ?? 0) >= 1 || (leaf !== sub && (actor.system?.tools?.[leaf]?.value ?? 0) >= 1);
          if (seg === "saves") return (actor.system?.abilities?.[leaf]?.proficient ?? 0) >= 1;
          const family = traitFamilies[seg] ? seg : (seg.endsWith("s") && traitFamilies[seg.slice(0, -1)]) ? seg.slice(0, -1) : null;
          if (!family) return null;
          if (family === "languages") return has(actor.system?.traits?.languages);
          const path = traitFamilies[family]?.actorKeyPath;
          if (!path) return null;
          const target = String(path).replace(/^system\./, "").split(".").reduce((obj, part) => obj?.[part], actor.system);
          if (target === undefined || target === null) return false;
          return has(target);
        };
        // 同一职业等级重复同样授予（fighter 1：class + subclass + 战斗风格三处甲/武熟练）；
        // 不去重的警告清单会淹没信号
        const warnedKeys = new Set();
        const warnOnce = (warning) => {
          const dedupKey = warning.code + "\n" + warning.value;
          if (warnedKeys.has(dedupKey)) return;
          warnedKeys.add(dedupKey);
          warnings.push(warning);
        };
        for (const plan of resolved) {
          for (const entry of plan.steps ?? []) {
            if (entry.kind !== "TraitAdvancement" || !entry.dataFor?.chosen?.length) continue;
            const mode = entry.advancement?.configuration?.mode;
            if (mode === "expertise") {
              for (const key of entry.dataFor.chosen) {
                const skillKey = String(key).startsWith("skills:") ? String(key).slice(7) : null;
                const toolKey = String(key).startsWith("tool:") ? String(key).slice(5) : null;
                const landed = skillKey ? (actor.system?.skills?.[skillKey]?.value ?? 0) >= 2
                  : toolKey ? (actor.system?.tools?.[toolKey]?.value ?? 0) >= 2 : true;
                if (!landed) warnOnce({ code: "EXPERTISE_NOT_LANDED", value: key,
                  message: key + " was not proficient, so the expertise grant was dropped; pick it in a skills/tools slot of the same call too, or choose an already-proficient trait" });
              }
              continue;
            }
            for (const key of entry.dataFor.chosen) {
              if (traitLanded(key) === false) warnOnce({ code: "TRAIT_GRANT_NOT_LANDED", value: key,
                message: key + " did not land on the actor (this actor type may not have the field in this system version); disclose it rather than hand-patching" });
            }
          }
        }
        // 嵌入文档写（commit 的 race/class 物品）让派生字段落后一个 prepare 周期——新演员回执
        // 读 movement.walk 0 而落定值是 30。重跑准备让下面每个 verification 值反映真实终态。
        try { actor.reset?.(); } catch { /* 派生刷新尽力而为 */ }
        const preservationChanged = preservationBefore ? (() => {
          const after = prepPreservationSnapshot(actor), changed = [];
          for (const key of Object.keys(preservationBefore)) {
            if (JSON.stringify(preservationBefore[key]) !== JSON.stringify(after[key])) {
              changed.push({ path: key, before: preservationBefore[key], after: after[key] });
            }
          }
          return changed;
        })() : null;
        const hp = actor.system?.attributes?.hp ?? {};
        // 逐源 ASI 分解直取解析步骤：每个 ASI 条目的 dataFor.assignments 已含固定种族加值与
        // 模型浮动的合并（槽位寻址，class/race 贡献永不混）。回执按能力答「半精灵 +2 cha
        // 落了没」，无需裸 abilities 转储
        const raceAsi = {}, choiceAsi = {};
        for (const [index, { label }] of stepSets.entries()) {
          const target = label === "race" ? raceAsi : choiceAsi;
          for (const entry of resolved[index]?.steps ?? []) {
            if (entry.kind !== "AbilityScoreImprovementAdvancement" || entry.dataFor?.type !== "asi") continue;
            for (const [ab, value] of Object.entries(entry.dataFor.assignments ?? {})) target[ab] = (target[ab] ?? 0) + (Number(value) || 0);
          }
        }
        const abilities = Object.fromEntries(Object.entries(actor.system?.abilities ?? {}).map(([ab, data]) => [ab,
          { before: abilitiesBefore[ab] ?? null, after: data?.value ?? null, race: raceAsi[ab] ?? 0, asi: choiceAsi[ab] ?? 0 }]));
        const subclassItem = collectionValues(actor.items).find((item) => item.type === "subclass") ?? null;
        // details.race 与种族派生 movement 在 commit 后落后一个自治 prepare 周期（回执读到
        // walk 0 / race null 而落定演员是 30）。直接读嵌入 race item 并按 prepareRace 将应用
        // 的方式兜底
        const raceDoc = collectionValues(actor.items).find((item) => item.type === "race") ?? null;
        const raceItem = actor.system?.details?.race;
        const raceReceiptSource = (raceItem && typeof raceItem === "object" ? raceItem : null) ?? raceDoc;
        const movement = { walk: actor.system?.attributes?.movement?.walk ?? null };
        for (const key of ["fly", "swim", "climb", "burrow"]) {
          const value = actor.system?.attributes?.movement?.[key];
          if (value) movement[key] = value;
        }
        if (raceDoc?.system?.movement) {
          for (const key of ["walk", "fly", "swim", "climb", "burrow"]) {
            const raceValue = raceDoc.system.movement[key];
            if (!movement[key] && raceValue) movement[key] = Number(raceValue) || raceValue;
          }
        }
        const traitSet = (key) => [...(actor.system?.traits?.[key]?.value ?? [])];
        const raceUncovered = resolved.some((plan) => (plan.uncovered ?? []).some((uncovered) => String(uncovered.slot).startsWith("race:")));
        const spellItems = collectionValues(actor.items).filter((item) => item.type === "spell");
        const spellsByLevel = {};
        for (const item of spellItems) {
          const level = item.system?.level ?? 0;
          if (level > 0) spellsByLevel[level] = (spellsByLevel[level] ?? 0) + 1;
        }
        const slots = Object.fromEntries(Object.entries(actor.system?.spells ?? {})
          .filter(([, slot]) => (slot?.max ?? 0) > 0).map(([key, slot]) => [key, slot.max]));
        const castingAbility = actor.system?.attributes?.spellcasting ?? null;
        // 职业 scale 值（偷袭骰、狂暴伤害…）是校验方经 getRollData 探的东西；浮出后回执免裸读
        const scale = {};
        try {
          for (const [classKey, values] of Object.entries(actor.getRollData?.()?.scale ?? {})) {
            const flat = {};
            for (const [scaleKey, scaleValue] of Object.entries(values ?? {})) {
              const resolved = scaleValue && typeof scaleValue === "object" ? scaleValue.value ?? scaleValue.formula ?? null : scaleValue;
              if (typeof resolved === "string" || typeof resolved === "number") flat[scaleKey] = resolved;
            }
            if (Object.keys(flat).length) scale[classKey] = flat;
          }
        } catch { /* roll data 是尽力而为的回执上下文 */ }
        // 授予装备的 activity 计数回答「长剑还有攻击活动吗」（v5 A3 读轻锤 activities）。
        // 按 id 对活物品解析
        const itemsById = new Map(collectionValues(actor.items).map((item) => [item.id, item]));
        const grantActivityCount = (entry) => {
          const doc = itemsById.get(entry?.id), activities = doc?.system?.activities;
          const count = activities ? (activities.size ?? Object.keys(activities).length) : 0;
          return count ? { activities: count } : {};
        };
        // advancementRoot 优先（链解析到顶部授予物）、Origin 兜底
        const spellSourceSplit = (spells) => {
          const out = {};
          for (const spell of spells) {
            const root = spell.flags?.dnd5e?.advancementRoot ?? spell.flags?.dnd5e?.advancementOrigin;
            const rootId = root ? String(root).split(".")[0] : null;
            const originItem = rootId ? itemsById.get(rootId) : null;
            const bucket = originItem?.type === "race" || originItem?.type === "subclass" || originItem?.type === "class" ? originItem.type : "granted";
            out[bucket] = (out[bucket] ?? 0) + 1;
          }
          return out;
        };
        const verification = {
          actorUuid: actor.uuid, type: actor.type, level: actor.system?.details?.level ?? null,
          hp: { value: hp.value ?? null, max: hp.max ?? null,
            ...(actor.system?.attributes?.hd?.max ? { hd: { max: actor.system.attributes.hd.max, denomination: actor.system.attributes.hd.denomination ?? null } } : {}) },
          itemCount: collectionValues(actor.items).length,
          grantedItems: advancementItems,
          preservedItems: (() => {
            const now = new Set(collectionValues(actor.items).map((item) => item.id));
            return [...itemIdsBefore].filter((id) => now.has(id)).length;
          })(),
          ...(preservationChanged ? { preservation: { changed: preservationChanged } } : {}),
          classUuid: collectionValues(actor.items).find((item) => item.type === "class")?.flags?.dnd5e?.sourceId ?? null,
          subclass: subclassItem ? { uuid: subclassItem.flags?.dnd5e?.sourceId ?? subclassItem.flags?.core?.sourceId ?? null, name: subclassItem.name ?? null } : null,
          abilities,
          race: raceReceiptSource ? { uuid: raceReceiptSource.flags?.dnd5e?.sourceId ?? raceReceiptSource.flags?.core?.sourceId ?? null, name: raceReceiptSource.name ?? null, size: actor.system?.traits?.size ?? null } : null,
          movement,
          init: actor.system?.attributes?.init?.total ?? null,
          languages: { applied: traitSet("languages"), ...(raceUncovered ? { note: "race trait pools outside skills/tools/languages used native defaults" } : {}) },
          traits: {
            saves: Object.entries(actor.system?.abilities ?? {}).filter(([, ab]) => (ab?.proficient ?? 0) >= 1).map(([key]) => key),
            skills: Object.entries(actor.system?.skills ?? {}).filter(([, sk]) => (sk?.value ?? 0) >= 1).map(([key]) => key),
            expertise: {
              skills: Object.entries(actor.system?.skills ?? {}).filter(([, sk]) => (sk?.value ?? 0) >= 2).map(([key]) => key),
              tools: Object.entries(actor.system?.tools ?? {}).filter(([, tool]) => (tool?.value ?? 0) >= 2).map(([key]) => key) },
            armor: traitSet("armorProf"), weapons: traitSet("weaponProf"), tools: [...new Set([...traitSet("toolProf"), ...Object.entries(actor.system?.tools ?? {}).filter(([, tool]) => (tool?.value ?? 0) >= 1).map(([key]) => key)])] },
          proficiency: { bonus: actor.system?.attributes?.prof ?? null },
          spellcasting: castingAbility || spellItems.length || Object.keys(slots).length ? {
            ability: castingAbility, slots,
            // 来源拆分：预算计 CLASS 配额，但种族/子职业授予（高精灵戏法、大地结界赠戏法、
            // 魔人位阶法术）落同一张卡。advancementRoot/Origin 是
            // `${grantingItem.id}.${advancement.id}`；解析根物品类型让调用方免裸读对账
            // class-vs-race。直接授予（additionalItems/fullSpellList）无 origin flag →
            // "granted"
            cantrips: spellItems.filter((item) => (item.system?.level ?? 0) === 0).length,
            spells: spellItems.filter((item) => (item.system?.level ?? 0) > 0).length,
            cantripsBySource: spellSourceSplit(spellItems.filter((item) => (item.system?.level ?? 0) === 0)),
            spellsBySource: spellSourceSplit(spellItems.filter((item) => (item.system?.level ?? 0) > 0)),
            ...(Object.keys(spellsByLevel).length ? { byLevel: spellsByLevel } : {}) } : null,
          ...(Object.keys(scale).length ? { scale } : {}),
          ac: { value: actor.system?.attributes?.ac?.value ?? null, calc: actor.system?.attributes?.ac?.calc ?? null },
          resources: collectionValues(actor.items).filter((item) => item.system?.uses?.max)
            .map((item) => ({ item: item.name ?? null, uses: { value: item.system.uses.value ?? null, max: item.system.uses.max } })),
          createdItems: grants.created.map((entry) => ({ ...entry, ...grantActivityCount(entry) })), skippedItems: grants.skippedExisting,
          ...(hpFill ? { hpFill } : {}),
          ...(slotFill ? { slotFill } : {}),
          ...(legacySpellRepair.repaired ? { legacySpellRepair } : {}),
          ...(spellMerge.merged ? { spellMerge } : {}),
          ...(spellFill ? { spellFill: { ...spellFill, created: spellFill.created.map((entry) => ({ ...entry, ...grantActivityCount(entry) })) } } : {}),
        };
        return { status: "completed", steps, verification, warnings };
      } catch (error) {
        return { status: started ? "partial" : "rejected", ...(started ? { retry: false, steps, message: writeErrorMessage(error) } : { code: writeErrorMessage(error).split(":")[0], message: writeErrorMessage(error) }) };
      }
    }
    // —— az 09 fragment：法术预算/类表枚举/槽候选与 advancementPlan ——
    function classRulesVersion(classData, classUuid) {
      if (classData.system?.source?.rules === "2024") return "2024";
      if (typeof classUuid === "string" && classUuid.includes("classes24")) return "2024";
      // 用户包按包名后缀判 2024 面（user-<module>.classes24）；缺省 2014 与内置旧行为一致
      const userScope = userModuleScope(classUuid);
      if (userScope && /24$/.test(String(userScope.packId).split(".").pop() ?? "")) return "2024";
      return "2014";
    }
    // 进阶表在职业等级给到的最高法术位。准备表施法者按此填全类表。
    // 同表唯一权威 = web/shim/derive.mjs 的 maxSlotLevelForProgression（阶段债 P1-4）。本副本
    // 因「函数源串」契约不能改 import——源串脱离本模块作用域在宿主页求值，闭包/导入绑定即
    // ReferenceError（见文件头铁律）。改表须两处同步。
    // 规则版本口径：2014 half 施法者 2 级起有 1 环；2024 half（paladin/ranger）1 级即有 1 环
    //（2024 职业表 L1 直接给一环位）。其余 progression 两版同表。
    function maxSlotLevelForProgression(progression, targetLevel, rulesVersion = "2014") {
      if (progression === "full") return Math.min(9, Math.ceil(targetLevel / 2));
      if (progression === "half") {
        if (rulesVersion === "2024") return Math.min(5, Math.ceil(targetLevel / 4));
        return targetLevel >= 2 ? Math.min(5, Math.ceil(targetLevel / 4)) : 0;
      }
      if (progression === "artificer") return Math.min(5, Math.ceil(targetLevel / 4));
      // 三阶施法者（2014 EK/AT 共用一张 PHB 表）：3 级起步、封顶 4 环
      if (progression === "third") return targetLevel >= 3 ? Math.min(4, Math.ceil(targetLevel / 6)) : 0;
      return 0;
    }
    // 全表准备职业的整表枚举：职业归属源 = 对应规则版本的 spellClassMapData（2014/2024 两份
    // studio 产物，值含小写 identifier），pack flags.<moduleId>.spellClasses 仅作兼容回退
    //（映射面缺席/该法术未被映射时）。法术元数据仍从 pack.getIndex 读（type/system.level/
    // system.source.rules），按目标职业等级 maxLevel、规则版本过滤，level>=1（戏法不入），
    // 按 identifier/_id 去重。返回 { maxLevel, count, candidates }。
    async function fullSpellListForClass(classData, targetLevel, classUuid) {
      const identifier = classData.system?.identifier;
      const rules = classRulesVersion(classData, classUuid);
      const maxLevel = maxSlotLevelForProgression(classData.system?.spellcasting?.progression, targetLevel, rules);
      if (!identifier || maxLevel < 1) return null;
      const wanted = String(identifier).toLowerCase();
      const scope = userModuleScope(classUuid);
      const byIdentifier = new Map();
      if (scope) {
        // 用户职业：只看同一 user-<module> 命名空间且战役启用的包；模块 spells 包优先并限定。
        // 成员判定 = flags.spellClasses 注解（Auto2014 每颗法术都带）——与内置映射缺席时的
        // 兼容回退同口径：注解缺席的法术不进全表（宁缺勿滥，绝不猜包内全部法术都属于本职业）。
        await ensureUserPackRefs();
        const packs = await userPackPacksForScope(scope, { spellsOnly: true });
        for (const pack of packs) {
          const packId = packIdOf(pack);
          const index = await pack.getIndex({ fields: ["type", "name", "system.level", "system.identifier", "system.source.rules", "flags"] }).catch(() => null);
          if (!index) continue;
          for (const entry of collectionValues(index)) {
            if (entry.type !== "spell") continue;
            const level = Number(entry.system?.level);
            if (!Number.isInteger(level) || level < 1 || level > maxLevel) continue;
            const entryRules = entry.system?.source?.rules;
            if (rules === "2024" ? entryRules === "2014" : entryRules === "2024") continue;
            const annotated = spellClassesFromFlags(entry.flags);
            if (!Array.isArray(annotated) || !annotated.some((name) => lower(name) === wanted)) continue;
            const key = entry.system?.identifier ?? entry._id;
            if (byIdentifier.has(key)) continue;
            byIdentifier.set(key, { uuid: "Compendium." + packId + ".Item." + entry._id, name: entry.name, level });
          }
        }
        const candidates = [...byIdentifier.values()].sort((a, b) => a.level - b.level || String(a.name).localeCompare(String(b.name)));
        return { maxLevel, count: candidates.length, candidates };
      }
      const bySpellId = await spellClassMapData(rules);
      for (const pack of collectionValues(game.packs)) {
        if (pack?.metadata?.type !== "Item") continue;
        const index = await pack.getIndex({ fields: ["type", "name", "system.level", "system.identifier", "system.source.rules", "flags"] }).catch(() => null);
        if (!index) continue;
        for (const entry of collectionValues(index)) {
          if (entry.type !== "spell") continue;
          const level = Number(entry.system?.level);
          if (!Number.isInteger(level) || level < 1 || level > maxLevel) continue;
          const entryRules = entry.system?.source?.rules;
          if (rules === "2024" ? entryRules === "2014" : entryRules === "2024") continue;
          const classes = bySpellId?.[String(entry._id ?? "")];
          let member;
          if (Array.isArray(classes) && classes.length) {
            member = classes.some((name) => String(name).toLowerCase() === wanted);
          } else {
            // 映射缺席（整面加载失败/该法术未映射）→ 兼容回退到 pack 注解
            const annotated = Object.values(entry.flags ?? {}).map((flag) => flag?.spellClasses).find((list) => Array.isArray(list));
            member = Array.isArray(annotated) && annotated.includes(identifier);
          }
          if (!member) continue;
          const key = entry.system?.identifier ?? entry._id;
          if (byIdentifier.has(key)) continue;
          byIdentifier.set(key, { uuid: "Compendium." + packIdOf(pack) + ".Item." + entry._id, name: entry.name, level });
        }
      }
      const candidates = [...byIdentifier.values()].sort((a, b) => a.level - b.level || String(a.name).localeCompare(String(b.name)));
      return { maxLevel, count: candidates.length, candidates };
    }
    // 空 ItemChoice 池枚举（按 restriction 等级的法术、无限制专长）：扫 Item 包索引、过滤
    // advancement 的规则版本、按 identifier 去重（arcane 优先）。镜像原生 advancement UI 对
    // 同一 pool:[] + restriction 编码的选物器行为。
    // scope = 用户包步骤（class/subclass/race 的 uuid 落在 user-<module>.<pack>）时只扫同一
    // 命名空间且战役启用的包：法术限定模块 spells 包并按 flags.spellClasses 注解收窄到目标
    // 职业；内置步骤 scope=null，原扫描面逐字节不变。
    async function enumerateItemChoicePoolCandidates(cfg, rules, scope = null) {
      const type = cfg?.type;
      if (type !== "spell" && type !== "feat") return null;
      let level = null;
      if (type === "spell") {
        const raw = cfg?.restriction?.level;
        // "available"（魔法奥秘/玄奥秘法类编码）：dnd5e 语义=当前可用环阶——计划面给全集
        //（提交侧 :1799 的 parseInt("available")=NaN 同口径不裁）。此前非整数直接返回 null
        // 候选，UI 只能「无法在此补选」+必选闸死锁——矩阵 bard 8 链 L10 阻断根因
        if (raw === "available" || raw === undefined || raw === null || raw === "") level = null;
        else {
          level = Number(raw);
          if (!Number.isInteger(level) || level < 0 || level > 9) return null;
        }
      }
      const byKey = new Map();
      if (scope) {
        await ensureUserPackRefs();
        const wanted = type === "spell" ? itemChoiceWantedClasses(cfg, scope) : [];
        const packs = await userPackPacksForScope(scope, { spellsOnly: type === "spell" });
        for (const pack of packs) {
          const packId = packIdOf(pack);
          const index = await pack.getIndex({ fields: ["type", "name", "system.level", "system.identifier", "system.source.rules", "flags"] }).catch(() => null);
          if (!index) continue;
          for (const entry of collectionValues(index)) {
            if (entry.type !== type) continue;
            if (type === "spell" && level !== null && Number(entry.system?.level) !== level) continue;
            const entryRules = entry.system?.source?.rules;
            if (rules === "2024" ? entryRules === "2014" : entryRules === "2024") continue;
            // 注解可验证时必须命中目标职业；无注解 fail-open（用户包可能是无注解旧档）
            if (type === "spell" && wanted.length && userSpellOnClassList(entry.flags, wanted) === false) continue;
            const key = entry.system?.identifier ?? entry._id;
            if (byKey.has(key)) continue;
            byKey.set(key, { uuid: "Compendium." + packId + ".Item." + entry._id, packId, name: entry.name });
          }
        }
        return [...byKey.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))).map((row) => row.uuid);
      }
      for (const pack of collectionValues(game.packs)) {
        if (pack?.metadata?.type !== "Item") continue;
        const packId = packIdOf(pack);
        const index = await pack.getIndex({ fields: ["type", "name", "system.level", "system.identifier", "system.source.rules"] }).catch(() => null);
        if (!index) continue;
        for (const entry of collectionValues(index)) {
          if (entry.type !== type) continue;
          if (type === "spell" && level !== null && Number(entry.system?.level) !== level) continue;
          const entryRules = entry.system?.source?.rules;
          if (rules === "2024" ? entryRules === "2014" : entryRules === "2024") continue;
          const key = entry.system?.identifier ?? entry._id;
          const existing = byKey.get(key);
          if (existing && preferExistingRow(existing, packId)) continue;
          byKey.set(key, { uuid: "Compendium." + packId + ".Item." + entry._id, packId, name: entry.name });
        }
      }
      return [...byKey.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))).map((row) => row.uuid);
    }
    // 2014 三阶施法者已知行：魔能骑士/诡术师共用一张 PHB 表（1-2 级不施法——子职业 3 级才到）
    const THIRD_CASTER_KNOWN = [0, 0, 3, 4, 4, 4, 5, 6, 6, 7, 8, 8, 9, 10, 10, 11, 11, 11, 12, 13];
    // 硬编码 SRD 施法预算（规则文本、1-20 级），仅咨询：模型必须自填戏法与已知/法术书总数。
    // 准备状态/计数与槽位计数刻意缺席：准备是卡面标记（不管理），槽位由 dnd5e 计算。
    // 值对 dnd5e 5.3.3 职业 advancement 校验过（2014 SRD + 2024 PHB + TCE artificer）。
    // fullList 只标全表准备职业——两类规则面各自一份（wizard/bard/sorcerer/warlock 永不标：
    // 法术书/已知法术语义，不自动全授）：
    //   2014：cleric/druid/paladin/artificer（SRD PHB 准备表四职业；paladin 2 级起有位）
    //   2024：cleric/druid/paladin/ranger（2024 PHB 准备表四职业；half 施法者 1 级即有一环位）
    // fullList 是否真生效取决于映射面与 pack 数据：映射缺失/无候选时 actorAdvance 前置闸
    // CAPABILITY_UNAVAILABLE 响亮失败（不再静默零法术）
    const SPELL_BUDGET_CANTIRPS = {
      full3: [3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
      full4: [4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6],
      half2: [2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
      artificer: [2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4],
    };
    const SPELL_BUDGET_TABLE = {
      "2014": {
        bard: { cantrips: SPELL_BUDGET_CANTIRPS.half2, known: [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15, 16, 18, 19, 19, 20, 22, 22, 22] },
        cleric: { cantrips: SPELL_BUDGET_CANTIRPS.full3, fullList: true },
        druid: { cantrips: SPELL_BUDGET_CANTIRPS.half2, fullList: true },
        sorcerer: { cantrips: SPELL_BUDGET_CANTIRPS.full4, known: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 15] },
        warlock: { cantrips: SPELL_BUDGET_CANTIRPS.half2, known: [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15] },
        ranger: { known: [0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11] },
        paladin: { fullList: true },
        wizard: { cantrips: SPELL_BUDGET_CANTIRPS.full3, book: true },
        artificer: { cantrips: SPELL_BUDGET_CANTIRPS.artificer, fullList: true },
      },
      "2024": {
        bard: { cantrips: SPELL_BUDGET_CANTIRPS.half2 },
        cleric: { cantrips: SPELL_BUDGET_CANTIRPS.full3, fullList: true },
        druid: { cantrips: SPELL_BUDGET_CANTIRPS.half2, fullList: true },
        sorcerer: { cantrips: SPELL_BUDGET_CANTIRPS.full4 },
        warlock: { cantrips: SPELL_BUDGET_CANTIRPS.half2 },
        ranger: { fullList: true },
        paladin: { fullList: true },
        wizard: { cantrips: SPELL_BUDGET_CANTIRPS.full3, book: true },
      },
    };
    async function spellBudgetForClass(classData, targetLevel, classUuid, subclassData) {
      const sc = classData.system?.spellcasting;
      if (!sc?.progression || sc.progression === "none") {
        // 子职业引入的施法（2014：仅魔能骑士/诡术师——对本桌全部 Item 包与 PHB 表校验过）。
        // 职业表无此行（fighter/rogue 不施法），已知法术无原生载体（玩家手挑法师法术），
        // 计划必须从此表浮出数量。戏法刻意缺席：它们走子职业自己的 ItemChoice 槽，预算会
        // 双计。位阶选择走 additionalItems（已知语义）
        const subSc = subclassData?.system?.spellcasting;
        if (!subSc?.progression || subSc.progression === "none") return null;
        const rules0 = classRulesVersion(classData, classUuid);
        if (rules0 !== "2014" || subSc.progression !== "third") return null; // 2024 子职业施法未研究
        const budget = { ability: subSc.ability ?? null, progression: subSc.progression, source: "subclass" };
        const known = THIRD_CASTER_KNOWN[targetLevel - 1] ?? null;
        if (known) budget.known = known;
        const maxSpellLevel = maxSlotLevelForProgression("third", targetLevel);
        if (maxSpellLevel) budget.maxSpellLevel = maxSpellLevel;
        // 用户职业的三阶子职业表：同一 user-<module> 命名空间内找 wizard，不得落到内置类表
        const listUuid = await classUuidByIdentifier("wizard", rules0, userModuleScope(classUuid));
        if (listUuid) budget.spellListClassUuid = listUuid;
        // 学派限制是自然语言规则：仅咨询注记，永不校验
        const subId = subclassData.system?.identifier;
        if (subId === "eldritch-knight") budget.note = "Pick from the wizard list; all but one 3rd-level pick and the 8th/14th/20th-level picks must be abjuration or evocation.";
        else if (subId === "arcane-trickster") budget.note = "Pick from the wizard list; all but one 3rd-level pick and the 8th/14th/20th-level picks must be enchantment or illusion; Mage Hand is a fixed bonus cantrip.";
        else budget.note = "Pick from the wizard spell list.";
        return budget;
      }
      const rules = classRulesVersion(classData, classUuid);
      const row = SPELL_BUDGET_TABLE[rules]?.[classData.system?.identifier] ?? {};
      const atLevel = (values) => (Array.isArray(values) ? values[targetLevel - 1] ?? null : null);
      const budget = { ability: sc.ability ?? null, progression: sc.progression };
      const cantrips = atLevel(row.cantrips); if (cantrips) budget.cantrips = cantrips;
      const known = atLevel(row.known); if (known) budget.known = known;
      if (row.book) budget.book = 6 + 2 * (targetLevel - 1);
      if (row.fullList) {
        const fullList = await fullSpellListForClass(classData, targetLevel, classUuid);
        if (fullList) budget.fullList = fullList;
      }
      return budget;
    }
    // 按标识符解析职业 Compendium uuid（共享目录去重偏好：arcane 副本胜）。把子职业施法者
    // 指向其抽取的类表（2014 三阶：法师表），不硬编码包 id。scope = 用户职业时只认同一
    // user-<module> 命名空间且启用的包，不拿内置 wizard 类表替代。
    async function classUuidByIdentifier(identifier, rules, scope = null) {
      let best = null;
      if (scope) await ensureUserPackRefs();
      for (const pack of collectionValues(game.packs)) {
        if (pack?.metadata?.type !== "Item") continue;
        const packId = packIdOf(pack);
        if (scope && !userPackAllowed(packId, scope)) continue;
        const index = await pack.getIndex({ fields: ["type", "system.identifier", "system.source.rules"] }).catch(() => null);
        if (!index) continue;
        for (const entry of collectionValues(index)) {
          if (entry.type !== "class" || (entry.system?.identifier ?? null) !== identifier) continue;
          const entryRules = entry.system?.source?.rules ?? (String(packId).endsWith("24") ? "2024" : "2014");
          if (rules && entryRules !== rules) continue;
          const candidate = { uuid: "Compendium." + packId + ".Item." + entry._id, packId };
          if (scope) { if (!best) best = candidate; }
          else if (!best || !preferExistingRow(best, packId)) best = candidate;
        }
      }
      return best?.uuid ?? null;
    }
    // 子职业发现：扫 Compendium 索引找 system.classIdentifier 匹配职业标识符的子职业文档。
    // 扫全部 Item 包（2024 子职业住 dnd5e.classes24、完整 2014 集可能在模块包）。显式规则
    // 版本不匹配者排除；无版本者保留。按 identifier 去重（arcane 偏好）。
    // scope = 用户职业时只扫同一 user-<module> 命名空间且启用的包（内置子职业不替代）。
    async function subclassCandidatesForClass(classData, classUuid) {
      const identifier = classData.system?.identifier;
      if (!identifier) return null;
      const rules = classRulesVersion(classData, classUuid);
      const scope = userModuleScope(classUuid);
      if (scope) await ensureUserPackRefs();
      const byKey = new Map();
      for (const pack of collectionValues(game.packs)) {
        if (pack?.metadata?.type !== "Item") continue;
        const packId = packIdOf(pack);
        if (scope && !userPackAllowed(packId, scope)) continue;
        const index = await pack.getIndex({ fields: ["type", "system.identifier", "system.classIdentifier", "system.source.rules"] }).catch(() => null);
        if (!index) continue;
        for (const entry of collectionValues(index)) {
          if (entry.type !== "subclass" || entry.system?.classIdentifier !== identifier) continue;
          const entryRules = entry.system?.source?.rules;
          if (rules === "2024" ? entryRules === "2014" : entryRules === "2024") continue;
          const uuid = "Compendium." + packId + ".Item." + entry._id;
          const key = entry.system?.identifier ?? uuid;
          if (scope ? byKey.has(key) : preferExistingRow(byKey.get(key), packId)) continue;
          byKey.set(key, { uuid, name: entry.name, packId });
        }
      }
      if (!byKey.size) return null;
      const rows = [...byKey.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const candidates = rows.map((row) => row.uuid), candidateNames = {};
      for (const row of rows) candidateNames[row.uuid] = row.name;
      return { candidates, candidateNames };
    }
    // 选择池免注水即可挑：特质键经 dnd5e 自己的 keyLabel 本地化、Compendium uuid 自包索引
    // 解析（缓存、廉价）
    async function hydrateCandidateNames(candidates) {
      const names = {};
      if (!Array.isArray(candidates) || !candidates.length) return names;
      const Trait = g.dnd5e?.documents?.Trait;
      const packs = new Map();
      for (const candidate of candidates) {
        if (typeof candidate !== "string" || names[candidate] !== undefined) continue;
        if (candidate.includes(":")) {
          const label = Trait?.keyLabel?.(candidate);
          if (label && label !== candidate) names[candidate] = label;
          continue;
        }
        if (candidate.startsWith("Compendium.")) {
          const parts = candidate.slice(11).split(".");
          const id = parts.pop();
          // shim 适配：dnd5e SRD 的 ItemChoice 池 uuid 有四段式（Compendium.<pack>.<id>，
          // 无文档段）——末段是 id，倒数第二段是文档段（Item）时剔除，否则整个余段是包名
          const docSegment = ["Item", "Actor", "Scene", "JournalEntry", "Macro", "RollTable"].includes(parts[parts.length - 1]);
          if (docSegment) parts.pop();
          const packId = parts.join(".");
          if (!packs.has(packId)) {
            const pack = game.packs?.get?.(packId) ?? null;
            if (pack && !(pack.index?.size > 0)) await pack.getIndex?.({ fields: [] }).catch(() => null);
            packs.set(packId, pack?.index ?? null);
          }
          const name = packs.get(packId)?.get?.(id)?.name;
          if (name) names[candidate] = name;
          continue;
        }
        const doc = await g.fromUuid(candidate).catch(() => null);
        if (doc?.name) names[candidate] = doc.name;
      }
      return names;
    }
    // az advancementPlan（contentListClassFeature）：现有演员升到 characterLevel 的计划。
    // rules 自职业文档派生，永不由模型供给；空选择是有意的——计划报告模型必须填什么而非
    // 消费已填的
    async function advancementPlanData(input) {
      try {
        writeInputGuard(input, "advancementPlan");
        if (input.world !== undefined) prepWorld(input.world);
        if (typeof input.actorUuid !== "string" || !input.actorUuid) {
          throw new Error("INPUT_INVALID: actorUuid required for advancement plans");
        }
        const actor = await prepActor(input.actorUuid);
        if (actor.type !== "character" && actor.type !== "npc") {
          throw new Error("ACTOR_TYPE_UNSUPPORTED: advancement plan requires a Character or NPC Actor");
        }
        const targetLevel = input.characterLevel;
        if (!Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > 20) {
          throw new Error("INPUT_INVALID: characterLevel must be 1..20");
        }
        const classData = await prepAdvancementSource(input.classUuid, "Item");
        if (classData.type !== "class") throw new Error("SOURCE_MISMATCH: class Item required");
        classData.system ??= {}; classData.system.levels = targetLevel;
        const classUserScope = userScopeForStep(input.classUuid, classData.system?.identifier);
        const raceData = input.raceUuid !== undefined ? await prepAdvancementSource(input.raceUuid, "Item") : null;
        if (raceData && raceData.type !== "race") throw new Error("SOURCE_MISMATCH: race Item required");
        // 子职业源：显式传参优先；同职业升级未传时从卡面派生（与 actorAdvance 同口径——
        // 计划侧 handledLevel 语义不再列出已到级 subclass 槽，枚举仍需源来对齐槽宇宙）
        const planSubclassUuid = input.subclassUuid ?? deriveActorSubclassUuid(actor, classData);
        const subclassData = planSubclassUuid !== undefined && planSubclassUuid !== null ? await prepAdvancementSource(planSubclassUuid, "Item") : null;
        if (subclassData && subclassData.type !== "subclass") throw new Error("SOURCE_MISMATCH: subclass Item required");
        await assertAdvancementSourcesEnabled([classData, subclassData, raceData]);
        const { stepSets, handledLevel } = await enumerateAdvancementStepSets(actor, { classData, raceData, subclassData, targetLevel });
        const ctx = {
          landedTraits: new Set([...Object.entries(actor.system?.skills ?? {}).filter(([, sk]) => (sk?.value ?? 0) >= 1).map(([key]) => "skills:" + key),
            ...Object.entries(actor.system?.tools ?? {}).filter(([, tool]) => (tool?.value ?? 0) >= 1).map(([key]) => "tool:" + key)]),
          candidateDocs: new Map(), isNpc: actor.type === "npc",
          rules: classRulesVersion(classData, input.classUuid),
          hpHistory: actorHpHistory(actor, classData),
          hitDie: actor.type === "npc"
            ? (actor.system?.attributes?.hd?.denomination ?? parseHitDieDenomination(classData.system))
            : parseHitDieDenomination(classData.system) };
        const stepScope = (label) => label === "class" ? classUserScope
          : label === "subclass" ? userScopeForStep(planSubclassUuid, classData.system?.identifier)
          : label === "race" ? userScopeForStep(input.raceUuid, classData.system?.identifier) : null;
        const resolved = [];
        for (const { label, steps } of stepSets) {
          resolved.push(await normalizeAdvancementSteps(ctx, label, steps, targetLevel, {}, planSubclassUuid ?? null, handledLevel, stepScope(label)));
        }
        const automaticSteps = [], choiceRequirements = [], uncoveredRequiredSteps = [];
        let nativeStepCount = 0, subclassPool;
        for (const plan of resolved) {
          nativeStepCount += plan.steps.length;
          for (const step of plan.automaticSteps) {
            automaticSteps.push({ slot: step.slot, level: step.level, kind: step.kind, label: step.label, ...(step.summary ? { summary: step.summary } : {}) });
          }
          for (const req of plan.choiceRequirements) {
            // key 精确告诉调用方值放 actor_advance 哪里：bySlot[key]，唯 subclass-uuid 保持
            // 顶层 subclassUuid 参数
            const serialized = { slot: req.slot, level: req.level, kind: req.kind, label: req.label, count: req.count,
              valueFormat: req.valueFormat, key: req.valueFormat === "subclass-uuid" ? "subclassUuid" : req.slot,
              ...(req.candidates ? { candidates: req.candidates } : {}), ...(req.cap !== undefined ? { cap: req.cap } : {}),
              ...(req.mode ? { mode: req.mode } : {}), ...(req.note ? { note: req.note } : {}), required: req.required !== false };
            if (serialized.valueFormat === "subclass-uuid" && !serialized.candidates) {
              subclassPool = subclassPool === undefined ? await subclassCandidatesForClass(classData, input.classUuid) : subclassPool;
              if (subclassPool) { serialized.candidates = subclassPool.candidates; serialized.candidateNames = subclassPool.candidateNames; }
            }
            if (serialized.candidates && !serialized.candidateNames) {
              const hydrated = await hydrateCandidateNames(serialized.candidates);
              if (Object.keys(hydrated).length) serialized.candidateNames = hydrated;
            }
            choiceRequirements.push(serialized);
          }
          for (const uncovered of plan.uncovered) {
            uncoveredRequiredSteps.push(uncovered.slot + " " + (uncovered.label ?? uncovered.kind) + ": " + uncovered.reason);
          }
        }
        // choicesTemplate：每个 bySlot 键一个骨架，调用方填空而非重建形状——特质键/池 uuid
        // 槽是 []，ASI 槽是 { abilityScore: {} }（asi-or-feat 可换 { feat: "<uuid>" }，见
        // 需求的 note）
        const choicesTemplate = {};
        for (const req of choiceRequirements) {
          if (req.valueFormat === "subclass-uuid") continue;
          choicesTemplate[req.key] = req.valueFormat === "asi-assignment" || req.valueFormat === "asi-or-feat" ? { abilityScore: {} } : [];
        }
        // 自动授予法术：固定 ItemGrant 条目（class/subclass/race，本次调用等级范围内）解析为
        // 法术文档者。已知预算施法者不得把自选花在这些上——写会去重重复并静默烧掉一个已知位
        //（月术巫师 A10s 课训）。ItemChoice 池不列此处——它们是选择、已在 choiceRequirements
        const autoGrantedSpells = [], seenGrantUuids = new Set();
        for (const plan of resolved) {
          for (const entry of plan.steps ?? []) {
            if (entry.kind !== "ItemGrantAdvancement" || !entry.dataFor?.selected?.length) continue;
            const source = String(entry.slot).split(":")[0];
            for (const uuid of entry.dataFor.selected) {
              if (seenGrantUuids.has(uuid)) continue;
              seenGrantUuids.add(uuid);
              if (!ctx.candidateDocs.has(uuid)) ctx.candidateDocs.set(uuid, await g.fromUuid(uuid).catch(() => null));
              const doc = ctx.candidateDocs.get(uuid);
              if (doc?.type !== "spell") continue;
              autoGrantedSpells.push({ uuid, name: doc.name ?? null, spellLevel: doc.system?.level ?? null, grantLevel: entry.level ?? 1, source });
            }
          }
        }
        autoGrantedSpells.sort((a, b) => (a.grantLevel - b.grantLevel) || ((a.spellLevel ?? 0) - (b.spellLevel ?? 0)) || String(a.name).localeCompare(String(b.name)));
        const raceMovement = raceData?.system?.movement
          ? Object.fromEntries(Object.entries(raceData.system.movement)
            .filter(([key, value]) => ["walk", "fly", "swim", "climb", "burrow"].includes(key) && value)
            .map(([key, value]) => [key, Number(value) || value]))
          : null;
        return { status: "completed",
          actorAdvanceArgs: { classUuid: input.classUuid, ...(input.subclassUuid !== undefined ? { subclassUuid: input.subclassUuid } : {}),
            ...(input.raceUuid !== undefined ? { raceUuid: input.raceUuid } : {}), targetLevel },
          ...(raceData ? { race: { uuid: input.raceUuid, name: raceData.name ?? null, movement: raceMovement } } : {}),
          automaticSteps, choiceRequirements, choicesTemplate,
          spellBudget: await spellBudgetForClass(classData, targetLevel, input.classUuid, subclassData),
          ...(autoGrantedSpells.length ? { autoGrantedSpells } : {}),
          coverage: { nativeStepCount, automaticStepCount: automaticSteps.length, choiceStepCount: choiceRequirements.length, uncoveredRequiredSteps },
          warnings: [] };
      } catch (error) {
        return writeReject(error);
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
          // L3：原型尺寸随放置落位——entry 未显式给 width/height 时取演员原型真值
          //（shim 的 prototypeToken getter 已回读 _source + dnd5e 体型映射），
          // 否则 lg 体型 NPC 拖上画布恒是 1×1。下方「Token creation did not settle」
          // 按 entry.data 全键比对，data 带上原型尺寸后确认面自动覆盖。
          const prototype = actor.prototypeToken ?? {};
          const prototypeName = typeof prototype.name === "string" && prototype.name.trim() ? prototype.name : actor.name;
          creations.push({
            actor,
            prototypeFingerprint: prototypeFingerprintOf(actor),
            data: {
              name: placement.name ?? prototypeName,
              x: placement.x, y: placement.y,
              ...(placement.width !== undefined ? { width: placement.width }
                : (Number(prototype.width) > 0 ? { width: Number(prototype.width) } : {})),
              ...(placement.height !== undefined ? { height: placement.height }
                : (Number(prototype.height) > 0 ? { height: Number(prototype.height) } : {})),
              ...(placement.disposition !== undefined ? { disposition: placement.disposition } : {}),
              ...(placement.elevation !== undefined ? { elevation: placement.elevation } : {}),
              ...(placement.hidden !== undefined ? { hidden: placement.hidden } : {}),
              actorId: actor.id,
              // Foundry 语义（M6b）：默认 link 取自演员——NPC 的原型 token actorLink=false
              //（unlink，群怪各自血量），PC=true（link）。entry 显式指定优先；演员侧读持久化
              // 原型（M6b 起直读 _source——当时 getter 是合成面无 actorLink；L3 起 getter 同读
              // _source，直读保留，两者等价）；
              // 缺面按 type 兜底（character=link）。原硬编码 true 会让群怪共享演员血量
              //（打一只全体掉血）
              actorLink: entry.actorLink ?? (actor._source?.prototypeToken?.actorLink
                ?? actor.type === "character"),
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
    //    syncPlacedTokens），Item 直写 img；upload 的处置随上传通道探针分档：无凭证档
    //    CAPABILITY_UNAVAILABLE，真实登录档放行 dataPath 直引）——
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
    // —— M2 回执结算明细（rolls/damageDetail）：彩排痛点「回执只有 status，骰值/伤害拆分
    //    只在 midi 聊天卡里 → LLM 读不到 d20、偷袭不可证」。数据源优先级：workflow 对象
    //    本体（midi-qol 13.0.63 Workflow 实例：attackRoll/attackTotal/d20AttackRoll/
    //    isCritical/damageRolls(+bonus/other/utility)/damageDetail(+raw/bonus/other)/
    //    damageList[oldHP/newHP/...]/hitTargets/targetSaveDetails[uuid].saveRoll——字段
    //    清单与页内探针证据见 tools/stage11-m2-verify.mjs --cloud）> 聊天卡
    //    flags["midi-qol"] 兜底（persistFields 落的 Roll.toJSON/damageDetailToObject 形，
    //    兼容 ChatMessageMidi 反序列化出的活 Roll 实例）。采集全程防御：明细拿不到只降级
    //    （空数组 + warnings 记录），绝不翻 status——四态回执语义是 az 契约红线——
    function settlementField(source, key) {
      try { return source?.[key]; } catch { return undefined; }
    }
    function settlementTargetRef(tokenByUuid, tokenLikeOrUuid) {
      const tokenLike = typeof tokenLikeOrUuid === "string"
        ? tokenByUuid.get(tokenLikeOrUuid) ?? null
        : tokenLikeOrUuid;
      const token = tokenObject(tokenLike);
      const doc = tokenDocument(tokenLike);
      const actor = token?.actor ?? doc?.actor ?? null;
      return {
        tokenId: doc?.id ?? token?.id ?? null,
        tokenUuid: typeof tokenLikeOrUuid === "string" ? tokenLikeOrUuid : (doc?.uuid ?? null),
        tokenName: doc?.name ?? token?.name ?? null,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
      };
    }
    function settlementRollEntry(roll, { kind, itemName, damageType = null, isCritical = null, d20 = null, target = null }) {
      const total = Number(roll?.total);
      const entry = {
        kind,
        item: itemName ?? null,
        formula: typeof roll?.formula === "string" && roll.formula.trim() ? roll.formula.trim() : null,
        total: Number.isFinite(total) ? total : null,
      };
      if (typeof d20 === "number" && d20 >= 1 && d20 <= 20) entry.d20 = d20;
      if (typeof isCritical === "boolean") entry.isCritical = isCritical;
      if (cleanText(damageType)) entry.type = cleanText(damageType);
      if (target && (target.tokenId || target.tokenUuid)) entry.target = target;
      return entry;
    }
    // workflow/flags → 统一「掷骰 + 伤害段 + 应用」快照；两边字段同名同义（midi 把 workflow
    // 字段 persistFields 进 flags，Roll 走 toJSON：{formula,total,...}）
    function settlementSnapshot(source, tokenByUuid) {
      if (!source) return null;
      return {
        attackRoll: settlementField(source, "attackRoll") ?? null,
        attackTotal: settlementField(source, "attackTotal") ?? null,
        d20AttackRoll: settlementField(source, "d20AttackRoll") ?? null,
        isCritical: settlementField(source, "isCritical") ?? null,
        damageRolls: collectionValues(settlementField(source, "damageRolls")),
        bonusDamageRolls: collectionValues(settlementField(source, "bonusDamageRolls")),
        otherDamageRolls: collectionValues(settlementField(source, "otherDamageRolls")),
        utilityRolls: collectionValues(settlementField(source, "utilityRolls")),
        damageDetail: collectionValues(settlementField(source, "damageDetail")),
        rawDamageDetail: collectionValues(settlementField(source, "rawDamageDetail")),
        bonusDamageDetail: collectionValues(settlementField(source, "bonusDamageDetail")),
        otherDamageDetail: collectionValues(settlementField(source, "otherDamageDetail")),
        damageList: collectionValues(settlementField(source, "damageList")),
        hitTargets: setValues(settlementField(source, "hitTargets")),
        hitTargetUuids: collectionValues(settlementField(source, "hitTargetUuids")),
        targetSaveDetails: settlementField(source, "targetSaveDetails") ?? null,
        tokenByUuid,
      };
    }
    function collectSettlementDetail({ workflow, item, chatCardMessage, observedTargets, beforeByTokenId }) {
      const warnings = [];
      const tokenByUuid = new Map();
      for (const token of [...(observedTargets ?? []), ...sceneTokens()]) {
        const uuid = tokenDocument(token)?.uuid;
        if (uuid && !tokenByUuid.has(uuid)) tokenByUuid.set(uuid, token);
      }
      const itemName = item?.name ?? null;
      const baseSource = item?.type === "weapon" ? "weapon"
        : item?.type === "spell" ? "spell"
          : (cleanText(item?.type) || "activity");
      let snapshot = settlementSnapshot(workflow, tokenByUuid);
      if ((!snapshot || (!snapshot.attackRoll && !snapshot.damageRolls.length && !snapshot.damageDetail.length && !snapshot.rawDamageDetail.length))
        && chatCardMessage) {
        const fromCard = settlementSnapshot(chatCardMessage.flags?.["midi-qol"] ?? null, tokenByUuid);
        if (fromCard && (fromCard.attackRoll || fromCard.damageRolls.length || fromCard.damageDetail.length)) {
          if (snapshot) warnings.push("settlement-from-chat-card-flags");
          snapshot = fromCard;
        }
      }
      const rolls = [];
      const damageDetail = [];
      if (!snapshot) return { rolls, damageDetail, warnings };
      // —— rolls：attack → damage(+bonus/other/utility) → save ——
      try {
        const isCritical = typeof snapshot.isCritical === "boolean" ? snapshot.isCritical : null;
        const d20 = Number(snapshot.d20AttackRoll);
        if (snapshot.attackRoll) {
          rolls.push(settlementRollEntry(snapshot.attackRoll, {
            kind: "attack", itemName, isCritical,
            d20: Number.isFinite(d20) ? d20 : null,
          }));
        } else if (typeof snapshot.attackTotal === "number" && snapshot.attackTotal) {
          // 掷骰对象拿不到但 midi 记了总数（如 flags 只有 attackTotal）——保底一行
          rolls.push(settlementRollEntry({ total: snapshot.attackTotal }, { kind: "attack", itemName, isCritical }));
        }
        for (const roll of snapshot.damageRolls) {
          rolls.push(settlementRollEntry(roll, {
            kind: "damage", itemName, damageType: roll?.options?.type,
            isCritical: typeof roll?.options?.isCritical === "boolean" ? roll.options.isCritical : isCritical,
          }));
        }
        for (const roll of snapshot.bonusDamageRolls) {
          rolls.push(settlementRollEntry(roll, { kind: "bonus-damage", itemName, damageType: roll?.options?.type }));
        }
        for (const roll of snapshot.otherDamageRolls) {
          rolls.push(settlementRollEntry(roll, { kind: "other-damage", itemName, damageType: roll?.options?.type }));
        }
        for (const roll of snapshot.utilityRolls) {
          rolls.push(settlementRollEntry(roll, { kind: "utility", itemName }));
        }
        for (const [uuid, details] of Object.entries(snapshot.targetSaveDetails ?? {})) {
          const roll = details?.saveRoll;
          if (!roll) continue;
          rolls.push(settlementRollEntry(roll, {
            kind: "save", itemName, target: settlementTargetRef(tokenByUuid, uuid),
          }));
        }
      } catch (error) {
        warnings.push("rolls-collection-failed:" + cleanText(error?.message ?? error).slice(0, 160));
      }
      // —— damageDetail：掷骰段（来源可判）× 目标应用（damageList 有 oldHP/newHP 与
      //    过抗性后段值；无 damageList 时以 hitTargets + 快照 hp 差兜底）——
      try {
        const rolledSegments = [];
        const pushRolled = (segments, source) => {
          for (const seg of collectionValues(segments)) {
            const value = Number(seg?.value ?? seg?.damage);
            const type = cleanText(seg?.type);
            if (!Number.isFinite(value) || !type || type === "midi-none") continue;
            rolledSegments.push({
              source,
              value,
              type,
              formula: typeof seg?.formula === "string" && seg.formula.trim() ? seg.formula.trim() : null,
              properties: setValues(seg?.properties).map((prop) => String(prop)),
              matched: false,
            });
          }
        };
        const baseSegments = snapshot.damageDetail.length ? snapshot.damageDetail : snapshot.rawDamageDetail;
        pushRolled(baseSegments, baseSource);
        pushRolled(snapshot.bonusDamageDetail, "bonus");
        pushRolled(snapshot.otherDamageDetail, "other");
        const hpPairOf = (tokenLike) => {
          const tokenId = tokenDocument(tokenLike)?.id;
          const before = tokenId ? beforeByTokenId?.get(tokenId) : null;
          const after = tokenLike ? tokenState(tokenLike) : null;
          if (!before || !after) return null;
          return {
            hpBefore: before.hp?.value ?? null,
            hpAfter: after.hp?.value ?? null,
            tempHpBefore: before.hp?.temp ?? 0,
            tempHpAfter: after.hp?.temp ?? 0,
          };
        };
        const matchRolled = (applied) => rolledSegments.find((rolled) => !rolled.matched
          && rolled.type === applied.type
          && (rolled.formula === applied.formula || !applied.formula || !rolled.formula));
        const applications = [];
        for (const entry of snapshot.damageList) {
          const targetUuid = cleanText(entry?.targetUuid);
          const tokenLike = targetUuid ? tokenByUuid.get(targetUuid) ?? null : null;
          const target = settlementTargetRef(tokenByUuid, targetUuid || tokenLike);
          const segments = collectionValues(entry?.damageDetail).map((seg) => ({
            value: Number(seg?.value ?? seg?.damage),
            type: cleanText(seg?.type),
            formula: typeof seg?.formula === "string" && seg.formula.trim() ? seg.formula.trim() : null,
          })).filter((seg) => Number.isFinite(seg.value) && seg.type && seg.type !== "midi-none");
          if (!segments.length) continue;
          const livePair = tokenLike ? hpPairOf(tokenLike) : null;
          applications.push({
            target,
            segments,
            hp: livePair ?? {
              hpBefore: entry?.oldHP ?? null,
              hpAfter: entry?.newHP ?? null,
              tempHpBefore: entry?.oldTempHP ?? 0,
              tempHpAfter: entry?.newTempHP ?? 0,
            },
            hpDamage: Number(entry?.hpDamage),
            appliedTotal: Number(entry?.totalDamage),
          });
        }
        if (applications.length) {
          for (const application of applications) {
            for (const applied of application.segments) {
              const rolled = matchRolled(applied);
              if (rolled) rolled.matched = true;
              damageDetail.push({
                source: rolled?.source ?? "applied",
                value: rolled?.value ?? applied.value,
                appliedValue: applied.value,
                type: applied.type,
                formula: rolled?.formula ?? applied.formula,
                properties: rolled?.properties ?? [],
                target: application.target,
                hpBefore: application.hp.hpBefore,
                hpAfter: application.hp.hpAfter,
                tempHpBefore: application.hp.tempHpBefore,
                tempHpAfter: application.hp.tempHpAfter,
              });
            }
          }
        } else if (rolledSegments.length) {
          // 未走 midi 自动应用（无 damageList）：按命中目标摊开，hp 前后取本地快照差
          const targets = snapshot.hitTargets.length
            ? [...snapshot.hitTargets, ...snapshot.hitTargetUuids.filter((uuid) => !tokenByUuid.has(uuid))]
            : snapshot.hitTargetUuids;
          for (const rolled of rolledSegments) {
            if (!targets.length) {
              damageDetail.push({
                source: rolled.source, value: rolled.value, appliedValue: null, type: rolled.type,
                formula: rolled.formula, properties: rolled.properties, target: null,
                hpBefore: null, hpAfter: null, tempHpBefore: null, tempHpAfter: null,
              });
              continue;
            }
            for (const targetLike of targets) {
              const tokenLike = typeof targetLike === "string" ? tokenByUuid.get(targetLike) ?? null : targetLike;
              const hp = tokenLike ? hpPairOf(tokenLike) : null;
              damageDetail.push({
                source: rolled.source, value: rolled.value, appliedValue: null, type: rolled.type,
                formula: rolled.formula, properties: rolled.properties,
                target: settlementTargetRef(tokenByUuid, targetLike),
                hpBefore: hp?.hpBefore ?? null,
                hpAfter: hp?.hpAfter ?? null,
                tempHpBefore: hp?.tempHpBefore ?? null,
                tempHpAfter: hp?.tempHpAfter ?? null,
              });
            }
          }
        }
      } catch (error) {
        warnings.push("damage-detail-collection-failed:" + cleanText(error?.message ?? error).slice(0, 160));
      }
      return { rolls, damageDetail, warnings };
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
      // M2：结算明细收官（rolls/damageDetail）——workflow 本体优先、聊天卡 flags 兜底；
      // 采集异常只降级为 warnings，status 四态不受影响
      const chatCardMessage = (itemCardId && game.messages?.get?.(itemCardId)) ?? recentItemCard ?? null;
      let settlement = { rolls: [], damageDetail: [], warnings: [] };
      try {
        settlement = collectSettlementDetail({ workflow, item, chatCardMessage, observedTargets, beforeByTokenId });
      } catch (error) {
        settlement = {
          rolls: [], damageDetail: [],
          warnings: ["settlement-detail-unavailable:" + cleanText(error?.message ?? error).slice(0, 160)],
        };
      }
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
        rolls: settlement.rolls,
        damageDetail: settlement.damageDetail,
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
          ...(settlement?.warnings ?? []),
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
          // M2：performUseAction 回执挂账——serializeTurnResponseV2 单动作 completed 时
          // 透传 receipt（此前从未赋值 → 回执只剩 status，骰值/伤害明细到不了调用方，
          // 即彩排「LLM 读不到 d20」的另一半根因）
          fact.receipt = result ?? null;
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
    // Agent API 线 M2：pageEval（PRD §3.1 / task.md 核心契约「pageEval action」）
    // 兜底 eval 一等化：包 async 函数体执行（顶层 await 可用）→ 落定时刻 diff 随结果返回。
    // 无沉降窗/残余缓冲（2026-10-16 拍板）：未 await 的副作用只由全局 unhandledrejection/error
    // 监听落统计面，本回执只含落定时刻的增量。边界：eval 语义固有——同步死循环本 runtime 无从
    // 中断，超时由宿主侧竞速承担；requestId 只随契约收下（eval 无回执幂等语义，不去重不重放）。
    // =========================================================================
    function evalFailureMessage(error) {
      if (error && typeof error.message === "string" && error.message) return error.message;
      return String(error);
    }
    // 失败码：既有码族优先（message 首段 "CODE: " 形状，如 CAPABILITY_UNAVAILABLE/INPUT_INVALID）
    // → Error.name（SyntaxError/TypeError/ReferenceError…）→ "Error"（非 Error 抛出物）
    function evalFailureCode(error) {
      const matched = /^([A-Z][A-Z0-9_]+): /.exec(evalFailureMessage(error));
      return matched ? matched[1] : (cleanText(error?.name) || "Error");
    }
    // SPIKE.missing（report.mjs classify 的特征串 → 次数）落定时刻增量；count = 本窗口增量
    function missingSince(report, before) {
      const now = report?.missing;
      if (!before || typeof now?.get !== "function") return [];
      const out = [];
      for (const [feature, count] of now) {
        const delta = count - (before.get(feature) ?? 0);
        if (delta > 0) out.push({ feature, count: delta });
      }
      out.sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));
      return out;
    }
    // 失败回投页面 error 通道（同步 dispatchEvent → report.mjs 监听器 + classify 既有能力）：
    // 缺失特征既进统计面（PRD §3.2 页面生命周期累计）又落进本回执 missing——不复制 classify 正则。
    // 归因靠 message 前缀（"pageEval: …"；classify 四条正则均不定锚，前缀不影响特征提取）。
    // 无 DOM 事件面（无头 vm）→ 兜底直报 errors，missing 不增（classify 不可达）。
    function reportEvalFailure(error) {
      const report = g.__SPIKE_REPORT__;
      if (!report) return;
      const message = "pageEval: " + evalFailureMessage(error);
      try {
        if (typeof g.ErrorEvent === "function" && typeof g.dispatchEvent === "function") {
          g.dispatchEvent(new g.ErrorEvent("error", { message }));
          return;
        }
      } catch { /* 事件面异常按兜底直报 */ }
      try { report.errors?.push?.({ stage: "pageEval", msg: message, stack: "" }); } catch { /* 统计面缺席不阻断 */ }
    }
    async function pageEvalData(input) {
      if (typeof input?.code !== "string" || !input.code.trim()) {
        return { status: "rejected", code: "INPUT_INVALID", message: "Expected a non-empty code string",
          touched: [], missing: [] };
      }
      const report = g.__SPIKE_REPORT__ ?? null;
      const surface = g.__MT_API_SURFACE__ ?? null;
      // 注册表句柄缺席（未装配的构建/环境）→ 打点面降级为空增量：兜底 eval 不因监控面缺席而废
      const counts = typeof surface?.snapshot === "function" && typeof surface?.diffSince === "function"
        ? surface.snapshot() : null;
      const missingBefore = typeof report?.missing?.get === "function" ? new Map(report.missing) : null;
      const settle = () => ({
        touched: counts ? surface.diffSince(counts).touched : [],
        missing: missingSince(report, missingBefore),
      });
      let value, failure = null;
      try {
        // 包 async 函数体：顶层 await 可用；返回值是 promise 则 await 到底（落定时刻才往下走）
        value = await new Function("return (async () => {\n" + input.code + "\n})()")();
      } catch (error) { failure = error; }
      if (failure) {
        reportEvalFailure(failure); // 先回投（同步）再 diff——本回执 missing 要含本次失败特征
        return { status: "rejected", code: evalFailureCode(failure), message: evalFailureMessage(failure),
          ...settle() };
      }
      const diff = settle();
      let serialized;
      try { serialized = JSON.stringify(value); }
      catch (error) {
        return { status: "rejected", code: "RESULT_NOT_SERIALIZABLE",
          message: "Result is not JSON-serializable: " + evalFailureMessage(error), ...diff };
      }
      // value 恒为 JSON 往返后的纯数据（宿主跨 realm 只有 JSON 通道；函数/undefined 成员被 JSON 语义
      // 丢弃）；无返回值/不可表原语（undefined/function/symbol）→ value 缺席（JSON 通道本就不携带）
      if (serialized === undefined) return { status: "completed", touched: diff.touched, missing: diff.missing };
      return { status: "completed", value: JSON.parse(serialized), touched: diff.touched, missing: diff.missing };
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
    // capabilities：az WorldInfo 契约 8 键（summonPlacement 恒 false——AUTO-001 边界）。
    // imageUploadEntryAvailable 随上传通道探针（技术债⑤两要件）：无 __MT_AUTH__ 会话的 stub 档
    // false、真实登录档 true——能力面如实反映本环境能否上传字节，不写死。
    const capabilities = {
      nativeActionEntryAvailable: typeof g.MidiQOL?.completeItemUse === "function",
      narrativeSpellConsumption: system.id === "dnd5e",
      conditionSetEntryAvailable: typeof g.CONFIG?.Actor?.documentClass?.prototype?.toggleStatusEffect === "function",
      prepActorDocuments: typeof g.CONFIG?.Actor?.documentClass?.create === "function",
      prepSceneDocuments: typeof g.CONFIG?.Scene?.documentClass?.create === "function",
      imageUploadEntryAvailable: imageUploadChannelAvailable(),
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

    // Agent API 线 M1：apiSurface 纯透传 __MT_API_SURFACE__ 注册表查询（句柄缺席降级
    // CAPABILITY_UNAVAILABLE，见文件头该段注记）；args 原样下传（{prefix?}），返回体不改写。
    if (action === "apiSurface") {
      const surface = g.__MT_API_SURFACE__;
      if (typeof surface?.query !== "function") {
        throw new Error("CAPABILITY_UNAVAILABLE: api surface registry not installed");
      }
      return surface.query(args ?? {});
    }

    // Agent API 线 M2：pageEval（兜底 eval 一等化——包 async 函数体执行 + 落定时刻打点 diff）。
    // 四态回执自捕获异常（rejected），不向宿主抛；GM 门在入口统一把守（写集同档，默认 requireGM）
    if (action === "pageEval") return await pageEvalData(args);

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
    // 阶段 11 M4：advancement 双 action（az 08/09 fragment 移植；自包异常转回执，不向宿主抛）
    if (action === "actorAdvance") return await actorAdvanceData(args);
    if (action === "advancementPlan") return await advancementPlanData(args);
    if (action === "sceneApply") return await sceneApplyData(args);
    if (action === "imageApply") return await imageApplyData(args);
    if (action === "conditionsSet") return await conditionsSetData(args);
    // M5 战斗集：executeTurn/executeAction 自包异常为回执（rejected/partial/indeterminate），
    // 不向宿主抛；GM 门在入口统一把守
    if (action === "executeTurn") return await executeTurnData(args);
    return await executeActionData(args);
  };

  window.__MT_AGENT_RUNTIME_SOURCE__ = `// ${RUNTIME.name} v${RUNTIME.version}\n(${window.__MT_AGENT_RUNTIME__.toString()})`;
})();
