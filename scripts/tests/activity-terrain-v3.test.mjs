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
const { buildManagedRegionFlags, getRegionRuntime } = await import("../runtime/utils.mjs");
const {
  buildInitialMultipartPart,
  buildSecondaryMultipartPart,
  buildTargetTemplateFromPersistentZoneConfig,
  normalizePersistentZoneActivitySubmitData,
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
  globalThis.canvas.scene = { grid: { units: "m", distance: 1.5, size: 100 } };
  const rectangle = normalizePersistentZoneActivitySubmitData({
    schemaVersion: 3,
    enabled: true,
    geometry: { type: "rectangle", width: 10, height: 10, units: "ft" }
  });
  const target = buildTargetTemplateFromPersistentZoneConfig(rectangle, { target: { template: { units: "ft" } } });
  assert.equal(target.type, "square");
  assert.equal(target.size, "3");
  assert.equal(target.width, "3");
  assert.equal(target.height, "3");
  const runtime = normalize(rectangle);
  assert.equal(runtime.geometry.type, "rectangle");
  assert.equal(runtime.geometry.width, 10);
  assert.equal(runtime.geometry.height, 10);
  assert.equal(runtime.geometry.units, "ft");
  globalThis.canvas.scene = null;
}

{
  const migrated = normalizePersistentZoneActivitySubmitData({
    schemaVersion: 3,
    enabled: true,
    geometry: { type: "circle", radius: 10 },
    triggers: { create: { enabled: true, mode: "simple-effect", frequency: "once-per-turn", frequencyGroup: "legacy-alias" } }
  });
  assert.equal(migrated.triggers.onCreate.frequency, "once-per-turn");
  assert.equal(migrated.triggers.onCreate.frequencyGroup, "legacy-alias");
  assert.equal(Object.hasOwn(migrated.triggers, "create"), false);
}

{
  const activeTrigger = (frequencyGroup) => ({
    enabled: true,
    mode: "simple-effect",
    frequency: "once-per-turn",
    frequencyGroup,
    simpleEffect: { damage: { enabled: true, formula: "1", type: "force" } }
  });
  for (const [source, expectedGroup, multipart] of [
    [{
      schemaVersion: 3,
      enabled: true,
      geometry: { type: "circle", radius: 10 },
      triggers: { onCreate: activeTrigger("shared-mono"), enter: activeTrigger("shared-mono") }
    }, "shared-mono", false],
    [{
      schemaVersion: 3,
      enabled: true,
      geometry: { type: "circle", radius: 10 },
      parts: [
        { id: "primary", role: "primary", geometry: { type: "template" }, triggers: { onCreate: activeTrigger("shared-multipart") } },
        { id: "secondary", role: "secondary", geometry: { type: "template" }, triggers: { onCreate: activeTrigger("shared-multipart") } }
      ]
    }, "shared-multipart", true]
  ]) {
    const prepared = normalizePersistentZoneActivitySubmitData(source);
    const runtime = normalize(prepared);
    if (multipart) {
      assert.ok(prepared.parts.every((part) => part.triggers.onCreate.frequency === "once-per-turn"));
      assert.ok(prepared.parts.every((part) => part.triggers.onCreate.frequencyGroup === expectedGroup));
      assert.ok(runtime.parts.every((part) => part.triggers.onCreate.enabled === true));
      assert.ok(runtime.parts.every((part) => part.triggers.onCreate.mode === "simple"));
      assert.ok(runtime.parts.every((part) => part.triggers.onCreate.frequency === "once-per-turn"));
      assert.ok(runtime.parts.every((part) => part.triggers.onCreate.frequencyGroup === expectedGroup));
    } else {
      assert.equal(prepared.triggers.onCreate.frequency, "once-per-turn");
      assert.equal(prepared.triggers.onCreate.frequencyGroup, expectedGroup);
      assert.equal(prepared.triggers.enter.frequency, "once-per-turn");
      assert.equal(prepared.triggers.enter.frequencyGroup, expectedGroup);
      for (const triggerId of ["onCreate", "onEnter"]) {
        assert.equal(runtime.triggers[triggerId].enabled, true);
        assert.equal(runtime.triggers[triggerId].mode, "simple");
        assert.equal(runtime.triggers[triggerId].frequency, "once-per-turn");
        assert.equal(runtime.triggers[triggerId].frequencyGroup, expectedGroup);
        assert.equal(runtime.triggers[triggerId].damage.enabled, true);
      }
      const storedFlags = structuredClone(buildManagedRegionFlags({ normalizedDefinition: runtime }));
      const regionDocument = {
        flags: storedFlags,
        toObject: () => ({ flags: structuredClone(storedFlags) })
      };
      const runtimeRead = getRegionRuntime(regionDocument)?.normalizedDefinition;
      for (const triggerId of ["onCreate", "onEnter"]) {
        assert.equal(runtimeRead.triggers[triggerId].enabled, true);
        assert.equal(runtimeRead.triggers[triggerId].mode, "simple");
        assert.equal(runtimeRead.triggers[triggerId].frequency, "once-per-turn");
        assert.equal(runtimeRead.triggers[triggerId].frequencyGroup, expectedGroup);
        assert.equal(runtimeRead.triggers[triggerId].damage.enabled, true);
      }
    }
  }
}

{
  const submitted = normalizePersistentZoneActivitySubmitData({
    schemaVersion: 3,
    enabled: true,
    geometry: { type: "circle", radius: 10 },
    triggers: {
      onCreate: { enabled: true, mode: "simple-effect", frequency: "once-per-turn", frequencyGroup: "mono-group" },
      enter: { enabled: false, mode: "none", frequency: "unlimited", frequencyGroup: "" }
    },
    parts: [{
      id: "primary",
      role: "primary",
      geometry: { type: "template" },
      triggers: { onCreate: { enabled: true, mode: "simple-effect", frequency: "once-per-turn", frequencyGroup: "part-group" } }
    }]
  });
  assert.equal(submitted.triggers.onCreate.frequency, "once-per-turn");
  assert.equal(submitted.triggers.onCreate.frequencyGroup, "mono-group");
  assert.equal(submitted.triggers.enter.frequency, "unlimited");
  assert.equal(submitted.parts[0].triggers.onCreate.frequency, "once-per-turn");
  assert.equal(submitted.parts[0].triggers.onCreate.frequencyGroup, "part-group");
  const runtimeDefinition = convert(submitted);
  assert.equal(runtimeDefinition.triggers.onCreate.frequency, "once-per-turn");
  assert.equal(runtimeDefinition.triggers.onCreate.frequencyGroup, "mono-group");
  const normalizedRuntime = normalize(submitted);
  for (const triggerId of ["onCreate", "onEnter"]) {
    assert.equal(normalizedRuntime.triggers[triggerId].enabled, triggerId === "onCreate");
    assert.equal(normalizedRuntime.triggers[triggerId].frequency, triggerId === "onCreate" ? "once-per-turn" : "unlimited");
  }
  assert.equal(normalizedRuntime.triggers.onCreate.mode, "simple");
  assert.equal(normalizedRuntime.triggers.onCreate.frequencyGroup, "mono-group");
  assert.equal(normalizedRuntime.parts[0].triggers.onCreate.frequency, "once-per-turn");
  assert.equal(normalizedRuntime.parts[0].triggers.onCreate.frequencyGroup, "part-group");
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
