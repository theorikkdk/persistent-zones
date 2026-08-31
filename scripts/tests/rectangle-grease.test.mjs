import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.game = { version: "14.367", settings: { settings: new Map() } };
globalThis.canvas = { scene: null, grid: { size: 100 } };
globalThis.CONFIG = { RegionBehavior: { dataModels: { "dnd5e.difficultTerrain": {} } } };

const { centerRectanglePosition, convertCanonicalDistanceToSceneUnits, distanceToScenePixels } = await import("../activity/activity-distance.mjs");
const { buildGeometryDefinition } = await import("../activity/persistent-zone-activity-utils.mjs");
const { buildLegacyDefinitionFromPersistentZoneActivity } = await import("../activity/persistent-zone-activity-utils.mjs");
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const {
  applyConfiguredTriggerEffect,
  findEquivalentTriggeredStatusSources,
  findRequiredAbsentStatusConflict,
  shouldApplyTriggeredStatus
} = await import("../runtime/entry-effects.mjs");
const { getPersistentZonePreset } = await import("../presets/preset-library.mjs");
const { registerPersistentZonePlacementContext, findPersistentZonePlacementContext } = await import("../runtime/persistent-zone-placement-context.mjs");
const { applyRegionOnCreateTrigger } = await import("../runtime/on-create-runtime.mjs");
const { testTokenInsideManagedRegion } = await import("../runtime/utils.mjs");
const { ensureNativeTerrainBehaviorsForAdoptedRegion } = await import("../runtime/region-factory.mjs");
const { createManagedRegionFromRegion } = await import("../runtime/region-factory.mjs");
const { getRegionRuntime } = await import("../runtime/utils.mjs");

test("canonical 10 feet converts to two cells on imperial and metric scenes", () => {
  const imperial = { grid: { units: "ft", distance: 5, size: 100 } };
  const metric = { grid: { units: "m", distance: 1.5, size: 100 } };
  assert.equal(convertCanonicalDistanceToSceneUnits(10, "ft", imperial), 10);
  assert.equal(distanceToScenePixels(10, "ft", imperial), 200);
  assert.equal(convertCanonicalDistanceToSceneUnits(10, "ft", metric), 3);
  assert.equal(distanceToScenePixels(10, "ft", metric), 200);
});

test("rectangle serialize and runtime normalization preserve dimensions and centered placement", () => {
  const geometry = buildGeometryDefinition("rectangle", { width: 10, height: 6, units: "ft" }, { activitySchemaVersion: 3 });
  assert.deepEqual(geometry, { type: "rectangle", width: 10, height: 6, units: "ft", placement: "center" });
  const normalized = normalizeZoneDefinition({
    enabled: true,
    template: { typeSource: "manual", type: "rect", distance: 10, width: 10, height: 6, units: "ft" },
    geometry
  });
  assert.deepEqual(normalized.geometry, geometry);
  assert.deepEqual(centerRectanglePosition({ x: 500, y: 400 }, { t: "rect" }, { widthPixels: 200, heightPixels: 120 }), { x: 400, y: 340 });
});

test("required-absent status prerequisite excludes an already Prone actor", () => {
  assert.equal(findRequiredAbsentStatusConflict({ statuses: new Set(["prone"]), effects: [] }, ["prone"]), "prone");
  assert.equal(findRequiredAbsentStatusConflict({ statuses: new Set(), effects: [] }, ["prone"]), null);
});

test("saved statuses on turn-end apply only on a failed save", () => {
  assert.equal(shouldApplyTriggeredStatus({ statusesConfigured: true, saveEnabled: true, saveResult: { success: true } }), false);
  assert.equal(shouldApplyTriggeredStatus({ statusesConfigured: true, saveEnabled: true, saveResult: { success: false } }), true);
});

test("Grease prerequisite and persistent Prone survive the Activity-to-runtime handoff", () => {
  const config = getPersistentZonePreset("srd-5.2.1.grease").persistentZone;
  const activity = { type: "persistent-zone", id: "grease", name: "Grease", persistentZone: config, target: { template: { type: "square", size: "10", units: "ft" } } };
  const runtime = normalizeZoneDefinition(buildLegacyDefinitionFromPersistentZoneActivity(activity, config));
  assert.deepEqual(runtime.triggers.onCreate.requiredAbsentStatuses, ["prone"]);
  assert.deepEqual(runtime.triggers.onEnter.requiredAbsentStatuses, ["prone"]);
  assert.deepEqual(runtime.triggers.onEndTurn.requiredAbsentStatuses, ["prone"]);
  assert.equal(runtime.triggers.onCreate.save.dcMode, "auto");
  assert.equal(runtime.triggers.onCreate.statuses.persistenceMode, "persistent");
  assert.equal(runtime.triggers.onEnter.statuses.persistenceMode, "persistent");
  assert.equal(runtime.triggers.onEndTurn.statuses.persistenceMode, "persistent");
});

test("an already Prone Actor skips before the native save for every Grease trigger", async () => {
  let saveCalls = 0;
  const actor = {
    uuid: "Actor.prone",
    statuses: new Set(["prone"]),
    effects: [],
    async rollSavingThrow() { saveCalls += 1; return [{ total: 1 }]; }
  };
  const presetConfig = getPersistentZonePreset("srd-5.2.1.grease").persistentZone;
  const runtime = normalizeZoneDefinition(buildLegacyDefinitionFromPersistentZoneActivity({
    type: "persistent-zone",
    id: "grease",
    name: "Grease",
    persistentZone: presetConfig
  }, presetConfig));
  const regionDocument = {
    id: "grease-region",
    flags: { "persistent-zones": { runtime: { normalizedDefinition: runtime, groupId: "grease-group", partId: "primary" } } },
    toObject() { return { flags: this.flags }; }
  };
  const tokenDocument = { id: "target", uuid: "Scene.scene.Token.target", actor };
  for (const [timing, trigger] of [["onCreate", runtime.triggers.onCreate], ["onEnter", runtime.triggers.onEnter], ["onEndTurn", runtime.triggers.onEndTurn]]) {
    const result = await applyConfiguredTriggerEffect({ regionDocument, tokenDocument, triggerConfig: trigger, timing });
    assert.equal(result.skipped, true);
    assert.equal(result.requiredAbsentStatus, "prone");
  }
  assert.equal(saveCalls, 0);
});

test("status source identity deduplicates triggers but preserves Regions, parts, and statuses", () => {
  const actor = { effects: [
    statusSource("a-legacy", { regionId: "region-a", triggerId: "enter", statusId: "prone" }),
    statusSource("a-create", { regionId: "region-a", partId: "primary", triggerId: "create", statusId: "prone" }),
    statusSource("a-turn", { regionId: "region-a", partId: "primary", triggerId: "turnEnd", statusId: "prone" }),
    statusSource("b-create", { regionId: "region-b", partId: "primary", triggerId: "create", statusId: "prone" }),
    statusSource("a-secondary", { regionId: "region-a", partId: "secondary", triggerId: "create", statusId: "prone" }),
    statusSource("a-poisoned", { regionId: "region-a", partId: "primary", triggerId: "create", statusId: "poisoned" })
  ] };
  const equivalent = findEquivalentTriggeredStatusSources(actor, {
    regionId: "region-a", partId: "primary", tokenUuid: "Token.target", statusId: "prone"
  });
  assert.deepEqual(equivalent.map((effect) => effect.id), ["a-legacy", "a-create", "a-turn"]);
});

function statusSource(id, flags) {
  return {
    id,
    uuid: `Actor.target.ActiveEffect.${id}`,
    active: true,
    flags: { "persistent-zones": { managedTriggeredEffect: true, tokenUuid: "Token.target", ...flags } }
  };
}

test("rectangle placement identity matches native rectangle and polygon Regions", () => {
  const context = registerPersistentZonePlacementContext({
    userId: "user", sceneId: "scene", itemUuid: "Item.grease",
    activityId: "grease", activityUuid: "Item.grease.Activity.grease",
    activityType: "persistent-zone", geometryType: "rectangle"
  });
  assert.ok(context);
  assert.equal(findPersistentZonePlacementContext({ userId: "user", sceneId: "scene", itemUuid: "Item.grease", regionShapeType: "rectangle" })?.activityId, "grease");
  assert.equal(findPersistentZonePlacementContext({ userId: "user", sceneId: "scene", itemUuid: "Item.grease", regionShapeType: "polygon" })?.activityId, "grease");
});

test("an active Rectangle context may claim a square-shaped line without reclassifying a real Wall", () => {
  registerPersistentZonePlacementContext({
    userId: "shape-user", sceneId: "shape-scene", itemUuid: "Item.grease-line",
    activityId: "grease-line", activityUuid: "Item.grease-line.Activity.grease-line",
    activityType: "persistent-zone", geometryType: "rectangle",
    targetTemplateType: "square", nativeTemplateType: "rect"
  });
  const rectangle = findPersistentZonePlacementContext({
    userId: "shape-user", sceneId: "shape-scene", regionShapeType: "line"
  });
  assert.equal(rectangle?.geometryType, "rectangle");
  assert.equal(rectangle?.activityId, "grease-line");

  registerPersistentZonePlacementContext({
    userId: "shape-user", sceneId: "shape-scene", itemUuid: "Item.wall",
    activityId: "wall", activityUuid: "Item.wall.Activity.wall",
    activityType: "persistent-zone", geometryType: "wall",
    targetTemplateType: "wall", nativeTemplateType: "ray"
  });
  const wall = findPersistentZonePlacementContext({
    userId: "shape-user", sceneId: "shape-scene", regionShapeType: "line"
  });
  assert.equal(wall?.geometryType, "wall");
  assert.equal(wall?.activityId, "wall");
});

test("native rectangle membership and onCreate use the same managed Region", async () => {
  const runtime = {
    geometryType: "rectangle",
    normalizedDefinition: {
      enabled: true,
      geometry: { type: "rectangle" },
      targeting: { mode: "all" },
      triggers: { onCreate: { enabled: true, mode: "simple", save: { enabled: true, ability: "dex", dcMode: "auto" } } }
    }
  };
  const region = {
    id: "rect-region",
    flags: { "persistent-zones": { runtime } },
    shapes: [{ type: "rectangle", x: 0, y: 0, width: 200, height: 200, rotation: 0 }],
    toObject() { return { flags: this.flags, shapes: this.shapes }; },
    async update(changes) { runtime.onCreateTriggerCompleted = changes["flags.persistent-zones.runtime.onCreateTriggerCompleted"]; }
  };
  const token = { id: "token", x: 50, y: 50, width: 1, height: 1, actor: { uuid: "Actor.target" } };
  assert.equal(testTokenInsideManagedRegion(token, region), true);
  let calls = 0;
  const result = await applyRegionOnCreateTrigger(region, {
    collectCandidates: () => [token],
    applyEffect: async () => { calls += 1; return { applied: true, skipped: false }; },
    settle: async () => {}
  });
  assert.equal(result.applied, true);
  assert.equal(calls, 1);
});

test("adopted rectangle receives the native difficult-terrain behavior once", async () => {
  const behaviors = [];
  const region = {
    id: "rect-terrain",
    shapes: [{ type: "rectangle" }],
    behaviors: { contents: behaviors },
    async createEmbeddedDocuments(documentName, payloads) {
      assert.equal(documentName, "RegionBehavior");
      behaviors.push(...payloads.map((payload, index) => ({ ...payload, id: `behavior-${index}` })));
      return behaviors;
    }
  };
  const definition = { label: "Grease", terrain: { difficult: true, multiplier: 2, behaviorType: "dnd5e.difficultTerrain", system: {} } };
  await ensureNativeTerrainBehaviorsForAdoptedRegion(region, definition, {});
  await ensureNativeTerrainBehaviorsForAdoptedRegion(region, definition, {});
  assert.equal(behaviors.length, 1);
  assert.equal(behaviors[0].type, "dnd5e.difficultTerrain");
});

test("real V14 direct Region path adopts a square-shaped line as Rectangle without a MeasuredTemplate", async () => {
  const config = structuredClone(getPersistentZonePreset("srd-5.2.1.grease").persistentZone);
  const actor = {
    id: "actor", uuid: "Actor.actor", effects: [],
    async createEmbeddedDocuments(documentName, payloads) {
      assert.equal(documentName, "ActiveEffect");
      const effects = payloads.map((payload, index) => ({
        ...payload,
        id: `owner-${index}`,
        uuid: `Actor.actor.ActiveEffect.owner-${index}`,
        documentName: "ActiveEffect",
        parent: actor,
        toObject() { return structuredClone({ ...payload, _id: this.id }); }
      }));
      actor.effects.push(...effects);
      return effects;
    }
  };
  const item = {
    id: "grease-item", uuid: "Actor.actor.Item.grease-item", name: "Grease", actor,
    system: { duration: { value: 1, units: "minute" }, activities: new Map() }
  };
  const activity = {
    id: "grease", uuid: `${item.uuid}.Activity.grease`, type: "persistent-zone", name: "Grease",
    item, persistentZone: config, _source: { persistentZone: config }, duration: { concentration: false }
  };
  item.system.activities.set(activity.id, activity);
  const regions = new Map();
  const scene = {
    id: "scene-real", uuid: "Scene.scene-real", grid: { units: "m", distance: 1.5, size: 100 },
    templates: { contents: [] }, tokens: { contents: [] }, regions,
    async createEmbeddedDocuments() { throw new Error("No replacement Region should be created during adoption."); }
  };
  const behaviors = [];
  const region = {
    id: "rect-real", uuid: `${scene.uuid}.Region.rect-real`, name: "Grease", documentName: "Region", parent: scene,
    flags: { dnd5e: { activityId: activity.id } },
    shapes: [{ type: "line", x: 0, y: 100, width: 200, distance: 200, length: 200, rotation: 0 }],
    behaviors: { contents: behaviors },
    toObject() { return structuredClone({ name: this.name, flags: this.flags, shapes: this.shapes }); },
    getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
    async setFlag(scope, key, value) { this.flags[scope] ??= {}; this.flags[scope][key] = structuredClone(value); return this; },
    async update(changes) {
      for (const [key, value] of Object.entries(changes)) {
        if (key === "flags") this.flags = structuredClone(value);
        else if (key.startsWith("flags.persistent-zones.runtime")) {
          this.flags["persistent-zones"] ??= {};
          if (key === "flags.persistent-zones.runtime") this.flags["persistent-zones"].runtime = structuredClone(value);
          else {
            this.flags["persistent-zones"].runtime ??= {};
            const runtimeKey = key.slice("flags.persistent-zones.runtime.".length);
            this.flags["persistent-zones"].runtime[runtimeKey] = structuredClone(value);
          }
        }
      }
      return this;
    },
    async createEmbeddedDocuments(documentName, payloads) {
      assert.equal(documentName, "RegionBehavior");
      behaviors.push(...payloads.map((payload, index) => ({ ...payload, id: `terrain-${index}` })));
      return behaviors;
    }
  };
  regions.set(region.id, region);
  globalThis.game = {
    version: "14.367", user: { id: "user-real", isGM: true }, users: { activeGM: { id: "user-real" } },
    settings: { settings: new Map(), get: () => null }, scenes: { contents: [scene] }, actors: { contents: [actor] }
  };
  globalThis.canvas = { scene, grid: { size: 100 }, tokens: { placeables: [] }, regions: { placeables: [] } };
  globalThis.CONFIG.ActiveEffect = { durationUnits: { minute: "Minute" } };
  globalThis.fromUuid = async (uuid) => uuid === item.uuid ? item : null;
  registerPersistentZonePlacementContext({
    userId: "user-real", sceneId: scene.id, itemUuid: item.uuid,
    activityId: activity.id, activityUuid: activity.uuid, activityType: activity.type,
    geometryType: "rectangle", targetTemplateType: "square", nativeTemplateType: "rect"
  });

  assert.equal(getRegionRuntime(region), null);
  const result = await createManagedRegionFromRegion(region, { userId: "user-real", source: "test-real-v14" });
  const runtime = getRegionRuntime(region);
  assert.equal(result.handled, true);
  assert.ok(runtime);
  assert.equal(runtime.itemUuid, item.uuid);
  assert.equal(runtime.activityId, activity.id);
  assert.equal(runtime.normalizedDefinition.geometry.type, "rectangle");
  assert.equal(runtime.normalizedDefinition.triggers.onCreate.save.ability, "dex");
  assert.equal(runtime.normalizedDefinition.terrain.difficult, true);
  assert.ok(runtime.groupId);
  assert.ok(runtime.ownerEffectUuid);
  assert.equal(behaviors.some((behavior) => behavior.type === "dnd5e.difficultTerrain"), true);
});
