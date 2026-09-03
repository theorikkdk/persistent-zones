import {
  MODULE_ID,
  RUNTIME_FLAG_KEY
} from "../constants.mjs";

const OBSCURATION_MODE = "heavily-obscured";

/**
 * Vision 5e currently implements Blindsight as a DetectionMode whose
 * technical Foundry type is SIGHT. That type identifies the canvas pipeline,
 * not whether the sense physically relies on seeing through the volume.
 *
 * Keep this compatibility boundary small and explicit. Other non-visual
 * modes (for example Blindsense, Tremorsense, Hearing, and Life Sense) use
 * OTHER, MOVE, or SOUND and are already excluded by the generic SIGHT test.
 */
const NON_VISUAL_SIGHT_DETECTION_MODE_IDS = new Set([
  "blindsight"
]);

let registered = false;
let activeScene = null;
let obscuringRegions = [];

/**
 * Production LOS restriction for PZ Regions whose normalized definition is
 * heavily obscured. The Debug/Test helper only creates such a definition; it
 * has no separate LOS path.
 *
 * The wrapper runs after Foundry (and any prior libWrapper wrappers) has allowed
 * Sight. It only adds a restriction; it never grants visibility.
 */
export function registerPersistentZoneObscurationRuntime() {
  if (registered) return true;
  const wrapper = globalThis.libWrapper;
  if (typeof wrapper?.register !== "function") {
    console.warn(`[${MODULE_ID}] PZ obscuration disabled: libWrapper is unavailable.`);
    return false;
  }

  wrapper.register(
    MODULE_ID,
    "foundry.canvas.perception.DetectionMode.prototype._testLOS",
    function persistentZonesHeavilyObscuredLOS(wrapped, visionSource, mode, target, test) {
      const normalResult = wrapped(visionSource, mode, target, test);
      const eligibility = getObscurationEligibility(this);
      if (!normalResult || !eligibility.affected) {
        return normalResult;
      }

      const result = evaluateHeavilyObscuredLOS({
        visionSource,
        target,
        test,
        regions: getActiveObscuringRegions()
      });
      return result.result;
    },
    "MIXED"
  );

  Hooks.on("canvasReady", refreshObscurationState);
  Hooks.on("createRegion", refreshObscurationState);
  Hooks.on("updateRegion", refreshObscurationState);
  Hooks.on("deleteRegion", refreshObscurationState);
  Hooks.on("createWall", refreshObscurationPerception);
  Hooks.on("updateWall", refreshObscurationPerception);
  Hooks.on("deleteWall", refreshObscurationPerception);
  registered = true;
  refreshObscurationState();
  console.info(`[${MODULE_ID}] PZ obscuration runtime registered via libWrapper MIXED on DetectionMode._testLOS.`);
  return true;
}

/** Create an isolated Debug/Test Region using the production obscuration primitive. */
export async function createHeavilyObscuredTestZone({ x = null, y = null, radius = null } = {}) {
  const scene = globalThis.canvas?.scene ?? null;
  if (!scene?.createEmbeddedDocuments) {
    return { ok: false, error: "No writable active Scene is available." };
  }

  const center = resolveDebugRegionCenter({ x, y });
  const resolvedRadius = Number.isFinite(Number(radius)) && Number(radius) > 0
    ? Number(radius)
    : Math.max(Number(scene.grid?.size ?? globalThis.canvas?.dimensions?.size ?? 100) * 2, 1);
  const label = globalThis.game?.i18n?.localize?.("PERSISTENT_ZONES.Debug.Obscuration.Name")
    ?? "Debug/Test — Heavily Obscured Zone";
  const runtime = {
    contractVersion: "persistent-zone-obscuration",
    normalizedDefinition: {
      source: { type: "debug-test", module: MODULE_ID, preset: "debug.heavily-obscured-zone" },
      obscuration: { mode: OBSCURATION_MODE }
    }
  };
  const [region] = await scene.createEmbeddedDocuments("Region", [{
    name: label,
    color: "#7b8796",
    // Match PZ's native Region visibility mechanism, but make this isolated
    // Debug/Test aid visible to the GM regardless of the active Region layer.
    visibility: resolveDebugRegionVisibility(),
    highlightMode: "shapes",
    locked: false,
    shapes: [{ type: "circle", x: center.x, y: center.y, radius: resolvedRadius, gridBased: false }],
    flags: { [MODULE_ID]: { [RUNTIME_FLAG_KEY]: runtime } }
  }], { persistentZonesDebugObscuration: true });

  refreshObscurationState();
  return {
    ok: Boolean(region),
    region,
    regionId: region?.id ?? null,
    center,
    radius: resolvedRadius,
    label
  };
}

export function isSightDetectionMode(detectionMode) {
  const sight = detectionMode?.constructor?.DETECTION_TYPES?.SIGHT
    ?? globalThis.foundry?.canvas?.perception?.DetectionMode?.DETECTION_TYPES?.SIGHT;
  return sight !== undefined && detectionMode?.type === sight;
}

/** Resolve the native Foundry visibility value that exposes a Region to GMs. */
export function resolveDebugRegionVisibility() {
  const visibility = globalThis.CONST?.REGION_VISIBILITY ?? {};
  const value = visibility.GAMEMASTER ?? visibility.ALWAYS ?? 4;
  return Number.isFinite(Number(value)) ? Number(value) : 4;
}

/**
 * Determine whether this exact detection mode represents vision through the
 * obscuring volume. This is deliberately based on the mode, not merely its
 * Foundry pipeline type: Vision 5e's Blindsight is technically SIGHT but is
 * semantically non-visual.
 */
export function getObscurationEligibility(detectionMode) {
  const detectionModeId = String(detectionMode?.id ?? "").trim();
  if (!isSightDetectionMode(detectionMode)) {
    return { affected: false, reason: "non-sight-detection-type", detectionModeId };
  }
  if (NON_VISUAL_SIGHT_DETECTION_MODE_IDS.has(detectionModeId)) {
    return { affected: false, reason: "known-nonvisual-sight-mode", detectionModeId };
  }
  return { affected: true, reason: "visual-sight-mode", detectionModeId };
}

export function evaluateHeavilyObscuredLOS({ visionSource = null, target = null, test = null, regions = [] } = {}) {
  const origin = visionSource?.origin ?? null;
  const destination = test?.point ?? null;
  if (!isFinitePoint(origin) || !isFinitePoint(destination)) {
    return { result: true, regionCount: regions.length, boundedRegionCount: 0, blockingRegion: null };
  }

  const boundedRegions = regions.filter((region) => segmentMayIntersectBounds(origin, destination, region?.bounds));
  const blockingRegion = boundedRegions.find((region) => segmentTraversesFinalRegionGeometry(region, origin, destination)) ?? null;
  return {
    result: !blockingRegion,
    regionCount: regions.length,
    boundedRegionCount: boundedRegions.length,
    blockingRegion,
    origin,
    destination,
    target
  };
}

/**
 * Use Foundry's public Region segmentizer so the test follows the Region's
 * current polygonTree, including any final native M11D constraint.
 */
export function segmentTraversesFinalRegionGeometry(region, origin, destination) {
  if (typeof region?.segmentizeMovementPath !== "function") return false;
  try {
    const segments = region.segmentizeMovementPath([
      { x: origin.x, y: origin.y, elevation: origin.elevation ?? 0 },
      { x: destination.x, y: destination.y, elevation: destination.elevation ?? 0 }
    ], [{ x: 0, y: 0 }], 0);
    return Array.from(segments ?? []).some((segment) => hasNonZeroLength(segment?.from, segment?.to));
  } catch (error) {
    console.warn(`[${MODULE_ID}] PZ obscuration skipped a Region segment test.`, {
      regionId: region?.id ?? null,
      reason: error?.message ?? "unknown"
    });
    return false;
  }
}

export function segmentMayIntersectBounds(origin, destination, bounds) {
  if (!bounds || !isFinitePoint(origin) || !isFinitePoint(destination)) return false;
  const minX = Math.min(origin.x, destination.x);
  const maxX = Math.max(origin.x, destination.x);
  const minY = Math.min(origin.y, destination.y);
  const maxY = Math.max(origin.y, destination.y);
  const left = Number(bounds.left ?? bounds.x);
  const top = Number(bounds.top ?? bounds.y);
  const right = Number(bounds.right ?? (left + Number(bounds.width)));
  const bottom = Number(bounds.bottom ?? (top + Number(bounds.height)));
  return Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(right) && Number.isFinite(bottom) &&
    maxX >= left && minX <= right && maxY >= top && minY <= bottom;
}

function getActiveObscuringRegions() {
  const scene = globalThis.canvas?.scene ?? null;
  if (scene !== activeScene) refreshActiveObscuringRegions();
  return obscuringRegions;
}

function refreshActiveObscuringRegions() {
  activeScene = globalThis.canvas?.scene ?? null;
  const regions = Array.from(activeScene?.regions?.contents ?? activeScene?.regions ?? []);
  obscuringRegions = regions.filter(isHeavilyObscuredRegion);
}

function refreshObscurationState() {
  refreshActiveObscuringRegions();
  refreshObscurationPerception();
}

function refreshObscurationPerception() {
  globalThis.canvas?.perception?.update?.({ refreshVision: true });
}

export function isHeavilyObscuredRegion(region) {
  const runtime = region?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]
    ?? region?._source?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]
    ?? region?.getFlag?.(MODULE_ID, RUNTIME_FLAG_KEY);
  return runtime?.normalizedDefinition?.obscuration?.mode === OBSCURATION_MODE;
}

function resolveDebugRegionCenter({ x, y }) {
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) return { x: Number(x), y: Number(y) };
  const selected = globalThis.canvas?.tokens?.controlled?.[0]?.document ?? null;
  if (typeof selected?.getCenterPoint === "function") return selected.getCenterPoint();
  const rect = globalThis.canvas?.dimensions?.sceneRect ?? null;
  return { x: Number(rect?.x ?? 0) + (Number(rect?.width ?? 0) / 2), y: Number(rect?.y ?? 0) + (Number(rect?.height ?? 0) / 2) };
}

function isFinitePoint(point) {
  return Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y));
}

function hasNonZeroLength(from, to) {
  if (!isFinitePoint(from) || !isFinitePoint(to)) return false;
  const dz = Number(to.elevation ?? 0) - Number(from.elevation ?? 0);
  return ((Number(to.x) - Number(from.x)) ** 2) + ((Number(to.y) - Number(from.y)) ** 2) + (dz ** 2) > 0;
}
