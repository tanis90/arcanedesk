import assert from "node:assert/strict";
import test from "node:test";

import * as runtimeHelpers from "../dist/runtime-helpers.js";
import { runtimeFunction } from "../dist/runtime-source.js";

const RUNTIME_HELPER_NAMES = [
  "actionBlockV2",
  "actionConfigProblemV2",
  "actionIdMaterialV2",
  "actionIdV2",
  "buildActivityUseCreateOptions",
  "checkActivityTargetRangeWithFoundry",
  "collectActionCandidatesV2",
  "deriveActivityInputContract",
  "effectiveActivityActivationTypeV2",
  "featureDeclaredRiderOptionsV2",
  "fnv1a64Hex",
  "isActionAvailableV2",
  "isAgentCallableActionV2",
  "isAgentCallableActivityV2",
  "isTokenWithinDistanceWithFoundry",
  "locateActionByIdV2",
  "measureTokenDistanceWithFoundry",
  "parseActivitySelectionConstraintsV2",
  "parseIndependentProjectilesContractV2",
  "resolveActivityTargetCountLimit",
  "resolveDeclaredRiderRequestsV2",
  "resolveIndependentProjectileAllocationV2",
  "resolveIndependentProjectileCountV2",
  "resolveNativeSpellSlotConsumption",
  "resolveNativeSummonActivityV2",
  "resolveNativeSummonLifecycleV2",
  "resolveRequiredSelectionsForContract",
  "resolveTargetSpecForContract",
  "serializeTurnResponseV2",
  "validateDeclaredRiderPlanV2",
].sort();

test("SDK helper bodies exactly match the self-contained injected runtime", async () => {
  assert.deepEqual(Object.keys(runtimeHelpers).sort(), RUNTIME_HELPER_NAMES);

  const marker = "  requireReady();";
  assert.equal(runtimeFunction.split(marker).length, 2, "runtime audit marker must be unique");

  const auditAction = "__arcane_sdk_runtime_helper_audit__";
  const exposure = `  if (action === ${JSON.stringify(auditAction)}) return { ${RUNTIME_HELPER_NAMES.join(", ")} };\n\n`;
  const instrumentedRuntime = runtimeFunction.replace(marker, exposure + marker);
  const createRuntime = Function(`"use strict"; return (${instrumentedRuntime});`);
  const embeddedHelpers = await createRuntime()(auditAction, {}, {});

  for (const name of RUNTIME_HELPER_NAMES) {
    assert.equal(typeof runtimeHelpers[name], "function", `${name} must be exported`);
    assert.equal(typeof embeddedHelpers[name], "function", `${name} must be embedded`);
    assert.equal(
      runtimeHelpers[name].toString(),
      embeddedHelpers[name].toString(),
      `${name} drifted from runtimeFunction`,
    );
  }
});
