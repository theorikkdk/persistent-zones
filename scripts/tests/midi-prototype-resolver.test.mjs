import assert from "node:assert/strict";
import test from "node:test";

const { buildMidiPrototypeItemData } = await import("../runtime/midi-prototype-resolver.mjs");

test("transient Midi prototype uses the D&D5e save Activity schema", () => {
  globalThis.foundry = { utils: { randomID: () => "synthetic-id" } };
  const item = buildMidiPrototypeItemData({ ability: "dex", dc: 14, formula: "2d6", type: "fire" });
  assert.equal(item.type, "feat");
  assert.equal(item.flags["persistent-zones"].resolution, true);
  const activity = item.system.activities["synthetic-id"];
  assert.equal(activity.type, "save");
  assert.deepEqual(activity.save.ability, ["dex"]);
  assert.deepEqual(activity.save.dc, { calculation: "", formula: "14" });
  assert.equal(activity.damage.onSave, "half");
  assert.equal(activity.damage.parts[0].custom.formula, "2d6");
  assert.deepEqual(activity.damage.parts[0].types, ["fire"]);
  assert.equal(activity.duration.concentration, false);
  assert.deepEqual(activity.consumption.targets, []);
  assert.equal(activity.target.template.type, "");
  assert.equal(activity.flags["persistent-zones"].resolution, true);
});
