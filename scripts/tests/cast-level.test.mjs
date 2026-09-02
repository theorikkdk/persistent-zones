import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.game = { version: "14.367", settings: { settings: new Map() } };
globalThis.canvas = { scene: null, grid: { size: 100 } };

const { resolvePersistentZoneCastLevel } = await import("../activity/cast-level.mjs");
const { resolvePersistentZoneConfiguration } = await import("../runtime/configuration-resolver.mjs");
const { resolveScaledDamageFormula } = await import("../runtime/damage-scaling.mjs");
const { buildLegacyDefinitionFromPersistentZoneActivity } = await import("../activity/persistent-zone-activity-utils.mjs");

const item = { system: { level: 3 } };
const actor = { system: { spells: { spell3: { level: 3 }, spell4: { level: 4 }, spell5: { level: 5 } } } };

for (const level of [3, 4, 5]) {
  test(`D&D5e selected spell${level} resolves to cast level ${level}`, () => {
    const resolved = resolvePersistentZoneCastLevel({ usage: { spell: { slot: `spell${level}` }, scaling: level - 3 }, item, actor });
    assert.equal(resolved.castLevel, level);
    assert.equal(resolved.source, "usage.spell.slot");
    assert.equal(resolveScaledDamageFormula({
      formula: "3d8",
      scaling: { mode: "per-level", baseLevel: 3, perLevelFormula: "1d8" },
      castLevel: resolved.castLevel
    }).formula, level === 3 ? "3d8" : level === 4 ? "3d8 + (1d8)" : "3d8 + (1d8) + (1d8)");
  });
}

test("missing D&D5e slot data safely falls back to the Item base level", () => {
  const resolved = resolvePersistentZoneCastLevel({ usage: {}, item, actor });
  assert.equal(resolved.castLevel, 3);
  assert.equal(resolved.source, "item.system.level-fallback");
});

test("runtime configuration persists the selected slot level without mutating the Activity definition", () => {
  const definition = { geometry: { type: "circle", radius: 10 }, triggers: {} };
  const activity = { type: "persistent-zone", persistentZone: definition };
  const configuration = resolvePersistentZoneConfiguration({ activity, item, actor, castLevel: 5 });
  assert.equal(configuration.normalizedDefinition.castLevel, 5);
  assert.equal(definition.castLevel, undefined);
});

test("Activity-to-runtime conversion retains configured damage scaling", () => {
  const persistentZone = {
    geometry: { type: "circle", radius: 10 },
    triggers: {
      enter: {
        enabled: true,
        mode: "simple",
        simpleEffect: {
          damage: {
            enabled: true,
            formula: "3d8",
            type: "radiant",
            scaling: { mode: "per-level", baseLevel: 3, perLevelFormula: "1d8" }
          }
        }
      }
    }
  };
  const definition = buildLegacyDefinitionFromPersistentZoneActivity({
    type: "persistent-zone", name: "Scaling", persistentZone
  }, persistentZone);
  const configuration = resolvePersistentZoneConfiguration({
    activity: { type: "persistent-zone", persistentZone }, item, actor, castLevel: 4
  });
  assert.deepEqual(definition.triggers.onEnter.damage.scaling, { mode: "per-level", baseLevel: 3, perLevelFormula: "1d8" });
  assert.equal(configuration.normalizedDefinition.triggers.onEnter.damage.scaling.mode, "per-level");
  assert.equal(resolveScaledDamageFormula({
    formula: configuration.normalizedDefinition.triggers.onEnter.damage.formula,
    scaling: configuration.normalizedDefinition.triggers.onEnter.damage.scaling,
    castLevel: configuration.normalizedDefinition.castLevel
  }).formula, "3d8 + (1d8)");
});
