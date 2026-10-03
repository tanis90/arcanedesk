// 阶段 9 M3：导入期离线版本迁移变换层（import-migrate）。
//
// 纯函数设计（与 import-core 同约束）：不 import 任何 node builtins、env 之外零依赖，
// 只用标准全局（structuredClone）。node 侧由 tools/migrate-env-node.mjs（Path A：jsdom +
// bootstrap 全量点火）注入 env；浏览器侧将来直接把页内 live 全局（dnd5e 命名空间 + CONFIG +
// game 常量面）按同一接口喂入即可，本文件无需感知运行端。
//
// 管线（钉死于 tools/stage9-m3-spike.mjs 的已验证语义）：
//   ① DataModel 面（版本无关的形状归一，幂等）：按集合/文档类型分派
//        Item  = dataModels.item.config[type].migrateData(system)（SystemDataModel 链自带
//                _migrateData 钩子：advancement 数组→键对象、senses 平铺→ranges 等）
//                + ActivitiesTemplate.initializeActivities(整档) + 类型 extras + effects
//        Actor = 类型模型 + 递归 items（Item 面）+ effects
//        JournalEntry = pages 逐页 dataModels.journal.config[page.type].migrateData
//        Scene = 无系统 DataModel（只有 ② 的 migrateSceneData）
//   ② world-level 面（版本门槛由 dnd5e 代码按 _stats.systemVersion 自管）：
//        migrations.migrateItemData/migrateActorData/migrateSceneData/…（伪文档实例面）
//        → 返回 updateData → 自写 applyUpdate 应用（-=/== 算子 + 点路径 + 嵌入数组按 _id 合并）
//   ③ 收尾：成功文档统一把 _stats.systemVersion 升写为目标版本（官方 migrateWorld 收尾
//      语义——world-level 面的版本门槛按它判断）。
//
// 版本路由（接受矩阵，routeOf）：
//   ≥5.3.0  noop-check（近似 no-op，跑完供断言）/ 5.0–5.2 light / 4.x full（旗舰）
//   3.x/2.x/其它 experimental（尽力而为）。所有档共管线：版本分支在 dnd5e 代码内部；
//   experimental 档同样逐文档兜底，差异只在 report.route 标注（语义提示，不改变行为）。
//   fromCore ≤10（NeDB）已在 M1 的 detectVersion 拒绝，本层不管。
//
// 护栏：docs 深拷贝后变换，绝不改输入；单文档抛错 → 进 report.failedDocs 且不进入输出集
//（防半迁移状态污染落库），其余文档继续。

// ---------------------------------------------------------------------------
// 内部工具（零依赖）
// ---------------------------------------------------------------------------
function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  // 跨 realm 兼容：dnd5e 迁移在运行环境 realm 里新建普通对象——原型链第二层为 null 即普通
  // Object（Map/Set/Date 等的内建原型不满足此判据，仍判非 plain）
  const p = Object.getPrototypeOf(v);
  return p === null || Object.getPrototypeOf(p) === null;
}
function deepClone(v) {
  if (v === undefined) return v;
  return structuredClone(v);
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}
function getProperty(obj, path) {
  if (!path) return obj;
  return String(path).split(".").reduce((o, k) => (o === null || o === undefined) ? undefined : o[k], obj);
}
function setProperty(obj, path, value) {
  const keys = String(path).split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] === null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
  return true;
}
// dnd5e formatIdentifier 的离线近似（仅伪文档实例的 identifier getter 兜底用，罕见分支）
function formatIdentifier(input) {
  return String(input ?? "")
    .replaceAll(/(\w+)([|/])(\w+)/g, "$1-$3")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// 路径级 diff（键集+递归值比较；数组按 JSON 全等）——report 诊断/断言用
export function diffPaths(a, b, base = "", out = [], depth = 0) {
  if (a === b) return out;
  if (depth > 14) return out;
  const ao = a !== null && typeof a === "object";
  const bo = b !== null && typeof b === "object";
  if (!ao || !bo) { out.push(`${base || "(root)"}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`); return out; }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${base || "(root)"}: ${JSON.stringify(a)?.slice(0, 100)} → ${JSON.stringify(b)?.slice(0, 100)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) out.push(`${base}${k}: (absent) → ${JSON.stringify(b[k])?.slice(0, 100)}`);
    else if (!(k in b)) out.push(`${base}${k}: ${JSON.stringify(a[k])?.slice(0, 100)} → (absent)`);
    else diffPaths(a[k], b[k], `${base}${k}.`, out, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// applyUpdate：world-level 迁移返回的 updateData 应用器
//（对齐 foundry Document.update 语义：点路径展开 + mergeObject 递归合并、数组替换、
//  "-=" 删除 / "==" 强写算子、嵌入文档数组按 _id 合并——元素可为点路径 delta 或嵌套形状）
// ---------------------------------------------------------------------------
function deleteAtPath(doc, path) {
  const keys = path.split(".");
  const last = keys.pop();
  const cur = getProperty(doc, keys.join("."));
  if (!cur || typeof cur !== "object") return;
  if (Array.isArray(cur)) {
    const i = cur.findIndex((e) => e?._id === last || e === last);
    if (i >= 0) cur.splice(i, 1);
  } else delete cur[last];
}
// 嵌套形状 delta 的深合并（对象递归；数组/标量替换；嵌套 "-=" / "==" 算子键支持）
function mergeInto(target, update) {
  for (const [k, v] of Object.entries(update ?? {})) {
    if (/^-=/.test(k)) { deleteAtPath(target, k.slice(2)); continue; }
    if (/^==/.test(k)) { target[k.slice(2)] = deepClone(v); continue; }
    if (isPlainObject(v) && isPlainObject(target[k])) mergeInto(target[k], v);
    else target[k] = deepClone(v);
  }
  return target;
}
function applyUpdate(doc, update) {
  for (const [key, value] of Object.entries(update ?? {})) {
    let m;
    if ((m = key.match(/^(.+)\.-=(.+)$/))) deleteAtPath(doc, `${m[1]}.${m[2]}`);
    else if ((m = key.match(/^(.+)\.==(.+)$/))) setProperty(doc, `${m[1]}.${m[2]}`, deepClone(value));
    else if (key.startsWith("==")) setProperty(doc, key.slice(2), deepClone(value));
    else if (key.startsWith("-=")) deleteAtPath(doc, key.slice(2));
    else if (Array.isArray(value) && value.length > 0 && value.every((e) => e && typeof e === "object" && "_id" in e)
      && Array.isArray(doc[key]) && doc[key].every((e) => e && typeof e === "object")) {
      // 嵌入文档数组（items delta / effects 更新）：按 _id 合并
      for (const u of value) {
        const t = doc[key].find((e) => e._id === u._id);
        if (t) applyUpdate(t, u); // u 自身可能仍是点路径 delta（items）或嵌套形状（effects），统一走 applyUpdate
        else doc[key].push(deepClone(u));
      }
    } else if (key.includes(".")) {
      // 点路径：目标已是普通对象且值也是普通对象 → 递归并入；否则直接写
      const cur = getProperty(doc, key);
      if (isPlainObject(value) && isPlainObject(cur)) mergeInto(cur, value);
      else setProperty(doc, key, deepClone(value));
    } else if (isPlainObject(value) && isPlainObject(doc[key])) mergeInto(doc[key], value);
    else doc[key] = deepClone(value);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 版本路由（接受矩阵）
// ---------------------------------------------------------------------------
function majorMinor(version) {
  if (version === null || version === undefined) return null;
  const m = /^(\d+)(?:\.(\d+))?/.exec(String(version));
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] === undefined ? null : Number(m[2]) };
}
// → { name: "noop-check"|"light"|"full"|"experimental"|"unknown", bestEffort }
export function routeOf(fromSystem) {
  const mm = majorMinor(fromSystem);
  if (mm === null) return { name: "unknown", bestEffort: true, fromSystem: fromSystem ?? null };
  const { major, minor } = mm;
  if (major >= 6 || (major === 5 && (minor === null || minor >= 3))) return { name: "noop-check", bestEffort: false, fromSystem };
  if (major === 5) return { name: "light", bestEffort: false, fromSystem };
  if (major === 4) return { name: "full", bestEffort: false, fromSystem };
  return { name: "experimental", bestEffort: true, fromSystem }; // 3.x/2.x/1.x
}

// ---------------------------------------------------------------------------
// installMigrateCompat：给运行环境的 DataModel 基类补 static migrateData / migrateDataSafe
//（对齐核心 SchemaField#migrateSource 语义：声明字段才递归；嵌套模型 migrateDataSafe；
//  "-=" 键跳过、"?=" 键剥前缀。适配层 boot 后调用；页内将来可对 live 全局同源调用）
// ---------------------------------------------------------------------------
let walkWarnings = 0;
export function walkWarningCount() { return walkWarnings; }
function migrateSchemaSource(sourceData, fieldData, fields) {
  if (!fieldData || typeof fieldData !== "object" || Array.isArray(fieldData)) return;
  for (const rawKey of Object.keys(fieldData)) {
    let key = rawKey;
    if (/^-=/.test(key)) continue;
    if (/^\?=/.test(key)) key = key.slice(2);
    const field = fields?.[key];
    if (!field) continue;
    const value = fieldData[rawKey];
    if (typeof field.migrateSource === "function") {
      try { field.migrateSource(sourceData, value); } catch { walkWarnings++; }
      continue;
    }
    if (typeof field.model?.migrateDataSafe === "function") {
      try { field.model.migrateDataSafe(value); } catch { walkWarnings++; }
    } else if (field.fields) {
      migrateSchemaSource(sourceData, value, field.fields);
    } else if (field.element && Array.isArray(value)) {
      for (const entry of value) migrateEntry(sourceData, field.element, entry);
    } else if (field.element && value && typeof value === "object") {
      for (const entry of Object.values(value)) migrateEntry(sourceData, field.element, entry);
    }
  }
}
function migrateEntry(sourceData, element, entry) {
  if (!entry || typeof entry !== "object") return;
  if (typeof element.migrateSource === "function") {
    try { element.migrateSource(sourceData, entry); } catch { walkWarnings++; }
    return;
  }
  if (typeof element.model?.migrateDataSafe === "function") {
    try { element.model.migrateDataSafe(entry); } catch { walkWarnings++; }
  }
}
export function installMigrateCompat(DataModelClass) {
  if (!DataModelClass || typeof DataModelClass !== "function") return false;
  let installed = false;
  if (typeof DataModelClass.migrateData !== "function") {
    DataModelClass.migrateData = function migrateData(source) {
      const fields = this.schema?.fields ?? {};
      migrateSchemaSource(source, source, fields);
      return source;
    };
    installed = true;
  }
  if (typeof DataModelClass.migrateDataSafe !== "function") {
    DataModelClass.migrateDataSafe = function migrateDataSafe(source) {
      try { this.migrateData(source); } catch { /* 核心语义：失败不断链 */ }
      return source;
    };
    installed = true;
  }
  return installed;
}

// ---------------------------------------------------------------------------
// DataModel 面（形状归一；分派器钉死自 spike §2/§6）
// ---------------------------------------------------------------------------
function makeMigrateDataModelFace(env) {
  const dm = env.dataModels ?? {};
  const documents = env.documents ?? {};
  function migrateEffect(eff) {
    try { return documents.ActiveEffect5e?.migrateData?.(eff) ?? eff; } catch { return eff; }
  }
  function migrateItemDoc(doc) {
    doc.system ??= {};
    const M = dm.item?.config?.[doc.type];
    if (typeof M?.migrateData === "function") M.migrateData(doc.system);
    else if (dm.abstract?.ItemDataModel) dm.abstract.ItemDataModel.migrateData(doc.system);
    dm.item?.ActivitiesTemplate?.initializeActivities?.(doc); // Item5e.migrateData 的文档级部分（幂等兜底）
    // 类型 extras：Item5e.migrateData 内置的整档钩子（官方签名 source=整档——传 doc 而非 system）
    if (doc.type === "class") dm.item?.ClassData?._migrateTraitAdvancement?.(doc);
    else if (doc.type === "container") dm.item?.ContainerData?._migrateWeightlessData?.(doc);
    else if (doc.type === "equipment") dm.item?.EquipmentData?._migrateStealth?.(doc);
    else if (doc.type === "spell") dm.item?.SpellData?._migrateComponentData?.(doc);
    if (Array.isArray(doc.effects)) doc.effects.forEach(migrateEffect);
    return doc;
  }
  function migrateActorDoc(doc) {
    doc.system ??= {};
    const M = dm.actor?.config?.[doc.type];
    if (typeof M?.migrateData === "function") M.migrateData(doc.system);
    else if (dm.abstract?.ActorDataModel) dm.abstract.ActorDataModel.migrateData(doc.system);
    if (Array.isArray(doc.effects)) doc.effects.forEach(migrateEffect);
    if (Array.isArray(doc.items)) doc.items.forEach(migrateItemDoc);
    return doc;
  }
  return function migrateDataModelFace(coll, doc) {
    switch (coll) {
      case "items": case "actors": {
        if (coll === "items") return migrateItemDoc(doc);
        return migrateActorDoc(doc);
      }
      case "journal": {
        // JournalEntry 主文档：逐页 JournalEntryPage（无系统面处直通）
        if (Array.isArray(doc.pages)) {
          for (const page of doc.pages) {
            if (!page || typeof page !== "object") continue;
            page.system ??= {};
            const M = dm.journal?.config?.[page.type];
            if (typeof M?.migrateData === "function") M.migrateData(page.system);
          }
        }
        return doc;
      }
      case "scenes": case "tables": case "macros": case "messages":
        return doc; // 无系统 DataModel（Scene/RollTable/Macro/ChatMessage 只有 world-level 面）
      default:
        return doc;
    }
  };
}

// ---------------------------------------------------------------------------
// world-level 面：伪文档实例构造 + migrations.* 调用
// ---------------------------------------------------------------------------
// 伪实例要求（钉自 dnd5e 源码逐处核对）：
//   migrateItemData(item, itemData, …) 同一对象承担实例/数据双角色（非 documentClass 时
//   itemData === item）：system.properties 需兼具 Set.has（gear 规则）与 Array.push
//   （properties 初值回填）→ 数组附 has；_stats/identifier/getFlag 为实例面读取点。
function pseudoItem(itemData) {
  const system = { ...(itemData.system ?? {}) };
  if (Array.isArray(system.properties) && typeof system.properties.has !== "function") {
    // 不可枚举：migrateActorData 的 mergeObject({inplace:false}) 会 structuredClone 本实例，
    // 函数/expando 方法必须藏进不可枚举位（结构化克隆只保留可枚举数据属性）
    Object.defineProperty(system.properties, "has", {
      value: function has(v) { return this.includes(v); }, enumerable: false,
    });
  }
  const pseudo = { ...itemData, system };
  if (!("identifier" in pseudo)) pseudo.identifier = system.identifier ?? formatIdentifier(itemData.name);
  Object.defineProperty(pseudo, "getFlag", {
    value: function getFlag(scope, key) { return getProperty(this.flags, `${scope}.${key}`); },
    enumerable: false,
  });
  return pseudo;
}
function pseudoActor(doc) {
  return { ...doc, items: (doc.items ?? []).map(pseudoItem) };
}

function makeWorldLevelFace(env, migrationData) {
  const M = env.migrations ?? {};
  const call = (fn, ...args) => (typeof fn === "function" ? (fn(...args) ?? {}) : null);
  return function worldLevelUpdate(coll, doc) {
    switch (coll) {
      case "actors": return call(M.migrateActorData, pseudoActor(doc), doc, migrationData, {});
      case "items": return call(M.migrateItemData, pseudoItem(doc), doc, migrationData, {});
      case "scenes": return call(M.migrateSceneData, doc, migrationData);
      case "tables": return call(M.migrateRollTableData, doc, migrationData);
      case "macros": return call(M.migrateMacroData, doc, migrationData);
      case "messages": return call(M.migrateMessageData, doc);
      default: return null; // 无 world-level 面（journal/playlists/folders/users/cards/combats/…）
    }
  };
}

// 迁移后遗留键最小仿真：官方在页内 DataModel 构造时丢弃未声明字段（toSource 清洗），
// 离线变换层在 world-level 面之后（properties 已并入）清理已知的此类键——
// equipment.system.stealth：_migrateStealth 已把它折进 properties.stealthDisadvantage
function stripLegacyItem(item) {
  if (item?.type === "equipment" && item.system && typeof item.system === "object" && "stealth" in item.system
    && Array.isArray(item.system.properties) && item.system.properties.includes("stealthDisadvantage")) {
    delete item.system.stealth;
  }
}
function stripLegacyKeys(coll, doc) {
  if (coll === "items") stripLegacyItem(doc);
  else if (coll === "actors" && Array.isArray(doc.items)) doc.items.forEach(stripLegacyItem);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
// docsByColl: Record<foundry 集合名（小写复数，readWorld 输出）, 文档数组（嵌入已内联）>
// opts.env: { dataModels, migrations, documents?, CONFIG?, game }（注入的环境句柄；
//   documents = dnd5e.documents（ActiveEffect5e 等），可缺省）
// → { docs, report }；docs 仅含成功文档（failed 不进输出），输入绝不被修改
// opts.debugDiff?: (coll, doc, diffPaths) => void —— 逐文档变化路径回调（诊断/护栏断言用）
export function migrateDocs(docsByColl, { fromCore, fromSystem, toSystem = null, env, debugDiff } = {}) {
  if (!env || !env.dataModels) throw new Error("migrateDocs：缺少 env（需 { dataModels, migrations, CONFIG, game } 环境句柄）");
  const route = routeOf(fromSystem);
  const target = toSystem ?? env.game?.system?.version ?? null;
  const migrateDataModelFace = makeMigrateDataModelFace(env);
  // icon-migration.json 在离线侧不可达（fetch 包文件缺省）→ iconMap 空、_migrateDocumentIcon 跳过
  const worldLevelUpdate = makeWorldLevelFace(env, {});

  const report = {
    route: { ...route, fromCore: fromCore ?? null, toSystem: target },
    totals: { input: 0, applied: 0, unchanged: 0, failed: 0, skipped: 0 },
    perColl: {},
    failedDocs: [],
    warnings: [],
  };
  const docs = {};
  for (const [coll, list] of Object.entries(docsByColl ?? {})) {
    const arr = Array.isArray(list) ? list : [];
    const per = { input: arr.length, applied: 0, unchanged: 0, failed: 0, skipped: 0 };
    const out = [];
    for (const doc of arr) {
      report.totals.input++;
      let copy;
      try {
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("文档不是普通对象");
        copy = deepClone(doc);
        migrateDataModelFace(coll, copy);
        const upd = worldLevelUpdate(coll, copy);
        if (upd) applyUpdate(copy, upd);
        stripLegacyKeys(coll, copy);
        // realm 洗礼：dnd5e 迁移在运行环境 realm 里新建对象（advancement 键化、senses.ranges 等），
        // JSON 往返统一为本 realm 纯数据（顺带清理 undefined 键——JSON 存储本无此区分）
        copy = JSON.parse(JSON.stringify(copy));
        // 版本登记（官方 migrateWorld 收尾语义）：成功文档统一升 _stats.systemVersion —— world-level
        // 面的版本门槛按它判断，不升写则文档在下次检查中仍被视为旧版
        if (target && copy._stats?.systemVersion !== target) {
          copy._stats = { ...(copy._stats ?? {}), systemVersion: target };
        }
        if (!deepEqual(doc, copy)) {
          if (debugDiff) debugDiff(coll, doc, diffPaths(doc, copy).slice(0, 8));
          per.applied++; report.totals.applied++;
        } else {
          per.unchanged++; report.totals.unchanged++;
        }
        out.push(copy);
      } catch (e) {
        // 单文档护栏：失败记档不阻断，且不进输出集（半迁移状态不落库）
        per.failed++; report.totals.failed++;
        report.failedDocs.push({
          coll, id: doc?._id ?? null, name: doc?.name ?? null, type: doc?.type ?? null,
          error: `${e?.constructor?.name ?? "Error"}: ${e?.message ?? e}`,
        });
      }
    }
    report.perColl[coll] = per;
    docs[coll] = out;
  }
  return { docs, report };
}
