# persistent-zones

`persistent-zones` is an autonomous Foundry VTT module for persistent template-driven zones.

It owns its own data contract, runtime behaviors, and Item authoring UI. Other modules can integrate with it without knowing the internal runtime implementation details.

## Core Contract

- Source Item data lives on `flags["persistent-zones"].definition`.
- Runtime Region metadata lives on `flags["persistent-zones"].runtime`.
- The public API is exposed on `game.persistentZones`.

## Supported Zone Shapes

- `simple`
  A single zone matching the detected Item template.

- `ring`
  An annulus / wall-body zone built from a circle template.

- `composite line`
  A multi-part line-based zone, typically a wall body plus one heated side.

- `composite ring`
  A multi-part ring-based zone, typically a wall body plus an inner or outer heated side.

## Parts And Variants

- `parts`
  A single logical definition can expand into multiple Region parts. Each part can carry its own triggers and behaviors.

- `variants`
  A definition can expose multiple alternative layouts through `variants[]`, an explicit `selectedVariant`, and an optional `defaultVariant`.

Typical examples:

- `line-left` / `line-right`
- `ring-inner` / `ring-outer`

## Public API

The public entry point is `game.persistentZones`.

### Main Helpers

- `await game.persistentZones.openItemConfig(itemOrUuid)`
  Open the Item authoring popup.

- `await game.persistentZones.getZoneDefinitionFromItem(itemOrUuid)`
  Read the raw stored definition from the Item flag.

- `await game.persistentZones.getNormalizedZoneDefinitionFromItem(itemOrUuid, options?)`
  Read and normalize the effective definition for the Item.

- `await game.persistentZones.setZoneDefinitionOnItem(itemOrUuid, definition)`
  Replace the Item definition with a new one.

- `await game.persistentZones.clearZoneDefinitionFromItem(itemOrUuid, options?)`
  Remove the Item definition and cleanup active managed Regions for that Item.

- `await game.persistentZones.validateDefinition(definition, context?)`
  Normalize and validate an arbitrary definition object.

- `await game.persistentZones.getCompatibleBaseTypes(itemOrUuid, options?)`
  Return the base types compatible with the detected or effective template type.

- `await game.persistentZones.getCompatibleVariants(itemOrUuid, options?)`
  Return the variant choices compatible with the Item and its effective template type.

- `await game.persistentZones.cleanupRegionsForItem(itemOrUuid, options?)`
  Delete active managed Regions currently linked to the Item.

- `await game.persistentZones.inspectSelectedVariant(itemOrUuid, options?)`
  Inspect the selected variant, effective variant, and variant resolution metadata.

### Existing Runtime Helpers Still Exposed

- `game.persistentZones.normalizeZoneDefinition(rawDefinition, options?)`
- `await game.persistentZones.createRegionFromTemplate(templateDocument, options?)`
- `await game.persistentZones.cleanupSceneRegions(scene, options?)`
- `await game.persistentZones.cleanupWorldRegions(options?)`
- `game.persistentZones.getRegionRuntime(regionDocument)`
- `game.persistentZones.debug`

## Minimal Definition Example

```js
const definition = {
  enabled: true,
  label: "Moonbeam",
  triggers: {
    onEnter: {
      mode: "simple",
      damage: {
        enabled: true,
        formula: "2d10",
        type: "radiant"
      },
      save: {
        enabled: true,
        ability: "con",
        dcMode: "auto",
        onSuccess: "half"
      }
    }
  }
};

await game.persistentZones.setZoneDefinitionOnItem(item, definition);
```

## Variant Example

```js
const definition = {
  enabled: true,
  label: "Wall Of Fire Like",
  selectedVariant: "line-left",
  defaultVariant: "line-left",
  variants: [
    {
      id: "line-left",
      parts: [
        { id: "wall-body" },
        {
          id: "heated-side-left",
          geometry: {
            type: "side-of-line",
            side: "left",
            offsetReference: "body-edge",
            offsetStart: 0,
            offsetEnd: 15
          },
          triggers: {
            onEnter: {
              mode: "simple",
              movementMode: "any",
              damage: { enabled: true, formula: "5d8", type: "fire" },
              save: { enabled: true, ability: "dex", dcMode: "auto", onSuccess: "half" }
            }
          }
        }
      ]
    },
    {
      id: "line-right",
      parts: [
        { id: "wall-body" },
        {
          id: "heated-side-right",
          geometry: {
            type: "side-of-line",
            side: "right",
            offsetReference: "body-edge",
            offsetStart: 0,
            offsetEnd: 15
          }
        }
      ]
    }
  ]
};

const result = await game.persistentZones.validateDefinition(definition, {
  item,
  templateType: "ray"
});

if (result.isValid) {
  await game.persistentZones.setZoneDefinitionOnItem(item, definition);
}
```

## Cleanup Example

```js
await game.persistentZones.cleanupRegionsForItem(item);
```

Or remove the definition and cleanup in one step:

```js
await game.persistentZones.clearZoneDefinitionFromItem(item);
```

## Compatibility Query Examples

```js
const baseTypes = await game.persistentZones.getCompatibleBaseTypes(item);
console.log(baseTypes.compatibleBaseTypes);
```

```js
const variants = await game.persistentZones.getCompatibleVariants(item);
console.log(variants.compatibleVariants);
```

## Macro Snippet Example

Open the authoring UI for the currently controlled Item:

```js
const item = actor?.items?.getName("Moonbeam");
if (!item) return ui.notifications.warn("Item not found.");

await game.persistentZones.openItemConfig(item);
```

Validate then store a small persistent-zone definition:

```js
const item = actor?.items?.getName("Moonbeam");
if (!item) return ui.notifications.warn("Item not found.");

const definition = {
  enabled: true,
  triggers: {
    onEnter: {
      mode: "simple",
      damage: { enabled: true, formula: "2d10", type: "radiant" }
    }
  }
};

const validation = await game.persistentZones.validateDefinition(definition, {
  item,
  templateType: "circle"
});

if (!validation.isValid) {
  return ui.notifications.error(validation.reasons.join(" | "));
}

await game.persistentZones.setZoneDefinitionOnItem(item, definition);
ui.notifications.info("Persistent Zones definition saved.");
```

## Notes

- The recommended integration path is to use the public API rather than writing flags manually.
- The Item editor remains the easiest way to author compatible definitions by hand.
- Movement stop is still intentionally disabled in the current stable runtime.
