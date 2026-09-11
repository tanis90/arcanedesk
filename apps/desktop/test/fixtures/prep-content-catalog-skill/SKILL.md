---
name: fvtt-content-catalog
description: Use the Foundry content catalog tools to discover source documents before prep writes.
---
# Content discovery

Use the catalog before writing whenever the task names a class, subclass, spell, feature, weapon, armor, monster action, actor, or scene.

1. Use `foundry_content_search` only for a fuzzy name or identifier. Always pass `scope` and the exact `type`; set `packIds` when the source pack is known. Search finds documents and never proves class eligibility.
2. Use `foundry_content_list` for a rule-defined set. For class growth pass `scope:"compendium"`, `type:"classFeature"`, lowercase `class` and `subclass`, and `characterLevel`. For spells pass the same class/subclass/level and `rules:"2014"` or the requested edition. Treat `classEligible`, `levelEligible`, and `subclassGranted` as separate fields; candidates are not automatic grants.
3. Use `foundry_content_detail` on every UUID that will be imported when activities, effects, or the complete document matter. Keep the returned UUID and source; do not substitute a same-name item.

The three tools are read-only. After discovery, perform writes with the normal Foundry workflow and read back effective fields. If a list returns an error, correct the input (especially lowercase identifiers and edition) or report the unresolved source; do not silently guess from item names or dump the whole pack with browser JavaScript. `world` means current mutable instances; `compendium` means reusable source documents.
