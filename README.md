# persistent-zones

FoundryVTT module dedicated to persistent zones runtime.

## Scope

`persistent-zones` is autonomous.

- It owns its runtime data contract.
- Compatible modules should write zone data to `flags["persistent-zones"].definition` on the source `Item`.
- Runtime metadata is stored on created `Region` documents in `flags["persistent-zones"].runtime`.

## Current MVP

- Creates a managed `Region` from a qualifying `MeasuredTemplate`.
- Stores normalized runtime metadata on the `Region`.
- Cleans stale managed Regions when the source template, item, or concentration state becomes invalid.
- Detects token entry into managed Regions.
- Applies simple entry damage, with optional save handling when configured.
- Applies simple start-of-turn and end-of-turn effects during Foundry combat, with optional save handling when configured.

## Debug / Dev

- As GM, apply a debug definition to an existing item with `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "basic")`.
- For entry testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "entry-damage-save")`.
- For turn testing, use `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "turn-damage-save")`.
- Remove the test definition with `await game.persistentZones.debug.clearTestDefinitionFromItem(itemOrUuid)`.
