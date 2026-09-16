---
name: fvtt-native-npc
description: Create or edit D&D 5e NPCs from a DM's description using Foundry Document APIs, compendium templates, spells, features and equipment.
---

# NPC preparation recipe

Validated on Foundry 13 / dnd5e 5.3.3. Use browser_evaluate on the connected GM page.
Keep variables inside an awaited async function; use public Document APIs. If the system differs,
inspect only the affected fields. Do not modify compendiums, module files or auto-pack behavior.

## 1. Choose the base and discover the missing content

For a named creature, find a suitable Actor template with foundry_content_search. For a custom NPC,
choose reasonable unspecified values; this is not player class advancement. Identify explicit requirements
and their data checks, including identity separately from display name. Keep optional additions coherent
and proportionate to the request; do not turn a simple NPC request into a complete player build.

Search documentType is case-sensitive Actor, Item or Scene. Use returned references and the requested
rules edition. Do not invent pack IDs. For several items, discover the relevant packs first, then read
those pack indices once in a single script and match the whole list, including language alternatives:
`await Promise.all(packs.map(p => p.getIndex()))`. Return compact matches and unresolved names.
Only missing or ambiguous entries need another lookup. Avoid one search per optional spell after its
pack is known, and do not repeat search for an already resolved reference. Available pack metadata is
`game.packs`: collection, title, documentName. Never load an entire large pack with getDocuments().

## 2. Load sources, configure, write and verify in one script

Once references are known, use one awaited script for the dependent steps below. No model response is
needed between each native operation. This is not an atomic transaction: keep the created Actor UUID
and completed steps available if an operation fails. Stop dependent writes on failure; never replay creation.

- Load only selected sources with `await fromUuid(uuid)` or `await pack.getDocument(entryId)`.
- Check the exact target before creating. To copy an Actor, take `source.toObject()`, remove its top-level
  `_id` and stale folder, change the requested fields, and create it. **Keep its items, effects and other
  mechanics.** Do not empty the items array to make room for additions. For an existing Actor, preserve
  unrelated fields. Compare requested additions with existing source UUIDs/identifiers before adding.
- To import an Item, take `source.toObject()`, remove its `_id`, retain activities/effects/description,
  set `_stats.compendiumSource=source.uuid`, and configure intended preparation/equipment/resources.
  Import the resulting array with `actor.createEmbeddedDocuments('Item', dataArray)`.
- Before import, inspect formulas such as `system.uses.max` and activity consumption targets for references
  to class scales or other items absent from this NPC. Importing a feature's name does not resolve those
  dependencies. If source rules specify a standalone allowance, configure that allowance on this NPC's
  embedded Item and preserve recovery/consumption. Do not invent a class to satisfy an absent scale.
  If the allowance cannot be determined, report the unresolved dependency instead of claiming readiness.
- After creation/import, read effective values. Fill intended remaining resources from their derived
  maxima with an awaited update in the same script. Check `item.system.uses.max`, `.value`, `.spent`
  and recovery; a raw formula surviving storage does not prove usable charges.

## Native field reference

Use Actor.create({name,type:'npc',system,...}) or actor.update(patch). Unknown keys can be silently ignored.

| Requirement | Native data and read-back |
| --- | --- |
| Abilities | `system.abilities.str/dex/con/int/wis/cha.value` |
| Humanoid identity | `system.details.type.value='humanoid'`, ancestry in `system.details.type.subtype` |
| HP and AC | `system.attributes.hp.value/max`; choose `ac.calc`, then read derived `ac.value` |
| Caster | `system.attributes.spellcasting`; level in `system.attributes.spell.level` |
| Proficiency | Read `system.attributes.prof`; derived from `system.details.cr`. Caster level is independent of CR; don't try to write proficiency or raise CR to imitate a PC. |
| Slots | Read `system.spells.spellN.max`; set `.value` to intended remaining amount. Inherited `.override` or class Items may alter derivation; inspect and adjust inherited resources to the requested level. |
| Spells | Preserve actual spell activities; `system.method='spell'`, numeric `system.prepared` (0 unprepared, 1 prepared, 2 always). Old `system.preparation` is not the current path. Cantrips need no slots/preparation. |
| Equipment | `system.quantity`, `system.equipped` when requested. Preserve native weapon activities. NPC `proficient=null` can mean native default; inspect effective data if relevant. |
| Item charges | Configure `system.uses.max` formula and `.spent`, preserve `.recovery`; verify effective `.max` and `.value` on the embedded Item. |

## Native API examples: use actual field types

These fragments belong inside the execution script above. Variables come from the DM's request and
resolved sources; they are not another input schema. Only apply the parts relevant to the NPC.

```js
// actor is the exact new/target NPC. Values were chosen from the request.
await actor.update({
  'system.attributes.spellcasting': castingAbility, // scalar 'int', 'wis' or 'cha', NOT an object
  'system.attributes.spell.level': casterLevel,
});
const casterCheck = actor.system.attributes.spellcasting === castingAbility
  && actor.system.attributes.spell.level === casterLevel;
// Neither details.spellLevel nor attributes.spellcasting.level is this API.

// Source data is native Item data, preserving actual activities and effects.
const data = spellSource.toObject();
delete data._id;
data._stats = { ...data._stats, compendiumSource: spellSource.uuid };
if (data.system.level > 0) {
  data.system.method = 'spell';
  data.system.prepared = 1; // numeric field, not system.preparation.prepared
}
const [spell] = await actor.createEmbeddedDocuments('Item', [data]);
const spellCheck = spell.system.level === 0
  || (spell.system.method === 'spell' && spell.system.prepared === 1);
// In the full task, build one data array and import all selected items together.
```

A false check is an unresolved requirement. Inspect the actual scalar/number before another patch;
do not repeatedly update invented nested fields or verify them instead of the current fields.

## 3. Return evidence, then stop

Return compact actual checks for the DM's requirements, source-mechanic preservation and resource readiness,
plus the Actor UUID and mismatches. Use assertions against effective fields, not names alone. Avoid another
read call if this script already checked the result. If the task is partial or uncertain, report exactly what
exists; inspect before any retry. Do not claim automation execution was tested from data checks alone.
Keep the final answer concise. No automatic concentration, initiative, rest or profession-action mechanisms
are required merely to configure an NPC.
