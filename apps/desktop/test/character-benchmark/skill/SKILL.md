---
name: character-benchmark
description: Shared defaults and scope for the six 2014 class-building benchmark tasks.
---

# Six-case class building defaults

These project defaults take precedence over the older minimal NPC guide. A cases create `character` Actors so dnd5e can derive player-character fields; B cases retain the supplied monster Actor type for extension tests. Use 2014 sources. Query sources in batches, include subclass progression, and preserve actual spell/weapon activities. Both experiment arms receive these same defaults.

For a new character: standard array 15/14/13/12/10/8 plus race and ordinary ASI, no feats. Human is nonvariant; dwarf is hill dwarf; unspecified wizard subclass is evocation. Explicit ability values are final. Choose legal class skills/languages and required choices, without asking DM. First class HD is full; later levels use PC fixed HP plus CON; hill dwarf adds HP per level. Full health/resources. Use one legal starting equipment combination, prioritizing the requested weapon. No background, portrait search or Tokens.

Wizard: complete the spellbook to the rules-correct total for its level, with level-appropriate cantrips and spell levels; Fireball must be among the granted spells. This NPC task does not require reconstructing the exact level-by-level acquisition history or limiting how many of those spells share the highest allowed level. Cleric and other prepared casters (druid, paladin, artificer): they "know" their entire class spell list — grant every class spell up to the highest available slot level (cantrips stay a level-appropriate choice), then leave preparation to the DM and players. Spell preparation is a sheet marker, not a casting gate: grant with compendium defaults and do not set `system.prepared`. Do not add every spell in a choice pool. Do not give higher-level spells or slot overrides to match a guess.

For a monster extension: clone the exact supplied source. Preserve existing items, activities, effects, images and traits. Preserve original ability scores except normal class ASI, unless DM specifies a change. Grant the requested class/subclass features cumulatively; first added class grants its normal starting proficiencies, union with existing ones, without duplicating benefits. No extra starting equipment. Grant the Extra Attack feature when earned, preserving its source; do not add its attack count to the source Multiattack action. These are separate attack options.

New Hit Dice use monster size: tiny d4, small d6, medium d8, large d10, huge d12, gargantuan d20. HP = floor(source maximum HP + added levels × (mean size die + final CON modifier) + original HD count × change in CON modifier). Preserve the source HP baseline even if it was rounded; floor only the final sum. Existing HD count comes from source HP formula. No maximum-first-class-die bonus on extensions.

Preserve source CR. CR reassessment is not implemented; disclose this briefly. Accept native dnd5e proficiency derivation. In local dnd5e5.3.3, NPC class Items cause proficiency to use max(CR,class level); this is the accepted project behavior. Do not add a proficiency override effect, manually patch proficiency, or change CR to force a value. Native class Item system.levels supplies class scales; subclass Item classIdentifier links it. Reading actual effective fields is required; source data alone is insufficient.

No auto-pack changes and no promise that every class feature has working combat automation. Preserve full source feature configuration and verify available resources. Do not inspect other benchmark characters. For A cases create the uniquely named requested Character; for B cases preserve the supplied monster Actor type. Finish with its ID and unresolved limitations.

Normal proficiencies, skill/expertise selections, spell grants and resource configuration must be completed and checked against expected effective values. A class Item not automatically applying Trait advancements is a reason to configure those fields, not an acceptable unfinished automation limitation. Preserve source ability scores on extensions and compare before/after deltas.
