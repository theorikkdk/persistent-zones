# persistent-zones

FoundryVTT module dedicated to persistent zones runtime.

## Scope

`persistent-zones` is autonomous.

- It owns its runtime data contract.
- Compatible modules should write zone data to `flags["persistent-zones"].definition` on the source `Item`.
- Variant-capable definitions can expose `variants[]`, an explicit `selectedVariant`, and an optional `defaultVariant`.
- Runtime metadata is stored on created `Region` documents in `flags["persistent-zones"].runtime`.
- Linked walls and linked lights can be configured either directly or through reusable `preset` keys on `linkedWalls` and `linkedLight`, with explicit fields overriding preset defaults.

## Current MVP

- Creates a managed `Region` from a qualifying `MeasuredTemplate`.
- Can create a managed Region group when one template expands into multiple logical parts.
- Supports explicit variant selection when one logical definition exposes multiple alternative zone compositions.
- Resolves variants with a stable fallback order: `selectedVariant`, then `defaultVariant`, then single-option, then deterministic fallback.
- Includes a first Item authoring UI for writing compatible `flags["persistent-zones"].definition` data without using only debug console helpers.
- Supports a first composite geometry mode for annulus / ring-style parts.
- Supports ring wall-body geometry with explicit `thickness`, anchored to the outer edge of the template circle and extending inward.
- Supports a first directional geometry mode for `side-of-line` parts on ray-like templates.
- Supports a first directional annular geometry mode for `side-of-ring` parts around ring body parts.
- Stores normalized runtime metadata on the `Region`.
- Can create simple linked `Wall` and `AmbientLight` documents that follow the managed zone.
- Cleans stale managed Regions when the source template, item, or concentration state becomes invalid.
- Detects token entry into managed Regions.
- Applies simple entry damage, with optional save handling when configured.
- Applies simple start-of-turn and end-of-turn effects during Foundry combat, with optional save handling when configured.

## Debug / Dev

- As GM, apply a debug definition to an existing item with `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "basic")`.
- For first-pass authoring, open an Item sheet and use the `Persistent Zones` header button, or call `await game.persistentZones.openItemConfig(itemOrUuid)`.
- For entry testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "entry-damage-save")`.
- For turn testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "turn-damage-save")`.
- For linked light testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-light")`.
- For linked moonlight testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-light-moonlight")`.
- For linked fire light testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-light-fire")`.
- For linked walls testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-walls")`.
- For linked solid walls testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-walls-solid")`.
- For linked terrain walls testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-walls-terrain")`.
- For ring geometry testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "ring-basic")`.
- For directional side-of-line testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "line-side-left")` or `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "line-side-right")`.
- For composite wall plus heated side testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "wall-heated-left")` or `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "wall-heated-right")`.
- For composite ring plus heated side testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "ring-heated-inner")` or `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "ring-heated-outer")`.
- For canonical ring wall-body testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "ring-wall-inner-heat")` or `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "ring-wall-outer-heat")`.
- For variant selection testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "variant-line-left")`, `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "variant-line-right")`, `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "variant-ring-inner")`, or `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "variant-ring-outer")`.
- To inspect the effective variant resolution, use `await game.persistentZones.debug.inspectSelectedVariant(itemOrUuid)` or `await game.persistentZones.debug.inspectSelectedVariant(itemOrUuid, { templateType: "circle" })`.
- For fire-wall-like line testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "fire-wall-line-left")` or `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "fire-wall-line-right")`.
- For fire-wall-like ring testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "fire-wall-ring-inner")` or `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "fire-wall-ring-outer")`.
- Remove the test definition with `await game.persistentZones.debug.clearTestDefinitionFromItem(itemOrUuid)`.
- Create or move the template in Foundry to verify that the Region, linked light, and linked walls stay synchronized, then delete the template to confirm cleanup.
