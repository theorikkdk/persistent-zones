import assert from "node:assert/strict";
import test from "node:test";

import { getPersistentZoneActivityDefinition } from "../activity/persistent-zone-activity-utils.mjs";
import { getPersistentZonePreset } from "../presets/preset-library.mjs";
import { resolvePresetPersistentZoneForScene } from "../presets/preset-utils.mjs";
import { claimTriggerFrequency } from "../runtime/trigger-frequency.mjs";
import { normalizeZoneDefinition } from "../runtime/zone-definition.mjs";

globalThis.foundry ??= { utils: { deepClone: structuredClone } };
globalThis.game ??= { version: "14.367", settings: { settings: new Map() } };
globalThis.canvas ??= { scene: null, grid: { size: 100 } };

const PRESET_ID = "srd-5.2.1.insect-plague";
const FREQUENCY_GROUP = "insect-plague-save";

test("Insect Plague builtin represents the exact supported SRD base mechanics", () => {
  const zone = getPersistentZonePreset(PRESET_ID).persistentZone;
  assert.deepEqual(zone.geometry, { type: "circle", radius: 20, units: "ft" });
  assert.deepEqual(zone.terrain, { enabled: true, multiplier: 2 });
  assert.equal(zone.parts.length, 0);
  assert.equal(zone.linkedWalls.enabled, false);
  assert.equal(zone.linkedLights.enabled, false);

  for (const timing of ["onCreate", "enter", "turnEnd"]) {
    const trigger = zone.triggers[timing];
    assert.equal(trigger.enabled, true);
    assert.equal(trigger.targetFilter.mode, "all");
    assert.equal(trigger.frequency, "once-per-turn");
    assert.equal(trigger.frequencyGroup, FREQUENCY_GROUP);
    assert.deepEqual(trigger.simpleEffect.damage, { enabled: true, formula: "4d10", type: "piercing" });
    assert.deepEqual(trigger.simpleEffect.save, { enabled: true, ability: "con", dcMode: "inherit", dc: null, onSave: "half" });
    assert.equal(trigger.simpleEffect.statuses.enabled, false);
  }
  for (const timing of ["exit", "move", "turnStart"]) assert.equal(zone.triggers[timing].enabled, false);
});

test("Insect Plague radius converts once to metric and remains canonical in feet", () => {
  const source = getPersistentZonePreset(PRESET_ID).persistentZone;
  const metricScene = { grid: { units: "m", distance: 1.5, size: 100 } };
  const imperialScene = { grid: { units: "ft", distance: 5, size: 100 } };
  const metric = resolvePresetPersistentZoneForScene(source, metricScene);
  const imperial = resolvePresetPersistentZoneForScene(source, imperialScene);
  assert.deepEqual(metric.geometry, { type: "circle", radius: 6, units: "m" });
  assert.deepEqual(resolvePresetPersistentZoneForScene(metric, metricScene), metric);
  assert.deepEqual(imperial.geometry, { type: "circle", radius: 20, units: "ft" });
});

test("Insect Plague survives preset to Activity to runtime with native difficult terrain", () => {
  const persistentZone = getPersistentZonePreset(PRESET_ID).persistentZone;
  const template = { type: "circle", size: 20, units: "ft" };
  const activity = {
    id: "insect-plague",
    uuid: "Actor.actor.Item.item.Activity.insect-plague",
    type: "persistent-zone",
    name: "Insect Plague",
    duration: { concentration: true },
    target: { template },
    item: { uuid: "Actor.actor.Item.item" },
    persistentZone,
    _source: { persistentZone, target: { template } }
  };
  const runtime = normalizeZoneDefinition(getPersistentZoneActivityDefinition(activity));
  assert.equal(runtime.geometry.type, "circle");
  assert.equal(runtime.geometry.radius, 20);
  assert.equal(runtime.terrain.difficult, true);
  assert.equal(runtime.terrain.behaviorType, "dnd5e.difficultTerrain");
  for (const timing of ["onCreate", "onEnter", "onEndTurn"]) {
    assert.equal(runtime.triggers[timing].frequency, "once-per-turn");
    assert.equal(runtime.triggers[timing].frequencyGroup, FREQUENCY_GROUP);
    assert.equal(runtime.triggers[timing].damage.formula, "4d10");
    assert.equal(runtime.triggers[timing].save.ability, "con");
    assert.equal(runtime.triggers[timing].save.onSuccess, "half");
  }
});

test("Insect Plague shares one frequency claim across appearance, entry, re-entry and turn end", async () => {
  const triggers = getPersistentZonePreset(PRESET_ID).persistentZone.triggers;
  const region = buildRegion();
  const token = { id: "target-a", uuid: "Scene.scene.Token.target-a" };
  const combat = buildCombat();
  assert.equal((await claim(region, token, triggers.onCreate, "onCreate", combat)).allowed, true);
  assert.equal((await claim(region, token, triggers.enter, "onEnter", combat)).allowed, false);
  assert.equal((await claim(region, token, triggers.enter, "onEnter", combat)).allowed, false);
  assert.equal((await claim(region, token, triggers.turnEnd, "onEndTurn", combat)).allowed, false);
  assert.equal(region.flags["persistent-zones"].runtime.triggerFrequencyLedger.length, 1);
});

test("Insect Plague frequency resets next turn and remains token-scoped", async () => {
  const trigger = getPersistentZonePreset(PRESET_ID).persistentZone.triggers.enter;
  const region = buildRegion();
  const firstTurn = buildCombat();
  const nextTurn = buildCombat({ turn: 2 });
  const tokenA = { id: "target-a", uuid: "Scene.scene.Token.target-a" };
  const tokenB = { id: "target-b", uuid: "Scene.scene.Token.target-b" };
  assert.equal((await claim(region, tokenA, trigger, "onEnter", firstTurn)).allowed, true);
  assert.equal((await claim(region, tokenB, trigger, "onEnter", firstTurn)).allowed, true);
  assert.equal((await claim(region, tokenA, trigger, "onEnter", nextTurn)).allowed, true);
});

function claim(regionDocument, tokenDocument, triggerConfig, timing, combat) {
  return claimTriggerFrequency({ regionDocument, tokenDocument, triggerConfig, timing, combat });
}

function buildCombat({ turn = 1 } = {}) {
  return { id: "combat", started: true, round: 1, turn, combatant: { id: `combatant-${turn}`, tokenId: "active" } };
}

function buildRegion() {
  const runtime = { groupId: "insect-plague-cast", triggerFrequencyLedger: [] };
  const region = {
    id: "insect-plague-region",
    flags: { "persistent-zones": { runtime } },
    getFlag: () => runtime,
    async update(changes) {
      runtime.triggerFrequencyLedger = changes["flags.persistent-zones.runtime.triggerFrequencyLedger"];
    }
  };
  region.parent = { regions: { contents: [region] } };
  return region;
}
