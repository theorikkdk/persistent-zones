import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_PRESETS } from "../presets/builtins.mjs";
import { getBuiltinPersistentZonePresets, getPersistentZonePreset } from "../presets/preset-library.mjs";
import {
  PRESET_SCHEMA_VERSION,
  applyPresetToActivity,
  extractPresetDataFromActivity,
  normalizePreset
} from "../presets/preset-utils.mjs";

test("accepts versioned built-in presets", () => {
  assert.equal(BUILTIN_PRESETS.length, 5);
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

  for (const preset of getBuiltinPersistentZonePresets()) {
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

test("library returns independent copies", () => {
  const first = getBuiltinPersistentZonePresets();
  first[0].persistentZone.geometry.radius = 999;
  assert.notEqual(getBuiltinPersistentZonePresets()[0].persistentZone.geometry.radius, 999);
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
  const ids = ["enter", "exit", "move", "turnStart", "turnEnd"];
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
