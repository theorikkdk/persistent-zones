import { ENTRY_DEDUP_TTL_MS } from "../constants.mjs";
import { applyConfiguredTriggerEffect } from "./entry-effects.mjs";
import {
  coerceNumber,
  debug,
  findManagedRegions,
  getRegionRuntimeFlags,
  getTokenCenter,
  isPrimaryGM,
  pixelsToDistance,
  testTokenInsideManagedRegion
} from "./utils.mjs";

const lastKnownTokenStates = new Map();
const regionInsideStates = new Map();
const recentEnterEvents = new Map();
const recentExitEvents = new Map();
const recentOnMoveEvents = new Map();
const recentMoveTokenEvents = new Map();
const queuedMovementModes = new Map();

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

export function markNextMovementMode(tokenDocument, movementMode = "forced") {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid) {
    debug("Could not queue movement mode because the token is invalid.", {
      tokenId: tokenDocument?.id ?? null,
      movementMode
    });
    return null;
  }

  const normalizedMode = normalizeMovementMode(movementMode);
  queuedMovementModes.set(tokenUuid, normalizedMode);

  debug("Queued next movement mode for token.", {
    tokenId: tokenDocument?.id ?? null,
    tokenUuid,
    movementMode: normalizedMode
  });

  return {
    tokenId: tokenDocument?.id ?? null,
    tokenUuid,
    movementMode: normalizedMode,
    queued: true
  };
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
  const movementResolution = resolveMovementModeForEvaluation(tokenDocument, {
    moveSource: movementPath.moveSource,
    consume: true
  });

  markRecentMoveTokenEvent(tokenDocument, movementPath.toState);

  await evaluateTokenEntry(tokenDocument, {
    moveSource: movementPath.moveSource,
    movementMode: movementResolution.resolvedMovementMode,
    movementModeRaw: movementResolution.rawMovementMode,
    movementMarkConsumed: movementResolution.consumed,
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
  const movementResolution = resolveMovementModeForEvaluation(tokenDocument, {
    moveSource: "updateToken-fallback",
    consume: false
  });

  await evaluateTokenEntry(tokenDocument, {
    moveSource: "updateToken-fallback",
    movementMode: movementResolution.resolvedMovementMode,
    movementModeRaw: movementResolution.rawMovementMode,
    movementMarkConsumed: movementResolution.consumed,
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
    movementMode: "any",
    movementModeRaw: null,
    movementMarkConsumed: false,
    fromState: null,
    toState: afterState,
    pathStates: [afterState]
  });

  lastKnownTokenStates.set(tokenDocument.uuid, afterState);
}

function onDeleteToken(tokenDocument) {
  lastKnownTokenStates.delete(tokenDocument.uuid);
  clearRecentDedupEntriesForToken(recentEnterEvents, tokenDocument);
  clearRecentDedupEntriesForToken(recentExitEvents, tokenDocument);
  clearRecentDedupEntriesForToken(recentOnMoveEvents, tokenDocument);
  recentMoveTokenEvents.delete(tokenDocument.uuid);
  queuedMovementModes.delete(tokenDocument.uuid);
  clearInsideStateCacheForToken(tokenDocument);
}

async function evaluateTokenEntry(tokenDocument, {
  moveSource,
  movementMode,
  movementModeRaw,
  movementMarkConsumed = false,
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
    const onExit = normalizedDefinition?.triggers?.onExit ?? {};
    const onMove = normalizedDefinition?.triggers?.onMove ?? {};

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
    const movementAnalysis = moveSource === "createToken"
      ? {
        crossedBoundary: toInside,
        sawEntry: toInside,
        sawExit: false,
        pathLengthPixels: 0,
        insideDistancePixels: 0
      }
      : analyzeMovementAcrossRegion(tokenDocument, regionDocument, pathStates, fromInside);
    const crossedBoundary = movementAnalysis.crossedBoundary;
    const enterDetected = moveSource === "createToken"
      ? toInside
      : !fromInside && movementAnalysis.sawEntry;
    const exitDetected = moveSource === "createToken"
      ? false
      : fromInside && !toInside && movementAnalysis.sawExit;
    const pathLength = pixelsToDistance(movementAnalysis.pathLengthPixels, scene);
    const insideDistance = pixelsToDistance(movementAnalysis.insideDistancePixels, scene);
    const stepDistance = coerceNumber(onMove.distanceStep, null);
    const moveTriggerCount = calculateMoveTriggerCount(insideDistance, stepDistance);
    const enterMovementModeMatched = movementModeMatches(movementMode, onEnter.movementMode);
    const exitMovementModeMatched = movementModeMatches(movementMode, onExit.movementMode);
    const moveMovementModeMatched = movementModeMatches(movementMode, onMove.movementMode);

    if (toInside) {
      regionInsideStates.set(insideStateKey, true);
    } else {
      regionInsideStates.delete(insideStateKey);
    }

    let effectApplied = false;

    if (!normalizedDefinition?.enabled) {
      debug("Skipped managed Region effect because the normalized definition is disabled.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id
      });
      continue;
    }

    if (!enterDetected && !exitDetected && moveTriggerCount <= 0) {
      debug("Skipped managed Region effect because no movement trigger was detected.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        moveSource,
        pathLength: roundDistanceValue(pathLength),
        insideDistance: roundDistanceValue(insideDistance),
        stepDistance: roundDistanceValue(stepDistance),
        triggerCount: moveTriggerCount
      });
    }

    if (enterDetected || exitDetected || moveTriggerCount > 0) {
      const filterResult = shouldAffectToken(tokenDocument, runtime, normalizedDefinition);
      if (!filterResult.allowed) {
        debug("Skipped managed Region effect because token filtering rejected the target.", {
          tokenId: tokenDocument.id,
          regionId: regionDocument.id,
          reason: filterResult.reason
        });
      } else {
        if (enterDetected) {
          if (!onEnter.enabled) {
            debug("Skipped managed Region effect because onEnter is disabled.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id
            });
          } else if (!movementModeMatches(movementMode, onEnter.movementMode)) {
            debug("Skipped managed Region effect because movement mode did not match.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id,
              trigger: "onEnter",
              moveSource,
              movementMode,
              requiredMovementMode: onEnter.movementMode ?? "any",
              movementModeMatched: false
            });
          } else if (isDuplicateMovementTrigger("enter", regionDocument, tokenDocument, moveSource, toState?.center)) {
            debug("Skipped managed Region effect because the entry was deduplicated.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id
            });
          } else {
            const application = await applyConfiguredTriggerEffect({
              regionDocument,
              tokenDocument,
              triggerConfig: onEnter,
              timing: "onEnter"
            });

            effectApplied = effectApplied || Boolean(application.applied && !application.skipped);

            debug("Managed Region onEnter effect completed.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id,
              moveSource,
              movementMode,
              requiredMovementMode: onEnter.movementMode ?? "any",
              movementModeMatched: true,
              applied: application.applied,
              skipped: application.skipped ?? false,
              reason: application.reason ?? null
            });
          }
        }

        if (moveTriggerCount > 0) {
          if (!onMove.enabled) {
            debug("Skipped managed Region effect because onMove is disabled.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id,
              moveSource,
              pathLength: roundDistanceValue(pathLength),
              insideDistance: roundDistanceValue(insideDistance),
              stepDistance: roundDistanceValue(stepDistance),
              triggerCount: moveTriggerCount
            });
          } else if (!moveMovementModeMatched) {
            debug("Skipped managed Region effect because movement mode did not match.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id,
              trigger: "onMove",
              moveSource,
              movementMode,
              requiredMovementMode: onMove.movementMode ?? "any",
              movementModeMatched: false,
              pathLength: roundDistanceValue(pathLength),
              insideDistance: roundDistanceValue(insideDistance),
              stepDistance: roundDistanceValue(stepDistance),
              triggerCount: moveTriggerCount
            });
          } else if (isDuplicateOnMoveTrigger(
            regionDocument,
            tokenDocument,
            moveSource,
            fromState,
            toState,
            moveTriggerCount,
            insideDistance
          )) {
            debug("Skipped managed Region effect because the onMove trigger was deduplicated.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id,
              moveSource,
              pathLength: roundDistanceValue(pathLength),
              insideDistance: roundDistanceValue(insideDistance),
              stepDistance: roundDistanceValue(stepDistance),
              triggerCount: moveTriggerCount
            });
          } else {
            let appliedCount = 0;

            for (let index = 0; index < moveTriggerCount; index += 1) {
              const application = await applyConfiguredTriggerEffect({
                regionDocument,
                tokenDocument,
                triggerConfig: onMove,
                timing: "onMove"
              });

              if (application.applied && !application.skipped) {
                appliedCount += 1;
                effectApplied = true;
              }
            }

            debug("Managed Region onMove effect completed.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id,
              moveSource,
              movementMode,
              requiredMovementMode: onMove.movementMode ?? "any",
              movementModeMatched: true,
              pathLength: roundDistanceValue(pathLength),
              insideDistance: roundDistanceValue(insideDistance),
              stepDistance: roundDistanceValue(stepDistance),
              triggerCount: moveTriggerCount,
              appliedCount,
              effectApplied: appliedCount > 0
            });
          }
        }

        if (exitDetected) {
          if (!onExit.enabled) {
            debug("Skipped managed Region effect because onExit is disabled.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id
            });
          } else if (!movementModeMatches(movementMode, onExit.movementMode)) {
            debug("Skipped managed Region effect because movement mode did not match.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id,
              trigger: "onExit",
              moveSource,
              movementMode,
              requiredMovementMode: onExit.movementMode ?? "any",
              movementModeMatched: false
            });
          } else if (isDuplicateMovementTrigger("exit", regionDocument, tokenDocument, moveSource, toState?.center)) {
            debug("Skipped managed Region effect because the exit was deduplicated.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id
            });
          } else {
            const application = await applyConfiguredTriggerEffect({
              regionDocument,
              tokenDocument,
              triggerConfig: onExit,
              timing: "onExit"
            });

            effectApplied = effectApplied || Boolean(application.applied && !application.skipped);

            debug("Managed Region onExit effect completed.", {
              tokenId: tokenDocument.id,
              regionId: regionDocument.id,
              moveSource,
              movementMode,
              requiredMovementMode: onExit.movementMode ?? "any",
              movementModeMatched: true,
              applied: application.applied,
              skipped: application.skipped ?? false,
              reason: application.reason ?? null
            });
          }
        }
      }
    }

    debug("Checked token against managed Region.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      moveSource,
      movementModeRaw,
      movementMode,
      movementMarkConsumed,
      enterRequiredMovementMode: onEnter.movementMode ?? "any",
      enterMovementModeMatched,
      exitRequiredMovementMode: onExit.movementMode ?? "any",
      exitMovementModeMatched,
      moveRequiredMovementMode: onMove.movementMode ?? "any",
      moveMovementModeMatched,
      fromX: fromState?.position?.x ?? null,
      fromY: fromState?.position?.y ?? null,
      toX: toState?.position?.x ?? null,
      toY: toState?.position?.y ?? null,
      fromInside,
      toInside,
      crossedBoundary,
      pathLength: roundDistanceValue(pathLength),
      insideDistance: roundDistanceValue(insideDistance),
      stepDistance: roundDistanceValue(stepDistance),
      triggerCount: moveTriggerCount,
      enterDetected,
      exitDetected,
      effectApplied,
      skipped: !effectApplied && (enterDetected || exitDetected || moveTriggerCount > 0)
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

function isDuplicateMovementTrigger(kind, regionDocument, tokenDocument, moveSource, afterCenter) {
  const store = kind === "exit" ? recentExitEvents : recentEnterEvents;
  cleanupExpiredDedupEntries(store);

  const centerKey = `${Math.round(afterCenter?.x ?? 0)}:${Math.round(afterCenter?.y ?? 0)}`;
  const key = [
    kind,
    regionDocument?.uuid ?? regionDocument?.id ?? "region",
    tokenDocument?.uuid ?? tokenDocument?.id ?? "token",
    moveSource,
    centerKey
  ].join("|");

  const lastSeen = store.get(key) ?? 0;
  const now = Date.now();
  store.set(key, now);

  return now - lastSeen < ENTRY_DEDUP_TTL_MS;
}

function cleanupExpiredDedupEntries(store) {
  const cutoff = Date.now() - ENTRY_DEDUP_TTL_MS;
  for (const [key, timestamp] of store.entries()) {
    if (timestamp < cutoff) {
      store.delete(key);
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
  recentEnterEvents.clear();
  recentExitEvents.clear();
  recentOnMoveEvents.clear();
  recentMoveTokenEvents.clear();
  queuedMovementModes.clear();

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

function analyzeMovementAcrossRegion(tokenDocument, regionDocument, pathStates, fromInside) {
  const states = compactStatePath(pathStates);
  if (!states.length) {
    return {
      crossedBoundary: false,
      sawEntry: false,
      sawExit: false,
      pathLengthPixels: 0,
      insideDistancePixels: 0
    };
  }

  let previousInside = Boolean(fromInside);
  let crossedBoundary = false;
  let sawEntry = false;
  let sawExit = false;
  let pathLengthPixels = 0;
  let insideDistancePixels = 0;

  for (let index = 1; index < states.length; index += 1) {
    const segmentSamples = sampleSegmentStates(states[index - 1], states[index]);
    let previousState = states[index - 1];

    for (const sampleState of segmentSamples) {
      const sampleInside = testTokenInsideManagedRegion(tokenDocument, regionDocument, sampleState);
      const segmentDistancePixels = measureStateDistance(previousState, sampleState);
      pathLengthPixels += segmentDistancePixels;
      insideDistancePixels += segmentDistancePixels * estimateInsideDistanceFactor(previousInside, sampleInside);

      if (previousInside !== sampleInside) {
        crossedBoundary = true;
        if (!previousInside && sampleInside) {
          sawEntry = true;
        }
        if (previousInside && !sampleInside) {
          sawExit = true;
        }
      }

      previousInside = sampleInside;
      previousState = sampleState;
    }
  }

  return {
    crossedBoundary,
    sawEntry,
    sawExit,
    pathLengthPixels,
    insideDistancePixels
  };
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

function clearRecentDedupEntriesForToken(store, tokenDocument) {
  const tokenKey = tokenDocument?.uuid ?? tokenDocument?.id ?? null;
  if (!tokenKey) {
    return;
  }

  const infix = `|${tokenKey}|`;
  for (const key of store.keys()) {
    if (key.includes(infix)) {
      store.delete(key);
    }
  }
}

function isDuplicateOnMoveTrigger(regionDocument, tokenDocument, moveSource, fromState, toState, triggerCount, insideDistance) {
  cleanupExpiredDedupEntries(recentOnMoveEvents);

  const tokenKey = tokenDocument?.uuid ?? tokenDocument?.id ?? "token";
  const regionKey = regionDocument?.uuid ?? regionDocument?.id ?? "region";
  const fromKey = buildPointKey(fromState?.center);
  const toKey = buildPointKey(toState?.center);
  const distanceKey = roundDistanceValue(insideDistance, 2);
  const key = [
    "move",
    regionKey,
    tokenKey,
    moveSource,
    fromKey,
    toKey,
    triggerCount,
    distanceKey
  ].join("|");

  const lastSeen = recentOnMoveEvents.get(key) ?? 0;
  const now = Date.now();
  recentOnMoveEvents.set(key, now);

  return now - lastSeen < ENTRY_DEDUP_TTL_MS;
}

function resolveMovementModeForEvaluation(tokenDocument, {
  moveSource,
  consume = false
} = {}) {
  const rawMovementMode = consume
    ? consumeQueuedMovementMode(tokenDocument)
    : peekQueuedMovementMode(tokenDocument);
  const resolvedMovementMode = normalizeMovementMode(rawMovementMode ?? "voluntary");
  const consumed = Boolean(consume && rawMovementMode);

  debug("Resolved token movement mode for Region evaluation.", {
    tokenId: tokenDocument?.id ?? null,
    moveSource,
    movementModeRaw: rawMovementMode,
    movementMode: resolvedMovementMode,
    movementMarkConsumed: consumed
  });

  return {
    rawMovementMode,
    resolvedMovementMode,
    consumed
  };
}

function consumeQueuedMovementMode(tokenDocument) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid) {
    return null;
  }

  const movementMode = queuedMovementModes.get(tokenUuid) ?? null;
  if (movementMode) {
    queuedMovementModes.delete(tokenUuid);
  }

  return movementMode;
}

function peekQueuedMovementMode(tokenDocument) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid) {
    return null;
  }

  return queuedMovementModes.get(tokenUuid) ?? null;
}

function movementModeMatches(actualMovementMode, requiredMovementMode) {
  const actual = normalizeMovementMode(actualMovementMode);
  const required = normalizeMovementMode(requiredMovementMode ?? "any");

  if (required === "any") {
    return true;
  }

  return actual === required;
}

function normalizeMovementMode(movementMode) {
  const normalized = String(movementMode ?? "any").toLowerCase();
  return ["any", "voluntary", "forced"].includes(normalized) ? normalized : "any";
}

function calculateMoveTriggerCount(insideDistance, stepDistance) {
  if (stepDistance === null || stepDistance <= 0 || insideDistance <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor((insideDistance + 0.0001) / stepDistance));
}

function measureStateDistance(fromState, toState) {
  const fromPoint = fromState?.center ?? fromState?.position ?? null;
  const toPoint = toState?.center ?? toState?.position ?? null;

  if (!fromPoint || !toPoint) {
    return 0;
  }

  return Math.hypot(
    coerceNumber(toPoint.x, 0) - coerceNumber(fromPoint.x, 0),
    coerceNumber(toPoint.y, 0) - coerceNumber(fromPoint.y, 0)
  );
}

function estimateInsideDistanceFactor(fromInside, toInside) {
  if (fromInside && toInside) {
    return 1;
  }

  if (fromInside !== toInside) {
    return 0.5;
  }

  return 0;
}

function buildPointKey(point) {
  return `${Math.round(coerceNumber(point?.x, 0))}:${Math.round(coerceNumber(point?.y, 0))}`;
}

function roundDistanceValue(value, precision = 2) {
  const numericValue = coerceNumber(value, null);
  if (numericValue === null) {
    return null;
  }

  const factor = 10 ** precision;
  return Math.round(numericValue * factor) / factor;
}
