---
name: fvtt-native-npc
description: Create or edit D&D 5e NPCs from a DM's description using current Foundry Document APIs. Read this for NPC ability scores, caster levels, spell imports and equipment, especially when combining compendium resources into a new NPC.
---

# Native NPC workflow

Validated on Foundry 13 / dnd5e 5.3.3. Check the actual system version; inspect affected fields if it differs.
Operate through browser_evaluate on the connected GM page. Use public Document APIs, await writes,
and keep temporary variables inside an async function so declarations do not collide between calls.

## Discover resources, then import them

Use foundry_content_search to locate world actors and compendium Actor/Item entries. Follow its schema:
documentType values are case-sensitive Actor, Item, Scene. Use returned references; do not invent IDs or paths.
Match the requested rules edition and inspect source metadata when uncertain. Labels may be translated;
after an empty search try a meaningful alternate language name, not many arbitrary query variations.

To understand available packs, read game.packs metadata: collection, title, documentName.
An index is cheaper than loading every document: await pack.getIndex(). Search several needed names in one
index read when they share a pack. Fetch only chosen documents with pack.getDocument(entryId), or
await fromUuid(exactUuid) using a reference returned by discovery. Batch independent reads in one script.
This connects search results to native writes; no particular world pack or resource is assumed here.

Import real Item data, including its activities, rather than recreating spell mechanics from memory:
take source.toObject(), remove the source _id, retain other data, set _stats.compendiumSource=source.uuid,
then await actor.createEmbeddedDocuments('Item', itemDataArray). For existing actors compare source UUIDs
before adding items. Do not change compendium documents. Do not call getDocuments() for an entire large
spell pack merely to find a few names.

## NPC data, not player advancement

Use Actor.create({name, type:'npc', system, ...}) or actor.update(patch). Check the exact target name
before creating. Existing actor edits should read relevant current data first and preserve unrelated content.
No player class, species or background Items are required merely to express an NPC's identity or caster level.
Copying a suitable source Actor is also valid; verify and adjust inherited capabilities to the requested scope.

Current fields:

- Ability scores: system.abilities.str/dex/con/int/wis/cha.value.
- Humanoid identity: system.details.type.value='humanoid'; subtype holds the intended ancestry text.
- HP: system.attributes.hp.value and max. AC: choose the intended calc and read derived ac.value;
  setting flat alone does not select the flat calculation mode.
- Caster ability: system.attributes.spellcasting. Caster level: system.attributes.spell.level.
- CR: system.details.cr. CR and caster level are independent. Do not raise CR just to mimic player
  proficiency. Read system.attributes.prof, not a guessed writable proficiency field.
- Standard NPC spellcasting derives slot maxima from caster level. Read system.spells.spellN.max;
  set the desired remaining value only after knowing that maximum. Source-template overrides may override
  this derivation; inspect override fields when inherited resources do not match. Class Items, if present,
  can also alter derived caster level. Do not add one just to repair a field-path mistake.

## Ready spells and equipment

For normal slot-based spells, the current fields are system.method='spell' and system.prepared (numeric:
0 unprepared, 1 prepared, 2 always prepared). Use the intended state and verify it persisted. The old
system.preparation={mode,prepared} object is not a reliable update path on this version.
Cantrips do not need preparation or slots. Do not replace the imported spell's activities to configure readiness.
Prepared data does not prove automation execution; do not claim a cast was tested unless it actually was.

Equipment imports use system.equipped and quantity. Inspect the source's weapon identifier/type and native
activities; do not infer success from its display name alone. NPC weapon proficient=null can use native default
proficiency, so inspect effective attack data rather than assuming null means untrained.

## Verify, then stop

Read actual derived NPC values and imported Item states after the writes: identity, ability scores, HP/AC,
caster level, CR/proficiency, slot maxima/remaining, spell levels and readiness, equipment and quantities.
Check that copied higher-level abilities or resource overrides were not accidentally retained.
Use a compact snapshot; a successful update response alone does not prove an unknown field took effect.
If a write is partial, timed out or uncertain, inspect its actual results before continuing; do not recreate
the actor or blindly replay a batch. No auto-pack changes or script patches to its behavior.
Report the values actually read, and any unresolved issue. Avoid lengthy build explanations not requested by DM.
