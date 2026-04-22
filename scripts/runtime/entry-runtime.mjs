import { ENTRY_DEDUP_TTL_MS, MODULE_ID } from "../constants.mjs";
import { applyConfiguredTriggerEffect } from "./entry-effects.mjs";
import {
  coerceNumber,
  debug,
  distanceToPixels,
  evaluateManagedRegionTargetFilter,
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
const pendingEnterStops = new Map();
const appliedEnterStops = new Map();
const preAppliedEnterStopDestinations = new Map();
const internalStopDestinations = new Map();
const handledMovementInterruptions = new Map();
const pendingPreUpdateGridStops = new Map();

let hooksRegistered = false;
const INTERNAL_STOP_TTL_MS = 3000;
const MOVEMENT_SEQUENCE_TTL_MS = 5000;
const MANAGED_REGION_ENTER_STOP_TTL_MS = 5000;
const MOVEMENT_STOP_SETTLE_TIMEOUT_MS = 100;
const CONTROLLED_STOP_ANIMATION_SETTLE_TIMEOUT_MS = 1000;
const PENDING_PREUPDATE_GRID_STOP_TTL_MS = 3000;

export function registerEntryRuntimeHooks() {
  if (hooksRegistered) {
    return;
  }

  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("preUpdateToken", onPreUpdateToken);
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

  if (!hasTranslationChange(changed)) {
    return;
  }

  const scene = tokenDocument?.parent ?? null;
  if (!scene) {
    return;
  }

  const isInternalUpdate = Boolean(options?.[MODULE_ID]?.internalStopMovement);
  const fromState = snapshotTokenState(tokenDocument);
  const originalToState = snapshotTokenStateAtPosition(tokenDocument, {
    x: changed.x ?? tokenDocument.x,
    y: changed.y ?? tokenDocument.y,
    width: changed.width ?? tokenDocument.width,
    height: changed.height ?? tokenDocument.height,
    elevation: changed.elevation ?? tokenDocument.elevation,
    shape: changed.shape ?? tokenDocument.shape
  });

  if (stateMatchesStopDestination(originalToState, {
    x: fromState.position.x,
    y: fromState.position.y,
    width: fromState.width,
    height: fromState.height,
    elevation: fromState.elevation
  })) {
    return;
  }

  const managedRegions = findManagedRegions(scene);
  if (!managedRegions.length) {
    return;
  }

  const movementSequenceId = buildMovementSequenceIdFromStates(tokenDocument, [fromState, originalToState]);
  const movementResolution = resolveMovementModeForEvaluation(tokenDocument, {
    moveSource: "preUpdateToken-diagnostic",
    consume: false
  });

  const evaluations = collectRegionEvaluations(tokenDocument, managedRegions, {
    scene,
    moveSource: "preUpdateToken-diagnostic",
    fromState,
    toState: originalToState,
    pathStates: compactStatePath([fromState, originalToState]),
    movementMode: movementResolution.resolvedMovementMode
  });
  const eligibleStopEvaluation = evaluations.find((evaluation) => {
    return Boolean(
      evaluation?.normalizedDefinition?.enabled &&
      evaluation?.filterResult?.allowed &&
      evaluation?.onEnter?.enabled &&
      evaluation?.onEnter?.stopMovementOnTrigger
    );
  });
  const candidateEvaluation = evaluations.find((evaluation) => {
    return Boolean(
      evaluation?.normalizedDefinition?.enabled &&
      evaluation?.filterResult?.allowed &&
      evaluation?.onEnter?.enabled &&
      evaluation?.onEnter?.stopMovementOnTrigger &&
      evaluation?.enterDetected
    );
  });
  const candidateWouldEnterRegion = Boolean(candidateEvaluation);
  const sourceLikelyPlayerDrag = isLikelyPlayerDragPreUpdate(tokenDocument, changed, options);
  const whyNoTruncationCandidate = candidateWouldEnterRegion
    ? null
    : !eligibleStopEvaluation
      ? "no-eligible-onenter-stop"
      : explainPreUpdateOnEnterTruncationFailure(eligibleStopEvaluation);

  debug("Observed managed Region preUpdate diagnostic.", {
    tokenUuid: tokenDocument?.uuid ?? null,
    "changed.x": changed?.x ?? null,
    "changed.y": changed?.y ?? null,
    changedX: changed?.x ?? null,
    changedY: changed?.y ?? null,
    isInternalUpdate,
    movementSequenceId,
    regionId: candidateEvaluation?.regionDocument?.id ?? eligibleStopEvaluation?.regionDocument?.id ?? null,
    candidateWouldEnterRegion,
    sourceLikelyPlayerDrag,
    whyNoTruncationCandidate,
    preUpdateFrom: buildSimplePositionPayload(fromState),
    preUpdateTo: buildSimplePositionPayload(originalToState),
    matchedEntryPoint: buildSimplePositionPayload(
      candidateEvaluation?.movementAnalysis?.firstEntryState ??
      eligibleStopEvaluation?.movementAnalysis?.firstEntryState
    ),
    matchedEntryCell: buildGridCellPayload(
      candidateEvaluation?.movementAnalysis?.firstInsideCellState ??
      eligibleStopEvaluation?.movementAnalysis?.firstInsideCellState
    ),
    plannedStopAvailable: false,
    truncatedDestinationApplied: false,
    originalTo: buildSimplePositionPayload(originalToState),
    truncatedTo: null
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
      plannedStopAvailable: evaluation.plannedStopAvailable ?? false,
      truncatedDestinationApplied: evaluation.truncatedDestinationApplied ?? false,
      originalFrom: buildSimplePositionPayload(movementPath.fromState),
      originalTo: buildSimplePositionPayload(movementPath.toState),
      truncatedTo: evaluation.truncatedTo ?? null,
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
      usedSnapFallback: evaluation.usedSnapFallback ?? false,
      animationRedirected: evaluation.animationRedirected ?? false,
      animationRestartedToStop: evaluation.animationRestartedToStop ?? false,
      usedTeleportFallback: evaluation.usedTeleportFallback ?? false,
      usedNativeTruncation: evaluation.usedNativeTruncation ?? false,
      usedRollbackFallback: evaluation.usedRollbackFallback ?? false
    });
  }

  cleanupManagedRegionOnEnterStopPlansForSequence(tokenDocument, movementSequenceId, {
    reason: "sequence-complete"
  });
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
  clearManagedRegionOnEnterStopStateForToken(tokenDocument);
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
  let plannedStopAvailable = false;
  let truncatedDestinationApplied = false;
  let truncatedTo = null;
  let usedSnapFallback = false;

  planManagedRegionOnEnterStops(tokenDocument, initialEvaluations, {
    movementSequenceId,
    moveSource,
    movementMode
  });
  const consumedEnterStopPlans = consumeManagedRegionOnEnterStopPlans(tokenDocument, movementSequenceId);
  const plannedEnterStopDecision = buildManagedRegionOnEnterStopDecision(consumedEnterStopPlans);
  if (plannedEnterStopDecision) {
    plannedStopAvailable = true;
    truncatedDestinationApplied = false;
    truncatedTo = buildSimplePositionPayload(plannedEnterStopDecision.stopState);
    usedSnapFallback = plannedEnterStopDecision.stopMode === "grid-cell";

    debug("Skipped managed Region onEnter stop because stop application is temporarily disabled.", {
      movementSequenceId,
      tokenId: tokenDocument?.id ?? null,
      regionId: plannedEnterStopDecision.regionId ?? null,
      moveSource,
      movementMode,
      trigger: "onEnter",
      stopSupported: false,
      plannedStopAvailable: true,
      truncatedDestinationApplied: false,
      selectedStopPoint: plannedEnterStopDecision.selectedStopPoint ?? null,
      truncatedTo
    });
  }
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
  let animationRedirected = false;
  let animationRestartedToStop = false;
  let usedTeleportFallback = false;

  if (stopDecision) {
    interruptionAttempted = true;
    selectedStopPoint = buildSimplePositionPayload(stopDecision.stopState);
    stopReason = stopDecision.stopReason ?? null;
    stopMode = stopDecision.stopMode ?? null;
    firstInsideCell = buildGridCellPayload(stopDecision.firstInsideCellState);
    onMoveThresholdPoint = buildSimplePositionPayload(stopDecision.onMoveThresholdState);
    const interruption = stopDecision.trigger === "onEnter" && stopDecision.planKey
      ? await applyManagedRegionOnEnterStopFromPlan({
        tokenDocument,
        movement,
        moveSource,
        movementSequenceId,
        originalFromState: fromState ?? basePathStates[0] ?? null,
        originalToState: toState ?? fallbackFinalState,
        stopDecision
      })
      : await interruptTokenMovementForTrigger({
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
    animationRedirected = interruption.animationRedirected ?? false;
    animationRestartedToStop = interruption.animationRestartedToStop ?? false;
    usedTeleportFallback = interruption.usedTeleportFallback ?? false;
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
    usedRollbackFallback,
    animationRedirected,
    animationRestartedToStop,
    usedTeleportFallback,
    plannedStopAvailable,
    truncatedDestinationApplied,
    truncatedTo,
    usedSnapFallback
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
    const stepMode = resolveOnMoveStepMode(onMove, scene);
    const cellStep = stepMode === "grid-cell"
      ? normalizeOnMoveCellStep(onMove.cellStep, 1)
      : null;
    const stepDistance = stepMode === "distance"
      ? coerceNumber(onMove.distanceStep, getDefaultOnMoveDistanceStep(scene))
      : null;
    const configuredStep = stepMode === "grid-cell" ? cellStep : stepDistance;
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
        insideCellCount: 0,
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
        firstMoveTriggerSegmentIndex: null,
        firstGridMoveTriggerState: null,
        firstGridMoveTriggerPathDistancePixels: null,
        firstGridMoveTriggerSegmentIndex: null
      }
      : analyzeMovementAcrossRegion(
        tokenDocument,
        regionDocument,
        states,
        fromInside,
        {
          stepDistancePixels,
          gridCellStep: cellStep
        }
      );
    const enterDetected = moveSource === "createToken"
      ? toInside
      : !fromInside && movementAnalysis.sawEntry;
    const exitDetected = moveSource === "createToken"
      ? false
      : fromInside && !toInside && movementAnalysis.sawExit;
    const pathLength = pixelsToDistance(movementAnalysis.pathLengthPixels, scene);
    const insideDistance = pixelsToDistance(movementAnalysis.insideDistancePixels, scene);
    const insideCellCount = movementAnalysis.insideCellCount ?? 0;
    const moveTriggerCount = calculateMoveTriggerCount({
      stepMode,
      insideDistance,
      stepDistance,
      insideCellCount,
      cellStep
    });
    const enterMovementModeMatched = movementModeMatches(movementMode, onEnter.movementMode);
    const exitMovementModeMatched = movementModeMatches(movementMode, onExit.movementMode);
    const moveMovementModeMatched = movementModeMatches(movementMode, onMove.movementMode);
    const filterResult = shouldAffectToken(tokenDocument, regionDocument, normalizedDefinition);

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
      insideCellCount,
      stepMode,
      configuredStep,
      cellStep,
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
    insideCellCount,
    stepMode,
    configuredStep,
    cellStep,
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
    : buildSimplePositionPayload(
      stepMode === "grid-cell"
        ? movementAnalysis.firstGridMoveTriggerState ?? movementAnalysis.firstInsideCellState
        : movementAnalysis.firstMoveTriggerState
    );

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
      stepMode,
      configuredStep: roundDistanceValue(configuredStep),
      computedSteps: moveTriggerCount,
      pathLength: roundDistanceValue(pathLength),
      insideDistance: roundDistanceValue(insideDistance),
      insideCellCount,
      stepDistance: roundDistanceValue(stepDistance),
      triggerCount: moveTriggerCount
    });
  }

  if (enterDetected || exitDetected || moveTriggerCount > 0) {
    if (!filterResult.allowed) {
      debug("Skipped managed Region effect because target filter rejected the token.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        targetFilter: filterResult.targetFilter,
        targetMatched: filterResult.targetMatched,
        sourceActorUuid: filterResult.sourceActorUuid ?? null,
        sourceTokenId: filterResult.sourceTokenId ?? null,
        sourceDisposition: filterResult.sourceDisposition ?? null,
        targetActorUuid: filterResult.targetActorUuid ?? null,
        targetDisposition: filterResult.targetDisposition ?? null,
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
        stepMode,
        configuredStep,
        insideCellCount,
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
    targetFilter: filterResult.targetFilter,
    targetMatched: filterResult.targetMatched,
    sourceActorUuid: filterResult.sourceActorUuid ?? null,
    sourceTokenId: filterResult.sourceTokenId ?? null,
    sourceDisposition: filterResult.sourceDisposition ?? null,
    targetActorUuid: filterResult.targetActorUuid ?? null,
    targetDisposition: filterResult.targetDisposition ?? null,
    moveStepMode: stepMode,
    moveConfiguredStep: roundDistanceValue(configuredStep),
    moveInsideCellCount: insideCellCount,
    computedSteps: moveTriggerCount,
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
  stepMode,
  configuredStep,
  insideCellCount,
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
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const partId =
    runtime?.partId ??
    runtime?.part?.id ??
    runtime?.normalizedDefinition?.part?.id ??
    null;
  const triggerTiming = "onMove";
  const triggerMode = String(onMove?.mode ?? "none");
  const selectedActivity =
    onMove?.activity?.id ??
    onMove?.activityId ??
    null;

  if (moveTriggerCount <= 0) {
    return false;
  }

  const effectiveTriggerCount = moveTriggerCount;

  if (!onMove.enabled) {
    if (triggerMode === "none") {
      debug("Skipped managed Region onMove effect because mode = none.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        partId,
        triggerTiming,
        triggerMode,
        selectedActivity,
        stepMode,
        configuredStep: roundDistanceValue(configuredStep),
        computedSteps: effectiveTriggerCount,
        moveSource,
        pathLength: roundDistanceValue(pathLength),
        insideDistance: roundDistanceValue(insideDistance),
        insideCellCount,
        stepDistance: roundDistanceValue(stepDistance),
        triggerCount: effectiveTriggerCount
      });
    } else {
      debug("Skipped managed Region effect because onMove is disabled.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        partId,
        triggerTiming,
        triggerMode,
        selectedActivity,
        stepMode,
        configuredStep: roundDistanceValue(configuredStep),
        computedSteps: effectiveTriggerCount,
        moveSource,
        pathLength: roundDistanceValue(pathLength),
        insideDistance: roundDistanceValue(insideDistance),
        insideCellCount,
        stepDistance: roundDistanceValue(stepDistance),
        triggerCount: effectiveTriggerCount
      });
    }
    return false;
  }

  if (!moveMovementModeMatched) {
    debug("Skipped managed Region effect because movement mode did not match.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      partId,
      trigger: "onMove",
      triggerTiming,
      triggerMode,
      selectedActivity,
      stepMode,
      configuredStep: roundDistanceValue(configuredStep),
      computedSteps: effectiveTriggerCount,
      moveSource,
      movementMode,
      requiredMovementMode: onMove.movementMode ?? "any",
      movementModeMatched: false,
      pathLength: roundDistanceValue(pathLength),
      insideDistance: roundDistanceValue(insideDistance),
      insideCellCount,
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
    insideDistance,
    {
      stepMode,
      configuredStep,
      insideCellCount
    }
  )) {
    debug("Skipped managed Region effect because the onMove trigger was deduplicated.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      partId,
      triggerTiming,
      triggerMode,
      selectedActivity,
      stepMode,
      configuredStep: roundDistanceValue(configuredStep),
      computedSteps: effectiveTriggerCount,
      moveSource,
      pathLength: roundDistanceValue(pathLength),
      insideDistance: roundDistanceValue(insideDistance),
      insideCellCount,
      stepDistance: roundDistanceValue(stepDistance),
      triggerCount: effectiveTriggerCount
    });
    return false;
  }

  let appliedCount = 0;
  let activityFound = null;
  let activityTriggered = false;
  let simpleEffectApplied = false;

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

    if (application.activityFound !== undefined) {
      activityFound = application.activityFound;
    }

    if (application.activityTriggered === true) {
      activityTriggered = true;
    }

    if (triggerMode === "simple" && application.applied && !application.skipped) {
      simpleEffectApplied = true;
    }
  }

  debug("Managed Region onMove effect completed.", {
    tokenId: tokenDocument.id,
    regionId: regionDocument.id,
    partId,
    triggerTiming,
    triggerMode,
    selectedActivity,
    stepMode,
    configuredStep: roundDistanceValue(configuredStep),
    computedSteps: effectiveTriggerCount,
    moveSource,
    movementMode,
    requiredMovementMode: onMove.movementMode ?? "any",
    movementModeMatched: true,
    stopMovementOnTrigger: onMove.stopMovementOnTrigger ?? false,
    stopPoint,
    stopReason: stopHandledByRegion ? stopDecision?.stopReason ?? null : null,
    onMoveThresholdPoint,
    movementInterrupted: stopHandledByRegion && stopDecision.trigger === "onMove",
    activityFound,
    activityTriggered,
    simpleEffectApplied,
    pathLength: roundDistanceValue(pathLength),
    insideDistance: roundDistanceValue(insideDistance),
    insideCellCount,
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
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const partId =
    runtime?.partId ??
    runtime?.part?.id ??
    runtime?.normalizedDefinition?.part?.id ??
    null;
  const triggerTiming = "onExit";
  const triggerMode = String(onExit?.mode ?? "none");
  const selectedActivity =
    onExit?.activity?.id ??
    onExit?.activityId ??
    null;

  if (!exitDetected) {
    return false;
  }

  if (!onExit.enabled) {
    if (triggerMode === "none") {
      debug("Skipped managed Region onExit effect because mode = none.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        partId,
        triggerTiming,
        triggerMode,
        selectedActivity
      });
    } else {
      debug("Skipped managed Region effect because onExit is disabled.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        partId,
        triggerTiming,
        triggerMode,
        selectedActivity
      });
    }
    return false;
  }

  if (!exitMovementModeMatched) {
    debug("Skipped managed Region effect because movement mode did not match.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      partId,
      trigger: "onExit",
      triggerTiming,
      triggerMode,
      selectedActivity,
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
      regionId: regionDocument.id,
      partId,
      triggerTiming,
      triggerMode,
      selectedActivity
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
    partId,
    triggerTiming,
    triggerMode,
    selectedActivity,
    moveSource,
    movementMode,
    requiredMovementMode: onExit.movementMode ?? "any",
    movementModeMatched: true,
    activityFound: application.activityFound ?? null,
    activityTriggered: application.activityTriggered ?? null,
    simpleEffectApplied:
      triggerMode === "simple"
        ? Boolean(application.applied && !application.skipped)
        : null,
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
      onMove,
      filterResult
    } = evaluation;

    if (!normalizedDefinition?.enabled || !filterResult.allowed) {
      continue;
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

function planManagedRegionOnEnterStops(tokenDocument, evaluations, {
  movementSequenceId,
  moveSource,
  movementMode
}) {
  if (!movementSequenceId || !isOnEnterStopPlanMoveSource(moveSource)) {
    return [];
  }

  cleanupExpiredManagedRegionOnEnterStopState();

  const plans = [];
  for (const evaluation of evaluations) {
    const plan = planManagedRegionOnEnterStop(tokenDocument, evaluation, {
      movementSequenceId,
      moveSource,
      movementMode
    });

    if (plan) {
      plans.push(plan);
    }
  }

  return plans;
}

function planManagedRegionOnEnterStop(tokenDocument, evaluation, {
  movementSequenceId,
  moveSource,
  movementMode
}) {
  const {
    regionDocument,
    normalizedDefinition,
    onEnter,
    filterResult,
    enterDetected,
    enterMovementModeMatched,
    movementAnalysis,
    fromState,
    toState
  } = evaluation;

  if (!movementSequenceId || !isOnEnterStopPlanMoveSource(moveSource)) {
    return null;
  }

  if (!normalizedDefinition?.enabled || !filterResult.allowed) {
    return null;
  }

  if (!enterDetected || !onEnter.enabled || !onEnter.stopMovementOnTrigger || !enterMovementModeMatched) {
    return null;
  }

  const entryPointState = movementAnalysis.firstEntryState ?? movementAnalysis.firstInsideCellState ?? null;
  const selectedStopState = movementAnalysis.firstInsideCellState ?? movementAnalysis.firstEntryState ?? null;
  if (!entryPointState || !selectedStopState) {
    return null;
  }

  const entryCenter = entryPointState.center ?? selectedStopState.center ?? toState?.center ?? null;
  if (
    checkMovementTriggerDedup(
      "enter",
      regionDocument,
      tokenDocument,
      moveSource,
      entryCenter,
      { record: false }
    )
  ) {
    return null;
  }

  const tokenUuid = tokenDocument?.uuid ?? null;
  const regionId = regionDocument?.id ?? regionDocument?.uuid ?? null;
  if (!tokenUuid || !regionId) {
    return null;
  }

  const key = buildManagedRegionOnEnterStopKey(tokenUuid, movementSequenceId, regionId);
  const alreadyApplied = appliedEnterStops.has(key);
  const plan = {
    key,
    tokenUuid,
    movementSequenceId,
    regionId,
    regionUuid: regionDocument?.uuid ?? null,
    moveSource,
    movementMode,
    fromState: duplicateStopState(fromState ?? selectedStopState),
    toState: duplicateStopState(toState ?? selectedStopState),
    entryPoint: buildSimplePositionPayload(entryPointState),
    entryCell: buildGridCellPayload(movementAnalysis.firstInsideCellState),
    firstInsideCellState: movementAnalysis.firstInsideCellState
      ? duplicateStopState(movementAnalysis.firstInsideCellState)
      : null,
    selectedStopPoint: buildStopPointPayload(selectedStopState),
    selectedStopState: duplicateStopState(selectedStopState),
    stopMode: movementAnalysis.firstInsideCellState ? "grid-cell" : "sampled-fallback",
    selectedPathDistancePixels: movementAnalysis.firstInsideCellState
      ? (movementAnalysis.firstInsideCellPathDistancePixels ?? 0)
      : (movementAnalysis.firstEntryPathDistancePixels ?? 0),
    segmentIndex: movementAnalysis.firstInsideCellState
      ? (movementAnalysis.firstInsideCellSegmentIndex ?? 1)
      : (movementAnalysis.firstEntrySegmentIndex ?? 1),
    plannedAt: Date.now(),
    expiresAt: Date.now() + MANAGED_REGION_ENTER_STOP_TTL_MS
  };

  if (!alreadyApplied) {
    pendingEnterStops.set(key, plan);
  }

  debug("Planned managed Region onEnter stop.", {
    tokenUuid,
    movementSequenceId,
    regionId,
    moveSource,
    movementMode,
    entryPoint: plan.entryPoint,
    entryCell: plan.entryCell,
    selectedStopPoint: plan.selectedStopPoint,
    alreadyApplied
  });

  return plan;
}

function consumeManagedRegionOnEnterStopPlans(tokenDocument, movementSequenceId) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid || !movementSequenceId) {
    return [];
  }

  cleanupExpiredManagedRegionOnEnterStopState();

  const plans = Array.from(pendingEnterStops.values())
    .filter((plan) => plan.tokenUuid === tokenUuid && plan.movementSequenceId === movementSequenceId);

  for (const plan of plans) {
    pendingEnterStops.delete(plan.key);

    const alreadyApplied = appliedEnterStops.has(plan.key);
    if (!alreadyApplied) {
      appliedEnterStops.set(plan.key, {
        ...plan,
        appliedAt: Date.now(),
        expiresAt: Date.now() + MANAGED_REGION_ENTER_STOP_TTL_MS
      });
    }

    plan.alreadyApplied = alreadyApplied;

    debug("Consumed managed Region onEnter stop plan.", {
      tokenUuid,
      movementSequenceId,
      regionId: plan.regionId ?? null,
      entryPoint: plan.entryPoint ?? null,
      entryCell: plan.entryCell ?? null,
      selectedStopPoint: plan.selectedStopPoint ?? null,
      alreadyApplied
    });
  }

  return plans;
}

function buildManagedRegionOnEnterStopDecision(consumedPlans = []) {
  if (!Array.isArray(consumedPlans) || !consumedPlans.length) {
    return null;
  }

  const selectedPlan = [...consumedPlans].sort((left, right) => {
    const distanceDelta = (left.selectedPathDistancePixels ?? 0) - (right.selectedPathDistancePixels ?? 0);
    if (distanceDelta !== 0) {
      return distanceDelta;
    }

    return String(left.regionId ?? "").localeCompare(String(right.regionId ?? ""));
  })[0];

  if (!selectedPlan?.selectedStopState?.position) {
    return null;
  }

  return {
    regionId: selectedPlan.regionId ?? null,
    regionUuid: selectedPlan.regionUuid ?? null,
    trigger: "onEnter",
    stopReason: "entry",
    stopMode: selectedPlan.stopMode ?? "sampled-fallback",
    firstInsideCellState: selectedPlan.firstInsideCellState ?? null,
    stopState: duplicateStopState(selectedPlan.selectedStopState),
    segmentIndex: selectedPlan.segmentIndex ?? 1,
    onMoveThresholdState: null,
    planKey: selectedPlan.key ?? null,
    entryPoint: selectedPlan.entryPoint ?? null,
    entryCell: selectedPlan.entryCell ?? null,
    selectedStopPoint: selectedPlan.selectedStopPoint ?? null,
    alreadyApplied: Boolean(selectedPlan.alreadyApplied)
  };
}

function markPreAppliedManagedRegionOnEnterStopDestination(tokenDocument, movementSequenceId, stopDecision, {
  originalFromState = null,
  originalToState = null
} = {}) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  const regionId = stopDecision?.regionId ?? null;
  const key = buildManagedRegionOnEnterStopKey(tokenUuid, movementSequenceId, regionId);
  if (!tokenUuid || !key || !stopDecision?.stopState?.position) {
    return null;
  }

  cleanupExpiredManagedRegionOnEnterStopState();
  const record = {
    key,
    tokenUuid,
    movementSequenceId,
    regionId,
    regionUuid: stopDecision?.regionUuid ?? null,
    trigger: "onEnter",
    stopReason: stopDecision?.stopReason ?? "entry",
    stopMode: stopDecision?.stopMode ?? "sampled-fallback",
    entryPoint: stopDecision?.entryPoint ?? null,
    entryCell: stopDecision?.entryCell ?? buildGridCellPayload(stopDecision?.firstInsideCellState),
    selectedStopPoint: stopDecision?.selectedStopPoint ?? buildStopPointPayload(stopDecision?.stopState),
    firstInsideCellState: stopDecision?.firstInsideCellState
      ? duplicateStopState(stopDecision.firstInsideCellState)
      : null,
    originalFromState: originalFromState ? duplicateStopState(originalFromState) : null,
    originalToState: originalToState ? duplicateStopState(originalToState) : null,
    truncatedToState: duplicateStopState(stopDecision.stopState),
    onMoveThresholdState: stopDecision?.onMoveThresholdState
      ? duplicateStopState(stopDecision.onMoveThresholdState)
      : null,
    segmentIndex: stopDecision?.segmentIndex ?? 1,
    plannedStopAvailable: true,
    truncatedDestinationApplied: true,
    expiresAt: Date.now() + MANAGED_REGION_ENTER_STOP_TTL_MS
  };

  preAppliedEnterStopDestinations.set(key, record);
  return record;
}

function consumePreAppliedManagedRegionOnEnterStopDestination(tokenDocument, toState, movementSequenceId = null) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid) {
    return null;
  }

  cleanupExpiredManagedRegionOnEnterStopState();

  for (const [key, record] of preAppliedEnterStopDestinations.entries()) {
    if (record.tokenUuid !== tokenUuid) {
      continue;
    }

    const destinationMatched = stateMatchesStopDestination(toState, record.truncatedToState);
    const sequenceMatched = Boolean(
      movementSequenceId &&
      record.movementSequenceId &&
      record.movementSequenceId === movementSequenceId
    );

    if (!destinationMatched && !sequenceMatched) {
      continue;
    }

    preAppliedEnterStopDestinations.delete(key);
    return record;
  }

  return null;
}

function buildManagedRegionOnEnterStopDecisionFromPreApplied(record) {
  if (!record?.truncatedToState?.position) {
    return null;
  }

  return {
    regionId: record.regionId ?? null,
    regionUuid: record.regionUuid ?? null,
    trigger: "onEnter",
    stopReason: record.stopReason ?? "entry",
    stopMode: record.stopMode ?? "sampled-fallback",
    firstInsideCellState: record.firstInsideCellState ?? null,
    stopState: duplicateStopState(record.truncatedToState),
    segmentIndex: record.segmentIndex ?? 1,
    onMoveThresholdState: record.onMoveThresholdState
      ? duplicateStopState(record.onMoveThresholdState)
      : null,
    planKey: record.key ?? null,
    entryPoint: record.entryPoint ?? null,
    entryCell: record.entryCell ?? null,
    selectedStopPoint: record.selectedStopPoint ?? buildStopPointPayload(record.truncatedToState),
    alreadyApplied: true,
    plannedStopAvailable: true,
    truncatedDestinationApplied: true,
    originalTo: buildSimplePositionPayload(record.originalToState),
    truncatedTo: buildSimplePositionPayload(record.truncatedToState),
    usedSnapFallback: record.stopMode === "grid-cell"
  };
}

function cleanupManagedRegionOnEnterStopPlansForSequence(tokenDocument, movementSequenceId, {
  reason = "sequence-complete"
} = {}) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid || !movementSequenceId) {
    return 0;
  }

  cleanupExpiredManagedRegionOnEnterStopState();

  let cleanupCount = 0;
  for (const [key, plan] of pendingEnterStops.entries()) {
    if (plan.tokenUuid !== tokenUuid || plan.movementSequenceId !== movementSequenceId) {
      continue;
    }

    pendingEnterStops.delete(key);
    cleanupCount += 1;

    debug("Cleaned up managed Region onEnter stop plan.", {
      tokenUuid,
      movementSequenceId,
      regionId: plan.regionId ?? null,
      entryPoint: plan.entryPoint ?? null,
      entryCell: plan.entryCell ?? null,
      selectedStopPoint: plan.selectedStopPoint ?? null,
      alreadyApplied: appliedEnterStops.has(key),
      reason
    });
  }

  for (const [key, plan] of appliedEnterStops.entries()) {
    if (plan.tokenUuid !== tokenUuid || plan.movementSequenceId !== movementSequenceId) {
      continue;
    }

    appliedEnterStops.delete(key);
    cleanupCount += 1;

    debug("Cleaned up managed Region onEnter stop plan.", {
      tokenUuid,
      movementSequenceId,
      regionId: plan.regionId ?? null,
      entryPoint: plan.entryPoint ?? null,
      entryCell: plan.entryCell ?? null,
      selectedStopPoint: plan.selectedStopPoint ?? null,
      alreadyApplied: true,
      reason
    });
  }

  for (const [key, record] of preAppliedEnterStopDestinations.entries()) {
    if (record.tokenUuid !== tokenUuid || record.movementSequenceId !== movementSequenceId) {
      continue;
    }

    preAppliedEnterStopDestinations.delete(key);
    cleanupCount += 1;

    debug("Cleaned up managed Region onEnter stop plan.", {
      tokenUuid,
      movementSequenceId,
      regionId: record.regionId ?? null,
      entryPoint: record.entryPoint ?? null,
      entryCell: record.entryCell ?? null,
      selectedStopPoint: record.selectedStopPoint ?? null,
      alreadyApplied: true,
      reason
    });
  }

  return cleanupCount;
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
      animationRedirected: false,
      animationRestartedToStop: false,
      usedTeleportFallback: false,
      usedNativeTruncation: false,
      usedRollbackFallback: false
    });
    return {
      interrupted: false,
      appliedStopPoint: null,
      animationRedirected: false,
      animationRestartedToStop: false,
      usedTeleportFallback: false,
      usedNativeTruncation: false,
      usedRollbackFallback: false
    };
  }

  const applyAnimatedStopUpdate = async () => {
    markInternalStopDestination(tokenDocument, stopState);
    await tokenDocument.update({
      x: stopState.position.x,
      y: stopState.position.y,
      elevation: stopState.elevation
    }, {
      animate: true,
      [MODULE_ID]: {
        internalStopMovement: true
      }
    });
  };

  const applyTeleportFallbackUpdate = async () => {
    markInternalStopDestination(tokenDocument, stopState);
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
        animationRedirected: true,
        animationRestartedToStop: false,
        usedTeleportFallback: false,
        usedNativeTruncation: true,
        usedRollbackFallback: false
      });

      return {
        interrupted: true,
        appliedStopPoint,
        animationRedirected: true,
        animationRestartedToStop: false,
        usedTeleportFallback: false,
        usedNativeTruncation: true,
        usedRollbackFallback: false
      };
    }

    const movementReachedOriginalDestinationBeforeFallback =
      originalDestination !== null &&
      stateMatchesStopDestination(settledState, originalDestination);

    markHandledMovementInterruption(tokenDocument, movementSequenceId, stopDecision, {
      stopPoint,
      usedRollbackFallback: false
    });

    tokenDocument.stopMovement?.();
    await wait(0);
    await applyAnimatedStopUpdate();

    const animatedState = await awaitControlledStopAnimationSettlement(tokenDocument);
    if (isStateNearStopState(animatedState, stopState)) {
      const appliedStopPoint = buildSimplePositionPayload(animatedState);

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
        finalTokenPosition: buildSimplePositionPayload(animatedState),
        onMoveThresholdPoint,
        interruptionApplied: true,
        interruptionSkippedBecauseAlreadyHandled: false,
        movementInterrupted: true,
        animationRedirected: false,
        animationRestartedToStop: true,
        usedTeleportFallback: false,
        usedNativeTruncation: false,
        usedRollbackFallback: false
      });

      return {
        interrupted: true,
        appliedStopPoint,
        animationRedirected: false,
        animationRestartedToStop: true,
        usedTeleportFallback: false,
        usedNativeTruncation: false,
        usedRollbackFallback: false
      };
    }

    markHandledMovementInterruption(tokenDocument, movementSequenceId, stopDecision, {
      stopPoint,
      usedRollbackFallback: true
    });

    tokenDocument.stopMovement?.();
    await wait(0);
    await applyTeleportFallbackUpdate();

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
      animationRedirected: false,
      animationRestartedToStop: true,
      usedTeleportFallback: true,
      usedNativeTruncation: false,
      usedRollbackFallback: true,
      rollbackAfterDestinationReached: movementReachedOriginalDestinationBeforeFallback
    });

    return {
      interrupted: true,
      appliedStopPoint,
      animationRedirected: false,
      animationRestartedToStop: true,
      usedTeleportFallback: true,
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
      animationRedirected: false,
      animationRestartedToStop: false,
      usedTeleportFallback: true,
      usedNativeTruncation: false,
      usedRollbackFallback: true,
      error: caughtError?.message ?? "unknown"
    });
    deleteHandledMovementInterruption(tokenDocument, movementSequenceId);

    return {
      interrupted: false,
      appliedStopPoint: null,
      animationRedirected: false,
      animationRestartedToStop: false,
      usedTeleportFallback: true,
      usedNativeTruncation: false,
      usedRollbackFallback: true
    };
  }
}

async function applyManagedRegionOnEnterStopFromPlan({
  tokenDocument,
  movement,
  moveSource,
  movementSequenceId,
  originalFromState,
  originalToState,
  stopDecision
}) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  const entryPoint = stopDecision?.entryPoint ?? null;
  const entryCell = stopDecision?.entryCell ?? null;
  const selectedStopPoint = stopDecision?.selectedStopPoint ?? buildStopPointPayload(stopDecision?.stopState);
  const alreadyApplied = Boolean(stopDecision?.alreadyApplied);

  const interruption = await interruptTokenMovementForTrigger({
    tokenDocument,
    movement,
    moveSource,
    movementSequenceId,
    originalFromState,
    originalToState,
    stopDecision
  });

  debug("Applied managed Region onEnter stop from plan.", {
    tokenUuid,
    movementSequenceId,
    regionId: stopDecision?.regionId ?? null,
    entryPoint,
    entryCell,
    selectedStopPoint,
    appliedStopPoint: interruption?.appliedStopPoint ?? null,
    finalTokenPosition: buildSimplePositionPayload(snapshotTokenState(tokenDocument)),
    animationRedirected: Boolean(interruption?.animationRedirected),
    animationRestartedToStop: Boolean(interruption?.animationRestartedToStop),
    usedTeleportFallback: Boolean(interruption?.usedTeleportFallback),
    usedFallback: Boolean(interruption?.usedTeleportFallback),
    alreadyApplied
  });

  debug("Resolved managed Region onEnter stop result.", {
    tokenUuid,
    movementSequenceId,
    regionId: stopDecision?.regionId ?? null,
    entryPoint,
    entryCell,
    selectedStopPoint,
    appliedStopPoint: interruption?.appliedStopPoint ?? null,
    finalTokenPosition: buildSimplePositionPayload(snapshotTokenState(tokenDocument)),
    animationRedirected: Boolean(interruption?.animationRedirected),
    animationRestartedToStop: Boolean(interruption?.animationRestartedToStop),
    usedTeleportFallback: Boolean(interruption?.usedTeleportFallback),
    usedFallback: Boolean(interruption?.usedTeleportFallback),
    alreadyApplied
  });

  return interruption;
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

async function awaitControlledStopAnimationSettlement(tokenDocument) {
  const movementAnimationPromise =
    tokenDocument?.rendered &&
    typeof tokenDocument?.object?.movementAnimationPromise?.then === "function"
      ? tokenDocument.object.movementAnimationPromise
      : null;

  if (movementAnimationPromise) {
    await Promise.race([
      movementAnimationPromise.catch(() => null),
      wait(CONTROLLED_STOP_ANIMATION_SETTLE_TIMEOUT_MS)
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

function isOnEnterStopPlanMoveSource(moveSource) {
  return isInterruptibleMoveSource(moveSource);
}

function isLikelyPlayerDragPreUpdate(tokenDocument, changed, options = {}) {
  if (options?.[MODULE_ID]?.internalStopMovement) {
    return false;
  }

  if (!hasTranslationChange(changed)) {
    return false;
  }

  if (
    Object.prototype.hasOwnProperty.call(changed ?? {}, "width") ||
    Object.prototype.hasOwnProperty.call(changed ?? {}, "height")
  ) {
    return false;
  }

  return Boolean(tokenDocument?.parent && tokenDocument.parent === canvas?.scene);
}

function explainPreUpdateOnEnterTruncationFailure(evaluation) {
  if (!evaluation) {
    return "missing-evaluation";
  }

  if (!evaluation.normalizedDefinition?.enabled) {
    return "definition-disabled";
  }

  if (!evaluation.filterResult?.allowed) {
    return "target-filtered";
  }

  if (!evaluation.onEnter?.enabled) {
    return "onenter-disabled";
  }

  if (!evaluation.onEnter?.stopMovementOnTrigger) {
    return "stop-not-requested";
  }

  if (!evaluation.enterDetected) {
    return "entry-not-detected";
  }

  if (!evaluation.enterMovementModeMatched) {
    return "movement-mode-mismatch";
  }

  if (!evaluation.movementAnalysis?.firstEntryState && !evaluation.movementAnalysis?.firstInsideCellState) {
    return "missing-entry-state";
  }

  return "plan-not-produced";
}

function shouldAffectToken(tokenDocument, regionDocument, normalizedDefinition) {
  return evaluateManagedRegionTargetFilter(tokenDocument, regionDocument, normalizedDefinition);
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
  pendingEnterStops.clear();
  appliedEnterStops.clear();
  preAppliedEnterStopDestinations.clear();
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

function buildMovementSequenceIdFromStates(tokenDocument, states) {
  cleanupExpiredManagedRegionOnEnterStopState();
  cleanupExpiredHandledMovementInterruptions();

  const compactStates = compactStatePath(states);
  const firstState = compactStates[0] ?? null;
  const lastState = compactStates[compactStates.length - 1] ?? null;
  if (!firstState || !lastState) {
    return `${tokenDocument?.uuid ?? tokenDocument?.id ?? "token"}|unknown`;
  }

  const firstPoint = firstState.position ?? firstState.center ?? null;
  const lastPoint = lastState.position ?? lastState.center ?? null;
  return [
    tokenDocument?.uuid ?? tokenDocument?.id ?? "token",
    [
      Math.round(coerceNumber(firstPoint?.x, 0)),
      Math.round(coerceNumber(firstPoint?.y, 0)),
      Math.round(coerceNumber(firstState?.elevation, 0))
    ].join(":"),
    [
      Math.round(coerceNumber(lastPoint?.x, 0)),
      Math.round(coerceNumber(lastPoint?.y, 0)),
      Math.round(coerceNumber(lastState?.elevation, 0))
    ].join(":")
  ].join("|");
}

function buildManagedRegionOnEnterStopKey(tokenUuid, movementSequenceId, regionId) {
  if (!tokenUuid || !movementSequenceId || !regionId) {
    return null;
  }

  return `${tokenUuid}|${movementSequenceId}|${regionId}`;
}

function clearManagedRegionOnEnterStopStateForToken(tokenDocument) {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid) {
    return;
  }

  for (const [key, plan] of pendingEnterStops.entries()) {
    if (plan.tokenUuid === tokenUuid) {
      pendingEnterStops.delete(key);
    }
  }

  for (const [key, plan] of appliedEnterStops.entries()) {
    if (plan.tokenUuid === tokenUuid) {
      appliedEnterStops.delete(key);
    }
  }

  for (const [key, record] of preAppliedEnterStopDestinations.entries()) {
    if (record.tokenUuid === tokenUuid) {
      preAppliedEnterStopDestinations.delete(key);
    }
  }
}

function cleanupExpiredManagedRegionOnEnterStopState() {
  const now = Date.now();

  for (const [key, plan] of pendingEnterStops.entries()) {
    if ((plan?.expiresAt ?? 0) > now) {
      continue;
    }

    pendingEnterStops.delete(key);
    debug("Cleaned up managed Region onEnter stop plan.", {
      tokenUuid: plan?.tokenUuid ?? null,
      movementSequenceId: plan?.movementSequenceId ?? null,
      regionId: plan?.regionId ?? null,
      entryPoint: plan?.entryPoint ?? null,
      entryCell: plan?.entryCell ?? null,
      selectedStopPoint: plan?.selectedStopPoint ?? null,
      alreadyApplied: appliedEnterStops.has(key),
      reason: "expired"
    });
  }

  for (const [key, plan] of appliedEnterStops.entries()) {
    if ((plan?.expiresAt ?? 0) > now) {
      continue;
    }

    appliedEnterStops.delete(key);
  }

  for (const [key, record] of preAppliedEnterStopDestinations.entries()) {
    if ((record?.expiresAt ?? 0) > now) {
      continue;
    }

    preAppliedEnterStopDestinations.delete(key);
  }
}

function buildMovementSequenceId(tokenDocument, movement, movementPath) {
  cleanupExpiredManagedRegionOnEnterStopState();
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
  stepDistancePixels = null,
  gridCellStep = null
} = {}) {
  const states = compactStatePath(pathStates);
  if (!states.length) {
    return {
      crossedBoundary: false,
      sawEntry: false,
      sawExit: false,
      pathLengthPixels: 0,
      insideDistancePixels: 0,
      insideCellCount: 0,
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
      firstMoveTriggerSegmentIndex: null,
      firstGridMoveTriggerState: null,
      firstGridMoveTriggerPathDistancePixels: null,
      firstGridMoveTriggerSegmentIndex: null
    };
  }

  let previousInside = Boolean(fromInside);
  let crossedBoundary = false;
  let sawEntry = false;
  let sawExit = false;
  let pathLengthPixels = 0;
  let insideDistancePixels = 0;
  let insideCellCount = 0;
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
  let firstGridMoveTriggerState = null;
  let firstGridMoveTriggerPathDistancePixels = null;
  let firstGridMoveTriggerSegmentIndex = null;
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

      if (gridInside) {
        insideCellCount += 1;

        if (
          !firstGridMoveTriggerState &&
          gridCellStep !== null &&
          gridCellStep > 0 &&
          insideCellCount >= gridCellStep
        ) {
          firstGridMoveTriggerState = gridState;
          firstGridMoveTriggerPathDistancePixels = gridPathDistancePixels;
          firstGridMoveTriggerSegmentIndex = index;
        }
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
    insideCellCount,
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
    firstMoveTriggerSegmentIndex,
    firstGridMoveTriggerState,
    firstGridMoveTriggerPathDistancePixels,
    firstGridMoveTriggerSegmentIndex
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

function isDuplicateOnMoveTrigger(regionDocument, tokenDocument, moveSource, fromState, toState, triggerCount, insideDistance, {
  stepMode = "distance",
  configuredStep = null,
  insideCellCount = 0
} = {}) {
  return checkOnMoveTriggerDedup(
    regionDocument,
    tokenDocument,
    moveSource,
    fromState,
    toState,
    triggerCount,
    insideDistance,
    {
      stepMode,
      configuredStep,
      insideCellCount
    },
    { record: true }
  );
}

function checkOnMoveTriggerDedup(regionDocument, tokenDocument, moveSource, fromState, toState, triggerCount, insideDistance, {
  stepMode = "distance",
  configuredStep = null,
  insideCellCount = 0
} = {}, {
  record = true
} = {}) {
  cleanupExpiredDedupEntries(recentOnMoveEvents);

  const tokenKey = tokenDocument?.uuid ?? tokenDocument?.id ?? "token";
  const regionKey = regionDocument?.uuid ?? regionDocument?.id ?? "region";
  const fromKey = buildPointKey(fromState?.center);
  const toKey = buildPointKey(toState?.center);
  const stepModeKey = normalizeOnMoveStepMode(stepMode);
  const configuredStepKey = roundDistanceValue(configuredStep, 2);
  const insideMetricKey = stepModeKey === "grid-cell"
    ? Math.max(Math.round(coerceNumber(insideCellCount, 0)), 0)
    : roundDistanceValue(insideDistance, 2);
  const key = [
    "move",
    regionKey,
    tokenKey,
    moveSource,
    fromKey,
    toKey,
    stepModeKey,
    configuredStepKey,
    triggerCount,
    insideMetricKey
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

function normalizeOnMoveStepMode(stepMode, fallback = "distance") {
  const normalized = String(stepMode ?? "").trim().toLowerCase();
  if (["grid-cell", "distance"].includes(normalized)) {
    return normalized;
  }

  return fallback;
}

function normalizeOnMoveCellStep(cellStep, fallback = 1) {
  return Math.max(Math.round(coerceNumber(cellStep, fallback)), 1);
}

function resolveOnMoveStepMode(onMove = {}, scene = canvas?.scene ?? null) {
  const requestedMode = normalizeOnMoveStepMode(
    onMove?.stepMode,
    isSquareGridOnMoveStepModeAvailable(scene) ? "grid-cell" : "distance"
  );

  if (requestedMode === "grid-cell" && !isSquareGridOnMoveStepModeAvailable(scene)) {
    return "distance";
  }

  return requestedMode;
}

function getDefaultOnMoveDistanceStep(scene = canvas?.scene ?? null) {
  const normalizedUnits = String(scene?.grid?.units ?? canvas?.scene?.grid?.units ?? "")
    .trim()
    .toLowerCase();

  if (normalizedUnits === "ft" || normalizedUnits.includes("foot") || normalizedUnits.includes("feet") || normalizedUnits.includes("pied")) {
    return 5;
  }

  if (normalizedUnits === "m" || normalizedUnits.includes("meter") || normalizedUnits.includes("metre") || normalizedUnits.includes("mètre")) {
    return 1.5;
  }

  const sceneDistance = coerceNumber(scene?.grid?.distance, null);
  return sceneDistance && sceneDistance > 0 ? sceneDistance : 5;
}

function isSquareGridOnMoveStepModeAvailable(scene = canvas?.scene ?? null) {
  return isSquareGridStopModeAvailable(scene);
}

function calculateMoveTriggerCount({
  stepMode = "distance",
  insideDistance = 0,
  stepDistance = null,
  insideCellCount = 0,
  cellStep = null
} = {}) {
  if (normalizeOnMoveStepMode(stepMode) === "grid-cell") {
    if (cellStep === null || cellStep <= 0 || insideCellCount <= 0) {
      return 0;
    }

    return Math.max(0, Math.floor((insideCellCount + 0.0001) / cellStep));
  }

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
