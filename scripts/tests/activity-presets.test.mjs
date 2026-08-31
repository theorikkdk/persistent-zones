import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_PRESETS } from "../presets/builtins.mjs";
import { getBuiltinPersistentZonePresets, getPersistentZonePreset } from "../presets/preset-library.mjs";
import {
  PRESET_SCHEMA_VERSION,
  applyPresetToActivity,
  extractPresetDataFromActivity,
  normalizePreset,
  resolvePresetPersistentZoneForScene
} from "../presets/preset-utils.mjs";

test("accepts versioned built-in presets", () => {
  assert.equal(BUILTIN_PRESETS.length, 6);
  for (const candidate of BUILTIN_PRESETS) {
    const preset = normalizePreset(candidate);
    assert.ok(preset);
    assert.equal(preset.version, PRESET_SCHEMA_VERSION);
    assert.equal(preset.system.id, "dnd5e");
  }
});

test("rejects invalid presets and removes unsupported data", () => {
  assert.equal(normalizePreset(null), null);
  assert.equal(normalizePreset({ id: "bad", version: 2, name: "Bad", persistentZone: {} }), null);
  const preset = normalizePreset({
    id: "test.cleaned",
    version: 1,
    name: "Cleaned",
    persistentZone: {
      schemaVersion: 3,
      enabled: true,
      geometry: { type: "circle", radius: 5 },
      unknownRuntimeBlock: { enabled: true },
      actorUuid: "Actor.secret",
      triggers: { enter: { linkedActivity: { id: "specific", uuid: "Activity.specific" } } }
    }
  });
  assert.ok(preset);
  assert.equal(preset.persistentZone.unknownRuntimeBlock, undefined);
  assert.equal(preset.persistentZone.actorUuid, undefined);
  assert.deepEqual(preset.persistentZone.triggers.enter.linkedActivity, {});
});

test("normalizes SRD attribution metadata without copying spell text", () => {
  const preset = normalizePreset({
    id: "srd-5.2.1.example",
    version: 1,
    source: "srd-5.2.1",
    rulesVersion: "2024",
    spell: true,
    name: "Example",
    persistentZone: { schemaVersion: 3, enabled: true, geometry: { type: "circle", radius: 5 } }
  });
  assert.equal(preset.source, "srd-5.2.1");
  assert.equal(preset.rulesVersion, "2024");
  assert.equal(preset.spell, true);
  assert.equal(preset.attribution.license, "CC BY 4.0");
  assert.equal("rulesText" in preset, false);
});

test("extracts configuration without cast identities", () => {
  const preset = extractPresetDataFromActivity({
    id: "activity-id",
    name: "Test Activity",
    persistentZone: {
      schemaVersion: 3,
      enabled: true,
      geometry: { type: "circle", radius: 10 },
      groupId: "cast-group",
      lifecycle: { useDedicatedOwnerEffect: true, ownerEffectUuid: "Effect.owner" }
    }
  }, { id: "user.extracted" });
  assert.ok(preset);
  assert.equal(preset.persistentZone.groupId, undefined);
  assert.equal(preset.persistentZone.lifecycle.ownerEffectUuid, undefined);
  assert.equal(preset.persistentZone.lifecycle.useDedicatedOwnerEffect, true);
});

test("preserves multipart, per-part triggers and terrain, and global linked documents", () => {
  const preset = getPersistentZonePreset("builtin.multipart-simple");
  assert.equal(preset.persistentZone.parts.length, 2);
  assert.deepEqual(preset.persistentZone.parts.map(part => part.id), ["primary", "secondary"]);
  assert.ok(preset.persistentZone.parts.every(part => hasOnlyDisabledTriggers(part.triggers)));
  assert.ok(preset.persistentZone.parts.every(part => Object.hasOwn(part, "terrain")));
  assert.equal(preset.persistentZone.parts.some(part => "linkedWalls" in part || "linkedLights" in part), false);
  assert.equal(preset.persistentZone.linkedWalls.enabled, false);
  assert.equal(preset.persistentZone.linkedLights.enabled, false);
});

test("applies only Activity updates and never touches existing Regions", async () => {
  const regions = [{ id: "existing-region" }];
  const captured = [];
  const item = {
    async updateActivity(id, updates) {
      captured.push({ id, updates });
    }
  };
  const activity = { id: "activity-1", item };
  const preset = getPersistentZonePreset("builtin.simple-circle");
  const result = await applyPresetToActivity(activity, preset);
  assert.deepEqual(captured, [
    { id: activity.id, updates: { "-=persistentZone": null } },
    { id: activity.id, updates: { persistentZone: preset.persistentZone } }
  ]);
  assert.deepEqual(regions, [{ id: "existing-region" }]);
  assert.deepEqual(result.persistentZone, preset.persistentZone);
});

test("replacement removes every stale mono and multipart setting", async () => {
  const state = {
    persistentZone: {
      schemaVersion: 3,
      enabled: true,
      geometry: { type: "wall", wallLength: 90, staleGeometry: true },
      triggers: {
        enter: { enabled: true, simpleEffect: { damage: { enabled: true, formula: "9d9" }, save: { enabled: true }, statuses: { enabled: true, statusId: "poisoned" } } },
        turnEnd: { enabled: true, simpleEffect: { damage: { enabled: true, formula: "8d8" } } }
      },
      terrain: { enabled: true, multiplier: 4 },
      parts: [
        { id: "old-primary", geometry: { type: "template" }, triggers: { enter: { enabled: true } } },
        { id: "old-secondary", geometry: { type: "template" }, triggers: { turnEnd: { enabled: true } } }
      ],
      linkedWalls: { enabled: true, preset: "solid" },
      linkedLights: { enabled: true, preset: "fire" },
      lifecycle: { useDedicatedOwnerEffect: false, staleLifecycle: true }
    }
  };
  const item = {
    async updateActivity(_id, updates) {
      if (Object.hasOwn(updates, "-=persistentZone")) delete state.persistentZone;
      if (updates.persistentZone) {
        state.persistentZone = state.persistentZone
          ? deepMerge(state.persistentZone, updates.persistentZone)
          : structuredClone(updates.persistentZone);
      }
    }
  };
  const preset = getPersistentZonePreset("builtin.multipart-simple");
  await applyPresetToActivity({ id: "activity-replace", item }, preset);
  assert.deepEqual(state.persistentZone, preset.persistentZone);
  assert.ok(hasOnlyDisabledTriggers(state.persistentZone.triggers));
  assert.deepEqual(state.persistentZone.parts.map(part => part.id), ["primary", "secondary"]);
  assert.ok(state.persistentZone.parts.every(part => hasOnlyDisabledTriggers(part.triggers)));
});

test("all technical built-ins replace stale effects with explicit disabled triggers", async () => {
  const expectedGeometry = new Map([
    ["builtin.simple-circle", "circle"],
    ["builtin.difficult-terrain", "circle"],
    ["builtin.ring", "ring"],
    ["builtin.wall-line", "wall"],
    ["builtin.multipart-simple", "circle"]
  ]);

  for (const preset of getBuiltinPersistentZonePresets().filter((candidate) => candidate.id.startsWith("builtin.") && candidate.category !== "test")) {
    const state = { persistentZone: buildStalePersistentZoneConfiguration() };
    const item = {
      async updateActivity(_id, updates) {
        if (Object.hasOwn(updates, "-=persistentZone")) delete state.persistentZone;
        if (updates.persistentZone) state.persistentZone = structuredClone(updates.persistentZone);
      }
    };
    await applyPresetToActivity({ id: `activity-${preset.id}`, item }, preset);

    assert.equal(state.persistentZone.geometry.type, expectedGeometry.get(preset.id), preset.id);
    assert.equal(state.persistentZone.terrain.enabled, preset.id === "builtin.difficult-terrain", preset.id);
    assert.ok(hasOnlyDisabledTriggers(state.persistentZone.triggers), preset.id);
    assert.equal(JSON.stringify(state.persistentZone).includes("9d9"), false, preset.id);
    assert.equal(JSON.stringify(state.persistentZone).includes("8d8"), false, preset.id);
    assert.equal(JSON.stringify(state.persistentZone).includes("poisoned"), false, preset.id);
    for (const part of state.persistentZone.parts ?? []) {
      assert.ok(hasOnlyDisabledTriggers(part.triggers), `${preset.id}:${part.id}`);
    }
  }
});

test("preset extraction and application preserve frequency configuration", async () => {
  const persistentZone = {
    schemaVersion: 3,
    enabled: true,
    geometry: { type: "circle", radius: 10 },
    triggers: {
      onCreate: { enabled: true, mode: "simple-effect", targetFilter: { mode: "enemies" }, frequency: "once-per-turn", frequencyGroup: "shared" },
      enter: { enabled: true, mode: "simple-effect", targetFilter: { mode: "allies" }, frequency: "once-per-turn", frequencyGroup: "shared" },
      exit: { enabled: false, mode: "none", frequency: "unlimited", frequencyGroup: "" }
    }
  };
  const extracted = extractPresetDataFromActivity({ name: "Frequency", persistentZone }, { id: "user.frequency" });
  assert.equal(extracted.persistentZone.triggers.onCreate.frequency, "once-per-turn");
  assert.equal(extracted.persistentZone.triggers.onCreate.frequencyGroup, "shared");
  assert.equal(extracted.persistentZone.triggers.onCreate.targetFilter.mode, "enemies");
  assert.equal(extracted.persistentZone.triggers.enter.targetFilter.mode, "allies");
  assert.equal(extracted.persistentZone.triggers.enter.frequencyGroup, "shared");
  assert.equal(extracted.persistentZone.triggers.exit.frequency, "unlimited");

  const captured = [];
  await applyPresetToActivity({
    id: "frequency-activity",
    item: { async updateActivity(_id, update) { captured.push(update); } }
  }, extracted);
  assert.equal(captured[1].persistentZone.triggers.onCreate.frequency, "once-per-turn");
  assert.equal(captured[1].persistentZone.triggers.onCreate.frequencyGroup, "shared");
  assert.equal(captured[1].persistentZone.triggers.onCreate.targetFilter.mode, "enemies");
});

test("library returns independent copies", () => {
  const first = getBuiltinPersistentZonePresets();
  first[0].persistentZone.geometry.radius = 999;
  assert.notEqual(getBuiltinPersistentZonePresets()[0].persistentZone.geometry.radius, 999);
});

test("preset normalization preserves target filters and healing from an internal fixture", () => {
  const fixture = structuredClone(BUILTIN_PRESETS[0]);
  fixture.id = "fixture.target-filters";
  fixture.source = "user";
  fixture.name = "Target filter fixture";
  fixture.persistentZone.triggers.enter = {
    ...fixture.persistentZone.triggers.enter,
    enabled: true,
    mode: "simple-effect",
    targetFilter: { mode: "enemies" },
    simpleEffect: {
      ...fixture.persistentZone.triggers.enter.simpleEffect,
      damage: { enabled: true, formula: "1", type: "fire" }
    }
  };
  fixture.persistentZone.triggers.turnEnd = {
    ...fixture.persistentZone.triggers.turnEnd,
    enabled: true,
    mode: "simple-effect",
    targetFilter: { mode: "allies" },
    simpleEffect: {
      ...fixture.persistentZone.triggers.turnEnd.simpleEffect,
      healing: { enabled: true, formula: "1" }
    }
  };
  const preset = normalizePreset(fixture);
  assert.deepEqual(preset.persistentZone.triggers.enter.targetFilter, { mode: "enemies" });
  assert.deepEqual(preset.persistentZone.triggers.turnEnd.targetFilter, { mode: "allies" });
  assert.deepEqual(preset.persistentZone.triggers.turnEnd.simpleEffect.healing, { enabled: true, formula: "1" });
});

test("SRD 5.2.1 Grease preset is RAW-oriented and fully replaces stale actions", async () => {
  const preset = getPersistentZonePreset("srd-5.2.1.grease");
  assert.equal(preset.source, "srd-5.2.1");
  assert.equal(preset.rulesVersion, "2024");
  assert.equal(preset.spell, true);
  assert.deepEqual(preset.persistentZone.geometry, { type: "rectangle", width: 10, height: 10, units: "ft", placement: "center" });
  assert.equal(preset.persistentZone.terrain.enabled, true);
  for (const triggerId of ["onCreate", "enter", "turnEnd"]) {
    const trigger = preset.persistentZone.triggers[triggerId];
    assert.equal(trigger.targetFilter.mode, "all");
    assert.equal(trigger.enabled, true);
    assert.equal(trigger.frequency, "unlimited");
    assert.equal(trigger.frequencyGroup, "");
    assert.equal(trigger.simpleEffect.damage.enabled, false);
    assert.equal(trigger.simpleEffect.healing.enabled, false);
    assert.equal(trigger.simpleEffect.temporaryHitPoints.enabled, false);
    assert.equal(trigger.simpleEffect.save.enabled, true);
    assert.equal(trigger.simpleEffect.save.ability, "dex");
    assert.equal(trigger.simpleEffect.save.dcMode, "inherit");
    assert.equal(trigger.simpleEffect.save.onSave, "none");
    assert.equal(trigger.simpleEffect.statuses.statusId, "prone");
    assert.equal(trigger.simpleEffect.statuses.persistenceMode, "persistent");
    assert.equal(trigger.simpleEffect.statuses.recovery.mode, "none");
  }
  for (const triggerId of ["onCreate", "enter", "turnEnd"]) {
    assert.deepEqual(preset.persistentZone.triggers[triggerId].requiredAbsentStatuses, ["prone"]);
  }
  for (const triggerId of ["exit", "move", "turnStart"]) assert.equal(preset.persistentZone.triggers[triggerId].enabled, false);
  assert.equal(JSON.stringify(preset.persistentZone).includes("concentration"), false);
  const state = { persistentZone: buildStalePersistentZoneConfiguration() };
  await applyPresetToActivity({
    id: "grease-activity",
    item: { async updateActivity(_id, updates) {
      if (Object.hasOwn(updates, "-=persistentZone")) delete state.persistentZone;
      if (updates.persistentZone) state.persistentZone = structuredClone(updates.persistentZone);
    } }
  }, preset);
  assert.equal(state.persistentZone.geometry.type, "rectangle");
  assert.equal(JSON.stringify(state.persistentZone).includes("9d9"), false);
  assert.equal(JSON.stringify(state.persistentZone).includes("poisoned"), false);
});

test("Grease is converted once to scene units when explicitly applied", async () => {
  const preset = getPersistentZonePreset("srd-5.2.1.grease");
  const imperial = { grid: { units: "ft", distance: 5, size: 100 } };
  const metric = { grid: { units: "m", distance: 1.5, size: 100 } };
  assert.deepEqual(resolvePresetPersistentZoneForScene(preset.persistentZone, imperial).geometry, {
    type: "rectangle", width: 10, height: 10, units: "ft", placement: "center"
  });
  assert.deepEqual(resolvePresetPersistentZoneForScene(preset.persistentZone, metric).geometry, {
    type: "rectangle", width: 3, height: 3, units: "m", placement: "center"
  });
  assert.deepEqual(preset.persistentZone.geometry, {
    type: "rectangle", width: 10, height: 10, units: "ft", placement: "center"
  }, "the canonical builtin must remain RAW and immutable");

  const state = {};
  const activity = {
    id: "metric-grease",
    item: { async updateActivity(_id, updates) {
      if (Object.hasOwn(updates, "-=persistentZone")) delete state.persistentZone;
      if (updates.persistentZone) state.persistentZone = structuredClone(updates.persistentZone);
    } }
  };
  await applyPresetToActivity(activity, preset, { scene: metric });
  assert.deepEqual(state.persistentZone.geometry, {
    type: "rectangle", width: 3, height: 3, units: "m", placement: "center"
  });
  state.persistentZone.geometry.width = 6;
  assert.deepEqual(state.persistentZone.geometry, {
    type: "rectangle", width: 6, height: 3, units: "m", placement: "center"
  }, "manual metric edits must remain ordinary Activity data");
  await applyPresetToActivity(activity, preset, { scene: metric });
  assert.deepEqual(state.persistentZone.geometry, {
    type: "rectangle", width: 3, height: 3, units: "m", placement: "center"
  }, "only explicit preset reapplication may restore the converted preset dimensions");
});

function deepMerge(target, source) {
  const output = structuredClone(target);
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object" && !Array.isArray(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else output[key] = structuredClone(value);
  }
  return output;
}

function hasOnlyDisabledTriggers(triggers) {
  const ids = ["onCreate", "enter", "exit", "move", "turnStart", "turnEnd"];
  return ids.every(id => {
    const trigger = triggers?.[id];
    return trigger?.enabled === false &&
      trigger?.mode === "none" &&
      trigger?.simpleEffect?.damage?.enabled === false &&
      trigger?.simpleEffect?.healing?.enabled === false &&
      trigger?.simpleEffect?.temporaryHitPoints?.enabled === false &&
      trigger?.simpleEffect?.save?.enabled === false &&
      trigger?.simpleEffect?.statuses?.enabled === false &&
      !trigger?.linkedActivity?.id &&
      !trigger?.linkedActivity?.uuid;
  });
}

function buildStalePersistentZoneConfiguration() {
  return {
    schemaVersion: 3,
    enabled: true,
    geometry: { type: "wall", wallLength: 90 },
    triggers: {
      enter: { enabled: true, simpleEffect: { damage: { enabled: true, formula: "9d9" }, save: { enabled: true }, statuses: { enabled: true, statusId: "poisoned" } } },
      turnEnd: { enabled: true, simpleEffect: { damage: { enabled: true, formula: "8d8" }, healing: { enabled: true }, temporaryHitPoints: { enabled: true } } }
    },
    terrain: { enabled: true, multiplier: 4 },
    parts: [
      { id: "old-primary", geometry: { type: "template" }, triggers: { enter: { enabled: true } } },
      { id: "old-secondary", geometry: { type: "template" }, triggers: { turnEnd: { enabled: true } } }
    ]
  };
}
