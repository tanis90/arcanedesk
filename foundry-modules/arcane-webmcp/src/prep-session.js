import { normalizePlayWriteReceipt } from "./play-session.js";

/**
 * Prep-mode (备团) tool surface: the in-page port of the Desktop host layer's
 * content family (apps/desktop/src/main/foundry-services.js readContent /
 * writeContent). Reads strip the SDK readState and hand the model an opaque
 * session readRef; non-creating writes must exchange that readRef back, and
 * the module re-attaches the stored readState before dispatch. The SDK
 * runtime stays the second validation layer (READ_REF_STALE,
 * READ_REF_INVALID, WORLD_CHANGED, NAME_COLLISION, SOURCE_MISMATCH).
 *
 * readRefs live in page-session memory only, exactly like Desktop's session
 * Map: a reload invalidates them and a fresh read restores write access.
 * Writes skip the Desktop approval dialog by design (GM gating + readRef +
 * ledger receipts); rejected receipts have no side effects and may be
 * corrected and retried with a NEW requestId.
 */

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const WORLD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const ACTOR_INCLUDES = Object.freeze(["items", "resources", "prototypeToken", "sceneTokens"]);
const SCENE_INCLUDES = Object.freeze(["tokens", "walls", "lights", "tiles", "notes", "sounds"]);
const BROWSE_TYPES = Object.freeze(["spell", "item", "class", "subclass", "race"]);
const BROWSE_ITEM_TYPES = Object.freeze(["weapon", "equipment", "consumable", "tool", "loot", "container", "ammo"]);
const ABILITY_KEYS = Object.freeze(["str", "dex", "con", "int", "wis", "cha"]);
const DISPOSITIONS = Object.freeze([-1, 0, 1]);

function fail(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  throw error;
}

function requireGm(gameRef) {
  if (gameRef?.user?.isGM !== true) {
    fail("GM_REQUIRED", "The current Foundry user must be a GM");
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkUnknownFields(rawInput, allowed, label) {
  if (!isPlainObject(rawInput)) {
    fail("INVALID_INPUT", `${label} must be an object`);
  }
  const unknown = Object.keys(rawInput).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail("INVALID_INPUT", `Unknown input field: ${unknown.join(", ")}`);
  }
}

// Desktop parity: every string field in the prep schemas is a plain 1-256
// string (ref() carries no charset restriction — names may contain spaces
// and CJK); only requestId keeps the idempotency-key charset.
function checkRef(value, field) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    fail("INVALID_INPUT", `${field} is missing or invalid`);
  }
  return value;
}

function checkText(value, field, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) {
    fail("INVALID_INPUT", `${field} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function checkNumber(value, field, { minimum, maximum, exclusiveMinimum, integer } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_INPUT", `${field} must be a finite number`);
  }
  if (integer && !Number.isInteger(value)) {
    fail("INVALID_INPUT", `${field} must be an integer`);
  }
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
    fail("INVALID_INPUT", `${field} must be greater than ${exclusiveMinimum}`);
  }
  if (minimum !== undefined && value < minimum) {
    fail("INVALID_INPUT", `${field} must be at least ${minimum}`);
  }
  if (maximum !== undefined && value > maximum) {
    fail("INVALID_INPUT", `${field} must be at most ${maximum}`);
  }
  return value;
}

function checkBoolean(value, field) {
  if (typeof value !== "boolean") {
    fail("INVALID_INPUT", `${field} must be a boolean`);
  }
  return value;
}

function checkEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    fail("INVALID_INPUT", `${field} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function checkIncludeList(value, field, allowed, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail("INVALID_INPUT", `${field} must be an array of at most ${maxItems} entries`);
  }
  const seen = new Set();
  for (const entry of value) {
    if (!allowed.includes(entry)) {
      fail("INVALID_INPUT", `${field} entry must be one of ${allowed.join(", ")}`);
    }
    if (seen.has(entry)) {
      fail("INVALID_INPUT", `${field} entries must be unique`);
    }
    seen.add(entry);
  }
  return [...value];
}

function checkPagination(rawInput, normalized) {
  if (rawInput.limit !== undefined) {
    normalized.limit = checkNumber(rawInput.limit, "limit", { minimum: 1, maximum: 100, integer: true });
  }
  if (rawInput.cursor !== undefined) {
    normalized.cursor = checkRef(rawInput.cursor, "cursor");
  }
}

/** Desktop foundry-assets.js validateDataImagePath, byte-parity. */
export function validateDataImagePath(value) {
  if (
    typeof value !== "string" || !value || value.length > 4096
    || /[\\\x00-\x1f\x7f:?#%]/.test(value) || value.startsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === "..")
    || !/\.(png|jpe?g|webp)$/i.test(value)
  ) {
    fail("INVALID_INPUT", "image must be a PNG/JPEG/WebP Data-relative path");
  }
  return value;
}

/**
 * Image source object. WebMCP has no host byte channel, so the sourcePath
 * variant is rejected outright and only the Data-relative dataPath variant
 * survives (the contract never lets the model supply Base64).
 */
function checkDataImage(value, field) {
  checkUnknownFields(value, new Set(["dataPath", "sourcePath"]), field);
  if (value.sourcePath !== undefined) {
    fail(
      "CAPABILITY_UNAVAILABLE",
      "Local image upload is unavailable in WebMCP; use an existing Data-relative dataPath",
    );
  }
  if (value.dataPath === undefined) {
    fail("INVALID_INPUT", `${field} requires dataPath`);
  }
  return { dataPath: validateDataImagePath(value.dataPath) };
}

function checkGrant(rawGrant) {
  checkUnknownFields(rawGrant, new Set([
    "uuid", "packId", "entryId", "expectedName", "expectedType", "quantity", "equipped",
  ]), "grant entry");
  const grant = {};
  for (const key of ["uuid", "packId", "entryId", "expectedName", "expectedType"]) {
    if (rawGrant[key] !== undefined) grant[key] = checkRef(rawGrant[key], `grant entry ${key}`);
  }
  if (rawGrant.quantity !== undefined) {
    grant.quantity = checkNumber(rawGrant.quantity, "grant entry quantity", { minimum: 1, maximum: 999, integer: true });
  }
  if (rawGrant.equipped !== undefined) {
    grant.equipped = checkBoolean(rawGrant.equipped, "grant entry equipped");
  }
  return grant;
}

function checkGrantList(value, field, { minItems = 0, maxItems = 50 } = {}) {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    fail("INVALID_INPUT", `${field} must contain ${minItems}-${maxItems} entries`);
  }
  return value.map(checkGrant);
}

function checkAbilityScores(rawScores, field) {
  checkUnknownFields(rawScores, new Set(ABILITY_KEYS), field);
  const scores = {};
  for (const key of ABILITY_KEYS) {
    if (rawScores[key] !== undefined) {
      scores[key] = checkNumber(rawScores[key], `${field}.${key}`, { minimum: 1, maximum: 20, integer: true });
    }
  }
  return scores;
}

const PLACEMENT_FIELD_KEYS = Object.freeze([
  "x", "y", "name", "hidden", "disposition", "width", "height", "elevation",
]);

function checkPlacementFields(rawFields, label, extraKeys = []) {
  checkUnknownFields(rawFields, new Set([...PLACEMENT_FIELD_KEYS, ...extraKeys]), label);
  const fields = {};
  if (rawFields.x !== undefined) fields.x = checkNumber(rawFields.x, `${label}.x`);
  if (rawFields.y !== undefined) fields.y = checkNumber(rawFields.y, `${label}.y`);
  if (rawFields.name !== undefined) fields.name = checkRef(rawFields.name, `${label}.name`);
  if (rawFields.hidden !== undefined) fields.hidden = checkBoolean(rawFields.hidden, `${label}.hidden`);
  if (rawFields.disposition !== undefined) {
    fields.disposition = checkEnum(rawFields.disposition, `${label}.disposition`, DISPOSITIONS);
  }
  if (rawFields.width !== undefined) {
    fields.width = checkNumber(rawFields.width, `${label}.width`, { exclusiveMinimum: 0 });
  }
  if (rawFields.height !== undefined) {
    fields.height = checkNumber(rawFields.height, `${label}.height`, { exclusiveMinimum: 0 });
  }
  if (rawFields.elevation !== undefined) {
    fields.elevation = checkNumber(rawFields.elevation, `${label}.elevation`);
  }
  return fields;
}

function checkTokenLayout(rawLayout) {
  checkUnknownFields(rawLayout, new Set(["create", "update", "deleteIds"]), "tokens");
  const layout = {};
  if (rawLayout.create !== undefined) {
    if (!Array.isArray(rawLayout.create) || rawLayout.create.length > 100) {
      fail("INVALID_INPUT", "tokens.create must contain at most 100 entries");
    }
    layout.create = rawLayout.create.map((entry) => {
      return {
        ...checkPlacementFields(entry, "tokens.create entry", ["actorUuid", "actorLink"]),
        actorUuid: checkRef(entry.actorUuid, "tokens.create entry actorUuid"),
        x: checkNumber(entry.x, "tokens.create entry x"),
        y: checkNumber(entry.y, "tokens.create entry y"),
        ...(entry.actorLink !== undefined
          ? { actorLink: checkBoolean(entry.actorLink, "tokens.create entry actorLink") }
          : {}),
      };
    });
  }
  if (rawLayout.update !== undefined) {
    if (!Array.isArray(rawLayout.update) || rawLayout.update.length > 100) {
      fail("INVALID_INPUT", "tokens.update must contain at most 100 entries");
    }
    layout.update = rawLayout.update.map((entry) => {
      checkUnknownFields(entry, new Set(["tokenId", "changes"]), "tokens.update entry");
      return {
        tokenId: checkRef(entry.tokenId, "tokens.update entry tokenId"),
        changes: checkPlacementFields(entry.changes ?? {}, "tokens.update entry changes"),
      };
    });
  }
  if (rawLayout.deleteIds !== undefined) {
    if (!Array.isArray(rawLayout.deleteIds) || rawLayout.deleteIds.length > 100) {
      fail("INVALID_INPUT", "tokens.deleteIds must contain at most 100 entries");
    }
    const seen = new Set();
    for (const id of rawLayout.deleteIds) {
      checkRef(id, "tokens.deleteIds entry");
      if (seen.has(id)) fail("INVALID_INPUT", "tokens.deleteIds entries must be unique");
      seen.add(id);
    }
    layout.deleteIds = [...rawLayout.deleteIds];
  }
  return layout;
}

function checkSceneFields(rawFields, { requireName = false } = {}) {
  checkUnknownFields(rawFields, new Set(["name", "active", "background", "width", "height", "grid"]), "scene");
  const fields = {};
  if (rawFields.name !== undefined) fields.name = checkRef(rawFields.name, "scene.name");
  if (rawFields.active !== undefined) fields.active = checkBoolean(rawFields.active, "scene.active");
  if (rawFields.background !== undefined) {
    fields.background = checkDataImage(rawFields.background, "scene.background");
  }
  if (rawFields.width !== undefined) {
    fields.width = checkNumber(rawFields.width, "scene.width", { minimum: 1, integer: true });
  }
  if (rawFields.height !== undefined) {
    fields.height = checkNumber(rawFields.height, "scene.height", { minimum: 1, integer: true });
  }
  if (rawFields.grid !== undefined) {
    checkUnknownFields(rawFields.grid, new Set(["type", "size", "distance", "units"]), "scene.grid");
    const grid = {};
    if (rawFields.grid.type !== undefined) {
      grid.type = checkNumber(rawFields.grid.type, "scene.grid.type", { integer: true });
    }
    if (rawFields.grid.size !== undefined) {
      grid.size = checkNumber(rawFields.grid.size, "scene.grid.size", { exclusiveMinimum: 0 });
    }
    if (rawFields.grid.distance !== undefined) {
      grid.distance = checkNumber(rawFields.grid.distance, "scene.grid.distance", { exclusiveMinimum: 0 });
    }
    if (rawFields.grid.units !== undefined) {
      grid.units = checkText(rawFields.grid.units, "scene.grid.units", 256);
    }
    fields.grid = grid;
  }
  if (requireName && fields.name === undefined) {
    fail("INVALID_INPUT", "scene.name is required when creating a Scene");
  }
  return fields;
}

function checkActorChanges(rawChanges) {
  checkUnknownFields(rawChanges, new Set(["name", "folderId", "prototypeToken", "dnd5e"]), "changes");
  const changes = {};
  if (rawChanges.name !== undefined) changes.name = checkRef(rawChanges.name, "changes.name");
  if (rawChanges.folderId !== undefined) {
    if (rawChanges.folderId !== null) {
      changes.folderId = checkRef(rawChanges.folderId, "changes.folderId");
    } else {
      changes.folderId = null;
    }
  }
  if (rawChanges.prototypeToken !== undefined) {
    checkUnknownFields(rawChanges.prototypeToken, new Set(["name", "width", "height", "disposition"]), "changes.prototypeToken");
    const prototypeToken = {};
    if (rawChanges.prototypeToken.name !== undefined) {
      prototypeToken.name = checkRef(rawChanges.prototypeToken.name, "changes.prototypeToken.name");
    }
    if (rawChanges.prototypeToken.width !== undefined) {
      prototypeToken.width = checkNumber(rawChanges.prototypeToken.width, "changes.prototypeToken.width", { exclusiveMinimum: 0, maximum: 100 });
    }
    if (rawChanges.prototypeToken.height !== undefined) {
      prototypeToken.height = checkNumber(rawChanges.prototypeToken.height, "changes.prototypeToken.height", { exclusiveMinimum: 0, maximum: 100 });
    }
    if (rawChanges.prototypeToken.disposition !== undefined) {
      prototypeToken.disposition = checkEnum(rawChanges.prototypeToken.disposition, "changes.prototypeToken.disposition", DISPOSITIONS);
    }
    changes.prototypeToken = prototypeToken;
  }
  if (rawChanges.dnd5e !== undefined) {
    checkUnknownFields(rawChanges.dnd5e, new Set(["hp", "ac", "abilities"]), "changes.dnd5e");
    const dnd5e = {};
    if (rawChanges.dnd5e.hp !== undefined) {
      checkUnknownFields(rawChanges.dnd5e.hp, new Set(["value", "max", "temp"]), "changes.dnd5e.hp");
      const hp = {};
      for (const key of ["value", "max", "temp"]) {
        if (rawChanges.dnd5e.hp[key] !== undefined) {
          hp[key] = checkNumber(rawChanges.dnd5e.hp[key], `changes.dnd5e.hp.${key}`, { minimum: 0 });
        }
      }
      dnd5e.hp = hp;
    }
    if (rawChanges.dnd5e.ac !== undefined) {
      checkUnknownFields(rawChanges.dnd5e.ac, new Set(["flat"]), "changes.dnd5e.ac");
      dnd5e.ac = { flat: checkNumber(rawChanges.dnd5e.ac.flat, "changes.dnd5e.ac.flat") };
    }
    if (rawChanges.dnd5e.abilities !== undefined) {
      dnd5e.abilities = checkAbilityScores(rawChanges.dnd5e.abilities, "changes.dnd5e.abilities");
    }
    changes.dnd5e = dnd5e;
  }
  return changes;
}

function checkAdvanceChoices(rawChoices) {
  checkUnknownFields(rawChoices, new Set(["bySlot", "hp"]), "choices");
  const choices = {};
  if (rawChoices.hp !== undefined) {
    choices.hp = checkEnum(rawChoices.hp, "choices.hp", ["max", "avg"]);
  }
  if (rawChoices.bySlot !== undefined) {
    if (!isPlainObject(rawChoices.bySlot)) {
      fail("INVALID_INPUT", "choices.bySlot must be an object");
    }
    const bySlot = {};
    for (const [slot, value] of Object.entries(rawChoices.bySlot)) {
      checkRef(slot, "choices.bySlot key");
      if (Array.isArray(value)) {
        if (value.length > 20) {
          fail("INVALID_INPUT", "choices.bySlot trait lists take at most 20 entries");
        }
        const seen = new Set();
        for (const pick of value) {
          checkRef(pick, "choices.bySlot entry");
          if (seen.has(pick)) fail("INVALID_INPUT", "choices.bySlot trait entries must be unique");
          seen.add(pick);
        }
        bySlot[slot] = [...value];
      } else if (isPlainObject(value)) {
        checkUnknownFields(value, new Set(["abilityScore", "feat"]), "choices.bySlot entry");
        const entry = {};
        if (value.abilityScore !== undefined) {
          if (!isPlainObject(value.abilityScore)) {
            fail("INVALID_INPUT", "choices.bySlot abilityScore must be an object");
          }
          const abilityScore = {};
          for (const [ability, points] of Object.entries(value.abilityScore)) {
            checkRef(ability, "choices.bySlot abilityScore key");
            abilityScore[ability] = checkNumber(points, "choices.bySlot abilityScore value", { minimum: 1, maximum: 2, integer: true });
          }
          entry.abilityScore = abilityScore;
        }
        if (value.feat !== undefined) {
          entry.feat = checkRef(value.feat, "choices.bySlot feat");
        }
        bySlot[slot] = entry;
      } else {
        fail("INVALID_INPUT", "choices.bySlot entries must be a trait list or an abilityScore/feat object");
      }
    }
    choices.bySlot = bySlot;
  }
  return choices;
}

function validateContentSearchInput(rawInput) {
  checkUnknownFields(rawInput, new Set([
    "scope", "documentType", "query", "packIds", "actorType", "itemType", "limit", "cursor",
  ]), "arcane_content_search input");
  const input = {
    scope: checkEnum(rawInput.scope, "scope", ["world", "compendium"]),
    documentType: checkEnum(rawInput.documentType, "documentType", ["Actor", "Item", "Scene"]),
    query: checkText(rawInput.query, "query", 256),
  };
  if (rawInput.packIds !== undefined) {
    if (!Array.isArray(rawInput.packIds) || rawInput.packIds.length > 20) {
      fail("INVALID_INPUT", "packIds must contain at most 20 entries");
    }
    input.packIds = rawInput.packIds.map((id) => checkRef(id, "packIds entry"));
  }
  if (rawInput.actorType !== undefined) input.actorType = checkRef(rawInput.actorType, "actorType");
  if (rawInput.itemType !== undefined) input.itemType = checkRef(rawInput.itemType, "itemType");
  checkPagination(rawInput, input);
  return input;
}

function validateCompendiumBrowseInput(rawInput) {
  checkUnknownFields(rawInput, new Set([
    "scope", "type", "rules", "classUuid", "maxLevel", "itemType", "query", "names", "page", "pageSize", "uuids",
  ]), "arcane_compendium_browse input");
  if (rawInput.scope !== "compendium") {
    fail("INVALID_INPUT", "scope must be compendium");
  }
  if (rawInput.uuids !== undefined) {
    for (const field of ["type", "rules", "classUuid", "maxLevel", "itemType", "query", "names", "page", "pageSize"]) {
      if (rawInput[field] !== undefined) {
        fail("INVALID_INPUT", `${field} is only valid for catalog queries; uuids mode takes uuids only`);
      }
    }
    if (!Array.isArray(rawInput.uuids) || rawInput.uuids.length < 1 || rawInput.uuids.length > 20) {
      fail("INVALID_INPUT", "uuids must contain 1-20 entries");
    }
    return {
      scope: "compendium",
      uuids: rawInput.uuids.map((uuid) => checkRef(uuid, "uuids entry")),
    };
  }
  if (rawInput.type === undefined) {
    fail("INVALID_INPUT", "type is required unless uuids is supplied");
  }
  const input = {
    scope: "compendium",
    type: checkEnum(rawInput.type, "type", BROWSE_TYPES),
  };
  if (rawInput.rules !== undefined) input.rules = checkEnum(rawInput.rules, "rules", ["2014", "2024"]);
  if (rawInput.classUuid !== undefined) input.classUuid = checkRef(rawInput.classUuid, "classUuid");
  if (rawInput.maxLevel !== undefined) {
    input.maxLevel = checkNumber(rawInput.maxLevel, "maxLevel", { minimum: 0, maximum: 9, integer: true });
  }
  if (rawInput.itemType !== undefined) {
    input.itemType = checkEnum(rawInput.itemType, "itemType", BROWSE_ITEM_TYPES);
  }
  if (rawInput.query !== undefined) input.query = checkText(rawInput.query, "query", 256);
  if (rawInput.names !== undefined) {
    if (!Array.isArray(rawInput.names) || rawInput.names.length < 1 || rawInput.names.length > 50) {
      fail("INVALID_INPUT", "names must contain 1-50 entries");
    }
    input.names = rawInput.names.map((name, index) => checkText(name, `names entry ${index + 1}`, 256));
  }
  if (rawInput.page !== undefined) {
    input.page = checkNumber(rawInput.page, "page", { minimum: 1, integer: true });
  }
  if (rawInput.pageSize !== undefined) {
    input.pageSize = checkNumber(rawInput.pageSize, "pageSize", { minimum: 1, maximum: 50, integer: true });
  }
  return input;
}

function validateAdvancementPlanInput(rawInput) {
  checkUnknownFields(rawInput, new Set([
    "actorUuid", "classUuid", "subclassUuid", "raceUuid", "characterLevel",
  ]), "arcane_advancement_plan input");
  const input = {
    actorUuid: checkRef(rawInput.actorUuid, "actorUuid"),
    classUuid: checkRef(rawInput.classUuid, "classUuid"),
    characterLevel: checkNumber(rawInput.characterLevel, "characterLevel", { minimum: 1, maximum: 20, integer: true }),
  };
  if (rawInput.subclassUuid !== undefined) input.subclassUuid = checkRef(rawInput.subclassUuid, "subclassUuid");
  if (rawInput.raceUuid !== undefined) input.raceUuid = checkRef(rawInput.raceUuid, "raceUuid");
  return input;
}

function validateActorGetInput(rawInput) {
  checkUnknownFields(rawInput, new Set(["actorUuid", "include", "limit", "cursor"]), "arcane_actor_get input");
  const input = { actorUuid: checkRef(rawInput.actorUuid, "actorUuid") };
  if (rawInput.include !== undefined) {
    input.include = checkIncludeList(rawInput.include, "include", ACTOR_INCLUDES, 4);
  }
  checkPagination(rawInput, input);
  return input;
}

function validateSceneGetInput(rawInput) {
  checkUnknownFields(rawInput, new Set(["sceneUuid", "include", "limit", "cursor"]), "arcane_scene_get input");
  const input = { sceneUuid: checkRef(rawInput.sceneUuid, "sceneUuid") };
  if (rawInput.include !== undefined) {
    input.include = checkIncludeList(rawInput.include, "include", SCENE_INCLUDES, 6);
  }
  checkPagination(rawInput, input);
  return input;
}

function validateRequestAndRef(rawInput, label) {
  if (!ID_PATTERN.test(rawInput.requestId ?? "")) {
    fail("INVALID_INPUT", "requestId is missing or invalid");
  }
  if (rawInput.readRef !== undefined) checkRef(rawInput.readRef, "readRef");
  return rawInput.requestId;
}

function validateActorCreateInput(rawInput) {
  checkUnknownFields(rawInput, new Set([
    "requestId", "source", "name", "folderId", "initialItems", "prototypeToken", "dnd5e",
  ]), "arcane_actor_create input");
  validateRequestAndRef(rawInput);
  checkUnknownFields(rawInput.source, new Set(["kind", "actorType", "packId", "entryId"]), "source");
  let source;
  if (rawInput.source.kind === "blank") {
    if (rawInput.source.packId !== undefined || rawInput.source.entryId !== undefined) {
      fail("INVALID_INPUT", "blank source takes actorType only");
    }
    source = {
      kind: "blank",
      actorType: checkEnum(rawInput.source.actorType, "source.actorType", ["character", "npc"]),
    };
  } else if (rawInput.source.kind === "compendium") {
    if (rawInput.source.actorType !== undefined) {
      fail("INVALID_INPUT", "compendium source takes packId and entryId only");
    }
    source = {
      kind: "compendium",
      packId: checkRef(rawInput.source.packId, "source.packId"),
      entryId: checkRef(rawInput.source.entryId, "source.entryId"),
    };
  } else {
    fail("INVALID_INPUT", "source.kind must be blank or compendium");
  }
  const input = {
    requestId: rawInput.requestId,
    source,
    name: checkRef(rawInput.name, "name"),
  };
  if (rawInput.folderId !== undefined) input.folderId = checkRef(rawInput.folderId, "folderId");
  if (rawInput.initialItems !== undefined) {
    input.initialItems = checkGrantList(rawInput.initialItems, "initialItems", { maxItems: 50 });
  }
  if (rawInput.prototypeToken !== undefined) {
    checkUnknownFields(rawInput.prototypeToken, new Set(["name"]), "prototypeToken");
    input.prototypeToken = { name: checkRef(rawInput.prototypeToken.name, "prototypeToken.name") };
  }
  if (rawInput.dnd5e !== undefined) {
    checkUnknownFields(rawInput.dnd5e, new Set(["abilities"]), "dnd5e");
    input.dnd5e = { abilities: checkAbilityScores(rawInput.dnd5e.abilities, "dnd5e.abilities") };
  }
  return input;
}

function validateActorUpdateInput(rawInput) {
  checkUnknownFields(rawInput, new Set(["requestId", "actorUuid", "readRef", "changes"]), "arcane_actor_update input");
  validateRequestAndRef(rawInput);
  return {
    requestId: rawInput.requestId,
    actorUuid: checkRef(rawInput.actorUuid, "actorUuid"),
    readRef: checkRef(rawInput.readRef, "readRef"),
    changes: checkActorChanges(rawInput.changes ?? {}),
  };
}

function validateGrantItemsInput(rawInput) {
  checkUnknownFields(rawInput, new Set(["requestId", "actorUuid", "readRef", "items"]), "arcane_actor_grant_items input");
  validateRequestAndRef(rawInput);
  return {
    requestId: rawInput.requestId,
    actorUuid: checkRef(rawInput.actorUuid, "actorUuid"),
    readRef: checkRef(rawInput.readRef, "readRef"),
    items: checkGrantList(rawInput.items, "items", { minItems: 1, maxItems: 50 }),
  };
}

function validateActorAdvanceInput(rawInput) {
  checkUnknownFields(rawInput, new Set([
    "requestId", "actorUuid", "readRef", "classUuid", "subclassUuid", "raceUuid",
    "targetLevel", "choices", "additionalItems", "fullSpellList",
  ]), "arcane_actor_advance input");
  validateRequestAndRef(rawInput);
  const input = {
    requestId: rawInput.requestId,
    actorUuid: checkRef(rawInput.actorUuid, "actorUuid"),
    readRef: checkRef(rawInput.readRef, "readRef"),
    classUuid: checkRef(rawInput.classUuid, "classUuid"),
    targetLevel: checkNumber(rawInput.targetLevel, "targetLevel", { minimum: 1, maximum: 20, integer: true }),
  };
  if (rawInput.subclassUuid !== undefined) input.subclassUuid = checkRef(rawInput.subclassUuid, "subclassUuid");
  if (rawInput.raceUuid !== undefined) input.raceUuid = checkRef(rawInput.raceUuid, "raceUuid");
  if (rawInput.choices !== undefined) input.choices = checkAdvanceChoices(rawInput.choices);
  if (rawInput.additionalItems !== undefined) {
    input.additionalItems = checkGrantList(rawInput.additionalItems, "additionalItems", { maxItems: 50 });
  }
  if (rawInput.fullSpellList !== undefined) {
    input.fullSpellList = checkBoolean(rawInput.fullSpellList, "fullSpellList");
  }
  return input;
}

function validateSceneApplyInput(rawInput) {
  checkUnknownFields(rawInput, new Set([
    "requestId", "operation", "scene", "sceneUuid", "readRef", "tokens",
  ]), "arcane_scene_apply input");
  validateRequestAndRef(rawInput);
  if (rawInput.operation === "create") {
    if (rawInput.sceneUuid !== undefined || rawInput.readRef !== undefined) {
      fail("INVALID_INPUT", "scene creation takes scene and optional tokens only");
    }
    const input = {
      requestId: rawInput.requestId,
      operation: "create",
      scene: checkSceneFields(rawInput.scene ?? {}, { requireName: true }),
    };
    if (rawInput.tokens !== undefined) input.tokens = checkTokenLayout(rawInput.tokens);
    return input;
  }
  if (rawInput.operation === "update") {
    const input = {
      requestId: rawInput.requestId,
      operation: "update",
      sceneUuid: checkRef(rawInput.sceneUuid, "sceneUuid"),
      readRef: checkRef(rawInput.readRef, "readRef"),
    };
    if (rawInput.scene !== undefined) input.scene = checkSceneFields(rawInput.scene);
    if (rawInput.tokens !== undefined) input.tokens = checkTokenLayout(rawInput.tokens);
    return input;
  }
  fail("INVALID_INPUT", "operation must be create or update");
}

function validateImageInput(rawInput) {
  checkUnknownFields(rawInput, new Set([
    "requestId", "sourcePath", "dataPath", "targetUuid", "syncPlacedTokens",
  ]), "arcane_image input");
  validateRequestAndRef(rawInput);
  if (rawInput.sourcePath !== undefined) {
    fail(
      "CAPABILITY_UNAVAILABLE",
      "Local image upload is unavailable in WebMCP; use an existing Data-relative dataPath",
    );
  }
  if (rawInput.dataPath === undefined) {
    fail("INVALID_INPUT", "dataPath is required; WebMCP cannot upload local files");
  }
  const input = {
    requestId: rawInput.requestId,
    dataPath: validateDataImagePath(rawInput.dataPath),
  };
  if (rawInput.targetUuid !== undefined) input.targetUuid = checkRef(rawInput.targetUuid, "targetUuid");
  if (rawInput.syncPlacedTokens !== undefined) {
    input.syncPlacedTokens = checkBoolean(rawInput.syncPlacedTokens, "syncPlacedTokens");
  }
  return input;
}

export function createPrepTools({
  gameRef = globalThis.game,
  locationRef = globalThis.location,
  runtime,
  ledger,
  clone = (value) => structuredClone(value),
  newReadRef = () => {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    throw new Error("Web Crypto API is required to issue readRefs");
  },
} = {}) {
  const readRefs = new Map();
  let queue = Promise.resolve();

  function currentWorld() {
    const worldId = gameRef?.world?.id;
    const origin = locationRef?.origin;
    if (!WORLD_ID_PATTERN.test(worldId ?? "") || !origin) {
      fail("WORLD_UNAVAILABLE", "The current Foundry world is unavailable");
    }
    return { origin, id: worldId };
  }

  /** Strip the SDK readState and hand out an opaque session readRef. */
  async function readContent(action, input) {
    const data = await runtime(action, input, { requireGM: true });
    const { readState, ...rest } = data ?? {};
    const readRef = newReadRef();
    readRefs.set(readRef, clone(readState));
    return { ...rest, readRef };
  }

  function dispatchOperation({ requestId, world, action, fingerprint, args }) {
    const run = async () => normalizePlayWriteReceipt(
      await runtime(action, { ...args, requestId }, { requireGM: true }),
      { action, args: { ...args, requestId } },
    );
    return ledger.execute({ requestId, worldId: world.id, action, fingerprint, run });
  }

  /**
   * Shared write path, the port of Desktop writeContent: replay first, then
   * the readRef gate (identity match for non-creating writes), then dispatch
   * through the ledger. Creating writes accept but never require a readRef.
   */
  function writeContent({ action, input, identityKey = null, creating = false, buildArgs }) {
    const world = currentWorld();
    const fingerprint = JSON.stringify({ worldId: world.id, action, input });
    const replayed = ledger.replay({ requestId: input.requestId, action, fingerprint });
    if (replayed) return replayed;

    let readState = null;
    if (input.readRef !== undefined) {
      readState = readRefs.get(input.readRef) ?? null;
      if (!creating && (!readState || (identityKey && readState[identityKey] !== input[identityKey]))) {
        fail(
          "READ_REF_INVALID",
          `Read this ${identityKey === "sceneUuid" ? "Scene" : "Actor"} in the current page session first`,
        );
      }
    } else if (!creating) {
      fail("READ_REF_INVALID", "Read this document in the current page session first");
    }

    const { requestId, readRef, ...values } = input;
    const args = {
      ...buildArgs(values),
      world,
      ...(readState && !creating ? { readState } : {}),
    };
    const dispatch = () => dispatchOperation({
      requestId: input.requestId,
      world,
      action,
      fingerprint,
      args,
    });
    const operation = queue.then(dispatch, dispatch);
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return {
    async contentSearch(rawInput) {
      requireGm(gameRef);
      return runtime("contentSearch", validateContentSearchInput(rawInput), { requireGM: true });
    },

    async compendiumBrowse(rawInput) {
      requireGm(gameRef);
      return runtime("compendiumBrowse", validateCompendiumBrowseInput(rawInput), { requireGM: true });
    },

    async advancementPlan(rawInput) {
      requireGm(gameRef);
      return runtime("advancementPlan", validateAdvancementPlanInput(rawInput), { requireGM: true });
    },

    async actorGet(rawInput) {
      requireGm(gameRef);
      return readContent("actorRead", validateActorGetInput(rawInput));
    },

    async sceneGet(rawInput) {
      requireGm(gameRef);
      return readContent("sceneRead", validateSceneGetInput(rawInput));
    },

    actorCreate(rawInput) {
      requireGm(gameRef);
      const input = validateActorCreateInput(rawInput);
      return writeContent({
        action: "actorCreate",
        input,
        creating: true,
        buildArgs: (values) => values,
      });
    },

    actorUpdate(rawInput) {
      requireGm(gameRef);
      const input = validateActorUpdateInput(rawInput);
      return writeContent({
        action: "actorEdit",
        input,
        identityKey: "actorUuid",
        buildArgs: (values) => values,
      });
    },

    actorGrantItems(rawInput) {
      requireGm(gameRef);
      const input = validateGrantItemsInput(rawInput);
      return writeContent({
        action: "actorGrantItems",
        input,
        identityKey: "actorUuid",
        buildArgs: (values) => values,
      });
    },

    actorAdvance(rawInput) {
      requireGm(gameRef);
      const input = validateActorAdvanceInput(rawInput);
      return writeContent({
        action: "actorAdvance",
        input,
        identityKey: "actorUuid",
        buildArgs: (values) => values,
      });
    },

    sceneApply(rawInput) {
      requireGm(gameRef);
      const input = validateSceneApplyInput(rawInput);
      const creating = input.operation === "create";
      return writeContent({
        action: "sceneApply",
        input,
        identityKey: "sceneUuid",
        creating,
        buildArgs: (values) => values,
      });
    },

    image(rawInput) {
      requireGm(gameRef);
      const input = validateImageInput(rawInput);
      return writeContent({
        action: "imageApply",
        input,
        creating: true,
        buildArgs: ({ dataPath, targetUuid, syncPlacedTokens }) => ({
          image: { dataPath },
          ...(targetUuid !== undefined ? { targetUuid } : {}),
          ...(syncPlacedTokens !== undefined ? { syncPlacedTokens } : {}),
        }),
      });
    },

    stateForTesting() {
      return { readRefs };
    },
  };
}
