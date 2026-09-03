import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.game = {
  version: "14.367",
  settings: { settings: new Map() },
  user: { isGM: true, character: null },
  i18n: { localize: (key) => key }
};
globalThis.canvas = { scene: null, grid: { size: 100 }, tokens: { controlled: [] } };
globalThis.CONFIG = { RegionBehavior: { dataModels: {} } };

const { getPersistentZonePreset } = await import("../presets/preset-library.mjs");
const { getPersistentZoneActivityDefinition } = await import("../activity/persistent-zone-activity-utils.mjs");
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const { resolveScaledFormula } = await import("../runtime/damage-scaling.mjs");
const { claimTriggerFrequency } = await import("../runtime/trigger-frequency.mjs");
const { createSpiritGuardiansTestItem } = await import("../runtime/debug-tools.mjs");

const VARIANTS = [
  ["srd-5.2.1.spirit-guardians-radiant", "radiant"],
  ["srd-5.2.1.spirit-guardians-necrotic", "necrotic"]
];

test("Spirit Guardians presets compose the attached emanation primitives", () => {
  for (const [id, damageType] of VARIANTS) {
    const preset = getPersistentZonePreset(id);
    const zone = preset.persistentZone;
    assert.deepEqual(zone.placement, { mode: "attached-source" });
    assert.deepEqual(zone.geometry, { type: "emanation", radius: 15, units: "ft" });
    assert.deepEqual(zone.obstacles, { mode: "wall-restricted", restrictionType: "move", priority: 0 });
    assert.deepEqual(zone.terrain, { enabled: true, multiplier: 2, targetFilter: { mode: "enemies" } });
    assert.deepEqual(zone.parts, []);
    for (const timing of ["onCreate", "enter", "turnEnd"]) {
      const trigger = zone.triggers[timing];
      assert.equal(trigger.enabled, true);
      assert.equal(trigger.targetFilter.mode, "enemies");
      assert.equal(trigger.frequency, "once-per-turn");
      assert.equal(trigger.frequencyGroup, "spirit-guardians-damage");
      assert.deepEqual(trigger.simpleEffect.save, { enabled: true, ability: "wis", dcMode: "inherit", dc: null, onSave: "half" });
      assert.equal(trigger.simpleEffect.damage.formula, "3d8");
      assert.equal(trigger.simpleEffect.damage.type, damageType);
      assert.deepEqual(trigger.simpleEffect.damage.scaling, {
        mode: "per-level", baseLevelMode: "item", baseLevel: 3, perLevelFormula: "1d8"
      });
    }
  }
});

test("Spirit Guardians keeps terrain filtering, scaling, and restriction in normalized runtime data", () => {
  const preset = getPersistentZonePreset("srd-5.2.1.spirit-guardians-radiant");
  const definition = getPersistentZoneActivityDefinition({
    id: "spirit-guardians",
    uuid: "Actor.actor.Item.item.Activity.spirit-guardians",
    type: "persistent-zone",
    name: "Spirit Guardians",
    persistentZone: preset.persistentZone,
    _source: { persistentZone: preset.persistentZone },
    item: { uuid: "Actor.actor.Item.item", system: { level: 3 } }
  });
  const normalized = normalizeZoneDefinition({ ...definition, castLevel: 5 }, {
    item: { system: { level: 3 } }
  });
  assert.equal(normalized.placement.mode, "attached-source");
  assert.equal(normalized.geometry.type, "emanation");
  assert.equal(normalized.obstacles.mode, "wall-restricted");
  assert.equal(normalized.obstacles.restrictionType, "move");
  assert.equal(normalized.terrain.multiplier, 2);
  assert.equal(normalized.terrain.targetFilter.mode, "enemies");
  assert.equal(normalized.triggers.onEnter.targetFilter.mode, "enemies");
  assert.equal(resolveScaledFormula({
    formula: normalized.triggers.onEnter.damage.formula,
    scaling: normalized.triggers.onEnter.damage.scaling,
    castLevel: normalized.castLevel
  }).formula, "3d8 + (1d8) + (1d8)");
});

test("Spirit Guardians shares its once-per-turn ledger across creation, entry, and turn end", async () => {
  const preset = getPersistentZonePreset("srd-5.2.1.spirit-guardians-radiant");
  const runtime = { groupId: "spirit-guardians-cast", triggerFrequencyLedger: [] };
  const region = {
    id: "region",
    flags: { "persistent-zones": { runtime } },
    getFlag: () => runtime,
    async update(changes) { runtime.triggerFrequencyLedger = changes["flags.persistent-zones.runtime.triggerFrequencyLedger"]; }
  };
  const combat = { id: "combat", started: true, round: 1, turn: 1, combatant: { id: "combatant", tokenId: "enemy" } };
  const token = { id: "enemy", uuid: "Scene.scene.Token.enemy" };
  for (const timing of ["onCreate", "onEnter", "onEndTurn"]) {
    const key = timing === "onCreate" ? "onCreate" : timing === "onEnter" ? "enter" : "turnEnd";
    const result = await claimTriggerFrequency({ regionDocument: region, tokenDocument: token, triggerConfig: preset.persistentZone.triggers[key], timing, combat });
    assert.equal(result.allowed, timing === "onCreate");
  }
  const nextTurn = await claimTriggerFrequency({
    regionDocument: region,
    tokenDocument: token,
    triggerConfig: preset.persistentZone.triggers.enter,
    timing: "onEnter",
    combat: { ...combat, turn: 2, combatant: { id: "combatant-next", tokenId: "enemy" } }
  });
  assert.equal(nextTurn.allowed, true);
});

test("Spirit Guardians frequency group blocks enter then turn end even when native events see different combatants", async () => {
  const preset = getPersistentZonePreset("srd-5.2.1.spirit-guardians-radiant");
  const runtime = { groupId: "spirit-guardians-cast", triggerFrequencyLedger: [] };
  const region = {
    id: "region",
    flags: { "persistent-zones": { runtime } },
    getFlag: () => runtime,
    async update(changes) { runtime.triggerFrequencyLedger = changes["flags.persistent-zones.runtime.triggerFrequencyLedger"]; }
  };
  const token = { id: "enemy", uuid: "Scene.scene.Token.enemy" };
  const enterCombat = { id: "combat", started: true, round: 1, turn: 1, combatant: { id: "enemy-combatant", tokenId: "enemy" } };
  const turnEndCombat = { ...enterCombat, combatant: { id: "late-event-combatant", tokenId: "other" } };
  assert.equal((await claimTriggerFrequency({
    regionDocument: region, tokenDocument: token, triggerConfig: preset.persistentZone.triggers.enter, timing: "onEnter", combat: enterCombat
  })).allowed, true);
  assert.equal((await claimTriggerFrequency({
    regionDocument: region, tokenDocument: token, triggerConfig: preset.persistentZone.triggers.turnEnd, timing: "onEndTurn", combat: turnEndCombat
  })).allowed, false);

  const otherRegionRuntime = { groupId: "other-spirit-guardians-cast", triggerFrequencyLedger: [] };
  const otherRegion = {
    id: "other-region",
    flags: { "persistent-zones": { runtime: otherRegionRuntime } },
    getFlag: () => otherRegionRuntime,
    async update(changes) { otherRegionRuntime.triggerFrequencyLedger = changes["flags.persistent-zones.runtime.triggerFrequencyLedger"]; }
  };
  assert.equal((await claimTriggerFrequency({
    regionDocument: otherRegion, tokenDocument: token, triggerConfig: preset.persistentZone.triggers.turnEnd, timing: "onEndTurn", combat: turnEndCombat
  })).allowed, true);
});

test("Spirit Guardians debug helper creates one level-three spell with both sibling activities", async () => {
  const previousItem = globalThis.Item;
  const captured = { item: null, activities: null };
  const item = {
    uuid: "Item.debug-spirit-guardians",
    system: { activities: new Map() },
    async createActivity(type, source, options) {
      assert.equal(type, "persistent-zone");
      assert.equal(options.renderSheet, false);
      captured.activities ??= [];
      captured.activities.push(source);
      this.system.activities.set(`activity-${captured.activities.length - 1}`, { id: `activity-${captured.activities.length - 1}`, ...source });
    }
  };
  globalThis.Item = { create: async (source) => { captured.item = source; return item; } };
  try {
    const result = await createSpiritGuardiansTestItem();
    assert.equal(result.ok, true);
    assert.equal(captured.item.name, "Debug/Test — Spirit Guardians");
    assert.equal(captured.item.system.level, 3);
    assert.equal(captured.item.system.duration.concentration, true);
    assert.equal(captured.activities.length, 2);
    assert.deepEqual(captured.activities.map((activity) => activity.persistentZone.geometry.type), ["emanation", "emanation"]);
    assert.deepEqual(captured.activities.map((activity) => activity.persistentZone.triggers.enter.simpleEffect.damage.type), ["radiant", "necrotic"]);
  } finally {
    globalThis.Item = previousItem;
  }
});
