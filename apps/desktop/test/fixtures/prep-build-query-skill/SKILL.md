---
name: fvtt-build-query
description: Read actual class, selected subclass and race import sources, then configure and verify the requested NPC.
---

# Read what will be imported

Use installed sources for the requested edition. When class levels are requested, obtain cumulative
class AND selected subclass benefits, plus ancestry where relevant. Use foundry_build_query with
className, subclassName, level and optional raceName. Use the DM's choice or an explicit project default;
if no subclass is selected, the result marks that gap. classRole defaults to primary for the first
class added to an NPC; use secondary only for an actual additional player class.

Select root documents with the project's auto-pack preference. Then follow those documents' own
advancement UUIDs exactly, including explicitly linked system-pack Items; do not rematch by name.
documents contains the linked documents' mechanics previews. Read with await fromUuid(uuid), then
use document.toObject(); preserve activities, effects and source identity. Missing links are explicit
unresolved entries, not permission to silently substitute another pack. An empty growth configuration
does not certify that the class has no benefits. Read full descriptions when descriptionTruncated
or an unresolved dependency affects a required choice.

Without the tool, batch the same work in browser_evaluate: read the selected class, subclass and race,
filter their own advancements through the target level and applicable primary/secondary role, and
read exact grant and choice-pool UUIDs. Do not replace selected growth with another pack's growth.
Keep automatic grants, choices/counts/pools, ASI and current scales distinct. Choices are not all grants.

# Complete normal configuration

Follow fvtt-native-npc for field types and writes. Importing class/subclass Items does not automatically
apply all proficiencies or choices on an NPC. Required skills, expertise, saves, ASI, spell selections,
prepared counts and full resources must be configured, then compared with expected effective values.
An imported feature name or a printed field list is not proof of completion. Do not stop with these
normal requirements listed as automation limitations when their sources and APIs are available.

Preserve actual source activities and effects. Complex combat automation may remain untested; this
does not excuse missing ordinary configuration. For an NPC without requested class levels, do only
the requested stat-block work. Do not add background, image work or optional mechanics by default.

# Adding class levels to a monster

Preserve source ability scores; apply only normal class ASI unless the DM requests another change.
Compare final abilities with the source, not with a newly invented class-oriented array.
Grant earned Extra Attack as a feature, but do not add its attack count to the existing Multiattack
action. Those are separate attack options.

Added Hit Dice use monster size: Tiny d4, Small d6, Medium d8, Large d10, Huge d12, Gargantuan d20.
Do not use class dice or a second first-level maximum die. Apply the project's explicit averaging and
CON-adjustment policy. Source: 2014 DMG p.283, Monsters with Classes.

Preserve CR and disclose that reassessment is not implemented. Accept local dnd5e NPC proficiency
derived from max(CR,class level); do not add override effects or change CR to force proficiency.
Do not modify auto pack. Finish with Actor UUID and verified results; label real blockers or timeout
as incomplete, and distinguish them from untested combat automation.


# Interpret candidate eligibility

The query excludes structured level prerequisites above the target level. A conditional or
review-required candidate still needs its textual/item prerequisites checked against your choices;
level-eligible is not a certification of the whole build. spellTables are linked spell candidates,
not automatic grants; use their interpretation and the source rules. spellAccess covers only the
requested class, not multiclass slot merging. Candidate mechanics are previews; import the actual
UUID document intact and read fuller source details when a truncated preview affects your decision.
