/**
 * Pure, transport-independent mirrors of the helpers embedded in runtimeFunction.
 *
 * runtimeFunction remains a self-contained browser injection string. The SDK test suite
 * enforces exact compiled-body equality between these helpers and that closure.
 */

export type FoundryActivityRangeCheck = "valid" | "invalid" | "unavailable";

export function measureTokenDistanceWithFoundry(
  runtime: any,
  fromToken: any,
  toToken: any,
): number | null {
  if (!fromToken || !toToken) return null;

  const midi = runtime?.MidiQOL;
  if (typeof midi?.getDistance === "function") {
    try {
      const distance = Number(
        midi.getDistance(fromToken, toToken, {
          wallsBlock: false,
          includeCover: false,
        }),
      );
      if (Number.isFinite(distance)) return distance >= 0 ? distance : null;
    } catch {
      // Fall through to Foundry's grid measurement when midi-qol cannot measure.
    }
  }

  const canvas = runtime?.canvas;
  const grid = canvas?.grid;
  if (typeof grid?.measurePath !== "function") return null;

  function centerOf(tokenLike: any): { x: number; y: number; elevation: number } | null {
    const document = tokenLike?.document ?? tokenLike;
    const placeable =
      tokenLike?.center
        ? tokenLike
        : document?.object?.center
          ? document.object
          : canvas?.tokens?.get?.(document?.id) ?? null;
    const centerX = Number(placeable?.center?.x);
    const centerY = Number(placeable?.center?.y);
    if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
      return {
        x: centerX,
        y: centerY,
        elevation: Number(document?.elevation ?? 0),
      };
    }

    const gridSize = Number(canvas?.dimensions?.size ?? canvas?.scene?.grid?.size);
    const x = Number(document?.x);
    const y = Number(document?.y);
    if (!Number.isFinite(gridSize) || gridSize <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return {
      x: x + (Number(document?.width ?? 1) * gridSize) / 2,
      y: y + (Number(document?.height ?? 1) * gridSize) / 2,
      elevation: Number(document?.elevation ?? 0),
    };
  }

  const from = centerOf(fromToken);
  const to = centerOf(toToken);
  if (!from || !to) return null;

  try {
    const distance = Number(grid.measurePath([from, to], {})?.distance);
    return Number.isFinite(distance) && distance >= 0 ? distance : null;
  } catch {
    return null;
  }
}

export function isTokenWithinDistanceWithFoundry(
  runtime: any,
  fromToken: any,
  toToken: any,
  maxDistance: number,
): boolean | null {
  if (!fromToken || !toToken || !Number.isFinite(maxDistance) || maxDistance < 0) return null;

  const midi = runtime?.MidiQOL;
  if (typeof midi?.checkDistance === "function") {
    try {
      const result = midi.checkDistance(fromToken, toToken, maxDistance, {
        wallsBlock: false,
        includeCover: false,
      });
      if (typeof result === "boolean") return result;
    } catch {
      // Fall through to the shared Foundry distance adapter.
    }
  }

  const distance = measureTokenDistanceWithFoundry(runtime, fromToken, toToken);
  return distance === null ? null : distance <= maxDistance;
}

export function checkActivityTargetRangeWithFoundry(
  runtime: any,
  activity: any,
  sourceToken: any,
  targetTokens: any[],
): FoundryActivityRangeCheck {
  const checkActivityRange = runtime?.MidiQOL?.checkActivityRange;
  if (typeof checkActivityRange !== "function") return "unavailable";

  try {
    const result = checkActivityRange(activity, sourceToken, new Set(targetTokens), false)?.result;
    if (result === "fail") return "invalid";
    if (result === "normal" || result === "dis") return "valid";
  } catch {
    // Let the caller use the lower-level Foundry distance adapter as a fallback.
  }
  return "unavailable";
}

export function parseActivitySelectionConstraintsV2(
  interaction: any,
): {
  constraints: Array<
    | { type: "pairwise-within-distance"; maximum: number; units: "ft" }
    | { type: "artifact-exists"; artifactId: string; subject: string }
  >;
  problem: string | null;
} {
  const rawConstraints = interaction?.selectionConstraints;
  if (rawConstraints === undefined) {
    return { constraints: [], problem: null };
  }
  if (!Array.isArray(rawConstraints)) {
    return {
      constraints: [],
      problem: "interaction-selection-constraints-invalid",
    };
  }

  const constraints: Array<
    | { type: "pairwise-within-distance"; maximum: number; units: "ft" }
    | { type: "artifact-exists"; artifactId: string; subject: string }
  > = [];
  for (const rawConstraint of rawConstraints) {
    if (
      !rawConstraint
      || typeof rawConstraint !== "object"
      || Array.isArray(rawConstraint)
    ) {
      return {
        constraints: [],
        problem: "interaction-selection-constraint-invalid",
      };
    }
    const constraintType = String(rawConstraint.type ?? "").trim();
    if (constraintType === "artifact-exists") {
      const artifactId = String(rawConstraint.artifactId ?? "").trim();
      const subject = String(rawConstraint.subject ?? "").trim();
      if (!artifactId) {
        return {
          constraints: [],
          problem: "interaction-selection-constraint-artifact-id-invalid",
        };
      }
      if (subject !== "target") {
        return {
          constraints: [],
          problem: "interaction-selection-constraint-subject-unsupported",
        };
      }
      constraints.push({
        type: "artifact-exists",
        artifactId,
        subject,
      });
      continue;
    }
    if (constraintType !== "pairwise-within-distance") {
      return {
        constraints: [],
        problem: "interaction-selection-constraint-type-unsupported",
      };
    }
    if (
      typeof rawConstraint.maximum !== "number"
      || !Number.isFinite(rawConstraint.maximum)
      || rawConstraint.maximum <= 0
    ) {
      return {
        constraints: [],
        problem: "interaction-selection-constraint-maximum-invalid",
      };
    }
    if (String(rawConstraint.units ?? "").trim() !== "ft") {
      return {
        constraints: [],
        problem: "interaction-selection-constraint-units-invalid",
      };
    }
    constraints.push({
      type: "pairwise-within-distance",
      maximum: rawConstraint.maximum,
      units: "ft",
    });
  }
  return { constraints, problem: null };
}

export function effectiveActivityActivationTypeV2(item: any, activity: any): string {
  const itemType = String(item?.system?.activation?.type ?? "").trim();
  const activityActivation = activity?.activation ?? {};
  const rawActivityActivation = activity?._source?.activation ?? {};
  const activityType =
    String(activityActivation?.type ?? "").trim()
    || String(rawActivityActivation?.type ?? "").trim();
  const overrides =
    activityActivation?.override === true
    || rawActivityActivation?.override === true;
  return overrides ? (activityType || itemType) : (itemType || activityType);
}

export function parseIndependentProjectilesContractV2(
  interaction: any,
): {
  resolution: {
    type: "independent-projectiles";
    count: Record<string, any>;
    allocation: "optional-explicit";
    defaultTarget: "concentrate";
    inputPath: "input.allocation";
  } | null;
  problem: string | null;
} {
  const raw = interaction?.resolution;
  if (raw === undefined) return { resolution: null, problem: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { resolution: null, problem: "interaction-resolution-invalid" };
  }
  const expectedKeys = [
    "allocation",
    "count",
    "defaultTarget",
    "type",
  ];
  if (raw.primitive !== undefined) expectedKeys.push("primitive");
  if (
    Object.keys(raw).sort().join(",") !== expectedKeys.sort().join(",")
    || (
      raw.primitive !== undefined
      && raw.primitive !== "action-resolution"
    )
    || raw.type !== "independent-projectiles"
    || raw.allocation !== "optional-explicit"
    || raw.defaultTarget !== "concentrate"
  ) {
    return {
      resolution: null,
      problem: "interaction-resolution-shape-invalid",
    };
  }

  function validExpression(value: any): boolean {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
    ) return false;
    const keysByType: Record<string, string[]> = {
      constant: ["type", "value"],
      add: ["terms", "type"],
      multiply: ["factors", "type"],
      "cast-level": ["type"],
      "levels-above-base": ["type"],
      "per-slot-above-base": ["base", "increment", "type"],
      "cantrip-progression": ["base", "increment", "type"],
      tiers: ["entries", "selector", "type"],
      "round-down": ["type", "value"],
    };
    const expected = keysByType[String(value.type ?? "")];
    if (
      !expected
      || (
        value.primitive !== undefined
        && value.primitive !== "value-expression"
      )
      || Object.keys(value).sort().join(",") !== [
        ...expected,
        ...(value.primitive !== undefined ? ["primitive"] : []),
      ].sort().join(",")
    ) {
      return false;
    }
    if (value.type === "constant") {
      return typeof value.value === "number" && Number.isFinite(value.value);
    }
    if (["cast-level", "levels-above-base"].includes(value.type)) return true;
    if (value.type === "add") {
      return Array.isArray(value.terms)
        && value.terms.length >= 2
        && value.terms.every(validExpression);
    }
    if (value.type === "multiply") {
      return Array.isArray(value.factors)
        && value.factors.length >= 2
        && value.factors.every(validExpression);
    }
    if (["per-slot-above-base", "cantrip-progression"].includes(value.type)) {
      return validExpression(value.base) && validExpression(value.increment);
    }
    if (value.type === "round-down") return validExpression(value.value);
    if (value.type === "tiers") {
      return validExpression(value.selector)
        && Array.isArray(value.entries)
        && value.entries.length > 0
        && value.entries.every((entry: any) =>
          entry
          && typeof entry === "object"
          && !Array.isArray(entry)
          && Object.keys(entry).sort().join(",") === "minimum,value"
          && Number.isInteger(entry.minimum)
          && entry.minimum >= 0
          && validExpression(entry.value)
        );
    }
    return false;
  }

  if (!validExpression(raw.count)) {
    return {
      resolution: null,
      problem: "interaction-resolution-count-invalid",
    };
  }
  return {
    resolution: {
      type: "independent-projectiles",
      count: raw.count,
      allocation: "optional-explicit",
      defaultTarget: "concentrate",
      inputPath: "input.allocation",
    },
    problem: null,
  };
}

export function resolveIndependentProjectileCountV2(
  item: any,
  inputContract: Record<string, any>,
  requestedSpellLevel?: unknown,
): number | null {
  const resolution = inputContract?.resolution;
  if (resolution?.type !== "independent-projectiles") return null;
  const baseLevel = Math.max(0, Number(item?.system?.level ?? 0) || 0);
  const explicitLevel = Number(requestedSpellLevel);
  const castLevel =
    requestedSpellLevel !== undefined && Number.isInteger(explicitLevel)
      ? explicitLevel
      : baseLevel;

  function valueOf(expression: any): number {
    if (expression.type === "constant") return Number(expression.value);
    if (expression.type === "add") {
      return expression.terms.reduce(
        (total: number, term: any) => total + valueOf(term),
        0,
      );
    }
    if (expression.type === "multiply") {
      return expression.factors.reduce(
        (total: number, factor: any) => total * valueOf(factor),
        1,
      );
    }
    if (expression.type === "cast-level") return castLevel;
    if (expression.type === "levels-above-base") {
      return Math.max(0, castLevel - baseLevel);
    }
    if (expression.type === "round-down") {
      return Math.floor(valueOf(expression.value));
    }
    if (expression.type === "per-slot-above-base") {
      return valueOf(expression.base)
        + Math.max(0, castLevel - baseLevel) * valueOf(expression.increment);
    }
    if (expression.type === "cantrip-progression") {
      const directIncrease = Number(item?.system?.scalingIncrease);
      let increase = Number.isFinite(directIncrease) && directIncrease >= 0
        ? directIncrease
        : Number.NaN;
      if (!Number.isFinite(increase)) {
        const cantripLevel = Number(
          item?.actor?.system?.cantripLevel?.(item)
          ?? item?.parent?.system?.cantripLevel?.(item),
        );
        increase = Number.isFinite(cantripLevel) && cantripLevel >= 0
          ? Math.floor((cantripLevel + 1) / 6)
          : 0;
      }
      return valueOf(expression.base) + increase * valueOf(expression.increment);
    }
    if (expression.type === "tiers") {
      const selector = valueOf(expression.selector);
      const entry = [...expression.entries]
        .sort((left, right) => Number(right.minimum) - Number(left.minimum))
        .find(candidate => selector >= Number(candidate.minimum));
      if (!entry) throw new Error("Projectile count tiers have no matching entry");
      return valueOf(entry.value);
    }
    throw new Error(
      "Unsupported independent-projectiles count expression: "
        + String(expression?.type ?? "unknown"),
    );
  }

  const count = valueOf(resolution.count);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("Independent projectile count must resolve to a positive integer");
  }
  return count;
}

export function resolveIndependentProjectileAllocationV2(
  item: any,
  inputContract: Record<string, any>,
  targetTokenIds: unknown,
  allocation: unknown,
  requestedSpellLevel?: unknown,
): {
  expectedCount: number;
  allocation: Array<{ targetTokenId: string; count: number }>;
  sequence: string[];
  primaryTargetId: string;
} | null {
  const resolution = inputContract?.resolution;
  if (resolution?.type !== "independent-projectiles") {
    if (allocation !== undefined) {
      throw new Error("input.allocation is only valid for independent-projectiles actions");
    }
    return null;
  }
  const ids = (Array.isArray(targetTokenIds) ? targetTokenIds : [])
    .map(String)
    .filter(Boolean);
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== ids.length) {
    throw new Error("targetTokenIds must not contain duplicates");
  }
  const expectedCount = resolveIndependentProjectileCountV2(
    item,
    inputContract,
    requestedSpellLevel,
  );
  if (expectedCount === null) {
    throw new Error("Independent projectile count is unavailable");
  }

  if (allocation === undefined) {
    if (ids.length !== 1) {
      throw new Error(
        "Independent projectiles require exactly one target unless DM explicitly declares input.allocation",
      );
    }
    const primaryTargetId = ids[0]!;
    return {
      expectedCount,
      allocation: [{ targetTokenId: primaryTargetId, count: expectedCount }],
      sequence: Array.from({ length: expectedCount }, () => primaryTargetId),
      primaryTargetId,
    };
  }
  if (!Array.isArray(allocation) || allocation.length === 0) {
    throw new Error("input.allocation must be a non-empty array");
  }
  const normalized = allocation.map((entry: any, index: number) => {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "count,targetTokenId"
    ) {
      throw new Error(`input.allocation[${index}] must contain targetTokenId and count`);
    }
    const targetTokenId = String(entry.targetTokenId ?? "").trim();
    if (!targetTokenId) {
      throw new Error(`input.allocation[${index}].targetTokenId is required`);
    }
    if (!Number.isInteger(entry.count) || entry.count <= 0) {
      throw new Error(`input.allocation[${index}].count must be a positive integer`);
    }
    return { targetTokenId, count: Number(entry.count) };
  });
  const allocatedIds = normalized.map(entry => entry.targetTokenId);
  if (new Set(allocatedIds).size !== allocatedIds.length) {
    throw new Error("input.allocation must list each target exactly once");
  }
  const allocatedCount = normalized.reduce((sum, entry) => sum + entry.count, 0);
  if (allocatedCount !== expectedCount) {
    throw new Error(
      `input.allocation assigns ${allocatedCount} projectiles; expected ${expectedCount}`,
    );
  }
  if (
    [...allocatedIds].sort().join(",") !== [...ids].sort().join(",")
  ) {
    throw new Error(
      "input.allocation targets must exactly match targetTokenIds",
    );
  }
  const sequence = normalized.flatMap(entry =>
    Array.from({ length: entry.count }, () => entry.targetTokenId)
  );
  return {
    expectedCount,
    allocation: normalized,
    sequence,
    primaryTargetId: sequence[0]!,
  };
}

export type NativeSummonLifecycleV2 =
  | { mode: "concentration" | "root-concentration"; effectUuid: string }
  | { mode: "dm-duration" | "native"; effectUuid: null };

export function resolveNativeSummonLifecycleV2(
  value: any,
): NativeSummonLifecycleV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    JSON.stringify(Object.keys(value).sort())
    !== JSON.stringify(["effectUuid", "mode"])
  ) return null;
  if (value.mode === "concentration" || value.mode === "root-concentration") {
    if (
      typeof value.effectUuid !== "string"
      || !value.effectUuid.trim()
      || value.effectUuid !== value.effectUuid.trim()
    ) return null;
    return { mode: value.mode, effectUuid: value.effectUuid };
  }
  if (
    (value.mode === "dm-duration" || value.mode === "native")
    && value.effectUuid === null
  ) {
    return { mode: value.mode, effectUuid: null };
  }
  return null;
}

export function resolveNativeSummonActivityV2(activity: any): Record<string, any> | null {
  if (String(activity?.type ?? "").trim() !== "summon") return null;
  const marker = activity?.flags?.["arcane-dnd5e-2014-automation"]?.nativeSummon;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const expectedKeys = [
    "artifactId", "choice", "cleanup", "documentId", "expectedCount",
    "humanStep", "profileId", "provider", "revision", "uniqueness",
  ];
  if (
    JSON.stringify(Object.keys(marker).sort())
    !== JSON.stringify(expectedKeys)
    || marker.provider !== "dnd5e"
    || marker.humanStep !== "native-summon-placement"
    || !String(marker.artifactId ?? "").trim()
    || !String(marker.choice ?? "").trim()
    || !["concentration-effect", "dm-duration", "root-concentration"]
      .includes(String(marker.cleanup ?? "").trim())
    || !String(marker.documentId ?? "").trim()
    || !String(marker.profileId ?? "").trim()
    || !Number.isInteger(marker.revision)
    || marker.revision <= 0
    || ![1, 2].includes(marker.expectedCount)
  ) return null;
  if (marker.uniqueness !== null) {
    if (
      !marker.uniqueness
      || typeof marker.uniqueness !== "object"
      || Array.isArray(marker.uniqueness)
      || JSON.stringify(Object.keys(marker.uniqueness).sort())
        !== JSON.stringify(["enforcement", "maximum", "scope"])
      || !["source-actor-item", "root-invocation"]
        .includes(String(marker.uniqueness.scope ?? ""))
      || marker.uniqueness.maximum !== 1
      || !["replace-after-create", "pre-use-reject"]
        .includes(String(marker.uniqueness.enforcement ?? ""))
    ) return null;
  }
  const rawProfiles = activity?.profiles;
  const profiles = !rawProfiles
    ? []
    : typeof rawProfiles.values === "function"
      ? Array.from(rawProfiles.values())
      : Array.isArray(rawProfiles)
        ? rawProfiles
        : Object.values(rawProfiles);
  if (profiles.length !== 1) return null;
  const profile: any = profiles[0];
  const nativeProfileId = String(profile?._id ?? profile?.id ?? "").trim();
  const profileUuid = String(profile?.uuid ?? "").trim();
  const count = Number(profile?.count);
  if (
    !nativeProfileId
    || profileUuid
      !== `Compendium.arcane-dnd5e-2014-automation.summons.Actor.${marker.documentId}`
    || !Number.isInteger(count)
    || count !== marker.expectedCount
  ) return null;
  return {
    nativeProfileId,
    profileUuid,
    expectedCount: count,
    profileId: String(marker.profileId).trim(),
    marker: JSON.parse(JSON.stringify(marker)),
  };
}

export function deriveActivityInputContract(item: any, activity: any): Record<string, any> {
  function text(value: unknown): string {
    return String(value ?? "").trim();
  }

  const itemTarget = item?.system?.target ?? {};
  const activityTarget = activity?.target ?? {};
  const rawItemTarget = item?._source?.system?.target ?? itemTarget;
  const rawActivityTarget = activity?._source?.target ?? activityTarget;
  const activityOverridesTarget =
    activityTarget?.override === true || rawActivityTarget?.override === true;
  const target = activityOverridesTarget ? activityTarget : itemTarget;
  const rawTarget = activityOverridesTarget ? rawActivityTarget : rawItemTarget;
  const itemRange = item?.system?.range ?? {};
  const activityRange = activity?.range ?? {};
  const range = activityRange?.override === true ? activityRange : itemRange;
  const template = target?.template ?? {};
  const affects = target?.affects ?? {};
  const rawAffectsCount = rawTarget?.affects?.count;
  const rawAffectsCountText =
    typeof rawAffectsCount === "string" ? rawAffectsCount.trim() : "";
  const affectsCountFormula =
    rawAffectsCountText && !Number.isFinite(Number(rawAffectsCountText))
      ? rawAffectsCountText
      : null;
  const templateType = text(template?.type);
  const affectsType = text(affects?.type);
  const activityType = text(activity?.type);
  const rangeUnits = text(range?.units);
  const declaredInteraction =
    activity?.flags?.["arcane-dnd5e-2014-automation"]?.interaction ?? null;
  const declaredChoiceDefault =
    activity?.flags?.["arcane-dnd5e-2014-automation"]?.choiceDefault ?? null;
  const parsedResolution =
    parseIndependentProjectilesContractV2(declaredInteraction);
  const nativeSummon = resolveNativeSummonActivityV2(activity);

  let runtimeTargeting = "unsupported";
  let source = "dnd5e-target";
  if (templateType) {
    runtimeTargeting = "template";
  } else if (affectsType === "self") {
    runtimeTargeting = "self";
  } else if (["creature", "ally", "enemy", "token"].includes(affectsType)) {
    runtimeTargeting = "tokens";
  } else if (["space", "object", "item", "none"].includes(affectsType)) {
    // These require a different wire input than token IDs. Keep them internal
    // until the public protocol deliberately gains such an input type.
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
    // Midi-QOL auto-places self emanations only for radius/squareRadius.
    // Other self-range shapes still need a human to choose their direction or
    // confirm their point on the canvas.
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

  const inferredMode =
    nativeSummon
      ? "self"
      : runtimeTargeting === "tokens"
      ? "selected-targets"
      : runtimeTargeting === "template"
        ? placement === "self" ? "self" : "placed-template"
        : runtimeTargeting;
  const declaredMode = text(declaredInteraction?.input);
  const allowedModes = ["selected-targets", "placed-template", "self"];
  const hasValidDeclaration =
    !!declaredInteraction
    && typeof declaredInteraction === "object"
    && !Array.isArray(declaredInteraction)
    && Number(declaredInteraction.version ?? 0) >= 1
    && allowedModes.includes(declaredMode);
  const mode = nativeSummon
    ? "self"
    : hasValidDeclaration ? declaredMode : inferredMode;
  const supported = allowedModes.includes(mode);
  const parsedSelectionConstraints = !nativeSummon && hasValidDeclaration
    ? parseActivitySelectionConstraintsV2(declaredInteraction)
    : { constraints: [], problem: null };
  const requiredSelections = !nativeSummon && hasValidDeclaration
    && Array.isArray(declaredInteraction?.requiredSelections)
    ? declaredInteraction.requiredSelections
        .filter((selection: any) =>
          selection
          && typeof selection === "object"
          && !Array.isArray(selection)
          && text(selection.id)
          && selection.type === "enum"
          && selection.required === true
          && Array.isArray(selection.values)
          && selection.values.length > 0
          && selection.values.every((entry: any) =>
            entry
            && typeof entry === "object"
            && !Array.isArray(entry)
            && text(entry.value)
          )
        )
        .map((selection: any) => ({
          id: text(selection.id),
          type: "enum",
          required: true,
          values: selection.values.map((entry: any) => ({
            value: text(entry.value),
            label: text(entry.label) || text(entry.value),
          })),
        }))
    : [];
  const hasValidChoiceDefault =
    !nativeSummon
    && mode === "selected-targets"
    && !!declaredChoiceDefault
    && typeof declaredChoiceDefault === "object"
    && !Array.isArray(declaredChoiceDefault)
    && declaredChoiceDefault.cardinality === "any"
    && ["same-disposition-all", "opposing-disposition-all"].includes(
      text(declaredChoiceDefault.targetPolicy),
    );

  return {
    version: 2,
    mode,
    source: nativeSummon
      ? "arcane-native-summon"
      : hasValidDeclaration ? "arcane-override" : source,
    supported,
    execution: nativeSummon || mode === "placed-template"
      ? "wait-for-human"
      : supported ? "immediate" : "not-implemented",
    ...(nativeSummon
      ? { humanStep: "native-summon-placement" }
      : {}),
    required: [
      ...(mode === "selected-targets" && !hasValidChoiceDefault
        ? ["targetTokenIds"]
        : []),
      ...requiredSelections.map((selection: any) =>
        `input.selections.${selection.id}`
      ),
    ],
    optional: [
      ...(activityType === "attack" ? ["input.attackRollMode"] : []),
      ...(parsedResolution.resolution
        ? [parsedResolution.resolution.inputPath]
        : []),
    ],
    selections: requiredSelections,
    resolution: parsedResolution.problem
      ? null
      : parsedResolution.resolution,
    selectionConstraints: parsedSelectionConstraints.problem
      ? []
      : parsedSelectionConstraints.constraints,
    choiceDefault: hasValidChoiceDefault
      ? {
          cardinality: "any",
          polarity: text(declaredChoiceDefault.polarity),
          targetPolicy: text(declaredChoiceDefault.targetPolicy),
          timing: text(declaredChoiceDefault.timing) || "cast",
          includeSelf: declaredChoiceDefault.includeSelf === true,
          requiresSourceCanSeeTarget: declaredChoiceDefault.requiresSourceCanSeeTarget === true,
          requiresTargetCanSeeSource: declaredChoiceDefault.requiresTargetCanSeeSource === true,
        }
      : null,
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

export function resolveRequiredSelectionsForContract(
  useArgs: Record<string, any>,
  inputContract: Record<string, any>
): Record<string, string> {
  const definitions = Array.isArray(inputContract?.selections)
    ? inputContract.selections
    : [];
  const provided = useArgs?.selections;
  if (
    provided !== undefined
    && (
      !provided
      || typeof provided !== "object"
      || Array.isArray(provided)
    )
  ) {
    throw new Error("selections must be an object");
  }
  const values = provided ?? {};
  const known = new Set(definitions.map((definition: any) =>
    String(definition?.id ?? "")
  ));
  const unknown = Object.keys(values).filter(key => !known.has(key));
  if (unknown.length > 0) {
    throw new Error("Unknown selections: " + unknown.join(", "));
  }
  const resolved: Record<string, string> = {};
  for (const definition of definitions) {
    const id = String(definition?.id ?? "");
    const value = values[id];
    if (definition?.required === true && typeof value !== "string") {
      throw new Error("Missing required selection input.selections." + id);
    }
    if (value === undefined) continue;
    const allowed = Array.isArray(definition?.values)
      ? definition.values.map((entry: any) => String(entry?.value ?? ""))
      : [];
    if (!allowed.includes(value)) {
      throw new Error(
        "Invalid selection input.selections." + id + ": " + String(value)
      );
    }
    resolved[id] = value;
  }
  return resolved;
}

export function resolveActivityTargetCountLimit(
  item: any,
  inputContract: Record<string, any>,
  requestedSpellLevel?: unknown,
): number | null {
  function positiveFinite(value: unknown): number | null {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  const preparedCount = positiveFinite(inputContract?.target?.count);
  const formula = String(inputContract?.target?.countFormula ?? "").trim();
  if (!formula) return preparedCount;

  const baseLevel = Number(item?.system?.level);
  const explicitLevel = Number(requestedSpellLevel);
  const itemLevel =
    requestedSpellLevel !== undefined && Number.isInteger(explicitLevel)
      ? explicitLevel
      : baseLevel;
  if (!Number.isInteger(itemLevel) || itemLevel < 0) return preparedCount;

  const expression = formula.replace(/@item\.level\b/g, String(itemLevel)).replace(/\s+/g, "");
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
  if (!expression || tokens.join("") !== expression) return preparedCount;

  let position = 0;
  function parsePrimary(): number {
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
  function parseUnary(): number {
    const token = tokens[position];
    if (token === "+" || token === "-") {
      position += 1;
      const value = parseUnary();
      return token === "-" ? -value : value;
    }
    return parsePrimary();
  }
  function parseProduct(): number {
    let value = parseUnary();
    while (tokens[position] === "*" || tokens[position] === "/") {
      const operator = tokens[position];
      position += 1;
      const right = parseUnary();
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  }
  function parseExpression(): number {
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
  if (position !== tokens.length || !Number.isFinite(resolved) || resolved <= 0) {
    return preparedCount;
  }
  return Math.floor(resolved);
}

export function resolveTargetSpecForContract(
  useArgs: Record<string, any>,
  inputContract: Record<string, any>
): Record<string, any> {
  function values(value: unknown): any[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  }

  const legacyTokenIds = values(useArgs?.targetTokenIds).map(String).filter(Boolean);
  const provided = useArgs?.targetSpec;
  if (provided !== undefined && (!provided || typeof provided !== "object" || Array.isArray(provided))) {
    throw new Error("targetSpec must be an object");
  }

  const contractMode = String(inputContract?.mode ?? "unknown");
  const hasSelfPlacedTemplate =
    !!inputContract?.template?.type && inputContract?.template?.placement === "self";
  const runtimeMode =
    contractMode === "selected-targets"
      ? "tokens"
      : contractMode === "placed-template" || (contractMode === "self" && hasSelfPlacedTemplate)
        ? "template"
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
  if (!targetSpec && runtimeMode === "tokens" && inputContract?.choiceDefault?.cardinality === "any") {
    targetSpec = {
      mode: "tokens",
      tokenIds: [],
      geometry: "default-choice",
      defaultPolicy: { ...inputContract.choiceDefault },
    };
  }
  if (!targetSpec) {
    throw new Error(
      "targetTokenIds are required for selected-targets actions"
    );
  }

  const requestedRawMode = String(targetSpec.mode ?? "").trim();
  const requestedMode = requestedRawMode === "selected-targets"
    ? "tokens"
    : requestedRawMode === "placed-template"
      ? "template"
      : requestedRawMode;
  const gmDeclaredTemplateTargets =
    contractMode === "placed-template" &&
    requestedMode === "tokens" &&
    targetSpec.geometry === "gm-declared";

  if (requestedMode !== runtimeMode && !gmDeclaredTemplateTargets) {
    throw new Error(
      "targetSpec.mode " + requestedRawMode + " does not match action inputContract.mode " + contractMode
    );
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
      throw new Error(
        "targetTokenIds are forbidden for template placement; use targetSpec.mode=template or an explicit geometry=gm-declared bypass"
      );
    }
    const placement = String(targetSpec.placement ?? inputContract?.template?.placement ?? "manual");
    if (!["manual", "self"].includes(placement)) {
      throw new Error("targetSpec.placement must be manual or self");
    }
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

  throw new Error(
    "CLI target mode " + requestedMode + " is not implemented; inspect inputContract before executing"
  );
}

export function buildActivityUseCreateOptions(
  targetResolution: Record<string, any>,
  nativeSummon: Record<string, any> | null = null,
  requestId: string | null = null,
): Record<string, any> {
  if (nativeSummon) {
    if (!requestId) throw new Error("native summon requestId is required");
    return {
      create: {
        measuredTemplate: false,
        summons: true,
      },
      summons: {
        profile: nativeSummon.nativeProfileId,
        arcaneNativeRequestId: requestId,
      },
    };
  }
  // Template activities already own their interactive placement through
  // activity.target.prompt. Forcing create.measuredTemplate at the same time
  // starts a second use workflow, creating two templates and spending twice.
  if (targetResolution?.mode === "template") return {};

  return {
    create: {
      measuredTemplate: false,
    },
  };
}

export function resolveNativeSpellSlotConsumption(
  item: any,
  activity: any,
  actor: any,
  spellcastingConfig: Record<string, any> | undefined,
  requestedSpellLevel?: unknown,
): Record<string, number | string> | null {
  const hasRequestedSpellLevel = requestedSpellLevel !== undefined;
  if (item?.type !== "spell" || !activity?.consumption?.spellSlot) {
    if (hasRequestedSpellLevel) {
      throw new Error("spellLevel is only valid for spell-slot-consuming spell activities");
    }
    return null;
  }
  const method = String(item?.system?.method ?? "").trim();
  const baseLevel = Number(item?.system?.level ?? 0);
  let level = baseLevel;
  if (hasRequestedSpellLevel) {
    if (typeof requestedSpellLevel !== "number"
      || !Number.isInteger(requestedSpellLevel)
      || requestedSpellLevel < 1
      || requestedSpellLevel > 9) {
      throw new Error("spellLevel must be an integer from 1 to 9");
    }
    if (method !== "spell") {
      throw new Error("spellLevel is only supported for ordinary spell slots");
    }
    if (!Number.isInteger(baseLevel) || baseLevel < 1 || requestedSpellLevel < baseLevel) {
      throw new Error(
        "spellLevel " + requestedSpellLevel
        + " cannot be lower than the spell's base level " + baseLevel,
      );
    }
    level = requestedSpellLevel;
  }
  const spellcasting = spellcastingConfig?.[method];
  const key = spellcasting?.getSpellSlotKey?.(level) ?? (method === "spell" ? `spell${level}` : method);
  const slot = actor?.system?.spells?.[key];
  if (!slot) {
    if (hasRequestedSpellLevel) {
      throw new Error("Spell slot " + key + " is not available on this actor");
    }
    return null;
  }
  return {
    key,
    value: Number(slot.value ?? 0),
    max: Number(slot.max ?? 0),
    level: Number(slot.level ?? level),
  };
}

export interface DeclaredRiderOptionV2 {
  id: string;
  name?: string;
  minSpellLevel?: number;
  consumes?: string;
  resource?: string;
  inputPath?: string;
  attackType?: string;
}

export interface ResolvedDeclaredRiderV2 {
  id: string;
  spellLevel?: number;
}

/**
 * Convert Arcane-owned Actor feature contracts into the same declared-rider
 * option shape used by spell riders. The declaration is authoritative: this
 * function deliberately does not infer weapon eligibility, advantage state,
 * nearby allies, or per-turn availability.
 *
 * Divine Smite predates the explicit `consumes` field, so its current
 * `{ id, consumesOn: "hit" }` contract receives one narrow compatibility
 * mapping until all generated packs carry the complete declaration.
 */
export function featureDeclaredRiderOptionsV2(
  items: unknown,
): DeclaredRiderOptionV2[] {
  const moduleId = "arcane-dnd5e-2014-automation";
  const values = Array.isArray(items) ? items : [];
  return values.flatMap((item: any) => {
    const declaration = item?.flags?.[moduleId]?.declaredRider;
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
      return [];
    }
    const id = String(
      declaration.id ?? declaration.identifier ?? item?.system?.identifier ?? "",
    ).trim();
    if (!id) return [];

    const declaredConsumes = String(declaration.consumes ?? "").trim();
    const explicitConsumes = declaredConsumes === "none" ? "" : declaredConsumes;
    const divineSmiteCompatibility = id === "divine-smite"
      && String(declaration.consumesOn ?? "").trim() === "hit";
    const consumes = explicitConsumes
      || (divineSmiteCompatibility ? "spell-slot-on-hit" : "");
    const rawMinimum = Number(declaration.minSpellLevel ?? 1);
    const minSpellLevel = Number.isInteger(rawMinimum) && rawMinimum >= 1
      ? rawMinimum
      : 1;
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

/**
 * Validate and normalize declared attack riders before any Foundry workflow
 * starts. Omitted spellLevel means the rider's base slot exactly; the CLI
 * never silently upcasts or clamps an explicit DM declaration.
 */
export function resolveDeclaredRiderRequestsV2(
  requests: unknown,
  options: DeclaredRiderOptionV2[],
  spellSlots: Record<string, any>,
): ResolvedDeclaredRiderV2[] {
  if (requests === undefined) return [];
  if (!Array.isArray(requests)) {
    throw new Error("input.declaredRiders must be an array");
  }
  const available = new Map(
    (Array.isArray(options) ? options : [])
      .filter(option => option && String(option.id ?? "").trim())
      .map(option => [String(option.id).trim(), option]),
  );
  const seen = new Set<string>();
  const seenConsumptionKinds = new Set<string>();
  const reservedSlots = new Map<string, number>();
  return requests.map((request: any) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Each input.declaredRiders entry must be an object");
    }
    const id = String(request.id ?? request.identifier ?? "").trim();
    if (!id) throw new Error("Each declared rider requires id");
    if (seen.has(id)) throw new Error("Duplicate declared rider " + id);
    seen.add(id);
    const option = available.get(id);
    if (!option) {
      throw new Error("Declared rider " + id + " is not available for this action");
    }
    const declaredConsumptionKind = String(option.consumes ?? "").trim();
    const consumptionKind = declaredConsumptionKind === "none"
      ? ""
      : declaredConsumptionKind;
    if (consumptionKind && seenConsumptionKinds.has(consumptionKind)) {
      throw new Error(
        "Only one declared rider consuming " + consumptionKind
        + " may be used with one attack",
      );
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
    if (
      typeof rawLevel !== "number"
      || !Number.isInteger(rawLevel)
      || rawLevel < 1
      || rawLevel > 9
    ) {
      throw new Error(
        "Declared rider " + id + " spellLevel must be an integer from 1 to 9",
      );
    }
    if (rawLevel < minimum) {
      throw new Error(
        "Declared rider " + id + " spellLevel " + rawLevel
        + " cannot be lower than " + minimum,
      );
    }
    const key = "spell" + rawLevel;
    const slot = spellSlots?.[key];
    const reserved = reservedSlots.get(key) ?? 0;
    if (!slot || Number(slot.value ?? 0) <= reserved) {
      throw new Error(
        "No " + key + " spell slots remain for declared rider " + id,
      );
    }
    reservedSlots.set(key, reserved + 1);
    return { id, spellLevel: rawLevel };
  });
}

/**
 * Declared spell riders share one bonus-action/concentration execution lane.
 * Validate the complete execute-turn plan before any workflow starts so two
 * individually valid actions cannot silently spend or resolve only one rider.
 */
export function validateDeclaredRiderPlanV2(
  riderGroups: ResolvedDeclaredRiderV2[][],
): void {
  const spellSlotRiders = (Array.isArray(riderGroups) ? riderGroups : [])
    .flatMap(group => Array.isArray(group) ? group : [])
    .filter(rider => rider?.spellLevel !== undefined);
  if (spellSlotRiders.length > 1) {
    throw new Error(
      "Only one spell-slot-on-hit declared rider may be used in one execute-turn",
    );
  }
}

// ---------------------------------------------------------------------------
// Turn Protocol v2: stable action IDs (pure, injectable into the browser
// runtime via .toString()). Keep these functions fully self-contained: no
// module-scope references, no imports.
// ---------------------------------------------------------------------------

/** FNV-1a 64-bit hash as 16 hex chars. Deterministic across Node and browser. */
export function fnv1a64Hex(value: unknown): string {
  const text = String(value ?? "");
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Hash material for a v2 action ID. Mode is reserved; currently "default". */
export function actionIdMaterialV2(
  actorUuid: unknown,
  itemId: unknown,
  activityId: unknown,
  mode?: unknown
): string {
  return ["action-v2", actorUuid ?? "", itemId ?? "", activityId ?? "", mode || "default"].join("\0");
}

/**
 * Stable opaque action ID. actorUuid must be token.actor.uuid so that
 * unlinked tokens (synthetic actors) of the same base actor get distinct IDs.
 */
export function actionIdV2(
  actorUuid: unknown,
  itemId: unknown,
  activityId: unknown,
  mode?: unknown
): string {
  return "a2_" + fnv1a64Hex(actionIdMaterialV2(actorUuid, itemId, activityId, mode));
}

export interface ActionCandidateV2 {
  actionId: string;
  itemId: string;
  activityId: string | null;
  item: any;
  activity: any;
}

/**
 * Enumerate (item, activity) candidates of an actor with their v2 action IDs.
 * Tolerates Foundry Collections (values()), arrays and plain objects.
 */
export function collectActionCandidatesV2(actor: any, mode?: unknown): ActionCandidateV2[] {
  const rawItems = actor?.items;
  const items = !rawItems
    ? []
    : typeof rawItems.values === "function"
      ? Array.from(rawItems.values())
      : Array.isArray(rawItems)
        ? rawItems
        : Object.values(rawItems);
  const actorUuid = actor?.uuid ?? "";
  const candidates: ActionCandidateV2[] = [];
  for (const item of items as any[]) {
    if (!item) continue;
    const rawActs = item?.system?.activities;
    const acts = !rawActs
      ? []
      : typeof rawActs.values === "function"
        ? Array.from(rawActs.values())
        : Array.isArray(rawActs)
          ? rawActs
          : Object.values(rawActs);
    for (const activity of acts as any[]) {
      if (!activity) continue;
      const activityId = activity?.id ?? activity?._id ?? null;
      candidates.push({
        actionId: actionIdV2(actorUuid, item.id, activityId, mode),
        itemId: item.id,
        activityId,
        item,
        activity,
      });
    }
  }
  return candidates;
}

/**
 * Relocate an action from the actor's current documents by recomputing
 * candidate IDs. Returns null when no candidate matches (ACTION_NOT_FOUND).
 */
export function locateActionByIdV2(actor: any, actionId: unknown, mode?: unknown): ActionCandidateV2 | null {
  const wanted = String(actionId ?? "");
  if (!wanted) return null;
  for (const candidate of collectActionCandidatesV2(actor, mode)) {
    if (candidate.actionId === wanted) return candidate;
  }
  return null;
}

/** Internal/over-time activities are automation building blocks, not agent actions. */
export function isAgentCallableActivityV2(activity: any): boolean {
  const type = String(activity?.type ?? "");
  const nativeSummon = type === "summon"
    && resolveNativeSummonActivityV2(activity) !== null;
  return (["attack", "save", "damage", "heal", "utility"].includes(type) || nativeSummon)
    && activity?.midiProperties?.automationOnly !== true
    && activity?.isOverTimeFlag !== true;
}

/** Public turn actions must also resolve to one of the three supported inputs. */
export function isAgentCallableActionV2(item: any, activity: any): boolean {
  return isAgentCallableActivityV2(activity)
    && deriveActivityInputContract(item, activity).supported === true;
}

/** Dynamic availability for follow-up activities such as Aura of Vitality. */
export function isActionAvailableV2(actor: any, activity: any): boolean {
  const availability =
    activity?.flags?.["arcane-dnd5e-2014-automation"]?.availability ?? {};
  const requiredIdentifier = String(availability.requiresEffectIdentifier ?? "").trim();
  const requiredArtifactId = String(availability.requiresArtifactId ?? "").trim();
  if (!requiredIdentifier && !requiredArtifactId) return true;
  const rawEffects = actor?.effects;
  const effects = !rawEffects
    ? []
    : typeof rawEffects.values === "function"
      ? Array.from(rawEffects.values())
      : Array.isArray(rawEffects)
        ? rawEffects
        : Object.values(rawEffects);
  return (effects as any[]).some(effect => {
    if (
      effect?.disabled === true
      || effect?.active === false
      || effect?.isSuppressed === true
    ) return false;
    const arcaneFlags =
      effect?.flags?.["arcane-dnd5e-2014-automation"] ?? {};
    const identifier = String(
      arcaneFlags.identifier ?? arcaneFlags.effectIdentifier ?? "",
    ).trim();
    const artifactIds = Array.isArray(arcaneFlags.compilerArtifactIds)
      ? arcaneFlags.compilerArtifactIds.map((value: unknown) => String(value))
      : [];
    return (!requiredIdentifier || identifier === requiredIdentifier)
      && (!requiredArtifactId || artifactIds.includes(requiredArtifactId));
  });
}

/** A structured ActiveEffect contract for actions the actor cannot currently use. */
export function actionBlockV2(
  actor: any,
  item: any,
  activity: any,
): {
  kind: "attack" | "spell" | "reaction" | "action";
  effectId: string | null;
  effectName: string | null;
} | null {
  const activationType = effectiveActivityActivationTypeV2(item, activity);
  const isSpell = item?.type === "spell";
  const isAttack = activity?.type === "attack";
  const isReaction = activationType === "reaction";
  const isAction = activationType === "action";
  if (!actor || (!isSpell && !isAttack && !isReaction && !isAction)) return null;
  const rawEffects = actor?.effects;
  const effects = !rawEffects
    ? []
    : typeof rawEffects.values === "function"
      ? Array.from(rawEffects.values())
      : Array.isArray(rawEffects)
        ? rawEffects
        : Object.values(rawEffects);
  for (const effect of effects as any[]) {
    if (
      effect?.disabled === true
      || effect?.active === false
      || effect?.isSuppressed === true
    ) continue;
    const rawKinds = effect?.flags?.["arcane-dnd5e-2014-automation"]?.blockedActionKinds;
    const kinds = rawKinds instanceof Set
      ? Array.from(rawKinds)
      : Array.isArray(rawKinds)
        ? rawKinds
        : [];
    const kind = isSpell && kinds.includes("spell")
      ? "spell"
      : isAttack && kinds.includes("attack")
        ? "attack"
        : isReaction && kinds.includes("reaction")
          ? "reaction"
          : isAction && kinds.includes("action")
            ? "action"
            : null;
    if (kind) {
      return {
        kind,
        effectId: effect?.id == null ? null : String(effect.id),
        effectName: effect?.name == null
          ? effect?.label == null ? null : String(effect.label)
          : String(effect.name),
      };
    }
  }
  return null;
}

/**
 * Data-consistency defense for the final public interaction contract.
 * Note: template data follows the override rule (activity overrides item),
 * but prompt is always read from the activity's own target block — dnd5e
 * honours activity-level prompt even when override is false.
 * Returns a problem code or null. Pure and injectable.
 */
export function actionConfigProblemV2(item: any, activity: any): string | null {
  const itemTarget = item?.system?.target ?? {};
  const activityTarget = activity?.target ?? {};
  const effectiveTarget = activityTarget?.override === true ? activityTarget : itemTarget;
  const interaction = activity?.flags?.["arcane-dnd5e-2014-automation"]?.interaction;
  const rawNativeSummon =
    activity?.flags?.["arcane-dnd5e-2014-automation"]?.nativeSummon;
  if (rawNativeSummon !== undefined) {
    if (!resolveNativeSummonActivityV2(activity)) {
      return "native-summon-contract-invalid";
    }
    if (
      activity?.summon?.prompt !== true
      || String(activity?.summon?.mode ?? "") !== ""
    ) {
      return "native-summon-placement-disabled";
    }
    if (interaction !== undefined && String(interaction?.input ?? "") !== "self") {
      return "native-summon-input-must-be-self";
    }
    return null;
  }
  if (interaction !== undefined) {
    if (!interaction || typeof interaction !== "object" || Array.isArray(interaction)) {
      return "interaction-contract-invalid";
    }
    if (![1, 2].includes(interaction.version)) {
      return "interaction-version-unsupported";
    }
    if (!["selected-targets", "self", "placed-template"].includes(String(interaction.input ?? ""))) {
      return "interaction-input-invalid";
    }
    const parsedSelectionConstraints =
      parseActivitySelectionConstraintsV2(interaction);
    if (parsedSelectionConstraints.problem) {
      return parsedSelectionConstraints.problem;
    }
    if (
      parsedSelectionConstraints.constraints.length > 0
      && interaction.input !== "selected-targets"
    ) {
      return "interaction-selection-constraints-require-selected-targets";
    }
    const parsedResolution =
      parseIndependentProjectilesContractV2(interaction);
    if (parsedResolution.problem) return parsedResolution.problem;
    if (
      interaction.version === 2
      && !parsedResolution.resolution
    ) {
      return "interaction-v2-resolution-required";
    }
    if (
      parsedResolution.resolution
      && (
        interaction.version !== 2
        || interaction.input !== "selected-targets"
      )
    ) {
      return "interaction-resolution-contract-invalid";
    }
  }

  const contract = deriveActivityInputContract(item, activity);
  if (contract.mode === "placed-template") {
    if (!effectiveTarget?.template?.type) return "placed-template-missing-template";
    if (activityTarget?.prompt !== true) return "template-prompt-disabled";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turn Protocol v2: public response serializer (pure, injectable).
// Maps internal execution facts to the slim public ExecuteTurnResponse.
// ---------------------------------------------------------------------------

export type RejectCodeV2 =
  | "ACTION_NOT_FOUND"
  | "ACTOR_NOT_ACTIVE"
  | "ACTION_BLOCKED"
  | "ACTION_MISCONFIGURED"
  | "INPUT_INVALID"
  | "BATTLE_NOT_ACTIVE";

export interface NativeSummonReceiptV2 {
  kind: "native-summon";
  humanStep: "native-summon-placement";
  outcome: "placed" | "partial-manual" | "skipped-manual";
  requestId: string;
  activityUuid: string;
  artifactId: string;
  choice: string;
  profileId: string;
  expectedCount: 1 | 2;
  placedCount: number;
  skippedCount: number;
  workflowUuid: string | null;
  messageUuid: string | null;
  members: Array<{
    memberIndex: number;
    tokenUuid: string;
    combatantUuid: string;
  }>;
  sourceCombatantUuid: string;
  inheritedInitiative: number;
  lifecycle: NativeSummonLifecycleV2;
  retry: false;
}

export type ExecuteTurnResponseV2 =
  | { status: "completed"; receipt?: NativeSummonReceiptV2 }
  | { status: "rejected"; code: RejectCodeV2; message?: string }
  | {
      status: "partial";
      completed: number;
      requested: number;
      advance: "not-requested" | "completed" | "not-completed";
      retry: false;
      message?: string;
    }
  | { status: "indeterminate"; retry: false };

export interface ActionFactV2 {
  actionId: string;
  /** true once the automation call was submitted (side effects possible). */
  started: boolean;
  /** true only when a reliable completion signal (workflow) was observed. */
  completed: boolean;
  /** error message when the action failed; null/undefined otherwise. */
  error?: string | null;
  /** Present only for one completed Arcane native SummonActivity. */
  receipt?: NativeSummonReceiptV2 | null;
}

export interface TurnExecutionFactsV2 {
  /** Set when schema-level validation failed before any action started. */
  rejectedCode?: RejectCodeV2 | null;
  /** Safe, pre-submit validation detail that tells the DM which input failed. */
  rejectedMessage?: string | null;
  actions: ActionFactV2[];
  advanceRequested: boolean;
  advanceStarted: boolean;
  advanceCompleted: boolean;
}

/**
 * Serialize internal execution facts into the public ExecuteTurnResponse.
 *
 * Rules (see turn-protocol-v2.md §7, §10.3):
 * - schema-level rejection before any action started -> rejected
 * - everything done (actions + advance) -> completed
 * - at least one action confirmed complete, request not fully done -> partial
 * - any started-but-unconfirmed action, or advance started-but-unconfirmed
 *   with nothing confirmed -> indeterminate
 * - partial and indeterminate never allow retry
 */
export function serializeTurnResponseV2(facts: TurnExecutionFactsV2): ExecuteTurnResponseV2 {
  const actions = facts?.actions ?? [];
  const requested = actions.length;
  const completedCount = actions.filter(action => action.completed).length;
  const anyStarted = actions.some(action => action.started);
  const unstartedError = actions.find(action =>
    !action.started
    && !action.completed
    && typeof action.error === "string"
    && action.error.trim()
    && action.error !== "not-attempted"
  )?.error?.trim();
  const advanceState = !facts?.advanceRequested
    ? "not-requested"
    : facts?.advanceCompleted
      ? "completed"
      : "not-completed";

  if (facts?.rejectedCode && !anyStarted && !facts?.advanceStarted) {
    const rejectedMessage = facts.rejectedMessage?.trim();
    return {
      status: "rejected",
      code: facts.rejectedCode,
      ...(rejectedMessage ? { message: rejectedMessage } : {}),
    };
  }

  const unconfirmedAction = actions.some(action => action.started && !action.completed);
  const unconfirmedAdvance = !!facts?.advanceRequested && !!facts?.advanceStarted && !facts?.advanceCompleted;

  if (completedCount === requested && !unconfirmedAction) {
    if (!facts?.advanceRequested || facts?.advanceCompleted) {
      const receipt = requested === 1 ? actions[0]?.receipt : null;
      return receipt
        ? { status: "completed", receipt }
        : { status: "completed" };
    }
    if (unconfirmedAdvance) {
      return { status: "indeterminate", retry: false };
    }
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

  if (unconfirmedAction || unconfirmedAdvance) {
    return { status: "indeterminate", retry: false };
  }

  // Nothing started and no schema rejection was recorded: treat as rejected
  // input (defensive fallback; callers should set rejectedCode explicitly).
  return {
    status: "rejected",
    code: facts?.rejectedCode ?? "INPUT_INVALID",
    ...(unstartedError ? { message: unstartedError } : {}),
  };
}
