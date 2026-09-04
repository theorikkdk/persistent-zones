import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.game = {
  version: "14.367",
  settings: { settings: new Map() },
  user: { isGM: true, character: null },
  i18n: { localize: (key) => key }
};
globalThis.canvas = { scene: { grid: { units: "m", distance: 1.5, size: 100 } }, grid: { size: 100 }, tokens: { controlled: [] } };
globalThis.CONFIG = { RegionBehavior: { dataModels: {} } };

const { getPersistentZonePreset } = await import("../presets/preset-library.mjs");
const { resolvePresetPersistentZoneForScene } = await import("../presets/preset-utils.mjs");
const { getPersistentZoneActivityDefinition } = await import("../activity/persistent-zone-activity-utils.mjs");
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const { resolveScaledFormula } = await import("../runtime/damage-scaling.mjs");
const { claimTriggerFrequency } = await import("../runtime/trigger-frequency.mjs");
const { createCloudkillTestItem } = await import("../runtime/debug-tools.mjs");

const CLOUDKILL_ID = "srd-5.2.1.cloudkill";
const TIMINGS = ["onCreate", "enter", "turnEnd"];

test("Cloudkill composes obscuration, movement restriction, translation, and shared poison damage", () => {
  const zone = getPersistentZonePreset(CLOUDKILL_ID).persistentZone;
  assert.deepEqual(zone.geometry, { type: "circle", radius: 20, units: "ft" });
  assert.deepEqual(zone.obstacles, { mode: "wall-restricted", restrictionType: "move", priority: 0 });
  assert.deepEqual(zone.obscuration, { mode: "heavily-obscured" });
  assert.deepEqual(zone.translation, {
    enabled: true, trigger: "source-turn-start", distance: 10, units: "ft", direction: "away-from-source"
  });
  assert.equal(zone.terrain.enabled, false);
  for (const timing of TIMINGS) {
    const trigger = zone.triggers[timing];
    assert.equal(trigger.enabled, true, timing);
    assert.equal(trigger.frequency, "once-per-turn", timing);
    assert.equal(trigger.frequencyGroup, "cloudkill-damage", timing);
    assert.deepEqual(trigger.simpleEffect.save, { enabled: true, ability: "con", dcMode: "inherit", dc: null, onSave: "half" }, timing);
    assert.equal(trigger.simpleEffect.damage.formula, "5d8", timing);
    assert.equal(trigger.simpleEffect.damage.type, "poison", timing);
    assert.deepEqual(trigger.simpleEffect.damage.scaling, {
      mode: "per-level", baseLevelMode: "item", baseLevel: 5, perLevelFormula: "1d8"
    }, timing);
  }
});

test("Cloudkill resolves its canonical radius and translation distance for metric scenes", () => {
  const resolved = resolvePresetPersistentZoneForScene(getPersistentZonePreset(CLOUDKILL_ID).persistentZone, globalThis.canvas.scene);
  assert.deepEqual(resolved.geometry, { type: "circle", radius: 6, units: "m" });
  assert.deepEqual(resolved.translation, {
    enabled: true, trigger: "source-turn-start", distance: 3, units: "m", direction: "away-from-source"
  });
});

test("Cloudkill stores generic slot scaling in normalized runtime data", () => {
  const preset = getPersistentZonePreset(CLOUDKILL_ID);
  const item = { uuid: "Actor.caster.Item.cloudkill", system: { level: 5 } };
  const definition = getPersistentZoneActivityDefinition({
    id: "cloudkill", uuid: "Actor.caster.Item.cloudkill.Activity.cloudkill", type: "persistent-zone", name: "Cloudkill",
    persistentZone: preset.persistentZone, _source: { persistentZone: preset.persistentZone }, item
  });
  const normalized = normalizeZoneDefinition({ ...definition, castLevel: 7 }, { item });
  assert.equal(normalized.obscuration.mode, "heavily-obscured");
  assert.equal(normalized.obstacles.restrictionType, "move");
  assert.equal(normalized.translation.enabled, true);
  assert.equal(normalized.translation.distance, 10);
  const damage = normalized.triggers.onEnter.damage;
  assert.equal(resolveScaledFormula({ formula: damage.formula, scaling: damage.scaling, castLevel: normalized.castLevel }).formula, "5d8 + (1d8) + (1d8)");
});

test("Cloudkill frequency group shares its once-per-turn limit across appearance, entry, and turn end", async () => {
  const zone = getPersistentZonePreset(CLOUDKILL_ID).persistentZone;
  const runtime = { groupId: "cloudkill-cast", triggerFrequencyLedger: [] };
  const region = {
    id: "cloudkill-region", flags: { "persistent-zones": { runtime } }, getFlag: () => runtime,
    async update(changes) { runtime.triggerFrequencyLedger = changes["flags.persistent-zones.runtime.triggerFrequencyLedger"]; }
  };
  const token = { id: "target", uuid: "Scene.scene.Token.target" };
  const combat = { id: "combat", started: true, round: 1, turn: 1, combatant: { id: "target-combatant", tokenId: "target" } };
  for (const [timing, key] of [["onCreate", "onCreate"], ["onEnter", "enter"], ["onEndTurn", "turnEnd"]]) {
    const result = await claimTriggerFrequency({ regionDocument: region, tokenDocument: token, triggerConfig: zone.triggers[key], timing, combat });
    assert.equal(result.allowed, timing === "onCreate", `${timing} should share the Cloudkill frequency group`);
  }
  const nextTurn = await claimTriggerFrequency({
    regionDocument: region, tokenDocument: token, triggerConfig: zone.triggers.turnEnd, timing: "onEndTurn",
    combat: { ...combat, turn: 2, combatant: { id: "target-next", tokenId: "target" } }
  });
  assert.equal(nextTurn.allowed, true);
});

test("Cloudkill Debug/Test helper creates a ready-to-cast level-five spell and Activity", async () => {
  const previousItem = globalThis.Item;
  const captured = { item: null, activity: null };
  const item = {
    id: "debug-cloudkill", uuid: "Actor.caster.Item.debug-cloudkill", system: { activities: new Map() },
    async createActivity(type, source, options) {
      assert.equal(type, "persistent-zone");
      assert.equal(options.renderSheet, false);
      captured.activity = source;
      this.system.activities.set("cloudkill", { id: "cloudkill", ...source });
    }
  };
  const owner = {
    async createEmbeddedDocuments(type, sources) {
      assert.equal(type, "Item");
      captured.item = sources[0];
      return [item];
    },
    async deleteEmbeddedDocuments() { throw new Error("cleanup should not run"); }
  };
  try {
    const result = await createCloudkillTestItem({ actor: owner });
    assert.equal(result.ok, true);
    assert.equal(captured.item.system.level, 5);
    assert.equal(captured.item.system.duration.concentration, true);
    assert.equal(captured.item.system.range.value, 36);
    assert.equal(captured.item.system.range.units, "m");
    assert.equal(captured.activity.target.template.size, 6);
    assert.equal(captured.activity.target.template.units, "m");
    assert.equal(captured.activity.persistentZone.translation.distance, 3);
    assert.equal(captured.activity.persistentZone.triggers.enter.simpleEffect.damage.formula, "5d8");
  } finally {
    globalThis.Item = previousItem;
  }
});
