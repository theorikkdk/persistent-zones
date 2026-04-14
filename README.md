# persistent-zones

FoundryVTT module dedicated to persistent zones runtime.

## Scope

`persistent-zones` is autonomous.

- `persistent-zones` defines and owns its runtime data contract.
- Other modules must write compatible data into `flags["persistent-zones"].definition` on the source `Item`.
- This MVP step 1 only creates persistent `Region` documents from eligible `MeasuredTemplate` documents.

## Current MVP behavior

- Initializes a Foundry VTT v13 module for the `dnd5e` system.
- Exposes a small API on `game.persistentZones`.
- Reads the source zone definition from `flags["persistent-zones"].definition` on the linked item.
- Normalizes that definition into a stable internal shape.
- On `createMeasuredTemplate`, creates a linked `Region` when a valid persistent zone config is found.
- Stores runtime flags on the `Region` for future steps.
- Cleans stale Regions when the linked template, item, or concentration effect is no longer valid.

## Compatibility contract

Compatible modules should write this data on the source item:

- `flags["persistent-zones"].definition`

The created runtime `Region` stores:

- `flags["persistent-zones"].runtime`

The public API exposes helpers to:

- Read the raw definition from an item
- Normalize a raw definition
- Create a `Region` from a `MeasuredTemplate`
- Read runtime data from a `Region`

## Transition note

- A small legacy fallback for Encounter+ Importer may still be used internally when no `persistent-zones` definition exists.
- This fallback is only transitional and is not the primary contract.

## Debug / Dev

- As a GM, open the Foundry console and run `await game.persistentZones.debug.applyTestDefinitionToItem(itemOrUuid, "basic")` on an existing spell item.
- Cast that spell so it creates a `MeasuredTemplate`, then confirm a linked `Region` is created and inspect its runtime flag if needed.
- Remove the debug flag with `await game.persistentZones.debug.clearTestDefinitionFromItem(itemOrUuid)`.

## Explicitly out of scope for step 1

- Spell-by-spell logic
- Historical hotfix behavior
- UI macros
- Linked walls
- Linked lights
- Damage application
- Runtime saves
- Turn logic
- Difficult terrain
- Forced movement
- Exit logic or movement-through-zone logic

## Shape support

- The module first tries to reuse the rendered template geometry from Foundry.
- A direct fallback is provided for `circle` and `ray`.
- More advanced shapes are intentionally left conservative for this MVP and will be expanded in later steps.
