import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionBlockV2,
  actionConfigProblemV2,
  actionIdV2,
  activityUiActorIdentity,
  activityUiDefaultTab,
  assertFoundryLoginOrigin,
  buildActivityUseCreateOptions,
  checkActivityTargetRangeWithFoundry,
  collectActionCandidatesV2,
  deriveActivityInputContract,
  runtimeFunction,
  effectiveActivityActivationTypeV2,
  featureDeclaredRiderOptionsV2,
  FoundryRuntimeClient,
  foundryLoginStateFunction,
  foundryLoginSubmitFunction,
  isActionAvailableV2,
  isAgentCallableActionV2,
  isAgentCallableActivityV2,
  isExactSyntheticActorUuid,
  isFoundryGameTarget,
  isFoundryLoginTarget,
  isFoundryLoginTargetForOrigin,
  isTokenWithinDistanceWithFoundry,
  locateActionByIdV2,
  measureTokenDistanceWithFoundry,
  type NativeSummonLifecycleV2,
  type NativeSummonReceiptV2,
  normalizeFoundryLoginOrigin,
  parseActivitySelectionConstraintsV2,
  parseIndependentProjectilesContractV2,
  resolveActivityTargetCountLimit,
  resolveFoundryLoginUser,
  resolveNativeSummonActivityV2,
  resolveNativeSummonLifecycleV2,
  resolveNativeSpellSlotConsumption,
  resolveDeclaredRiderRequestsV2,
  validateDeclaredRiderPlanV2,
  resolveIndependentProjectileAllocationV2,
  resolveIndependentProjectileCountV2,
  resolveRequiredSelectionsForContract,
  resolveTargetSpecForContract,
  selectFoundryLoginTarget,
  selectFoundryPageReloadTarget,
  selectFoundryTarget,
  serializeTurnResponseV2,
  validateFoundryLoginState,
  withRuntimeConnection,
} from "./foundry-runtime.js";
import { CliError, errorToJson } from "./errors.js";
import { redactJsonSecrets } from "./json.js";
import { CdpSession } from "./cdp-client.js";

function nativeSummonActivityFixture(expectedCount: 1 | 2 = 1): Record<string, any> {
  return {
    id: "activity-1",
    type: "summon",
    summon: { mode: "", prompt: true },
    profiles: [{
      _id: "native-profile-1",
      uuid: "Compendium.arcane-dnd5e-2014-automation.summons.Actor.spiritual-weapon",
      count: expectedCount,
    }],
    flags: {
      "arcane-dnd5e-2014-automation": {
        nativeSummon: {
          provider: "dnd5e",
          humanStep: "native-summon-placement",
          artifactId: "spiritual-weapon",
          choice: "spectral-weapon",
          profileId: "spiritual-weapon",
          revision: 1,
          documentId: "spiritual-weapon",
          expectedCount,
          cleanup: "dm-duration",
          uniqueness: {
            scope: "source-actor-item",
            maximum: 1,
            enforcement: "replace-after-create",
          },
        },
      },
    },
  };
}

const nativeSummonLifecycleFixtures = {
  concentration: {
    mode: "concentration",
    effectUuid: "Actor.source.ActiveEffect.native-concentration",
  },
  rootConcentration: {
    mode: "root-concentration",
    effectUuid: "Actor.root.ActiveEffect.root-concentration",
  },
  dmDuration: { mode: "dm-duration", effectUuid: null },
  native: { mode: "native", effectUuid: null },
} satisfies Record<string, NativeSummonLifecycleV2>;

function nativeSummonReceiptFixture(
  expectedCount: 1 | 2 = 1,
  placedCount: number = expectedCount,
  lifecycle: NativeSummonLifecycleV2 = nativeSummonLifecycleFixtures.dmDuration,
): NativeSummonReceiptV2 {
  const members = Array.from({ length: placedCount }, (_, memberIndex) => ({
    memberIndex,
    tokenUuid: `Scene.scene.Token.summoned-${memberIndex + 1}`,
    combatantUuid: `Combat.combat.Combatant.summoned-${memberIndex + 1}`,
  }));
  return {
    kind: "native-summon",
    humanStep: "native-summon-placement",
    outcome: placedCount === expectedCount
      ? "placed"
      : placedCount === 0 ? "skipped-manual" : "partial-manual",
    requestId: "native-request-1",
    activityUuid: "Actor.source.Item.item-1.Activity.activity-1",
    artifactId: "spiritual-weapon",
    choice: "spectral-weapon",
    profileId: "spiritual-weapon",
    expectedCount,
    placedCount,
    skippedCount: expectedCount - placedCount,
    workflowUuid: "Workflow.native-summon-1",
    messageUuid: "ChatMessage.native-summon-1",
    members,
    sourceCombatantUuid: "Combat.combat.Combatant.combatant-source",
    inheritedInitiative: 17,
    lifecycle,
    retry: false,
  };
}

describe("declared rider preflight", () => {
  const options = [
    {
      id: "ensnaring-strike",
      minSpellLevel: 1,
      consumes: "spell-slot-on-hit",
    },
    {
      id: "blinding-smite",
      minSpellLevel: 3,
      consumes: "spell-slot-on-hit",
    },
    {
      id: "zephyr-strike",
      consumes: "active-buff-on-attack",
      resource: "none",
    },
  ];
  const slots = {
    spell1: { value: 1 },
    spell3: { value: 1 },
    spell4: { value: 1 },
  };

  it("maps an owned Sneak Attack feature as a no-resource DM declaration", () => {
    const sneakAttack = featureDeclaredRiderOptionsV2([{
      name: "Sneak Attack",
      type: "feat",
      system: { identifier: "sneak-attack" },
      flags: {
        "arcane-dnd5e-2014-automation": {
          declaredRider: {
            id: "sneak-attack",
            consumesOn: "hit",
            consumes: "none",
            damageType: "parent",
          },
        },
      },
    }]);

    expect(sneakAttack).toEqual([{
      id: "sneak-attack",
      name: "Sneak Attack",
      inputPath: "input.declaredRiders",
    }]);
    expect(resolveDeclaredRiderRequestsV2(
      [{ id: "sneak-attack" }],
      sneakAttack,
      {},
    )).toEqual([{ id: "sneak-attack" }]);
    expect(() => resolveDeclaredRiderRequestsV2(
      [{ id: "sneak-attack", spellLevel: 1 }],
      sneakAttack,
      { spell1: { value: 1 } },
    )).toThrow("does not accept spellLevel");
  });

  it("keeps current Divine Smite feature declarations slot-aware", () => {
    const divineSmite = featureDeclaredRiderOptionsV2([{
      name: "Divine Smite",
      type: "feat",
      system: { identifier: "divine-smite" },
      flags: {
        "arcane-dnd5e-2014-automation": {
          declaredRider: {
            id: "divine-smite",
            consumesOn: "hit",
            damageType: "radiant",
          },
        },
      },
    }]);

    expect(divineSmite).toEqual([{
      id: "divine-smite",
      name: "Divine Smite",
      consumes: "spell-slot-on-hit",
      minSpellLevel: 1,
      inputPath: "input.declaredRiders",
    }]);
    expect(resolveDeclaredRiderRequestsV2(
      [{ id: "divine-smite" }],
      divineSmite,
      { spell1: { value: 1 } },
    )).toEqual([{ id: "divine-smite", spellLevel: 1 }]);
    expect(() => resolveDeclaredRiderRequestsV2(
      [{ id: "divine-smite" }],
      divineSmite,
      { spell1: { value: 0 } },
    )).toThrow("No spell1 spell slots remain");
  });

  it("does not make no-resource feature riders mutually exclusive", () => {
    expect(resolveDeclaredRiderRequestsV2(
      [{ id: "sneak-attack" }, { id: "aasimar-revelation-damage" }],
      [
        { id: "sneak-attack", consumes: "none" },
        { id: "aasimar-revelation-damage", consumes: "none" },
      ],
      {},
    )).toEqual([
      { id: "sneak-attack" },
      { id: "aasimar-revelation-damage" },
    ]);
  });

  it("uses the exact base slot when the DM did not declare an upcast", () => {
    expect(resolveDeclaredRiderRequestsV2(
      [{ id: "blinding-smite" }],
      options,
      slots,
    )).toEqual([{ id: "blinding-smite", spellLevel: 3 }]);
  });

  it("preserves an explicit legal upcast", () => {
    expect(resolveDeclaredRiderRequestsV2(
      [{ id: "ensnaring-strike", spellLevel: 4 }],
      options,
      slots,
    )).toEqual([{ id: "ensnaring-strike", spellLevel: 4 }]);
  });

  it("rejects unknown, duplicate, clamped, and unavailable riders", () => {
    expect(() => resolveDeclaredRiderRequestsV2(
      [{ id: "unknown" }], options, slots,
    )).toThrow("not available for this action");
    expect(() => resolveDeclaredRiderRequestsV2(
      [{ id: "ensnaring-strike" }, { id: "ensnaring-strike" }],
      options,
      { spell1: { value: 2 } },
    )).toThrow("Duplicate declared rider");
    expect(() => resolveDeclaredRiderRequestsV2(
      [{ id: "blinding-smite", spellLevel: 1 }], options, slots,
    )).toThrow("cannot be lower than 3");
    expect(() => resolveDeclaredRiderRequestsV2(
      [{ id: "blinding-smite", spellLevel: 5 }], options, slots,
    )).toThrow("No spell5 spell slots remain");
  });

  it("rejects spellLevel for a non-slot active buff rider", () => {
    expect(() => resolveDeclaredRiderRequestsV2(
      [{ id: "zephyr-strike", spellLevel: 3 }], options, slots,
    )).toThrow("does not accept spellLevel");
  });

  it("rejects multiple riders backed by the same runtime consumer", () => {
    expect(() => resolveDeclaredRiderRequestsV2(
      [
        { id: "ensnaring-strike" },
        { id: "blinding-smite", spellLevel: 3 },
      ],
      options,
      { spell1: { value: 1 }, spell3: { value: 1 } },
    )).toThrow("Only one declared rider consuming spell-slot-on-hit");
  });

  it("rejects more than one spell-slot rider across the whole execute-turn", () => {
    expect(() => validateDeclaredRiderPlanV2([
      [{ id: "ensnaring-strike", spellLevel: 1 }],
      [{ id: "blinding-smite", spellLevel: 3 }],
    ])).toThrow("Only one spell-slot-on-hit declared rider");
    expect(() => validateDeclaredRiderPlanV2([
      [{ id: "ensnaring-strike", spellLevel: 1 }],
      [{ id: "zephyr-strike" }],
    ])).not.toThrow();
  });
});

describe("strict Actor export and import", () => {
  it("exports a complete document and preserves Actor and embedded Item IDs on import", async () => {
    const raw = {
      _id: "actor-1",
      name: "Barbarian",
      type: "character",
      folder: null,
      system: { abilities: { str: { value: 16 } } },
      items: [{ _id: "item-1", name: "Rage", type: "feat", system: {} }],
    };
    const sourceActor = {
      id: raw._id,
      uuid: `Actor.${raw._id}`,
      name: raw.name,
      type: raw.type,
      img: null,
      folder: null,
      system: raw.system,
      items: new Map(raw.items.map(item => [item._id, { id: item._id, name: item.name, type: item.type, system: item.system }])),
      toObject: () => structuredClone(raw),
    };
    vi.stubGlobal("game", {
      ready: true,
      version: "13.351",
      user: { isGM: true },
      world: { id: "testclean", title: "Test Clean" },
      system: { id: "dnd5e", version: "5.3.3" },
      actors: new Map([[sourceActor.id, sourceActor]]),
    });
    vi.stubGlobal("foundry", { utils: { deepClone: structuredClone } });

    try {
      const runtime = new Function("return (" + runtimeFunction + ");")();
      const exported = await runtime("actorExport", { identifier: raw._id }, { requireGM: true });
      expect(exported.actor).toEqual(raw);

      const createdActor: any = {
        ...sourceActor,
        items: new Map(raw.items.map(item => [item._id, { id: item._id, name: item.name, type: item.type, system: item.system }])),
        delete: vi.fn(),
      };
      const create = vi.fn(async () => createdActor);
      vi.stubGlobal("CONFIG", { Actor: { documentClass: { create } } });
      vi.stubGlobal("game", {
        ready: true,
        version: "13.351",
        user: { isGM: true },
        world: { id: "dragonlance", title: "Dragonlance" },
        system: { id: "dnd5e", version: "5.3.3" },
        actors: new Map(),
        folders: new Map(),
      });
      const imported = await runtime("actorImport", {
        expectedWorldId: "dragonlance",
        sourceWorldId: "testclean",
        actor: exported.actor,
      }, { requireGM: true });
      expect(create).toHaveBeenCalledWith(raw, { keepId: true, keepEmbeddedIds: true });
      expect(imported.verification).toEqual({
        actorIdPreserved: true,
        actorIdentityPreserved: true,
        embeddedItemIdsPreserved: true,
        embeddedItemCount: 1,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses target-world and identity collisions before creating anything", async () => {
    const raw = { _id: "actor-1", name: "Barbarian", type: "character", folder: null, items: [] };
    const create = vi.fn();
    vi.stubGlobal("foundry", { utils: { deepClone: structuredClone } });
    vi.stubGlobal("CONFIG", { Actor: { documentClass: { create } } });
    vi.stubGlobal("game", {
      ready: true,
      user: { isGM: true },
      world: { id: "dragonlance", title: "Dragonlance" },
      system: { id: "dnd5e", version: "5.3.3" },
      actors: new Map([[raw._id, { id: raw._id, name: raw.name }]]),
      folders: new Map(),
    });
    try {
      const runtime = new Function("return (" + runtimeFunction + ");")();
      await expect(runtime("actorImport", {
        expectedWorldId: "wrong-world",
        actor: raw,
      }, { requireGM: true })).rejects.toThrow("target world mismatch");
      await expect(runtime("actorImport", {
        expectedWorldId: "dragonlance",
        actor: raw,
      }, { requireGM: true })).rejects.toThrow("Actor import collision");
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("grants exact compendium Items with quantities and traceable source IDs", async () => {
    const items = new Map<string, any>([["existing", {
      id: "existing",
      name: "Rage",
      flags: {},
      _stats: {},
    }]]);
    const createEmbeddedDocuments = vi.fn(async (_type: string, data: any[]) => data.map((entry, index) => {
      const item = {
        id: `created-${index}`,
        uuid: `Actor.actor-1.Item.created-${index}`,
        name: entry.name,
        type: entry.type,
        img: entry.img,
        system: entry.system,
        flags: entry.flags,
        _stats: {},
      };
      items.set(item.id, item);
      return item;
    }));
    const actor = {
      id: "actor-1",
      uuid: "Actor.actor-1",
      name: "Barbarian",
      type: "character",
      img: null,
      folder: null,
      system: { attributes: { hp: { value: 12 }, ac: { value: 13 } } },
      items,
      createEmbeddedDocuments,
    };
    const source = {
      documentName: "Item",
      uuid: "Compendium.pack.weapons.Item.maul",
      name: "Maul",
      type: "weapon",
      toObject: () => ({
        _id: "maul",
        name: "Maul",
        type: "weapon",
        img: "maul.webp",
        system: { identifier: "maul", quantity: 1, equipped: false },
        flags: { dnd5e: {} },
      }),
    };
    const getDocument = vi.fn(async () => source);
    vi.stubGlobal("foundry", { utils: { deepClone: structuredClone } });
    vi.stubGlobal("game", {
      ready: true,
      user: { isGM: true },
      world: { id: "dragonlance", title: "Dragonlance" },
      system: { id: "dnd5e", version: "5.3.3" },
      actors: new Map([[actor.id, actor]]),
      packs: new Map([["pack.weapons", { getDocument }]]),
    });
    try {
      const runtime = new Function("return (" + runtimeFunction + ");")();
      const result = await runtime("actorAddItemsFromCompendium", {
        expectedWorldId: "dragonlance",
        actorId: actor.id,
        expectedActorName: actor.name,
        expectedExistingItemCount: 1,
        entries: [{
          packId: "pack.weapons",
          entryId: "maul",
          expectedName: "Maul",
          expectedType: "weapon",
          quantity: 2,
          equipped: true,
        }],
      }, { requireGM: true });
      expect(getDocument).toHaveBeenCalledWith("maul");
      expect(createEmbeddedDocuments).toHaveBeenCalledWith("Item", [expect.objectContaining({
        name: "Maul",
        system: expect.objectContaining({ quantity: 2, equipped: true }),
        flags: { dnd5e: { sourceId: source.uuid } },
      })]);
      expect(result.sources).toEqual([expect.objectContaining({ uuid: source.uuid, quantity: 2, equipped: true })]);
      expect(result.actor.itemCount).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function mockActor(uuid: string, items: any[], name = "Goblin") {
  return { uuid, name, items: new Map(items.map(item => [item.id, item])) };
}

function mockItem(id: string, name: string, activityIds: string[]) {
  return {
    id,
    name,
    type: "weapon",
    system: {
      activities: new Map(
        activityIds.map(activityId => [activityId, { id: activityId, type: "attack", name: "Attack" }])
      ),
    },
  };
}

describe("turn protocol v2 action IDs", () => {
  it("is deterministic for the same Foundry documents", () => {
    const actor = mockActor("Actor.abc123", [mockItem("item1", "Longsword", ["act1"])]);
    const first = collectActionCandidatesV2(actor).map(c => c.actionId);
    const second = collectActionCandidatesV2(actor).map(c => c.actionId);
    expect(first).toEqual(second);
    expect(first[0]).toMatch(/^a2_[0-9a-f]{16}$/);
  });

  it("generates different IDs for two same-named actions", () => {
    const actor = mockActor("Actor.abc123", [
      mockItem("item1", "Longsword", ["act1"]),
      mockItem("item2", "Longsword", ["act2"]),
    ]);
    const ids = collectActionCandidatesV2(actor).map(c => c.actionId);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps the ID stable when the display name changes", () => {
    const before = mockActor("Actor.abc123", [mockItem("item1", "Longsword", ["act1"])], "Goblin");
    const after = mockActor("Actor.abc123", [mockItem("item1", "Renamed Sword", ["act1"])], "Renamed Goblin");
    expect(collectActionCandidatesV2(before)[0]!.actionId).toBe(collectActionCandidatesV2(after)[0]!.actionId);
  });

  it("does not collide between a world actor and a synthetic token actor", () => {
    const world = actionIdV2("Actor.abc123", "item1", "act1");
    const synthetic = actionIdV2("Scene.s1.Token.t1.Actor.abc123", "item1", "act1");
    expect(world).not.toBe(synthetic);
  });

  it("does not collide between two unlinked tokens of the same base actor", () => {
    const first = actionIdV2("Scene.s1.Token.t1.Actor.abc123", "item1", "act1");
    const second = actionIdV2("Scene.s1.Token.t2.Actor.abc123", "item1", "act1");
    expect(first).not.toBe(second);
  });

  it("relocates an action from the actor's current documents without a catalog", () => {
    const actor = mockActor("Scene.s1.Token.t1.Actor.abc123", [
      mockItem("item1", "Longsword", ["act1", "act2"]),
      mockItem("item2", "Shortbow", ["act3"]),
    ]);
    const candidates = collectActionCandidatesV2(actor);
    const target = candidates.find(c => c.itemId === "item2" && c.activityId === "act3")!;
    const located = locateActionByIdV2(actor, target.actionId);
    expect(located?.item.id).toBe("item2");
    expect(located?.activity.id).toBe("act3");
  });

  it("returns null for an unknown action ID", () => {
    const actor = mockActor("Actor.abc123", [mockItem("item1", "Longsword", ["act1"])]);
    expect(locateActionByIdV2(actor, "a2_0000000000000000")).toBeNull();
    expect(locateActionByIdV2(actor, "")).toBeNull();
  });

  it("tolerates plain-object item and activity collections", () => {
    const actor = {
      uuid: "Actor.abc123",
      items: {
        item1: {
          id: "item1",
          name: "Longsword",
          system: { activities: { act1: { id: "act1", type: "attack" } } },
        },
      },
    };
    const candidates = collectActionCandidatesV2(actor);
    expect(candidates).toHaveLength(1);
    expect(locateActionByIdV2(actor, candidates[0]!.actionId)?.itemId).toBe("item1");
  });
});

describe("agent-callable activities", () => {
  it("keeps ordinary activities, exposes exact SUM-NATIVE, and rejects unmarked or legacy summons", () => {
    const nativeSummon = nativeSummonActivityFixture();
    expect(isAgentCallableActivityV2({ type: "save", midiProperties: {} })).toBe(true);
    expect(isAgentCallableActivityV2({ type: "summon", midiProperties: {} })).toBe(false);
    expect(isAgentCallableActivityV2({
      type: "summon",
      flags: { "arcane-dnd5e-2014-automation": { summon: { version: 1 } } },
    })).toBe(false);
    expect(isAgentCallableActivityV2(nativeSummon)).toBe(true);
    expect(isAgentCallableActivityV2({
      ...nativeSummon,
      midiProperties: { automationOnly: true },
    })).toBe(false);
    expect(isAgentCallableActivityV2({ type: "save", midiProperties: { automationOnly: true } })).toBe(false);
    expect(isAgentCallableActivityV2({ type: "damage", isOverTimeFlag: true })).toBe(false);
    expect(isAgentCallableActivityV2({ type: "enchant" })).toBe(false);
  });

  it("only exposes activities that resolve to one of the three public inputs", () => {
    const creatureItem = { system: { target: { affects: { type: "creature" } } } };
    expect(isAgentCallableActionV2(creatureItem, { type: "save" })).toBe(true);
    expect(isAgentCallableActionV2({ system: {} }, { type: "utility" })).toBe(false);
    expect(
      isAgentCallableActionV2(
        { system: { target: { affects: { type: "self" } } } },
        nativeSummonActivityFixture(),
      ),
    ).toBe(true);
    expect(
      isAgentCallableActionV2(
        { system: { target: { affects: { type: "object" } } } },
        { type: "save" },
      ),
    ).toBe(false);
  });

  it("requires the exact native summon marker and one matching native profile", () => {
    const activity = nativeSummonActivityFixture(2);
    expect(resolveNativeSummonActivityV2(activity)).toEqual({
      nativeProfileId: "native-profile-1",
      profileUuid: "Compendium.arcane-dnd5e-2014-automation.summons.Actor.spiritual-weapon",
      expectedCount: 2,
      profileId: "spiritual-weapon",
      marker: activity.flags["arcane-dnd5e-2014-automation"].nativeSummon,
    });

    const withExtraMarkerKey = structuredClone(activity);
    withExtraMarkerKey.flags["arcane-dnd5e-2014-automation"].nativeSummon.version = 1;
    expect(resolveNativeSummonActivityV2(withExtraMarkerKey)).toBeNull();

    const mismatchedCount = structuredClone(activity);
    mismatchedCount.profiles[0].count = 1;
    expect(resolveNativeSummonActivityV2(mismatchedCount)).toBeNull();

    const multipleProfiles = structuredClone(activity);
    multipleProfiles.profiles.push({
      _id: "native-profile-2",
      uuid: "Compendium.arcane-dnd5e-2014-automation.summon-actors.Actor.profile-2",
      count: 2,
    });
    expect(resolveNativeSummonActivityV2(multipleProfiles)).toBeNull();
  });

  it.each([
    { name: "concentration", lifecycle: nativeSummonLifecycleFixtures.concentration },
    { name: "root concentration", lifecycle: nativeSummonLifecycleFixtures.rootConcentration },
    { name: "DM duration", lifecycle: nativeSummonLifecycleFixtures.dmDuration },
    { name: "native", lifecycle: nativeSummonLifecycleFixtures.native },
  ])("accepts and stably projects the exact $name lifecycle receipt", ({ lifecycle }) => {
    const projected = resolveNativeSummonLifecycleV2(lifecycle);
    expect(projected).toEqual(lifecycle);
    expect(projected).not.toBe(lifecycle);
  });

  it.each([
    { name: "legacy string", lifecycle: "dm-duration" },
    { name: "missing effectUuid", lifecycle: { mode: "dm-duration" } },
    {
      name: "extra key",
      lifecycle: { mode: "dm-duration", effectUuid: null, version: 1 },
    },
    {
      name: "effectless concentration",
      lifecycle: { mode: "concentration", effectUuid: null },
    },
    {
      name: "blank concentration effect",
      lifecycle: { mode: "concentration", effectUuid: " " },
    },
    {
      name: "DM duration with an effect",
      lifecycle: {
        mode: "dm-duration",
        effectUuid: "Actor.source.ActiveEffect.unexpected",
      },
    },
    { name: "unknown mode", lifecycle: { mode: "until-rest", effectUuid: null } },
  ])("rejects the malformed $name lifecycle receipt", ({ lifecycle }) => {
    expect(resolveNativeSummonLifecycleV2(lifecycle)).toBeNull();
  });
});

describe("Foundry-owned distance and range checks", () => {
  it("uses midi-qol's distance API instead of calculating grid diagonals in the CLI", () => {
    const fromToken = { id: "source" };
    const toToken = { id: "target" };
    const getDistance = vi.fn(() => 35);
    const measurePath = vi.fn(() => ({ distance: 999 }));

    expect(
      measureTokenDistanceWithFoundry(
        { MidiQOL: { getDistance }, canvas: { grid: { measurePath } } },
        fromToken,
        toToken,
      ),
    ).toBe(35);
    expect(getDistance).toHaveBeenCalledWith(fromToken, toToken, {
      wallsBlock: false,
      includeCover: false,
    });
    expect(measurePath).not.toHaveBeenCalled();
  });

  it("falls back to Foundry's grid measurePath API when midi-qol cannot measure", () => {
    const measurePath = vi.fn(() => ({ distance: 15 }));
    const fromToken = {
      document: { id: "source", elevation: 0 },
      center: { x: 50, y: 50 },
    };
    const toToken = {
      document: { id: "target", elevation: 10 },
      center: { x: 250, y: 150 },
    };

    expect(
      measureTokenDistanceWithFoundry(
        { canvas: { grid: { measurePath } } },
        fromToken,
        toToken,
      ),
    ).toBe(15);
    expect(measurePath).toHaveBeenCalledWith(
      [
        { x: 50, y: 50, elevation: 0 },
        { x: 250, y: 150, elevation: 10 },
      ],
      {},
    );
  });

  it("delegates boolean distance checks to midi-qol", () => {
    const fromToken = { id: "source" };
    const toToken = { id: "target" };
    const checkDistance = vi.fn(() => false);

    expect(
      isTokenWithinDistanceWithFoundry(
        { MidiQOL: { checkDistance } },
        fromToken,
        toToken,
        30,
      ),
    ).toBe(false);
    expect(checkDistance).toHaveBeenCalledWith(fromToken, toToken, 30, {
      wallsBlock: false,
      includeCover: false,
    });
  });

  it("accepts normal and long-range-disadvantage activity checks, but rejects failures", () => {
    const activity = { id: "activity" };
    const sourceToken = { id: "source" };
    const targetTokens = [{ id: "target" }];
    const checkActivityRange = vi
      .fn()
      .mockReturnValueOnce({ result: "normal" })
      .mockReturnValueOnce({ result: "dis" })
      .mockReturnValueOnce({ result: "fail" });
    const runtime = { MidiQOL: { checkActivityRange } };

    expect(
      checkActivityTargetRangeWithFoundry(runtime, activity, sourceToken, targetTokens),
    ).toBe("valid");
    expect(
      checkActivityTargetRangeWithFoundry(runtime, activity, sourceToken, targetTokens),
    ).toBe("valid");
    expect(
      checkActivityTargetRangeWithFoundry(runtime, activity, sourceToken, targetTokens),
    ).toBe("invalid");
    expect(checkActivityRange).toHaveBeenCalledWith(
      activity,
      sourceToken,
      new Set(targetTokens),
      false,
    );
  });
});


describe("Foundry target detection", () => {
  const gameTarget = (id: string, url = "https://foundry.example/game") => ({
    id,
    type: "page",
    title: `Foundry ${id}`,
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
  });

  it("accepts debuggable Foundry /game tabs", () => {
    expect(
      isFoundryGameTarget({
        id: "1",
        type: "page",
        title: "Foundry",
        url: "https://foundry.example/game",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1",
      })
    ).toBe(true);
  });

  it("matches target-url as an exact origin or complete URL", () => {
    const target = gameTarget("1", "https://foundry.example/game?world=cos");

    expect(isFoundryGameTarget(target, "https://foundry.example")).toBe(true);
    expect(
      isFoundryGameTarget(target, "https://foundry.example/game?world=cos")
    ).toBe(true);
    expect(isFoundryGameTarget(target, "https://foundry.example/game")).toBe(false);
  });

  it("rejects approximate target URLs and invalid substring selectors", () => {
    const target = gameTarget("1");

    for (const targetUrl of [
      "https://foundry.example.evil.invalid",
      "https://evil.invalid/game?next=https://foundry.example/game",
      "https://foundry.example/game/",
    ]) {
      expect(isFoundryGameTarget(target, targetUrl)).toBe(false);
    }
    expect(() => isFoundryGameTarget(target, "foundry.example")).toThrow(
      "must be an absolute http(s) URL or origin"
    );
  });

  it("fails closed when multiple game tabs match", () => {
    expect(() => selectFoundryTarget(
      [gameTarget("first"), gameTarget("second")],
      { targetUrl: "https://foundry.example" },
    )).toThrow("Multiple debuggable Foundry /game tabs match");
  });

  it("selects only an exact target id when game tabs have identical URLs", () => {
    const targets = [gameTarget("game-1"), gameTarget("game-2")];

    expect(selectFoundryTarget(targets, { targetId: "game-2" }).id).toBe("game-2");
    expect(() => selectFoundryTarget(targets, { targetId: "game" })).toThrow(
      "No debuggable Foundry /game tab found"
    );
  });

  it("rejects non-debuggable or non-game pages", () => {
    expect(
      isFoundryGameTarget({
        id: "1",
        type: "page",
        title: "Join",
        url: "https://foundry.example/join",
      })
    ).toBe(false);
  });

  it("recognizes debuggable Foundry /join tabs as login candidates", () => {
    expect(
      isFoundryLoginTarget({
        id: "1",
        type: "page",
        title: "Join",
        url: "https://foundry.example/join",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1",
      })
    ).toBe(true);
  });

  it("prefers a unique /join page over an already logged-in /game page", () => {
    const target = selectFoundryLoginTarget(
      [
        {
          id: "game",
          type: "page",
          title: "Game",
          url: "http://127.0.0.1:30000/game",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/game",
        },
        {
          id: "join",
          type: "page",
          title: "Join",
          url: "http://127.0.0.1:30000/join",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/join",
        },
      ],
      "http://127.0.0.1:30000"
    );

    expect(target.id).toBe("join");
  });

  it("rejects ambiguous login tabs instead of choosing one silently", () => {
    expect(() =>
      selectFoundryLoginTarget(
        [
          {
            id: "join-1",
            type: "page",
            title: "Join 1",
            url: "http://127.0.0.1:30000/join",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/join-1",
          },
          {
            id: "join-2",
            type: "page",
            title: "Join 2",
            url: "http://127.0.0.1:30000/join?world=COS",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/join-2",
          },
        ],
        "http://127.0.0.1:30000"
      )
    ).toThrow("Multiple debuggable Foundry login tabs match");
  });

  it("requires an exact origin and ignores query/hash target spoofing", () => {
    const spoofed = {
      id: "evil",
      type: "page",
      title: "Fake Join",
      url: "https://evil.invalid/?next=http://127.0.0.1:30000/join",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/evil",
    };

    expect(isFoundryLoginTarget(spoofed, "http://127.0.0.1:30000")).toBe(false);
    expect(isFoundryLoginTargetForOrigin(spoofed, "http://127.0.0.1:30000")).toBe(false);
    expect(() =>
      selectFoundryLoginTarget([spoofed], "http://127.0.0.1:30000")
    ).toThrow("No debuggable Foundry /join or /game tab found");
  });

  it("rejects an origin containing credentials, a path, query, or fragment", () => {
    for (const origin of [
      "127.0.0.1:30000",
      "http://user:password@127.0.0.1:30000",
      "http://127.0.0.1:30000/join",
      "http://127.0.0.1:30000?next=/join",
      "http://127.0.0.1:30000#join",
    ]) {
      expect(() => normalizeFoundryLoginOrigin(origin)).toThrow();
    }
    expect(normalizeFoundryLoginOrigin("http://127.0.0.1:30000/")).toBe(
      "http://127.0.0.1:30000"
    );
  });

  it("does not echo invalid origin credentials in validation errors", () => {
    const secret = "ORIGIN_SENTINEL";
    try {
      normalizeFoundryLoginOrigin(`http://review:${secret}@127.0.0.1:30000`);
      throw new Error("Expected origin validation to fail");
    } catch (error) {
      expect(JSON.stringify(errorToJson(error))).not.toContain(secret);
    }
  });

  it("selects only an exact /game page for one-shot reload", () => {
    const target = selectFoundryPageReloadTarget(
      [
        {
          id: "join",
          type: "page",
          title: "Join",
          url: "http://127.0.0.1:30101/join",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/join",
        },
        {
          id: "game",
          type: "page",
          title: "Game",
          url: "http://127.0.0.1:30101/game",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/game",
        },
      ],
      "http://127.0.0.1:30101/game",
      "http://127.0.0.1:30101",
    );

    expect(target.id).toBe("game");
  });

  it("rejects a wrong reload path and query instead of using substring matching", () => {
    for (const url of [
      "http://127.0.0.1:30101/join",
      "http://127.0.0.1:30101/game?next=/game",
    ]) {
      expect(() => selectFoundryPageReloadTarget(
        [{
          id: "wrong",
          type: "page",
          title: "Wrong",
          url,
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/wrong",
        }],
        "http://127.0.0.1:30101",
        "http://127.0.0.1:30101",
      )).toThrow("No unique debuggable Foundry /game tab found");
    }
  });

  it("rejects multiple exact reload targets instead of picking the first tab", () => {
    expect(() => selectFoundryPageReloadTarget(
      ["first", "second"].map(id => ({
        id,
        type: "page",
        title: id,
        url: "http://127.0.0.1:30101/game",
        webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
      })),
      "http://127.0.0.1:30101",
      "http://127.0.0.1:30101",
    )).toThrow("Multiple debuggable Foundry /game tabs match");
  });
});

describe("Foundry login", () => {
  const users = [
    { value: "", text: "" },
    { value: "gm2-id", text: "GM2" },
    { value: "gm-id", text: "Gamemaster" },
  ];

  it("resolves a user by exact display name or ID", () => {
    expect(resolveFoundryLoginUser(users, "GM2")).toEqual({
      ok: true,
      user: { id: "gm2-id", name: "GM2" },
    });
    expect(resolveFoundryLoginUser(users, "gm-id")).toEqual({
      ok: true,
      user: { id: "gm-id", name: "Gamemaster" },
    });
  });

  it("reports missing, duplicate, and disabled users", () => {
    expect(resolveFoundryLoginUser(users, "Missing")).toMatchObject({
      ok: false,
      code: "ERR_LOGIN_USER_NOT_FOUND",
    });
    expect(
      resolveFoundryLoginUser(
        [
          { value: "first", text: "GM2" },
          { value: "second", text: "GM2" },
        ],
        "GM2"
      )
    ).toMatchObject({
      ok: false,
      code: "ERR_LOGIN_USER_AMBIGUOUS",
    });
    expect(
      resolveFoundryLoginUser([{ value: "gm2-id", text: "GM2", disabled: true }], "GM2")
    ).toMatchObject({
      ok: false,
      code: "ERR_LOGIN_USER_UNAVAILABLE",
    });
  });

  it("keeps the injected login page functions syntactically valid", () => {
    expect(() => Function(`return (${foundryLoginSubmitFunction})`)).not.toThrow();
    expect(() => Function(`return (${foundryLoginStateFunction})`)).not.toThrow();
    expect(foundryLoginSubmitFunction.indexOf("globalThis.location.origin")).toBeLessThan(
      foundryLoginSubmitFunction.indexOf("passwordInput.value")
    );
  });

  it("validates the selected user and Gamemaster role", () => {
    const state = {
      href: "http://127.0.0.1:30000/game",
      title: "Foundry Virtual Tabletop",
      originMatches: true,
      joinFormReady: false,
      ready: true,
      user: { id: "gm2-id", name: "GM2", isGM: true },
      world: { id: "COS", title: "Curse of Strahd" },
      notifications: [],
    };

    expect(
      validateFoundryLoginState("GM2", "gm2-id", state, true, "logged-in")
    ).toMatchObject({
      status: "logged-in",
      user: { id: "gm2-id", name: "GM2", isGM: true },
    });

    expect(() =>
      validateFoundryLoginState("Gamemaster", undefined, state, true, "already-logged-in")
    ).toThrow("already logged in as GM2");
    expect(() =>
      validateFoundryLoginState(
        "GM2",
        "gm2-id",
        { ...state, user: { ...state.user, isGM: false } },
        true,
        "logged-in"
      )
    ).toThrow("is not a Gamemaster");

    expect(() =>
      assertFoundryLoginOrigin(
        {
          ...state,
          href: "https://evil.invalid/join",
          originMatches: false,
        },
        "http://127.0.0.1:30000"
      )
    ).toThrow("navigated away from the expected origin");
  });

  it("redacts a password recursively from login error output", () => {
    const secret = "REVIEW_SENTINEL";
    const redacted = redactJsonSecrets(
      {
        message: `Invalid password: ${secret}`,
        details: {
          exception: `input value was ${secret}`,
          nested: [`notification echoed ${secret}`],
        },
      },
      [secret]
    );

    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");

    expect(
      redactJsonSecrets(
        {
          ok: false,
          error: {
            code: "ERR_LOGIN_FAILED",
            message: "a",
            details: { data: "a" },
          },
        },
        ["a", "ok", "ERR"]
      )
    ).toEqual({
      ok: false,
      error: {
        code: "ERR_LOGIN_FAILED",
        message: "[REDACTED]",
        details: { data: "[REDACTED]" },
      },
    });
  });
});

describe("activity input contracts", () => {
  it("projects SUM-NATIVE as one explicit wait-for-human placement step", () => {
    const contract = deriveActivityInputContract(
      {
        system: {
          range: { value: 60, units: "ft" },
          target: { affects: { type: "space", count: "" } },
        },
      },
      nativeSummonActivityFixture(2),
    );

    expect(contract).toMatchObject({
      version: 2,
      mode: "self",
      source: "arcane-native-summon",
      supported: true,
      execution: "wait-for-human",
      humanStep: "native-summon-placement",
      required: [],
    });
  });

  it("derives immediate explicit-token input from inherited creature targets", () => {
    const contract = deriveActivityInputContract(
      {
        system: {
          range: { value: 120, units: "ft" },
          target: {
            affects: { type: "creature", count: "1", choice: false },
            template: {},
          },
        },
      },
      {
        type: "attack",
        range: { override: false },
        target: { override: false, prompt: false },
      }
    );

    expect(contract).toMatchObject({
      version: 2,
      mode: "selected-targets",
      supported: true,
      execution: "immediate",
      required: ["targetTokenIds"],
      optional: ["input.attackRollMode"],
      target: { type: "creature", count: "1" },
      range: { value: 120, units: "ft" },
    });
  });

  it("projects a valid pairwise selected-target distance constraint", () => {
    const item = {
      system: {
        range: { value: 60, units: "ft" },
        target: {
          affects: { type: "creature", count: "2", choice: false },
          template: {},
        },
      },
    };
    const activity = {
      type: "save",
      range: { override: false },
      target: { override: false, prompt: false },
      flags: {
        "arcane-dnd5e-2014-automation": {
          interaction: {
            version: 1,
            input: "selected-targets",
            selectionConstraints: [{
              type: "pairwise-within-distance",
              maximum: 5,
              units: "ft",
            }],
          },
        },
      },
    };

    expect(deriveActivityInputContract(item, activity)).toMatchObject({
      mode: "selected-targets",
      selectionConstraints: [{
        type: "pairwise-within-distance",
        maximum: 5,
        units: "ft",
      }],
    });
    expect(actionConfigProblemV2(item, activity)).toBeNull();
  });

  it("requires every field of a supported selection constraint", () => {
    expect(parseActivitySelectionConstraintsV2({
      selectionConstraints: [{
        type: "pairwise-within-distance",
        maximum: 5,
        units: "ft",
      }],
    })).toEqual({
      constraints: [{
        type: "pairwise-within-distance",
        maximum: 5,
        units: "ft",
      }],
      problem: null,
    });

    for (const [selectionConstraints, problem] of [
      [[{ type: "pairwise-within-distance", units: "ft" }],
        "interaction-selection-constraint-maximum-invalid"],
      [[{ type: "pairwise-within-distance", maximum: 5 }],
        "interaction-selection-constraint-units-invalid"],
      [[{ type: "nearest", maximum: 5, units: "ft" }],
        "interaction-selection-constraint-type-unsupported"],
      [[{ type: "pairwise-within-distance", maximum: "5", units: "ft" }],
        "interaction-selection-constraint-maximum-invalid"],
    ] as const) {
      expect(parseActivitySelectionConstraintsV2({
        selectionConstraints,
      }).problem).toBe(problem);
    }
    expect(parseActivitySelectionConstraintsV2({
      selectionConstraints: { type: "pairwise-within-distance" },
    }).problem).toBe("interaction-selection-constraints-invalid");
  });

  it("only permits pairwise token constraints on selected-target actions", () => {
    const item = {
      system: {
        range: { units: "self" },
        target: { affects: { type: "self" }, template: {} },
      },
    };
    const activity = {
      type: "utility",
      flags: {
        "arcane-dnd5e-2014-automation": {
          interaction: {
            version: 1,
            input: "self",
            selectionConstraints: [{
              type: "pairwise-within-distance",
              maximum: 5,
              units: "ft",
            }],
          },
        },
      },
    };

    expect(actionConfigProblemV2(item, activity)).toBe(
      "interaction-selection-constraints-require-selected-targets",
    );
  });

  it("exposes an explicit any-target default without adding a fourth input mode", () => {
    const contract = deriveActivityInputContract(
      {
        system: {
          range: { value: 30, units: "ft" },
          target: { affects: { type: "creature", count: "" } },
        },
      },
      {
        type: "utility",
        flags: {
          "arcane-dnd5e-2014-automation": {
            choiceDefault: {
              cardinality: "any",
              polarity: "beneficial",
              targetPolicy: "same-disposition-all",
              timing: "cast",
              includeSelf: true,
            },
          },
        },
      },
    );

    expect(contract).toMatchObject({
      mode: "selected-targets",
      required: [],
      choiceDefault: {
        cardinality: "any",
        polarity: "beneficial",
        targetPolicy: "same-disposition-all",
        includeSelf: true,
      },
    });
    expect(resolveTargetSpecForContract({}, contract)).toMatchObject({
      mode: "tokens",
      tokenIds: [],
      geometry: "default-choice",
      defaultPolicy: { targetPolicy: "same-disposition-all" },
    });
  });

  it("derives an interactive measured-template contract from inherited spell data", () => {
    const contract = deriveActivityInputContract(
      {
        system: {
          range: { value: 150, units: "ft" },
          target: {
            affects: { type: "", count: null },
            template: { type: "radius", size: 20, count: 1, units: "ft" },
          },
        },
      },
      {
        type: "utility",
        range: { override: false },
        target: { override: false, prompt: false },
      }
    );

    expect(contract).toMatchObject({
      version: 2,
      mode: "placed-template",
      supported: true,
      execution: "wait-for-human",
      required: [],
      template: {
        type: "radius",
        size: 20,
        units: "ft",
        origin: "manual-point",
        placement: "manual",
      },
      range: { value: 150, units: "ft" },
    });
  });

  it("keeps self-centered templates distinct from directional templates", () => {
    const radius = deriveActivityInputContract(
      {
        system: {
          range: { units: "self" },
          target: { template: { type: "radius", size: 10, units: "ft" }, affects: {} },
        },
      },
      { type: "save", target: { override: false }, range: { override: false } }
    );
    const cone = deriveActivityInputContract(
      {
        system: {
          range: { units: "self" },
          target: { template: { type: "cone", size: 15, units: "ft" }, affects: {} },
        },
      },
      { type: "save", target: { override: false }, range: { override: false } }
    );

    expect(radius.template).toMatchObject({ origin: "self-centered", placement: "self" });
    expect(radius.mode).toBe("self");
    expect(cone.template).toMatchObject({ origin: "self-directional", placement: "manual" });
    expect(cone.mode).toBe("placed-template");
  });

  it("preserves the dnd5e -self template-target exclusion in the input contract", () => {
    const contract = deriveActivityInputContract(
      {
        system: {
          range: { units: "self" },
          target: {
            template: { type: "radius", size: 10, units: "ft" },
            affects: { special: "-self" },
          },
        },
      },
      { type: "save", target: { override: false }, range: { override: false } },
    );

    expect(contract.mode).toBe("self");
    expect(contract.target.special).toBe("-self");
    expect(contract.template).toMatchObject({
      origin: "self-centered",
      placement: "self",
    });
  });

  it("treats a sparse Arcane declaration as authoritative", () => {
    const contract = deriveActivityInputContract(
      {
        system: {
          range: { value: 120, units: "ft" },
          target: { template: { type: "cube", size: 30, units: "ft" }, affects: {} },
        },
      },
      {
        type: "save",
        target: { override: false, prompt: true },
        flags: {
          "arcane-dnd5e-2014-automation": {
            interaction: { version: 1, input: "selected-targets" },
          },
        },
      },
    );
    expect(contract).toMatchObject({
      mode: "selected-targets",
      source: "arcane-override",
      required: ["targetTokenIds"],
      template: { type: "cube", placement: "manual" },
    });
  });

  it("honours activity target/range overrides before applying generic rules", () => {
    const contract = deriveActivityInputContract(
      {
        system: {
          range: { value: 120, units: "ft" },
          target: { template: { type: "cube", size: 30, units: "ft" } },
        },
      },
      {
        type: "save",
        range: { override: true, value: 5, units: "ft" },
        target: { override: true, affects: { type: "creature", count: "1" } },
      },
    );
    expect(contract).toMatchObject({
      mode: "selected-targets",
      target: { type: "creature", count: "1" },
      range: { value: 5, units: "ft" },
      template: null,
    });
  });

  it("projects and validates one required enum selection without multiplying actions", () => {
    const contract = deriveActivityInputContract(
      {
        system: {
          range: { value: 60, units: "ft" },
          target: {
            affects: { type: "humanoid", count: "" },
            template: { type: "radius", size: 20, units: "ft" },
          },
        },
      },
      {
        type: "save",
        flags: {
          "arcane-dnd5e-2014-automation": {
            interaction: {
              version: 1,
              input: "placed-template",
              templateTargets: "workflow",
              requiredSelections: [{
                id: "effectMode",
                type: "enum",
                required: true,
                values: [
                  { value: "suppress", label: "Suppress" },
                  { value: "indifferent", label: "Indifferent" },
                ],
              }],
            },
          },
        },
      },
    );

    expect(contract).toMatchObject({
      mode: "placed-template",
      required: ["input.selections.effectMode"],
      selections: [{
        id: "effectMode",
        type: "enum",
        required: true,
      }],
    });
    expect(
      resolveRequiredSelectionsForContract({
        selections: { effectMode: "suppress" },
      }, contract),
    ).toEqual({ effectMode: "suppress" });
    expect(() =>
      resolveRequiredSelectionsForContract({}, contract)
    ).toThrow("Missing required selection input.selections.effectMode");
    expect(() =>
      resolveRequiredSelectionsForContract({
        selections: { effectMode: "stale" },
      }, contract)
    ).toThrow("Invalid selection input.selections.effectMode");
    expect(() =>
      resolveRequiredSelectionsForContract({
        selections: { effectMode: "suppress", unknown: "x" },
      }, contract)
    ).toThrow("Unknown selections");
  });

  it("preserves the prepared target count and exposes the raw upcast formula", () => {
    const contract = deriveActivityInputContract(
      {
        type: "spell",
        system: {
          level: 3,
          target: { affects: { type: "creature", count: 1 } },
        },
      },
      {
        type: "utility",
        target: {
          override: true,
          affects: { type: "creature", count: 1 },
        },
        _source: {
          target: {
            override: true,
            affects: { type: "creature", count: "@item.level - 2" },
          },
        },
      },
    );

    expect(contract.target).toMatchObject({
      type: "creature",
      count: 1,
      countFormula: "@item.level - 2",
    });
  });

  it("does not reclassify a numeric raw target count as a formula", () => {
    const contract = deriveActivityInputContract(
      {
        system: { target: { affects: { type: "creature", count: 2 } } },
        _source: { system: { target: { affects: { type: "creature", count: "2" } } } },
      },
      { type: "utility", target: { override: false } },
    );

    expect(contract.target).toMatchObject({ count: 2, countFormula: null });
  });

  it("keeps unsupported actions out of the public three-mode contract", () => {
    for (const target of [{ affects: { type: "none" } }, { affects: { type: "space" } }, { affects: { type: "object" } }]) {
      const contract = deriveActivityInputContract({ system: { target } }, { type: "save" });
      expect(contract.mode).toBe("unsupported");
      expect(contract.supported).toBe(false);
      expect(["selected-targets", "self", "placed-template"]).not.toContain(contract.mode);
    }
  });
});

describe("upcast target count limits", () => {
  it("evaluates raw item-level formulas against an explicit spell level", () => {
    const item = { system: { level: 3 } };
    const contract = {
      target: {
        count: 1,
        countFormula: "@item.level - 2",
      },
    };

    expect(resolveActivityTargetCountLimit(item, contract, 5)).toBe(3);
    expect(resolveActivityTargetCountLimit(item, contract)).toBe(1);
  });

  it("supports generic arithmetic while preserving numeric and invalid-formula fallbacks", () => {
    expect(resolveActivityTargetCountLimit(
      { system: { level: 2 } },
      { target: { count: 1, countFormula: "(@item.level + 2) * 2" } },
      4,
    )).toBe(12);
    expect(resolveActivityTargetCountLimit(
      { system: { level: 1 } },
      { target: { count: "2", countFormula: null } },
      9,
    )).toBe(2);
    expect(resolveActivityTargetCountLimit(
      { system: { level: 1 } },
      { target: { count: 1, countFormula: "@actor.level" } },
      9,
    )).toBe(1);
  });
});

describe("targetSpec validation", () => {
  const tokenContract = { mode: "selected-targets" };
  const templateContract = {
    mode: "placed-template",
    template: { type: "cube", placement: "manual" },
  };

  it("accepts targetSpec token ids and the legacy alias for token actions", () => {
    expect(
      resolveTargetSpecForContract(
        { targetSpec: { mode: "tokens", tokenIds: ["A"] } },
        tokenContract
      )
    ).toMatchObject({ mode: "tokens", tokenIds: ["A"], createMeasuredTemplate: false });

    expect(
      resolveTargetSpecForContract({ targetTokenIds: ["B"] }, tokenContract)
    ).toMatchObject({ mode: "tokens", tokenIds: ["B"], geometry: "legacy-explicit" });

    expect(() => resolveTargetSpecForContract({}, tokenContract)).toThrow(/targetTokenIds are required/);
  });

  it("requires interactive template placement and rejects accidental explicit targets", () => {
    expect(
      resolveTargetSpecForContract({}, templateContract)
    ).toMatchObject({
      mode: "template",
      tokenIds: [],
      placement: "manual",
      createMeasuredTemplate: true,
      inputMode: "placed-template",
    });

    expect(() =>
      resolveTargetSpecForContract({ targetTokenIds: ["A"] }, templateContract)
    ).toThrow(/only accepted|does not match|forbidden/);
  });

  it("allows an explicit GM-declared geometry bypass for template actions", () => {
    expect(
      resolveTargetSpecForContract(
        {
          targetSpec: {
            mode: "tokens",
            tokenIds: ["A", "B"],
            geometry: "gm-declared",
          },
        },
        templateContract
      )
    ).toMatchObject({
      mode: "tokens",
      tokenIds: ["A", "B"],
      geometry: "gm-declared",
      bypassedTemplateGeometry: true,
      createMeasuredTemplate: false,
    });
  });

  it("defaults self actions and refuses unsupported point/object modes", () => {
    expect(resolveTargetSpecForContract({}, { mode: "self" })).toMatchObject({
      mode: "self",
      tokenIds: ["self"],
    });
    expect(() =>
      resolveTargetSpecForContract(
        { targetSpec: { mode: "point", placement: "manual" } },
        { mode: "point" }
      )
    ).toThrow(/not implemented/);
  });

  it("keeps an auto-placed self template internal to a self input contract", () => {
    expect(
      resolveTargetSpecForContract(
        {},
        { mode: "self", template: { type: "radius", placement: "self" } },
      ),
    ).toMatchObject({
      mode: "template",
      inputMode: "self",
      placement: "self",
    });
  });

  it("suppresses a misleading manually placed template when self is authoritative", () => {
    expect(
      resolveTargetSpecForContract(
        {},
        { mode: "self", template: { type: "radius", placement: "manual" } },
      ),
    ).toMatchObject({
      mode: "self",
      inputMode: "self",
      createMeasuredTemplate: false,
    });
  });
});

describe("dynamic activity availability", () => {
  const activity = {
    flags: {
      "arcane-dnd5e-2014-automation": {
        availability: { requiresEffectIdentifier: "aura-of-vitality" },
      },
    },
  };

  it("requires a matching enabled Arcane source effect", () => {
    expect(isActionAvailableV2({ effects: [] }, activity)).toBe(false);
    expect(isActionAvailableV2({
      effects: [{
        disabled: false,
        flags: {
          "arcane-dnd5e-2014-automation": { identifier: "aura-of-vitality" },
        },
      }],
    }, activity)).toBe(true);
    expect(isActionAvailableV2({
      effects: [{
        disabled: true,
        flags: {
          "arcane-dnd5e-2014-automation": { identifier: "aura-of-vitality" },
        },
      }],
    }, activity)).toBe(false);
  });

  it("requires the exact compiler artifact when the emitter provides one", () => {
    const artifactActivity = {
      flags: {
        "arcane-dnd5e-2014-automation": {
          availability: {
            requiresEffectIdentifier: "aura-of-vitality",
            requiresArtifactId: "aura-source",
          },
        },
      },
    };
    const effect = (
      compilerArtifactIds: string[],
      state: Record<string, unknown> = {},
    ) => ({
      ...state,
      disabled: false,
      flags: {
        "arcane-dnd5e-2014-automation": {
          identifier: "aura-of-vitality",
          compilerArtifactIds,
        },
      },
    });

    expect(isActionAvailableV2({
      effects: [effect(["some-other-effect"])],
    }, artifactActivity)).toBe(false);
    expect(isActionAvailableV2({
      effects: [effect(["aura-source", "range-indicator"])],
    }, artifactActivity)).toBe(true);
    expect(isActionAvailableV2({
      effects: [effect(["aura-source"], { active: false })],
    }, artifactActivity)).toBe(false);
    expect(isActionAvailableV2({
      effects: [effect(["aura-source"], { isSuppressed: true })],
    }, artifactActivity)).toBe(false);
  });
});

describe("structured action blocks", () => {
  const effect = {
    id: "gaseous",
    name: "Gaseous Form",
    flags: {
      "arcane-dnd5e-2014-automation": {
        blockedActionKinds: ["attack", "spell"],
      },
    },
  };

  it("blocks spell Items and attack activities without blocking utility feats", () => {
    const actor = { effects: [effect] };
    expect(actionBlockV2(actor, { type: "spell" }, { type: "save" })).toMatchObject({
      kind: "spell",
      effectId: "gaseous",
    });
    expect(actionBlockV2(actor, { type: "weapon" }, { type: "attack" })).toMatchObject({
      kind: "attack",
      effectId: "gaseous",
    });
    expect(actionBlockV2(actor, { type: "feat" }, { type: "utility" })).toBeNull();
  });

  it("blocks reactions according to the effective inherited activation", () => {
    const actor = {
      effects: [{
        id: "reaction-block",
        name: "Reaction Block",
        flags: {
          "arcane-dnd5e-2014-automation": {
            blockedActionKinds: ["reaction"],
          },
        },
      }],
    };
    const item = {
      type: "feat",
      system: { activation: { type: "reaction" } },
    };
    const inheritedActivity = {
      type: "utility",
      activation: { type: "action", override: false },
    };
    const overriddenActivity = {
      type: "utility",
      activation: { type: "bonus", override: true },
    };

    expect(effectiveActivityActivationTypeV2(item, inheritedActivity)).toBe(
      "reaction",
    );
    expect(actionBlockV2(actor, item, inheritedActivity)).toMatchObject({
      kind: "reaction",
      effectId: "reaction-block",
    });
    expect(effectiveActivityActivationTypeV2(item, overriddenActivity)).toBe(
      "bonus",
    );
    expect(actionBlockV2(actor, item, overriddenActivity)).toBeNull();
  });

  it("ignores disabled, suppressed, and inactive effects", () => {
    for (const state of [
      { disabled: true },
      { isSuppressed: true },
      { active: false },
    ]) {
      expect(actionBlockV2(
        { effects: [{ ...effect, ...state }] },
        { type: "spell" },
        { type: "attack" },
      )).toBeNull();
    }
  });
});

describe("activity use create options", () => {
  it("asks dnd5e to create one exact native summon profile under a request id", () => {
    expect(
      buildActivityUseCreateOptions(
        { mode: "self", createMeasuredTemplate: false },
        resolveNativeSummonActivityV2(nativeSummonActivityFixture(2)),
        "native-request-1",
      ),
    ).toEqual({
      create: {
        measuredTemplate: false,
        summons: true,
      },
      summons: {
        profile: "native-profile-1",
        arcaneNativeRequestId: "native-request-1",
      },
    });
  });

  it("rejects a native summon usage without an invocation request id", () => {
    expect(() => buildActivityUseCreateOptions(
      { mode: "self", createMeasuredTemplate: false },
      resolveNativeSummonActivityV2(nativeSummonActivityFixture()),
      null,
    )).toThrow("native summon requestId is required");
  });

  it("lets template activity prompts own interactive placement", () => {
    expect(
      buildActivityUseCreateOptions({
        mode: "template",
        createMeasuredTemplate: true,
      })
    ).toEqual({});
  });

  it("prevents non-template actions from creating measured templates", () => {
    expect(
      buildActivityUseCreateOptions({
        mode: "tokens",
        createMeasuredTemplate: false,
      })
    ).toEqual({
      create: {
        measuredTemplate: false,
      },
    });
  });
});

describe("native spell slot consumption", () => {
  it("resolves Pact Magic to the actor's single-level pact pool", () => {
    const result = resolveNativeSpellSlotConsumption(
      { type: "spell", system: { method: "pact", level: 1 } },
      { consumption: { spellSlot: true } },
      { system: { spells: { pact: { value: 2, max: 2, level: 3 } } } },
      { pact: { getSpellSlotKey: () => "pact" } },
    );
    expect(result).toEqual({ key: "pact", value: 2, max: 2, level: 3 });
  });

  it("resolves ordinary prepared spells by their spell level", () => {
    const result = resolveNativeSpellSlotConsumption(
      { type: "spell", system: { method: "spell", level: 2 } },
      { consumption: { spellSlot: true } },
      { system: { spells: { spell2: { value: 3, max: 3, level: 2 } } } },
      { spell: { getSpellSlotKey: (level: number) => `spell${level}` } },
    );
    expect(result).toEqual({ key: "spell2", value: 3, max: 3, level: 2 });
  });

  it("resolves an explicitly requested ordinary spell slot without falling back", () => {
    const item = { type: "spell", system: { method: "spell", level: 1 } };
    const activity = { consumption: { spellSlot: true } };
    const spellcasting = { spell: { getSpellSlotKey: (level: number) => `spell${level}` } };

    expect(resolveNativeSpellSlotConsumption(
      item,
      activity,
      { system: { spells: { spell1: { value: 4 }, spell3: { value: 2, max: 3 } } } },
      spellcasting,
      3,
    )).toEqual({ key: "spell3", value: 2, max: 3, level: 3 });

    expect(() => resolveNativeSpellSlotConsumption(
      item,
      activity,
      { system: { spells: { spell1: { value: 4 } } } },
      spellcasting,
      3,
    )).toThrow("Spell slot spell3 is not available on this actor");
  });

  it("rejects invalid explicit spell levels instead of coercing or falling back", () => {
    const actor = { system: { spells: { spell1: { value: 4 }, spell2: { value: 3 } } } };
    const activity = { consumption: { spellSlot: true } };
    const spellcasting = { spell: { getSpellSlotKey: (level: number) => `spell${level}` } };

    expect(() => resolveNativeSpellSlotConsumption(
      { type: "spell", system: { method: "spell", level: 2 } },
      activity,
      actor,
      spellcasting,
      1,
    )).toThrow("cannot be lower than the spell's base level 2");
    expect(() => resolveNativeSpellSlotConsumption(
      { type: "spell", system: { method: "spell", level: 1 } },
      activity,
      actor,
      spellcasting,
      "2",
    )).toThrow("spellLevel must be an integer from 1 to 9");
    expect(() => resolveNativeSpellSlotConsumption(
      { type: "spell", system: { method: "pact", level: 1 } },
      activity,
      { system: { spells: { pact: { value: 2, level: 3 } } } },
      { pact: { getSpellSlotKey: () => "pact" } },
      3,
    )).toThrow("spellLevel is only supported for ordinary spell slots");
  });

  it("ignores cantrips and activities that do not consume spell slots", () => {
    expect(resolveNativeSpellSlotConsumption(
      { type: "spell", system: { method: "pact", level: 0 } },
      { consumption: { spellSlot: false } },
      { system: { spells: { pact: { value: 2 } } } },
      {},
    )).toBeNull();
  });
});


describe("turn protocol v2 response serializer", () => {
  const done = (actionId: string) => ({ actionId, started: true, completed: true });
  const failed = (actionId: string) => ({ actionId, started: true, completed: false, error: "boom" });

  it("returns only completed when all actions and advance are done", () => {
    expect(
      serializeTurnResponseV2({
        actions: [done("a2_x")],
        advanceRequested: true,
        advanceStarted: true,
        advanceCompleted: true,
      })
    ).toEqual({ status: "completed" });
  });

  it("returns completed for a single action without advance", () => {
    expect(
      serializeTurnResponseV2({
        actions: [done("a2_x")],
        advanceRequested: false,
        advanceStarted: false,
        advanceCompleted: false,
      })
    ).toEqual({ status: "completed" });
  });

  it("passes through one exact native summon receipt and only for one action", () => {
    const receipt = nativeSummonReceiptFixture(2);
    expect(serializeTurnResponseV2({
      actions: [{ ...done("a2_native"), receipt }],
      advanceRequested: false,
      advanceStarted: false,
      advanceCompleted: false,
    })).toEqual({ status: "completed", receipt });

    expect(serializeTurnResponseV2({
      actions: [
        { ...done("a2_native"), receipt },
        done("a2_other"),
      ],
      advanceRequested: false,
      advanceStarted: false,
      advanceCompleted: false,
    })).toEqual({ status: "completed" });
  });

  it("returns rejected when schema-level validation fails with no side effects", () => {
    expect(
      serializeTurnResponseV2({
        rejectedCode: "ACTION_NOT_FOUND",
        actions: [],
        advanceRequested: true,
        advanceStarted: false,
        advanceCompleted: false,
      })
    ).toEqual({ status: "rejected", code: "ACTION_NOT_FOUND" });
  });

  it("preserves schema-level validation detail for the DM", () => {
    expect(
      serializeTurnResponseV2({
        rejectedCode: "INPUT_INVALID",
        rejectedMessage: "Missing required selection input.selections.damageType",
        actions: [],
        advanceRequested: false,
        advanceStarted: false,
        advanceCompleted: false,
      })
    ).toEqual({
      status: "rejected",
      code: "INPUT_INVALID",
      message: "Missing required selection input.selections.damageType",
    });
  });

  it("preserves a pre-submit mechanical error for the DM", () => {
    expect(
      serializeTurnResponseV2({
        actions: [{
          actionId: "a2_spell",
          started: false,
          completed: false,
          error: "No spell3 spell slots remain for Cure Wounds",
        }],
        advanceRequested: false,
        advanceStarted: false,
        advanceCompleted: false,
      })
    ).toEqual({
      status: "rejected",
      code: "INPUT_INVALID",
      message: "No spell3 spell slots remain for Cure Wounds",
    });
  });

  it("returns partial when the first action completed and the second failed", () => {
    expect(
      serializeTurnResponseV2({
        actions: [done("a2_1"), failed("a2_2")],
        advanceRequested: true,
        advanceStarted: false,
        advanceCompleted: false,
      })
    ).toEqual({ status: "partial", completed: 1, requested: 2, advance: "not-completed", retry: false });
  });

  it("returns partial when actions completed but advance failed before starting", () => {
    expect(
      serializeTurnResponseV2({
        actions: [done("a2_1")],
        advanceRequested: true,
        advanceStarted: false,
        advanceCompleted: false,
      })
    ).toEqual({ status: "partial", completed: 1, requested: 1, advance: "not-completed", retry: false });
  });

  it("returns indeterminate when a submitted action cannot be confirmed", () => {
    expect(
      serializeTurnResponseV2({
        actions: [failed("a2_1")],
        advanceRequested: false,
        advanceStarted: false,
        advanceCompleted: false,
      })
    ).toEqual({ status: "indeterminate", retry: false });
  });

  it("returns indeterminate when advance started but completion is unconfirmed", () => {
    expect(
      serializeTurnResponseV2({
        actions: [done("a2_1")],
        advanceRequested: true,
        advanceStarted: true,
        advanceCompleted: false,
      })
    ).toEqual({ status: "indeterminate", retry: false });
  });

  it("returns partial (not indeterminate) when one action is confirmed and another is not", () => {
    const response = serializeTurnResponseV2({
      actions: [done("a2_1"), failed("a2_2")],
      advanceRequested: false,
      advanceStarted: false,
      advanceCompleted: false,
    });
    expect(response.status).toBe("partial");
    expect(response).toMatchObject({ retry: false });
  });

  it("never allows retry on partial or indeterminate", () => {
    const partial = serializeTurnResponseV2({
      actions: [done("a2_1"), failed("a2_2")],
      advanceRequested: true,
      advanceStarted: false,
      advanceCompleted: false,
    });
    const indeterminate = serializeTurnResponseV2({
      actions: [failed("a2_1")],
      advanceRequested: false,
      advanceStarted: false,
      advanceCompleted: false,
    });
    expect(JSON.stringify(partial)).not.toContain('"retry":true');
    expect(JSON.stringify(indeterminate)).not.toContain('"retry":true');
  });

  it("produces the exact slim completed body", () => {
    const response = serializeTurnResponseV2({
      actions: [done("a2_1")],
      advanceRequested: false,
      advanceStarted: false,
      advanceCompleted: false,
    });
    expect(JSON.stringify(response)).toBe('{"status":"completed"}');
  });
});


describe("direct runtime injection", () => {
  afterEach(() => {
    delete (globalThis as any).__arcaneNativeSummonPlacementFlight;
  });

  function installSpellExecuteRuntime(
    spellSlots: Record<string, { value: number; max?: number; level?: number }>,
    fixtureOptions: {
      baseLevel?: number;
      preparedTargetCount?: number;
      rawTargetCountFormula?: string;
      targetIds?: string[];
      templateType?: string;
      selectionConstraints?: Array<{
        type: "pairwise-within-distance";
        maximum: number;
        units: "ft";
      }>;
      itemActivationType?: string;
      activityType?: string;
      activityActivation?: {
        type?: string;
        override?: boolean;
      };
    } = {},
  ) {
    const usesActivityTargetFormula = !!fixtureOptions.rawTargetCountFormula;
    const usesTemplateTarget = !!fixtureOptions.templateType;
    const activity = {
      id: "activity-1",
      uuid: "Actor.source.Item.item-1.Activity.activity-1",
      name: "Cast",
      type: fixtureOptions.activityType ?? "save",
      target: usesActivityTargetFormula
        ? {
            override: true,
            affects: {
              type: "creature",
              count: fixtureOptions.preparedTargetCount ?? 1,
            },
          }
        : usesTemplateTarget
          ? { override: false, prompt: true }
          : { override: false },
      range: { override: false },
      consumption: { spellSlot: true },
      ...(fixtureOptions.activityActivation
        ? { activation: fixtureOptions.activityActivation }
        : {}),
      ...(fixtureOptions.selectionConstraints
        ? {
            flags: {
              "arcane-dnd5e-2014-automation": {
                interaction: {
                  version: 1,
                  input: "selected-targets",
                  selectionConstraints: fixtureOptions.selectionConstraints,
                },
              },
            },
          }
        : {}),
      ...(usesActivityTargetFormula
        ? {
            _source: {
              target: {
                override: true,
                affects: {
                  type: "creature",
                  count: fixtureOptions.rawTargetCountFormula,
                },
              },
            },
          }
        : {}),
    };
    const item = {
      id: "item-1",
      uuid: "Actor.source.Item.item-1",
      name: "Cure Wounds",
      type: "spell",
      system: {
        method: "spell",
        level: fixtureOptions.baseLevel ?? 1,
        activation: {
          type: fixtureOptions.itemActivationType ?? "action",
          value: 1,
        },
        activities: new Map([[activity.id, activity]]),
        target: usesTemplateTarget
          ? {
              affects: { type: "creature", count: "" },
              template: { type: fixtureOptions.templateType, size: 10 },
            }
          : {
              affects: {
                type: "creature",
                count: fixtureOptions.preparedTargetCount ?? 1,
              },
            },
        range: { value: 30, units: "ft" },
      },
    };
    const actor: any = {
      id: "actor-source",
      name: "Caster",
      uuid: "Actor.source",
      items: new Map([[item.id, item]]),
      effects: [],
      system: {
        attributes: { hp: { value: 10, max: 10, temp: 0 } },
        spells: structuredClone(spellSlots),
      },
    };
    actor.update = vi.fn(async (updates: Record<string, unknown>) => {
      for (const [path, value] of Object.entries(updates)) {
        const match = /^system\.spells\.([^.]+)\.value$/.exec(path);
        const slotKey = match?.[1];
        if (slotKey && actor.system.spells[slotKey]) {
          actor.system.spells[slotKey].value = value;
        }
      }
      return actor;
    });
    const sourceToken = {
      id: "source",
      name: "Source",
      actor,
      document: {
        id: "source",
        uuid: "Scene.scene.Token.source",
        name: "Source",
        disposition: 1,
        parent: { id: "scene" },
      },
    };
    const targetTokens = (fixtureOptions.targetIds ?? ["target"]).map((targetId, index) => ({
      id: targetId,
      name: "Target " + (index + 1),
      actor: {
        id: "actor-" + targetId,
        name: "Target " + (index + 1),
        uuid: "Actor." + targetId,
        items: new Map(),
        effects: [],
        system: { attributes: { hp: { value: 10, max: 10, temp: 0 } } },
      },
      document: {
        id: targetId,
        uuid: "Scene.scene.Token." + targetId,
        name: "Target " + (index + 1),
        disposition: -1,
        parent: { id: "scene" },
      },
    }));
    const tokens = new Map([
      [sourceToken.id, sourceToken],
      ...targetTokens.map(targetToken => [targetToken.id, targetToken] as const),
    ]);
    const controlledTokens: any[] = [];
    const tokenLayer: any = {
      placeables: Array.from(tokens.values()),
      get: (id: string) => tokens.get(id),
      controlled: controlledTokens,
      releaseAll: vi.fn(() => {
        controlledTokens.splice(0, controlledTokens.length);
      }),
    };
    for (const token of tokens.values()) {
      (token as any).control = vi.fn((options: { releaseOthers?: boolean } = {}) => {
        if (options.releaseOthers) controlledTokens.splice(0, controlledTokens.length);
        if (!controlledTokens.includes(token)) controlledTokens.push(token);
        return true;
      });
      (token as any).release = vi.fn(() => {
        const index = controlledTokens.indexOf(token);
        if (index >= 0) controlledTokens.splice(index, 1);
        return true;
      });
    }
    const combatant = {
      id: "combatant-source",
      uuid: "Combat.combat.Combatant.combatant-source",
      actorId: actor.id,
      tokenId: sourceToken.id,
      sceneId: "scene",
      name: sourceToken.name,
      token: sourceToken,
      initiative: 17,
    };
    const nextTurn = vi.fn(async () => undefined);
    const completeItemUse = vi.fn(async (
      _usedItem: unknown,
      _usageConfig: any,
    ): Promise<any> => ({
      id: "Workflow.upcast",
      targets: new Set(targetTokens),
    }));

    vi.stubGlobal("game", {
      ready: true,
      user: { isGM: true },
      world: { id: "world", title: "World" },
      scenes: { active: null },
      combat: {
        id: "combat",
        round: 1,
        turn: 0,
        combatant,
        combatants: [combatant],
        nextTurn,
      },
    });
    vi.stubGlobal("canvas", {
      scene: { id: "scene", templates: [] },
      tokens: tokenLayer,
    });
    vi.stubGlobal("CONFIG", {
      DND5E: {
        spellcasting: {
          spell: { getSpellSlotKey: (level: number) => `spell${level}` },
        },
      },
    });
    vi.stubGlobal("MidiQOL", {
      checkActivityRange: vi.fn(() => ({ result: "normal" })),
      completeItemUse,
    });

    return {
      runtime: new Function("return (" + runtimeFunction + ");")(),
      actionId: actionIdV2(actor.uuid, item.id, activity.id),
      actor,
      item,
      activity,
      combatant,
      sourceToken,
      tokenLayer,
      targetTokens,
      completeItemUse,
      nextTurn,
    };
  }

  function installTestHookBus() {
    let nextId = 1;
    const listeners = new Map<string, Map<number, (...args: any[]) => void>>();
    const on = vi.fn((hook: string, callback: (...args: any[]) => void) => {
      const id = nextId++;
      const callbacks = listeners.get(hook) ?? new Map();
      callbacks.set(id, callback);
      listeners.set(hook, callbacks);
      return id;
    });
    const off = vi.fn((hook: string, id: number) => {
      listeners.get(hook)?.delete(id);
    });
    const emit = (hook: string, ...args: any[]) => {
      for (const callback of listeners.get(hook)?.values() ?? []) callback(...args);
    };
    vi.stubGlobal("Hooks", { on, off });
    return { on, off, emit };
  }

  function prepareNativeSummonFixture(
    fixture: ReturnType<typeof installSpellExecuteRuntime>,
    expectedCount: 1 | 2,
    lifecycle: unknown = nativeSummonLifecycleFixtures.dmDuration,
  ) {
    Object.assign(fixture.activity, nativeSummonActivityFixture(expectedCount), {
      canSummon: true,
    });
    fixture.item.system.target.affects = { type: "self", count: "" };
    const hooks = installTestHookBus();
    const tokenCreate = vi.fn();
    (globalThis as any).CONFIG.Token = {
      documentClass: { create: tokenCreate },
    };
    const finalizeNativeSummonUse = vi.fn(async (request: any) => ({
      requestId: request.requestId,
      activityUuid: request.activityUuid,
      artifactId: (fixture.activity as any).flags["arcane-dnd5e-2014-automation"]
        .nativeSummon.artifactId,
      choice: (fixture.activity as any).flags["arcane-dnd5e-2014-automation"]
        .nativeSummon.choice,
      profileId: (fixture.activity as any).flags["arcane-dnd5e-2014-automation"]
        .nativeSummon.profileId,
      members: request.createdTokenUuids.map((tokenUuid: string, memberIndex: number) => ({
        memberIndex,
        tokenUuid,
        combatantUuid: `Combat.combat.Combatant.summoned-${memberIndex + 1}`,
      })),
      sourceCombatantUuid: fixture.combatant.uuid,
      inheritedInitiative: fixture.combatant.initiative,
      lifecycle,
    }));
    const cancelNativeSummonUse = vi.fn(async () => true);
    (globalThis as any).game.modules = new Map([[
      "arcane-dnd5e-2014-automation",
      {
        active: true,
        api: { cancelNativeSummonUse, finalizeNativeSummonUse },
      },
    ]]);
    let randomIdCall = 0;
    vi.stubGlobal("foundry", {
      utils: {
        randomID: vi.fn(() => {
          const invocation = Math.floor(randomIdCall / 2) + 1;
          const kind = randomIdCall++ % 2 === 0 ? "request" : "sequence";
          return `native-${kind}-${invocation}`;
        }),
      },
    });

    const emitPostUse = (
      usageConfig: any,
      tokenUuids: string[],
      overrides: {
        requestId?: string;
        activityId?: string;
        itemUuid?: string;
        messageUuid?: string | null;
      } = {},
    ) => {
      const requestUsageConfig = {
        ...usageConfig,
        summons: { ...usageConfig.summons },
      };
      if (overrides.requestId !== undefined) {
        requestUsageConfig.summons.arcaneNativeRequestId = overrides.requestId;
      }
      hooks.emit(
        "dnd5e.postUseActivity",
        {
          id: overrides.activityId ?? fixture.activity.id,
          item: { uuid: overrides.itemUuid ?? fixture.item.uuid },
        },
        requestUsageConfig,
        {
          summoned: tokenUuids.map(uuid => ({ uuid })),
          message: overrides.messageUuid === null
            ? null
            : { uuid: overrides.messageUuid ?? "ChatMessage.native-summon-1" },
        },
      );
    };

    const emitCleanup = (
      usageConfig: any,
      overrides: {
        requestId?: string;
        sequenceId?: string;
        activityUuid?: string;
        itemUuid?: string;
        tokenUuid?: string;
        workflowUuid?: string;
        aborted?: boolean;
      } = {},
    ) => {
      const candidate = {
        id: overrides.workflowUuid ?? "Workflow.native-summon-1",
        uuid: overrides.workflowUuid ?? "Workflow.native-summon-1",
        activity: {
          uuid: overrides.activityUuid ?? fixture.activity.uuid,
          item: { uuid: overrides.itemUuid ?? fixture.item.uuid },
        },
        item: { uuid: overrides.itemUuid ?? fixture.item.uuid },
        tokenUuid: overrides.tokenUuid ?? fixture.sourceToken.document.uuid,
        workflowOptions: {
          arcaneNativeRequestId: overrides.requestId
            ?? usageConfig.midiOptions.workflowOptions.arcaneNativeRequestId,
          arcaneNativeSequenceId: overrides.sequenceId
            ?? usageConfig.midiOptions.workflowOptions.arcaneNativeSequenceId,
        },
        aborted: overrides.aborted ?? false,
        targets: new Set(),
      };
      hooks.emit("midi-qol.postCleanup", candidate);
      return candidate;
    };

    const emitRejection = (
      usageConfig: any,
      overrides: {
        requestId?: string;
        activityUuid?: string;
        itemUuid?: string;
        code?: "ACTION_BLOCKED" | "ACTION_MISCONFIGURED";
        message?: string;
      } = {},
    ) => {
      hooks.emit("arcane-dnd5e-2014-automation.nativeSummonRejected", {
        requestId: overrides.requestId
          ?? usageConfig.midiOptions.workflowOptions.arcaneNativeRequestId,
        activityUuid: overrides.activityUuid ?? fixture.activity.uuid,
        sourceItemUuid: overrides.itemUuid ?? fixture.item.uuid,
        code: overrides.code ?? "ACTION_BLOCKED",
        message: overrides.message ?? "Native summon was blocked",
      });
    };

    return {
      cancelNativeSummonUse,
      emitCleanup,
      emitPostUse,
      emitRejection,
      finalizeNativeSummonUse,
      hooks,
      tokenCreate,
    };
  }

  it("produces a syntactically valid browser function with v2 support", () => {
    const factory = new Function("return (" + runtimeFunction + ");");
    expect(typeof factory()).toBe("function");
    for (const marker of [
      "actionIdV2",
      "locateActionByIdV2",
      "isAgentCallableActivityV2",
      "isAgentCallableActionV2",
      "actionBlockV2",
      "effectiveActivityActivationTypeV2",
      "parseActivitySelectionConstraintsV2",
      "pairwise-within-distance",
      "measureTokenDistanceWithFoundry",
      "isTokenWithinDistanceWithFoundry",
      "checkActivityTargetRangeWithFoundry",
      "serializeTurnResponseV2",
      "battleContextDataV2",
      "turnContextDataV2",
      "executeTurnV2Data",
      "resolveNativeSpellSlotConsumption",
      "resolveNativeSummonActivityV2",
      "resolveNativeSummonLifecycleV2",
      "featureDeclaredRiderOptionsV2",
      "resolveDeclaredRiderRequestsV2",
      "validateDeclaredRiderPlanV2",
      "dnd5e.postUseActivity",
      "midi-qol.postCleanup",
      "arcaneNativeSequenceId",
      "cancelNativeSummonUse",
      "finalizeNativeSummonUse",
      "nativeSummonReceipt",
      "tokenUuid: sourceTokenUuid",
      "__arcaneCompilerRuntimeCompletion",
      "declaredActiveBuff",
      "active-buff-on-attack",
      'case "battleContext"',
      'case "turnContext"',
      'case "actorBilingualSync"',
      "matchingEffects.map(activeEffect => activeEffect.id)",
    ]) {
      expect(runtimeFunction).toContain(marker);
    }
    expect(runtimeFunction).not.toContain(
      "Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y))",
    );
  });

  it("publishes owned feature riders on weapon attacks and forwards the DM declaration", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 1, max: 1, level: 1 },
    }, { activityType: "attack" });
    fixture.item.name = "Shortsword";
    fixture.item.type = "weapon";
    (fixture.item.system as any).actionType = "mwak";
    (fixture.item.system as any).type = { value: "simpleM" };
    (fixture.activity as any).attack = { type: { value: "mwak" } };

    fixture.actor.items.set("feature-sneak-attack", {
      id: "feature-sneak-attack",
      name: "Sneak Attack",
      type: "feat",
      system: { identifier: "sneak-attack", activities: new Map() },
      flags: {
        "arcane-dnd5e-2014-automation": {
          declaredRider: {
            id: "sneak-attack",
            consumesOn: "hit",
            consumes: "none",
            damageType: "parent",
          },
        },
      },
    });
    fixture.actor.items.set("duplicate-spell-rider", {
      id: "duplicate-spell-rider",
      name: "Duplicate Spell Rider",
      type: "spell",
      system: {
        identifier: "sneak-attack",
        level: 1,
        activities: new Map(),
      },
      flags: {
        "arcane-dnd5e-2014-automation": {
          declaredWeaponSpellRider: {
            identifier: "sneak-attack",
            minSpellLevel: 1,
          },
        },
      },
    });

    try {
      const battle = await fixture.runtime("battleContext", {}, { requireGM: false });
      const action = battle.combatants[0].actions.find(
        (candidate: any) => candidate.id === fixture.actionId,
      );
      expect(action.declaredRiders).toEqual([{
        id: "sneak-attack",
        name: "Sneak Attack",
        inputPath: "input.declaredRiders",
      }]);

      await expect(fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          input: { declaredRiders: [{ id: "sneak-attack" }] },
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      )).resolves.toEqual({ status: "completed" });
      expect(fixture.completeItemUse).toHaveBeenCalledOnce();
      expect(fixture.completeItemUse.mock.calls[0]![1]).toMatchObject({
        midiOptions: {
          workflowOptions: {
            arcaneDeclaredRiders: [{ id: "sneak-attack" }],
          },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { name: "selected-target", selfTarget: false },
    { name: "self-target", selfTarget: true },
  ])("auto-rolls and fast-forwards attack and damage for $name actions", async ({ selfTarget }) => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    if (selfTarget) {
      (fixture.activity as any).flags = {
        "arcane-dnd5e-2014-automation": {
          interaction: { version: 1, input: "self" },
        },
      };
      fixture.item.system.target.affects = { type: "self", count: "" };
    }

    try {
      await expect(fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: selfTarget ? [] : ["target"],
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      )).resolves.toEqual({ status: "completed" });

      expect(fixture.completeItemUse).toHaveBeenCalledOnce();
      expect(fixture.completeItemUse.mock.calls[0]![1]).toMatchObject({
        midiOptions: {
          fastForward: true,
          workflowOptions: {
            autoRollAttack: true,
            autoRollDamage: "onHit",
            fastForwardAttack: true,
            fastForwardDamage: true,
          },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      mode: "normal",
      advantage: undefined,
      disadvantage: undefined,
    },
    {
      mode: "advantage",
      advantage: true,
      disadvantage: false,
    },
    {
      mode: "disadvantage",
      advantage: false,
      disadvantage: true,
    },
  ])(
    "forwards explicit $mode attack-roll mode to both Midi option layers",
    async ({ mode, advantage, disadvantage }) => {
      const fixture = installSpellExecuteRuntime({
        spell1: { value: 4, max: 4, level: 1 },
      }, { activityType: "attack" });

      try {
        await expect(fixture.runtime(
          "executeTurn",
          {
            actionId: fixture.actionId,
            targetTokenIds: ["target"],
            input: { attackRollMode: mode },
            actionTimeoutMs: 1000,
          },
          { requireGM: false },
        )).resolves.toEqual({ status: "completed" });

        expect(fixture.completeItemUse).toHaveBeenCalledOnce();
        const midiOptions = fixture.completeItemUse.mock.calls[0]![1].midiOptions;
        expect(midiOptions.advantage).toBe(advantage);
        expect(midiOptions.disadvantage).toBe(disadvantage);
        expect(midiOptions.workflowOptions.advantage).toBe(advantage);
        expect(midiOptions.workflowOptions.disadvantage).toBe(disadvantage);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("rejects an unknown attack-roll mode before starting the workflow", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    }, { activityType: "attack" });

    try {
      await expect(fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          input: { attackRollMode: "with-advantage" },
        },
        { requireGM: false },
      )).resolves.toEqual({
        status: "rejected",
        code: "INPUT_INVALID",
      });
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects attack-roll mode for a non-attack action", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });

    try {
      await expect(fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          input: { attackRollMode: "advantage" },
        },
        { requireGM: false },
      )).resolves.toEqual({
        status: "rejected",
        code: "INPUT_INVALID",
        message: "input.attackRollMode is not supported by this action",
      });
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes a SUM-NATIVE wait-for-human activity through battle and turn contexts", async () => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 2, max: 2, level: 2 },
    }, { baseLevel: 2 });
    Object.assign(fixture.activity, nativeSummonActivityFixture());
    fixture.item.system.target.affects = { type: "self", count: "" };

    try {
      const catalog = await fixture.runtime(
        "tokenActions",
        { tokenId: "source" },
        { requireGM: false },
      );
      expect(catalog.actions).toEqual([
        expect.objectContaining({
          itemId: fixture.item.id,
          activityId: fixture.activity.id,
          type: "summon",
          inputContract: expect.objectContaining({
            mode: "self",
            supported: true,
            execution: "wait-for-human",
            humanStep: "native-summon-placement",
          }),
        }),
      ]);
      const battle = await fixture.runtime("battleContext", {}, { requireGM: false });
      expect(battle.combatants).toHaveLength(1);
      expect(battle.combatants[0].actions).toEqual([
        expect.objectContaining({
          id: fixture.actionId,
          itemId: fixture.item.id,
          kind: "summon",
          input: expect.objectContaining({
            mode: "self",
            supported: true,
            execution: "wait-for-human",
            humanStep: "native-summon-placement",
          }),
        }),
      ]);

      const turn = await fixture.runtime("turnContext", {}, { requireGM: false });
      expect(turn.actor.availableActionIds).toContain(fixture.actionId);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { name: "one placed Token", expectedCount: 1 as const, placedCount: 1 },
    { name: "two placed Tokens", expectedCount: 2 as const, placedCount: 2 },
    { name: "one of two Tokens placed", expectedCount: 2 as const, placedCount: 1 },
    { name: "placement skipped", expectedCount: 2 as const, placedCount: 0 },
  ])(
    "observes $name through dnd5e and returns one exact SUM-NATIVE receipt",
    async ({ expectedCount, placedCount }) => {
      const fixture = installSpellExecuteRuntime({
        spell2: { value: 3, max: 3, level: 2 },
      }, { baseLevel: 2 });
      const native = prepareNativeSummonFixture(fixture, expectedCount);
      const tokenUuids = Array.from(
        { length: placedCount },
        (_, index) => "Scene.scene.Token.summoned-" + (index + 1),
      );
      fixture.completeItemUse.mockImplementationOnce(async (item: unknown, usageConfig: any) => {
        expect(item).toBe(fixture.item);
        expect(usageConfig).toMatchObject({
          create: {
            measuredTemplate: false,
            summons: true,
          },
          midiOptions: {
            tokenUuid: fixture.sourceToken.document.uuid,
            workflowOptions: {
              sourceTokenUuid: fixture.sourceToken.document.uuid,
            },
          },
          summons: {
            profile: "native-profile-1",
            arcaneNativeRequestId: "native-request-1",
          },
        });
        fixture.actor.system.spells.spell2.value -= 1;
        native.emitPostUse(usageConfig, tokenUuids);
        native.emitCleanup(usageConfig);
        return {
          id: "Workflow.native-summon-1",
          uuid: "Workflow.native-summon-1",
          targets: new Set(),
        };
      });

      try {
        await expect(fixture.runtime(
          "executeTurn",
          {
            actionId: fixture.actionId,
            actionTimeoutMs: 1000,
          },
          { requireGM: false, timeoutMs: 3000 },
        )).resolves.toEqual({
          status: "completed",
          receipt: nativeSummonReceiptFixture(expectedCount, placedCount),
        });

        expect(native.finalizeNativeSummonUse).toHaveBeenCalledOnce();
        expect(native.finalizeNativeSummonUse).toHaveBeenCalledWith({
          requestId: "native-request-1",
          activityUuid: fixture.activity.uuid,
          profileId: "spiritual-weapon",
          sourceTokenUuid: fixture.sourceToken.document.uuid,
          sourceItemUuid: fixture.item.uuid,
          createdTokenUuids: tokenUuids,
          messageUuid: "ChatMessage.native-summon-1",
          workflowUuid: "Workflow.native-summon-1",
        });
        expect(fixture.completeItemUse).toHaveBeenCalledOnce();
        expect(fixture.actor.system.spells.spell2.value).toBe(2);
        expect(fixture.actor.update).not.toHaveBeenCalled();
        expect(native.tokenCreate).not.toHaveBeenCalled();
        expect(native.hooks.off).toHaveBeenCalledWith(
          "dnd5e.postUseActivity",
          expect.any(Number),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("waits for the exact Midi postCleanup before finalizing an undefined native use", async () => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const native = prepareNativeSummonFixture(fixture, 1);
    let usageConfig: any = null;
    fixture.completeItemUse.mockImplementationOnce(async (_item: unknown, candidate: any) => {
      usageConfig = candidate;
      fixture.actor.system.spells.spell2.value -= 1;
      native.emitPostUse(candidate, ["Scene.scene.Token.summoned-1"]);
      return undefined;
    });

    try {
      const execution = fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          actionTimeoutMs: 1000,
        },
        { requireGM: false, timeoutMs: 3000 },
      );
      expect(usageConfig).not.toBeNull();
      await Promise.resolve();
      expect(native.finalizeNativeSummonUse).not.toHaveBeenCalled();

      native.emitCleanup(usageConfig, { sequenceId: "foreign-sequence" });
      await Promise.resolve();
      expect(native.finalizeNativeSummonUse).not.toHaveBeenCalled();

      native.emitCleanup(usageConfig);
      await expect(execution).resolves.toEqual({
        status: "completed",
        receipt: nativeSummonReceiptFixture(1, 1),
      });
      expect(native.finalizeNativeSummonUse).toHaveBeenCalledOnce();
      expect(native.hooks.off).toHaveBeenCalledWith(
        "midi-qol.postCleanup",
        expect.any(Number),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { name: "another active Token for the same Actor", staleControlled: false },
    { name: "a stale controlled Token", staleControlled: true },
  ])("pins native Midi tokenUuid to the active combatant despite $name", async ({ staleControlled }) => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const native = prepareNativeSummonFixture(fixture, 1);
    const misleadingToken = {
      id: staleControlled ? "stale-controlled" : "duplicate-source",
      name: staleControlled ? "Stale Controlled" : "Duplicate Source",
      actor: fixture.actor,
      document: {
        id: staleControlled ? "stale-controlled" : "duplicate-source",
        uuid: staleControlled
          ? "Scene.old.Token.stale-controlled"
          : "Scene.scene.Token.duplicate-source",
        name: staleControlled ? "Stale Controlled" : "Duplicate Source",
        disposition: 1,
        parent: { id: staleControlled ? "old" : "scene" },
      },
    };
    (misleadingToken as any).control = vi.fn((options: { releaseOthers?: boolean } = {}) => {
      if (options.releaseOthers) fixture.tokenLayer.releaseAll();
      fixture.tokenLayer.controlled.push(misleadingToken);
      return true;
    });
    (misleadingToken as any).release = vi.fn(() => {
      const index = fixture.tokenLayer.controlled.indexOf(misleadingToken);
      if (index >= 0) fixture.tokenLayer.controlled.splice(index, 1);
      return true;
    });
    fixture.tokenLayer.controlled.push(misleadingToken);
    if (!staleControlled) {
      (globalThis as any).canvas.tokens.placeables.push(misleadingToken);
      (globalThis as any).game.combat.combatants.push({
        id: "combatant-duplicate-source",
        uuid: "Combat.combat.Combatant.combatant-duplicate-source",
        actorId: fixture.actor.id,
        tokenId: misleadingToken.id,
        sceneId: "scene",
        name: misleadingToken.name,
        token: misleadingToken,
        initiative: 12,
      });
    }
    fixture.completeItemUse.mockImplementationOnce(async (_item: unknown, usageConfig: any) => {
      expect(fixture.tokenLayer.controlled).toEqual([fixture.sourceToken]);
      expect(usageConfig.midiOptions.tokenUuid).toBe(fixture.sourceToken.document.uuid);
      expect(usageConfig.midiOptions.tokenUuid).not.toBe(misleadingToken.document.uuid);
      expect(usageConfig.midiOptions.workflowOptions.sourceTokenUuid)
        .toBe(fixture.sourceToken.document.uuid);
      fixture.actor.system.spells.spell2.value -= 1;
      native.emitPostUse(usageConfig, ["Scene.scene.Token.summoned-1"]);
      native.emitCleanup(usageConfig);
      return {
        id: "Workflow.native-summon-1",
        uuid: "Workflow.native-summon-1",
        targets: new Set(),
      };
    });

    try {
      await expect(fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          actionTimeoutMs: 1000,
        },
        { requireGM: false, timeoutMs: 3000 },
      )).resolves.toEqual({
        status: "completed",
        receipt: nativeSummonReceiptFixture(1, 1),
      });
      expect(fixture.completeItemUse).toHaveBeenCalledOnce();
      expect(native.finalizeNativeSummonUse).toHaveBeenCalledOnce();
      expect(native.finalizeNativeSummonUse.mock.calls[0]![0].sourceTokenUuid)
        .toBe(fixture.sourceToken.document.uuid);
      expect(fixture.tokenLayer.controlled).toEqual([misleadingToken]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores the prior controlled Tokens when exclusive source control throws", async () => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const previouslyControlled = fixture.targetTokens[0];
    (previouslyControlled as any).control({ releaseOthers: true });
    const native = prepareNativeSummonFixture(fixture, 1);
    (fixture.sourceToken as any).control.mockImplementationOnce(
      (options: { releaseOthers?: boolean } = {}) => {
        if (options.releaseOthers) fixture.tokenLayer.releaseAll();
        throw new Error("synthetic control failure");
      },
    );

    try {
      await expect(fixture.runtime(
        "executeTurn",
        { actionId: fixture.actionId },
        { requireGM: false, timeoutMs: 3000 },
      )).resolves.toEqual({
        status: "rejected",
        code: "ACTION_MISCONFIGURED",
        message: "ACTION_MISCONFIGURED: native summon source Token control failed: synthetic control failure",
      });
      expect(fixture.tokenLayer.controlled).toEqual([previouslyControlled]);
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(native.finalizeNativeSummonUse).not.toHaveBeenCalled();
      expect((globalThis as any).__arcaneNativeSummonPlacementFlight).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores the prior controlled Tokens when exclusive source control verification fails", async () => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const previouslyControlled = fixture.targetTokens[0];
    (previouslyControlled as any).control({ releaseOthers: true });
    const native = prepareNativeSummonFixture(fixture, 1);
    (fixture.sourceToken as any).control.mockImplementationOnce(
      (options: { releaseOthers?: boolean } = {}) => {
        if (options.releaseOthers) fixture.tokenLayer.releaseAll();
        return true;
      },
    );

    try {
      await expect(fixture.runtime(
        "executeTurn",
        { actionId: fixture.actionId },
        { requireGM: false, timeoutMs: 3000 },
      )).resolves.toEqual({
        status: "rejected",
        code: "ACTION_MISCONFIGURED",
        message: "ACTION_MISCONFIGURED: native summon could not exclusively control its source Token",
      });
      expect(fixture.tokenLayer.controlled).toEqual([previouslyControlled]);
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(native.finalizeNativeSummonUse).not.toHaveBeenCalled();
      expect((globalThis as any).__arcaneNativeSummonPlacementFlight).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { name: "legacy string", lifecycle: "dm-duration" },
    {
      name: "extra-key object",
      lifecycle: { mode: "dm-duration", effectUuid: null, version: 1 },
    },
    {
      name: "effectless concentration object",
      lifecycle: { mode: "concentration", effectUuid: null },
    },
    {
      name: "DM-duration object with an effect",
      lifecycle: {
        mode: "dm-duration",
        effectUuid: "Actor.source.ActiveEffect.unexpected",
      },
    },
  ])("does not complete when the native finalizer returns a $name lifecycle", async ({ lifecycle }) => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const native = prepareNativeSummonFixture(fixture, 1, lifecycle);
    fixture.completeItemUse.mockImplementationOnce(async (_item: unknown, usageConfig: any) => {
      fixture.actor.system.spells.spell2.value -= 1;
      native.emitPostUse(usageConfig, ["Scene.scene.Token.summoned-1"]);
      native.emitCleanup(usageConfig);
      return {
        id: "Workflow.native-summon-1",
        uuid: "Workflow.native-summon-1",
        targets: new Set(),
      };
    });

    try {
      await expect(fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          actionTimeoutMs: 1000,
        },
        { requireGM: false, timeoutMs: 3000 },
      )).resolves.toEqual({ status: "indeterminate", retry: false });
      expect(native.finalizeNativeSummonUse).toHaveBeenCalledOnce();
      expect(fixture.actor.system.spells.spell2.value).toBe(2);
      expect(native.tokenCreate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["requestId", "activityUuid", "artifactId", "choice", "profileId"] as const)(
    "does not publish a native receipt when finalizer %s mismatches",
    async identityField => {
      const fixture = installSpellExecuteRuntime({
        spell2: { value: 3, max: 3, level: 2 },
      }, { baseLevel: 2 });
      const native = prepareNativeSummonFixture(fixture, 1);
      const validFinalizer = native.finalizeNativeSummonUse.getMockImplementation() as (
        (request: any) => Promise<any>
      );
      native.finalizeNativeSummonUse.mockImplementationOnce(async (request: any) => ({
        ...await validFinalizer(request),
        [identityField]: "mismatched-identity",
      }));
      fixture.completeItemUse.mockImplementationOnce(async (_item: unknown, usageConfig: any) => {
        fixture.actor.system.spells.spell2.value -= 1;
        native.emitPostUse(usageConfig, ["Scene.scene.Token.summoned-1"]);
        native.emitCleanup(usageConfig);
        return undefined;
      });

      try {
        await expect(fixture.runtime(
          "executeTurn",
          {
            actionId: fixture.actionId,
            actionTimeoutMs: 1000,
          },
          { requireGM: false, timeoutMs: 3000 },
        )).resolves.toEqual({ status: "indeterminate", retry: false });
        expect(native.finalizeNativeSummonUse).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    { field: "sourceCombatantUuid" as const, value: null },
    { field: "inheritedInitiative" as const, value: Number.NaN },
  ])("rejects a zero-Token receipt without valid $field", async ({ field, value }) => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const native = prepareNativeSummonFixture(fixture, 2);
    const validFinalizer = native.finalizeNativeSummonUse.getMockImplementation() as (
      (request: any) => Promise<any>
    );
    native.finalizeNativeSummonUse.mockImplementationOnce(async (request: any) => ({
      ...await validFinalizer(request),
      [field]: value,
    }));
    fixture.completeItemUse.mockImplementationOnce(async (_item: unknown, usageConfig: any) => {
      fixture.actor.system.spells.spell2.value -= 1;
      native.emitPostUse(usageConfig, []);
      native.emitCleanup(usageConfig);
      return undefined;
    });

    try {
      await expect(fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          actionTimeoutMs: 1000,
        },
        { requireGM: false, timeoutMs: 3000 },
      )).resolves.toEqual({ status: "indeterminate", retry: false });
      expect(native.finalizeNativeSummonUse).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops immediately without replay when native completeItemUse returns false", async () => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    (fixture.item.system as any).uses = { spent: 0, max: 1 };
    const native = prepareNativeSummonFixture(fixture, 1);
    fixture.completeItemUse.mockResolvedValueOnce(false);
    vi.useFakeTimers();
    let settled = false;
    let response: unknown;
    const execution = fixture.runtime(
      "executeTurn",
      {
        actionId: fixture.actionId,
        actionTimeoutMs: 1000,
      },
      { requireGM: false, timeoutMs: 3000 },
    ).then((value: unknown) => {
      settled = true;
      response = value;
      return value;
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(response).toEqual({ status: "indeterminate", retry: false });
      expect(fixture.completeItemUse).toHaveBeenCalledOnce();
      expect(native.finalizeNativeSummonUse).not.toHaveBeenCalled();
      expect(fixture.actor.system.spells.spell2.value).toBe(3);
      expect((fixture.item.system as any).uses).toEqual({ spent: 0, max: 1 });
      expect(fixture.actor.update).not.toHaveBeenCalled();
      expect(native.tokenCreate).not.toHaveBeenCalled();
      expect(native.hooks.off).toHaveBeenCalledWith(
        "dnd5e.postUseActivity",
        expect.any(Number),
      );
    } finally {
      await vi.runAllTimersAsync();
      await execution;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      code: "ACTION_BLOCKED" as const,
      message: "Fallen Lover cannot summon another Wood Woad while its current Woad is alive",
    },
    {
      code: "ACTION_MISCONFIGURED" as const,
      message: "native summon controlled usage Token does not match the requested source Combatant Token",
    },
  ])("returns an exact $code rejection when builder pre-use rejects", async ({ code, message }) => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const native = prepareNativeSummonFixture(fixture, 1);
    fixture.completeItemUse.mockImplementationOnce(async (_item: unknown, usageConfig: any) => {
      native.emitRejection(usageConfig, { code, message });
      return false;
    });

    try {
      await expect(fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          actionTimeoutMs: 1000,
        },
        { requireGM: false, timeoutMs: 3000 },
      )).resolves.toEqual({
        status: "rejected",
        code,
        message: `${code}: ${message}`,
      });
      expect(native.cancelNativeSummonUse).toHaveBeenCalledWith({
        requestId: "native-request-1",
        activityUuid: fixture.activity.uuid,
        sourceTokenUuid: fixture.sourceToken.document.uuid,
        sourceItemUuid: fixture.item.uuid,
        midiSequenceId: "native-sequence-1",
      });
      expect(native.finalizeNativeSummonUse).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores foreign postUseActivity events before accepting the exact native request", async () => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const native = prepareNativeSummonFixture(fixture, 1);
    fixture.completeItemUse.mockImplementationOnce(async (_item: unknown, usageConfig: any) => {
      fixture.actor.system.spells.spell2.value -= 1;
      native.emitPostUse(
        usageConfig,
        ["Scene.scene.Token.foreign-request"],
        { requestId: "foreign-request" },
      );
      native.emitPostUse(
        usageConfig,
        ["Scene.scene.Token.foreign-activity"],
        { activityId: "foreign-activity" },
      );
      native.emitPostUse(
        usageConfig,
        ["Scene.scene.Token.foreign-item"],
        { itemUuid: "Actor.foreign.Item.foreign" },
      );
      native.emitPostUse(
        usageConfig,
        ["Scene.scene.Token.summoned-1"],
      );
      native.emitCleanup(usageConfig);
      return {
        id: "Workflow.native-summon-1",
        uuid: "Workflow.native-summon-1",
        targets: new Set(),
      };
    });

    try {
      const response = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          actionTimeoutMs: 1000,
        },
        { requireGM: false, timeoutMs: 3000 },
      );
      expect(response).toEqual({
        status: "completed",
        receipt: nativeSummonReceiptFixture(1, 1),
      });
      expect(native.finalizeNativeSummonUse).toHaveBeenCalledOnce();
      expect(native.finalizeNativeSummonUse.mock.calls[0]![0].createdTokenUuids).toEqual([
        "Scene.scene.Token.summoned-1",
      ]);
      expect(native.tokenCreate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clamps native timeout below the CDP deadline and keeps its flight until exact cleanup", async () => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const native = prepareNativeSummonFixture(fixture, 2);
    let usageConfig: any = null;
    fixture.completeItemUse.mockImplementationOnce((_item: unknown, candidate: any) => {
      usageConfig = candidate;
      fixture.actor.system.spells.spell2.value -= 1;
      return new Promise(() => undefined);
    });
    vi.useFakeTimers();
    let settled = false;
    const execution = fixture.runtime(
      "executeTurn",
      {
        actionId: fixture.actionId,
        actionTimeoutMs: 60_000,
      },
      { requireGM: false, timeoutMs: 3000 },
    ).then((value: unknown) => {
      settled = true;
      return value;
    });

    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await vi.runOnlyPendingTimersAsync();
      await expect(execution).resolves.toEqual({
        status: "indeterminate",
        retry: false,
      });
      expect((globalThis as any).__arcaneNativeSummonPlacementFlight).toMatchObject({
        requestId: "native-request-1",
        sequenceId: "native-sequence-1",
      });

      await expect(fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          actionTimeoutMs: 60_000,
        },
        { requireGM: false, timeoutMs: 3000 },
      )).resolves.toEqual({
        status: "rejected",
        code: "ACTION_BLOCKED",
        message: "ACTION_BLOCKED: another native summon placement is already active in this GM page",
      });
      expect(fixture.completeItemUse).toHaveBeenCalledOnce();

      native.emitCleanup(usageConfig, { sequenceId: "foreign-sequence" });
      expect((globalThis as any).__arcaneNativeSummonPlacementFlight).toBeTruthy();
      native.emitCleanup(usageConfig);
      expect((globalThis as any).__arcaneNativeSummonPlacementFlight).toBeUndefined();
      expect(native.finalizeNativeSummonUse).not.toHaveBeenCalled();
      expect(native.tokenCreate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { name: "unmarked", flags: undefined },
    {
      name: "legacy SUM-v1",
      flags: {
        "arcane-dnd5e-2014-automation": {
          summon: { version: 1 },
        },
      },
    },
  ])("does not expose or execute an $name summon", async ({ flags }) => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    fixture.activity.type = "summon";
    (fixture.activity as any).flags = flags;
    fixture.item.system.target.affects = { type: "self", count: "" };

    try {
      await expect(fixture.runtime(
        "executeTurn",
        { actionId: fixture.actionId },
        { requireGM: false },
      )).resolves.toEqual({
        status: "rejected",
        code: "ACTION_NOT_FOUND",
      });
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(fixture.actor.system.spells.spell2.value).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a native summon mixed with another action before either is submitted", async () => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const native = prepareNativeSummonFixture(fixture, 1);
    const ordinaryActivity = {
      id: "activity-ordinary",
      uuid: fixture.item.uuid + ".Activity.activity-ordinary",
      name: "Ordinary Action",
      type: "utility",
      target: { override: false },
      range: { override: false },
      consumption: { spellSlot: false },
    };
    fixture.item.system.activities.set(
      ordinaryActivity.id,
      ordinaryActivity,
    );
    const ordinaryActionId = actionIdV2(
      fixture.actor.uuid,
      fixture.item.id,
      ordinaryActivity.id,
    );

    try {
      await expect(fixture.runtime(
        "executeTurn",
        {
          actions: [
            { actionId: fixture.actionId },
            { actionId: ordinaryActionId },
          ],
        },
        { requireGM: false },
      )).resolves.toEqual({
        status: "rejected",
        code: "INPUT_INVALID",
        message: "A native summon must be the only action in one execute-turn request",
      });
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(native.finalizeNativeSummonUse).not.toHaveBeenCalled();
      expect(native.tokenCreate).not.toHaveBeenCalled();
      expect(fixture.actor.system.spells.spell2.value).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("blocks Fallen Lover advance=true before submitting its native summon", async () => {
    const fixture = installSpellExecuteRuntime({
      spell2: { value: 3, max: 3, level: 2 },
    }, { baseLevel: 2 });
    const native = prepareNativeSummonFixture(fixture, 1);
    const marker = (fixture.activity as any)
      .flags["arcane-dnd5e-2014-automation"].nativeSummon;
    marker.artifactId = "fallen-lover";
    marker.choice = "wood-woad";
    marker.profileId = "wood-woad";
    marker.documentId = "wood-woad";
    marker.cleanup = "root-concentration";
    marker.uniqueness = {
      scope: "root-invocation",
      maximum: 1,
      enforcement: "pre-use-reject",
    };
    (fixture.activity as any).profiles[0].uuid =
      "Compendium.arcane-dnd5e-2014-automation.summons.Actor.wood-woad";

    try {
      await expect(fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          advance: true,
        },
        { requireGM: false, timeoutMs: 3000 },
      )).resolves.toEqual({
        status: "rejected",
        code: "ACTION_BLOCKED",
        message: "Fallen Lover must use advance=false; after placement the DM manually skips the new Wood Woad's current-round turn",
      });
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(native.finalizeNativeSummonUse).not.toHaveBeenCalled();
      expect(fixture.nextTurn).not.toHaveBeenCalled();
      expect(fixture.actor.system.spells.spell2.value).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("audits and migrates exact Actor attack base-damage bonuses", async () => {
    const itemRaw: any = {
      _id: "item-1",
      name: "Test Spear",
      system: {
        damage: {
          base: { number: 1, denomination: 6, bonus: "3", types: ["piercing"] },
        },
        activities: {
          "activity-1": {
            type: "attack",
            attack: { ability: "str", type: { value: "melee" } },
            damage: { includeBase: true, parts: [] },
          },
        },
      },
    };
    const item = {
      id: itemRaw._id,
      name: itemRaw.name,
      toObject: () => structuredClone(itemRaw),
    };
    const updateEmbeddedDocuments = vi.fn(async (_type: string, patches: any[]) => {
      itemRaw.system.damage.base.bonus = patches[0]["system.damage.base.bonus"];
      return [item];
    });
    const actor = {
      id: "actor-1",
      name: "Test NPC",
      type: "npc",
      folder: { name: "English NPCs" },
      system: { abilities: { str: { mod: 3 } } },
      items: new Map([[item.id, item]]),
      updateEmbeddedDocuments,
      toObject: () => ({
        _id: "actor-1",
        name: "Test NPC",
        items: [structuredClone(itemRaw)],
      }),
    };
    const manifest = {
      worldId: "dragonlance",
      systemId: "dnd5e",
      systemVersion: "5.3.3",
      foundryVersion: "13.351",
      expectedActorCount: 1,
      expectedAttackCount: 1,
      actors: [{
        id: actor.id,
        name: actor.name,
        type: actor.type,
        folder: actor.folder.name,
        attacks: [{
          itemId: item.id,
          itemName: item.name,
          activityId: "activity-1",
          ability: "str",
          attackType: "melee",
          base: { number: 1, denomination: 6, bonus: "3", types: ["piercing"] },
          extraDamage: [],
        }],
      }],
    };

    vi.stubGlobal("game", {
      ready: true,
      version: "13.351",
      user: { isGM: true },
      world: { id: "dragonlance", title: "Dragonlance" },
      system: { id: "dnd5e", version: "5.3.3" },
      actors: new Map([[actor.id, actor]]),
    });

    try {
      const runtime = new Function("return (" + runtimeFunction + ");")();
      const dryRun = await runtime("actorDamageMigrate", { manifest, apply: false }, { requireGM: true });
      expect(dryRun.before).toMatchObject({ actorCount: 1, attackCount: 1, pending: 1, migrated: 0 });
      expect(updateEmbeddedDocuments).not.toHaveBeenCalled();

      const applied = await runtime("actorDamageMigrate", { manifest, apply: true }, { requireGM: true });
      expect(updateEmbeddedDocuments).toHaveBeenCalledWith("Item", [{
        _id: "item-1",
        "system.damage.base.bonus": "",
      }]);
      expect(applied.before).toMatchObject({ pending: 1, migrated: 0 });
      expect(applied.after).toMatchObject({ pending: 0, migrated: 1 });
      expect(applied.backup[0].actor.items[0].system.damage.base.bonus).toBe("3");
      expect(itemRaw.system.damage.base.bonus).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses Actor damage migration when a base bonus is unexpected", async () => {
    const itemRaw: any = {
      system: {
        damage: { base: { number: 1, denomination: 6, bonus: "9", types: ["piercing"] } },
        activities: {
          attack: {
            type: "attack",
            attack: { ability: "str", type: { value: "melee" } },
            damage: { includeBase: true, parts: [] },
          },
        },
      },
    };
    const item = { id: "item", name: "Spear", toObject: () => structuredClone(itemRaw) };
    const updateEmbeddedDocuments = vi.fn();
    const actor = {
      id: "actor",
      name: "NPC",
      type: "npc",
      folder: { name: "Folder" },
      system: { abilities: { str: { mod: 3 } } },
      items: new Map([[item.id, item]]),
      updateEmbeddedDocuments,
      toObject: () => ({}),
    };
    const manifest = {
      worldId: "world",
      expectedActorCount: 1,
      expectedAttackCount: 1,
      actors: [{
        id: actor.id,
        name: actor.name,
        type: actor.type,
        folder: actor.folder.name,
        attacks: [{
          itemId: item.id,
          itemName: item.name,
          activityId: "attack",
          ability: "str",
          attackType: "melee",
          base: { number: 1, denomination: 6, bonus: "3", types: ["piercing"] },
          extraDamage: [],
        }],
      }],
    };

    vi.stubGlobal("game", {
      ready: true,
      user: { isGM: true },
      world: { id: "world", title: "World" },
      system: { id: "dnd5e", version: "5.3.3" },
      actors: new Map([[actor.id, actor]]),
    });

    try {
      const runtime = new Function("return (" + runtimeFunction + ");")();
      await expect(runtime("actorDamageMigrate", { manifest, apply: true }, { requireGM: true }))
        .rejects.toThrow("unexpected base bonus");
      expect(updateEmbeddedDocuments).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("synchronizes bilingual Actor rules, item topology, and unlinked token deltas", async () => {
    const makeItem = (rawInput: any) => {
      let raw = structuredClone(rawInput);
      return {
        get id() { return raw._id; },
        get name() { return raw.name; },
        get type() { return raw.type; },
        toObject: () => structuredClone(raw),
        replace(next: any) { raw = structuredClone(next); },
      };
    };
    const makeActor = (rawInput: any, folderName: string) => {
      let raw = structuredClone(rawInput);
      const items = new Map(raw.items.map((item: any) => {
        const document = makeItem(item);
        return [document.id, document];
      }));
      const refreshRawItems = () => {
        raw.items = Array.from(items.values()).map((item: any) => item.toObject());
      };
      const actor: any = {
        id: raw._id,
        name: raw.name,
        type: raw.type,
        folder: { name: folderName },
        items,
        toObject: () => {
          refreshRawItems();
          return structuredClone(raw);
        },
        update: vi.fn(async (patch: any) => {
          if (patch.system) raw.system = structuredClone(patch.system);
          return actor;
        }),
        updateEmbeddedDocuments: vi.fn(async (_type: string, patches: any[]) => {
          for (const patch of patches) {
            const item = items.get(patch._id) as any;
            item.replace(patch);
          }
          refreshRawItems();
          return patches.map(patch => items.get(patch._id));
        }),
        deleteEmbeddedDocuments: vi.fn(async (_type: string, ids: string[]) => {
          for (const id of ids) items.delete(id);
          refreshRawItems();
          return [];
        }),
        createEmbeddedDocuments: vi.fn(async (_type: string, data: any[]) => {
          const created = data.map(entry => makeItem(entry));
          for (const item of created) items.set(item.id, item);
          refreshRawItems();
          return created;
        }),
      };
      return actor;
    };
    const sourceRaw = {
      _id: "source-actor",
      name: "English NPC",
      type: "npc",
      system: {
        attributes: { hp: { value: 10, max: 10, temp: 0, formula: "2d8+2" } },
        abilities: { str: { value: 14 } },
        details: { biography: { value: "English" } },
      },
      items: [
        {
          _id: "source-one",
          name: "Sword",
          type: "weapon",
          img: "sword.webp",
          system: {
            description: { value: "English sword" },
            damage: { base: { number: 1, denomination: 8, bonus: "", types: ["slashing"] } },
            activities: { attack: { type: "attack", attack: { ability: "str" }, uses: { spent: 0 } } },
            uses: { spent: 0 },
          },
          effects: [],
          flags: {},
        },
        {
          _id: "source-two",
          name: "Sword (Two-Handed)",
          type: "weapon",
          img: "sword.webp",
          system: {
            description: { value: "English two-handed sword" },
            damage: { base: { number: 1, denomination: 10, bonus: "", types: ["slashing"] } },
            activities: { attack: { type: "attack", attack: { ability: "str" }, uses: { spent: 0 } } },
            uses: { spent: 0 },
          },
          effects: [],
          flags: {},
        },
      ],
    };
    const targetRaw = {
      _id: "target-actor",
      name: "中文 NPC",
      type: "npc",
      system: {
        attributes: { hp: { value: 4, max: 12, temp: 2, formula: "3d8" } },
        abilities: { str: { value: 18 } },
        details: { biography: { value: "中文介绍" } },
      },
      items: [
        {
          _id: "target-one",
          name: "长剑",
          type: "weapon",
          img: "localized.webp",
          system: {
            description: { value: "中文长剑" },
            damage: { base: { number: 1, denomination: 8, bonus: "4", types: ["slashing"] } },
            activities: { attack: { type: "attack", attack: { ability: "" }, uses: { spent: 1 } } },
            uses: { spent: 1 },
          },
          effects: [],
          flags: {},
        },
        {
          _id: "obsolete",
          name: "旧盾牌",
          type: "equipment",
          system: { description: { value: "" }, activities: {}, uses: { spent: 0 } },
          effects: [],
          flags: {},
        },
      ],
    };
    const sourceActor = makeActor(sourceRaw, "English");
    const targetActor = makeActor(targetRaw, "Localized");
    const tokenActor = makeActor({ ...targetRaw, _id: "token-delta", system: {
      ...targetRaw.system,
      attributes: { hp: { value: 3, max: 12, temp: 1, formula: "3d8" } },
    } }, "Localized");
    const token = {
      id: "token-1",
      name: "中文 NPC",
      actorId: targetActor.id,
      actorLink: false,
      actor: tokenActor,
      toObject: () => ({ _id: "token-1", actorId: targetActor.id, actorLink: false }),
    };
    const scene = { id: "scene-1", name: "Scene", tokens: [token] };
    const manifest = {
      worldId: "world",
      expectedPairCount: 1,
      expectedUnlinkedTokenCount: 1,
      pairs: [{
        key: "npc",
        sourceActor: { id: sourceActor.id, name: sourceActor.name, folder: "English" },
        targetActor: { id: targetActor.id, name: targetActor.name, folder: "Localized" },
        actorRulesFrom: "source",
        expectedSourceUnlinkedTokens: 0,
        expectedTargetUnlinkedTokens: 1,
        items: [
          {
            key: "sword",
            rulesFrom: "source",
            source: { id: "source-one", name: "Sword", type: "weapon" },
            target: { id: "target-one", name: "长剑", type: "weapon" },
          },
          {
            key: "sword-two-handed",
            rulesFrom: "source",
            source: { id: "source-two", name: "Sword (Two-Handed)", type: "weapon" },
            target: { id: "target-two", name: "长剑（双手）", type: "weapon", createIfMissing: true },
          },
        ],
        deleteTargetItemIds: ["obsolete"],
      }],
    };

    vi.stubGlobal("foundry", { utils: { deepClone: structuredClone } });
    vi.stubGlobal("game", {
      ready: true,
      version: "13.351",
      user: { isGM: true },
      world: { id: "world", title: "World" },
      system: { id: "dnd5e", version: "5.3.3" },
      actors: new Map([[sourceActor.id, sourceActor], [targetActor.id, targetActor]]),
      scenes: [scene],
    });

    try {
      const runtime = new Function("return (" + runtimeFunction + ");")();
      const dryRun = await runtime("actorBilingualSync", { manifest, apply: false }, { requireGM: true });
      expect(dryRun.before).toMatchObject({ pairCount: 1, documentCount: 3, unlinkedTokenCount: 1, pending: 2, consistent: 1 });

      const applied = await runtime("actorBilingualSync", { manifest, apply: true }, { requireGM: true });
      expect(applied.after).toMatchObject({ pending: 0, consistent: 3 });
      expect(applied.backup.actors).toHaveLength(2);
      expect(applied.backup.tokens).toHaveLength(1);

      const targetAfter = targetActor.toObject();
      expect(targetAfter.system.attributes.hp).toMatchObject({ value: 4, max: 10, temp: 2, formula: "2d8+2" });
      expect(targetAfter.system.abilities.str.value).toBe(14);
      expect(targetAfter.system.details.biography.value).toBe("中文介绍");
      expect(Array.from(targetActor.items.keys()).sort()).toEqual(["target-one", "target-two"]);
      expect(targetActor.items.get("target-one").toObject()).toMatchObject({
        name: "长剑",
        img: "localized.webp",
        system: {
          description: { value: "中文长剑" },
          damage: { base: { bonus: "" } },
          activities: { attack: { attack: { ability: "str" }, uses: { spent: 1 } } },
          uses: { spent: 1 },
        },
      });

      const tokenAfter = tokenActor.toObject();
      expect(tokenAfter.system.attributes.hp).toMatchObject({ value: 3, max: 10, temp: 1, formula: "2d8+2" });
      expect(Array.from(tokenActor.items.keys()).sort()).toEqual(["target-one", "target-two"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns indeterminate when compiler runtime completion fails after the action starts", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    const runtimeCompletion = Promise.reject(new Error("child splash failed"));
    void runtimeCompletion.catch(() => undefined);
    fixture.completeItemUse.mockResolvedValue({
      id: "Workflow.partial",
      targets: new Set(fixture.targetTokens),
      __arcaneCompilerRuntimeCompletion: runtimeCompletion,
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );
      expect(result).toEqual({
        status: "indeterminate",
        retry: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns completed when compiler runtime completion resolves within the action deadline", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    const runtimeCompletion = new Promise(resolve => {
      setTimeout(() => resolve(true), 20);
    });
    fixture.completeItemUse.mockResolvedValue({
      id: "Workflow.runtime-completes",
      targets: new Set(fixture.targetTokens),
      __arcaneCompilerRuntimeCompletion: runtimeCompletion,
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );
      expect(result).toEqual({ status: "completed" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns indeterminate when compiler runtime completion exceeds the action deadline", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    fixture.completeItemUse.mockResolvedValue({
      id: "Workflow.runtime-pending",
      targets: new Set(fixture.targetTokens),
      __arcaneCompilerRuntimeCompletion: new Promise(() => undefined),
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          actionTimeoutMs: 25,
        },
        { requireGM: false },
      );
      expect(result).toEqual({ status: "indeterminate", retry: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns the required selection detail before submitting the workflow", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    (fixture.activity as any).flags = {
      "arcane-dnd5e-2014-automation": {
        interaction: {
          version: 1,
          input: "selected-targets",
          requiredSelections: [{
            id: "damageType",
            type: "enum",
            required: true,
            values: [{ value: "fire", label: "Fire" }],
          }],
        },
      },
    };

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
        },
        { requireGM: false },
      );

      expect(result).toEqual({
        status: "rejected",
        code: "INPUT_INVALID",
        message: "Missing required selection input.selections.damageType",
      });
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(fixture.actor.system.spells.spell1.value).toBe(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("waits for a compiler-triggered child workflow within the action timeout", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    const childActivity: any = {
      id: "triggered-child",
      flags: {
        "arcane-dnd5e-2014-automation": {
          triggeredEventActivity: { version: 1 },
        },
      },
    };
    (fixture.item.system.activities as Map<string, any>).set(
      childActivity.id,
      childActivity,
    );
    (fixture.activity as any).midiProperties = {
      triggeredActivityId: childActivity.id,
    };
    const rollCompleteHooks = new Map<number, (workflow: any) => void>();
    let nextHookId = 1;
    vi.stubGlobal("Hooks", {
      on: vi.fn((_event: string, callback: (workflow: any) => void) => {
        const hookId = nextHookId++;
        rollCompleteHooks.set(hookId, callback);
        return hookId;
      }),
      off: vi.fn((_event: string, hookId: number) => {
        rollCompleteHooks.delete(hookId);
      }),
    });
    let childCompleted = false;
    fixture.completeItemUse.mockImplementation(async () => {
      const parentWorkflow = {
        id: "Workflow.trigger-parent",
        targets: new Set(fixture.targetTokens),
      };
      setTimeout(() => {
        childCompleted = true;
        const childWorkflow = {
          activity: childActivity,
          workflowOptions: {
            triggeringWorkflowId: "ChatMessage." + parentWorkflow.id,
          },
        };
        for (const callback of rollCompleteHooks.values()) {
          callback(childWorkflow);
        }
      }, 20);
      return parentWorkflow;
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "completed" });
      expect(childCompleted).toBe(true);
      expect(rollCompleteHooks.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the action indeterminate when only an unrelated triggered child completes", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    const childActivity: any = {
      id: "triggered-child",
      flags: {
        "arcane-dnd5e-2014-automation": {
          triggeredEventActivity: { version: 1 },
        },
      },
    };
    (fixture.item.system.activities as Map<string, any>).set(
      childActivity.id,
      childActivity,
    );
    (fixture.activity as any).midiProperties = {
      triggeredActivityId: childActivity.id,
    };
    const rollCompleteHooks = new Map<number, (workflow: any) => void>();
    let nextHookId = 1;
    vi.stubGlobal("Hooks", {
      on: vi.fn((_event: string, callback: (workflow: any) => void) => {
        const hookId = nextHookId++;
        rollCompleteHooks.set(hookId, callback);
        return hookId;
      }),
      off: vi.fn((_event: string, hookId: number) => {
        rollCompleteHooks.delete(hookId);
      }),
    });
    fixture.completeItemUse.mockImplementation(async () => {
      for (const callback of rollCompleteHooks.values()) {
        callback({
          activity: childActivity,
          workflowOptions: {
            triggeringWorkflowId: "Workflow.unrelated-parent",
          },
        });
      }
      return {
        id: "Workflow.expected-parent",
        targets: new Set(fixture.targetTokens),
      };
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          actionTimeoutMs: 25,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "indeterminate", retry: false });
      expect(rollCompleteHooks.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes the resolved activity to Foundry-owned range validation before use", async () => {
    const activity = {
      id: "activity-1",
      name: "Save",
      type: "save",
      target: { override: false },
      range: { override: false },
    };
    const item = {
      id: "item-1",
      name: "Range Test",
      type: "feat",
      system: {
        activities: new Map([[activity.id, activity]]),
        target: { affects: { type: "creature", count: 1 } },
        range: { value: 30, units: "ft" },
      },
    };
    const actor = {
      uuid: "Actor.source",
      items: new Map([[item.id, item]]),
      effects: [],
    };
    const sourceToken = {
      id: "source",
      actor,
      document: {
        id: "source",
        uuid: "Scene.scene.Token.source",
        name: "Source",
        disposition: 1,
      },
    };
    const targetToken = {
      id: "target",
      actor: { uuid: "Actor.target", items: new Map(), effects: [] },
      document: {
        id: "target",
        uuid: "Scene.scene.Token.target",
        name: "Target",
        disposition: -1,
      },
    };
    const tokens = new Map([
      [sourceToken.id, sourceToken],
      [targetToken.id, targetToken],
    ]);
    const checkActivityRange = vi.fn(() => ({ result: "fail" }));
    const completeItemUse = vi.fn();

    vi.stubGlobal("game", {
      ready: true,
      user: { isGM: true },
      world: { id: "world", title: "World" },
      scenes: { active: null },
    });
    vi.stubGlobal("canvas", {
      scene: { id: "scene", templates: [] },
      tokens: {
        placeables: Array.from(tokens.values()),
        get: (id: string) => tokens.get(id),
      },
    });
    vi.stubGlobal("MidiQOL", { checkActivityRange, completeItemUse });

    try {
      const runtime = new Function("return (" + runtimeFunction + ");")();
      await expect(
        runtime(
          "useAction",
          {
            sourceTokenId: sourceToken.id,
            itemId: item.id,
            activityId: activity.id,
            targetSpec: { mode: "tokens", tokenIds: [targetToken.id] },
          },
          { requireGM: false },
        ),
      ).rejects.toThrow("outside the action's allowed range or line of effect");
      expect(checkActivityRange).toHaveBeenCalledWith(
        activity,
        sourceToken,
        new Set([targetToken]),
        false,
      );
      expect(completeItemUse).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not let a Midi normal result bypass the numeric Foundry distance check", async () => {
    const activity = {
      id: "activity-1",
      name: "Cast",
      type: "utility",
      actionType: "utility",
      target: { override: false },
      range: { override: false },
    };
    const item = {
      id: "item-1",
      name: "Owned Weapon Cantrip",
      type: "spell",
      system: {
        activities: new Map([[activity.id, activity]]),
        target: { affects: { type: "creature", count: 1 } },
        range: { value: 5, units: "ft" },
      },
    };
    const actor = {
      uuid: "Actor.source",
      items: new Map([[item.id, item]]),
      effects: [],
    };
    const sourceToken = {
      id: "source",
      actor,
      document: {
        id: "source",
        uuid: "Scene.scene.Token.source",
        name: "Source",
        disposition: 1,
      },
    };
    const targetToken = {
      id: "target",
      actor: { uuid: "Actor.target", items: new Map(), effects: [] },
      document: {
        id: "target",
        uuid: "Scene.scene.Token.target",
        name: "Target",
        disposition: -1,
      },
    };
    const tokens = new Map([
      [sourceToken.id, sourceToken],
      [targetToken.id, targetToken],
    ]);
    const checkActivityRange = vi.fn(() => ({ result: "normal" }));
    const checkDistance = vi.fn(() => false);
    const completeItemUse = vi.fn();

    vi.stubGlobal("game", {
      ready: true,
      user: { isGM: true },
      world: { id: "world", title: "World" },
      scenes: { active: null },
    });
    vi.stubGlobal("canvas", {
      scene: { id: "scene", templates: [] },
      tokens: {
        placeables: Array.from(tokens.values()),
        get: (id: string) => tokens.get(id),
      },
    });
    vi.stubGlobal("MidiQOL", {
      checkActivityRange,
      checkDistance,
      completeItemUse,
    });

    try {
      const runtime = new Function("return (" + runtimeFunction + ");")();
      await expect(
        runtime(
          "useAction",
          {
            sourceTokenId: sourceToken.id,
            itemId: item.id,
            activityId: activity.id,
            targetSpec: { mode: "tokens", tokenIds: [targetToken.id] },
          },
          { requireGM: false },
        ),
      ).rejects.toThrow("Target token is outside action range: target");
      expect(checkActivityRange).toHaveBeenCalledWith(
        activity,
        sourceToken,
        new Set([targetToken]),
        false,
      );
      expect(checkDistance).toHaveBeenCalledWith(
        sourceToken,
        targetToken,
        5,
        {
          wallsBlock: false,
          includeCover: false,
        },
      );
      expect(completeItemUse).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks Foundry to validate every selected-target pair", async () => {
    const fixture = installSpellExecuteRuntime(
      { spell1: { value: 4, max: 4, level: 1 } },
      {
        preparedTargetCount: 3,
        targetIds: ["target", "target-2", "target-3"],
        selectionConstraints: [{
          type: "pairwise-within-distance",
          maximum: 5,
          units: "ft",
        }],
      },
    );
    const checkDistance = vi.fn((
      _first: any,
      _second: any,
      _maximum: number,
    ) => true);
    (globalThis as any).MidiQOL.checkDistance = checkDistance;

    try {
      await expect(fixture.runtime(
        "useAction",
        {
          sourceTokenId: "source",
          itemId: fixture.item.id,
          activityId: fixture.activity.id,
          targetSpec: {
            mode: "tokens",
            tokenIds: fixture.targetTokens.map(target => target.id),
          },
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      )).resolves.toMatchObject({ status: "completed" });

      const pairCalls = checkDistance.mock.calls
        .filter(([, , maximum]) => maximum === 5)
        .map(([first, second]) => [first.id, second.id]);
      expect(pairCalls).toEqual([
        ["target", "target-2"],
        ["target", "target-3"],
        ["target-2", "target-3"],
      ]);
      expect(fixture.completeItemUse).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hard-rejects a malformed selection constraint before Midi use", async () => {
    const fixture = installSpellExecuteRuntime(
      { spell1: { value: 4, max: 4, level: 1 } },
      {
        preparedTargetCount: 2,
        targetIds: ["target", "target-2"],
      },
    );
    (fixture.activity as any).flags = {
      "arcane-dnd5e-2014-automation": {
        interaction: {
          version: 1,
          input: "selected-targets",
          selectionConstraints: [{
            type: "pairwise-within-distance",
            units: "ft",
          }],
        },
      },
    };

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: fixture.targetTokens.map(target => target.id),
        },
        { requireGM: false },
      );
      expect(result).toEqual({
        status: "rejected",
        code: "ACTION_MISCONFIGURED",
      });
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(fixture.actor.update).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an out-of-range selected-target pair before Midi use", async () => {
    const fixture = installSpellExecuteRuntime(
      { spell1: { value: 4, max: 4, level: 1 } },
      {
        preparedTargetCount: 2,
        targetIds: ["target", "target-2"],
        selectionConstraints: [{
          type: "pairwise-within-distance",
          maximum: 5,
          units: "ft",
        }],
      },
    );
    const checkDistance = vi.fn((
      first: any,
      second: any,
      maximum: number,
    ) => !(
      first.id === "target"
      && second.id === "target-2"
      && maximum === 5
    ));
    (globalThis as any).MidiQOL.checkDistance = checkDistance;

    try {
      await expect(fixture.runtime(
        "useAction",
        {
          sourceTokenId: "source",
          itemId: fixture.item.id,
          activityId: fixture.activity.id,
          targetSpec: {
            mode: "tokens",
            tokenIds: fixture.targetTokens.map(target => target.id),
          },
        },
        { requireGM: false },
      )).rejects.toThrow(
        "Selected targets must be within 5 ft of each other: target, target-2",
      );
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(fixture.actor.update).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when Foundry cannot measure a required target pair", async () => {
    const fixture = installSpellExecuteRuntime(
      { spell1: { value: 4, max: 4, level: 1 } },
      {
        preparedTargetCount: 2,
        targetIds: ["target", "target-2"],
        selectionConstraints: [{
          type: "pairwise-within-distance",
          maximum: 5,
          units: "ft",
        }],
      },
    );

    try {
      await expect(fixture.runtime(
        "useAction",
        {
          sourceTokenId: "source",
          itemId: fixture.item.id,
          activityId: fixture.activity.id,
          targetSpec: {
            mode: "tokens",
            tokenIds: fixture.targetTokens.map(target => target.id),
          },
        },
        { requireGM: false },
      )).rejects.toThrow(
        "Foundry could not validate pairwise target distance: target, target-2",
      );
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts an enabled required artifact from the selected item source", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    const itemUuid = "Actor.source.Item.item-1";
    (fixture.item as any).uuid = itemUuid;
    (fixture.activity as any).flags = {
      "arcane-dnd5e-2014-automation": {
        interaction: {
          version: 1,
          input: "selected-targets",
          selectionConstraints: [{
            type: "artifact-exists",
            artifactId: "heated-object",
            subject: "target",
          }],
        },
      },
    };
    (fixture.targetTokens[0]!.actor.effects as any[]).push({
      disabled: false,
      active: true,
      isSuppressed: false,
      origin: itemUuid,
      flags: {
        "arcane-dnd5e-2014-automation": {
          compilerArtifactIds: ["heated-object"],
          sourceItemUuid: itemUuid,
        },
      },
    });

    try {
      await expect(fixture.runtime(
        "useAction",
        {
          sourceTokenId: "source",
          itemId: fixture.item.id,
          activityId: fixture.activity.id,
          targetSpec: { mode: "tokens", tokenIds: ["target"] },
        },
        { requireGM: false },
      )).resolves.toMatchObject({ status: "completed" });
      expect(fixture.completeItemUse).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["disabled", { disabled: true }],
    ["inactive", { active: false }],
    ["suppressed", { isSuppressed: true }],
    ["from another item", { sourceItemUuid: "Actor.source.Item.other" }],
  ])(
    "rejects a required artifact that is %s",
    async (_description, state) => {
      const fixture = installSpellExecuteRuntime({
        spell1: { value: 4, max: 4, level: 1 },
      });
      const itemUuid = "Actor.source.Item.item-1";
      const sourceItemUuid = "sourceItemUuid" in state
        ? state.sourceItemUuid
        : itemUuid;
      (fixture.item as any).uuid = itemUuid;
      (fixture.activity as any).flags = {
        "arcane-dnd5e-2014-automation": {
          interaction: {
            version: 1,
            input: "selected-targets",
            selectionConstraints: [{
              type: "artifact-exists",
              artifactId: "heated-object",
              subject: "target",
            }],
          },
        },
      };
      (fixture.targetTokens[0]!.actor.effects as any[]).push({
        disabled: false,
        active: true,
        isSuppressed: false,
        origin: sourceItemUuid,
        ...state,
        flags: {
          "arcane-dnd5e-2014-automation": {
            compilerArtifactIds: ["heated-object"],
            sourceItemUuid,
          },
        },
      });

      try {
        await expect(fixture.runtime(
          "useAction",
          {
            sourceTokenId: "source",
            itemId: fixture.item.id,
            activityId: fixture.activity.id,
            targetSpec: { mode: "tokens", tokenIds: ["target"] },
          },
          { requireGM: false },
        )).rejects.toThrow(
          "Selected target does not hold required artifact heated-object from this source: target",
        );
        expect(fixture.completeItemUse).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("forwards input.spellLevel to Midi and reconciles that exact ordinary slot", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
      spell2: { value: 3, max: 3, level: 2 },
      spell3: { value: 2, max: 3, level: 3 },
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          input: { spellLevel: 3 },
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "completed" });
      const usageConfig = fixture.completeItemUse.mock.calls[0]![1];
      expect(usageConfig.midiOptions.spellLevel).toBe(3);
      expect(usageConfig.spell).toEqual({ slot: "spell3" });
      expect(fixture.actor.update).toHaveBeenCalledWith({
        "system.spells.spell3.value": 1,
      });
      expect(fixture.actor.system.spells).toMatchObject({
        spell1: { value: 4 },
        spell2: { value: 3 },
        spell3: { value: 1 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports an aborted Midi workflow without reconciling a native slot", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    fixture.completeItemUse.mockResolvedValueOnce({
      id: "Workflow.aborted",
      aborted: true,
      targets: new Set(fixture.targetTokens),
    });

    try {
      const result = await fixture.runtime(
        "useAction",
        {
          sourceTokenId: "source",
          itemId: fixture.item.id,
          activityId: fixture.activity.id,
          targetTokenIds: ["target"],
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toMatchObject({
        success: false,
        status: "aborted",
        resourceConsumption: {
          spellSlot: {
            key: "spell1",
            before: 4,
            after: 4,
            reconciled: false,
          },
        },
      });
      expect(result.warnings).toContain("midi-qol-workflow-aborted");
      expect(fixture.actor.update).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("suppresses Midi's implicit thrown-weapon roll dialog only for the programmatic use", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    const thrownItem = fixture.item as any;
    const thrownActivity = fixture.activity as any;
    thrownItem.type = "weapon";
    thrownItem.system.properties = new Set(["fin", "lgt", "thr"]);
    thrownActivity.type = "attack";
    thrownActivity.midiProperties = { forceRollDialog: "default" };
    thrownActivity._source = {
      midiProperties: { forceRollDialog: "default" },
    };
    thrownItem._source = {
      system: {
        activities: {
          [thrownActivity.id]: thrownActivity._source,
        },
      },
    };
    fixture.completeItemUse.mockImplementationOnce(async () => {
      expect(thrownActivity.midiProperties.forceRollDialog).toBe("never");
      expect(thrownActivity._source.midiProperties.forceRollDialog).toBe("never");
      return {
        id: "Workflow.thrown-default",
        targets: new Set(fixture.targetTokens),
      };
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "completed" });
      expect(thrownActivity.midiProperties.forceRollDialog).toBe("default");
      expect(thrownActivity._source.midiProperties.forceRollDialog).toBe("default");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores every thrown-weapon dialog container when suppression is incomplete", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    const thrownItem = fixture.item as any;
    const thrownActivity = fixture.activity as any;
    thrownItem.type = "weapon";
    thrownItem.system.properties = new Set(["thr"]);
    thrownActivity.type = "attack";
    thrownActivity.midiProperties = { forceRollDialog: "default" };
    const immutableSourceProperties: any = {};
    Object.defineProperty(immutableSourceProperties, "forceRollDialog", {
      configurable: true,
      enumerable: true,
      value: "default",
      writable: false,
    });
    thrownActivity._source = {
      midiProperties: immutableSourceProperties,
    };

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toMatchObject({
        status: "rejected",
        code: "ACTION_MISCONFIGURED",
      });
      expect((result as any).message).toContain(
        "Could not suppress the default thrown-weapon attack dialog",
      );
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(thrownActivity.midiProperties.forceRollDialog).toBe("default");
      expect(immutableSourceProperties.forceRollDialog).toBe("default");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves an explicit thrown-weapon force-roll-dialog contract", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    const thrownItem = fixture.item as any;
    const thrownActivity = fixture.activity as any;
    thrownItem.type = "weapon";
    thrownItem.system.properties = new Set(["thr"]);
    thrownActivity.type = "attack";
    thrownActivity.midiProperties = { forceRollDialog: "always" };
    fixture.completeItemUse.mockImplementationOnce(async () => {
      expect(thrownActivity.midiProperties.forceRollDialog).toBe("always");
      return {
        id: "Workflow.thrown-explicit",
        targets: new Set(fixture.targetTokens),
      };
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "completed" });
      expect(thrownActivity.midiProperties.forceRollDialog).toBe("always");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps an aborted submitted action indeterminate and does not advance", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    fixture.completeItemUse.mockResolvedValueOnce({
      id: "Workflow.aborted",
      aborted: true,
      targets: new Set(fixture.targetTokens),
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          advance: true,
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "indeterminate", retry: false });
      expect(fixture.actor.update).not.toHaveBeenCalled();
      expect(fixture.nextTurn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not roll back side effects observed before an aborted workflow returns", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    fixture.completeItemUse.mockImplementationOnce(async () => {
      fixture.actor.system.spells.spell1.value = 3;
      fixture.actor.effects.push({ id: "effect-before-abort", name: "Before Abort" });
      return {
        id: "Workflow.aborted-after-side-effect",
        aborted: true,
        targets: new Set(fixture.targetTokens),
      };
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "indeterminate", retry: false });
      expect(fixture.actor.system.spells.spell1.value).toBe(3);
      expect(fixture.actor.effects).toContainEqual({
        id: "effect-before-abort",
        name: "Before Abort",
      });
      expect(fixture.actor.update).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns partial when a later action aborts and skips the remaining actions", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    fixture.completeItemUse
      .mockResolvedValueOnce({
        id: "Workflow.completed",
        aborted: false,
        targets: new Set(fixture.targetTokens),
      })
      .mockResolvedValueOnce({
        id: "Workflow.aborted",
        aborted: true,
        targets: new Set(fixture.targetTokens),
      });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actions: [1, 2, 3].map(() => ({
            actionId: fixture.actionId,
            targetTokenIds: ["target"],
          })),
          advance: true,
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({
        status: "partial",
        completed: 1,
        requested: 3,
        advance: "not-completed",
        retry: false,
      });
      expect(fixture.completeItemUse).toHaveBeenCalledTimes(2);
      expect(fixture.nextTurn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats an explicit aborted false workflow as completed", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    fixture.completeItemUse.mockResolvedValueOnce({
      id: "Workflow.completed",
      aborted: false,
      targets: new Set(fixture.targetTokens),
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "completed" });
      expect(fixture.actor.system.spells.spell1.value).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("provides the requested native slot before Midi auto-consume checks an empty base slot", async () => {
    const fixture = installSpellExecuteRuntime(
      {
        spell2: { value: 0, max: 3, level: 2 },
        spell3: { value: 2, max: 3, level: 3 },
      },
      { baseLevel: 2 },
    );

    fixture.completeItemUse.mockImplementationOnce(async (_usedItem: unknown, usageConfig: any) => {
      if (usageConfig.spell?.slot !== "spell3") {
        throw new Error("would-open-native-usage-dialog");
      }
      return {
        id: "Workflow.upcast",
        targets: new Set(fixture.targetTokens),
      };
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          input: { spellLevel: 3 },
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "completed" });
      expect(fixture.completeItemUse).toHaveBeenCalledOnce();
      expect(fixture.completeItemUse.mock.calls[0]![1]).toMatchObject({
        spell: { slot: "spell3" },
        midiOptions: { spellLevel: 3 },
      });
      expect(fixture.actor.system.spells).toMatchObject({
        spell2: { value: 0 },
        spell3: { value: 1 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("provides the requested native slot before a placed-template workflow starts", async () => {
    const fixture = installSpellExecuteRuntime(
      {
        spell2: { value: 0, max: 3, level: 2 },
        spell3: { value: 1, max: 3, level: 3 },
      },
      {
        baseLevel: 2,
        templateType: "sphere",
      },
    );

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: [],
          input: { spellLevel: 3 },
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "completed" });
      const usageConfig = fixture.completeItemUse.mock.calls[0]![1];
      expect(usageConfig).toMatchObject({
        spell: { slot: "spell3" },
        midiOptions: {
          spellLevel: 3,
          fastForward: false,
        },
      });
      expect(usageConfig.midiOptions.workflowOptions).not.toHaveProperty(
        "autoRollAttack",
      );
      expect(usageConfig.midiOptions.workflowOptions).not.toHaveProperty(
        "autoRollDamage",
      );
      expect(usageConfig.midiOptions.workflowOptions).not.toHaveProperty(
        "fastForwardAttack",
      );
      expect(usageConfig.midiOptions.workflowOptions).not.toHaveProperty(
        "fastForwardDamage",
      );
      expect(usageConfig).not.toHaveProperty("create");
      expect(fixture.actor.system.spells).toMatchObject({
        spell2: { value: 0 },
        spell3: { value: 0 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the explicit upcast level when validating a formula-based target maximum", async () => {
    const fixture = installSpellExecuteRuntime(
      {
        spell1: { value: 4, max: 4, level: 1 },
        spell3: { value: 2, max: 3, level: 3 },
      },
      {
        baseLevel: 1,
        preparedTargetCount: 1,
        rawTargetCountFormula: "@item.level",
        targetIds: ["target", "target-2", "target-3"],
      },
    );

    try {
      await expect(fixture.runtime(
        "useAction",
        {
          sourceTokenId: "source",
          itemId: fixture.item.id,
          activityId: fixture.activity.id,
          targetSpec: {
            mode: "tokens",
            tokenIds: fixture.targetTokens.map(target => target.id),
          },
          spellLevel: 3,
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      )).resolves.toMatchObject({ status: "completed" });

      expect(fixture.completeItemUse).toHaveBeenCalledOnce();
      expect(fixture.completeItemUse.mock.calls[0]![1].midiOptions.spellLevel).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the item base level when no explicit upcast level is provided", async () => {
    const fixture = installSpellExecuteRuntime(
      {
        spell1: { value: 4, max: 4, level: 1 },
      },
      {
        baseLevel: 1,
        preparedTargetCount: 1,
        rawTargetCountFormula: "@item.level",
        targetIds: ["target", "target-2"],
      },
    );

    try {
      await expect(fixture.runtime(
        "useAction",
        {
          sourceTokenId: "source",
          itemId: fixture.item.id,
          activityId: fixture.activity.id,
          targetSpec: {
            mode: "tokens",
            tokenIds: fixture.targetTokens.map(target => target.id),
          },
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      )).rejects.toThrow("Selected target count exceeds action maximum of 1");

      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(fixture.actor.system.spells.spell1.value).toBe(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hides and hard-rejects an action blocked by an active effect before Midi or slot use", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
    });
    fixture.actor.effects.push({
      id: "gaseous",
      name: "Gaseous Form",
      flags: {
        "arcane-dnd5e-2014-automation": {
          blockedActionKinds: ["attack", "spell"],
        },
      },
    });

    try {
      const context = await fixture.runtime("turnContext", {}, { requireGM: false });
      expect(context.actor.availableActionIds).not.toContain(fixture.actionId);

      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "rejected", code: "ACTION_BLOCKED" });
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(fixture.actor.update).not.toHaveBeenCalled();
      expect(fixture.actor.system.spells.spell1.value).toBe(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hides and hard-rejects an inherited reaction block", async () => {
    const fixture = installSpellExecuteRuntime(
      { spell1: { value: 4, max: 4, level: 1 } },
      {
        itemActivationType: "reaction",
        activityActivation: { type: "action", override: false },
      },
    );
    fixture.actor.effects.push({
      id: "reaction-block",
      name: "Reaction Block",
      flags: {
        "arcane-dnd5e-2014-automation": {
          blockedActionKinds: ["reaction"],
        },
      },
    });

    try {
      const context = await fixture.runtime(
        "turnContext",
        {},
        { requireGM: false },
      );
      expect(context.actor.availableActionIds).not.toContain(fixture.actionId);

      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
        },
        { requireGM: false },
      );

      expect(result).toEqual({
        status: "rejected",
        code: "ACTION_BLOCKED",
      });
      await expect(fixture.runtime(
        "useAction",
        {
          sourceTokenId: "source",
          itemId: fixture.item.id,
          activityId: fixture.activity.id,
          targetSpec: { mode: "tokens", tokenIds: ["target"] },
        },
        { requireGM: false },
      )).rejects.toThrow("ACTION_BLOCKED");
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(fixture.actor.update).not.toHaveBeenCalled();
      expect(fixture.actor.system.spells.spell1.value).toBe(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the explicitly selected slot in the use-action resource receipt", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
      spell3: { value: 2, max: 3, level: 3 },
    });

    try {
      const result = await fixture.runtime(
        "useAction",
        {
          sourceTokenId: "source",
          itemId: fixture.item.id,
          activityId: fixture.activity.id,
          targetSpec: { mode: "tokens", tokenIds: ["target"] },
          spellLevel: 3,
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result.resourceConsumption).toEqual({
        spellSlot: {
          key: "spell3",
          level: 3,
          before: 2,
          after: 1,
          reconciled: true,
        },
      });
      expect(fixture.completeItemUse.mock.calls[0]![1].midiOptions.spellLevel).toBe(3);
      expect(fixture.actor.system.spells.spell1.value).toBe(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns an explicit unavailable-slot error without falling back", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
      spell3: { value: 0, max: 3, level: 3 },
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          input: { spellLevel: 3 },
        },
        { requireGM: false },
      );

      expect(result).toEqual({
        status: "rejected",
        code: "INPUT_INVALID",
        message: "No spell3 spell slots remain for Cure Wounds",
      });
      expect(fixture.completeItemUse).not.toHaveBeenCalled();
      expect(fixture.actor.update).not.toHaveBeenCalled();
      expect(fixture.actor.system.spells.spell1.value).toBe(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps omitted spellLevel on the existing base-slot path", async () => {
    const fixture = installSpellExecuteRuntime({
      spell1: { value: 4, max: 4, level: 1 },
      spell3: { value: 2, max: 3, level: 3 },
    });

    try {
      const result = await fixture.runtime(
        "executeTurn",
        {
          actionId: fixture.actionId,
          targetTokenIds: ["target"],
          input: {},
          actionTimeoutMs: 1000,
        },
        { requireGM: false },
      );

      expect(result).toEqual({ status: "completed" });
      const usageConfig = fixture.completeItemUse.mock.calls[0]![1];
      expect(usageConfig.midiOptions).not.toHaveProperty("spellLevel");
      expect(usageConfig).not.toHaveProperty("spell");
      expect(fixture.actor.update).toHaveBeenCalledWith({
        "system.spells.spell1.value": 3,
      });
      expect(fixture.actor.system.spells.spell3.value).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});


describe("actionConfigProblemV2", () => {
  const itemWithTarget = (target: any) => ({ system: { target } });
  const activityWithTarget = (target: any) => ({ target });

  it("returns null for a template spell with activity-level prompt enabled", () => {
    const item = itemWithTarget({ template: { type: "cube" } });
    expect(actionConfigProblemV2(item, activityWithTarget({ prompt: true }))).toBeNull();
  });

  it("flags a template spell with activity-level prompt disabled", () => {
    const item = itemWithTarget({ template: { type: "cube" } });
    expect(actionConfigProblemV2(item, activityWithTarget({ prompt: false }))).toBe("template-prompt-disabled");
  });

  it("reads prompt from the activity even when override is false", () => {
    // The pack pattern: full template at item level, prompt true at activity
    // level, override false. Item-level prompt must not matter.
    const item = itemWithTarget({ template: { type: "cube" }, prompt: false });
    expect(actionConfigProblemV2(item, activityWithTarget({ prompt: true, override: false }))).toBeNull();
  });

  it("returns null when there is no template", () => {
    const item = itemWithTarget({ affects: { type: "creature" } });
    expect(actionConfigProblemV2(item, activityWithTarget({ prompt: false }))).toBeNull();
  });

  it("honours activity.target.override for the template data itself", () => {
    const item = itemWithTarget({ template: { type: "cube" } });
    const overridingNoTemplate = activityWithTarget({ override: true, affects: { type: "creature" }, prompt: false });
    expect(actionConfigProblemV2(item, overridingNoTemplate)).toBeNull();
    const overridingTemplate = activityWithTarget({ override: true, template: { type: "cube" }, prompt: false });
    expect(actionConfigProblemV2(item, overridingTemplate)).toBe("template-prompt-disabled");
  });

  it("treats a missing activity prompt flag as disabled", () => {
    const item = itemWithTarget({ template: { type: "sphere" } });
    expect(actionConfigProblemV2(item, activityWithTarget({}))).toBe("template-prompt-disabled");
  });

  it("only requires a prompt for templates whose final mode needs human placement", () => {
    const selfRadius = {
      system: {
        target: { template: { type: "radius" } },
        range: { units: "self" },
      },
    };
    const selfCone = {
      system: {
        target: { template: { type: "cone" } },
        range: { units: "self" },
      },
    };
    expect(actionConfigProblemV2(selfRadius, { type: "save", target: { prompt: false } })).toBeNull();
    expect(actionConfigProblemV2(selfCone, { type: "save", target: { prompt: false } })).toBe("template-prompt-disabled");
  });

  it("does not turn Midi auto-target policy into an input-contract requirement", () => {
    const item = itemWithTarget({ template: { type: "cube" } });
    const activity = {
      type: "save",
      target: { prompt: true },
      midiProperties: { autoTargetAction: "default" },
    };
    expect(actionConfigProblemV2(item, activity)).toBeNull();
  });

  it("allows a reviewed override to disagree with misleading dnd5e target data", () => {
    const item = {
      system: {
        target: { template: { type: "cube" } },
        range: { value: 120, units: "ft" },
      },
    };
    const activity = {
      type: "save",
      target: { prompt: true },
      midiProperties: { autoTargetAction: "always" },
      flags: {
        "arcane-dnd5e-2014-automation": {
          interaction: { version: 1, input: "selected-targets" },
        },
      },
    };
    expect(actionConfigProblemV2(item, activity)).toBeNull();
    activity.target.prompt = false;
    expect(actionConfigProblemV2(item, activity)).toBeNull();
    activity.flags["arcane-dnd5e-2014-automation"].interaction.input = "placed-template";
    expect(actionConfigProblemV2(item, activity)).toBe("template-prompt-disabled");
  });

  it("validates only the sparse override schema and public three-mode enum", () => {
    const item = itemWithTarget({ affects: { type: "creature" } });
    const activity: any = {
      type: "save",
      target: { prompt: false },
      flags: { "arcane-dnd5e-2014-automation": { interaction: { version: 3, input: "self" } } },
    };
    expect(actionConfigProblemV2(item, activity)).toBe("interaction-version-unsupported");
    activity.flags["arcane-dnd5e-2014-automation"].interaction.version = 1;
    activity.flags["arcane-dnd5e-2014-automation"].interaction.input = "none";
    expect(actionConfigProblemV2(item, activity)).toBe("interaction-input-invalid");
    activity.flags["arcane-dnd5e-2014-automation"].interaction = "self";
    expect(actionConfigProblemV2(item, activity)).toBe("interaction-contract-invalid");
  });

  it("requires real template geometry only when the final mode is placed-template", () => {
    const item = itemWithTarget({ affects: { type: "creature" } });
    const activity = {
      type: "save",
      target: { prompt: true },
      flags: {
        "arcane-dnd5e-2014-automation": {
          interaction: { version: 1, input: "placed-template" },
        },
      },
    };
    expect(actionConfigProblemV2(item, activity)).toBe("placed-template-missing-template");
  });
});

describe("input contract public modes", () => {
  const projectileResolution = {
    primitive: "action-resolution",
    type: "independent-projectiles",
    count: {
      primitive: "value-expression",
      type: "per-slot-above-base",
      base: { primitive: "value-expression", type: "constant", value: 3 },
      increment: { primitive: "value-expression", type: "constant", value: 1 },
    },
    allocation: "optional-explicit",
    defaultTarget: "concentrate",
  };

  it("accepts the compiler-emitted normalized resolution shape", () => {
    const normalizedResolution = {
      type: "independent-projectiles",
      count: {
        type: "per-slot-above-base",
        base: { type: "constant", value: 3 },
        increment: { type: "constant", value: 1 },
      },
      allocation: "optional-explicit",
      defaultTarget: "concentrate",
    };
    const parsed = parseIndependentProjectilesContractV2({
      resolution: normalizedResolution,
    });
    expect(parsed.problem).toBeNull();
    expect(parsed.resolution?.count).toEqual(normalizedResolution.count);
  });

  it("advertises the optional explicit allocation without adding a fourth input mode", () => {
    const item = {
      system: {
        level: 1,
        target: { affects: { type: "creature", count: "1" } },
        range: { value: 120, units: "ft" },
      },
    };
    const activity = {
      type: "damage",
      target: {},
      range: {},
      flags: {
        "arcane-dnd5e-2014-automation": {
          interaction: {
            version: 2,
            input: "selected-targets",
            resolution: projectileResolution,
          },
        },
      },
    };
    const contract = deriveActivityInputContract(item, activity);
    expect(contract.mode).toBe("selected-targets");
    expect(contract.required).toEqual(["targetTokenIds"]);
    expect(contract.optional).toEqual(["input.allocation"]);
    expect(contract.resolution?.type).toBe("independent-projectiles");
    expect(actionConfigProblemV2(item, activity)).toBeNull();
  });

  it("resolves upcast projectile counts and validates explicit allocation", () => {
    const item = { system: { level: 1 } };
    const contract = {
      resolution: parseIndependentProjectilesContractV2({
        resolution: projectileResolution,
      }).resolution,
    };
    expect(resolveIndependentProjectileCountV2(item, contract, 1)).toBe(3);
    expect(resolveIndependentProjectileCountV2(item, contract, 3)).toBe(5);
    expect(resolveIndependentProjectileAllocationV2(
      item,
      contract,
      ["A", "B"],
      [
        { targetTokenId: "A", count: 2 },
        { targetTokenId: "B", count: 3 },
      ],
      3,
    )).toMatchObject({
      expectedCount: 5,
      primaryTargetId: "A",
      sequence: ["A", "A", "B", "B", "B"],
    });
    expect(() => resolveIndependentProjectileAllocationV2(
      item,
      contract,
      ["A", "B"],
      undefined,
      3,
    )).toThrow("unless DM explicitly declares");
    expect(() => resolveIndependentProjectileAllocationV2(
      item,
      contract,
      ["A", "B"],
      [
        { targetTokenId: "A", count: 2 },
        { targetTokenId: "B", count: 2 },
      ],
      3,
    )).toThrow("expected 5");
  });

  it("uses the actual Pact Magic pool level for projectile counts", () => {
    const slot = resolveNativeSpellSlotConsumption(
      { type: "spell", system: { method: "pact", level: 1 } },
      { consumption: { spellSlot: true } },
      {
        system: {
          spells: {
            pact: { value: 2, max: 2, level: 3 },
          },
        },
      },
      { pact: { getSpellSlotKey: () => "pact" } },
    );
    const contract = {
      resolution: parseIndependentProjectilesContractV2({
        resolution: projectileResolution,
      }).resolution,
    };
    expect(slot?.level).toBe(3);
    expect(resolveIndependentProjectileCountV2(
      { system: { level: 1 } },
      contract,
      slot?.level,
    )).toBe(5);
  });

  it("uses dnd5e cantrip scaling for independent beam counts", () => {
    const cantripResolution = {
      primitive: "action-resolution",
      type: "independent-projectiles",
      count: {
        primitive: "value-expression",
        type: "cantrip-progression",
        base: { primitive: "value-expression", type: "constant", value: 1 },
        increment: { primitive: "value-expression", type: "constant", value: 1 },
      },
      allocation: "optional-explicit",
      defaultTarget: "concentrate",
    };
    const contract = {
      resolution: parseIndependentProjectilesContractV2({
        resolution: cantripResolution,
      }).resolution,
    };
    expect(resolveIndependentProjectileCountV2(
      { system: { level: 0, scalingIncrease: 0 } },
      contract,
    )).toBe(1);
    expect(resolveIndependentProjectileCountV2(
      { system: { level: 0, scalingIncrease: 3 } },
      contract,
    )).toBe(4);
  });

  it("advertises placed-template without requiring agent parameters", () => {
    const contract = deriveActivityInputContract(
      { system: { target: { template: { type: "cube", size: 30, units: "ft" }, prompt: true }, range: { value: 120, units: "ft" } } },
      { type: "save", target: {}, range: {} }
    );
    expect(contract.mode).toBe("placed-template");
    expect(contract.required).toEqual([]);
  });

  it("advertises targetTokenIds for selected-target actions", () => {
    const contract = deriveActivityInputContract(
      { system: { target: { affects: { type: "creature", count: "1" } }, range: { value: 5, units: "ft" } } },
      { type: "attack", target: {}, range: {} }
    );
    expect(contract.mode).toBe("selected-targets");
    expect(contract.required).toEqual(["targetTokenIds"]);
  });

  it("accepts a gm-declared tokens bypass for a template contract", () => {
    const contract = deriveActivityInputContract(
      { system: { target: { template: { type: "cube", size: 30, units: "ft" }, prompt: true }, range: { value: 120, units: "ft" } } },
      { type: "save", target: {}, range: {} }
    );
    const resolution = resolveTargetSpecForContract(
      { targetSpec: { mode: "tokens", tokenIds: ["t1", "t2"], geometry: "gm-declared" } },
      contract
    );
    expect(resolution.mode).toBe("tokens");
    expect(resolution.tokenIds).toEqual(["t1", "t2"]);
    expect(resolution.bypassedTemplateGeometry).toBe(true);
  });

  it("still rejects bare tokens for a template contract without gm-declared", () => {
    const contract = deriveActivityInputContract(
      { system: { target: { template: { type: "cube", size: 30, units: "ft" }, prompt: true }, range: { value: 120, units: "ft" } } },
      { type: "save", target: {}, range: {} }
    );
    expect(() =>
      resolveTargetSpecForContract({ targetSpec: { mode: "tokens", tokenIds: ["t1"] } }, contract)
    ).toThrow(/does not match/);
  });
});

describe("CDP event delivery", () => {
  it("delivers protocol events independently from command responses", async () => {
    const session = new CdpSession("ws://127.0.0.1/devtools/page/target");
    const listener = vi.fn();
    const unsubscribe = session.on("Runtime.executionContextCreated", listener);
    const params = { context: { id: 17, auxData: { isDefault: true } } };

    await (session as any).handleMessage(JSON.stringify({
      method: "Runtime.executionContextCreated",
      params,
    }));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(params);

    unsubscribe();
    await (session as any).handleMessage(JSON.stringify({
      method: "Runtime.executionContextCreated",
      params,
    }));
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("runtime connection lifecycle", () => {
  it("closes a partially connected runtime when connect rejects", async () => {
    const connectError = new Error("Page.enable rejected");
    const runtime = {
      connect: vi.fn().mockRejectedValue(connectError),
      close: vi.fn(),
    };
    const use = vi.fn();

    await expect(withRuntimeConnection(runtime, use)).rejects.toBe(connectError);

    expect(use).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("closes a partially connected runtime when bounded connect times out", async () => {
    const timeoutError = Object.assign(new Error("CDP command timed out: Page.enable"), {
      code: "ERR_CDP_COMMAND_TIMEOUT",
    });
    const runtime = {
      connect: vi.fn().mockRejectedValue(timeoutError),
      close: vi.fn(),
    };
    const use = vi.fn();

    await expect(withRuntimeConnection(runtime, use, 37)).rejects.toBe(timeoutError);

    expect(runtime.connect).toHaveBeenCalledOnce();
    expect(runtime.connect).toHaveBeenCalledWith(37);
    expect(use).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});

describe("one-shot page reload", () => {
  const origin = "http://127.0.0.1:30101";
  const gameUrl = `${origin}/game`;
  const reloadOptions = {
    targetUrl: gameUrl,
    expectedOrigin: origin,
    expectedWorldId: "cos-a",
    timeoutMs: 1000,
  };

  function setupPageReload(options: {
    frames?: Array<{ id: string; loaderId: string; url: string }>;
    reloadError?: Error;
    diagnostics?: Record<string, unknown>;
  } = {}) {
    const client = new FoundryRuntimeClient({
      id: "game-target",
      type: "page",
      title: "Foundry",
      url: gameUrl,
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/game-target",
    });
    const defaultFrame = {
      id: "main-frame",
      loaderId: "loader-before-reload",
      url: gameUrl,
    };
    const frames = [...(options.frames ?? [defaultFrame, defaultFrame])];
    const diagnostics = options.diagnostics ?? {
      href: gameUrl,
      ready: true,
      user: { id: "gm-user", isGM: true },
      world: { id: "cos-a" },
    };
    const sessionClose = vi.fn();
    const sessionCall = vi.fn(async (
      method: string,
      _params: Record<string, unknown>,
      _timeoutMs: number,
    ) => {
      if (method === "Page.getFrameTree") {
        const frame = frames.shift();
        if (!frame) throw new Error("Unexpected extra Page.getFrameTree call");
        return { frameTree: { frame } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: diagnostics } };
      }
      if (method === "Page.reload") {
        if (options.reloadError) throw options.reloadError;
        return {};
      }
      throw new Error(`Unexpected CDP method: ${method}`);
    });
    (client as any).session = { call: sessionCall, close: sessionClose };
    (client as any).mainFrameId = defaultFrame.id;
    (client as any).mainExecutionContextId = 17;
    return { client, sessionCall, sessionClose, defaultFrame };
  }

  it("reloads the authorized loader exactly once and returns immediately after acknowledgement", async () => {
    const { client, sessionCall, defaultFrame } = setupPageReload();

    await expect(client.pageReload(reloadOptions)).resolves.toEqual({
      status: "acknowledged",
      retry: false,
      target: { id: "game-target", url: gameUrl },
      frame: defaultFrame,
      gate: {
        ready: true,
        worldId: "cos-a",
        userId: "gm-user",
        isGM: true,
      },
      reload: {
        ignoreCache: false,
        loaderId: defaultFrame.loaderId,
      },
    });

    const reloadCalls = sessionCall.mock.calls.filter(call => call[0] === "Page.reload");
    expect(reloadCalls).toHaveLength(1);
    expect(reloadCalls[0]?.[1]).toEqual({
      ignoreCache: false,
      loaderId: "loader-before-reload",
    });
    expect(sessionCall).toHaveBeenCalledTimes(4);
    expect(sessionCall.mock.calls.filter(call => call[0] === "Page.getFrameTree"))
      .toHaveLength(2);
    const runtimeCall = sessionCall.mock.calls.find(call => call[0] === "Runtime.callFunctionOn");
    expect(runtimeCall?.[1]).toMatchObject({
      executionContextId: 17,
      arguments: [
        { value: "doctor" },
        { value: {} },
        { value: { requireGM: true } },
      ],
    });
  });

  it("rejects a loader race before dispatching Page.reload", async () => {
    const { client, sessionCall } = setupPageReload({
      frames: [
        { id: "main-frame", loaderId: "loader-one", url: gameUrl },
        { id: "main-frame", loaderId: "loader-two", url: gameUrl },
      ],
    });

    await expect(client.pageReload(reloadOptions)).rejects.toMatchObject({
      code: "ERR_PAGE_RELOAD_RACE",
    });
    expect(sessionCall.mock.calls.some(call => call[0] === "Page.reload")).toBe(false);
  });

  it("marks a Page.reload acknowledgement timeout indeterminate without retrying", async () => {
    const timeout = new CliError(
      "ERR_CDP_COMMAND_TIMEOUT",
      "CDP command timed out: Page.reload",
    );
    const { client, sessionCall } = setupPageReload({ reloadError: timeout });

    await expect(client.pageReload(reloadOptions)).rejects.toMatchObject({
      code: "ERR_PAGE_RELOAD_INDETERMINATE",
      details: {
        status: "indeterminate",
        retry: false,
        frame: { loaderId: "loader-before-reload", url: gameUrl },
      },
    });
    expect(sessionCall.mock.calls.filter(call => call[0] === "Page.reload")).toHaveLength(1);
  });

  it("closes the CDP session when the loader-guarded reload rejects", async () => {
    const rejected = new CliError(
      "ERR_CDP_COMMAND",
      "Reload was canceled because the loader changed",
    );
    const { client, sessionCall, sessionClose } = setupPageReload({
      reloadError: rejected,
    });
    vi.spyOn(client, "connect").mockResolvedValue(undefined);

    await expect(withRuntimeConnection(
      client,
      () => client.pageReload(reloadOptions),
    )).rejects.toBe(rejected);

    expect(sessionCall.mock.calls.filter(call => call[0] === "Page.reload")).toHaveLength(1);
    expect(sessionClose).toHaveBeenCalledOnce();
  });
});

describe("runtime function bootstrap", () => {
  function setupRuntimeClient(response: unknown = {
    result: { value: { ok: true } },
  }) {
    const client = new FoundryRuntimeClient({
      id: "target",
      type: "page",
      title: "Foundry",
      url: "http://127.0.0.1:30000/game",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target",
    } as any);
    const sessionCall = vi.fn().mockResolvedValue(response);
    (client as any).session = { call: sessionCall };
    (client as any).mainExecutionContextId = 17;
    return { client, sessionCall };
  }

  it("invokes Foundry in the tracked main execution context without a global object handle", async () => {
    const { client, sessionCall } = setupRuntimeClient();

    await expect(client.debugEval(
      "return { value: arg.value, missing: arg.missing };",
      { value: "quoted \\\"value\\\"" },
      { timeoutMs: 1000 },
    )).resolves.toEqual({ ok: true });

    expect(sessionCall).toHaveBeenCalledOnce();
    const call = sessionCall.mock.calls[0];
    expect(call).toBeDefined();
    const [method, params, timeout] = call!;
    expect(method).toBe("Runtime.callFunctionOn");
    expect(timeout).toBeGreaterThan(0);
    expect(params).toMatchObject({
      executionContextId: 17,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    expect(params).not.toHaveProperty("objectId");
    expect(params).not.toHaveProperty("objectGroup");
    expect(params.functionDeclaration).toContain("return { value: arg.value");
    expect(params.arguments).toEqual([{ value: { value: "quoted \\\"value\\\"" } }]);
  });

  it("rejects runtime work when no main-world execution context becomes available", async () => {
    const { client, sessionCall } = setupRuntimeClient();
    (client as any).mainExecutionContextId = undefined;

    await expect(client.debugEval("return arg;", {}, { timeoutMs: 20 }))
      .rejects.toMatchObject({ code: "ERR_CDP_EXECUTION_CONTEXT" });
    expect(sessionCall).not.toHaveBeenCalled();
  });

  it("marks executeTurn transport timeout after dispatch indeterminate and non-retryable", async () => {
    const timeout = new CliError(
      "ERR_CDP_COMMAND_TIMEOUT",
      "CDP command timed out: Runtime.callFunctionOn",
    );
    const { client, sessionCall } = setupRuntimeClient();
    sessionCall.mockRejectedValue(timeout);

    await expect(client.direct("executeTurn", { actionId: "attack" }, { timeoutMs: 20 }))
      .resolves.toMatchObject({
        status: "indeterminate",
        retry: false,
        code: "FOUNDRY_SDK_RUNTIME_INTERRUPTED",
        runtimeStatus: "timeout",
      });
    expect(sessionCall).toHaveBeenCalledOnce();
  });

  it("throws machine-readable indeterminate state for a generic write after dispatch", async () => {
    const timeout = new CliError(
      "ERR_CDP_COMMAND_TIMEOUT",
      "CDP command timed out: Runtime.callFunctionOn",
    );
    const { client, sessionCall } = setupRuntimeClient();
    sessionCall.mockRejectedValue(timeout);

    let interruption: unknown;
    try {
      await client.direct("actorUpdate", { actorId: "a1", updates: { name: "Changed" } }, {
        timeoutMs: 20,
      });
    } catch (error) {
      interruption = error;
    }

    expect(errorToJson(interruption)).toMatchObject({
      code: "FOUNDRY_SDK_RUNTIME_INTERRUPTED",
      details: {
        status: "indeterminate",
        retry: false,
        code: "FOUNDRY_SDK_RUNTIME_INTERRUPTED",
        action: "actorUpdate",
        runtimeStatus: "timeout",
      },
    });
    expect(sessionCall).toHaveBeenCalledOnce();
  });

  it("keeps read transport failures as errors instead of write receipts", async () => {
    const timeout = new CliError(
      "ERR_CDP_COMMAND_TIMEOUT",
      "CDP command timed out: Runtime.callFunctionOn",
    );
    const { client, sessionCall } = setupRuntimeClient();
    sessionCall.mockRejectedValue(timeout);

    await expect(client.direct("worldInfo", {}, { timeoutMs: 20 })).rejects.toBe(timeout);
    expect(sessionCall).toHaveBeenCalledOnce();
  });

  it("does not mark executeTurn indeterminate before a CDP dispatch", async () => {
    const { client, sessionCall } = setupRuntimeClient();
    (client as any).mainExecutionContextId = undefined;

    await expect(client.direct("executeTurn", { actionId: "attack" }, { timeoutMs: 20 }))
      .rejects.toMatchObject({ code: "ERR_CDP_EXECUTION_CONTEXT" });
    expect(sessionCall).not.toHaveBeenCalled();
  });

  it("keeps generic write failures unchanged before a CDP dispatch", async () => {
    const { client, sessionCall } = setupRuntimeClient();
    (client as any).mainExecutionContextId = undefined;

    await expect(client.direct("actorUpdate", { actorId: "a1", updates: {} }, { timeoutMs: 20 }))
      .rejects.toMatchObject({ code: "ERR_CDP_EXECUTION_CONTEXT" });
    expect(sessionCall).not.toHaveBeenCalled();
  });
});

describe("canvas click obstruction guard", () => {
  function setupCanvasClick(accepted: boolean) {
    const client = new FoundryRuntimeClient({
      id: "target",
      type: "page",
      title: "Foundry",
      url: "http://127.0.0.1:30000/game",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target",
    } as any);
    const sessionCall = vi.fn().mockResolvedValue({});
    (client as any).session = { call: sessionCall };

    const canvasElement = {
      tag: "canvas",
      id: "board",
      classes: [],
      aria: { role: null, modal: null, hidden: null, disabled: null },
    };
    const dialogElement = {
      tag: "div",
      id: "ability-use-dialog",
      classes: ["dialog", "application"],
      aria: { role: "dialog", modal: "true", hidden: null, disabled: null },
    };
    const before = {
      sceneId: "scene",
      client: { x: 100, y: 120 },
      roundTrip: { x: 400, y: 500 },
      viewport: { width: 800, height: 600 },
      previewCount: 1,
      templateIds: [],
      dom: {
        accepted,
        hit: accepted ? canvasElement : dialogElement,
        canvas: canvasElement,
        dialog: accepted ? null : dialogElement,
      },
    };
    const after = {
      ...before,
      previewCount: 0,
      templateIds: ["template-1"],
      dom: {
        accepted: true,
        hit: canvasElement,
        canvas: canvasElement,
        dialog: null,
      },
    };
    vi.spyOn(client as any, "canvasPointerContext")
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    return { client, sessionCall, before };
  }

  it("refuses to dispatch trusted mouse events through a dialog", async () => {
    const { client, sessionCall, before } = setupCanvasClick(false);

    await expect(client.canvasClick({
      x: 400,
      y: 500,
      waitForTemplatePreviewMs: 0,
      settleMs: 0,
    })).rejects.toMatchObject({
      code: "ERR_CANVAS_POINT_OBSTRUCTED",
      details: {
        canvas: { x: 400, y: 500 },
        client: before.client,
        dom: before.dom,
      },
    });

    expect(sessionCall).not.toHaveBeenCalled();
    expect(JSON.stringify(before.dom)).not.toContain("textContent");
  });

  it("still dispatches a click when the DOM hit is Foundry's canvas", async () => {
    const { client, sessionCall } = setupCanvasClick(true);

    const result = await client.canvasClick({
      x: 400,
      y: 500,
      waitForTemplatePreviewMs: 0,
      settleMs: 0,
    }) as any;

    expect(sessionCall).toHaveBeenCalledTimes(3);
    expect(result.templates.created).toEqual(["template-1"]);
  });

  it("waits for preview-driven canvas movement to settle before clicking", async () => {
    const { client, sessionCall, before } = setupCanvasClick(true);
    const drifted = {
      ...before,
      client: { x: 180, y: 170 },
      roundTrip: { x: 400, y: 500 },
    };
    const after = {
      ...drifted,
      previewCount: 0,
      templateIds: ["template-1"],
    };
    const pointerContext = (client as any).canvasPointerContext;
    pointerContext.mockReset()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(drifted)
      .mockResolvedValueOnce(drifted)
      .mockResolvedValueOnce(drifted)
      .mockResolvedValueOnce(after);

    const result = await client.canvasClick({
      x: 400,
      y: 500,
      waitForTemplatePreviewMs: 1000,
      settleMs: 0,
    }) as any;

    expect(sessionCall).toHaveBeenCalledTimes(3);
    expect(sessionCall.mock.calls[0]?.[1]).toMatchObject({ x: 180, y: 170 });
    expect(result.stableCoordinateObservations).toBe(2);
    expect(result.templates.created).toEqual(["template-1"]);
  });
});

describe("activity UI Actor identity", () => {
  it("classifies only a complete Scene.Token.Actor UUID as synthetic", () => {
    expect(isExactSyntheticActorUuid("Scene.scene1.Token.token1.Actor.actor1")).toBe(true);
    for (const value of [
      "Actor.actor1",
      "Scene.scene1.Token.token1",
      "Scene.scene1.Token.token1.Actor.actor1.Item.item1",
      "Scene.scene1.Token..Actor.actor1",
    ]) expect(isExactSyntheticActorUuid(value)).toBe(false);
  });

  it("binds a synthetic Actor to its exact unlinked Token identity", () => {
    const identity = activityUiActorIdentity({
      id: "actor1",
      uuid: "Scene.scene1.Token.token1.Actor.actor1",
      isToken: true,
      token: {
        uuid: "Scene.scene1.Token.token1",
        actorLink: false,
      },
    });
    expect(identity).toEqual({
      id: "actor1",
      uuid: "Scene.scene1.Token.token1.Actor.actor1",
      isToken: true,
      tokenUuid: "Scene.scene1.Token.token1",
      actorLink: false,
    });
  });

  it("uses the NPC features tab without changing character defaults or explicit tabs", () => {
    expect(activityUiDefaultTab("npc", "weapon")).toBe("features");
    expect(activityUiDefaultTab("npc", "spell")).toBe("spells");
    expect(activityUiDefaultTab("character", "spell")).toBe("spells");
    expect(activityUiDefaultTab("character", "weapon")).toBe("inventory");
    expect(activityUiDefaultTab("npc", "weapon", "effects")).toBe("effects");
  });
});

describe("activity UI user authorization", () => {
  function setupActivityUiAccessGate() {
    const client = new FoundryRuntimeClient({
      id: "player-target",
      type: "page",
      title: "Foundry",
      url: "http://127.0.0.1:30000/game",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/player-target",
    } as any);
    const sessionCall = vi.fn(async (
      method: string,
      params: Record<string, any>,
    ) => {
      if (method !== "Runtime.callFunctionOn") {
        throw new Error(`Unexpected CDP method: ${method}`);
      }
      const runtime = new Function(`return (${params.functionDeclaration});`)();
      const args = params.arguments.map((argument: { value: unknown }) => argument.value);
      return { result: { value: await runtime(...args) } };
    });
    (client as any).session = { call: sessionCall };
    (client as any).mainExecutionContextId = 17;
    vi.stubGlobal("game", {
      ready: true,
      user: { id: "player", isGM: false },
      actors: new Map(),
    });
    vi.stubGlobal("canvas", { ready: true });
    return { client, sessionCall };
  }

  const pointerOptions = {
    actorIdentifier: "missing-player-actor",
    itemIdentifier: "item",
    activityIdentifier: "activity",
    targetTokenIds: [],
    tab: "",
  };

  it("rejects a PLAYER before resolving UI state when the GM gate is enabled", async () => {
    const { client, sessionCall } = setupActivityUiAccessGate();
    try {
      await expect((client as any).activityUiPointerContext({
        ...pointerOptions,
        requireGM: true,
      })).rejects.toThrow("GM user is required");
      expect(sessionCall).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows a PLAYER past the GM gate only when explicitly disabled", async () => {
    const { client, sessionCall } = setupActivityUiAccessGate();
    try {
      await expect((client as any).activityUiPointerContext({
        ...pointerOptions,
        requireGM: false,
      })).rejects.toThrow("Actor not found: missing-player-actor");
      expect(sessionCall).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("activity UI click state cleanup", () => {
  function setupActivityUiClick(options: {
    clientX?: number;
    expandedByCli?: boolean;
    dispatchError?: Error;
  } = {}) {
    const client = new FoundryRuntimeClient({
      id: "target",
      type: "page",
      title: "Foundry",
      url: "http://127.0.0.1:30000/game",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target",
    } as any);
    const sessionCall = options.dispatchError
      ? vi.fn().mockRejectedValue(options.dispatchError)
      : vi.fn().mockResolvedValue({});
    (client as any).session = { call: sessionCall };

    const before = {
      actor: {
        id: "actor",
        uuid: "Scene.scene.Token.token.Actor.actor",
        name: "Caster",
        type: "npc",
        isToken: true,
        tokenUuid: "Scene.scene.Token.token",
        actorLink: false,
      },
      item: { id: "item", name: "Spell", identifier: "spell" },
      activity: { id: "activity", name: "Cast", semanticActionId: "spell.cast" },
      targets: [],
      tab: "spells",
      client: { x: options.clientX ?? 100, y: 100 },
      viewport: { width: 800, height: 600 },
      receiptKey: "receipt",
      expandedByCli: options.expandedByCli ?? true,
    };
    const pointerContextSpy = vi
      .spyOn(client as any, "activityUiPointerContext")
      .mockResolvedValue(before);

    const cleanup = {
      receipt: {
        clicked: true,
        isTrusted: true,
        button: 0,
        detail: 1,
        actorId: "actor",
        actorUuid: before.actor.uuid,
        isToken: before.actor.isToken,
        tokenUuid: before.actor.tokenUuid,
        actorLink: before.actor.actorLink,
        itemId: "item",
        activityId: "activity",
        timestamp: 1,
      },
      uiState: {
        expandedByCli: before.expandedByCli,
        restored: true,
        status: before.expandedByCli ? "restored" : "not-needed",
      },
    };
    const cleanupSpy = vi
      .spyOn(client as any, "activityUiClickReceipt")
      .mockResolvedValue(cleanup);
    return { client, sessionCall, before, pointerContextSpy, cleanup, cleanupSpy };
  }

  it("restores a row that the CLI temporarily expanded", async () => {
    const {
      client,
      sessionCall,
      pointerContextSpy,
      cleanup,
      cleanupSpy,
    } = setupActivityUiClick();

    const result = await client.activityUiClick({
      actorIdentifier: "actor",
      itemIdentifier: "item",
      activityIdentifier: "activity",
      settleMs: 0,
    }) as any;

    expect(sessionCall).toHaveBeenCalledTimes(3);
    expect(pointerContextSpy).toHaveBeenCalledWith(expect.objectContaining({
      requireGM: true,
    }));
    expect(cleanupSpy).toHaveBeenCalledOnce();
    expect(result.uiState).toEqual(cleanup.uiState);
  });

  it("passes an explicit non-GM gate for a PLAYER activity click", async () => {
    const { client, pointerContextSpy } = setupActivityUiClick();

    await client.activityUiClick({
      actorIdentifier: "Scene.scene.Token.token.Actor.actor",
      itemIdentifier: "item",
      activityIdentifier: "activity",
      settleMs: 0,
      requireGM: false,
    });

    expect(pointerContextSpy).toHaveBeenCalledWith(expect.objectContaining({
      requireGM: false,
    }));
  });

  it("still cleans up when the planned control is offscreen", async () => {
    const { client, sessionCall, cleanupSpy } = setupActivityUiClick({ clientX: 900 });

    await expect(client.activityUiClick({
      actorIdentifier: "actor",
      itemIdentifier: "item",
      activityIdentifier: "activity",
      settleMs: 0,
    })).rejects.toMatchObject({ code: "ERR_ACTIVITY_UI_CONTROL_OFFSCREEN" });

    expect(sessionCall).not.toHaveBeenCalled();
    expect(cleanupSpy).toHaveBeenCalledOnce();
  });

  it("still cleans up when trusted mouse dispatch fails", async () => {
    const dispatchError = new Error("CDP dispatch failed");
    const { client, cleanupSpy } = setupActivityUiClick({ dispatchError });

    await expect(client.activityUiClick({
      actorIdentifier: "actor",
      itemIdentifier: "item",
      activityIdentifier: "activity",
      settleMs: 0,
    })).rejects.toBe(dispatchError);

    expect(cleanupSpy).toHaveBeenCalledOnce();
  });

  it("rejects a trusted receipt whose synthetic Token identity drifted", async () => {
    const { client, cleanup } = setupActivityUiClick();
    cleanup.receipt.tokenUuid = "Scene.scene.Token.other";

    await expect(client.activityUiClick({
      actorIdentifier: "Scene.scene.Token.token.Actor.actor",
      itemIdentifier: "item",
      activityIdentifier: "activity",
      settleMs: 0,
    })).rejects.toMatchObject({ code: "ERR_ACTIVITY_UI_CLICK_IDENTITY_DRIFT" });
  });
});
