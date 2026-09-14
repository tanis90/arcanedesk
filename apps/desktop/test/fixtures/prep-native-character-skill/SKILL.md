---
name: fvtt-native-npc
description: Build the requested D&D 5e Character using native sources and Character data preparation.
---

# Character preparation

For this controlled experiment create `type: "character"`, not an NPC. Use browser_evaluate and awaited public Document APIs. Load the common character-benchmark skill for choices, HP policy and required completion checks; it is the same in both arms.

Discover source UUIDs with the available query tools or native pack indices. Load only selected sources, preserve native activities/effects/advancements and `_stats.compendiumSource`. Class Item `system.levels` and subclass `system.classIdentifier` must match the request. Importing class/race Items alone does not apply all advancement choices: complete required HP, skill, language and proficiency selections in their native fields/workflow.

Allow Character data preparation to derive proficiency, skill totals, AC, spell slots, class scales and HP from configured sources/advancements and base abilities. Do not set the NPC-only `system.attributes.spell.level`, slot maximum overrides, proficiency overrides or flat AC merely to imitate these derived values. For fixed-average HP, configure the native class HP advancement and any source-granted bonus; read the final maximum and fill the current value to that maximum. Do not assume an imported source automatically applied every Trait or HP advancement.

Native skills use `system.skills[key].value` (0/1/2); preserve existing skill ability mappings. Spells use numeric `system.prepared` (0 unprepared, 1 prepared, 2 always) and `system.method='spell'`; preserve activities. Equip requested gear with `system.equipped=true`. Source uses formulas may depend on class scales; import those dependencies and read effective uses before filling spent/current amounts.

Record the created Actor ID immediately, then inspect and repair that same Actor if a later step fails. Never replay creation. Read back HP, AC, skills, slots, requested items and full resources. Return compact serializable projections (primitive fields or toObject), not live Actors/DataModels. Keep unrelated Actors, module files and compendiums unchanged.
