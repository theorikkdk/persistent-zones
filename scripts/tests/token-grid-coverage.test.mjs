import assert from "node:assert/strict";
import test from "node:test";

globalThis.CONST = { GRID_TYPES: { GRIDLESS: 0, SQUARE: 1 } };
globalThis.game = { version: "14.367", settings: { settings: new Map() } };
globalThis.canvas = {
  scene: { id: "scene", grid: { type: 1, size: 100, distance: 5, units: "ft" } },
  grid: { type: 1, size: 100 }
};

const {
  calculateTokenRegionGridCoverage,
  testTokenInsideManagedRegion
} = await import("../runtime/utils.mjs");

test("Medium square-grid occupancy uses the exact 49/50/51 percent boundary", () => {
  assert.equal(inside([{ type: "rectangle", x: 0, y: 200, width: 100, height: 100 }]), false);
  assert.equal(inside([{ type: "rectangle", x: 0, y: 90, width: 100, height: 100 }]), false);
  assert.equal(inside([{ type: "rectangle", x: 0, y: 51, width: 100, height: 100 }]), false);
  assert.equal(inside([{ type: "rectangle", x: 0, y: 50, width: 100, height: 100 }]), true);
  assert.equal(inside([{ type: "rectangle", x: 0, y: 49, width: 100, height: 100 }]), true);
  assert.equal(inside([{ type: "rectangle", x: 0, y: 0, width: 100, height: 100 }]), true);
});

test("a Large token is inside when any occupied cell reaches 50 percent", () => {
  const membership = { x: 0, y: 0, width: 2, height: 2 };
  const affected = calculateTokenRegionGridCoverage(membership, region([
    { type: "rectangle", x: 100, y: 150, width: 100, height: 50 }
  ]));
  assert.equal(affected.testedCellCount, 4);
  assert.equal(affected.affectedCellCount, 1);
  assert.equal(affected.inside, true);

  const unaffected = calculateTokenRegionGridCoverage(membership, region([
    { type: "rectangle", x: 100, y: 151, width: 100, height: 49 }
  ]));
  assert.equal(unaffected.affectedCellCount, 0);
  assert.equal(unaffected.inside, false);
});

test("coverage supports final circle, line, and ring Region shapes", () => {
  assert.equal(inside([{ type: "circle", x: 50, y: 50, radius: 50 }]), true);
  assert.equal(inside([{ type: "line", x: 0, y: 50, length: 100, width: 50, rotation: 0 }]), true);
  assert.equal(inside([{ type: "ring", x: 50, y: 50, radius: 50, innerWidth: 25, outerWidth: 25 }]), true);
});

test("the screenshot-like thin overlap is outside until half the cell is covered", () => {
  const thin = region([{ type: "rectangle", x: 0, y: 90, width: 200, height: 200 }]);
  const half = region([{ type: "rectangle", x: 0, y: 50, width: 200, height: 200 }]);
  assert.equal(testTokenInsideManagedRegion(token(), thin), false);
  assert.equal(testTokenInsideManagedRegion(token(), half), true);
});

test("gridless scenes keep the historical geometric membership path", () => {
  const previousScene = canvas.scene;
  const previousType = canvas.grid.type;
  canvas.scene = { id: "gridless", grid: { type: 0, size: 100 } };
  canvas.grid.type = 0;
  const thin = region([{ type: "rectangle", x: 0, y: 90, width: 100, height: 100 }], canvas.scene);
  assert.equal(calculateTokenRegionGridCoverage({ x: 0, y: 0, width: 1, height: 1 }, thin), null);
  assert.equal(testTokenInsideManagedRegion(token(), thin), true);
  canvas.scene = previousScene;
  canvas.grid.type = previousType;
});

test("wall-restricted Regions trust native membership while unrestricted Regions retain 50 percent coverage", () => {
  const shape = [{ type: "rectangle", x: 0, y: 90, width: 200, height: 200 }];
  const restricted = region(shape);
  restricted.flags["persistent-zones"].runtime.normalizedDefinition.obstacles = { mode: "wall-restricted" };
  const nativeOutside = { ...token(), testInsideRegion: () => false };
  const nativeInside = { ...token(), testInsideRegion: () => true };
  assert.equal(testTokenInsideManagedRegion(nativeOutside, restricted), false);
  assert.equal(testTokenInsideManagedRegion(nativeInside, restricted), true);
  assert.equal(testTokenInsideManagedRegion(nativeInside, region(shape)), false);
});

function inside(shapes) {
  return calculateTokenRegionGridCoverage(
    { x: 0, y: 0, width: 1, height: 1 },
    region(shapes),
    shapes
  ).inside;
}

function region(shapes, parent = canvas.scene) {
  return {
    id: "region",
    parent,
    shapes,
    flags: { "persistent-zones": { runtime: { normalizedDefinition: { geometry: { type: shapes[0]?.type } } } } },
    toObject() { return { shapes: this.shapes, flags: this.flags }; }
  };
}

function token() {
  return { id: "token", x: 0, y: 0, width: 1, height: 1 };
}
