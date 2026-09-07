import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

/** @template {import("typebox").TProperties} P @param {P} properties */
const exact = properties => Type.Object(properties, { additionalProperties: false });
const ref = () => Type.String({ minLength: 1, maxLength: 256 });
const source = Type.Union([
  exact({ kind: Type.Literal("actor"), actorUuid: ref() }),
  exact({ kind: Type.Literal("token"), tokenUuid: ref() }),
  exact({ kind: Type.Literal("selected") }),
  exact({ kind: Type.Literal("name"), name: ref(), scope: Type.Union([Type.Literal("focus"), Type.Literal("actors")]) }),
]);
const textResult = data => ({ content: [{ type: /** @type {const} */ ("text"), text: JSON.stringify(data) }], details: data });

/** Definitions are mode-independent; activation belongs to the host's explicit allowlist. */
export function createFoundryTools(host) {
  return [
    defineTool({
      name: "foundry_static_context", label: "Static Context",
      description: "Read the full static manual once per combat or Scene: all focused Tokens and their complete supported abilities. During combat focus is its participants; otherwise every current Scene Token. Refresh only when the scope or capability structure changes.",
      parameters: exact({}),
      execute: async (_id, _params, signal) => textResult(await host.foundryServices().readStatic(signal)),
    }),
    defineTool({
      name: "foundry_play_context", label: "Play Context",
      description: "Read lightweight current HP, resources, conditions and available action IDs for the same focus as static context. Use turn before and after combat actions. Status instructions need no preliminary read. Operation view inspects a known receipt without retrying it.",
      parameters: Type.Union([
        exact({ view: Type.Optional(Type.Union([Type.Literal("scene"), Type.Literal("turn")])) }),
        exact({ view: Type.Literal("operation"), operationRef: ref() }),
      ]),
      execute: async (_id, params, signal) => textResult(await host.foundryServices().readPlay(params, signal)),
    }),
    defineTool({
      name: "foundry_conditions_set", label: "Set Conditions",
      description: "Set or remove named system conditions, including explicitly ending concentration. Supply active true/false, never toggle. Selected means the Tokens selected when the user submitted their message. Play targets must have a Token in the current focus; actor/actors selectors are prep-only. Source-managed effects are protected.",
      parameters: exact({
        targets: Type.Array(source, { minItems: 1, maxItems: 20 }),
        conditions: Type.Array(exact({ key: ref(), active: Type.Boolean() }), { minItems: 1, maxItems: 8 }),
      }),
      executionMode: "sequential",
      execute: async (id, params, signal) => {
        // Pin the consumed input before any approval wait; later steering cannot change this command.
        const binding = host.taskCoordinator().currentInputBinding();
        const approved = await host.maybeRequestApproval({ tool: "foundry_conditions_set",
          summary: params.conditions.map(value => `${value.key}=${value.active}`).join(", "), args: params });
        if (!approved) return textResult({ status: "rejected", code: "DECLINED", message: "DM declined; do not retry." });
        return textResult(await host.foundryServices().setConditions(params, binding, id, signal));
      },
    }),
  ];
}
