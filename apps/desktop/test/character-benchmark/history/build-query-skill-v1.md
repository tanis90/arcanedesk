---
name: fvtt-build-query
description: Query installed dnd5e class and race progression, then prepare an NPC using source defaults and the DM's explicit requirements.
---

# Source-driven NPC preparation

Read the native NPC and pack guides alongside this guide. Use installed 2014/2024 sources matching the request, not external rulebook text. Actor Studio is not needed.

Before creating, obtain the class/race information through the target level. If foundry_build_query is available, use it. Otherwise use browser_evaluate and batch the following read-only steps:

- Discover Item packs whose collection names contain classes, races or species using game.packs. getIndex({fields:['system.identifier','system.source.rules','type']}); match the requested name or English identifier, load matched documents and verify type and system.source.rules. Prefer the system dnd5e source when duplicates exist; retain exact UUIDs.
- Read source.toObject().system.advancement. It can be an object keyed by ID: use Object.values when not an array. Include entries with level <= target level and entries without a level.
- ItemGrant: resolve configuration.items UUIDs with fromUuid and return names and references. Trait: retain grants and choices/count/pool. Subclass and AbilityScoreImprovement: retain selection requirements. ScaleValue: choose the last configuration.scale threshold <= target level. ItemChoice: retain only configuration.choices levels <= target level. Do not flatten choices into automatic grants.
- Also return class hit-die denomination, spellcasting configuration and race movement. Return compact structured results, not whole documents. Missing data stays unresolved; do not guess additional grants.

The cumulative list is preparation evidence, not a command to reproduce all PC advancement mechanics on an NPC. Use the same native NPC write workflow in either arm. Respect requested final ability values; do not add racial/level bonuses on top of an explicit final value. Preserve native defaults for unspecified fields and images. Do not browse for portraits, decorate biography, or set CR equal to caster level. Apply relevant source-provided defaults such as race movement. HP formula alone does not fill current/max HP; set both explicitly when creating a full-health NPC.

Where an applicable selection has no source default, make the minimum reasonable selection needed for this NPC; do not expand into optional spellbook, subclass automation or image work. A source choice pool is not a source recommendation. Use the DM's required spell/equipment, preserving their actual activities and source references. Do not inspect previously created benchmark NPCs for answers. Read effective final fields in the same write script, summarize unresolved choices honestly, and stop once the requested NPC is ready. Do not claim that all possible class mechanics have been implemented.

## Adding class levels to an existing monster (2014)

Preserve the monster's original ability scores; apply only ordinary class Ability Score Improvements unless the DM explicitly requests another change. Do not optimize a monster's ability array merely to suit its new class.

Each added class level adds one Hit Die of the monster's size-based denomination, not the class denomination: Tiny d4, Small d6, Medium d8, Large d10, Huge d12, Gargantuan d20. Preserve existing Hit Dice; include Constitution in the added HP. Do not grant a second first-level maximum die. Class hit-die data returned by the progression query still applies to a character built from scratch, not this monster extension. Distinguish die denomination from the separate HP averaging/rounding policy; do not silently reuse PC fixed-level HP values.

Source: Dungeon Master's Guide (2014), p.283, “Monsters with Classes”; size denominations from the 2014 monster rules. This is a shared rule in both benchmark arms, not an advantage exclusive to the query tool. Project scope: automatic CR reassessment after adding class levels is not implemented. Preserve the source CR unless the DM explicitly supplies a replacement; do not estimate CR or convert added levels into a CR increment. Briefly disclose that retained CR has not been reassessed and is not a validated encounter-difficulty rating for the modified monster. Accept native dnd5e proficiency derivation (local 5.3.3 uses max(CR, class level) for NPCs). Do not add override effects or manual proficiency corrections, and never change CR to force a desired proficiency bonus.
