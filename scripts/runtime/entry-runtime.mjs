import { ENTRY_DEDUP_TTL_MS, MODULE_ID } from "../constants.mjs";
import { applyConfiguredTriggerEffect } from "./entry-effects.mjs";
import {
  coerceNumber,
  debug,
  distanceToPixels,
  findManagedRegions,
  getRegionRuntimeFlags,
  getTokenCenter,
  isPrimaryGM,
  pixelsToDistance,
  testTokenInsideManagedRegion,
  wait
} from "./utils.mjs";

const lastKnownTokenStates = new Map();
const regionInsideStates = new Map();
const recentEnterEvents = new Map();
const recentExitEvents = new Map();
const recentOnMoveEvents = new Map();
const recentMoveTokenEvents = new Map();
const queuedMovementModes = new Map();
const internalStopDestinations = new Map();
const handledMovementInterruptions = new Map();
const pendingPreUpdateGridStops = new Map();

let hooksRegistered = false;
const INTERNAL_STOP_TTL_MS = 3000;
const MOVEMENT_SEQUENCE_TTL_MS = 5000;
const MOVEMENT_STOP_SETTLE_TIMEOUT_MS = 100;
const PENDING_PREUPDATE_GRID_STOP_TTL_MS = 3000;

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

function onPreUpdateToken(tokenDocument, changed, options = {}) {
  if (!isPrimaryGM()) {
    return;
  }

  if (options?.[MODULE_ID]?.internalStopMovement) {
    return;
  }

  if (!hasTranslationChange(changed)) {
    return;
  }

  if (!isSquareGridStopModeAvailable(tokenDocument?.parent ?? null)) {
    return;
  }

  const scene = tokenDocument?.parent ?? null;
  const actor = tokenDocument?.actor ?? null;
  if (!scene || !actor) {
    return;
  }

  const managedRegions = findManagedRegions(scene);
  if (!managedRegions.length) {
    return;
  }

  const fromState = snapshotTokenState(tokenDocument);
  const intendedToState = snapshotTokenStateAtPosition(tokenDocument, {
    x: changed.x ?? tokenDocument.x,
    y: changed.y ?? tokenDocument.y,
    width: changed.width ?? tokenDocument.width,
    height: changed.height ?? tokenDocument.height,
    elevation: changed.elevation ?? tokenDocument.elevation,
    shape: changed.shape ?? tokenDocument.shape
  });

  if (stateMatchesStopDestination(intendedToState, {
    x: fromState.position.x,
    y: fromState.position.y,
    width: fromState.width,
    height: fromState.height,
    elevation: fromState.elevation
  })) {
    return;
  }

  const movementResolution = resolveMovementModeForEvaluation(tokenDocument, {
    moveSource: "preUpdateToken-grid-truncate",
    consume: false
  });

  const evaluations = collectRegionEvaluations(tokenDocument, managedRegions, {
    scene,
    moveSource: "preUpdateToken-grid-truncate",
    fromState,
    toState: intendedToState,
    pathStates: compactStatePath([fromState, intendedToState]),
    movementMode: movementResolution.resolvedMovementMode
  });
  const stopDecision = chooseGridCellStopDecision(evaluations, {
    tokenDocument,
    moveSource: "preUpdateToken-grid-truncate",
    movementMode: movementResolution.resolvedMovementMode
  });

  if (!stopDecision?.stopState?.position) {
    return;
  }

  const currentCell = buildGridCellPayload(fromState);
  const firstInsideCell = buildGridCellPayload(stopDecision.firstInsideCellState);
  const areSameCell = areGridCellsEqual(currentCell, firstInsideCell);
  const willActuallyMove = !stateMatchesStopDestination(stopDecision.stopState, {
    x: fromState.position.x,
    y: fromState.position.y,
    width: fromState.width,
    height: fromState.height,
    elevation: fromState.elevation
  });

  if (areSameCell || !willActuallyMove) {
    debug("Skipped managed Region preUpdate grid stop because it would not improve the movement.", {
      tokenId: tokenDocument?.id ?? null,
      regionId: stopDecision.regionId ?? null,
      moveSource: "preUpdateToken-grid-truncate",
      movementMode: movementResolution.resolvedMovementMode,
      trigger: stopDecision.trigger,
      stopReason: stopDecision.stopReason ?? null,
      stopMode: stopDecision.stopMode ?? "grid-cell",
      currentCell,
      firstInsideCell,
      areSameCell,
      willActuallyMove,
      selectedStopPoint: buildSimplePositionPayload(stopDecision.stopState),
      appliedStopPoint: null,
      finalTokenPosition: buildSimplePositionPayload(fromState),
      skippedBecauseSameCell: areSameCell,
      skippedBecauseNoUsefulAdvance: !willActuallyMove
    });
    return;
  }

  changed.x = stopDecision.stopState.position.x;
  changed.y = stopDecision.stopState.position.y;

  if (
    Object.prototype.hasOwnProperty.call(changed, "elevation") ||
    !compareNumbersWithinTolerance(stopDecision.stopState.elevation, tokenDocument.elevation, 0.5)
  ) {
    changed.elevation = stopDecision.stopState.elevation;
  }

  recordPendingPreUpdateGridStop(tokenDocument, stopDecision, {
    originalFromState: fromState,
    originalToState: intendedToState
  });

  debug("Applied managed Region preUpdate grid stop.", {
    tokenId: tokenDocument?.id ?? null,
    regionId: stopDecision.regionId ?? null,
    moveSource: "preUpdateToken-grid-truncate",
    movementMode: movementResolution.resolvedMovementMode,
    trigger: stopDecision.trigger,
    stopReason: stopDecision.stopReason ?? null,
    stopMode: stopDecision.stopMode ?? "grid-cell",
    currentCell,
    originalFrom: buildSimplePositionPayload(fromState),
    originalTo: buildSimplePositionPayload(intendedToState),
    firstInsideCell,
    areSameCell,
    willActuallyMove,
    selectedStopPoint: buildSimplePositionPayload(stopDecision.stopState),
    onMoveThresholdPoint: buildSimplePositionPayload(stopDecision.onMoveThresholdState),
    truncatedDestination: buildSimplePositionPayload(stopDecision.stopState)
  });
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
  const movementSequenceId = buildMovementSequenceId(tokenDocument, movement, movementPath);
  const handledInterruption = getHandledMovementInterruption(tokenDocument, movementSequenceId);

  if (handledInterruption) {
    tokenDocument.stopMovement?.();
    markRecentMoveTokenEvent(tokenDocument, handledInterruption.stopState ?? movementPath.toState);
    lastKnownTokenStates.set(tokenDocument.uuid, handledInterruption.stopState ?? movementPath.toState);

    debug("Skipped managed Region movement interruption because the movement sequence was already handled.", {
      movementSequenceId,
      tokenId: tokenDocument?.id ?? null,
      regionId: handledInterruption.regionId ?? null,
      trigger: handledInterruption.trigger ?? null,
      stopReason: handledInterruption.stopReason ?? null,
      stopMode: handledInterruption.stopMode ?? "sampled-fallback",
      firstInsideCell: handledInterruption.firstInsideCell ?? null,
      originalFrom: buildSimplePositionPayload(movementPath.fromState),
      originalTo: buildSimplePositionPayload(movementPath.toState),
      selectedStopPoint: handledInterruption.stopPoint ?? null,
      appliedStopPoint: handledInterruption.stopPoint ?? null,
      finalTokenPosition: buildSimplePositionPayload(snapshotTokenState(tokenDocument)),
      onMoveThresholdPoint: handledInterruption.onMoveThresholdPoint ?? null,
      interruptionApplied: false,
      movementInterrupted: false,
      interruptionSkippedBecauseAlreadyHandled: true,
      usedNativeTruncation: !(handledInterruption.usedRollbackFallback ?? false),
      usedRollbackFallback: handledInterruption.usedRollbackFallback ?? false
    });
    return;
  }

  if (consumeInternalStopDestinationIfMatched(tokenDocument, movementPath.toState)) {
    markRecentMoveTokenEvent(tokenDocument, movementPath.toState);
    lastKnownTokenStates.set(tokenDocument.uuid, movementPath.toState);

    debug("Skipped managed Region evaluation for internal stop-movement sync.", {
      movementSequenceId,
      tokenId: tokenDocument?.id ?? null,
      moveSource: movementPath.moveSource,
      toX: movementPath.toState?.position?.x ?? null,
      toY: movementPath.toState?.position?.y ?? null
    });
    return;
  }

  const movementResolution = resolveMovementModeForEvaluation(tokenDocument, {
    moveSource: movementPath.moveSource,
    consume: true
  });

  const evaluation = await evaluateTokenEntry(tokenDocument, {
    moveSource: movementPath.moveSource,
    movementSequenceId,
    movementMode: movementResolution.resolvedMovementMode,
    movementModeRaw: movementResolution.rawMovementMode,
    movementMarkConsumed: movementResolution.consumed,
    fromState: movementPath.fromState,
    toState: movementPath.toState,
    pathStates: movementPath.pathStates,
    movement
  });

  const finalState = evaluation?.finalState ?? movementPath.toState;
  markRecentMoveTokenEvent(tokenDocument, finalState);
  lastKnownTokenStates.set(tokenDocument.uuid, finalState);

  if (evaluation?.interruptionAttempted) {
    debug("Resolved managed Region movement stop result.", {
      movementSequenceId,
      tokenId: tokenDocument?.id ?? null,
      originalFrom: buildSimplePositionPayload(movementPath.fromState),
      originalTo: buildSimplePositionPayload(movementPath.toState),
      stopReason: evaluation.stopReason ?? null,
      stopMode: evaluation.stopMode ?? "sampled-fallback",
      firstInsideCell: evaluation.firstInsideCell ?? null,
      selectedStopPoint: evaluation.selectedStopPoint ?? null,
      appliedStopPoint: evaluation.appliedStopPoint ?? null,
      finalTokenPosition: buildSimplePositionPayload(snapshotTokenState(tokenDocument)),
      onMoveThresholdPoint: evaluation.onMoveThresholdPoint ?? null,
      interruptionApplied: evaluation.movementInterrupted,
      movementInterrupted: evaluation.movementInterrupted,
      interruptionSkippedBecauseAlreadyHandled: false,
      usedNativeTruncation: evaluation.usedNativeTruncation ?? false,
      usedRollbackFallback: evaluation.usedRollbackFallback ?? false
    });
  }
}

async function onUpdateToken(tokenDocument, changed, options = {}) {
  if (!isPrimaryGM()) {
    return;
  }

  if (!hasPositionChange(changed)) {
    return;
  }

  const afterState = snapshotTokenState(tokenDocument);
  if (options?.[MODULE_ID]?.internalStopMovement) {
    lastKnownTokenStates.set(tokenDocument.uuid, afterState);
    return;
  }

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
  internalStopDestinations.delete(tokenDocument.uuid);
  clearHandledMovementInterruptionsForToken(tokenDocument);
  clearInsideStateCacheForToken(tokenDocument);
}

async function evaluateTokenEntry(tokenDocument, {
  moveSource,
  movementSequenceId = null,
  movementMode,
  movementModeRaw,
  movementMarkConsumed = false,
  fromState,
  toState,
  pathStates = [],
  movement = null
}) {
  const scene = tokenDocument?.parent ?? null;
  const actor = tokenDocument?.actor ?? null;
  const fallbackFinalState = toState ?? compactStatePath(pathStates).at(-1) ?? null;

  if (!scene) {
    return { finalState: fallbackFinalState, movementInterrupted: false };
  }

  if (!tokenDocument?.id || tokenDocument?.parent?.tokens?.get?.(tokenDocument.id) === null) {
    debug("Skipped token entry check because the token is invalid.", {
      tokenId: tokenDocument?.id ?? null,
      moveSource
    });
    return { finalState: fallbackFinalState, movementInterrupted: false };
  }

  if (!actor) {
    debug("Skipped token entry check because the token has no Actor.", {
      tokenId: tokenDocument.id,
      tokenName: tokenDocument.name,
      moveSource
    });
    return { finalState: fallbackFinalState, movementInterrupted: false };
  }

  const managedRegions = findManagedRegions(scene);
  if (!managedRegions.length) {
    return { finalState: fallbackFinalState, movementInterrupted: false };
  }

  const basePathStates = compactStatePath(pathStates);
  const initialEvaluations = collectRegionEvaluations(tokenDocument, managedRegions, {
    scene,
    moveSource,
    fromState,
    toState,
    pathStates: basePathStates,
    movementMode
  });
  const stopDecision = chooseStopDecision(initialEvaluations, {
    tokenDocument,
    moveSource,
    movementSequenceId,
    movementMode
  });

  let effectivePathStates = basePathStates;
  let effectiveToState = fallbackFinalState;
  let movementInterrupted = false;
  let interruptionAttempted = false;
  let selectedStopPoint = null;
  let appliedStopPoint = null;
  let stopReason = null;
  let stopMode = null;
  let firstInsideCell = null;
  let onMoveThresholdPoint = null;
  let usedNativeTruncation = false;
  let usedRollbackFallback = false;

  if (stopDecision) {
    interruptionAttempted = true;
    selectedStopPoint = buildSimplePositionPayload(stopDecision.stopState);
    stopReason = stopDecision.stopReason ?? null;
    stopMode = stopDecision.stopMode ?? null;
    firstInsideCell = buildGridCellPayload(stopDecision.firstInsideCellState);
    onMoveThresholdPoint = buildSimplePositionPayload(stopDecision.onMoveThresholdState);
    const interruption = await interruptTokenMovementForTrigger({
      tokenDocument,
      movement,
      moveSource,
      movementSequenceId,
      originalFromState: fromState ?? basePathStates[0] ?? null,
      originalToState: toState ?? fallbackFinalState,
      stopDecision
    });

    movementInterrupted = interruption.interrupted;
    appliedStopPoint = interruption.appliedStopPoint ?? null;
    usedNativeTruncation = interruption.usedNativeTruncation ?? false;
    usedRollbackFallback = interruption.usedRollbackFallback ?? false;
    if (movementInterrupted) {
      effectivePathStates = buildTruncatedPathStates(
        basePathStates,
        stopDecision.stopState,
        stopDecision.segmentIndex
      );
      effectiveToState = stopDecision.stopState;
    }
  }

  const evaluations = movementInterrupted
    ? collectRegionEvaluations(tokenDocument, managedRegions, {
      scene,
      moveSource,
      fromState,
      toState: effectiveToState,
      pathStates: effectivePathStates,
      movementMode
    })
    : initialEvaluations;

  for (const evaluation of evaluations) {
    await applyRegionEvaluation(tokenDocument, evaluation, {
      moveSource,
      movementSequenceId,
      movementMode,
      movementModeRaw,
      movementMarkConsumed,
      fromState,
      toState: effectiveToState,
      stopDecision,
      movementInterrupted
    });
  }

  return {
    finalState: effectiveToState,
    movementInterrupted,
    interruptionAttempted,
    selectedStopPoint,
    appliedStopPoint,
    stopReason,
    stopMode,
    firstInsideCell,
    onMoveThresholdPoint,
    usedNativeTruncation,
    usedRollbackFallback
  };
}

function collectRegionEvaluations(tokenDocument, managedRegions, {
  scene,
  moveSource,
  fromState,
  toState,
  pathStates,
  movementMode
}) {
  const states = compactStatePath(pathStates);
  const firstPathState = states[0] ?? fromState ?? null;
  const lastPathState = states[states.length - 1] ?? toState ?? null;

  return managedRegions.map((regionDocument) => {
    const runtime = getRegionRuntimeFlags(regionDocument);
    const normalizedDefinition = runtime?.normalizedDefinition ?? null;
    const onEnter = normalizedDefinition?.triggers?.onEnter ?? {};
    const onExit = normalizedDefinition?.triggers?.onExit ?? {};
    const onMove = normalizedDefinition?.triggers?.onMove ?? {};
    const stepDistance = coerceNumber(onMove.distanceStep, null);
    const stepDistancePixels = stepDistance === null ? null : distanceToPixels(stepDistance, scene);
    const insideStateKey = buildInsideStateKey(tokenDocument, regionDocument);
    const cachedFromInside = regionInsideStates.get(insideStateKey) ?? null;
    const fromInside = firstPathState
      ? testTokenInsideManagedRegion(tokenDocument, regionDocument, firstPathState)
      : Boolean(cachedFromInside);
    const toInside = lastPathState
      ? testTokenInsideManagedRegion(tokenDocument, regionDocument, lastPathState)
      : false;
    const movementAnalysis = moveSource === "createToken"
      ? {
        crossedBoundary: toInside,
        sawEntry: toInside,
        sawExit: false,
        pathLengthPixels: 0,
        insideDistancePixels: 0,
        firstEntryState: toInside ? lastPathState : null,
        firstEntryPathDistancePixels: toInside ? 0 : null,
        firstEntrySegmentIndex: 1,
        firstInsideCellState: toInside ? lastPathState : null,
        firstInsideCellPathDistancePixels: toInside ? 0 : null,
        firstInsideCellSegmentIndex: 1,
        firstInsideStepState: toInside ? lastPathState : null,
        firstInsideStepPathDistancePixels: toInside ? 0 : null,
        firstInsideStepSegmentIndex: 1,
        firstMoveTriggerState: null,
        firstMoveTriggerPathDistancePixels: null,
        firstMoveTriggerSegmentIndex: null
      }
      : analyzeMovementAcrossRegion(
        tokenDocument,
        regionDocument,
        states,
        fromInside,
        { stepDistancePixels }
      );
    const enterDetected = moveSource === "createToken"
      ? toInside
      : !fromInside && movementAnalysis.sawEntry;
    const exitDetected = moveSource === "createToken"
      ? false
      : fromInside && !toInside && movementAnalysis.sawExit;
    const pathLength = pixelsToDistance(movementAnalysis.pathLengthPixels, scene);
    const insideDistance = pixelsToDistance(movementAnalysis.insideDistancePixels, scene);
    const moveTriggerCount = calculateMoveTriggerCount(insideDistance, stepDistance);
    const enterMovementModeMatched = movementModeMatches(movementMode, onEnter.movementMode);
    const exitMovementModeMatched = movementModeMatches(movementMode, onExit.movementMode);
    const moveMovementModeMatched = movementModeMatches(movementMode, onMove.movementMode);
    const filterResult = shouldAffectToken(tokenDocument, runtime, normalizedDefinition);

    return {
      regionDocument,
      runtime,
      normalizedDefinition,
      onEnter,
      onExit,
      onMove,
      insideStateKey,
      fromState: firstPathState,
      toState: lastPathState,
      fromInside,
      toInside,
      movementAnalysis,
      pathLength,
      insideDistance,
      stepDistance,
      moveTriggerCount,
      enterDetected,
      exitDetected,
      enterMovementModeMatched,
      exitMovementModeMatched,
      moveMovementModeMatched,
      filterResult
    };
  });
}

async function applyRegionEvaluation(tokenDocument, evaluation, {
  moveSource,
  movementSequenceId,
  movementMode,
  movementModeRaw,
  movementMarkConsumed,
  fromState,
  toState,
  stopDecision,
  movementInterrupted
}) {
  const {
    regionDocument,
    runtime,
    normalizedDefinition,
    onEnter,
    onExit,
    onMove,
    insideStateKey,
    fromInside,
    toInside,
    movementAnalysis,
    pathLength,
    insideDistance,
    stepDistance,
    moveTriggerCount,
    enterDetected,
    exitDetected,
    enterMovementModeMatched,
    exitMovementModeMatched,
    moveMovementModeMatched,
    filterResult
  } = evaluation;

  if (toInside) {
    regionInsideStates.set(insideStateKey, true);
  } else {
    regionInsideStates.delete(insideStateKey);
  }

  let effectApplied = false;
  const stopHandledByRegion = Boolean(
    movementInterrupted &&
    stopDecision &&
    stopDecision.regionId === regionDocument.id
  );
  const stopPoint = stopHandledByRegion ? buildStopPointPayload(stopDecision.stopState) : null;
  const stopMode = stopHandledByRegion ? stopDecision.stopMode ?? "sampled-fallback" : null;
  const firstInsideCell = stopHandledByRegion
    ? buildGridCellPayload(stopDecision.firstInsideCellState)
    : buildGridCellPayload(movementAnalysis.firstInsideCellState);
  const onMoveThresholdPoint = stopHandledByRegion
    ? buildSimplePositionPayload(stopDecision.onMoveThresholdState)
    : buildSimplePositionPayload(movementAnalysis.firstMoveTriggerState);

  if (!normalizedDefinition?.enabled) {
    debug("Skipped managed Region effect because the normalized definition is disabled.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id
    });
    return;
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
    if (!filterResult.allowed) {
      debug("Skipped managed Region effect because token filtering rejected the target.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        reason: filterResult.reason
      });
    } else {
      effectApplied = await applyEnterTriggerIfNeeded(tokenDocument, regionDocument, onEnter, {
        moveSource,
        movementMode,
        enterDetected,
        enterMovementModeMatched,
        entryCenter: movementAnalysis.firstEntryState?.center ?? toState?.center,
        stopPoint,
        stopHandledByRegion,
        stopDecision
      });

      const moveApplied = await applyMoveTriggerIfNeeded(tokenDocument, regionDocument, onMove, {
        moveSource,
        movementMode,
        moveTriggerCount,
        moveMovementModeMatched,
        fromState,
        toState,
        insideDistance,
        pathLength,
        stepDistance,
        stopPoint,
        onMoveThresholdPoint,
        stopHandledByRegion,
        stopDecision
      });
      effectApplied = effectApplied || moveApplied;

      const exitApplied = await applyExitTriggerIfNeeded(tokenDocument, regionDocument, onExit, {
        moveSource,
        movementMode,
        exitDetected,
        exitMovementModeMatched,
        exitCenter: toState?.center,
        stopPoint,
        stopHandledByRegion,
        stopDecision
      });
      effectApplied = effectApplied || exitApplied;
    }
  }

  debug("Checked token against managed Region.", {
    movementSequenceId,
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
    onEnterStopMovementOnTrigger: onEnter.stopMovementOnTrigger ?? false,
    onMoveStopMovementOnTrigger: onMove.stopMovementOnTrigger ?? false,
    fromX: fromState?.position?.x ?? null,
    fromY: fromState?.position?.y ?? null,
    toX: toState?.position?.x ?? null,
    toY: toState?.position?.y ?? null,
    fromInside,
    toInside,
    crossedBoundary: movementAnalysis.crossedBoundary,
    pathLength: roundDistanceValue(pathLength),
    insideDistance: roundDistanceValue(insideDistance),
    stepDistance: roundDistanceValue(stepDistance),
    triggerCount: moveTriggerCount,
    enterDetected,
    exitDetected,
    stopTrigger: stopHandledByRegion ? stopDecision.trigger : null,
    stopReason: stopHandledByRegion ? stopDecision.stopReason ?? null : null,
    stopMode,
    firstInsideCell,
    stopPoint,
    onMoveThresholdPoint,
    movementInterrupted: stopHandledByRegion,
    effectApplied,
    skipped: !effectApplied && (enterDetected || exitDetected || moveTriggerCount > 0)
  });
}

async function applyEnterTriggerIfNeeded(tokenDocument, regionDocument, onEnter, {
  moveSource,
  movementMode,
  enterDetected,
  enterMovementModeMatched,
  entryCenter,
  stopPoint,
  stopHandledByRegion,
  stopDecision
}) {
  if (!enterDetected) {
    return false;
  }

  if (!onEnter.enabled) {
    debug("Skipped managed Region effect because onEnter is disabled.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id
    });
    return false;
  }

  if (!enterMovementModeMatched) {
    debug("Skipped managed Region effect because movement mode did not match.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      trigger: "onEnter",
      moveSource,
      movementMode,
      requiredMovementMode: onEnter.movementMode ?? "any",
      movementModeMatched: false
    });
    return false;
  }

  if (isDuplicateMovementTrigger("enter", regionDocument, tokenDocument, moveSource, entryCenter)) {
    debug("Skipped managed Region effect because the entry was deduplicated.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id
    });
    return false;
  }

  const application = await applyConfiguredTriggerEffect({
    regionDocument,
    tokenDocument,
    triggerConfig: onEnter,
    timing: "onEnter"
  });

  debug("Managed Region onEnter effect completed.", {
    tokenId: tokenDocument.id,
    regionId: regionDocument.id,
    moveSource,
    movementMode,
    requiredMovementMode: onEnter.movementMode ?? "any",
    movementModeMatched: true,
    stopMovementOnTrigger: onEnter.stopMovementOnTrigger ?? false,
    stopPoint,
    stopReason: stopHandledByRegion ? stopDecision?.stopReason ?? null : null,
    movementInterrupted: stopHandledByRegion && stopDecision.trigger === "onEnter",
    applied: application.applied,
    skipped: application.skipped ?? false,
    reason: application.reason ?? null
  });

  return Boolean(application.applied && !application.skipped);
}

async function applyMoveTriggerIfNeeded(tokenDocument, regionDocument, onMove, {
  moveSource,
  movementMode,
  moveTriggerCount,
  moveMovementModeMatched,
  fromState,
  toState,
  insideDistance,
  pathLength,
  stepDistance,
  stopPoint,
  onMoveThresholdPoint,
  stopHandledByRegion,
  stopDecision
}) {
  if (moveTriggerCount <= 0) {
    return false;
  }

  const effectiveTriggerCount = moveTriggerCount;

  if (!onMove.enabled) {
    debug("Skipped managed Region effect because onMove is disabled.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      moveSource,
      pathLength: roundDistanceValue(pathLength),
      insideDistance: roundDistanceValue(insideDistance),
      stepDistance: roundDistanceValue(stepDistance),
      triggerCount: effectiveTriggerCount
    });
    return false;
  }

  if (!moveMovementModeMatched) {
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
      triggerCount: effectiveTriggerCount
    });
    return false;
  }

  if (isDuplicateOnMoveTrigger(
    regionDocument,
    tokenDocument,
    moveSource,
    fromState,
    toState,
    effectiveTriggerCount,
    insideDistance
  )) {
    debug("Skipped managed Region effect because the onMove trigger was deduplicated.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      moveSource,
      pathLength: roundDistanceValue(pathLength),
      insideDistance: roundDistanceValue(insideDistance),
      stepDistance: roundDistanceValue(stepDistance),
      triggerCount: effectiveTriggerCount
    });
    return false;
  }

  let appliedCount = 0;

  for (let index = 0; index < effectiveTriggerCount; index += 1) {
    const application = await applyConfiguredTriggerEffect({
      regionDocument,
      tokenDocument,
      triggerConfig: onMove,
      timing: "onMove"
    });

    if (application.applied && !application.skipped) {
      appliedCount += 1;
    }
  }

  debug("Managed Region onMove effect completed.", {
    tokenId: tokenDocument.id,
    regionId: regionDocument.id,
    moveSource,
    movementMode,
    requiredMovementMode: onMove.movementMode ?? "any",
    movementModeMatched: true,
    stopMovementOnTrigger: onMove.stopMovementOnTrigger ?? false,
    stopPoint,
    stopReason: stopHandledByRegion ? stopDecision?.stopReason ?? null : null,
    onMoveThresholdPoint,
    movementInterrupted: stopHandledByRegion && stopDecision.trigger === "onMove",
    pathLength: roundDistanceValue(pathLength),
    insideDistance: roundDistanceValue(insideDistance),
    stepDistance: roundDistanceValue(stepDistance),
    triggerCount: effectiveTriggerCount,
    appliedCount,
    effectApplied: appliedCount > 0
  });

  return appliedCount > 0;
}

async function applyExitTriggerIfNeeded(tokenDocument, regionDocument, onExit, {
  moveSource,
  movementMode,
  exitDetected,
  exitMovementModeMatched,
  exitCenter
}) {
  if (!exitDetected) {
    return false;
  }

  if (!onExit.enabled) {
    debug("Skipped managed Region effect because onExit is disabled.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id
    });
    return false;
  }

  if (!exitMovementModeMatched) {
    debug("Skipped managed Region effect because movement mode did not match.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      trigger: "onExit",
      moveSource,
      movementMode,
      requiredMovementMode: onExit.movementMode ?? "any",
      movementModeMatched: false
    });
    return false;
  }

  if (isDuplicateMovementTrigger("exit", regionDocument, tokenDocument, moveSource, exitCenter)) {
    debug("Skipped managed Region effect because the exit was deduplicated.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id
    });
    return false;
  }

  const application = await applyConfiguredTriggerEffect({
    regionDocument,
    tokenDocument,
    triggerConfig: onExit,
    timing: "onExit"
  });

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

  return Boolean(application.applied && !application.skipped);
}

function chooseStopDecision(evaluations, {
  tokenDocument,
  moveSource,
  movementSequenceId,
  movementMode
}) {
  for (const evaluation of evaluations) {
    const {
      regionDocument,
      normalizedDefinition,
      onEnter,
      onMove,
      filterResult
    } = evaluation;

    if (!normalizedDefinition?.enabled || !filterResult.allowed) {
      continue;
    }

    if (onEnter.enabled && onEnter.stopMovementOnTrigger) {
      debug("Skipped managed Region movement stop because stopMovementOnTrigger is temporarily disabled.", {
        movementSequenceId,
        tokenId: tokenDocument?.id ?? null,
        regionId: regionDocument?.id ?? null,
        moveSource,
        movementMode,
        trigger: "onEnter",
        stopSupported: false,
        stopRequested: true,
        requiredMovementMode: onEnter.movementMode ?? "any"
      });
    }

    if (onMove.enabled && onMove.stopMovementOnTrigger) {
      debug("Skipped managed Region movement stop because stopMovementOnTrigger is temporarily disabled.", {
        movementSequenceId,
        tokenId: tokenDocument?.id ?? null,
        regionId: regionDocument?.id ?? null,
        moveSource,
        movementMode,
        trigger: "onMove",
        stopSupported: false,
        stopRequested: true,
        requiredMovementMode: onMove.movementMode ?? "any"
      });
    }
  }

  return null;
}

function chooseGridCellStopDecision(evaluations, {
  tokenDocument,
  moveSource,
  movementMode
}) {
  if (!isSquareGridStopModeAvailable()) {
    return null;
  }

  const candidates = [];

  for (const evaluation of evaluations) {
    const {
      regionDocument,
      normalizedDefinition,
      onEnter,
      onMove,
      enterDetected,
      enterMovementModeMatched,
      moveMovementModeMatched,
      movementAnalysis,
      filterResult
    } = evaluation;

    if (!normalizedDefinition?.enabled || !filterResult.allowed) {
      continue;
    }

    if (
      enterDetected &&
      onEnter.enabled &&
      onEnter.stopMovementOnTrigger &&
      enterMovementModeMatched &&
      movementAnalysis.firstInsideCellState &&
      !checkMovementTriggerDedup(
        "enter",
        regionDocument,
        tokenDocument,
        moveSource,
        movementAnalysis.firstInsideCellState.center,
        { record: false }
      )
    ) {
      candidates.push({
        regionDocument,
        regionId: regionDocument.id,
        trigger: "onEnter",
        stopReason: "entry",
        stopMode: "grid-cell",
        firstInsideCellState: movementAnalysis.firstInsideCellState,
        pathDistancePixels: movementAnalysis.firstInsideCellPathDistancePixels ?? 0,
        stopState: movementAnalysis.firstInsideCellState,
        segmentIndex: movementAnalysis.firstInsideCellSegmentIndex ?? 1,
        onMoveThresholdState: null
      });
    }

    if (
      onMove.enabled &&
      onMove.stopMovementOnTrigger &&
      moveMovementModeMatched &&
      movementAnalysis.firstInsideCellState &&
      !checkOnMoveTriggerDedup(
        regionDocument,
        tokenDocument,
        moveSource,
        evaluation.fromState,
        movementAnalysis.firstInsideCellState,
        0,
        0,
        { record: false }
      )
    ) {
      candidates.push({
        regionDocument,
        regionId: regionDocument.id,
        trigger: "onMove",
        stopReason: "first-inside-step",
        stopMode: "grid-cell",
        firstInsideCellState: movementAnalysis.firstInsideCellState,
        pathDistancePixels: movementAnalysis.firstInsideCellPathDistancePixels ?? 0,
        stopState: movementAnalysis.firstInsideCellState,
        segmentIndex: movementAnalysis.firstInsideCellSegmentIndex ?? 1,
        onMoveThresholdState: movementAnalysis.firstMoveTriggerState ?? null
      });
    }
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) => {
    const distanceDelta = (left.pathDistancePixels ?? 0) - (right.pathDistancePixels ?? 0);
    if (distanceDelta !== 0) {
      return distanceDelta;
    }

    if (left.trigger === right.trigger) {
      return 0;
    }

    return left.trigger === "onEnter" ? -1 : 1;
  });

  const decision = candidates[0];

  debug("Selected managed Region preUpdate grid stop point.", {
    tokenId: tokenDocument?.id ?? null,
    regionId: decision.regionId,
    moveSource,
    movementMode,
    trigger: decision.trigger,
    stopReason: decision.stopReason ?? null,
    stopMode: decision.stopMode ?? "grid-cell",
    firstInsideCell: buildGridCellPayload(decision.firstInsideCellState),
    selectedStopPoint: buildSimplePositionPayload(decision.stopState),
    onMoveThresholdPoint: buildSimplePositionPayload(decision.onMoveThresholdState)
  });

  return decision;
}

function buildTruncatedPathStates(pathStates, stopState, segmentIndex = 1) {
  const states = compactStatePath(pathStates);
  if (!stopState) {
    return states;
  }

  const clampedSegmentIndex = Math.max(1, Math.min(segmentIndex, states.length));
  return compactStatePath([
    ...states.slice(0, clampedSegmentIndex),
    duplicateStopState(stopState)
  ]);
}

async function interruptTokenMovementForTrigger({
  tokenDocument,
  movement,
  moveSource,
  movementSequenceId,
  originalFromState,
  originalToState,
  stopDecision
}) {
  const stopState = stopDecision?.stopState ?? null;
  const stopPoint = buildSimplePositionPayload(stopState);
  const stopReason = stopDecision?.stopReason ?? null;
  const stopMode = stopDecision?.stopMode ?? "sampled-fallback";
  const firstInsideCell = buildGridCellPayload(stopDecision?.firstInsideCellState);
  const onMoveThresholdPoint = buildSimplePositionPayload(stopDecision?.onMoveThresholdState);
  const originalDestination = originalToState
    ? {
      x: originalToState.position?.x ?? 0,
      y: originalToState.position?.y ?? 0,
      width: originalToState.width ?? 1,
      height: originalToState.height ?? 1,
      elevation: originalToState.elevation ?? 0
    }
    : null;

  if (!canInterruptMovement(moveSource, movement, tokenDocument, stopState)) {
    debug("Skipped movement interruption because no interruptible move context was available.", {
      movementSequenceId,
      tokenId: tokenDocument?.id ?? null,
      regionId: stopDecision?.regionId ?? null,
      moveSource,
      trigger: stopDecision?.trigger ?? null,
      stopMovementOnTrigger: false,
      stopSupported: false,
      originalFrom: buildSimplePositionPayload(originalFromState),
      originalTo: buildSimplePositionPayload(originalToState),
      stopReason,
      stopMode,
      firstInsideCell,
      selectedStopPoint: stopPoint,
      appliedStopPoint: null,
      finalTokenPosition: buildSimplePositionPayload(snapshotTokenState(tokenDocument)),
      onMoveThresholdPoint,
      interruptionApplied: false,
      interruptionSkippedBecauseAlreadyHandled: false,
      movementInterrupted: false,
      usedNativeTruncation: false,
      usedRollbackFallback: false
    });
    return {
      interrupted: false,
      appliedStopPoint: null,
      usedNativeTruncation: false,
      usedRollbackFallback: false
    };
  }

  const applyFallbackUpdate = async () => {
    await tokenDocument.update({
      x: stopState.position.x,
      y: stopState.position.y,
      elevation: stopState.elevation
    }, {
      animate: false,
      [MODULE_ID]: {
        internalStopMovement: true
      }
    });
  };

  markHandledMovementInterruption(tokenDocument, movementSequenceId, stopDecision, {
    stopPoint,
    usedRollbackFallback: false
  });

  try {
    const initialAnimationPromise =
      tokenDocument?.rendered &&
      typeof tokenDocument?.object?.movementAnimationPromise?.then === "function"
        ? tokenDocument.object.movementAnimationPromise
        : null;

    tokenDocument.stopMovement?.();
    await wait(0);

    let settledState = snapshotTokenState(tokenDocument);
    if (!isStateNearStopState(settledState, stopState)) {
      settledState = await awaitMovementStopSettlement(tokenDocument, initialAnimationPromise);
    }

    if (isStateNearStopState(settledState, stopState)) {
      const appliedStopPoint = buildSimplePositionPayload(settledState);

      debug("Applied managed Region movement stop.", {
        movementSequenceId,
        tokenId: tokenDocument?.id ?? null,
        regionId: stopDecision?.regionId ?? null,
        moveSource,
        trigger: stopDecision?.trigger ?? null,
        originalFrom: buildSimplePositionPayload(originalFromState),
        originalTo: buildSimplePositionPayload(originalToState),
        stopReason,
        stopMode,
        firstInsideCell,
        selectedStopPoint: stopPoint,
        appliedStopPoint,
        finalTokenPosition: buildSimplePositionPayload(settledState),
        onMoveThresholdPoint,
        interruptionApplied: true,
        interruptionSkippedBecauseAlreadyHandled: false,
        movementInterrupted: true,
        usedNativeTruncation: true,
        usedRollbackFallback: false
      });

      return {
        interrupted: true,
        appliedStopPoint,
        usedNativeTruncation: true,
        usedRollbackFallback: false
      };
    }

    const movementReachedOriginalDestinationBeforeFallback =
      originalDestination !== null &&
      stateMatchesStopDestination(settledState, originalDestination);

    markHandledMovementInterruption(tokenDocument, movementSequenceId, stopDecision, {
      stopPoint,
      usedRollbackFallback: true
    });

    tokenDocument.stopMovement?.();
    await wait(0);
    await applyFallbackUpdate();

    const finalState = snapshotTokenState(tokenDocument);
    const appliedStopPoint = buildSimplePositionPayload(finalState);

    debug("Applied managed Region movement stop.", {
      movementSequenceId,
      tokenId: tokenDocument?.id ?? null,
      regionId: stopDecision?.regionId ?? null,
      moveSource,
      trigger: stopDecision?.trigger ?? null,
      originalFrom: buildSimplePositionPayload(originalFromState),
      originalTo: buildSimplePositionPayload(originalToState),
      stopReason,
      stopMode,
      firstInsideCell,
      selectedStopPoint: stopPoint,
      appliedStopPoint,
      finalTokenPosition: buildSimplePositionPayload(finalState),
      onMoveThresholdPoint,
      interruptionApplied: true,
      interruptionSkippedBecauseAlreadyHandled: false,
      movementInterrupted: true,
      usedNativeTruncation: false,
      usedRollbackFallback: true,
      rollbackAfterDestinationReached: movementReachedOriginalDestinationBeforeFallback
    });

    return {
      interrupted: true,
      appliedStopPoint,
      usedNativeTruncation: false,
      usedRollbackFallback: true
    };
  } catch (caughtError) {
    debug("Managed Region movement stop failed.", {
      movementSequenceId,
      tokenId: tokenDocument?.id ?? null,
      regionId: stopDecision?.regionId ?? null,
      moveSource,
      trigger: stopDecision?.trigger ?? null,
      originalFrom: buildSimplePositionPayload(originalFromState),
      originalTo: buildSimplePositionPayload(originalToState),
      stopReason,
      stopMode,
      firstInsideCell,
      selectedStopPoint: stopPoint,
      appliedStopPoint: null,
      finalTokenPosition: buildSimplePositionPayload(snapshotTokenState(tokenDocument)),
      onMoveThresholdPoint,
      interruptionApplied: false,
      interruptionSkippedBecauseAlreadyHandled: false,
      movementInterrupted: false,
      usedNativeTruncation: false,
      usedRollbackFallback: true,
      error: caughtError?.message ?? "unknown"
    });
    deleteHandledMovementInterruption(tokenDocument, movementSequenceId);

    return {
      interrupted: false,
      appliedStopPoint: null,
      usedNativeTruncation: false,
      usedRollbackFallback: true
    };
  }
}

async function awaitMovementStopSettlement(tokenDocument, initialAnimationPromise) {
  const movementAnimationPromise =
    initialAnimationPromise ??
    (tokenDocument?.rendered &&
    typeof tokenDocument?.object?.movementAnimationPromise?.then === "function"
      ? tokenDocument.object.movementAnimationPromise
      : null);

  if (movementAnimationPromise) {
    await Promise.race([
      movementAnimationPromise.catch(() => null),
      wait(MOVEMENT_STOP_SETTLE_TIMEOUT_MS)
    ]);
  } else {
    await wait(0);
  }

  return snapshotTokenState(tokenDocument);
}

function canInterruptMovement(moveSource, movement, tokenDocument, stopState = null) {
  if (!isInterruptibleMoveSource(moveSource)) {
    return false;
  }

  if (!movement) {
    return false;
  }

  if (stopState !== null && !stopState?.position) {
    return false;
  }

  return Boolean(
    typeof tokenDocument?.stopMovement === "function" &&
    (typeof tokenDocument?.move === "function" || typeof tokenDocument?.update === "function")
  );
}

function buildStopWaypoint(stopState) {
  return {
    x: stopState?.position?.x ?? 0,
    y: stopState?.position?.y ?? 0,
    elevation: stopState?.elevation ?? 0,
    width: stopState?.width ?? undefined,
    height: stopState?.height ?? undefined,
    shape: stopState?.shape ?? undefined
  };
}

function buildSimplePositionPayload(stateOrPoint) {
  const point = stateOrPoint?.position ?? stateOrPoint ?? null;
  if (!point) {
    return null;
  }

  return {
    x: roundDistanceValue(point.x, 2),
    y: roundDistanceValue(point.y, 2)
  };
}

function buildGridCellPayload(stateOrPoint) {
  const cell = getSquareGridCellCoordinates(stateOrPoint);
  const point = stateOrPoint?.position ?? stateOrPoint ?? null;
  if (!cell || !point) {
    return null;
  }

  return {
    row: cell.row,
    col: cell.col,
    x: roundDistanceValue(point.x, 2),
    y: roundDistanceValue(point.y, 2)
  };
}

function areGridCellsEqual(leftCell, rightCell) {
  if (!leftCell || !rightCell) {
    return false;
  }

  return leftCell.row === rightCell.row && leftCell.col === rightCell.col;
}

function buildStopPointPayload(stopState) {
  if (!stopState) {
    return null;
  }

  return {
    x: roundDistanceValue(stopState.position?.x, 2),
    y: roundDistanceValue(stopState.position?.y, 2),
    centerX: roundDistanceValue(stopState.center?.x, 2),
    centerY: roundDistanceValue(stopState.center?.y, 2)
  };
}

function isStateNearStopState(state, stopState) {
  const positionTolerance = Math.max(8, Math.min(coerceNumber(canvas?.grid?.size, 100) / 5, 20));

  return compareNumbersWithinTolerance(state?.position?.x, stopState?.position?.x, positionTolerance) &&
    compareNumbersWithinTolerance(state?.position?.y, stopState?.position?.y, positionTolerance) &&
    compareNumbersWithinTolerance(state?.width, stopState?.width, 1) &&
    compareNumbersWithinTolerance(state?.height, stopState?.height, 1) &&
    compareNumbersWithinTolerance(state?.elevation, stopState?.elevation, 0.5);
}

function duplicateStopState(stopState) {
  return {
    position: {
      x: stopState?.position?.x ?? 0,
      y: stopState?.position?.y ?? 0
    },
    width: stopState?.width ?? 1,
    height: stopState?.height ?? 1,
    elevation: stopState?.elevation ?? 0,
    shape: stopState?.shape ?? null,
    center: stopState?.center ?? getTokenCenter({
      x: stopState?.position?.x ?? 0,
      y: stopState?.position?.y ?? 0,
      width: stopState?.width ?? 1,
      height: stopState?.height ?? 1
    })
  };
}

function markInternalStopDestination(tokenDocument, stopState) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid || !stopState?.position) {
    return;
  }

  cleanupExpiredInternalStopDestinations();
  internalStopDestinations.set(tokenUuid, {
    x: coerceNumber(stopState.position.x, 0),
    y: coerceNumber(stopState.position.y, 0),
    width: coerceNumber(stopState.width, 1),
    height: coerceNumber(stopState.height, 1),
    elevation: coerceNumber(stopState.elevation, 0),
    expiresAt: Date.now() + INTERNAL_STOP_TTL_MS
  });
}

function consumeInternalStopDestinationIfMatched(tokenDocument, toState) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid) {
    return false;
  }

  cleanupExpiredInternalStopDestinations();
  const destination = internalStopDestinations.get(tokenUuid);
  if (!destination) {
    return false;
  }

  if (!stateMatchesStopDestination(toState, destination)) {
    return false;
  }

  internalStopDestinations.delete(tokenUuid);
  return true;
}

function cleanupExpiredInternalStopDestinations() {
  const now = Date.now();

  for (const [tokenUuid, destination] of internalStopDestinations.entries()) {
    if ((destination?.expiresAt ?? 0) <= now) {
      internalStopDestinations.delete(tokenUuid);
    }
  }
}

function stateMatchesStopDestination(state, destination) {
  return compareNumbersWithinTolerance(state?.position?.x, destination?.x) &&
    compareNumbersWithinTolerance(state?.position?.y, destination?.y) &&
    compareNumbersWithinTolerance(state?.width, destination?.width) &&
    compareNumbersWithinTolerance(state?.height, destination?.height) &&
    compareNumbersWithinTolerance(state?.elevation, destination?.elevation, 0.5);
}

function compareNumbersWithinTolerance(left, right, tolerance = 1) {
  return Math.abs(coerceNumber(left, 0) - coerceNumber(right, 0)) <= tolerance;
}

function isInterruptibleMoveSource(moveSource) {
  return typeof moveSource === "string" && moveSource.startsWith("moveToken");
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
  return checkMovementTriggerDedup(
    kind,
    regionDocument,
    tokenDocument,
    moveSource,
    afterCenter,
    { record: true }
  );
}

function checkMovementTriggerDedup(kind, regionDocument, tokenDocument, moveSource, afterCenter, {
  record = true
} = {}) {
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
  if (record) {
    store.set(key, now);
  }

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

function hasTranslationChange(changed) {
  return Object.prototype.hasOwnProperty.call(changed ?? {}, "x") ||
    Object.prototype.hasOwnProperty.call(changed ?? {}, "y");
}

function refreshTrackedTokenStates(scene) {
  lastKnownTokenStates.clear();
  regionInsideStates.clear();
  recentEnterEvents.clear();
  recentExitEvents.clear();
  recentOnMoveEvents.clear();
  recentMoveTokenEvents.clear();
  queuedMovementModes.clear();
  internalStopDestinations.clear();
  handledMovementInterruptions.clear();

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

function buildMovementSequenceId(tokenDocument, movement, movementPath) {
  cleanupExpiredHandledMovementInterruptions();

  const points = compactMovementPoints([
    movement?.origin,
    ...(Array.isArray(movement?.history?.waypoints) ? movement.history.waypoints : []),
    ...(Array.isArray(movement?.pending?.waypoints) ? movement.pending.waypoints : []),
    ...(Array.isArray(movement?.waypoints) ? movement.waypoints : []),
    movement?.destination,
    movementPath?.toState?.position
  ]);

  if (!points.length) {
    return `${tokenDocument?.uuid ?? tokenDocument?.id ?? "token"}|unknown`;
  }

  const pointKey = points
    .map((point) => [
      Math.round(coerceNumber(point?.x, 0)),
      Math.round(coerceNumber(point?.y, 0)),
      Math.round(coerceNumber(point?.elevation, 0))
    ].join(":"))
    .join(">");

  return `${tokenDocument?.uuid ?? tokenDocument?.id ?? "token"}|${pointKey}`;
}

function getHandledMovementInterruption(tokenDocument, movementSequenceId) {
  const key = buildHandledMovementInterruptionKey(tokenDocument, movementSequenceId);
  if (!key) {
    return null;
  }

  cleanupExpiredHandledMovementInterruptions();
  return handledMovementInterruptions.get(key) ?? null;
}

function markHandledMovementInterruption(tokenDocument, movementSequenceId, stopDecision, {
  stopPoint = null,
  usedRollbackFallback = false
} = {}) {
  const key = buildHandledMovementInterruptionKey(tokenDocument, movementSequenceId);
  if (!key || !stopDecision) {
    return;
  }

  handledMovementInterruptions.set(key, {
    regionId: stopDecision.regionId ?? null,
    trigger: stopDecision.trigger ?? null,
    stopReason: stopDecision.stopReason ?? null,
    stopMode: stopDecision.stopMode ?? "sampled-fallback",
    firstInsideCell: buildGridCellPayload(stopDecision.firstInsideCellState),
    stopPoint: stopPoint ?? buildStopPointPayload(stopDecision.stopState),
    onMoveThresholdPoint: buildSimplePositionPayload(stopDecision.onMoveThresholdState),
    stopState: duplicateStopState(stopDecision.stopState),
    usedRollbackFallback,
    expiresAt: Date.now() + MOVEMENT_SEQUENCE_TTL_MS
  });
}

function deleteHandledMovementInterruption(tokenDocument, movementSequenceId) {
  const key = buildHandledMovementInterruptionKey(tokenDocument, movementSequenceId);
  if (!key) {
    return;
  }

  handledMovementInterruptions.delete(key);
}

function buildHandledMovementInterruptionKey(tokenDocument, movementSequenceId) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid || !movementSequenceId) {
    return null;
  }

  return `${tokenUuid}|${movementSequenceId}`;
}

function cleanupExpiredHandledMovementInterruptions() {
  const now = Date.now();

  for (const [key, interruption] of handledMovementInterruptions.entries()) {
    if ((interruption?.expiresAt ?? 0) <= now) {
      handledMovementInterruptions.delete(key);
    }
  }
}

function recordPendingPreUpdateGridStop(tokenDocument, stopDecision, {
  originalFromState = null,
  originalToState = null
} = {}) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid || !stopDecision?.stopState?.position) {
    return;
  }

  cleanupExpiredPendingPreUpdateGridStops();
  pendingPreUpdateGridStops.set(tokenUuid, {
    ...stopDecision,
    originalFromState: originalFromState ? duplicateStopState(originalFromState) : null,
    originalToState: originalToState ? duplicateStopState(originalToState) : null,
    expiresAt: Date.now() + PENDING_PREUPDATE_GRID_STOP_TTL_MS
  });
}

function consumePendingPreUpdateGridStop(tokenDocument, toState) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid) {
    return null;
  }

  cleanupExpiredPendingPreUpdateGridStops();
  const pendingStop = pendingPreUpdateGridStops.get(tokenUuid) ?? null;
  if (!pendingStop) {
    return null;
  }

  if (!stateMatchesStopDestination(toState, {
    x: pendingStop.stopState?.position?.x,
    y: pendingStop.stopState?.position?.y,
    width: pendingStop.stopState?.width,
    height: pendingStop.stopState?.height,
    elevation: pendingStop.stopState?.elevation
  })) {
    return null;
  }

  pendingPreUpdateGridStops.delete(tokenUuid);
  return pendingStop;
}

function cleanupExpiredPendingPreUpdateGridStops() {
  const now = Date.now();

  for (const [tokenUuid, pendingStop] of pendingPreUpdateGridStops.entries()) {
    if ((pendingStop?.expiresAt ?? 0) <= now) {
      pendingPreUpdateGridStops.delete(tokenUuid);
    }
  }
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

function analyzeMovementAcrossRegion(tokenDocument, regionDocument, pathStates, fromInside, {
  stepDistancePixels = null
} = {}) {
  const states = compactStatePath(pathStates);
  if (!states.length) {
    return {
      crossedBoundary: false,
      sawEntry: false,
      sawExit: false,
      pathLengthPixels: 0,
      insideDistancePixels: 0,
      firstEntryState: null,
      firstEntryPathDistancePixels: null,
      firstEntrySegmentIndex: null,
      firstInsideCellState: null,
      firstInsideCellPathDistancePixels: null,
      firstInsideCellSegmentIndex: null,
      firstInsideStepState: null,
      firstInsideStepPathDistancePixels: null,
      firstInsideStepSegmentIndex: null,
      firstMoveTriggerState: null,
      firstMoveTriggerPathDistancePixels: null,
      firstMoveTriggerSegmentIndex: null
    };
  }

  let previousInside = Boolean(fromInside);
  let crossedBoundary = false;
  let sawEntry = false;
  let sawExit = false;
  let pathLengthPixels = 0;
  let insideDistancePixels = 0;
  let firstEntryState = null;
  let firstEntryPathDistancePixels = null;
  let firstEntrySegmentIndex = null;
  let firstInsideCellState = null;
  let firstInsideCellPathDistancePixels = null;
  let firstInsideCellSegmentIndex = null;
  let firstInsideStepState = null;
  let firstInsideStepPathDistancePixels = null;
  let firstInsideStepSegmentIndex = null;
  let firstMoveTriggerState = null;
  let firstMoveTriggerPathDistancePixels = null;
  let firstMoveTriggerSegmentIndex = null;
  let gridPathDistancePixels = 0;

  for (let index = 1; index < states.length; index += 1) {
    const gridTraversalStates = buildGridCellTraversalStates(states[index - 1], states[index]);
    let previousGridState = states[index - 1];

    for (const gridState of gridTraversalStates) {
      gridPathDistancePixels += measureStateDistance(previousGridState, gridState);
      const gridInside = testTokenInsideManagedRegion(tokenDocument, regionDocument, gridState);

      if (!firstInsideCellState && gridInside) {
        firstInsideCellState = gridState;
        firstInsideCellPathDistancePixels = gridPathDistancePixels;
        firstInsideCellSegmentIndex = index;
      }

      previousGridState = gridState;
    }

    const segmentSamples = sampleSegmentStates(states[index - 1], states[index]);
    let previousState = states[index - 1];

    for (const sampleState of segmentSamples) {
      const sampleInside = testTokenInsideManagedRegion(tokenDocument, regionDocument, sampleState);
      const segmentDistancePixels = measureStateDistance(previousState, sampleState);
      const previousInsideDistancePixels = insideDistancePixels;
      pathLengthPixels += segmentDistancePixels;
      insideDistancePixels += segmentDistancePixels * estimateInsideDistanceFactor(previousInside, sampleInside);

      if (!firstInsideStepState && sampleInside && segmentDistancePixels > 0) {
        firstInsideStepState = sampleState;
        firstInsideStepPathDistancePixels = pathLengthPixels;
        firstInsideStepSegmentIndex = index;
      }

      if (previousInside !== sampleInside) {
        crossedBoundary = true;
        if (!previousInside && sampleInside) {
          sawEntry = true;
          if (!firstEntryState) {
            firstEntryState = sampleState;
            firstEntryPathDistancePixels = pathLengthPixels;
            firstEntrySegmentIndex = index;
          }
        }
        if (previousInside && !sampleInside) {
          sawExit = true;
        }
      }

      if (
        !firstMoveTriggerState &&
        stepDistancePixels !== null &&
        stepDistancePixels > 0 &&
        previousInsideDistancePixels < stepDistancePixels &&
        insideDistancePixels >= stepDistancePixels
      ) {
        firstMoveTriggerState = sampleState;
        firstMoveTriggerPathDistancePixels = pathLengthPixels;
        firstMoveTriggerSegmentIndex = index;
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
    insideDistancePixels,
    firstEntryState,
    firstEntryPathDistancePixels,
    firstEntrySegmentIndex,
    firstInsideCellState,
    firstInsideCellPathDistancePixels,
    firstInsideCellSegmentIndex,
    firstInsideStepState,
    firstInsideStepPathDistancePixels,
    firstInsideStepSegmentIndex,
    firstMoveTriggerState,
    firstMoveTriggerPathDistancePixels,
    firstMoveTriggerSegmentIndex
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

function buildGridCellTraversalStates(fromState, toState) {
  if (!isSquareGridStopModeAvailable() || !fromState || !toState) {
    return [];
  }

  const fromCell = getSquareGridCellCoordinates(fromState);
  const toCell = getSquareGridCellCoordinates(toState);
  if (!fromCell || !toCell) {
    return [];
  }

  const steps = Math.max(
    Math.abs(toCell.row - fromCell.row),
    Math.abs(toCell.col - fromCell.col)
  );
  if (!steps) {
    return [];
  }

  const traversedStates = [];
  const seenCells = new Set();

  for (let step = 1; step <= steps; step += 1) {
    const alpha = step / steps;
    const row = Math.round(lerp(fromCell.row, toCell.row, alpha));
    const col = Math.round(lerp(fromCell.col, toCell.col, alpha));
    const key = `${row}:${col}`;
    if (seenCells.has(key)) {
      continue;
    }

    seenCells.add(key);
    traversedStates.push(buildStateAtSquareGridCell(fromState, toState, row, col, alpha));
  }

  return traversedStates;
}

function isSquareGridStopModeAvailable(scene = canvas?.scene ?? null) {
  const grid = canvas?.grid ?? null;
  return Boolean(
    grid &&
    !grid.isGridless &&
    grid.isSquare &&
    coerceNumber(scene?.grid?.size, coerceNumber(grid.size, 0)) > 0
  );
}

function getSquareGridCellCoordinates(stateOrPoint) {
  if (!isSquareGridStopModeAvailable()) {
    return null;
  }

  const point = stateOrPoint?.position ?? stateOrPoint ?? null;
  if (!point) {
    return null;
  }

  try {
    if (typeof canvas?.grid?.getOffset === "function") {
      const offset = canvas.grid.getOffset(point);
      const row = coerceNumber(offset?.i, coerceNumber(offset?.y, null));
      const col = coerceNumber(offset?.j, coerceNumber(offset?.x, null));
      if (row !== null && col !== null) {
        return { row, col };
      }
    }
  } catch {
    // Fall back to raw square-grid math below.
  }

  const gridSize = Math.max(coerceNumber(canvas?.grid?.size, 100), 1);
  return {
    row: Math.floor(coerceNumber(point.y, 0) / gridSize),
    col: Math.floor(coerceNumber(point.x, 0) / gridSize)
  };
}

function buildStateAtSquareGridCell(fromState, toState, row, col, alpha = 1) {
  const gridSize = Math.max(coerceNumber(canvas?.grid?.size, 100), 1);
  let x = col * gridSize;
  let y = row * gridSize;

  try {
    if (typeof canvas?.grid?.getCenterPoint === "function") {
      const centerPoint = canvas.grid.getCenterPoint({ i: row, j: col });
      if (centerPoint) {
        x = coerceNumber(centerPoint.x, x + (gridSize / 2)) - (gridSize / 2);
        y = coerceNumber(centerPoint.y, y + (gridSize / 2)) - (gridSize / 2);
      }
    }
  } catch {
    // Keep the computed square-grid top-left fallback.
  }

  const width = lerp(coerceNumber(fromState?.width, 1), coerceNumber(toState?.width, 1), alpha);
  const height = lerp(coerceNumber(fromState?.height, 1), coerceNumber(toState?.height, 1), alpha);

  return {
    position: { x, y },
    width,
    height,
    elevation: lerp(coerceNumber(fromState?.elevation, 0), coerceNumber(toState?.elevation, 0), alpha),
    shape: alpha < 1 ? fromState?.shape ?? null : toState?.shape ?? fromState?.shape ?? null,
    center: getTokenCenter({ x, y, width, height })
  };
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

function clearHandledMovementInterruptionsForToken(tokenDocument) {
  const tokenKey = tokenDocument?.uuid ?? tokenDocument?.id ?? null;
  if (!tokenKey) {
    return;
  }

  const prefix = `${tokenKey}|`;
  for (const key of handledMovementInterruptions.keys()) {
    if (key.startsWith(prefix)) {
      handledMovementInterruptions.delete(key);
    }
  }
}

function isDuplicateOnMoveTrigger(regionDocument, tokenDocument, moveSource, fromState, toState, triggerCount, insideDistance) {
  return checkOnMoveTriggerDedup(
    regionDocument,
    tokenDocument,
    moveSource,
    fromState,
    toState,
    triggerCount,
    insideDistance,
    { record: true }
  );
}

function checkOnMoveTriggerDedup(regionDocument, tokenDocument, moveSource, fromState, toState, triggerCount, insideDistance, {
  record = true
} = {}) {
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
  if (record) {
    recentOnMoveEvents.set(key, now);
  }

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
