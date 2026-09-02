import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.game = { version: "14.367", settings: { settings: new Map() } };
globalThis.canvas = { scene: null, grid: { size: 100 } };
globalThis.CONFIG = {
  RegionBehavior: {
    dataModels: {
      "dnd5e.difficultTerrain": {},
      modifyMovementCost: {}
    }
  },
  Token: {
    movement: {
      actions: {
        walk: {},
        fly: {},
        crawl: { terrainAction: "walk" },
        jump: { deriveTerrainDifficulty: () => 1 }
      }
    }
  }
};

const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const { ensureNativeTerrainBehaviorsForAdoptedRegion } = await import("../runtime/region-factory.mjs");
const { buildLegacyDefinitionFromPersistentZoneActivity } = await import("../activity/persistent-zone-activity-utils.mjs");

function normalizeTerrain(terrain) {
  return normalizeZoneDefinition({
    label: "Movement Cost",
    geometry: { type: "circle", radius: 10 },
    terrain
  });
}

test("standard multiplier 2 preserves the D&D5e difficult-terrain behavior", () => {
  const normalized = normalizeTerrain({ enabled: true, multiplier: 2 });
  assert.equal(normalized.terrain.difficult, true);
  assert.equal(normalized.terrain.multiplier, 2);
  assert.equal(normalized.terrain.behaviorType, "dnd5e.difficultTerrain");
});

test("custom multiplier 4 selects Foundry's native modifyMovementCost behavior", async () => {
  const normalized = normalizeTerrain({ enabled: true, multiplier: 4 });
  assert.equal(normalized.terrain.difficult, true);
  assert.equal(normalized.terrain.multiplier, 4);
  assert.equal(normalized.terrain.behaviorType, "modifyMovementCost");

  const behaviors = [];
  const region = {
    behaviors: { contents: behaviors },
    async createEmbeddedDocuments(documentName, payloads) {
      assert.equal(documentName, "RegionBehavior");
      behaviors.push(...payloads.map((payload, index) => ({ ...payload, id: `behavior-${index}` })));
      return behaviors;
    }
  };
  await ensureNativeTerrainBehaviorsForAdoptedRegion(region, normalized, {});
  assert.equal(behaviors.length, 1);
  assert.equal(behaviors[0].type, "modifyMovementCost");
  assert.deepEqual(behaviors[0].system, { difficulties: { walk: 4, fly: 4 } });
});

test("absent terrain remains unrestricted and produces no movement-cost behavior", () => {
  const normalized = normalizeTerrain({});
  assert.equal(normalized.terrain.difficult, false);
  assert.equal(normalized.terrain.multiplier, null);
  assert.equal(normalized.terrain.behaviorType, null);
});

test("custom movement cost is bounded by Foundry's native maximum", () => {
  const normalized = normalizeTerrain({ enabled: true, multiplier: 9 });
  assert.equal(normalized.terrain.multiplier, 5);
  assert.equal(normalized.terrain.behaviorType, "modifyMovementCost");
});

test("Activity terrain multiplier survives the Activity-to-runtime handoff", () => {
  const definition = buildLegacyDefinitionFromPersistentZoneActivity({
    id: "movement-cost",
    name: "Movement Cost",
    target: { template: { units: "ft", size: 10 } },
    duration: {}
  }, {
    schemaVersion: 3,
    enabled: true,
    geometry: { type: "circle", radius: 10, units: "ft" },
    terrain: { enabled: true, multiplier: 4 }
  });
  assert.deepEqual(definition.terrain, { enabled: true, multiplier: 4 });
  assert.equal(normalizeZoneDefinition(definition).terrain.behaviorType, "modifyMovementCost");
});
