import { ENTRY_DEDUP_TTL_MS } from "../constants.mjs";
import { applyOnEnterEffect } from "./entry-effects.mjs";
import {
  coerceNumber,
  debug,
  findManagedRegions,
  getRegionRuntimeFlags,
  getTokenCenter,
  isPrimaryGM,
  testTokenInsideManagedRegion
} from "./utils.mjs";

const lastKnownTokenStates = new Map();
const regionInsideStates = new Map();
const recentEnterEvents = new Map();
const recentMoveTokenEvents = new Map();

let hooksRegistered = false;

export function registerEntryRuntimeHooks() {
  if (hooksRegistered) {
    return;
  }

  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("moveToken", onMoveToken);
  Hooks.on("updateToken", onUpdateToken);
  Hooks.on("createToken", onCreateToken);
  Hooks.on("deleteToken", onDeleteToken);

  if (canvas?.ready) {
    refreshTrackedTokenStates(canvas.scene ?? null);
  }

  hooksRegistered = true;
}

function onCanvasReady() {
  if (!isPrimaryGM()) {
    return;
  }

  refreshTrackedTokenStates(canvas?.scene ?? null);
}

async function onMoveToken(tokenDocument, movement) {
  if (!isPrimaryGM()) {
    return;
  }

  if (!tokenDocument?.parent || tokenDocument.parent !== canvas?.scene) {
    return;
  }

  const movementPath = buildMovementPathFromFoundryMovement(tokenDocument, movement);
  if (!movementPath) {
    return;
  }

  markRecentMoveTokenEvent(tokenDocument, movementPath.toState);

  await evaluateTokenEntry(tokenDocument, {
    moveSource: movementPath.moveSource,
    fromState: movementPath.fromState,
    toState: movementPath.toState,
    pathStates: movementPath.pathStates
  });

  lastKnownTokenStates.set(tokenDocument.uuid, movementPath.toState);
}

async function onUpdateToken(tokenDocument, changed) {
  if (!isPrimaryGM()) {
    return;
  }

  if (!hasPositionChange(changed)) {
    return;
  }

  const afterState = snapshotTokenState(tokenDocument);
  if (wasRecentlyHandledByMoveToken(tokenDocument, afterState)) {
    lastKnownTokenStates.set(tokenDocument.uuid, afterState);
    return;
  }

  const beforeState = lastKnownTokenStates.get(tokenDocument.uuid) ?? null;

  await evaluateTokenEntry(tokenDocument, {
    moveSource: "updateToken-fallback",
    fromState: beforeState,
    toState: afterState,
    pathStates: compactStatePath([beforeState, afterState])
  });

  lastKnownTokenStates.set(tokenDocument.uuid, afterState);
}

async function onCreateToken(tokenDocument) {
  if (!isPrimaryGM()) {
    return;
  }

  const afterState = snapshotTokenState(tokenDocument);

  await evaluateTokenEntry(tokenDocument, {
    moveSource: "createToken",
    fromState: null,
    toState: afterState,
    pathStates: [afterState]
  });

  lastKnownTokenStates.set(tokenDocument.uuid, afterState);
}

function onDeleteToken(tokenDocument) {
  lastKnownTokenStates.delete(tokenDocument.uuid);
  recentMoveTokenEvents.delete(tokenDocument.uuid);
  clearInsideStateCacheForToken(tokenDocument);
}

async function evaluateTokenEntry(tokenDocument, {
  moveSource,
  fromState,
  toState,
  pathStates = []
}) {
  const scene = tokenDocument?.parent ?? null;
  const actor = tokenDocument?.actor ?? null;

  if (!scene) {
    return;
  }

  if (!tokenDocument?.id || tokenDocument?.parent?.tokens?.get?.(tokenDocument.id) === null) {
    debug("Skipped token entry check because the token is invalid.", {
      tokenId: tokenDocument?.id ?? null,
      moveSource
    });
    return;
  }

  if (!actor) {
    debug("Skipped token entry check because the token has no Actor.", {
      tokenId: tokenDocument.id,
      tokenName: tokenDocument.name,
      moveSource
    });
    return;
  }

  const managedRegions = findManagedRegions(scene);
  if (!managedRegions.length) {
    return;
  }

  for (const regionDocument of managedRegions) {
    const runtime = getRegionRuntimeFlags(regionDocument);
    const normalizedDefinition = runtime?.normalizedDefinition ?? null;
    const onEnter = normalizedDefinition?.triggers?.onEnter ?? {};

    const insideStateKey = buildInsideStateKey(tokenDocument, regionDocument);
    const cachedFromInside = regionInsideStates.get(insideStateKey) ?? null;
    const fromInside = fromState
      ? testTokenInsideManagedRegion(tokenDocument, regionDocument, fromState)
      : Boolean(cachedFromInside);
    const toInside = toState
      ? testTokenInsideManagedRegion(tokenDocument, regionDocument, toState)
      : false;

    // Inspired by the older Encounter+ Importer approach:
    // keep an inside-cache per token/region, but prefer Foundry v13 moveToken origin/destination
    // plus sampled movement segments instead of relying on document end-state only.
    const crossedBoundary = moveSource === "createToken"
      ? toInside
      : detectBoundaryCrossing(tokenDocument, regionDocument, pathStates, fromInside);
    const enterDetected = moveSource === "createToken"
      ? toInside
      : !fromInside && crossedBoundary;

    if (toInside) {
      regionInsideStates.set(insideStateKey, true);
    } else {
      regionInsideStates.delete(insideStateKey);
    }

    debug("Checked token against managed Region.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      moveSource,
      fromX: fromState?.position?.x ?? null,
      fromY: fromState?.position?.y ?? null,
      toX: toState?.position?.x ?? null,
      toY: toState?.position?.y ?? null,
      fromInside,
      toInside,
      crossedBoundary,
      enterDetected
    });

    if (!normalizedDefinition?.enabled) {
      debug("Skipped managed Region effect because the normalized definition is disabled.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id
      });
      continue;
    }

    if (!onEnter.enabled) {
      debug("Skipped managed Region effect because onEnter is disabled.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id
      });
      continue;
    }

    const filterResult = shouldAffectToken(tokenDocument, runtime, normalizedDefinition);
    if (!filterResult.allowed) {
      debug("Skipped managed Region effect because token filtering rejected the target.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        reason: filterResult.reason
      });
      continue;
    }

    if (!enterDetected) {
      debug("Skipped managed Region effect because no entry was detected.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id
      });
      continue;
    }

    if (isDuplicateEnter(regionDocument, tokenDocument, moveSource, toState?.center)) {
      debug("Skipped managed Region effect because the entry was deduplicated.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id
      });
      continue;
    }

    const application = await applyOnEnterEffect({
      regionDocument,
      tokenDocument,
      normalizedDefinition
    });

    debug("Managed Region onEnter effect completed.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      applied: application.applied,
      skipped: application.skipped ?? false,
      reason: application.reason ?? null
    });
  }
}

function shouldAffectToken(tokenDocument, runtime, normalizedDefinition) {
  if (!tokenDocument?.actor) {
    return { allowed: false, reason: "Token has no Actor." };
  }

  const targeting = normalizedDefinition?.targeting ?? {};
  const mode = String(targeting.mode ?? "all").toLowerCase();
  const sourceActorUuid = runtime?.casterUuid ?? runtime?.actorUuid ?? null;
  const tokenActorUuid = tokenDocument.actor?.uuid ?? null;

  if (mode === "self") {
    return {
      allowed: Boolean(sourceActorUuid && tokenActorUuid === sourceActorUuid),
      reason: "Targeting mode self."
    };
  }

  if (mode === "allies" || mode === "enemies") {
    return {
      allowed: false,
      reason: `Targeting mode ${mode} is reserved but not yet implemented in this MVP.`
    };
  }

  if (targeting.includeSelf === false && sourceActorUuid && tokenActorUuid === sourceActorUuid) {
    return {
      allowed: false,
      reason: "Self targeting is excluded."
    };
  }

  return { allowed: true, reason: "Targeting mode all." };
}

function isDuplicateEnter(regionDocument, tokenDocument, moveSource, afterCenter) {
  cleanupExpiredDedupEntries();

  const centerKey = `${Math.round(afterCenter?.x ?? 0)}:${Math.round(afterCenter?.y ?? 0)}`;
  const key = [
    regionDocument?.uuid ?? regionDocument?.id ?? "region",
    tokenDocument?.uuid ?? tokenDocument?.id ?? "token",
    moveSource,
    centerKey
  ].join("|");

  const lastSeen = recentEnterEvents.get(key) ?? 0;
  const now = Date.now();
  recentEnterEvents.set(key, now);

  return now - lastSeen < ENTRY_DEDUP_TTL_MS;
}

function cleanupExpiredDedupEntries() {
  const cutoff = Date.now() - ENTRY_DEDUP_TTL_MS;
  for (const [key, timestamp] of recentEnterEvents.entries()) {
    if (timestamp < cutoff) {
      recentEnterEvents.delete(key);
    }
  }
}

function hasPositionChange(changed) {
  return Object.prototype.hasOwnProperty.call(changed ?? {}, "x") ||
    Object.prototype.hasOwnProperty.call(changed ?? {}, "y") ||
    Object.prototype.hasOwnProperty.call(changed ?? {}, "width") ||
    Object.prototype.hasOwnProperty.call(changed ?? {}, "height");
}

function refreshTrackedTokenStates(scene) {
  lastKnownTokenStates.clear();
  regionInsideStates.clear();
  recentMoveTokenEvents.clear();

  const tokenDocuments =
    scene?.tokens?.contents ??
    Array.from(scene?.tokens?.values?.() ?? []);

  for (const tokenDocument of tokenDocuments) {
    lastKnownTokenStates.set(tokenDocument.uuid, snapshotTokenState(tokenDocument));
  }

  debug("Refreshed tracked token states.", {
    sceneId: scene?.id ?? null,
    trackedTokens: tokenDocuments.length
  });
}

function snapshotTokenState(tokenDocument) {
  return {
    position: {
      x: tokenDocument?.x ?? 0,
      y: tokenDocument?.y ?? 0
    },
    width: tokenDocument?.width ?? 1,
    height: tokenDocument?.height ?? 1,
    elevation: tokenDocument?._source?.elevation ?? tokenDocument?.elevation ?? 0,
    shape: tokenDocument?._source?.shape ?? tokenDocument?.shape ?? null,
    center: getTokenCenter(tokenDocument)
  };
}

function buildMovementPathFromFoundryMovement(tokenDocument, movement) {
  const points = compactMovementPoints([
    movement?.origin,
    ...(Array.isArray(movement?.waypoints) ? movement.waypoints : []),
    ...(Array.isArray(movement?.history?.waypoints) ? movement.history.waypoints : []),
    movement?.destination
  ]);

  if (points.length < 2) {
    return null;
  }

  const pathStates = compactStatePath(points.map((point) => snapshotTokenStateAtPosition(tokenDocument, point)));
  if (pathStates.length < 2) {
    return null;
  }

  return {
    moveSource: points.length > 2 ? "moveToken-waypoints" : "moveToken-origin-destination",
    fromState: pathStates[0],
    toState: pathStates[pathStates.length - 1],
    pathStates
  };
}

function snapshotTokenStateAtPosition(tokenDocument, point) {
  const x = coerceNumber(point?.x, coerceNumber(tokenDocument?.x, 0));
  const y = coerceNumber(point?.y, coerceNumber(tokenDocument?.y, 0));
  const width = coerceNumber(point?.width, coerceNumber(tokenDocument?.width, 1));
  const height = coerceNumber(point?.height, coerceNumber(tokenDocument?.height, 1));

  return {
    position: { x, y },
    width,
    height,
    elevation: coerceNumber(point?.elevation, coerceNumber(tokenDocument?.elevation, 0)),
    shape: point?.shape ?? tokenDocument?._source?.shape ?? tokenDocument?.shape ?? null,
    center: getTokenCenter({ x, y, width, height })
  };
}

function compactMovementPoints(points) {
  const result = [];

  for (const point of points) {
    const normalized = normalizeMovementPoint(point);
    if (!normalized) {
      continue;
    }

    const previous = result[result.length - 1];
    if (
      previous &&
      previous.x === normalized.x &&
      previous.y === normalized.y &&
      previous.elevation === normalized.elevation
    ) {
      continue;
    }

    result.push(normalized);
  }

  return result;
}

function normalizeMovementPoint(point) {
  if (!point || (point.x === undefined && point.y === undefined)) {
    return null;
  }

  return {
    x: coerceNumber(point.x, 0),
    y: coerceNumber(point.y, 0),
    elevation: coerceNumber(point.elevation, 0),
    width: coerceNumber(point.width, null),
    height: coerceNumber(point.height, null),
    shape: point.shape ?? null
  };
}

function compactStatePath(states) {
  const result = [];

  for (const state of states) {
    if (!state) {
      continue;
    }

    const previous = result[result.length - 1];
    if (
      previous &&
      previous.position.x === state.position.x &&
      previous.position.y === state.position.y &&
      previous.elevation === state.elevation
    ) {
      continue;
    }

    result.push(state);
  }

  return result;
}

function detectBoundaryCrossing(tokenDocument, regionDocument, pathStates, fromInside) {
  const states = compactStatePath(pathStates);
  if (!states.length) {
    return false;
  }

  let previousInside = Boolean(fromInside);

  for (let index = 1; index < states.length; index += 1) {
    const segmentSamples = sampleSegmentStates(states[index - 1], states[index]);

    for (const sampleState of segmentSamples) {
      const sampleInside = testTokenInsideManagedRegion(tokenDocument, regionDocument, sampleState);
      if (!previousInside && sampleInside) {
        return true;
      }

      previousInside = sampleInside;
    }
  }

  return false;
}

function sampleSegmentStates(fromState, toState) {
  if (!fromState || !toState) {
    return [];
  }

  const dx = toState.position.x - fromState.position.x;
  const dy = toState.position.y - fromState.position.y;
  const distance = Math.hypot(dx, dy);
  const gridSize = Math.max(coerceNumber(canvas?.grid?.size, 100), 1);
  const steps = Math.max(1, Math.ceil(distance / Math.max(gridSize / 2, 1)));
  const samples = [];

  for (let step = 1; step <= steps; step += 1) {
    const alpha = step / steps;
    const x = lerp(fromState.position.x, toState.position.x, alpha);
    const y = lerp(fromState.position.y, toState.position.y, alpha);
    const width = lerp(fromState.width, toState.width, alpha);
    const height = lerp(fromState.height, toState.height, alpha);

    samples.push({
      position: { x, y },
      width,
      height,
      elevation: lerp(fromState.elevation, toState.elevation, alpha),
      shape: alpha < 1 ? fromState.shape : toState.shape,
      center: getTokenCenter({ x, y, width, height })
    });
  }

  return samples;
}

function lerp(from, to, alpha) {
  return from + ((to - from) * alpha);
}

function markRecentMoveTokenEvent(tokenDocument, toState) {
  recentMoveTokenEvents.set(tokenDocument.uuid, {
    x: toState?.position?.x ?? null,
    y: toState?.position?.y ?? null,
    timestamp: Date.now()
  });
}

function wasRecentlyHandledByMoveToken(tokenDocument, afterState) {
  const recent = recentMoveTokenEvents.get(tokenDocument.uuid);
  if (!recent) {
    return false;
  }

  if (Date.now() - recent.timestamp > 1000) {
    recentMoveTokenEvents.delete(tokenDocument.uuid);
    return false;
  }

  const matchesDestination =
    recent.x === (afterState?.position?.x ?? null) &&
    recent.y === (afterState?.position?.y ?? null);

  if (matchesDestination) {
    recentMoveTokenEvents.delete(tokenDocument.uuid);
    return true;
  }

  return false;
}

function buildInsideStateKey(tokenDocument, regionDocument) {
  const tokenKey = tokenDocument?.uuid ?? tokenDocument?.id ?? "token";
  const regionKey = regionDocument?.uuid ?? regionDocument?.id ?? "region";
  return `${regionKey}::${tokenKey}`;
}

function clearInsideStateCacheForToken(tokenDocument) {
  const tokenKey = tokenDocument?.uuid ?? tokenDocument?.id ?? null;
  if (!tokenKey) {
    return;
  }

  const suffix = `::${tokenKey}`;
  for (const key of regionInsideStates.keys()) {
    if (key.endsWith(suffix)) {
      regionInsideStates.delete(key);
    }
  }
}
