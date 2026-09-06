import assert from "node:assert/strict";
import test from "node:test";
import { measureCircleTokenProximity, sweepPhysicalBodyAgainstTokens } from "../runtime/physical-targeting.mjs";
globalThis.canvas ??= { scene: { grid: { size: 100, distance: 1, units: "scene" } }, grid: { size: 100, distance: 1, units: "scene" } };
import { testTurnTriggerTargeting } from "../runtime/turn-runtime.mjs";

const scene = { grid: { size: 100, distance: 1, units: "scene" } };
const token = (id, x, y, width = 1, height = 1) => ({ id, uuid: `Scene.s.Token.${id}`, x, y, width, height, actor: {} });

test("physical circle contact selects the first footprint without membership coverage", () => {
  const first = token("medium", 300, 50);
  const second = token("large", 500, 0, 2, 2);
  const result = sweepPhysicalBodyAgainstTokens({ origin: { x: 100, y: 100 }, destination: { x: 800, y: 100 }, body: { type: "circle", radius: 25 }, tokens: [second, first], scene });
  assert.equal(result.tokenUuid, first.uuid);
  assert.ok(result.fraction > 0 && result.fraction < 1);
});

test("physical contact permits a body already touching at the origin to leave", () => {
  const overlapping = token("origin", 50, 50);
  const result = sweepPhysicalBodyAgainstTokens({ origin: { x: 100, y: 100 }, destination: { x: 500, y: 100 }, body: { type: "circle", radius: 25 }, tokens: [overlapping], scene });
  assert.equal(result, null);
});

test("proximity measures body edge to Medium Large and Huge footprints", () => {
  assert.equal(measureCircleTokenProximity({ center: { x: 0, y: 50 }, radius: 25, token: token("medium", 100, 0), scene }).distance, 75);
  assert.equal(measureCircleTokenProximity({ center: { x: 0, y: 100 }, radius: 25, token: token("large", 100, 0, 2, 2), scene }).distance, 75);
  assert.equal(measureCircleTokenProximity({ center: { x: 0, y: 150 }, radius: 25, token: token("huge", 100, 0, 3, 3), scene }).distance, 75);
});

test("turn-end proximity evaluates a nearby Large Token without membership", () => {
  const region = { _source: { shapes: [{ type: "circle", x: 100, y: 100, radius: 25 }] }, parent: scene };
  const large = token("near-large", 140, 0, 2, 2);
  const selected = testTurnTriggerTargeting({
    tokenDocument: large, regionDocument: region, scene,
    normalizedDefinition: { controlledMovement: { physicalRadius: 0.25, units: "scene" } },
    triggerConfig: { targeting: { mode: "proximity", distance: 0.5 } }
  });
  assert.equal(selected, true);
});
