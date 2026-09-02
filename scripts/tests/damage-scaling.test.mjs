import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = { version: "14.367", settings: { settings: new Map() } };
globalThis.canvas = { scene: null, grid: { size: 100 } };
globalThis.CONFIG = { RegionBehavior: { dataModels: {} } };

const { resolveScaledFormula } = await import("../runtime/damage-scaling.mjs");
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const { BUILTIN_PRESETS } = await import("../presets/builtins.mjs");

const itemScaling = { mode: "per-level", baseLevelMode: "item", baseLevel: 1, perLevelFormula: "1d8" };
const fixedScaling = { mode: "per-level", baseLevelMode: "fixed", baseLevel: 3, perLevelFormula: "1d8" };

test("item-level scaling applies the complete extra formula once per higher slot", () => {
  assert.equal(resolveScaledFormula({ formula: "3d8", scaling: itemScaling, castLevel: 1, itemBaseLevel: 1 }).formula, "3d8");
  assert.equal(resolveScaledFormula({ formula: "3d8", scaling: itemScaling, castLevel: 2, itemBaseLevel: 1 }).formula, "3d8 + (1d8)");
  const fifth = resolveScaledFormula({ formula: "3d8", scaling: itemScaling, castLevel: 3, itemBaseLevel: 1 });
  assert.equal(fifth.formula, "3d8 + (1d8) + (1d8)");
  assert.equal(fifth.extraLevels, 2);
  assert.equal(fifth.scaling.resolvedBaseLevel, 1);
});

test("level-three spells, fixed mode, and legacy numeric base levels remain supported", () => {
  assert.equal(resolveScaledFormula({ formula: "3d8", scaling: itemScaling, castLevel: 3, itemBaseLevel: 3 }).formula, "3d8");
  assert.equal(resolveScaledFormula({ formula: "3d8", scaling: itemScaling, castLevel: 4, itemBaseLevel: 3 }).formula, "3d8 + (1d8)");
  assert.equal(resolveScaledFormula({ formula: "3d8", scaling: itemScaling, castLevel: 5, itemBaseLevel: 3 }).formula, "3d8 + (1d8) + (1d8)");
  assert.equal(resolveScaledFormula({ formula: "3d8", scaling: fixedScaling, castLevel: 4, itemBaseLevel: 1 }).formula, "3d8 + (1d8)");
  assert.equal(resolveScaledFormula({ formula: "3d8", scaling: { mode: "per-level", baseLevel: 3, perLevelFormula: "1d8" }, castLevel: 4, itemBaseLevel: 1 }).formula, "3d8 + (1d8)");
});

test("scaling is safe for absent or lower cast levels and supports constants", () => {
  assert.equal(resolveScaledFormula({ formula: "3d8", scaling: itemScaling, castLevel: null, itemBaseLevel: 1 }).formula, "3d8");
  assert.equal(resolveScaledFormula({ formula: "3d8", scaling: itemScaling, castLevel: 0, itemBaseLevel: 1 }).formula, "3d8");
  assert.equal(
    resolveScaledFormula({ formula: "2d6", scaling: { mode: "per-level", baseLevelMode: "item", perLevelFormula: "3" }, castLevel: 3, itemBaseLevel: 1 }).formula,
    "2d6 + (3) + (3)"
  );
});

test("normalized trigger retains scaling and cast level throughout the zone lifetime", () => {
  const normalized = normalizeZoneDefinition({
    label: "Scaling",
    castLevel: 5,
    geometry: { type: "circle", radius: 10 },
    triggers: {
      onEnter: {
        enabled: true,
        mode: "simple-effect",
        simpleEffect: { damage: { enabled: true, formula: "3d8", type: "radiant", scaling: itemScaling } }
      }
    }
  }, { item: { system: { level: 3 } } });
  assert.equal(normalized.castLevel, 5);
  assert.equal(normalized.triggers.onEnter.damage.scaling.baseLevelMode, "item");
  assert.equal(normalized.triggers.onEnter.damage.scaling.itemBaseLevel, 3);
  assert.equal(normalized.triggers.onEnter.damage.scaling.resolvedBaseLevel, 3);
  assert.equal(resolveScaledFormula({
    formula: "3d8",
    scaling: normalized.triggers.onEnter.damage.scaling,
    castLevel: normalized.castLevel
  }).formula, "3d8 + (1d8) + (1d8)");
});

test("the same scaling configuration is preserved for every damage trigger timing", () => {
  const triggers = Object.fromEntries(["onCreate", "onEnter", "onMove", "onExit", "onStartTurn", "onEndTurn"].map((timing) => [timing, {
    enabled: true,
    mode: "simple-effect",
    simpleEffect: { damage: { enabled: true, formula: "2d6", type: "fire", scaling: { mode: "per-level", baseLevelMode: "item", perLevelFormula: "1d6" } } }
  }]));
  const normalized = normalizeZoneDefinition({ castLevel: 4, geometry: { type: "circle", radius: 10 }, triggers }, { item: { system: { level: 2 } } });
  for (const timing of Object.keys(triggers)) {
    assert.equal(normalized.triggers[timing].damage.scaling.baseLevelMode, "item");
    assert.equal(normalized.triggers[timing].damage.scaling.resolvedBaseLevel, 2);
  }
});

test("formula scaling is effect-neutral and carries stable roll data", () => {
  const result = resolveScaledFormula({
    formula: "2d6 + 3",
    scaling: { mode: "per-level", baseLevelMode: "item", perLevelFormula: "1d4 + 1" },
    castLevel: 3,
    itemBaseLevel: 1
  });
  assert.equal(result.formula, "2d6 + 3 + (1d4 + 1) + (1d4 + 1)");
  assert.equal(result.rollData.castLevel, 3);
  assert.equal(result.rollData.pz.baseLevel, 1);
  assert.equal(result.rollData.pz.extraLevels, 2);
});

test("damage, healing, and temporary hit points retain independent scaling", () => {
  const scaling = { mode: "per-level", baseLevelMode: "item", perLevelFormula: "1d8" };
  const normalized = normalizeZoneDefinition({
    label: "Recovery scaling",
    castLevel: 3,
    geometry: { type: "circle", radius: 10 },
    triggers: {
      onEnter: {
        enabled: true,
        mode: "simple-effect",
        simpleEffect: {
          damage: { enabled: true, formula: "2d6", type: "force", scaling },
          healing: { enabled: true, formula: "2d8", scaling },
          temporaryHitPoints: { enabled: true, formula: "5", scaling: { ...scaling, perLevelFormula: "5" } }
        }
      }
    }
  }, { item: { system: { level: 1 } } });
  const trigger = normalized.triggers.onEnter;
  assert.equal(resolveScaledFormula({ formula: trigger.damage.formula, scaling: trigger.damage.scaling, castLevel: 3 }).formula, "2d6 + (1d8) + (1d8)");
  assert.equal(resolveScaledFormula({ formula: trigger.healing.formula, scaling: trigger.healing.scaling, castLevel: 3 }).formula, "2d8 + (1d8) + (1d8)");
  assert.equal(resolveScaledFormula({ formula: trigger.temporaryHitPoints.formula, scaling: trigger.temporaryHitPoints.scaling, castLevel: 3 }).formula, "5 + (5) + (5)");
});

test("legacy formula effects remain unscaled and debug presets carry explicit scaling", () => {
  const legacy = normalizeZoneDefinition({ geometry: { type: "circle", radius: 10 }, triggers: { onEnter: { enabled: true, mode: "simple-effect", simpleEffect: { damage: { enabled: true, formula: "2d6", type: "fire" } } } } });
  assert.equal(legacy.triggers.onEnter.damage.scaling.mode, "none");
  assert.equal(legacy.triggers.onEnter.healing.scaling.mode, "none");
  assert.equal(legacy.triggers.onEnter.temporaryHitPoints.scaling.mode, "none");
  for (const id of ["debug.damage-scaling-3d8", "debug.damage-scaling-constant", "debug.healing-scaling", "debug.temporary-hit-points-scaling"]) {
    const preset = BUILTIN_PRESETS.find((candidate) => candidate.id === id);
    const effects = preset?.persistentZone?.triggers?.enter?.simpleEffect ?? {};
    const scaledEffect = effects.damage?.scaling?.mode === "per-level"
      ? effects.damage
      : effects.healing?.scaling?.mode === "per-level"
        ? effects.healing
        : effects.temporaryHitPoints;
    assert.equal(scaledEffect?.scaling?.mode, "per-level");
    assert.equal(scaledEffect?.scaling?.baseLevelMode, "item");
  }
});
