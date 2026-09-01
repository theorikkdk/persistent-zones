import assert from "node:assert/strict";
import test from "node:test";

globalThis.CONST = { GRID_TYPES: { GRIDLESS: 0, SQUARE: 1 } };
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.game = { version: "14.367", settings: { settings: new Map(), get: () => "off" }, combat: null };
globalThis.canvas = {
  scene: { id: "scene", grid: { type: 1, size: 100, distance: 1.5, units: "m" } },
  grid: {
    type: 1, size: 100, isSquare: true, isGridless: false,
    getOffset: ({ x, y }) => ({ i: Math.floor(y / 100), j: Math.floor(x / 100) }),
    getCenterPoint: ({ i, j }) => ({ x: (j * 100) + 50, y: (i * 100) + 50 }),
    measurePath: ([a, b]) => ({ distance: Math.hypot(b.x - a.x, b.y - a.y) / 100 * 1.5 })
  }
};

const { getPersistentZonePreset } = await import("../presets/preset-library.mjs");
const { resolvePresetPersistentZoneForScene } = await import("../presets/preset-utils.mjs");
const { getPersistentZoneActivityDefinition } = await import("../activity/persistent-zone-activity-utils.mjs");
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const {
  analyzeMovementAcrossRegion,
  calculateMovementDistanceProgress,
  claimMovementExecution,
  multiplyDiceFormula
} = await import("../runtime/entry-runtime.mjs");
const { resolveMovementStopGlobalState } = await import("../settings.mjs");

test("Spike Growth builtin is a neutral circle terrain with unlimited distance damage", () => {
  const preset = getPersistentZonePreset("srd-5.2.1.spike-growth").persistentZone;
  assert.deepEqual(preset.geometry, { type: "circle", radius: 20, units: "ft" });
  assert.equal(preset.terrain.enabled, true);
  assert.equal(preset.linkedWalls.enabled, false);
  assert.equal(preset.linkedLights.enabled, false);
  assert.equal(preset.triggers.move.enabled, true);
  assert.equal(preset.triggers.move.frequency, "unlimited");
  assert.deepEqual(preset.triggers.move.simpleEffect.damage, { enabled: true, formula: "2d4", type: "piercing" });
  assert.equal(preset.triggers.move.simpleEffect.save.enabled, false);
  assert.equal(preset.movement.movementMode, "any");
  assert.equal(preset.movement.accumulateRemainder, true);
  assert.equal(preset.movement.interruptionMode, "off");
});

test("Spike Growth radius and movement interval convert once between ft and metric scenes", () => {
  const source = getPersistentZonePreset("srd-5.2.1.spike-growth").persistentZone;
  const metric = resolvePresetPersistentZoneForScene(source, canvas.scene);
  assert.equal(metric.geometry.radius, 6);
  assert.equal(metric.geometry.units, "m");
  assert.equal(metric.movement.distanceStep, 1.5);
  assert.equal(metric.movement.units, "m");
  assert.deepEqual(resolvePresetPersistentZoneForScene(metric, canvas.scene), metric);
  const imperial = resolvePresetPersistentZoneForScene(source, { grid: { units: "ft", distance: 5, size: 100 } });
  assert.equal(imperial.geometry.radius, 20);
  assert.equal(imperial.movement.distanceStep, 5);
});

test("movement remainder accumulates partial distances and resets by ledger scope", () => {
  assert.deepEqual(calculateMovementDistanceProgress(0, 1.5, 1.5), { previousRemainder: 0, completeIntervals: 1, newRemainder: 0 });
  assert.deepEqual(calculateMovementDistanceProgress(0, 3, 1.5), { previousRemainder: 0, completeIntervals: 2, newRemainder: 0 });
  assert.deepEqual(calculateMovementDistanceProgress(0, 0.9, 1.5), { previousRemainder: 0, completeIntervals: 0, newRemainder: 0.9 });
  const second = calculateMovementDistanceProgress(0.9, 0.9, 1.5);
  assert.equal(second.completeIntervals, 1);
  assert.ok(Math.abs(second.newRemainder - 0.3) < 1e-9);
});

test("dice aggregation multiplies dice count without fragile replacement", () => {
  assert.equal(multiplyDiceFormula("2d4", 1), "2d4");
  assert.equal(multiplyDiceFormula("2d4", 2), "4d4");
  assert.equal(multiplyDiceFormula("2d4", 4), "8d4");
  assert.equal(multiplyDiceFormula("1d6 + 2", 3), "(1d6 + 2) * 3");
  assert.equal(multiplyDiceFormula("@abilities.str.mod", 2), "(@abilities.str.mod) * 2");
});

test("Activity round-trip preserves the generic distance movement contract", () => {
  const persistentZone = resolvePresetPersistentZoneForScene(getPersistentZonePreset("srd-5.2.1.spike-growth").persistentZone, canvas.scene);
  const activity = {
    id: "spike", uuid: "Actor.a.Item.i.Activity.spike", type: "persistent-zone", name: "Spike Growth",
    duration: { concentration: true }, item: { uuid: "Actor.a.Item.i" },
    target: { template: { type: "circle", size: 6, units: "m" } }, persistentZone,
    _source: { persistentZone, target: { template: { type: "circle", size: 6, units: "m" } } }
  };
  const definition = getPersistentZoneActivityDefinition(activity);
  const runtime = normalizeZoneDefinition(definition);
  assert.equal(runtime.triggers.onMove.distanceStep, 1.5);
  assert.equal(runtime.triggers.onMove.accumulateRemainder, true);
  assert.equal(runtime.triggers.onMove.aggregateApplications, true);
  assert.equal(runtime.triggers.onMove.movementMode, "any");
  assert.equal(runtime.triggers.onMove.damage.formula, "2d4");
  assert.equal(runtime.triggers.onMove.interruptionMode, "off");
});

test("Activity interruption explicitly overrides the global default", () => {
  game.settings.get = () => "on-enter-and-move";
  assert.equal(resolveMovementStopGlobalState({ interruptionMode: "inherit" }, "onEnter").enabled, true);
  assert.equal(resolveMovementStopGlobalState({ interruptionMode: "inherit" }, "onMove").enabled, true);
  assert.equal(resolveMovementStopGlobalState({ interruptionMode: "off" }, "onEnter").enabled, false);
  assert.equal(resolveMovementStopGlobalState({ interruptionMode: "off" }, "onMove").enabled, false);
  game.settings.get = () => "off";
  assert.equal(resolveMovementStopGlobalState({ interruptionMode: "on-enter" }, "onEnter").enabled, true);
  assert.equal(resolveMovementStopGlobalState({ interruptionMode: "on-enter" }, "onMove").enabled, false);
  assert.equal(resolveMovementStopGlobalState({ interruptionMode: "on-move" }, "onEnter").enabled, false);
  assert.equal(resolveMovementStopGlobalState({ interruptionMode: "on-move" }, "onMove").enabled, true);
});

test("square-grid distance uses eight 50-percent-adjudicated cells for 16d4", () => {
  const region = circleRegionAt(400, 350, 400);
  const analysis = analyzeMovementAcrossRegion(
    token(1), region,
    [state(-100, 350, 1), state(800, 350, 1)],
    false,
    { stepDistancePixels: 100 }
  );
  assert.equal(analysis.insideCellCount, 8);
  assert.equal(Math.round(analysis.insideDistancePixels), 800);
  assert.equal(calculateMovementDistanceProgress(0, analysis.insideDistancePixels / 100 * 1.5, 1.5).completeIntervals, 8);
  assert.equal(multiplyDiceFormula("2d4", 8), "16d4");
  const reverse = analyzeMovementAcrossRegion(
    token(1), region,
    [state(800, 350, 1), state(-100, 350, 1)],
    false,
    { stepDistancePixels: 100 }
  );
  assert.equal(Math.round(reverse.insideDistancePixels), 800);
  assert.equal(calculateMovementDistanceProgress(0, reverse.insideDistancePixels / 100 * 1.5, 1.5).completeIntervals, 8);
});

test("grid-aware measurement follows native diagonal distance and never multiplies Large footprint", () => {
  const region = circleRegionAt(500, 500, 1000);
  const medium = analyzeMovementAcrossRegion(token(1), region, [state(0, 0, 1), state(300, 300, 1)], true);
  const large = analyzeMovementAcrossRegion(token(2), region, [state(0, 0, 2), state(300, 300, 2)], true);
  assert.equal(Math.round(medium.insideDistancePixels), Math.round(large.insideDistancePixels));
  assert.ok(medium.insideDistancePixels > 300);
});

test("49/50/51 percent coverage controls distance-inside on square grids", () => {
  const results = [49, 50, 51].map((coverage) => {
    const shape = { type: "rectangle", x: 0, y: 100 - coverage, width: 100, height: coverage };
    const region = shapedRegion(shape);
    return analyzeMovementAcrossRegion(token(1), region, [state(-100, 0, 1), state(0, 0, 1)], false);
  });
  assert.equal(results[0].insideDistancePixels, 0);
  assert.equal(results[0].insideCellCount, 0);
  assert.equal(Math.round(results[1].insideDistancePixels), 100);
  assert.equal(results[1].insideCellCount, 1);
  assert.equal(Math.round(results[2].insideDistancePixels), 100);
});

test("square-grid boundaries count destination-inside entry and exclude destination-outside exit", () => {
  const region = shapedRegion({ type: "rectangle", x: 0, y: 200, width: 300, height: 100 });
  const entering = analyzeMovementAcrossRegion(token(1), region, [state(-100, 200, 1), state(200, 200, 1)], false);
  const exiting = analyzeMovementAcrossRegion(token(1), region, [state(200, 200, 1), state(-100, 200, 1)], true);
  assert.equal(Math.round(entering.insideDistancePixels), 300);
  assert.equal(Math.round(exiting.insideDistancePixels), 200);
  const entryProgress = calculateMovementDistanceProgress(0, entering.insideDistancePixels / 100 * 1.5, 1.5);
  const exitProgress = calculateMovementDistanceProgress(entryProgress.newRemainder, exiting.insideDistancePixels / 100 * 1.5, 1.5);
  assert.deepEqual(entryProgress, { previousRemainder: 0, completeIntervals: 3, newRemainder: 0 });
  assert.deepEqual(exitProgress, { previousRemainder: 0, completeIntervals: 2, newRemainder: 0 });
  assert.equal(multiplyDiceFormula("2d4", entryProgress.completeIntervals), "6d4");
  assert.equal(multiplyDiceFormula("2d4", exitProgress.completeIntervals), "4d4");

  const oneCellEntry = analyzeMovementAcrossRegion(token(1), region, [state(-100, 200, 1), state(0, 200, 1)], false);
  const oneCellExit = analyzeMovementAcrossRegion(token(1), region, [state(0, 200, 1), state(-100, 200, 1)], true);
  assert.equal(Math.round(oneCellEntry.insideDistancePixels), 100);
  assert.equal(oneCellExit.insideDistancePixels, 0);
});

test("three fully-inside grid transitions are symmetric and deterministic", () => {
  const region = circleRegionAt(300, 300, 1000);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const forward = analyzeMovementAcrossRegion(token(1), region, [state(0, 200, 1), state(300, 200, 1)], true);
    const reverse = analyzeMovementAcrossRegion(token(1), region, [state(300, 200, 1), state(0, 200, 1)], true);
    assert.equal(Math.round(forward.insideDistancePixels), 300);
    assert.equal(Math.round(reverse.insideDistancePixels), 300);
    assert.equal(calculateMovementDistanceProgress(0, forward.insideDistancePixels / 100 * 1.5, 1.5).completeIntervals, 3);
    assert.equal(calculateMovementDistanceProgress(0, reverse.insideDistancePixels / 100 * 1.5, 1.5).completeIntervals, 3);
  }
});

test("movement execution claims deduplicate one sequence but preserve distinct sequences", () => {
  const keyA = `scene|sequence-a|token|region|primary|onMove`;
  const keyB = `scene|sequence-b|token|region|primary|onMove`;
  assert.deepEqual(claimMovementExecution(keyA), { firstSeen: true, duplicate: false });
  assert.deepEqual(claimMovementExecution(keyA), { firstSeen: false, duplicate: true });
  assert.deepEqual(claimMovementExecution(keyB), { firstSeen: true, duplicate: false });
});

test("exact interval multiples normalize remainder to zero", () => {
  for (const distance of [1.5, 3, 4.5]) {
    const progress = calculateMovementDistanceProgress(0, distance, 1.5);
    assert.equal(progress.completeIntervals, distance / 1.5);
    assert.equal(progress.newRemainder, 0);
  }
});

test("an offset circle counts only traversed cells that meet the shared coverage threshold", () => {
  const analysis = analyzeMovementAcrossRegion(
    token(1), circleRegionAt(435, 365, 330),
    [state(0, 300, 1), state(800, 300, 1)],
    false
  );
  assert.ok(analysis.insideCellCount > 0);
  assert.equal(Math.round(analysis.insideDistancePixels), analysis.insideCellCount * 100);
});

test("non-square grids fall back to continuous geometric distance", () => {
  const previous = { isSquare: canvas.grid.isSquare, isGridless: canvas.grid.isGridless, type: canvas.grid.type, sceneType: canvas.scene.grid.type };
  canvas.grid.isSquare = false;
  canvas.grid.isGridless = false;
  canvas.grid.type = 2;
  canvas.scene.grid.type = 2;
  const analysis = analyzeMovementAcrossRegion(token(1), circleRegionAt(300, 300, 150), [state(0, 250, 1), state(600, 250, 1)], false);
  assert.ok(analysis.insideDistancePixels > 0);
  Object.assign(canvas.grid, { isSquare: previous.isSquare, isGridless: previous.isGridless, type: previous.type });
  canvas.scene.grid.type = previous.sceneType;
});

test("inside distance follows waypoints and does not multiply by Large footprint", () => {
  const region = circleRegion();
  const medium = analyzeMovementAcrossRegion(token(1), region, [state(200, 300, 1), state(400, 300, 1)], true);
  const large = analyzeMovementAcrossRegion(token(2), region, [state(200, 300, 2), state(400, 300, 2)], true);
  assert.ok(Math.abs(medium.insideDistancePixels - large.insideDistancePixels) < 0.001);
  const waypointPath = analyzeMovementAcrossRegion(token(1), region, [state(200, 300, 1), state(200, 400, 1), state(300, 400, 1)], true);
  assert.equal(Math.round(waypointPath.insideDistancePixels), 200);
});

test("movement analysis counts only the path portion inside on entry, exit, and full crossing", () => {
  const previousType = canvas.scene.grid.type;
  const previousIsSquare = canvas.grid.isSquare;
  const previousIsGridless = canvas.grid.isGridless;
  canvas.scene.grid.type = 0;
  canvas.grid.type = 0;
  canvas.grid.isSquare = false;
  canvas.grid.isGridless = true;
  const region = boundedCircleRegion();
  const entering = analyzeMovementAcrossRegion(token(1), region, [state(0, 250, 1), state(250, 250, 1)], false);
  const exiting = analyzeMovementAcrossRegion(token(1), region, [state(250, 250, 1), state(600, 250, 1)], true);
  const crossing = analyzeMovementAcrossRegion(token(1), region, [state(0, 250, 1), state(600, 250, 1)], false);
  const missing = analyzeMovementAcrossRegion(token(1), region, [state(0, 0, 1), state(600, 0, 1)], false);
  for (const analysis of [entering, exiting, crossing]) {
    assert.ok(analysis.insideDistancePixels > 0);
    assert.ok(analysis.insideDistancePixels < analysis.pathLengthPixels);
  }
  assert.equal(missing.insideDistancePixels, 0);
  canvas.scene.grid.type = previousType;
  canvas.grid.type = previousType;
  canvas.grid.isSquare = previousIsSquare;
  canvas.grid.isGridless = previousIsGridless;
});

function circleRegion() {
  const runtime = { normalizedDefinition: { geometry: { type: "circle" } } };
  return {
    id: "spike-region", parent: canvas.scene,
    shapes: [{ type: "circle", x: 350, y: 350, radius: 500 }],
    flags: { "persistent-zones": { runtime } }, getFlag: () => runtime,
    toObject() { return { shapes: this.shapes, flags: this.flags }; }
  };
}

function boundedCircleRegion() {
  const region = circleRegion();
  region.shapes = [{ type: "circle", x: 300, y: 300, radius: 150 }];
  return region;
}

function circleRegionAt(x, y, radius) {
  const region = circleRegion();
  region.shapes = [{ type: "circle", x, y, radius }];
  return region;
}

function shapedRegion(shape) {
  const region = circleRegion();
  region.shapes = [shape];
  return region;
}

function token(size) { return { id: `token-${size}`, width: size, height: size }; }
function state(x, y, size) { return { position: { x, y }, width: size, height: size, elevation: 0, shape: null, center: { x: x + size * 50, y: y + size * 50 } }; }
