import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../module.json", import.meta.url), "utf8"));
const behaviorTypes = Object.keys(manifest.documentTypes.RegionBehavior).map((type) => `${manifest.id}.${type}`);

class RegionBehaviorType {}
class NumberField { constructor(options) { this.options = options; } }
class StringField { constructor(options) { this.options = options; } }
class SchemaField { constructor(fields) { this.fields = fields; } }

globalThis.foundry = {
  data: { regionBehaviors: { RegionBehaviorType }, fields: { NumberField, StringField, SchemaField } },
  utils: { deepClone: structuredClone }
};
globalThis.game = {
  version: "13.0",
  model: { RegionBehavior: Object.fromEntries(behaviorTypes.map((type) => [type, {}])) },
  settings: { settings: new Map() }
};
globalThis.canvas = { scene: null, grid: { size: 100 } };
globalThis.CONST = { TOKEN_DISPOSITIONS: { HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 } };
globalThis.CONFIG = {
  RegionBehavior: {
    dataModels: {
      "dnd5e.difficultTerrain": {},
      modifyMovementCost: {},
      "persistent-zones.attachedEmanation": {}
    },
    typeIcons: {},
    documentClass: { get TYPES() { return Object.keys(game.model.RegionBehavior); } }
  },
  Token: { movement: { actions: { walk: {}, fly: {} } } }
};

const { FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE } = await import("../constants.mjs");
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const { ensureNativeTerrainBehaviorsForAdoptedRegion } = await import("../runtime/region-factory.mjs");
const {
  buildFilteredMovementCostBehaviorData,
  getFilteredMovementCostTerrainEffects,
  registerFilteredMovementCostRegionBehavior
} = await import("../runtime/filtered-movement-cost-runtime.mjs");

function token({ id, actorUuid, disposition, scene }) {
  return { id, uuid: `Scene.scene.Token.${id}`, disposition, actor: { uuid: actorUuid }, parent: scene };
}

function region({ scene, sourceToken, normalizedDefinition = {} }) {
  const runtime = {
    actorUuid: sourceToken.actor.uuid,
    sourceTokenUuid: sourceToken.uuid,
    sourceDisposition: sourceToken.disposition,
    normalizedDefinition: { targeting: { mode: "all" }, ...normalizedDefinition }
  };
  return {
    parent: scene,
    flags: { "persistent-zones": { runtime } },
    toObject: () => ({ flags: { "persistent-zones": { runtime } } })
  };
}

function effectsFor(mode, target, multiplier = 4) {
  const scene = { tokens: { contents: [] } };
  const source = token({ id: "source", actorUuid: "Actor.source", disposition: 1, scene });
  const targetToken = token({ id: target.id, actorUuid: target.actorUuid, disposition: target.disposition, scene });
  scene.tokens.contents = [source, targetToken];
  return getFilteredMovementCostTerrainEffects({
    regionDocument: region({ scene, sourceToken: source }),
    tokenDocument: targetToken,
    multiplier,
    targetFilter: { mode }
  });
}

test("filtered movement RegionBehavior is manifest-backed and registered at init", () => {
  assert.ok(behaviorTypes.includes(FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE));
  assert.equal(registerFilteredMovementCostRegionBehavior(), true);
  const Model = CONFIG.RegionBehavior.dataModels[FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE];
  assert.equal(typeof Model, "function");
  const schema = Model.defineSchema();
  assert.deepEqual(schema.targetFilter.fields.mode.options.choices, ["all", "allies", "enemies", "self", "others"]);
  assert.deepEqual(buildFilteredMovementCostBehaviorData({ multiplier: 4, targetFilter: { mode: "enemies" } }).system, {
    multiplier: 4,
    targetFilter: { mode: "enemies" }
  });
  const moduleSource = readFileSync(new URL("../module.mjs", import.meta.url), "utf8");
  assert.ok(moduleSource.indexOf("registerFilteredMovementCostRegionBehavior();") < moduleSource.indexOf("registerPersistentZoneActivityType();"));
});

test("legacy and explicit all terrain filters retain native behaviors", () => {
  for (const terrain of [
    { enabled: true, multiplier: 2 },
    { enabled: true, multiplier: 2, targetFilter: { mode: "all" } },
    { enabled: true, multiplier: 4, targetFilter: { mode: "all" } }
  ]) {
    const normalized = normalizeZoneDefinition({ geometry: { type: "circle", radius: 10 }, terrain });
    assert.equal(normalized.terrain.targetFilter.mode, "all");
    assert.equal(normalized.terrain.behaviorType, terrain.multiplier === 2 ? "dnd5e.difficultTerrain" : "modifyMovementCost");
  }
});

test("filtered terrain selects the PZ behavior for multiplier two and four", async () => {
  for (const multiplier of [2, 4]) {
    const normalized = normalizeZoneDefinition({
      geometry: { type: "circle", radius: 10 },
      terrain: { enabled: true, multiplier, targetFilter: { mode: "enemies" } }
    });
    assert.equal(normalized.terrain.behaviorType, FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE);
    const behaviors = [];
    const regionDocument = {
      behaviors: { contents: behaviors },
      async createEmbeddedDocuments(_type, payloads) { behaviors.push(...payloads); }
    };
    await ensureNativeTerrainBehaviorsForAdoptedRegion(regionDocument, normalized, {});
    assert.equal(behaviors.length, 1);
    assert.equal(behaviors[0].type, FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE);
    assert.equal(behaviors[0].system.multiplier, multiplier);
    assert.equal(behaviors[0].system.targetFilter.mode, "enemies");
  }
});

test("filtered terrain preserves trigger target semantics for every mode including neutral tokens", () => {
  const source = { id: "source", actorUuid: "Actor.source", disposition: 1 };
  const friendly = { id: "friendly", actorUuid: "Actor.friendly", disposition: 1 };
  const hostile = { id: "hostile", actorUuid: "Actor.hostile", disposition: -1 };
  const neutral = { id: "neutral", actorUuid: "Actor.neutral", disposition: 0 };

  assert.deepEqual(effectsFor("all", hostile), [{ name: "difficulty", difficulty: 4 }]);
  assert.deepEqual(effectsFor("allies", source), [{ name: "difficulty", difficulty: 4 }]);
  assert.deepEqual(effectsFor("allies", friendly), [{ name: "difficulty", difficulty: 4 }]);
  assert.deepEqual(effectsFor("allies", hostile), []);
  assert.deepEqual(effectsFor("enemies", hostile), [{ name: "difficulty", difficulty: 4 }]);
  assert.deepEqual(effectsFor("enemies", friendly), []);
  assert.deepEqual(effectsFor("enemies", neutral), []);
  assert.deepEqual(effectsFor("self", source), [{ name: "difficulty", difficulty: 4 }]);
  assert.deepEqual(effectsFor("self", friendly), []);
  assert.deepEqual(effectsFor("others", source), []);
  assert.deepEqual(effectsFor("others", neutral), [{ name: "difficulty", difficulty: 4 }]);
  assert.deepEqual(effectsFor("allies", friendly, 2), [{ name: "difficulty", difficulty: 2 }]);
});

test("multipart terrain inherits the global filter and accepts a per-part override", () => {
  const normalized = normalizeZoneDefinition({
    source: "activity",
    schemaVersion: 3,
    geometry: { type: "circle", radius: 10 },
    terrain: { enabled: true, multiplier: 4, targetFilter: { mode: "enemies" } },
    parts: [
      { id: "inherited", geometry: { type: "template" }, terrain: { enabled: true, multiplier: 4 } },
      { id: "override", geometry: { type: "template" }, terrain: { enabled: true, multiplier: 4, targetFilter: { mode: "allies" } } }
    ]
  });
  assert.equal(normalized.parts[0].terrain.targetFilter.mode, "enemies");
  assert.equal(normalized.parts[1].terrain.targetFilter.mode, "allies");
  assert.ok(normalized.parts.every((part) => part.terrain.behaviorType === FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE));
});

test("wall-restricted terrain remains structurally compatible with filtered movement cost", async () => {
  const normalized = normalizeZoneDefinition({
    geometry: { type: "circle", radius: 10 },
    terrain: { enabled: true, multiplier: 4, targetFilter: { mode: "enemies" } },
    obstacles: { mode: "wall-restricted", restrictionType: "move", priority: 0, levelId: "level-a" }
  });
  const behaviors = [];
  const regionDocument = {
    behaviors: { contents: behaviors },
    async createEmbeddedDocuments(_type, payloads) { behaviors.push(...payloads); }
  };
  await ensureNativeTerrainBehaviorsForAdoptedRegion(regionDocument, normalized, {});
  assert.ok(behaviors.some((behavior) => behavior.type === FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE));
});
