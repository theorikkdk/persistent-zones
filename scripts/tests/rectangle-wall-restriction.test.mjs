import assert from "node:assert/strict";
import test from "node:test";

globalThis.canvas = { scene: null };
globalThis.CONFIG = { RegionBehavior: { dataModels: {} } };
globalThis.game = { settings: { settings: new Map() } };

const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const {
  applyConfiguredRegionObstacles,
  buildCentralOriginRectangleShapes
} = await import("../runtime/region-factory.mjs");

const WALL_RESTRICTED = { mode: "wall-restricted", restrictionType: "move", priority: 0 };

function rectangleDefinition(overrides = {}) {
  return {
    geometry: { type: "rectangle", width: 20, height: 10, units: "ft", placement: "center" },
    ...overrides
  };
}

function mockRegion({ levels = ["level-a"], shapes = [{ type: "rectangle", x: 100, y: 200, width: 400, height: 200, anchorX: 0, anchorY: 0, rotation: 0, gridBased: true }] } = {}) {
  const updates = [];
  return {
    _source: { levels },
    levels,
    parent: { levels: { has: (id) => id === "level-a" } },
    shapes,
    updates,
    async update(data) { updates.push(data); }
  };
}

test("rectangle default obstacles are wall-restricted while multipart remains unrestricted", () => {
  const rectangle = normalizeZoneDefinition(rectangleDefinition());
  assert.deepEqual(rectangle.obstacles, WALL_RESTRICTED);

  const multipart = normalizeZoneDefinition(rectangleDefinition({
    parts: [
      { id: "primary", role: "primary", geometry: { type: "template" } },
      { id: "secondary", role: "secondary", geometry: { type: "template" } }
    ]
  }));
  assert.equal(multipart.parts.length, 2);
  assert.equal(multipart.obstacles.mode, "unrestricted");

  for (const definition of [
    { geometry: { type: "circle", radius: 10 } },
    { geometry: { type: "ring", ringReferenceRadius: 10, ringInnerWidth: 1, ringOuterWidth: 1 } },
    { placement: { mode: "attached-source" }, geometry: { type: "emanation", radius: 10 } }
  ]) {
    assert.deepEqual(normalizeZoneDefinition(definition).obstacles, WALL_RESTRICTED);
  }
});

test("a centered rectangle anchor preserves its visible bounds and dimensions", () => {
  const [shape] = buildCentralOriginRectangleShapes([
    { type: "rectangle", x: 100, y: 200, width: 400, height: 200, anchorX: 0, anchorY: 0, rotation: 0, gridBased: true }
  ]);
  assert.deepEqual(shape, {
    type: "rectangle", x: 300, y: 300, width: 400, height: 200,
    anchorX: 0.5, anchorY: 0.5, rotation: 0, gridBased: true
  });
  assert.equal(shape.x - (shape.anchorX * shape.width), 100);
  assert.equal(shape.y - (shape.anchorY * shape.height), 200);
  assert.equal(buildCentralOriginRectangleShapes([{ type: "rectangle", x: 0, y: 0, width: 20, height: 20, rotation: 45 }]), null);
});

test("wall-restricted rectangles receive centered shapes and one resolved Level", async () => {
  const region = mockRegion();
  const definition = rectangleDefinition({ obstacles: { ...WALL_RESTRICTED } });
  assert.equal(await applyConfiguredRegionObstacles(region, definition), true);
  assert.deepEqual(region.updates, [{
    restriction: { enabled: true, type: "move", priority: 0 },
    levels: ["level-a"],
    shapes: [{ type: "rectangle", x: 300, y: 300, width: 400, height: 200, anchorX: 0.5, anchorY: 0.5, rotation: 0, gridBased: true }]
  }]);
});

test("D&D5e rect placement line is re-serialized as a centered rectangle before restriction", async () => {
  const region = mockRegion({
    shapes: [{
      type: "line",
      x: 100,
      y: 300,
      length: 400,
      width: 200,
      rotation: 0,
      gridBased: true
    }]
  });
  const templateDocument = { t: "rect" };
  const definition = rectangleDefinition({ obstacles: { ...WALL_RESTRICTED } });

  assert.equal(await applyConfiguredRegionObstacles(region, definition, { templateDocument }), true);
  assert.deepEqual(region.updates, [{
    restriction: { enabled: true, type: "move", priority: 0 },
    levels: ["level-a"],
    shapes: [{
      type: "rectangle",
      x: 300,
      y: 300,
      width: 400,
      height: 200,
      anchorX: 0.5,
      anchorY: 0.5,
      rotation: 0,
      gridBased: true,
      hole: false
    }]
  }]);
});

test("a real line cannot be promoted to a wall-restricted rectangle without a rect template identity", async () => {
  const region = mockRegion({
    shapes: [{ type: "line", x: 100, y: 300, length: 400, width: 200, rotation: 0 }]
  });
  const definition = rectangleDefinition({ obstacles: { ...WALL_RESTRICTED } });

  assert.equal(await applyConfiguredRegionObstacles(region, definition, { templateDocument: { t: "ray" } }), false);
  assert.equal(definition.obstacles.mode, "unrestricted");
  assert.equal(definition.obstacles.fallbackReason, "unsupported-rectangle-shape");
});

test("wall-restricted rectangle without one resolved Level falls back safely", async () => {
  const region = mockRegion({ levels: [] });
  const definition = rectangleDefinition({ obstacles: { ...WALL_RESTRICTED } });
  assert.equal(await applyConfiguredRegionObstacles(region, definition), false);
  assert.equal(definition.obstacles.mode, "unrestricted");
  assert.equal(definition.obstacles.fallbackReason, "missing-level");
  assert.equal(region.updates.length, 0);
});
