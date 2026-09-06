import assert from "node:assert/strict";
import test from "node:test";

globalThis.CONST = { GRID_TYPES: { GRIDLESS: 0, SQUARE: 1, HEXODDR: 2 } };
globalThis.game = { version: "14.367", settings: { get: () => "footprint-50", settings: new Map() } };
globalThis.canvas = { scene: { id: "scene", grid: { type: 1, size: 100 } }, grid: { type: 1, size: 100 } };

const { calculateTokenRegionGridCoverage, testTokenInsideManagedRegion } = await import("../runtime/utils.mjs");

test("Medium Token uses the exact 49/50/51 total-footprint boundary", () => {
  assertCoverage(0.49, false);
  assertCoverage(0.50, true);
  assertCoverage(0.51, true);
});

test("Large Token evaluates total footprint rather than any individual occupied cell", () => {
  const membership = { x: 0, y: 0, width: 2, height: 2 };
  const quarter = coverage(membership, [{ type: "rectangle", x: 0, y: 0, width: 100, height: 100 }]);
  const half = coverage(membership, [{ type: "rectangle", x: 0, y: 0, width: 200, height: 100 }]);
  const threeQuarters = coverage(membership, [{ type: "rectangle", x: 0, y: 0, width: 200, height: 150 }]);
  assert.equal(quarter.coverageRatio, 0.25);
  assert.equal(quarter.inside, false, "one fully covered cell out of four is outside");
  assert.equal(half.coverageRatio, 0.5);
  assert.equal(half.inside, true);
  assert.equal(threeQuarters.coverageRatio, 0.75);
  assert.equal(threeQuarters.inside, true);
});

test("Huge and rectangular Token footprints retain one total coverage threshold", () => {
  const huge = coverage({ x: 0, y: 0, width: 3, height: 3 }, [{ type: "rectangle", x: 0, y: 0, width: 300, height: 120 }]);
  const rectangular = coverage({ x: 0, y: 0, width: 3, height: 2 }, [{ type: "rectangle", x: 0, y: 0, width: 300, height: 100 }]);
  assert.equal(huge.coverageRatio, 0.4);
  assert.equal(huge.inside, false);
  assert.equal(rectangular.coverageRatio, 0.5);
  assert.equal(rectangular.inside, true);
});

test("gridless scenes use the same rectangular Token footprint policy", () => {
  const previousScene = canvas.scene;
  const previousType = canvas.grid.type;
  canvas.scene = { id: "gridless", grid: { type: 0, size: 100 } };
  canvas.grid.type = 0;
  const result = coverage({ x: 0, y: 0, width: 2, height: 2 }, [{ type: "rectangle", x: 0, y: 0, width: 100, height: 100 }], canvas.scene);
  assert.equal(result.coverageRatio, 0.25);
  assert.equal(result.inside, false);
  canvas.scene = previousScene;
  canvas.grid.type = previousType;
});

test("multiple shapes use union coverage and never double count overlaps", () => {
  const overlap = coverage({ x: 0, y: 0, width: 1, height: 1 }, [
    { type: "rectangle", x: 0, y: 0, width: 30, height: 100 },
    { type: "rectangle", x: 0, y: 0, width: 30, height: 100 }
  ]);
  const union = coverage({ x: 0, y: 0, width: 1, height: 1 }, [
    { type: "rectangle", x: 0, y: 0, width: 30, height: 100 },
    { type: "rectangle", x: 30, y: 0, width: 30, height: 100 }
  ]);
  assert.ok(Math.abs(overlap.coverageRatio - 0.3) < 0.01);
  assert.ok(Math.abs(union.coverageRatio - 0.6) < 0.01);
  assert.equal(union.inside, true);
});

test("circle and empty intersection return actual footprint coverage", () => {
  const full = coverage({ x: 0, y: 0, width: 1, height: 1 }, [{ type: "circle", x: 50, y: 50, radius: 100 }]);
  const none = coverage({ x: 0, y: 0, width: 1, height: 1 }, [{ type: "circle", x: 300, y: 300, radius: 10 }]);
  assert.ok(full.coverageRatio > 0.99);
  assert.equal(full.inside, true);
  assert.equal(none.coverageRatio, 0);
  assert.equal(none.inside, false);
});

test("hex scenes deliberately fall back to native membership", () => {
  const previousScene = canvas.scene;
  const previousType = canvas.grid.type;
  canvas.scene = { id: "hex", grid: { type: 2, size: 100 } };
  canvas.grid.type = 2;
  assert.equal(coverage({ x: 0, y: 0, width: 1, height: 1 }, [{ type: "rectangle", x: 0, y: 0, width: 100, height: 100 }], canvas.scene), null);
  assert.equal(testTokenInsideManagedRegion({ ...token(), testInsideRegion: () => true }, region([{ type: "rectangle", x: 0, y: 90, width: 100, height: 100 }], canvas.scene)), true);
  canvas.scene = previousScene;
  canvas.grid.type = previousType;
});

test("M11D native exclusion gates footprint coverage without replacing it", () => {
  const restricted = region([{ type: "rectangle", x: 0, y: 0, width: 100, height: 100 }]);
  restricted.flags["persistent-zones"].runtime.normalizedDefinition.obstacles = { mode: "wall-restricted" };
  assert.equal(testTokenInsideManagedRegion({ ...token(), testInsideRegion: () => false }, restricted), false);
  const partial = region([{ type: "rectangle", x: 0, y: 51, width: 100, height: 100 }]);
  partial.flags["persistent-zones"].runtime.normalizedDefinition.obstacles = { mode: "wall-restricted" };
  assert.equal(testTokenInsideManagedRegion({ ...token(), testInsideRegion: () => true }, partial), false);
});

test("Foundry-native mode delegates the final decision to token.testInsideRegion", () => {
  const previousGet = game.settings.get;
  game.settings.get = () => "foundry-native";
  const partial = region([{ type: "rectangle", x: 0, y: 51, width: 100, height: 100 }]);
  assert.equal(testTokenInsideManagedRegion({ ...token(), testInsideRegion: () => true }, partial), true);
  game.settings.get = previousGet;
});

function assertCoverage(ratio, expectedInside) {
  const result = coverage({ x: 0, y: 0, width: 1, height: 1 }, [{ type: "rectangle", x: 0, y: (1 - ratio) * 100, width: 100, height: 100 }]);
  assert.equal(result.inside, expectedInside);
}

function coverage(membership, shapes, parent = canvas.scene) {
  const target = region(shapes, parent);
  return calculateTokenRegionGridCoverage(membership, target, shapes);
}

function region(shapes, parent = canvas.scene) {
  return { id: "region", parent, shapes, flags: { "persistent-zones": { runtime: { normalizedDefinition: { geometry: { type: shapes[0]?.type } } } } }, toObject() { return { shapes: this.shapes, flags: this.flags }; } };
}

function token() {
  return { id: "token", uuid: "Scene.scene.Token.token", x: 0, y: 0, width: 1, height: 1 };
}
