import assert from "node:assert/strict";

globalThis.foundry = {
  utils: {
    deepClone: (value) => structuredClone(value),
    randomID: () => "abcdef"
  }
};
globalThis.game = { settings: { settings: new Map() } };
globalThis.canvas = { scene: null };
globalThis.dnd5e = {
  applications: {
    activity: {
      ActivitySheet: class { static PARTS = {}; }
    }
  }
};

const { buildLegacyDefinitionFromPersistentZoneActivity } = await import(
  "../activity/persistent-zone-activity-utils.mjs"
);
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const {
  buildInitialMultipartPart,
  buildSecondaryMultipartPart,
  preserveExistingActivitySchemaVersion
} = await import("../activity/persistent-zone-activity-sheet.mjs");

const originalDebug = console.debug;
const originalWarn = console.warn;
console.debug = () => {};
console.warn = () => {};

function buildActivity(config) {
  return {
    id: "activity-id",
    uuid: "Item.item-id.Activity.activity-id",
    name: "Terrain test",
    type: "persistent-zone",
    duration: { concentration: false },
    target: { template: { type: "circle", size: 10, units: "ft" } },
    _source: {
      persistentZone: structuredClone(config),
      target: { template: { type: "circle", size: 10, units: "ft" } }
    }
  };
}

function buildConfig({ schemaVersion, terrainEnabled = false, parts = undefined, geometry = undefined } = {}) {
  return {
    schemaVersion,
    enabled: true,
    geometry: geometry ?? { type: "circle", radius: 10 },
    terrain: { enabled: terrainEnabled, multiplier: 2 },
    ...(parts ? { parts } : {})
  };
}

function convert(config) {
  return buildLegacyDefinitionFromPersistentZoneActivity(buildActivity(config), config);
}

function normalize(config) {
  return normalizeZoneDefinition(convert(config));
}

{
  const initial = buildInitialMultipartPart({});
  const secondary = buildSecondaryMultipartPart([initial], {});
  assert.deepEqual(initial.terrain, { enabled: false }, "initial multipart part terrain must default to OFF");
  assert.deepEqual(secondary.terrain, { enabled: false }, "added multipart part terrain must default to OFF");
}

{
  const submitted = {};
  preserveExistingActivitySchemaVersion(submitted, { schemaVersion: 2 });
  assert.equal(submitted.schemaVersion, 2, "editing a v2 activity must not upgrade it");
}

{
  const normalized = normalize(buildConfig({ schemaVersion: 3, terrainEnabled: false }));
  assert.equal(normalized.terrain.difficult, false, "v3 mono OFF must remain off");
  assert.equal(normalized.parts[0].terrain.difficult, false, "v3 mono OFF must create no part terrain");
}

{
  const normalized = normalize(buildConfig({ schemaVersion: 3, terrainEnabled: true }));
  assert.equal(normalized.terrain.difficult, true, "v3 mono ON must activate native terrain");
  assert.equal(normalized.parts[0].terrain.difficult, true, "v3 mono ON must reach its sole Region");
  assert.equal(normalized.parts[0].terrain.behaviorType, "dnd5e.difficultTerrain");
  assert.equal(normalized.parts[0].terrain.multiplier, 2);
}

{
  const normalized = normalize(buildConfig({
    schemaVersion: 3,
    terrainEnabled: true,
    parts: [
      { id: "off", geometry: { type: "template" }, terrain: { enabled: false } },
      { id: "on", geometry: { type: "template" }, terrain: { enabled: true } },
      { id: "missing", geometry: { type: "template" } }
    ]
  }));
  assert.deepEqual(
    normalized.parts.map((part) => part.terrain.difficult),
    [false, true, false],
    "v3 multipart terrain must be explicit and must not inherit global terrain"
  );
}

{
  const normalized = normalize(buildConfig({
    schemaVersion: 3,
    parts: ["one", "two", "three"].map((id) => ({
      id,
      geometry: { type: "template" },
      terrain: { enabled: true }
    }))
  }));
  assert.deepEqual(normalized.parts.map((part) => part.terrain.difficult), [true, true, true]);
}

{
  const definition = convert(buildConfig({ schemaVersion: 2, terrainEnabled: true }));
  assert.deepEqual(definition.terrain, {
    enabled: false,
    requestedEnabled: true,
    multiplier: 2,
    runtimeSupported: false
  }, "v2 requestedEnabled must stay neutralized");
}

{
  const normalized = normalize(buildConfig({
    schemaVersion: 2,
    terrainEnabled: false,
    parts: [{ id: "legacy-explicit", geometry: { type: "template" }, terrain: { enabled: true } }]
  }));
  assert.equal(normalized.parts[0].terrain.difficult, true, "legacy explicit part terrain must be preserved");
}

{
  const definition = convert(buildConfig({
    schemaVersion: 3,
    geometry: {
      type: "ring",
      ringReferenceRadius: 10,
      ringInnerWidth: 2,
      ringOuterWidth: 3
    }
  }));
  assert.equal(definition.geometry.widthSemantics, "independent", "v3 Ring must retain v2 independent widths");
  assert.equal(definition.geometry.innerWidth, 2);
  assert.equal(definition.geometry.outerWidth, 3);
}

console.debug = originalDebug;
console.warn = originalWarn;
console.log("activity-terrain-v3 tests passed");
