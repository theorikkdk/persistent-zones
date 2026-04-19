# persistent-zones

FoundryVTT module dedicated to persistent zones runtime.

## Scope

`persistent-zones` is autonomous.

- It owns its runtime data contract.
- Compatible modules should write zone data to `flags["persistent-zones"].definition` on the source `Item`.
- Runtime metadata is stored on created `Region` documents in `flags["persistent-zones"].runtime`.
- Linked walls and linked lights can be configured either directly or through reusable `preset` keys on `linkedWalls` and `linkedLight`, with explicit fields overriding preset defaults.

## Current MVP

- Creates a managed `Region` from a qualifying `MeasuredTemplate`.
- Can create a managed Region group when one template expands into multiple logical parts.
- Supports a first composite geometry mode for annulus / ring-style parts.
- Stores normalized runtime metadata on the `Region`.
- Can create simple linked `Wall` and `AmbientLight` documents that follow the managed zone.
- Cleans stale managed Regions when the source template, item, or concentration state becomes invalid.
- Detects token entry into managed Regions.
- Applies simple entry damage, with optional save handling when configured.
- Applies simple start-of-turn and end-of-turn effects during Foundry combat, with optional save handling when configured.

## Debug / Dev

- As GM, apply a debug definition to an existing item with `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "basic")`.
- For entry testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "entry-damage-save")`.
- For turn testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "turn-damage-save")`.
- For linked light testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-light")`.
- For linked moonlight testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-light-moonlight")`.
- For linked fire light testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-light-fire")`.
- For linked walls testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-walls")`.
- For linked solid walls testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-walls-solid")`.
- For linked terrain walls testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "linked-walls-terrain")`.
- For ring geometry testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "ring-basic")`.
- Remove the test definition with `await game.persistentZones.debug.clearTestDefinitionFromItem(itemOrUuid)`.
- Create or move the template in Foundry to verify that the Region, linked light, and linked walls stay synchronized, then delete the template to confirm cleanup.
