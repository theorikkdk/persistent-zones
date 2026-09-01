import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { getPersistentZonePreset } from "../presets/preset-library.mjs";
import { normalizePreset, resolvePresetPersistentZoneForScene } from "../presets/preset-utils.mjs";
import { findRequiredAbsentSourceStatusConflict } from "../runtime/entry-effects.mjs";
import { claimTriggerFrequency } from "../runtime/trigger-frequency.mjs";

const IDS = {
  entangle: "srd-5.2.1.entangle",
  tentacles: "srd-5.2.1.black-tentacles",
  web: "srd-5.2.1.web"
};

test("Entangle models only the SRD creation save and persistent source-scoped escape", () => {
  const preset = getPersistentZonePreset(IDS.entangle);
  assertSrdPreset(preset);
  assert.deepEqual(preset.persistentZone.geometry, { type: "rectangle", width: 20, height: 20, units: "ft", placement: "center" });
  assert.equal(preset.persistentZone.terrain.enabled, true);
  const trigger = preset.persistentZone.triggers.onCreate;
  assert.equal(trigger.enabled, true);
  assert.equal(trigger.targetFilter.mode, "others");
  assert.equal(trigger.simpleEffect.save.ability, "str");
  assert.equal(trigger.simpleEffect.save.dcMode, "inherit");
  assertEscape(trigger, "persistent");
  for (const timing of ["enter", "exit", "move", "turnStart", "turnEnd"]) assert.equal(preset.persistentZone.triggers[timing].enabled, false, timing);
});

test("Black Tentacles shares one failure-only save/damage/status resolution per turn", async () => {
  const preset = getPersistentZonePreset(IDS.tentacles);
  assertSrdPreset(preset);
  assert.equal(preset.persistentZone.terrain.enabled, true);
  const triggers = ["onCreate", "enter", "turnEnd"].map((timing) => preset.persistentZone.triggers[timing]);
  for (const trigger of triggers) {
    assert.equal(trigger.enabled, true);
    assert.equal(trigger.frequency, "once-per-turn");
    assert.equal(trigger.frequencyGroup, "black-tentacles-save");
    assert.deepEqual(trigger.simpleEffect.damage, { enabled: true, formula: "3d6", type: "bludgeoning" });
    assert.equal(trigger.simpleEffect.save.ability, "str");
    assert.equal(trigger.simpleEffect.save.onSave, "none");
    assert.equal(trigger.requiredAbsentStatuses, undefined);
    assertEscape(trigger, "persistent");
  }

  const region = buildRegion();
  const combat = buildCombat();
  const target = { id: "target-a" };
  assert.equal((await claimTriggerFrequency({ regionDocument: region, tokenDocument: target, triggerConfig: triggers[1], timing: "enter", combat })).allowed, true);
  assert.equal((await claimTriggerFrequency({ regionDocument: region, tokenDocument: target, triggerConfig: triggers[2], timing: "turnEnd", combat })).allowed, false);
  assert.equal((await claimTriggerFrequency({ regionDocument: region, tokenDocument: target, triggerConfig: triggers[1], timing: "enter", combat })).allowed, false);
  assert.equal((await claimTriggerFrequency({ regionDocument: region, tokenDocument: { id: "target-b" }, triggerConfig: triggers[2], timing: "turnEnd", combat })).allowed, true);
  combat.turn = 2;
  combat.combatant = { id: "combatant-2", tokenId: "target-a" };
  assert.equal((await claimTriggerFrequency({ regionDocument: region, tokenDocument: target, triggerConfig: triggers[2], timing: "turnEnd", combat })).allowed, true);
});

test("Web is partial-safe with correct automated entry/start timing and while-inside status", () => {
  const preset = getPersistentZonePreset(IDS.web);
  assertSrdPreset(preset);
  assert.equal(preset.persistentZone.terrain.enabled, true);
  for (const timing of ["enter", "turnStart"]) {
    const trigger = preset.persistentZone.triggers[timing];
    assert.equal(trigger.enabled, true);
    assert.equal(trigger.frequency, "once-per-turn");
    assert.equal(trigger.frequencyGroup, "web-restrain");
    assert.equal(trigger.simpleEffect.save.ability, "dex");
    assert.equal(trigger.simpleEffect.damage.enabled, false);
    assertEscape(trigger, "while-inside-region");
  }
  assert.deepEqual(preset.persistentZone.triggers.turnStart.requiredAbsentSourceStatuses, ["restrained"]);
  assert.equal(preset.persistentZone.triggers.enter.requiredAbsentSourceStatuses, undefined);
  for (const timing of ["onCreate", "exit", "move", "turnEnd"]) assert.equal(preset.persistentZone.triggers[timing].enabled, false, timing);
  assert.ok(preset.tags.includes("partial-safe"));
});

test("Web suppresses only a redundant save from the exact Region status source", () => {
  const target = { uuid: "Scene.scene.Token.target" };
  const webA = { id: "web-a" };
  const webB = { id: "web-b" };
  const actor = { effects: [] };
  const gate = (regionDocument) => findRequiredAbsentSourceStatusConflict({
    actor,
    regionDocument,
    tokenDocument: target,
    requiredAbsentSourceStatuses: ["restrained"]
  });

  assert.equal(gate(webA), null, "a target not restrained by this Web still saves");
  actor.effects.push(statusSource("tentacles", { regionId: "tentacles", tokenUuid: target.uuid, statusId: "restrained" }));
  assert.equal(gate(webA), null, "Restrained from Black Tentacles does not suppress Web");
  actor.effects.push(statusSource("web-a", { regionId: webA.id, tokenUuid: target.uuid, statusId: "restrained" }));
  assert.equal(gate(webA), "restrained", "the exact Web source suppresses its redundant save");
  assert.equal(gate(webB), null, "a second Web remains independent");

  actor.effects = actor.effects.filter((effect) => effect.id !== "web-a");
  assert.equal(gate(webA), null, "after a successful escape, next turn saves resume");
  actor.effects.push(statusSource("web-a-failed-escape", { regionId: webA.id, tokenUuid: target.uuid, statusId: "restrained" }));
  assert.equal(gate(webA), "restrained", "after a failed escape, the next redundant save stays suppressed");
});

test("new SRD presets localize EN/FR, convert 20 feet once to 6 meters, and round-trip", () => {
  const en = JSON.parse(fs.readFileSync(new URL("../../lang/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(fs.readFileSync(new URL("../../lang/fr.json", import.meta.url), "utf8"));
  for (const [id, key] of [[IDS.entangle, "Entangle"], [IDS.tentacles, "BlackTentacles"], [IDS.web, "Web"]]) {
    const preset = getPersistentZonePreset(id);
    assert.equal(typeof en.PERSISTENT_ZONES.Activity.Presets.Builtins[key].Name, "string");
    assert.equal(typeof fr.PERSISTENT_ZONES.Activity.Presets.Builtins[key].Name, "string");
    const metric = resolvePresetPersistentZoneForScene(preset.persistentZone, { grid: { units: "m", distance: 1.5, size: 100 } });
    assert.deepEqual({ width: metric.geometry.width, height: metric.geometry.height, units: metric.geometry.units }, { width: 6, height: 6, units: "m" });
    assert.deepEqual(resolvePresetPersistentZoneForScene(metric, { grid: { units: "m", distance: 1.5, size: 100 } }), metric);
    assert.deepEqual(normalizePreset(preset), preset);
  }
});

function assertSrdPreset(preset) {
  assert.ok(preset);
  assert.equal(preset.source, "srd-5.2.1");
  assert.equal(preset.attribution.license, "CC BY 4.0");
  assert.equal(preset.persistentZone.lifecycle.useDedicatedOwnerEffect, true);
}

function assertEscape(trigger, persistenceMode) {
  const statuses = trigger.simpleEffect.statuses;
  assert.equal(statuses.statusId, "restrained");
  assert.equal(statuses.persistenceMode, persistenceMode);
  assert.deepEqual({
    enabled: statuses.escape.enabled,
    checkType: statuses.escape.checkType,
    skill: statuses.escape.skill,
    dcMode: statuses.escape.dcMode,
    removeOnSuccess: statuses.escape.removeOnSuccess,
    prompt: statuses.escape.prompt.enabled
  }, { enabled: true, checkType: "skill", skill: "ath", dcMode: "inherit", removeOnSuccess: true, prompt: true });
}

function buildCombat() {
  return { id: "combat", started: true, round: 1, turn: 1, combatant: { id: "combatant-1", tokenId: "target-a" } };
}

function buildRegion() {
  const runtime = { groupId: "tentacles-cast", triggerFrequencyLedger: [] };
  const region = {
    id: "region",
    flags: { "persistent-zones": { runtime } },
    getFlag: () => runtime,
    async update(changes) { runtime.triggerFrequencyLedger = changes["flags.persistent-zones.runtime.triggerFrequencyLedger"]; }
  };
  region.parent = { regions: { contents: [region] } };
  return region;
}

function statusSource(id, { regionId, tokenUuid, statusId, partId = null }) {
  return {
    id,
    active: true,
    flags: {
      "persistent-zones": {
        managedTriggeredEffect: true,
        regionId,
        tokenUuid,
        partId,
        statusId
      }
    }
  };
}
