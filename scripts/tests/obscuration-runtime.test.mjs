import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  canvas: {
    perception: {
      DetectionMode: {
        DETECTION_TYPES: { SIGHT: 0, OTHER: 3 }
      }
    }
  }
};
globalThis.canvas = { scene: null };
globalThis.game = { settings: { settings: new Map(), get: () => "off" } };

const {
  evaluateHeavilyObscuredLOS,
  getObscurationEligibility,
  isHeavilyObscuredRegion,
  isSightDetectionMode,
  resolveDebugRegionVisibility,
  segmentMayIntersectBounds,
  segmentTraversesFinalRegionGeometry
} = await import("../runtime/obscuration-runtime.mjs");
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");

const source = { origin: { x: 0, y: 0, elevation: 0 } };
const destination = { point: { x: 100, y: 0, elevation: 0 } };

function region({ id = "fog", bounds = { x: 40, y: -10, width: 20, height: 20 }, segments = [] } = {}) {
  return {
    id,
    bounds,
    segmentizeMovementPath: () => segments
  };
}

function traversingSegment() {
  return [{ type: "MOVE", from: { x: 40, y: 0, elevation: 0 }, to: { x: 60, y: 0, elevation: 0 } }];
}

test("obscuration preserves normal sight when no obscuring Region exists", () => {
  const result = evaluateHeavilyObscuredLOS({ visionSource: source, test: destination, regions: [] });
  assert.equal(result.result, true);
  assert.equal(result.regionCount, 0);
});

test("a Region outside the segment bounds leaves sight unchanged", () => {
  const result = evaluateHeavilyObscuredLOS({
    visionSource: source,
    test: destination,
    regions: [region({ bounds: { x: 40, y: 30, width: 20, height: 20 }, segments: traversingSegment() })]
  });
  assert.equal(result.result, true);
  assert.equal(result.boundedRegionCount, 0);
});

test("a traversed final Region geometry blocks Sight", () => {
  const fog = region({ segments: traversingSegment() });
  const result = evaluateHeavilyObscuredLOS({ visionSource: source, test: destination, regions: [fog] });
  assert.equal(result.result, false);
  assert.equal(result.blockingRegion, fog);
});

test("source inside and source plus target inside both block Sight through nonzero final geometry", () => {
  const fog = region({
    bounds: { x: -10, y: -10, width: 130, height: 20 },
    segments: [{ type: "MOVE", from: { x: 0, y: 0, elevation: 0 }, to: { x: 100, y: 0, elevation: 0 } }]
  });
  const fromInside = evaluateHeavilyObscuredLOS({ visionSource: source, test: destination, regions: [fog] });
  assert.equal(fromInside.result, false);

  const bothInside = evaluateHeavilyObscuredLOS({
    visionSource: { origin: { x: 20, y: 0, elevation: 0 } },
    test: { point: { x: 80, y: 0, elevation: 0 } },
    regions: [fog]
  });
  assert.equal(bothInside.result, false);
});

test("one of multiple obscuring Regions is sufficient", () => {
  const result = evaluateHeavilyObscuredLOS({
    visionSource: source,
    test: destination,
    regions: [
      region({ id: "outside", bounds: { x: 30, y: 30, width: 10, height: 10 }, segments: [] }),
      region({ id: "blocking", segments: traversingSegment() })
    ]
  });
  assert.equal(result.result, false);
  assert.equal(result.blockingRegion.id, "blocking");
});

test("visual DetectionModes remain eligible for obscuration", () => {
  const sightType = { constructor: { DETECTION_TYPES: { SIGHT: 0 } }, type: 0 };
  assert.equal(isSightDetectionMode(sightType), true);
  assert.deepEqual(getObscurationEligibility({ ...sightType, id: "basicSight" }), {
    affected: true,
    reason: "visual-sight-mode",
    detectionModeId: "basicSight"
  });
  assert.equal(getObscurationEligibility({ ...sightType, id: "darkvision" }).affected, true);
  assert.equal(getObscurationEligibility({ ...sightType, id: "seeAll" }).affected, true);
});

test("Vision 5e Blindsight is exempt despite its technical SIGHT type", () => {
  const blindsight = { id: "blindsight", type: 0, constructor: { DETECTION_TYPES: { SIGHT: 0 } } };
  assert.equal(isSightDetectionMode(blindsight), true);
  assert.deepEqual(getObscurationEligibility(blindsight), {
    affected: false,
    reason: "known-nonvisual-sight-mode",
    detectionModeId: "blindsight"
  });
});

test("nonvisual DetectionModes remain exempt through their native Foundry types", () => {
  const detectionTypes = { SIGHT: 0 };
  for (const mode of [
    { id: "blindsense", type: 3 },
    { id: "feelTremor", type: 2 },
    { id: "hearing", type: 1 },
    { id: "lifeSense", type: 3 }
  ]) {
    const detectionMode = { ...mode, constructor: { DETECTION_TYPES: detectionTypes } };
    assert.equal(isSightDetectionMode(detectionMode), false, mode.id);
    assert.equal(getObscurationEligibility(detectionMode).affected, false, mode.id);
    assert.equal(getObscurationEligibility(detectionMode).reason, "non-sight-detection-type", mode.id);
  }
});

test("the narrow phase uses Foundry's final Region segmentizer, including a constrained polygonTree", () => {
  const finalRegion = region({ segments: traversingSegment() });
  const theoreticalRegion = region({ segments: [] });
  assert.equal(segmentTraversesFinalRegionGeometry(finalRegion, source.origin, destination.point), true);
  assert.equal(segmentTraversesFinalRegionGeometry(theoreticalRegion, source.origin, destination.point), false);
});

test("bounds broad phase and zero-length boundary noise do not block sight", () => {
  assert.equal(segmentMayIntersectBounds(source.origin, destination.point, { x: 40, y: -10, width: 20, height: 20 }), true);
  const fog = region({ segments: [{ type: "ENTER", from: { x: 40, y: 0 }, to: { x: 40, y: 0 } }] });
  assert.equal(segmentTraversesFinalRegionGeometry(fog, source.origin, destination.point), false);
});

test("only the explicit production obscuration marker activates the runtime", () => {
  const marked = { flags: { "persistent-zones": { runtime: { normalizedDefinition: { obscuration: { mode: "heavily-obscured" } } } } } };
  const none = { flags: { "persistent-zones": { runtime: { normalizedDefinition: { obscuration: { mode: "none" } } } } } };
  assert.equal(isHeavilyObscuredRegion(marked), true);
  assert.equal(isHeavilyObscuredRegion(none), false);
});

test("production obscuration defaults safely for old data and preserves the explicit mode", () => {
  const legacy = normalizeZoneDefinition({ geometry: { type: "circle", radius: 10 } });
  assert.deepEqual(legacy.obscuration, { mode: "none" });

  const obscured = normalizeZoneDefinition({
    geometry: { type: "circle", radius: 10 },
    obscuration: { mode: "heavily-obscured" }
  });
  assert.deepEqual(obscured.obscuration, { mode: "heavily-obscured" });
});

test("the Debug/Test Region uses Foundry's GM-visible Region visibility", () => {
  globalThis.CONST = { REGION_VISIBILITY: { GAMEMASTER: 2, ALWAYS: 4 } };
  assert.equal(resolveDebugRegionVisibility(), 2);
  globalThis.CONST = { REGION_VISIBILITY: { ALWAYS: 4 } };
  assert.equal(resolveDebugRegionVisibility(), 4);
});
