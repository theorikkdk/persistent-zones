import assert from "node:assert/strict";
import test from "node:test";

globalThis.CONST = { GRID_TYPES: { GRIDLESS: 0, SQUARE: 1 } };
globalThis.game = { version: "14.367", settings: { settings: new Map(), get: () => "off" } };
globalThis.canvas = {
  scene: { id: "scene", grid: { type: 1, size: 100, distance: 5, units: "ft" } },
  grid: { type: 1, size: 100 }
};

const {
  calculateTokenRegionGridCoverage,
  testTokenInsideManagedRegion,
  testTokenTouchesManagedRegion
} = await import("../runtime/utils.mjs");
const { analyzeMovementAcrossRegion, collectRegionEvaluations } = await import("../runtime/entry-runtime.mjs");

test("a centered 1-foot band covers 20 percent of a 5-foot cell", () => {
  const wall = lineRegion();
  const state = tokenState(200, 200);
  const coverage = calculateTokenRegionGridCoverage(membership(state), wall);
  assert.ok(Math.abs(coverage.maxCoverageRatio - 0.2) < 1e-9);
  assert.equal(testTokenInsideManagedRegion(token(), wall, state), false);
  assert.equal(testTokenTouchesManagedRegion(token(), wall, state), true);
});

test("thin-wall movement distinguishes entry, exit, crossing, and parallel movement", () => {
  const wall = lineRegion();
  const cases = [
    { from: tokenState(100, 200), to: tokenState(200, 200), entry: true, exit: false },
    { from: tokenState(200, 200), to: tokenState(300, 200), entry: false, exit: true },
    { from: tokenState(100, 200), to: tokenState(300, 200), entry: true, exit: true },
    { from: tokenState(100, 0), to: tokenState(100, 300), entry: false, exit: false }
  ];
  for (const candidate of cases) {
    const analysis = analyzeMovementAcrossRegion(token(), wall, [candidate.from, candidate.to], testTokenTouchesManagedRegion(token(), wall, candidate.from), {
      membershipTest: testTokenTouchesManagedRegion
    });
    assert.equal(analysis.sawEntry, candidate.entry);
    assert.equal(analysis.sawExit, candidate.exit);
  }
});

test("thin-wall crossing works for Large tokens without changing area membership", () => {
  const wall = lineRegion();
  const from = tokenState(20, 200, 2, 2);
  const to = tokenState(380, 200, 2, 2);
  const analysis = analyzeMovementAcrossRegion(token(2, 2), wall, [from, to], false, { membershipTest: testTokenTouchesManagedRegion });
  assert.equal(analysis.sawEntry, true);
  assert.equal(analysis.sawExit, true);
  assert.equal(testTokenInsideManagedRegion(token(2, 2), wall, tokenState(150, 200, 2, 2)), false);
});

test("thin ring detects crossings but not motion confined to its hole or exterior", () => {
  const ring = ringRegion();
  const crossing = analyzeMovementAcrossRegion(token(), ring, [tokenState(250, 250), tokenState(520, 250)], false, { membershipTest: testTokenTouchesManagedRegion });
  assert.equal(crossing.sawEntry, true);
  assert.equal(crossing.sawExit, true);
  const hole = analyzeMovementAcrossRegion(token(), ring, [tokenState(250, 250), tokenState(260, 250)], false, { membershipTest: testTokenTouchesManagedRegion });
  assert.equal(hole.sawEntry, false);
  const exterior = analyzeMovementAcrossRegion(token(), ring, [tokenState(520, 0), tokenState(520, 100)], false, { membershipTest: testTokenTouchesManagedRegion });
  assert.equal(exterior.sawEntry, false);
  assert.equal(testTokenTouchesManagedRegion(token(), ring, tokenState(450, 250)), true);
});

test("runtime evaluation resolves one enter for Medium and Large complete crossings", () => {
  const wall = lineRegion();
  for (const size of [1, 2]) {
    const from = tokenState(20, 200, size, size);
    const to = tokenState(380, 200, size, size);
    const [evaluation] = collectRegionEvaluations(token(size, size), [wall], {
      scene: canvas.scene,
      moveSource: "updateToken",
      fromState: from,
      toState: to,
      pathStates: [from, to],
      movementMode: "voluntary",
      movementSequenceId: `crossing-${size}`
    });
    assert.equal(evaluation.fromInside, false);
    assert.equal(evaluation.toInside, false);
    assert.equal(evaluation.enterDetected, true);
    assert.equal(evaluation.movementAnalysis.transitions.filter(({ type }) => type === "onEnter").length, 1);
  }
});

test("runtime evaluation does not invent an enter for parallel thin-wall movement", () => {
  const wall = lineRegion();
  const from = tokenState(100, 0);
  const to = tokenState(100, 300);
  const [evaluation] = collectRegionEvaluations(token(), [wall], {
    scene: canvas.scene,
    moveSource: "updateToken",
    fromState: from,
    toState: to,
    pathStates: [from, to],
    movementMode: "voluntary",
    movementSequenceId: "parallel"
  });
  assert.equal(evaluation.enterDetected, false);
});

function lineRegion() {
  return region([{ type: "line", x: 250, y: 0, length: 500, width: 20, rotation: 90 }], "template");
}

function ringRegion() {
  return region([{ type: "ring", x: 300, y: 300, radius: 200, innerWidth: 20, outerWidth: 0 }], "ring");
}

function region(shapes, geometryType) {
  const runtime = {
    partId: "wall-body",
    normalizedDefinition: {
      enabled: true,
      geometry: { type: geometryType },
      interaction: { mode: "thin-wall" },
      targeting: { mode: "all" },
      triggers: {
        onEnter: { enabled: true, movementMode: "any" },
        onExit: { enabled: false, movementMode: "any" },
        onMove: { enabled: false, movementMode: "any", stepMode: "distance", distanceStep: 5 }
      }
    }
  };
  return {
    id: "region",
    parent: canvas.scene,
    shapes,
    flags: { "persistent-zones": { runtime } },
    getFlag: () => runtime,
    toObject() { return { shapes: this.shapes, flags: this.flags }; }
  };
}

function token(width = 1, height = 1) {
  return { id: "token", x: 0, y: 0, width, height };
}

function tokenState(x, y, width = 1, height = 1) {
  return { position: { x, y }, width, height, elevation: 0, shape: null, center: { x: x + width * 50, y: y + height * 50 } };
}

function membership(state) {
  return { x: state.position.x, y: state.position.y, width: state.width, height: state.height };
}
