import { MODULE_ID } from "../constants.mjs";
import {
  distanceToPixels,
  findManagedRegions,
  getRegionRuntimeFlags,
  getTokenCenter,
  isPrimaryGM,
  pixelsToDistance
} from "./utils.mjs";
import { translateRegionShapeData } from "./region-factory.mjs";
import {
  captureRegionMembership,
  reconcileRegionMembershipAfterTranslation
} from "./entry-runtime.mjs";

const processedSourceTurns = new Set();

/**
 * Runs the first generic automatic translation mode. It deliberately moves the
 * logical Region shape and leaves Foundry's Region.restriction in place, so
 * native M11D rays are recomputed at the new origin rather than transporting a
 * previous restriction result.
 */
export async function processSourceTurnZoneTranslations(combat, state, sourceToken) {
  if (!isPrimaryGM() || !sourceToken?.uuid) return [];
  const turnKey = [combat?.id, state?.round, state?.turn, sourceToken.uuid].join("|");
  const scene = sourceToken.parent ?? null;
  const regions = findManagedRegions(scene);
  const alreadyProcessed = processedSourceTurns.has(turnKey);
  if (alreadyProcessed) return [];
  processedSourceTurns.add(turnKey);
  trimProcessedSourceTurns();

  const results = [];
  for (const regionDocument of regions) {
    const runtime = getRegionRuntimeFlags(regionDocument);
    const translation = runtime?.normalizedDefinition?.translation ?? null;
    const source = resolveStoredSourceToken(scene, runtime);
    const skipReason = resolveTranslationSkipReason({ runtime, translation, source, sourceToken });
    if (skipReason) continue;
    const result = await translateRegionAwayFromSource(regionDocument, sourceToken, { combat, state });
    results.push(result);
  }
  return results;
}

function resolveTranslationSkipReason({ runtime, translation, source, sourceToken }) {
  if (!runtime) return "missing-runtime";
  if (!translation) return "missing-translation-config";
  if (translation.enabled !== true) return "translation-disabled";
  if (translation.trigger !== "source-turn-start") return "wrong-trigger";
  if (!runtime.sourceTokenUuid && !runtime.sourceTokenId) return "missing-source-token";
  if (!source) return "missing-source-token";
  if (source.id !== sourceToken?.id && source.uuid !== sourceToken?.uuid) return "not-source-turn";
  return null;
}

function resolveStoredSourceToken(scene, runtime = {}) {
  const tokens = scene?.tokens?.contents ?? Array.from(scene?.tokens?.values?.() ?? []);
  const sourceTokenId = String(runtime?.sourceTokenId ?? "").trim();
  const sourceTokenUuid = String(runtime?.sourceTokenUuid ?? "").trim();
  return tokens.find((token) =>
    (sourceTokenId && token?.id === sourceTokenId) ||
    (sourceTokenUuid && token?.uuid === sourceTokenUuid)
  ) ?? null;
}

export async function translateRegionAwayFromSource(regionDocument, sourceToken, { combat = null, state = null } = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument);
  const translation = runtime?.normalizedDefinition?.translation ?? {};
  if (!translation.enabled || translation.trigger !== "source-turn-start") return { moved: false, reason: "disabled" };
  if (translation.direction !== "away-from-source") return { moved: false, reason: "unsupported-direction" };
  const scene = regionDocument?.parent ?? sourceToken?.parent ?? null;
  const requestedPixels = distanceToPixels(translation.distance, scene);
  if (!(requestedPixels > 0)) return { moved: false, reason: "zero-distance" };

  const origin = getRegionLogicalCenter(regionDocument);
  const sourceCenter = getTokenCenter(sourceToken);
  const vector = { x: origin.x - sourceCenter.x, y: origin.y - sourceCenter.y };
  const magnitude = Math.hypot(vector.x, vector.y);
  if (!(magnitude > 1e-6)) {
    const message = globalThis.game?.i18n?.localize?.("PERSISTENT_ZONES.Runtime.TranslationCoincidentOrigin")
      ?? "The persistent zone cannot move because its center coincides with its source.";
    globalThis.ui?.notifications?.warn?.(message);
    console.warn(`[${MODULE_ID}] Zone translation skipped: source and zone center coincide.`, { regionId: regionDocument?.id ?? null, sourceTokenId: sourceToken?.id ?? null });
    return { moved: false, reason: "coincident-origin" };
  }
  const unit = { x: vector.x / magnitude, y: vector.y / magnitude };
  const requested = { x: unit.x * requestedPixels, y: unit.y * requestedPixels };
  return translateManagedRegionByVector(regionDocument, requested, {
    combat,
    state,
    updateOptions: {
      persistentZonesZoneTranslation: true,
      persistentZonesTranslationContext: { combatId: combat?.id ?? null, round: state?.round ?? null, turn: state?.turn ?? null }
    }
  });
}

/**
 * Translate a managed Region through the same center-point move-wall resolver
 * used by automatic zones. Callers supply a requested pixel vector; this keeps
 * action-triggered movement separate from ordinary Region editing.
 */
export async function translateManagedRegionByVector(regionDocument, requested, {
  combat = null,
  state = null,
  updateOptions = {}
} = {}) {
  const scene = regionDocument?.parent ?? globalThis.canvas?.scene ?? null;
  const origin = getRegionLogicalCenter(regionDocument);
  const requestedDestination = { x: origin.x + Number(requested?.x ?? 0), y: origin.y + Number(requested?.y ?? 0) };
  const collisionTest = testMoveCollisionBackend(origin, requestedDestination, { scene, regionDocument });
  const resolved = resolveMoveCollision(origin, requested, { scene, regionDocument, collisionTest });
  const requestedPixels = Math.hypot(Number(requested?.x ?? 0), Number(requested?.y ?? 0));
  const beforeMembership = captureRegionMembership(regionDocument);
  if (Math.hypot(resolved.dx, resolved.dy) <= 1e-4) {
    return { moved: false, reason: resolved.reason, requestedPixels, movedPixels: 0 };
  }

  const shapes = Array.from(regionDocument?._source?.shapes ?? [])
    .map((shape) => translateRegionShapeData(shape, resolved.dx, resolved.dy));
  await regionDocument.update({ shapes }, updateOptions);
  await reconcileRegionMembershipAfterTranslation(regionDocument, beforeMembership, { combat, state });
  return {
    moved: true,
    reason: resolved.reason,
    requestedPixels,
    movedPixels: Math.hypot(resolved.dx, resolved.dy),
    movedDistance: pixelsToDistance(Math.hypot(resolved.dx, resolved.dy), scene),
    dx: resolved.dx,
    dy: resolved.dy
  };
}

export function getRegionLogicalCenter(regionDocument) {
  const shapes = Array.from(regionDocument?._source?.shapes ?? []);
  const shape = shapes[0] ?? {};
  if (Number.isFinite(Number(shape.x)) && Number.isFinite(Number(shape.y))) return { x: Number(shape.x), y: Number(shape.y) };
  const points = Array.from(shape.points ?? []);
  if (points.length >= 2) {
    const pairs = points.length / 2;
    return {
      x: points.filter((_, index) => index % 2 === 0).reduce((sum, value) => sum + Number(value), 0) / pairs,
      y: points.filter((_, index) => index % 2 === 1).reduce((sum, value) => sum + Number(value), 0) / pairs
    };
  }
  return { x: 0, y: 0 };
}

/** Resolve a straight movement-channel wall collision with Foundry V14's polygon backend. */
export function resolveMoveCollision(origin, requested, { scene = null, regionDocument = null, collisionTest = null } = {}) {
  const distance = Math.hypot(requested?.x ?? 0, requested?.y ?? 0);
  if (!(distance > 0)) return { dx: 0, dy: 0, reason: "zero-distance" };
  const destination = { x: origin.x + requested.x, y: origin.y + requested.y };
  const collisions = collisionTest?.collisions ?? testMoveCollisionBackend(origin, destination, { scene, regionDocument }).collisions;
  const firstCollision = collisions[0] ?? null;
  if (!firstCollision) {
    return {
      dx: requested.x,
      dy: requested.y,
      reason: "full-distance",
      collisions: [],
      firstCollision: null,
      finalDestination: destination
    };
  }
  const hit = { x: Number(firstCollision.x), y: Number(firstCollision.y) };
  const projectedDistance = Math.max(0, Math.min(distance,
    (((hit.x - origin.x) * requested.x) + ((hit.y - origin.y) * requested.y)) / distance
  ));
  // Keep one pixel before the blocking segment, avoiding an ambiguous on-wall center.
  const allowedDistance = Math.max(0, projectedDistance - 1);
  const fraction = allowedDistance / distance;
  const dx = requested.x * fraction;
  const dy = requested.y * fraction;
  return {
    dx,
    dy,
    reason: fraction > 0 ? "blocked-by-move-wall" : "blocked-at-origin",
    collisions,
    firstCollision,
    finalDestination: { x: origin.x + dx, y: origin.y + dy }
  };
}

function getMoveCollisionBackend() {
  return globalThis.CONFIG?.Canvas?.polygonBackends?.move ?? null;
}

function testMoveCollisionBackend(origin, destination, { scene = null, regionDocument = null, backend = getMoveCollisionBackend() } = {}) {
  if (typeof backend?.testCollision !== "function") return { raw: null, collisions: [], error: null };
  const level = resolveCollisionLevel(scene, regionDocument);
  const config = { type: "move", mode: "all" };
  if (level) config.level = level;
  try {
    const raw = backend.testCollision(origin, destination, config);
    return { raw, collisions: Array.isArray(raw) ? raw : (raw ? [raw] : []), error: null };
  } catch (error) {
    return { raw: null, collisions: [], error: error?.message ?? String(error) };
  }
}

function resolveCollisionLevel(scene, regionDocument) {
  const levelId = regionDocument?._source?.level ?? regionDocument?.level ?? null;
  return (levelId ? scene?.levels?.get?.(levelId) : null) ?? globalThis.canvas?.level ?? null;
}

function trimProcessedSourceTurns() {
  if (processedSourceTurns.size <= 200) return;
  const entries = Array.from(processedSourceTurns);
  for (const key of entries.slice(0, entries.length - 100)) processedSourceTurns.delete(key);
}
