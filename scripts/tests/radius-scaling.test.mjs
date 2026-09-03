import assert from "node:assert/strict";
import test from "node:test";
import { applyResolvedRadiusToTemplateData, resolveScaledRadius } from "../runtime/radius-scaling.mjs";
import { getPersistentZonePreset } from "../presets/preset-library.mjs";
import { resolvePresetPersistentZoneForScene } from "../presets/preset-utils.mjs";
import { convertCanonicalDistanceToSceneUnits } from "../activity/activity-distance.mjs";
import { resolvePersistentZoneCastLevel } from "../activity/cast-level.mjs";

test("radius scaling uses the item level by default and freezes the resolved radius", () => {
  const scaling = { mode: "per-level", baseLevelMode: "item", radiusPerLevel: 20 };
  assert.equal(resolveScaledRadius({ radius: 20, scaling, itemBaseLevel: 1, castLevel: 1 }).radius, 20);
  assert.equal(resolveScaledRadius({ radius: 20, scaling, itemBaseLevel: 1, castLevel: 2 }).radius, 40);
  assert.equal(resolveScaledRadius({ radius: 20, scaling, itemBaseLevel: 1, castLevel: 3 }).radius, 60);
});

test("fixed radius scaling and missing scaling preserve safe legacy behavior", () => {
  assert.equal(resolveScaledRadius({ radius: 10, scaling: { mode: "per-level", baseLevelMode: "fixed", baseLevel: 3, radiusPerLevel: 5 }, castLevel: 4 }).radius, 15);
  assert.equal(resolveScaledRadius({ radius: 10, castLevel: 4, itemBaseLevel: 1 }).radius, 10);
});

test("Fog Cloud stores explicit generic radius scaling", () => {
  const preset = getPersistentZonePreset("srd-5.2.1.fog-cloud");
  assert.deepEqual(preset.persistentZone.geometry.scaling, { mode: "per-level", baseLevelMode: "item", baseLevel: 1, radiusPerLevel: 20 });
  assert.equal(preset.persistentZone.obscuration.mode, "heavily-obscured");
});

test("canonical SRD distances resolve against scene units, not UI locale", () => {
  const metric = { grid: { units: "m" } };
  const imperial = { grid: { units: "ft" } };
  for (const [feet, meters] of [[5, 1.5], [15, 4.5], [20, 6], [100, 30]]) {
    assert.equal(convertCanonicalDistanceToSceneUnits(feet, "ft", metric), meters);
    assert.equal(convertCanonicalDistanceToSceneUnits(feet, "ft", imperial), feet);
  }
});

test("Fog Cloud converts both its base radius and per-slot radius before use", () => {
  const fog = getPersistentZonePreset("srd-5.2.1.fog-cloud");
  const metric = resolvePresetPersistentZoneForScene(fog.persistentZone, { grid: { units: "m" } });
  const imperial = resolvePresetPersistentZoneForScene(fog.persistentZone, { grid: { units: "ft" } });
  assert.deepEqual(metric.geometry.scaling, { mode: "per-level", baseLevelMode: "item", baseLevel: 1, radiusPerLevel: 6 });
  assert.equal(metric.geometry.radius, 6);
  assert.deepEqual([1, 2, 3].map((castLevel) => resolveScaledRadius({ radius: metric.geometry.radius, scaling: metric.geometry.scaling, itemBaseLevel: 1, castLevel }).radius), [6, 12, 18]);
  assert.equal(imperial.geometry.radius, 20);
  assert.deepEqual([1, 2, 3].map((castLevel) => resolveScaledRadius({ radius: imperial.geometry.radius, scaling: imperial.geometry.scaling, itemBaseLevel: 1, castLevel }).radius), [20, 40, 60]);
});

test("native template creation receives the resolved world radius instead of an Item target fallback", () => {
  const templateData = {
    t: "circle",
    distance: 60.000001,
    flags: { dnd5e: { dimensions: { size: 60.000001 } } }
  };
  assert.equal(applyResolvedRadiusToTemplateData(templateData, 6), true);
  assert.equal(templateData.distance, 6);
  assert.equal(templateData.flags.dnd5e.dimensions.size, 6);
});

test("D&D5e finalized spell-slot scaling reaches the native template payload", () => {
  const metricFog = resolvePresetPersistentZoneForScene(
    getPersistentZonePreset("srd-5.2.1.fog-cloud").persistentZone,
    { grid: { units: "m" } }
  );
  const item = { system: { level: 1 } };
  const actor = { system: { spells: {
    spell1: { level: 1 }, spell2: { level: 2 }, spell3: { level: 3 }, spell4: { level: 4 }
  } } };
  const distances = [0, 1, 2, 3].map((scaling) => {
    const usage = { spell: { slot: `spell${scaling + 1}` }, scaling };
    const cast = resolvePersistentZoneCastLevel({ usage, item, actor });
    const resolved = resolveScaledRadius({
      radius: metricFog.geometry.radius,
      scaling: metricFog.geometry.scaling,
      castLevel: cast.castLevel,
      itemBaseLevel: item.system.level
    });
    const templateData = { distance: 60.000001, flags: { dnd5e: { dimensions: { size: 60.000001 } } } };
    applyResolvedRadiusToTemplateData(templateData, resolved.radius);
    assert.equal(cast.castLevel, scaling + 1);
    assert.equal(cast.usageScaling, scaling);
    return templateData.distance;
  });
  assert.deepEqual(distances, [6, 12, 18, 24]);
});
