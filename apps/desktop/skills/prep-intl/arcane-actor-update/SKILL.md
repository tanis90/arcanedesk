---
name: arcane-actor-update
description: Create or modify characters (Actors, PCs, NPCs) in a Foundry world. Use when adding spells, class features, or feats to a character (prefer the "Arcane 5e 2014" compendium packs from the arcane-dnd5e-2014-automation module), creating characters, adding character art, noticing tokens dragged onto the map have no portrait, fixing token art, or batch-fixing character images.
---

# Character (Actor) updates

## Adding spells / class features to a character

The default source for spells, class features, feats, and similar items is the **compendium packs of the arcane-dnd5e-2014-automation module** (the "Arcane 5e 2014 …" series in Foundry's compendium sidebar): pull from here first, and only fall back to the system's built-in packs when they're unavailable. Never write item data from memory — always copy from compendium documents to avoid field-version drift.

1. Locate the packs: filter `game.packs` by `pack.metadata.packageName === "arcane-dnd5e-2014-automation"` (collections start with `arcane-dnd5e-2014-automation.`). Pick the pack by need:
   - Spells: `arcane-dnd5e-2014-automation.spells`
   - Class/subclass features: `arcane-dnd5e-2014-automation.classfeatures`
   - Feats: `arcane-dnd5e-2014-automation.feats`
   - Races / racial traits: `arcane-dnd5e-2014-automation.races` / `.racialtraits`
   - Backgrounds / background features: `arcane-dnd5e-2014-automation.backgrounds` / `.backgroundfeatures`
   - Classes / subclasses: `arcane-dnd5e-2014-automation.classes` / `.subclasses`
   - `arcane-dnd5e-2014-automation.summons` is an Actor pack (summoned creatures) and does not apply to this granting path.
   When none of these Item packs exist, the module is not installed or not enabled: tell the user explicitly, then fall back to the `dnd5e.*` built-in packs (e.g. `dnd5e.spells`), and record the actual source in the report.
2. Search: `await pack.getIndex()`. Entry names may be bilingual or monolingual; always match with case-insensitive substring matching tolerant of partial names — never do full-string exact matching on a single user-given name. Index entries carry `type` (spells are `spell`; class features and feats are both `feat` — only the chosen pack tells them apart) and `_id`; on a hit, `await pack.getDocument(entry._id)` for the full document. With multiple candidates, take the closest name match and note it in the report — don't interrupt the flow to ask back.
3. Grant: `await actor.createEmbeddedDocuments("Item", [doc.toObject()])`; to grant several items at once, put several `toObject()`s in the same array in a single call.
4. Read back `actor.items` to confirm the items are on the character, and report item names and source pack ids.

## Character portrait and token image sync

In Foundry, "the portrait on the character sheet" and "the token image dragged onto the map" are fields that don't track each other: set only the portrait and the token shows the default mystery-man silhouette. Whenever you create a character or change a character's image, both locations must be set together and read back together — changing just one is not allowed.

### Field locations (V13)

- `actor.img` — the portrait shown on the character sheet and in the Actors directory.
- `actor.prototypeToken.texture.src` — the default image for tokens newly dragged into a scene afterwards.
- Dynamic token ring: when `prototypeToken.ring.enabled` is true, the token's main image comes from `prototypeToken.ring.subject.texture`, which must be set together with the two fields above (usually the same image).

### Default actions when creating a character

1. When the user hasn't provided separate portrait and token images, use the same image for all three fields; when they provide separate ones, set them separately and confirm with the user which image goes where.
2. Image files land inside the world's Data directory first (e.g. `worlds/<world-id>/assets/`), and fields store world-relative paths; never reference local absolute paths or temp directories — the images would all be lost after migrating the world or switching machines.
3. After writing, read back `img`, `prototypeToken.texture.src` (and `ring.subject.texture` when the ring is enabled) one by one, and confirm the referenced files actually exist.

### Existing tokens already in scenes

Changing `prototypeToken` only affects tokens placed afterwards — it doesn't touch tokens already placed in scenes. To fix existing ones: walk the token documents of the relevant Scenes and update `texture.src` (and `ring.subject.texture` when the ring is enabled) on the tokens belonging to that character, or have the user delete and re-drag them. Await every write call and read back to verify.

## Acceptance

1. Read back `actor.items` to confirm the added spells/features are on the character sheet, sourced from the arcane-dnd5e-2014-automation packs or a reported fallback source.
2. The character sheet / Actors directory shows the portrait.
3. Drag a new token into the scene — it shows the correct image.
4. The character's existing tokens in scenes have been synced.
