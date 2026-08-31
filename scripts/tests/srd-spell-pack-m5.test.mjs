import assert from "node:assert/strict";
import test from "node:test";

import { getPersistentZonePreset } from "../presets/preset-library.mjs";
import { resolvePresetPersistentZoneForScene } from "../presets/preset-utils.mjs";
import { getPersistentZoneActivityDefinition } from "../activity/persistent-zone-activity-utils.mjs";
import { claimTriggerFrequency } from "../runtime/trigger-frequency.mjs";
import { normalizeZoneDefinition } from "../runtime/zone-definition.mjs";
import { resolveLinkedLightConfig } from "../runtime/linked-presets.mjs";
import { buildLinkedLightLayout } from "../runtime/linked-documents.mjs";

globalThis.foundry ??= { utils: { deepClone: structuredClone } };
globalThis.game ??= { version: "14.367", settings: { settings: new Map() } };
globalThis.canvas ??= { scene: null, grid: { size: 100 } };

const trigger = (preset, partId, timing) => preset.persistentZone.parts.find((part) => part.id === partId).triggers[timing];

test("Wall of Fire line uses two stable parts and exact SRD base geometry", () => {
  const preset = getPersistentZonePreset("srd-5.2.1.wall-of-fire-line");
  assert.deepEqual(preset.persistentZone.geometry, { type: "wall", wallLength: 60, wallThickness: 1, units: "ft" });
  assert.deepEqual(preset.persistentZone.parts.map(({ id, role }) => ({ id, role })), [
    { id: "wall-body", role: "wall" },
    { id: "hot-side", role: "hot-side" }
  ]);
  assert.deepEqual(preset.persistentZone.parts[0].geometry, { type: "template" });
  assert.deepEqual(preset.persistentZone.parts[0].interaction, { mode: "thin-wall" });
  assert.deepEqual(preset.persistentZone.parts[1].geometry, {
    type: "side-of-line",
    referencePartId: "wall-body",
    side: "left",
    offsetReference: "body-edge",
    offsetStart: 0,
    offsetEnd: 10
  });
  assertWallOfFireTriggers(preset);
  assert.equal(preset.persistentZone.linkedWalls.enabled, true);
  assert.equal(preset.persistentZone.linkedWalls.preset, "custom");
  assert.equal(preset.persistentZone.linkedWalls.geometry, "perimeter");
  assert.equal(preset.persistentZone.linkedWalls.move, "none");
  assert.equal(preset.persistentZone.linkedWalls.sight, "limited");
  assert.equal(preset.persistentZone.linkedWalls.light, "limited");
  assert.equal(preset.persistentZone.linkedWalls.sound, "none");
  assert.equal(preset.persistentZone.linkedWalls.dir, "both");
  assert.deepEqual(preset.persistentZone.linkedLights, {
    enabled: false,
    preset: "fire",
    bright: 1,
    dim: 5,
    max: 24,
    color: "#ff9b42"
  });
});

test("Wall of Fire ring uses Ring v2 and configurable outer hot side", () => {
  const preset = getPersistentZonePreset("srd-5.2.1.wall-of-fire-ring");
  assert.deepEqual(preset.persistentZone.geometry, {
    type: "ring",
    ringReferenceRadius: 10,
    ringInnerWidth: 1,
    ringOuterWidth: 0,
    units: "ft"
  });
  assert.deepEqual(preset.persistentZone.parts.map(({ id, role }) => ({ id, role })), [
    { id: "wall-body", role: "wall" },
    { id: "hot-side", role: "hot-side" }
  ]);
  assert.deepEqual(preset.persistentZone.parts[0].interaction, { mode: "thin-wall" });
  assert.deepEqual(preset.persistentZone.parts[1].geometry, {
    type: "side-of-ring",
    referencePartId: "wall-body",
    side: "outer",
    offsetReference: "body-edge",
    offsetStart: 0,
    offsetEnd: 10
  });
  assertWallOfFireTriggers(preset);
  assert.equal(preset.persistentZone.linkedWalls.geometry, "perimeter");
  assert.equal(preset.persistentZone.linkedWalls.move, "none");
  assert.equal(preset.persistentZone.linkedWalls.sight, "limited");
  assert.equal(preset.persistentZone.linkedWalls.light, "limited");
  assert.equal(preset.persistentZone.linkedWalls.sound, "none");
});

test("Wall of Fire canonical dimensions and multipart offsets convert once to metric", () => {
  const scene = { grid: { units: "m", distance: 1.5, size: 100 } };
  for (const id of ["srd-5.2.1.wall-of-fire-line", "srd-5.2.1.wall-of-fire-ring"]) {
    const preset = getPersistentZonePreset(id);
    const resolved = resolvePresetPersistentZoneForScene(preset.persistentZone, scene);
    assert.equal(resolved.geometry.units, "m");
    assert.equal(resolved.parts[1].geometry.offsetStart, 0);
    assert.equal(resolved.parts[1].geometry.offsetEnd, 3);
    assert.equal(resolved.linkedWalls.height, 6);
    assert.deepEqual(resolvePresetPersistentZoneForScene(resolved, scene), resolved);
  }
  const line = resolvePresetPersistentZoneForScene(getPersistentZonePreset("srd-5.2.1.wall-of-fire-line").persistentZone, scene);
  assert.equal(line.geometry.wallLength, 18);
  assert.equal(line.geometry.wallThickness, 0.3);
  const ring = resolvePresetPersistentZoneForScene(getPersistentZonePreset("srd-5.2.1.wall-of-fire-ring").persistentZone, scene);
  assert.equal(ring.geometry.ringReferenceRadius, 3);
  assert.equal(ring.geometry.ringInnerWidth, 0.3);
});

test("Moonbeam uses exact representable SRD triggers and dim-light radius", () => {
  const preset = getPersistentZonePreset("srd-5.2.1.moonbeam");
  assert.deepEqual(preset.persistentZone.geometry, { type: "circle", radius: 5, units: "ft" });
  assert.equal(preset.persistentZone.terrain.enabled, false);
  assert.deepEqual(preset.persistentZone.linkedLights, {
    enabled: true,
    preset: "moonlight",
    bright: 0,
    dim: 5,
    max: 1,
    color: "#dbe7ff"
  });
  for (const timing of ["onCreate", "enter", "turnEnd"]) {
    const config = preset.persistentZone.triggers[timing];
    assert.equal(config.enabled, true);
    assert.equal(config.targetFilter.mode, "all");
    assert.equal(config.frequency, "once-per-turn");
    assert.equal(config.frequencyGroup, "moonbeam-damage");
    assert.deepEqual(config.simpleEffect.damage, { enabled: true, formula: "2d10", type: "radiant" });
    assert.deepEqual(config.simpleEffect.save, { enabled: true, ability: "con", dcMode: "inherit", dc: null, onSave: "half" });
  }
  assert.equal(preset.persistentZone.triggers.move.enabled, false);
});

test("Moonbeam radius and linked dim light convert to metric without cumulative conversion", () => {
  const scene = { grid: { units: "m", distance: 1.5, size: 100 } };
  const preset = getPersistentZonePreset("srd-5.2.1.moonbeam");
  const resolved = resolvePresetPersistentZoneForScene(preset.persistentZone, scene);
  assert.equal(resolved.geometry.radius, 1.5);
  assert.equal(resolved.geometry.units, "m");
  assert.equal(resolved.linkedLights.bright, 0);
  assert.equal(resolved.linkedLights.dim, 1.5);
  assert.deepEqual(resolvePresetPersistentZoneForScene(resolved, scene), resolved);
});

test("Moonbeam linked light survives preset to Activity to runtime handoff", () => {
  const persistentZone = getPersistentZonePreset("srd-5.2.1.moonbeam").persistentZone;
  const definition = getPersistentZoneActivityDefinition({
    id: "moonbeam",
    uuid: "Actor.actor.Item.item.Activity.moonbeam",
    type: "persistent-zone",
    name: "Moonbeam",
    duration: { concentration: true },
    target: { template: { type: "circle", size: 5, units: "ft" } },
    item: { uuid: "Actor.actor.Item.item" },
    persistentZone,
    _source: { persistentZone, target: { template: { type: "circle", size: 5, units: "ft" } } }
  });
  assert.equal(definition.linkedLight.enabled, true);
  assert.equal(definition.linkedLight.preset, "moonlight");
  assert.equal(definition.linkedLight.bright, 0);
  assert.equal(definition.linkedLight.dim, 5);
  assert.equal(definition.linkedLight.max, 1);
  assert.equal(definition.linkedLight.color, "#dbe7ff");
});

test("Wall of Fire thin-wall interaction survives Activity and runtime normalization", () => {
  const persistentZone = getPersistentZonePreset("srd-5.2.1.wall-of-fire-line").persistentZone;
  const activity = buildActivity("wall-of-fire", persistentZone, { type: "wall", size: 60, width: 1, units: "ft" });
  const definition = getPersistentZoneActivityDefinition(activity);
  assert.equal(definition.parts[0].interaction.mode, "thin-wall");
  const normalized = normalizeZoneDefinition(definition);
  assert.equal(normalized.parts[0].interaction.mode, "thin-wall");
});

test("Wall of Fire dormant fire profile enables an adaptive stable line layout", () => {
  const scene = { id: "scene", width: 2000, height: 2000, padding: 0, grid: { units: "ft", distance: 5, size: 100 } };
  const definition = getPersistentZonePreset("srd-5.2.1.wall-of-fire-line").persistentZone.linkedLights;
  const linkedLight = resolveLinkedLightConfig({ ...definition, enabled: true });
  const layout = buildLinkedLightLayout({
    scene,
    regionDocument: { id: "wall" },
    linkedLight,
    bright: linkedLight.bright,
    dim: linkedLight.dim,
    shapes: [{ type: "line", x: 100, y: 100, length: 1200, width: 20, rotation: 0, gridBased: false }]
  });
  assert.equal(linkedLight.preset, "fire");
  assert.equal(linkedLight.animation.type, "torch");
  assert.equal(linkedLight.color, "#ff9b42");
  assert.equal(layout.layoutType, "line-path");
  assert.equal(layout.positions.length, 12);
  assert.equal(new Set(layout.positions.map((position) => position.slot)).size, 12);
});

test("Wall of Fire enter and turn-end use independent once-per-turn ledgers", async () => {
  const preset = getPersistentZonePreset("srd-5.2.1.wall-of-fire-line");
  const appearance = trigger(preset, "wall-body", "onCreate");
  const enter = trigger(preset, "wall-body", "enter");
  const bodyEnd = trigger(preset, "wall-body", "turnEnd");
  const hotEnd = trigger(preset, "hot-side", "turnEnd");
  assert.equal(enter.frequencyGroup, "wall-of-fire-enter");
  assert.equal(bodyEnd.frequencyGroup, "wall-of-fire-turn-end");
  assert.equal(hotEnd.frequencyGroup, "wall-of-fire-turn-end");

  const { bodyRegion, hotRegion } = buildFrequencyRegions();
  const tokenDocument = { id: "target", uuid: "Scene.scene.Token.target" };
  const combat = buildCombat();
  assert.equal((await claimTriggerFrequency({ regionDocument: bodyRegion, tokenDocument, triggerConfig: appearance, timing: "onCreate", combat })).allowed, true);
  assert.equal((await claimTriggerFrequency({ regionDocument: bodyRegion, tokenDocument, triggerConfig: enter, timing: "onEnter", combat })).allowed, true);
  assert.equal((await claimTriggerFrequency({ regionDocument: bodyRegion, tokenDocument, triggerConfig: enter, timing: "onEnter", combat })).allowed, false);
  assert.equal((await claimTriggerFrequency({ regionDocument: bodyRegion, tokenDocument, triggerConfig: bodyEnd, timing: "onEndTurn", combat })).allowed, true);
  assert.equal((await claimTriggerFrequency({ regionDocument: hotRegion, tokenDocument, triggerConfig: hotEnd, timing: "onEndTurn", combat })).allowed, false);
  assert.equal((await claimTriggerFrequency({ regionDocument: bodyRegion, tokenDocument, triggerConfig: enter, timing: "onEnter", combat: buildCombat({ turn: 2 }) })).allowed, true);
});

test("preset copies preserve edits to side, save, filters, frequency and linked light independently", () => {
  const preset = getPersistentZonePreset("srd-5.2.1.wall-of-fire-line");
  preset.persistentZone.parts[1].geometry.side = "right";
  trigger(preset, "wall-body", "onCreate").simpleEffect.save.dcMode = "manual";
  trigger(preset, "wall-body", "onCreate").simpleEffect.save.dc = 17;
  trigger(preset, "hot-side", "turnEnd").targetFilter.mode = "enemies";
  trigger(preset, "hot-side", "turnEnd").frequencyGroup = "edited-group";
  preset.persistentZone.linkedLights.color = "#ff0000";
  assert.equal(preset.persistentZone.parts[1].geometry.side, "right");
  assert.equal(trigger(preset, "wall-body", "onCreate").simpleEffect.save.dc, 17);
  assert.equal(trigger(preset, "hot-side", "turnEnd").targetFilter.mode, "enemies");
  assert.equal(trigger(preset, "hot-side", "turnEnd").frequencyGroup, "edited-group");
  assert.equal(preset.persistentZone.linkedLights.color, "#ff0000");
  assert.equal(getPersistentZonePreset("srd-5.2.1.wall-of-fire-line").persistentZone.parts[1].geometry.side, "left");
});

function assertWallOfFireTriggers(preset) {
  const appearance = trigger(preset, "wall-body", "onCreate");
  assert.deepEqual(appearance.simpleEffect.damage, { enabled: true, formula: "5d8", type: "fire" });
  assert.deepEqual(appearance.simpleEffect.save, { enabled: true, ability: "dex", dcMode: "inherit", dc: null, onSave: "half" });
  assert.equal(appearance.targetFilter.mode, "all");
  assert.equal(appearance.frequency, "unlimited");

  for (const [partId, timing] of [["wall-body", "enter"], ["wall-body", "turnEnd"], ["hot-side", "turnEnd"]]) {
    const config = trigger(preset, partId, timing);
    assert.deepEqual(config.simpleEffect.damage, { enabled: true, formula: "5d8", type: "fire" });
    assert.equal(config.simpleEffect.save.enabled, false);
    assert.equal(config.frequency, "once-per-turn");
    assert.equal(config.frequencyGroup, timing === "enter" ? "wall-of-fire-enter" : "wall-of-fire-turn-end");
    assert.equal(config.targetFilter.mode, "all");
  }
  assert.equal(trigger(preset, "hot-side", "enter").enabled, false);
}

function buildCombat({ turn = 1 } = {}) {
  return { id: "combat", started: true, round: 1, turn, combatant: { id: `combatant-${turn}`, tokenId: "active" } };
}

function buildFrequencyRegions() {
  const build = (id) => {
    const runtime = { groupId: "wall-of-fire-cast", triggerFrequencyLedger: [] };
    return {
      id,
      flags: { "persistent-zones": { runtime } },
      getFlag: () => runtime,
      async update(changes) {
        runtime.triggerFrequencyLedger = changes["flags.persistent-zones.runtime.triggerFrequencyLedger"];
      }
    };
  };
  const bodyRegion = build("wall-body");
  const hotRegion = build("hot-side");
  const parent = { regions: { contents: [bodyRegion, hotRegion] } };
  bodyRegion.parent = parent;
  hotRegion.parent = parent;
  return { bodyRegion, hotRegion };
}

function buildActivity(id, persistentZone, template) {
  return {
    id,
    uuid: `Actor.actor.Item.item.Activity.${id}`,
    type: "persistent-zone",
    name: id,
    duration: { concentration: true },
    target: { template },
    item: { uuid: "Actor.actor.Item.item" },
    persistentZone,
    _source: { persistentZone, target: { template } }
  };
}
