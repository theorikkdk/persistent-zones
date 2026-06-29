# Persistent Zones

Persistent Zones is a Foundry VTT module for turning measured templates into managed, persistent zones.

It lets GMs attach zone definitions to Items, create scene Regions from templates, run entry and turn-based effects, manage linked walls or lights, and keep active Regions synchronized with their source Item.

## Features

- Item authoring UI for persistent zone definitions.
- Built-in and user-saved profiles for common zone patterns.
- Persistent scene Regions created from measured templates.
- Automated trigger effects for damage, healing, temporary hit points, and compatible dnd5e activities.
- Per-zone targeting rules for self, allies, enemies, or all tokens.
- Optional difficult terrain using Foundry/dnd5e native movement-cost behavior.
- Linked wall and AmbientLight document creation for supported zone shapes.
- Global movement interruption setting for supported movement triggers.
- Public API exposed as `game.persistentZones`.
- English and French localization.

## Supported Zone Types

- Simple zone: uses the detected template shape directly.
- Ring: creates an annular zone from a circle template.
- Composite line: creates multi-part line zones, such as a wall body plus one heated side.
- Composite ring: creates multi-part circular zones, such as a ring body plus an inner or outer heated side.

Supported template types are circle, cone, ray, and rectangle. Ring and composite ring zones require circle templates. Composite line zones require ray templates.

## Supported Triggers

Persistent Zones normalizes the following trigger timings:

- `onEnter`
- `onExit`
- `onMove`
- `onStartTurn`
- `onEndTurn`

Triggers can use simple effects or compatible dnd5e activities. Simple effects support damage, healing, temporary hit points, saving throws, damage type, movement mode, and step-based `onMove` behavior.

## Linked Documents

Persistent Zones can create and maintain linked scene documents for active zones:

- Linked walls with solid, terrain, invisible, and ethereal presets.
- Linked AmbientLight documents with glow, moonlight, fire, holy, and darkness presets.
- Optional linked wall height when a compatible wall-height support module is active.

Linked walls are limited to compatible circle, rectangle, and polygon Region shapes. Linked lights use one native AmbientLight per managed zone.

## Global Movement Interruption

Movement interruption is controlled globally in module settings:

- Off
- On Enter only
- On Enter + On Move

The module preserves legacy local movement-stop flags for migration awareness, but the global setting controls runtime movement interruption.

## Installation And Compatibility

- Foundry VTT: minimum v13, verified v13.
- System: dnd5e minimum v4, verified v4.
- Languages: English and French.

For local installation, place this module folder in your Foundry `Data/modules` directory and enable **Persistent Zones** from the Manage Modules screen.

Publication manifest and download URLs should be added once the release artifact is hosted.

## Quick Usage

1. Enable the module in a dnd5e world.
2. Open an Item that uses a measured template.
3. Click the Persistent Zones header button.
4. Choose a built-in profile or configure a zone type manually.
5. Configure triggers, targeting, terrain, linked walls, or linked light as needed.
6. Save the definition.
7. Place the Item template in a scene to create managed persistent Regions.

Use the module settings to choose whether supported zone triggers should interrupt token movement globally.

## Public API

The public entry point is:

```js
game.persistentZones
```

Common helpers:

- `openItemConfig(itemOrUuid)`
- `getZoneDefinitionFromItem(itemOrUuid)`
- `getNormalizedZoneDefinitionFromItem(itemOrUuid, options?)`
- `setZoneDefinitionOnItem(itemOrUuid, definition)`
- `clearZoneDefinitionFromItem(itemOrUuid, options?)`
- `validateDefinition(definition, context?)`
- `getCompatibleBaseTypes(itemOrUuid, options?)`
- `getCompatibleVariants(itemOrUuid, options?)`
- `cleanupRegionsForItem(itemOrUuid, options?)`
- `inspectSelectedVariant(itemOrUuid, options?)`
- `createRegionFromTemplate(templateDocument, options?)`
- `cleanupSceneRegions(scene, options?)`
- `cleanupWorldRegions(options?)`
- `getRegionRuntime(regionDocument)`

The recommended integration path is to use the public API instead of writing module flags directly.

## Data Contract

- Source Item definitions live on `flags["persistent-zones"].definition`.
- Runtime Region metadata lives on `flags["persistent-zones"].runtime`.
- User profiles are stored in a client-scoped module setting.

## Known Limits And Notes

- Custom movement-cost multipliers are not applied; enabled terrain uses standard difficult terrain.
- Forced movement configuration is recognized as a limitation but is not executed.
- Linked walls only support compatible circle, rectangle, and polygon Region shapes.
- Linked lights use a single native AmbientLight with bright/dim settings.
- `side-of-ring` is intended for circle-based ring body parts.
- The Item editor saves definitions in the supported public authoring set: simple, ring, composite line, and composite ring.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
