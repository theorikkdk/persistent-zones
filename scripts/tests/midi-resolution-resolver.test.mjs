import assert from "node:assert/strict";
import test from "node:test";

const resolver = await import("../runtime/midi-resolution-resolver.mjs");
const dispatcher = await import("../runtime/resolution-dispatcher.mjs");

test("synthetic Midi save Activity uses the D&D5e save schema and anti-recursion flags", () => {
  globalThis.foundry = { utils: { randomID: () => "synthetic-id" } };
  const item = resolver.buildMidiResolutionItemData({
    save: { enabled: true, ability: "dex", dc: 14, onSuccess: "half" },
    damage: { enabled: true, formula: "2d6", type: "fire" }
  });
  const activity = item.system.activities["synthetic-id"];
  assert.equal(activity.type, "save");
  assert.deepEqual(activity.save.ability, ["dex"]);
  assert.equal(activity.save.dc.formula, "14");
  assert.equal(activity.damage.onSave, "half");
  assert.equal(activity.damage.parts[0].custom.formula, "2d6");
  assert.equal(resolver.isPersistentZonesSyntheticResolution(activity), true);
});

test("synthetic Midi damage-only Activity has no save and retains typed damage", () => {
  globalThis.foundry = { utils: { randomID: () => "damage-id" } };
  const item = resolver.buildMidiResolutionItemData({ damage: { enabled: true, formula: "3d8", type: "poison" } });
  const activity = item.system.activities["damage-id"];
  assert.equal(activity.type, "damage");
  assert.equal(activity.save, undefined);
  assert.equal(activity.damage.parts[0].custom.formula, "3d8");
  assert.deepEqual(activity.damage.parts[0].types, ["poison"]);
});

test("dispatcher selects native only when the world setting is native", async () => {
  globalThis.game = { settings: { get: () => "native" } };
  globalThis.MidiQOL = { TrapWorkflow() { throw new Error("must not run"); } };
  const result = await dispatcher.resolveResolutionRequest({ request: {} });
  assert.equal(result.engine, "native");
  assert.equal(result.status, "native");
});

test("Midi setting falls back to native once when Midi APIs are unavailable", async () => {
  let warnings = 0;
  globalThis.game = { settings: { get: () => "midi-qol" }, i18n: { localize: () => "fallback" } };
  globalThis.ui = { notifications: { warn: () => warnings++ } };
  globalThis.MidiQOL = null;
  globalThis.CONFIG = null;
  globalThis.Hooks = null;
  dispatcher.resetMidiFallbackWarningForTests();
  const first = await dispatcher.resolveResolutionRequest({ request: {} });
  const second = await dispatcher.resolveResolutionRequest({ request: {} });
  assert.equal(first.engine, "native");
  assert.equal(second.engine, "native");
  assert.equal(warnings, 1);
});

test("Midi resolver uses TrapWorkflow for a save and DamageOnlyWorkflow without one", async () => {
  const hooks = new Map();
  const calls = [];
  globalThis.Hooks = {
    on: (name, callback) => { hooks.set(name, callback); return name; },
    off: (name) => hooks.delete(name)
  };
  globalThis.CONFIG = {
    Item: { documentClass: class {
      constructor(data) { this.system = { activities: { contents: Object.values(data.system.activities), get: (id) => data.system.activities[id] } }; }
      prepareData() {}
      prepareFinalAttributes() {}
    } }
  };
  class TrapWorkflow {
    constructor(...args) { this.aborted = false; this.saves = new Set(); this.damageTotal = 7; calls.push("trap"); queueMicrotask(() => hooks.get("midi-qol.RollComplete")?.(this)); }
  }
  class DamageOnlyWorkflow {
    constructor(...args) { this.aborted = false; this.damageTotal = 4; calls.push("damage-only"); queueMicrotask(() => hooks.get("midi-qol.RollComplete")?.(this)); }
  }
  globalThis.MidiQOL = { TrapWorkflow, DamageOnlyWorkflow };
  globalThis.foundry = { utils: { randomID: () => "workflow-id" } };
  globalThis.Roll = class { constructor() { this.total = 4; } async evaluate() { return this; } };
  const actor = {};
  const token = { id: "target" };
  const saveResult = await resolver.resolveMidiResolution({ sourceActor: actor, targetToken: token, save: { enabled: true, ability: "dex", dc: 12 }, damage: { enabled: true, formula: "2d6", type: "fire" } });
  const damageResult = await resolver.resolveMidiResolution({ sourceActor: actor, targetToken: token, damage: { enabled: true, formula: "2d6", type: "fire" } });
  assert.equal(saveResult.status, "resolved");
  assert.equal(damageResult.status, "resolved");
  assert.deepEqual(calls, ["trap", "damage-only"]);
});
