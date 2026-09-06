import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.game = { version: "14.367", settings: { settings: new Map() }, user: { isGM: true }, i18n: { localize: (key) => key } };
globalThis.canvas = { scene: { grid: { units: "m", distance: 1.5, size: 100 } }, grid: { size: 100 }, tokens: { controlled: [] } };

const { getPersistentZonePreset } = await import("../presets/preset-library.mjs");
const { resolvePresetPersistentZoneForScene } = await import("../presets/preset-utils.mjs");
const { getPersistentZoneActivityDefinition } = await import("../activity/persistent-zone-activity-utils.mjs");
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const { resolveScaledFormula } = await import("../runtime/damage-scaling.mjs");
const { createFlamingSphereTestItem } = await import("../runtime/debug-tools.mjs");

const ID = "srd-5.2.1.flaming-sphere";

test("Flaming Sphere composes physical contact, proximity, scaling, and linked light without membership targeting", () => {
  const zone = getPersistentZonePreset(ID).persistentZone;
  assert.deepEqual(zone.geometry, { type: "circle", radius: 2.5, units: "ft" });
  assert.deepEqual(zone.obstacles, { mode: "wall-restricted", restrictionType: "move", priority: 0 });
  assert.deepEqual(zone.controlledMovement, {
    enabled: true, maxDistance: 30, physicalRadius: 2.5, units: "ft",
    utilityName: "PERSISTENT_ZONES.Activity.Presets.Builtins.FlamingSphere.MoveActivityName"
  });
  assert.deepEqual(zone.linkedLights, { enabled: true, preset: "fire", bright: 20, dim: 40, max: 1, color: "#ff9b42" });
  assert.deepEqual(zone.triggers.move.targeting, { mode: "physical-contact", distance: null });
  assert.deepEqual(zone.triggers.turnEnd.targeting, { mode: "proximity", distance: 5 });
  for (const trigger of [zone.triggers.move, zone.triggers.turnEnd]) {
    assert.equal(trigger.frequency, "unlimited");
    assert.equal(trigger.frequencyGroup, "");
    assert.deepEqual(trigger.simpleEffect.save, { enabled: true, ability: "dex", dcMode: "inherit", dc: null, onSave: "half" });
    assert.equal(trigger.simpleEffect.damage.formula, "2d6");
    assert.equal(trigger.simpleEffect.damage.type, "fire");
    assert.deepEqual(trigger.simpleEffect.damage.scaling, { mode: "per-level", baseLevelMode: "item", baseLevel: 2, perLevelFormula: "1d6" });
  }
});

test("Flaming Sphere resolves metric geometry, contact body, proximity, movement, and light", () => {
  const resolved = resolvePresetPersistentZoneForScene(getPersistentZonePreset(ID).persistentZone, canvas.scene);
  assert.equal(resolved.geometry.radius, 0.75);
  assert.equal(resolved.geometry.units, "m");
  assert.equal(resolved.controlledMovement.physicalRadius, 0.75);
  assert.equal(resolved.controlledMovement.maxDistance, 9);
  assert.equal(resolved.triggers.turnEnd.targeting.distance, 1.5);
  assert.equal(resolved.linkedLights.bright, 6);
  assert.equal(resolved.linkedLights.dim, 12);
});

test("Flaming Sphere keeps generic slot scaling and targeting through Activity definition normalization", () => {
  const item = { uuid: "Actor.caster.Item.flaming-sphere", system: { level: 2 } };
  const zone = getPersistentZonePreset(ID).persistentZone;
  const definition = getPersistentZoneActivityDefinition({ id: "sphere", type: "persistent-zone", persistentZone: zone, _source: { persistentZone: zone }, item });
  const normalized = normalizeZoneDefinition({ ...definition, castLevel: 4 }, { item });
  assert.equal(normalized.triggers.onMove.targeting.mode, "physical-contact");
  assert.equal(normalized.triggers.onEndTurn.targeting.mode, "proximity");
  assert.equal(resolveScaledFormula({ formula: normalized.triggers.onMove.damage.formula, scaling: normalized.triggers.onMove.damage.scaling, castLevel: 4 }).formula, "2d6 + (1d6) + (1d6)");
});

test("Flaming Sphere Debug/Test helper creates a ready cast with one named Bonus Action companion", async () => {
  const captured = { item: null, activities: [] };
  const item = {
    id: "debug-sphere", uuid: "Actor.caster.Item.debug-sphere", system: { activities: new Map() },
    async createActivity(type, source) {
      const id = type === "utility" ? "move-sphere" : "sphere";
      const activity = { id, type, item: this, flags: structuredClone(source.flags), _source: structuredClone(source), persistentZone: source.persistentZone };
      this.system.activities.set(id, activity);
      captured.activities.push({ type, source: structuredClone(source) });
    },
    async updateActivity(id, update) {
      const activity = this.system.activities.get(id);
      if (update.persistentZone) activity.persistentZone = structuredClone(update.persistentZone);
      if (update.flags) activity.flags = structuredClone(update.flags);
    }
  };
  const actor = {
    async createEmbeddedDocuments(_type, sources) { captured.item = sources[0]; return [item]; },
    async deleteEmbeddedDocuments() { throw new Error("cleanup should not run"); }
  };
  const result = await createFlamingSphereTestItem({ actor });
  assert.equal(result.ok, true);
  assert.equal(captured.item.system.level, 2);
  assert.equal(captured.item.system.range.value, 18);
  assert.equal(result.utilityActivityId, "move-sphere");
  const utility = captured.activities.find((entry) => entry.type === "utility").source;
  assert.equal(utility.activation.type, "bonus");
  assert.equal(utility.name, "Move Zone", "falls back safely when i18n is not loaded");
  assert.equal(utility.duration.concentration, false);
  assert.equal(utility.consumption.spellSlot, false);
});
