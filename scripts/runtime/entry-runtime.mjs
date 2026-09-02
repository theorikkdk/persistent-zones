import { ENTRY_DEDUP_TTL_MS, MODULE_ID, RUNTIME_FLAG_KEY } from "../constants.mjs";
import { resolveMovementStopGlobalState } from "../settings.mjs";
import {
  applyConfiguredTriggerEffect,
  cleanupWhileInsideStatusesForRegionToken
} from "./entry-effects.mjs";
import {
  coerceNumber,
  debug,
  debugVerbose,
  distanceToPixels,
  evaluateManagedRegionTargetFilter,
  findManagedRegions,
  getRegionRuntimeFlags,
  getTokenCenter,
  isPrimaryGM,
  pixelsToDistance,
  resolveNativeRingGeometryFromRegion,
  testTokenInsideManagedRegion,
  testTokenTouchesManagedRegion,
  wait
} from "./utils.mjs";

const lastKnownTokenStates = new Map();
const regionInsideStates = new Map();
const movementDistanceRemainders = new Map();
const processedMovementExecutions = new Map();
const movementInvocationIds = new WeakMap();
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
let movementInvocationCounter = 0;
const INTERNAL_STOP_TTL_MS = 3000;
const MOVEMENT_SEQUENCE_TTL_MS = 5000;
const MANAGED_REGION_ENTER_STOP_TTL_MS = 5000;
const MOVEMENT_STOP_SETTLE_TIMEOUT_MS = 100;
const CONTROLLED_STOP_ANIMATION_SETTLE_TIMEOUT_MS = 1000;
const PENDING_PREUPDATE_GRID_STOP_TTL_MS = 3000;

function logV14RuntimeDiagnostic(message, data = {}) {
  if (!isFoundryV14OrNewer()) {
    return;
  }

  console.warn(`[${MODULE_ID}][v14-runtime] ${message}`, data);
}

function logV14EntryDiagnostic(message, data = {}) {
  console.warn(`[${MODULE_ID}][v14-entry] ${message}`, buildV14RuntimePayload(data));
}

function logV14BranchDiagnostic(message, data = {}) {
  const payload = buildV14RuntimePayload(data);
  const skippedReason = payload.skippedReason ?? payload.skippedV14PathBecause ?? payload.reason ?? "unspecified";
  const entryPoint = payload.entryPoint ?? payload.hook ?? "unknown-entry";
  const selectedCompatibilityPath = payload.selectedCompatibilityPath ?? payload.fallbackPathSelected ?? "unknown-path";
  console.warn(
    `[${MODULE_ID}][v14-branch] ${message}: ${skippedReason} | entryPoint=${entryPoint} | selectedCompatibilityPath=${selectedCompatibilityPath}`,
    payload
  );
}

function logTriggerSuppressedReason(reason, data = {}) {
  logV14RuntimeDiagnostic("triggerSuppressedReason", {
    reason,
    ...data
  });
}

function logPzEffectDiagnostic(message, data = {}) {
  logV14RuntimeDiagnostic(message, data);
}

function buildV14RuntimePayload(data = {}) {
  const skippedReason = data.skippedReason ?? data.skippedV14PathBecause ?? data.reason ?? null;
  return {
    foundryCoreVersion: globalThis.game?.version ?? null,
    foundryVersion: globalThis.game?.version ?? null,
    isV14: isFoundryV14OrNewer(),
    isFoundryV14OrNewer: isFoundryV14OrNewer(),
    skippedV14PathBecause: skippedReason,
    skippedReason,
    ...data
  };
}

function findRuntimeManagedRegions(scene) {
  const primaryRegions = findManagedRegions(scene).filter(isLegacyMovementRuntimeRegion);
  if (primaryRegions.length || !canvas?.scene || canvas.scene === scene) {
    return {
      regions: primaryRegions,
      source: "token-parent-scene",
      primarySummary: summarizeRuntimeSceneRegions(scene),
      fallbackSummary: null
    };
  }

  const fallbackRegions = findManagedRegions(canvas.scene).filter(isLegacyMovementRuntimeRegion);
  return {
    regions: fallbackRegions,
    source: fallbackRegions.length ? "canvas-scene-fallback" : "token-parent-scene",
    primarySummary: summarizeRuntimeSceneRegions(scene),
    fallbackSummary: summarizeRuntimeSceneRegions(canvas.scene)
  };
}

function summarizeRuntimeSceneRegions(scene) {
  const regionDocuments =
    scene?.regions?.contents ??
    Array.from(scene?.regions?.values?.() ?? []);

  return {
    sceneId: scene?.id ?? null,
    sceneRegionCount: regionDocuments.length,
    totalRegionCount: regionDocuments.length,
    managedRegionCount: regionDocuments.filter((region) => Boolean(getRegionRuntimeFlags(region))).length,
    regionSummaries: regionDocuments.slice(0, 8).map((region) => {
      const runtime = getRegionRuntimeFlags(region);
      const objectData = region?.toObject?.() ?? {};
      const flags = objectData.flags ?? region?.flags ?? {};
      return {
        id: region?.id ?? objectData._id ?? null,
        name: region?.name ?? objectData.name ?? null,
        hasPersistentZonesRuntime: Boolean(runtime),
        flagNamespaces: Object.keys(flags ?? {}),
        persistentZonesFlagKeys: Object.keys(flags?.[MODULE_ID] ?? {}),
        hasNestedRuntimeFlag: Boolean(flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]),
        hasFlatRuntimeFlag: Boolean(flags?.[`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]),
        sourceFlagNamespaces: Object.keys(region?._source?.flags ?? {}),
        sourcePersistentZonesFlagKeys: Object.keys(region?._source?.flags?.[MODULE_ID] ?? {}),
        templateId: runtime?.templateId ?? null,
        templateUuid: runtime?.templateUuid ?? null,
        itemUuid: runtime?.itemUuid ?? null,
        partId: runtime?.partId ?? null
      };
    })
  };
}

function isFoundryV14OrNewer() {
  const version = String(globalThis.game?.version ?? globalThis.game?.data?.version ?? "");
  const major = Number.parseInt(version.split(".")[0], 10);
  return Number.isFinite(major) && major >= 14;
}

export function registerEntryRuntimeHooks() {
  if (hooksRegistered) {
    logV14EntryDiagnostic("enteredManagedRegionRuntime", {
      selectedCompatibilityPath: "runtime-hooks-already-registered"
    });
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
  logV14EntryDiagnostic("enteredManagedRegionRuntime", {
    selectedCompatibilityPath: "runtime-hooks-registered",
    registeredHooks: ["canvasReady", "preUpdateToken", "moveToken", "updateToken", "createToken", "deleteToken"]
  });
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
  logV14EntryDiagnostic("enteredManagedRegionRuntime", {
    hook: "canvasReady",
    isPrimaryGM: isPrimaryGM(),
    sceneId: canvas?.scene?.id ?? null,
    selectedCompatibilityPath: "runtime-canvas-ready"
  });

  if (!isPrimaryGM()) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "canvasReady",
      reason: "not-primary-gm",
      fallbackPathSelected: "none"
    });
    return;
  }

  refreshTrackedTokenStates(canvas?.scene ?? null);
}

function onPreUpdateToken(tokenDocument, changed, options = {}) {
  logV14EntryDiagnostic("enteredManagedRegionRuntime", {
    hook: "preUpdateToken",
    tokenId: tokenDocument?.id ?? null,
    sceneId: tokenDocument?.parent?.id ?? null,
    changedKeys: Object.keys(changed ?? {}),
    optionsKeys: Object.keys(options ?? {}),
    isPrimaryGM: isPrimaryGM(),
    selectedCompatibilityPath: "runtime-preupdate-diagnostic"
  });

  if (!isPrimaryGM()) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "preUpdateToken",
      tokenId: tokenDocument?.id ?? null,
      reason: "not-primary-gm",
      fallbackPathSelected: "none"
    });
    return;
  }

  if (!hasTranslationChange(changed)) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "preUpdateToken",
      tokenId: tokenDocument?.id ?? null,
      reason: "no-translation-change",
      changedKeys: Object.keys(changed ?? {}),
      fallbackPathSelected: "none"
    });
    return;
  }

  const scene = tokenDocument?.parent ?? null;
  if (!scene) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "preUpdateToken",
      tokenId: tokenDocument?.id ?? null,
      reason: "missing-parent-scene",
      fallbackPathSelected: "none"
    });
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

  const managedRegionLookup = findRuntimeManagedRegions(scene);
  const managedRegions = managedRegionLookup.regions;
  if (!managedRegions.length) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "preUpdateToken",
      tokenId: tokenDocument?.id ?? null,
      sceneId: scene.id,
      reason: "no-managed-regions",
      skippedV14PathBecause: "no-managed-regions",
      hasManagedRegions: false,
      regionLookupSource: managedRegionLookup.source,
      primarySceneRegions: managedRegionLookup.primarySummary,
      fallbackSceneRegions: managedRegionLookup.fallbackSummary,
      fallbackPathSelected: "none"
    });
    return;
  }
  logV14BranchDiagnostic("selectedCompatibilityPath", {
    hook: "preUpdateToken",
    tokenId: tokenDocument?.id ?? null,
    sceneId: scene.id,
    hasManagedRegions: true,
    managedRegionCount: managedRegions.length,
    regionLookupSource: managedRegionLookup.source,
    selectedCompatibilityPath: "v14-preupdate-managed-region-diagnostic"
  });

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
    movementMode: movementResolution.resolvedMovementMode,
    movementSequenceId
  });
  const eligibleStopEvaluation = evaluations.find((evaluation) => {
    return Boolean(
      evaluation?.normalizedDefinition?.enabled &&
      evaluation?.filterResult?.allowed &&
      evaluation?.onEnter?.enabled &&
      evaluation?.enterMovementStopResolution?.enabled
    );
  });
  const candidateEvaluation = evaluations.find((evaluation) => {
    return Boolean(
      evaluation?.normalizedDefinition?.enabled &&
      evaluation?.filterResult?.allowed &&
      evaluation?.onEnter?.enabled &&
      evaluation?.enterMovementStopResolution?.enabled &&
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

  debugVerbose("Observed managed Region preUpdate diagnostic.", {
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
  logV14EntryDiagnostic("enteredManagedRegionRuntime", {
    hook: "moveToken",
    tokenId: tokenDocument?.id ?? null,
    sceneId: tokenDocument?.parent?.id ?? null,
    isPrimaryGM: isPrimaryGM(),
    selectedCompatibilityPath: "runtime-move-token"
  });

  if (!isPrimaryGM()) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "moveToken",
      tokenId: tokenDocument?.id ?? null,
      reason: "not-primary-gm",
      fallbackPathSelected: "none"
    });
    return;
  }

  if (!tokenDocument?.parent || tokenDocument.parent !== canvas?.scene) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "moveToken",
      tokenId: tokenDocument?.id ?? null,
      reason: "token-not-on-active-scene",
      tokenSceneId: tokenDocument?.parent?.id ?? null,
      canvasSceneId: canvas?.scene?.id ?? null,
      fallbackPathSelected: "none"
    });
    return;
  }

  const movementPath = buildMovementPathFromFoundryMovement(tokenDocument, movement);
  if (!movementPath) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "moveToken",
      tokenId: tokenDocument?.id ?? null,
      reason: "movement-path-not-resolved",
      fallbackPathSelected: "updateToken-fallback-if-fired"
    });
    return;
  }
  const movementInvocationId = getMovementInvocationId(tokenDocument, movement, "moveToken");
  const movementSequenceId = `${buildMovementSequenceId(tokenDocument, movement, movementPath)}|${movementInvocationId}`;
  const movementFamilyId = buildMovementFamilyId(tokenDocument, movement, movementPath);

  markRecentMoveTokenEvent(tokenDocument, movementPath.toState, {
    movementSequenceId,
    pending: true
  });

  if (consumeInternalStopDestinationIfMatched(tokenDocument, movementPath.toState)) {
    markRecentMoveTokenEvent(tokenDocument, movementPath.toState);
    lastKnownTokenStates.set(tokenDocument.uuid, movementPath.toState);

    debugVerbose("Skipped managed Region evaluation for internal stop-movement sync.", {
      movementSequenceId,
      tokenId: tokenDocument?.id ?? null,
      moveSource: movementPath.moveSource,
      toX: movementPath.toState?.position?.x ?? null,
      toY: movementPath.toState?.position?.y ?? null
    });
    return;
  }

  const handledInterruption = getHandledMovementInterruption(
    tokenDocument,
    movementSequenceId,
    movementFamilyId
  );

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
      stepMode: handledInterruption.stepMode ?? null,
      configuredStep: roundDistanceValue(handledInterruption.configuredStep),
      firstInsideCell: handledInterruption.firstInsideCell ?? null,
      originalFrom: buildSimplePositionPayload(movementPath.fromState),
      originalTo: buildSimplePositionPayload(movementPath.toState),
      selectedStopPoint: handledInterruption.stopPoint ?? null,
      appliedStopPoint: handledInterruption.stopPoint ?? null,
      finalTokenPosition: buildSimplePositionPayload(snapshotTokenState(tokenDocument)),
      onMoveThresholdPoint: handledInterruption.onMoveThresholdPoint ?? null,
      stopApplied: false,
      onMoveSuppressed: handledInterruption.trigger === "onMove",
      effectiveTriggerCount: handledInterruption.trigger === "onMove" ? 1 : 0,
      movementAlreadyHandled: true,
      interruptionApplied: false,
      movementInterrupted: false,
      interruptionSkippedBecauseAlreadyHandled: true,
      usedFallback: handledInterruption.usedRollbackFallback ?? false,
      usedNativeTruncation: !(handledInterruption.usedRollbackFallback ?? false),
      usedRollbackFallback: handledInterruption.usedRollbackFallback ?? false
    });
    return;
  }

  const movementResolution = resolveMovementModeForEvaluation(tokenDocument, {
    moveSource: movementPath.moveSource,
    consume: true
  });

  let evaluation;
  try {
    evaluation = await evaluateTokenEntry(tokenDocument, {
      moveSource: movementPath.moveSource,
      movementSequenceId,
      movementMode: movementResolution.resolvedMovementMode,
      movementModeRaw: movementResolution.rawMovementMode,
      movementMarkConsumed: movementResolution.consumed,
      fromState: movementPath.fromState,
      toState: movementPath.toState,
      pathStates: movementPath.pathStates,
      movementFamilyId,
      movement
    });
  } catch (error) {
    completeRecentMoveTokenEvent(tokenDocument, movementSequenceId);
    debug("Managed Region movement execution failed.", {
      errorName: error?.name ?? null,
      errorMessage: error?.message ?? String(error),
      errorStack: error?.stack ?? null,
      movementSequenceId,
      tokenUuid: tokenDocument?.uuid ?? null,
      regionId: null
    });
    return;
  }

  const finalState = evaluation?.finalState ?? movementPath.toState;
  completeRecentMoveTokenEvent(tokenDocument, movementSequenceId);
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
      stepMode: evaluation.stopStepMode ?? null,
      configuredStep: roundDistanceValue(evaluation.stopConfiguredStep),
      firstInsideCell: evaluation.firstInsideCell ?? null,
      selectedStopPoint: evaluation.selectedStopPoint ?? null,
      appliedStopPoint: evaluation.appliedStopPoint ?? null,
      finalTokenPosition: buildSimplePositionPayload(snapshotTokenState(tokenDocument)),
      onMoveThresholdPoint: evaluation.onMoveThresholdPoint ?? null,
      stopApplied: evaluation.movementInterrupted,
      onMoveSuppressed: evaluation.onMoveSuppressed ?? false,
      effectiveTriggerCount: evaluation.effectiveTriggerCount ?? null,
      movementAlreadyHandled: false,
      interruptionApplied: evaluation.movementInterrupted,
      movementInterrupted: evaluation.movementInterrupted,
      interruptionSkippedBecauseAlreadyHandled: false,
      usedFallback: Boolean(
        evaluation.usedRollbackFallback ||
        evaluation.usedTeleportFallback ||
        evaluation.animationRestartedToStop
      ),
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
  logV14EntryDiagnostic("enteredManagedRegionRuntime", {
    hook: "updateToken",
    tokenId: tokenDocument?.id ?? null,
    sceneId: tokenDocument?.parent?.id ?? null,
    changedKeys: Object.keys(changed ?? {}),
    optionsKeys: Object.keys(options ?? {}),
    isPrimaryGM: isPrimaryGM(),
    selectedCompatibilityPath: "runtime-update-token-fallback"
  });

  if (!isPrimaryGM()) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "updateToken",
      tokenId: tokenDocument?.id ?? null,
      reason: "not-primary-gm",
      fallbackPathSelected: "none"
    });
    return;
  }

  if (!hasPositionChange(changed)) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "updateToken",
      tokenId: tokenDocument?.id ?? null,
      reason: "no-position-change",
      changedKeys: Object.keys(changed ?? {}),
      fallbackPathSelected: "none"
    });
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
  const movementInvocationId = getMovementInvocationId(tokenDocument, null, "updateToken");
  const movementSequenceId = `${buildMovementSequenceIdFromStates(tokenDocument, [beforeState, afterState])}|${movementInvocationId}`;
  const movementResolution = resolveMovementModeForEvaluation(tokenDocument, {
    moveSource: "updateToken-fallback",
    consume: false
  });

  await evaluateTokenEntry(tokenDocument, {
    moveSource: "updateToken-fallback",
    movementSequenceId,
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
  logV14EntryDiagnostic("enteredManagedRegionRuntime", {
    hook: "createToken",
    tokenId: tokenDocument?.id ?? null,
    sceneId: tokenDocument?.parent?.id ?? null,
    isPrimaryGM: isPrimaryGM(),
    selectedCompatibilityPath: "runtime-create-token"
  });

  if (!isPrimaryGM()) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      hook: "createToken",
      tokenId: tokenDocument?.id ?? null,
      reason: "not-primary-gm",
      fallbackPathSelected: "none"
    });
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
  clearProcessedMovementExecutionsForToken(tokenDocument);
}

export function isLegacyMovementRuntimeRegion(regionDocument) {
  const definition = getRegionRuntimeFlags(regionDocument)?.normalizedDefinition;
  return definition?.placement?.mode !== "attached-source" && definition?.obstacles?.mode !== "wall-restricted";
}

function clearProcessedMovementExecutionsForToken(tokenDocument) {
  const tokenKey = tokenDocument?.uuid ?? tokenDocument?.id ?? null;
  if (!tokenKey) return;
  for (const key of processedMovementExecutions.keys()) {
    if (key.includes(`|${tokenKey}|`)) processedMovementExecutions.delete(key);
  }
  if (Object.prototype.hasOwnProperty.call(changed ?? {}, "elevation") &&
      !Object.prototype.hasOwnProperty.call(changed ?? {}, "x") &&
      !Object.prototype.hasOwnProperty.call(changed ?? {}, "y") &&
      !Object.prototype.hasOwnProperty.call(changed ?? {}, "width") &&
      !Object.prototype.hasOwnProperty.call(changed ?? {}, "height")) {
  }
}

function buildRegionNativeSegmentTriggerKey(evaluation) {
  const runtime = evaluation?.runtime ?? {};
  if (runtime.regionSourceStrategy !== "v14-region-native-segment-group" && !runtime.regionSegmentCount) {
    return null;
  }
  const partId =
    runtime?.partId ??
    runtime?.part?.id ??
    runtime?.normalizedDefinition?.part?.id ??
    null;
  return [
    runtime.groupId ?? evaluation?.regionDocument?.id ?? "no-group",
    partId ?? "no-part"
  ].join(":");
}

function evaluationHasMovementTrigger(evaluation) {
  return Boolean(
    evaluation?.enterDetected ||
    evaluation?.exitDetected ||
    evaluation?.moveTriggerCount > 0
  );
}

function resolveEvaluationTriggerType(evaluation) {
  const firstTransition = Array.from(evaluation?.movementAnalysis?.transitions ?? [])[0] ?? null;
  if (firstTransition?.type === "onEnter") {
    return "onEnter";
  }
  if (firstTransition?.type === "onExit") {
    return "onExit";
  }
  if (evaluation?.enterDetected) {
    return "onEnter";
  }
  if (evaluation?.exitDetected) {
    return "onExit";
  }
  if (evaluation?.moveTriggerCount > 0) {
    return "onMove";
  }
  return "none";
}

function resolveFirstCandidateTrigger(evaluation) {
  switch (resolveEvaluationTriggerType(evaluation)) {
    case "onEnter":
      return evaluation?.onEnter ?? {};
    case "onMove":
      return evaluation?.onMove ?? {};
    case "onExit":
      return evaluation?.onExit ?? {};
    default:
      return null;
  }
}

function resolveSkippedEffectReason(evaluation, {
  filterResult = null,
  onEnterTriggered = false,
  onMoveTriggered = false,
  triggerSuppressedBecauseMovementAlreadyStopped = false
} = {}) {
  const triggerType = resolveEvaluationTriggerType(evaluation);
  const trigger = resolveFirstCandidateTrigger(evaluation);
  if (triggerType === "none") {
    return "movement-trigger-not-matched";
  }
  if (!evaluation?.normalizedDefinition?.enabled) {
    return "definition-disabled";
  }
  if (!filterResult?.allowed) {
    return "target-filtered";
  }
  if (!trigger?.enabled) {
    return `${triggerType}-disabled`;
  }
  if (triggerSuppressedBecauseMovementAlreadyStopped) {
    return "movement-already-stopped";
  }
  if (onEnterTriggered || onMoveTriggered) {
    return "executor-returned-no-application";
  }
  const mode = String(trigger?.mode ?? "none").toLowerCase();
  if (mode === "none") {
    return "no-effect-configured";
  }
  if (mode === "activity" && !trigger?.activity?.id && !trigger?.activity?.uuid) {
    return "no-activity-reference";
  }
  if (mode !== "activity" && !trigger?.damage?.formula && !trigger?.simpleEffect?.formula) {
    return "no-damage-formula";
  }
  return "executor-not-found";
}

function markRegionInsideStateFromEvaluation(evaluation) {
  if (!evaluation?.insideStateKey) {
    return;
  }
  if (evaluation.toInside) {
    regionInsideStates.set(evaluation.insideStateKey, true);
  } else {
    regionInsideStates.delete(evaluation.insideStateKey);
  }
}

async function evaluateTokenEntry(tokenDocument, {
  moveSource,
  movementSequenceId = null,
  movementFamilyId = null,
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
  logV14EntryDiagnostic("enteredManagedRegionRuntime", {
    entryPoint: "evaluateTokenEntry",
    tokenId: tokenDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    actorUuid: actor?.uuid ?? null,
    moveSource,
    movementMode,
    movementModeRaw,
    pathStateCount: Array.from(pathStates ?? []).length,
    selectedCompatibilityPath: "runtime-region-membership-evaluation"
  });

  if (!scene) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      entryPoint: "evaluateTokenEntry",
      tokenId: tokenDocument?.id ?? null,
      moveSource,
      reason: "missing-parent-scene",
      fallbackPathSelected: "none"
    });
    return { finalState: fallbackFinalState, movementInterrupted: false };
  }

  if (!tokenDocument?.id || tokenDocument?.parent?.tokens?.get?.(tokenDocument.id) === null) {
    debug("Skipped token entry check because the token is invalid.", {
      tokenId: tokenDocument?.id ?? null,
      moveSource
    });
    logV14BranchDiagnostic("skippedV14PathBecause", {
      entryPoint: "evaluateTokenEntry",
      tokenId: tokenDocument?.id ?? null,
      moveSource,
      reason: "invalid-token-document",
      fallbackPathSelected: "none"
    });
    return { finalState: fallbackFinalState, movementInterrupted: false };
  }

  if (!actor) {
    debug("Skipped token entry check because the token has no Actor.", {
      tokenId: tokenDocument.id,
      tokenName: tokenDocument.name,
      moveSource
    });
    logV14BranchDiagnostic("skippedV14PathBecause", {
      entryPoint: "evaluateTokenEntry",
      tokenId: tokenDocument.id,
      tokenName: tokenDocument.name,
      moveSource,
      reason: "token-has-no-actor",
      fallbackPathSelected: "none"
    });
    return { finalState: fallbackFinalState, movementInterrupted: false };
  }

  const managedRegionLookup = findRuntimeManagedRegions(scene);
  const managedRegions = managedRegionLookup.regions;
  if (!managedRegions.length) {
    logV14BranchDiagnostic("skippedV14PathBecause", {
      entryPoint: "evaluateTokenEntry",
      tokenId: tokenDocument.id,
      sceneId: scene.id,
      moveSource,
      reason: "no-managed-regions",
      skippedV14PathBecause: "no-managed-regions",
      hasManagedRegions: false,
      regionLookupSource: managedRegionLookup.source,
      primarySceneRegions: managedRegionLookup.primarySummary,
      fallbackSceneRegions: managedRegionLookup.fallbackSummary,
      fallbackPathSelected: "none"
    });
    return { finalState: fallbackFinalState, movementInterrupted: false };
  }
  logV14BranchDiagnostic("selectedCompatibilityPath", {
    entryPoint: "evaluateTokenEntry",
    tokenId: tokenDocument.id,
    sceneId: scene.id,
    moveSource,
    movementMode,
    hasManagedRegions: true,
    managedRegionCount: managedRegions.length,
    regionLookupSource: managedRegionLookup.source,
    selectedCompatibilityPath: "v14-runtime-managed-region-evaluation"
  });

  const basePathStates = compactStatePath(pathStates);
  const initialEvaluations = collectRegionEvaluations(tokenDocument, managedRegions, {
    scene,
    moveSource,
    fromState,
    toState,
    pathStates: basePathStates,
    movementMode,
    movementSequenceId
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

    debug("Prepared managed Region onEnter stop decision.", {
      movementSequenceId,
      tokenId: tokenDocument?.id ?? null,
      regionId: plannedEnterStopDecision.regionId ?? null,
      moveSource,
      movementMode,
      trigger: "onEnter",
      stopReason: plannedEnterStopDecision.stopReason ?? "entry",
      stopMode: plannedEnterStopDecision.stopMode ?? "sampled-fallback",
      stopSupported: true,
      plannedStopAvailable: true,
      truncatedDestinationApplied: false,
      entryPoint: plannedEnterStopDecision.entryPoint ?? null,
      entryCell: plannedEnterStopDecision.entryCell ?? null,
      selectedStopPoint: plannedEnterStopDecision.selectedStopPoint ?? null,
      truncatedTo,
      skippedBecauseAlreadyHandled: Boolean(plannedEnterStopDecision.alreadyApplied)
    });
  }
  const stopDecision = plannedEnterStopDecision ?? chooseStopDecision(initialEvaluations, {
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
  let stopStepMode = null;
  let stopConfiguredStep = null;
  let firstInsideCell = null;
  let onMoveThresholdPoint = null;
  let onMoveSuppressed = false;
  let effectiveTriggerCount = null;
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
    stopStepMode = stopDecision.stepMode ?? null;
    stopConfiguredStep = stopDecision.configuredStep ?? null;
    firstInsideCell = buildGridCellPayload(stopDecision.firstInsideCellState);
    onMoveThresholdPoint = buildSimplePositionPayload(stopDecision.onMoveThresholdState);
    const interruption = stopDecision.trigger === "onEnter" && stopDecision.planKey
      ? await applyManagedRegionOnEnterStopFromPlan({
        tokenDocument,
        movement,
        moveSource,
        movementSequenceId,
        movementFamilyId,
        originalFromState: fromState ?? basePathStates[0] ?? null,
        originalToState: toState ?? fallbackFinalState,
        stopDecision
      })
      : await interruptTokenMovementForTrigger({
        tokenDocument,
        movement,
        moveSource,
        movementSequenceId,
        movementFamilyId,
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
      movementMode,
      movementSequenceId
    })
    : initialEvaluations;

  const appliedRegionNativeSegmentGroups = new Set();
  for (const evaluation of evaluations) {
    const segmentGroupKey = buildRegionNativeSegmentTriggerKey(evaluation);
    if (
      segmentGroupKey &&
      evaluationHasMovementTrigger(evaluation) &&
      appliedRegionNativeSegmentGroups.has(segmentGroupKey)
    ) {
      markRegionInsideStateFromEvaluation(evaluation);
      logPzEffectDiagnostic("PZ EFFECT EXECUTION SKIPPED", {
        tokenId: tokenDocument?.id ?? null,
        regionId: evaluation?.regionDocument?.id ?? null,
        partId: evaluation?.runtime?.partId ?? null,
        movementSequenceId,
        triggerType: resolveEvaluationTriggerType(evaluation),
        previousInside: evaluation?.fromInside ?? null,
        currentInside: evaluation?.toInside ?? null,
        onEnterEnabled: Boolean(evaluation?.onEnter?.enabled),
        onMoveEnabled: Boolean(evaluation?.onMove?.enabled),
        effectMode: resolveFirstCandidateTrigger(evaluation)?.mode ?? null,
        simpleEffect: resolveFirstCandidateTrigger(evaluation)?.simpleEffect ?? null,
        damageFormula: resolveFirstCandidateTrigger(evaluation)?.damage?.formula ?? null,
        damageType: resolveFirstCandidateTrigger(evaluation)?.damage?.type ?? null,
        activityUuid: resolveFirstCandidateTrigger(evaluation)?.activity?.uuid ?? null,
        regionSourceStrategy: evaluation?.runtime?.regionSourceStrategy ?? null,
        regionSegmentIndex: evaluation?.runtime?.regionSegmentIndex ?? null,
        regionSegmentCount: evaluation?.runtime?.regionSegmentCount ?? null,
        skipped: true,
        skippedReason: "duplicate-movement-sequence",
        triggerSuppressedReason: "region-native-segment-group-already-applied"
      });
      logV14RuntimeDiagnostic("v14RingDedupApplied", {
        tokenId: tokenDocument?.id ?? null,
        regionId: evaluation?.regionDocument?.id ?? null,
        groupId: evaluation?.runtime?.groupId ?? null,
        partId: evaluation?.runtime?.partId ?? null,
        regionSourceStrategy: evaluation?.runtime?.regionSourceStrategy ?? null,
        regionSegmentIndex: evaluation?.runtime?.regionSegmentIndex ?? null,
        regionSegmentCount: evaluation?.runtime?.regionSegmentCount ?? null,
        skipped: true,
        triggerSuppressedReason: "region-native-segment-group-already-applied"
      });
      continue;
    }
    const evaluationResult = await applyRegionEvaluation(tokenDocument, evaluation, {
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
    if (segmentGroupKey && evaluationHasMovementTrigger(evaluation) && evaluationResult?.effectApplied) {
      appliedRegionNativeSegmentGroups.add(segmentGroupKey);
    }
    if (evaluation?.regionDocument?.id === stopDecision?.regionId) {
      onMoveSuppressed = Boolean(evaluationResult?.onMoveSuppressed);
      effectiveTriggerCount = evaluationResult?.effectiveTriggerCount ?? effectiveTriggerCount;
    }
  }

  return {
    finalState: effectiveToState,
    movementInterrupted,
    interruptionAttempted,
    selectedStopPoint,
    appliedStopPoint,
    stopReason,
    stopMode,
    stopStepMode,
    stopConfiguredStep,
    firstInsideCell,
    onMoveThresholdPoint,
    onMoveSuppressed,
    effectiveTriggerCount,
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

export function collectRegionEvaluations(tokenDocument, managedRegions, {
  scene,
  moveSource,
  fromState,
  toState,
  pathStates,
  movementMode,
  movementSequenceId = null
}) {
  const states = compactStatePath(pathStates);
  const firstPathState = states[0] ?? fromState ?? null;
  const lastPathState = states[states.length - 1] ?? toState ?? null;

  return managedRegions.map((regionDocument) => {
    const runtime = getRegionRuntimeFlags(regionDocument);
    const normalizedDefinition = runtime?.normalizedDefinition ?? null;
    const membershipTest = normalizedDefinition?.interaction?.mode === "thin-wall"
      ? testTokenTouchesManagedRegion
      : testTokenInsideManagedRegion;
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
    const rawFromInside = firstPathState
      ? membershipTest(tokenDocument, regionDocument, firstPathState)
      : Boolean(cachedFromInside);
    const rawToInside = lastPathState
      ? membershipTest(tokenDocument, regionDocument, lastPathState)
      : false;
    const inferV14InitialEntry =
      isFoundryV14OrNewer() &&
      cachedFromInside === null &&
      rawFromInside &&
      rawToInside &&
      moveSource !== "preUpdateToken-diagnostic";
    const fromInside = inferV14InitialEntry ? false : rawFromInside;
    const toInside = rawToInside;
    const movementAnalysis = moveSource === "createToken"
      ? {
        crossedBoundary: toInside,
        sawEntry: toInside,
        sawExit: false,
        movementStartedInside: false,
        entryConsumedFirstMoveStep: false,
        pathLengthPixels: 0,
        insideDistancePixels: 0,
        remainingInsideDistancePixels: 0,
        insideCellCount: 0,
        remainingInsideCellCount: 0,
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
          gridCellStep: cellStep,
          membershipTest,
          sampleStepPixels: normalizedDefinition?.interaction?.mode === "thin-wall"
            ? resolveThinWallSampleStepPixels(regionDocument)
            : null
        }
      );
    const enterDetected = moveSource === "createToken"
      ? toInside
      : movementAnalysis.sawEntry;
    const exitDetected = moveSource === "createToken"
      ? false
      : movementAnalysis.sawExit;
    const pathLength = pixelsToDistance(movementAnalysis.pathLengthPixels, scene);
    const movementStartedInside = Boolean(movementAnalysis.movementStartedInside ?? fromInside);
    const entryConsumedFirstMoveStep = Boolean(movementAnalysis.entryConsumedFirstMoveStep);
    const insideDistance = pixelsToDistance(movementAnalysis.insideDistancePixels, scene);
    const remainingInsideDistance = pixelsToDistance(
      movementAnalysis.remainingInsideDistancePixels ?? movementAnalysis.insideDistancePixels,
      scene
    );
    const insideCellCount = movementAnalysis.insideCellCount ?? 0;
    const remainingInsideCellCount = movementAnalysis.remainingInsideCellCount ?? insideCellCount;
    const accumulateMovementDistance = stepMode === "distance" && onMove?.accumulateRemainder === true;
    const distanceForMoveTrigger = accumulateMovementDistance ? insideDistance : remainingInsideDistance;
    const rawMoveTriggerCount = calculateMoveTriggerCount({
      stepMode,
      insideDistance: distanceForMoveTrigger,
      stepDistance,
      insideCellCount: remainingInsideCellCount,
      cellStep
    });
    const moveTriggerCount = accumulateMovementDistance
      ? (distanceForMoveTrigger > 0 ? Math.max(1, rawMoveTriggerCount) : 0)
      : movementAnalysis.crossedBoundary ? 0 : rawMoveTriggerCount;
    const onMoveEligible = Boolean(fromInside && toInside && !movementAnalysis.crossedBoundary);
    const nativeRingGeometry = resolveNativeRingGeometryFromRegion(regionDocument, runtime);
    if (nativeRingGeometry) {
      logPzEffectDiagnostic("PZ RING TRANSITION CHECK", {
        tokenId: tokenDocument?.id ?? null,
        regionId: regionDocument?.id ?? null,
        movementSequenceId,
        origin: buildSimplePositionPayload(firstPathState),
        destination: buildSimplePositionPayload(lastPathState),
        shapeRadius: nativeRingGeometry.radiusPixels,
        shapeInnerWidth: nativeRingGeometry.innerWidthPixels,
        shapeOuterWidth: nativeRingGeometry.outerWidthPixels,
        resolvedInnerRadiusPixels: nativeRingGeometry.innerRadiusPixels,
        resolvedOuterRadiusPixels: nativeRingGeometry.outerRadiusPixels,
        previousInside: fromInside,
        currentInside: toInside,
        entered: enterDetected,
        exited: exitDetected,
        triggerType: resolveEvaluationTriggerType({
          enterDetected,
          exitDetected,
          moveTriggerCount,
          movementAnalysis
        }),
        geometrySource: nativeRingGeometry.geometrySource
      });
    }
    logPzEffectDiagnostic("PZ MOVEMENT TRANSITIONS RESOLVED", {
      tokenId: tokenDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      movementSequenceId,
      originInside: fromInside,
      destinationInside: toInside,
      transitions: summarizeMovementTransitions(movementAnalysis.transitions, movementAnalysis.pathLengthPixels),
      onMoveEligible,
      rawMoveTriggerCount,
      moveTriggerCount,
      stopTransitionIndex: movementAnalysis.firstEntryTransitionIndex ?? null
    });
    const onMoveEligibleAfterEntry = moveTriggerCount > 0;
    const enterMovementModeMatched = movementModeMatches(movementMode, onEnter.movementMode);
    const exitMovementModeMatched = movementModeMatches(movementMode, onExit.movementMode);
    const moveMovementModeMatched = movementModeMatches(movementMode, onMove.movementMode);
    const enterMovementStopResolution = resolveMovementStopGlobalState(onEnter, "onEnter");
    const exitMovementStopResolution = resolveMovementStopGlobalState(onExit, "onExit");
    const moveMovementStopResolution = resolveMovementStopGlobalState(onMove, "onMove");
    const filterResult = shouldAffectToken(tokenDocument, regionDocument, normalizedDefinition);
    const partId =
      runtime?.partId ??
      runtime?.part?.id ??
      runtime?.normalizedDefinition?.part?.id ??
      null;
    const geometryType = runtime?.normalizedDefinition?.geometry?.type ?? null;
    const runtimeDiagnostic = {
      tokenId: tokenDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      partId,
      geometryType,
      regionSourceStrategy: runtime?.regionSourceStrategy ?? null,
      regionSegmentIndex: runtime?.regionSegmentIndex ?? null,
      regionSegmentCount: runtime?.regionSegmentCount ?? null,
      moveSource,
      movementMode,
      fromInside,
      toInside,
      enterDetected,
      exitDetected,
      moveTriggerCount,
      rawFromInside,
      rawToInside,
      cachedFromInside,
      inferV14InitialEntry,
      tokenInsideRegion: toInside,
      targetAllowed: filterResult.allowed,
      triggerTiming: {
        onEnter: enterDetected,
        onMove: moveTriggerCount > 0,
        onExit: exitDetected
      },
      v14RuntimePath: "managed-region-runtime-evaluation"
    };
    logV14RuntimeDiagnostic("runtimeRegionCheck", runtimeDiagnostic);
    logV14RuntimeDiagnostic("regionRuntimeCheck", runtimeDiagnostic);
    logV14RuntimeDiagnostic("tokenInsideRegion", runtimeDiagnostic);
    if (partId) {
      logV14RuntimeDiagnostic("partRuntimeCheck", runtimeDiagnostic);
    }
    if (String(geometryType ?? "").toLowerCase().includes("ring")) {
      logV14RuntimeDiagnostic("ringRuntimeCheck", runtimeDiagnostic);
    }
    logV14RuntimeDiagnostic("triggerCandidateFound", {
      ...runtimeDiagnostic,
      triggerCandidateFound: Boolean(enterDetected || exitDetected || moveTriggerCount > 0),
      triggerTimingResolved: resolveEvaluationTriggerType({
        enterDetected,
        exitDetected,
        moveTriggerCount,
        movementAnalysis
      }),
      simpleEffectAllowed: Boolean(
        (enterDetected && onEnter?.enabled) ||
        (moveTriggerCount > 0 && onMove?.enabled) ||
        (exitDetected && onExit?.enabled)
      )
    });

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
      movementStartedInside,
      entryConsumedFirstMoveStep,
      pathLength,
      insideDistance,
      remainingInsideDistance,
      movementDistanceInside: distanceForMoveTrigger,
      accumulateMovementDistance,
      insideCellCount,
      remainingInsideCellCount,
      stepMode,
      configuredStep,
      cellStep,
      stepDistance,
      moveTriggerCount,
      onMoveEligibleAfterEntry,
      enterDetected,
      exitDetected,
      enterMovementModeMatched,
      exitMovementModeMatched,
      moveMovementModeMatched,
      enterMovementStopResolution,
      exitMovementStopResolution,
      moveMovementStopResolution,
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
    movementStartedInside,
    entryConsumedFirstMoveStep,
    pathLength,
    insideDistance,
    remainingInsideDistance,
    movementDistanceInside,
    accumulateMovementDistance,
    insideCellCount,
    remainingInsideCellCount,
    stepMode,
    configuredStep,
    cellStep,
    stepDistance,
    moveTriggerCount,
    onMoveEligibleAfterEntry,
    enterDetected,
    exitDetected,
    enterMovementModeMatched,
    exitMovementModeMatched,
    moveMovementModeMatched,
    enterMovementStopResolution,
    exitMovementStopResolution,
    moveMovementStopResolution,
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
  const stopApplied = Boolean(
    movementInterrupted &&
    ["onEnter", "onMove"].includes(stopDecision?.trigger)
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
  let effectiveTriggerCount = moveTriggerCount;
  let onEnterSuppressed = false;
  let onMoveSuppressed = false;
  let onExitSuppressed = false;
  let triggerSuppressedBecauseMovementAlreadyStopped = false;
  let onEnterTriggered = false;
  let onMoveTriggered = false;

  if (!normalizedDefinition?.enabled) {
    debug("Skipped managed Region effect because the normalized definition is disabled.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id
    });
    logTriggerSuppressedReason("definition-disabled", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      partId: filterResult?.partId ?? null
    });
    return {
      onMoveSuppressed,
      effectiveTriggerCount
    };
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
    logTriggerSuppressedReason("no-movement-trigger-detected", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      partId: filterResult?.partId ?? null,
      moveSource,
      fromInside,
      toInside,
      enterDetected,
      exitDetected,
      moveTriggerCount,
      stepMode,
      insideDistance: roundDistanceValue(insideDistance),
      insideCellCount
    });
    logPzEffectDiagnostic("PZ EFFECT EXECUTION SKIPPED", {
      movementSequenceId,
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      partId: filterResult?.partId ?? null,
      triggerType: "none",
      previousInside: fromInside,
      currentInside: toInside,
      onEnterEnabled: Boolean(onEnter?.enabled),
      onMoveEnabled: Boolean(onMove?.enabled),
      effectMode: null,
      simpleEffect: null,
      damageFormula: null,
      damageType: null,
      activityUuid: null,
      skippedReason: "movement-trigger-not-matched"
    });
  }

  if (enterDetected || exitDetected || moveTriggerCount > 0) {
    const candidateTrigger = resolveFirstCandidateTrigger(evaluation);
    logPzEffectDiagnostic("PZ TRIGGER CONFIG RESOLVED", {
      movementSequenceId,
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      partId: filterResult?.partId ?? null,
      triggerType: resolveEvaluationTriggerType(evaluation),
      previousInside: fromInside,
      currentInside: toInside,
      onEnterEnabled: Boolean(onEnter?.enabled),
      onMoveEnabled: Boolean(onMove?.enabled),
      effectMode: candidateTrigger?.mode ?? null,
      simpleEffect: candidateTrigger?.simpleEffect ?? null,
      damageFormula: candidateTrigger?.damage?.formula ?? null,
      damageType: candidateTrigger?.damage?.type ?? null,
      activityUuid: candidateTrigger?.activity?.uuid ?? null,
      skippedReason: null
    });
    if (!filterResult.allowed) {
      debug("Skipped managed Region effect because target filter rejected the token.", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        partId: filterResult.partId ?? null,
        targetFilter: filterResult.targetFilter,
        targetFilterGlobal: filterResult.targetFilterGlobal,
        targetFilterPart: filterResult.targetFilterPart,
        targetFilterEffective: filterResult.targetFilterEffective,
        targetMatched: filterResult.targetMatched,
        sourceActorUuid: filterResult.sourceActorUuid ?? null,
        sourceTokenId: filterResult.sourceTokenId ?? null,
        sourceDisposition: filterResult.sourceDisposition ?? null,
        targetActorUuid: filterResult.targetActorUuid ?? null,
        targetDisposition: filterResult.targetDisposition ?? null,
        reason: filterResult.reason
      });
      logTriggerSuppressedReason("target-filter-rejected", {
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        partId: filterResult.partId ?? null,
        targetFilter: filterResult.targetFilter,
        targetMatched: filterResult.targetMatched,
        reason: filterResult.reason
      });
    } else {
      if (stopApplied && !stopHandledByRegion) {
        onEnterSuppressed = Boolean(enterDetected);
        onMoveSuppressed = moveTriggerCount > 0;
        onExitSuppressed = Boolean(exitDetected);
        effectiveTriggerCount = 0;
        triggerSuppressedBecauseMovementAlreadyStopped =
          onEnterSuppressed || onMoveSuppressed || onExitSuppressed;
      } else {
        const boundaryTransitions = Array.from(movementAnalysis.transitions ?? []);
        if (boundaryTransitions.length) {
          for (const [transitionIndex, transition] of boundaryTransitions.entries()) {
            if (transition.type === "onExit") {
              const exitApplied = await applyExitTriggerIfNeeded(tokenDocument, regionDocument, onExit, {
                moveSource,
                movementSequenceId,
                fromInside,
                toInside,
                movementMode,
                exitDetected: true,
                exitMovementModeMatched,
                exitCenter: transition.state?.center ?? transition.center ?? toState?.center,
                stopPoint,
                stopHandledByRegion,
                stopDecision
              });
              effectApplied = effectApplied || exitApplied;
              continue;
            }

            if (transition.type === "onEnter") {
              const enterApplied = await applyEnterTriggerIfNeeded(tokenDocument, regionDocument, onEnter, {
                moveSource,
                movementSequenceId,
                fromInside,
                toInside,
                movementMode,
                enterDetected: true,
                enterMovementModeMatched,
                entryCenter: transition.state?.center ?? transition.center ?? toState?.center,
                movementStopResolution: enterMovementStopResolution,
                stopPoint,
                stopHandledByRegion,
                stopDecision
              });
              effectApplied = effectApplied || enterApplied;
              onEnterTriggered = onEnterTriggered || enterApplied;

              if (stopApplied && stopDecision?.trigger === "onEnter") {
                onMoveSuppressed = moveTriggerCount > 0;
                onExitSuppressed = boundaryTransitions.slice(transitionIndex + 1).some((candidate) => candidate.type === "onExit");
                effectiveTriggerCount = 0;
                triggerSuppressedBecauseMovementAlreadyStopped = onMoveSuppressed || onExitSuppressed;
                break;
              }
            }
          }
          if (accumulateMovementDistance && !triggerSuppressedBecauseMovementAlreadyStopped) {
            const moveApplied = await applyMoveTriggerIfNeeded(tokenDocument, regionDocument, onMove, {
              moveSource,
              movementSequenceId,
              fromInside,
              toInside,
              movementMode,
              moveTriggerCount: effectiveTriggerCount,
              stepMode,
              configuredStep,
              rawInsideCellCount: insideCellCount,
              remainingInsideCellCount,
              moveMovementModeMatched,
              movementStopResolution: moveMovementStopResolution,
              fromState,
              toState,
              rawInsideDistance: insideDistance,
              remainingInsideDistance,
              movementDistanceInside,
              accumulateMovementDistance,
              movementStartedInside,
              entryConsumedFirstMoveStep,
              onMoveEligibleAfterEntry,
              pathLength,
              stepDistance,
              stopPoint,
              onMoveThresholdPoint,
              stopHandledByRegion,
              stopDecision,
              movementAnalysis
            });
            effectApplied = effectApplied || moveApplied;
            onMoveTriggered = moveApplied;
          }
        } else {
          if (stopApplied && stopDecision?.trigger === "onMove") {
            onMoveSuppressed = moveTriggerCount > 1;
            onExitSuppressed = Boolean(exitDetected);
            effectiveTriggerCount = Math.min(Math.max(moveTriggerCount, 0), 1);
            triggerSuppressedBecauseMovementAlreadyStopped = onMoveSuppressed || onExitSuppressed;
          }

          const moveApplied = await applyMoveTriggerIfNeeded(tokenDocument, regionDocument, onMove, {
            moveSource,
            movementSequenceId,
            fromInside,
            toInside,
            movementMode,
            moveTriggerCount: effectiveTriggerCount,
            stepMode,
            configuredStep,
            rawInsideCellCount: insideCellCount,
            remainingInsideCellCount,
            moveMovementModeMatched,
            movementStopResolution: moveMovementStopResolution,
            fromState,
            toState,
            rawInsideDistance: insideDistance,
            remainingInsideDistance,
            movementDistanceInside,
            accumulateMovementDistance,
            movementStartedInside,
            entryConsumedFirstMoveStep,
            onMoveEligibleAfterEntry,
            pathLength,
            stepDistance,
            stopPoint,
            onMoveThresholdPoint,
            stopHandledByRegion,
            stopDecision,
            movementAnalysis
          });
          effectApplied = effectApplied || moveApplied;
          onMoveTriggered = moveApplied;
        }
      }

      if (triggerSuppressedBecauseMovementAlreadyStopped) {
        debug("Suppressed managed Region movement triggers because movement sequence was already stopped.", {
          movementSequenceId,
          tokenId: tokenDocument.id,
          regionId: regionDocument.id,
          partId: filterResult.partId ?? null,
          moveSource,
          stopApplied: true,
          triggerSuppressedBecauseMovementAlreadyStopped: true,
          onMoveSuppressed,
          onEnterSuppressed,
          onExitSuppressed,
          stepMode: stopDecision?.stepMode ?? stepMode,
          configuredStep: roundDistanceValue(stopDecision?.configuredStep ?? configuredStep),
          movementStartedInside,
          entryConsumedFirstMoveStep,
          onMoveEligibleAfterEntry,
          remainingInsideDistance: roundDistanceValue(remainingInsideDistance),
          remainingInsideCells: remainingInsideCellCount,
          effectiveTriggerCount,
          stopReason: stopDecision?.stopReason ?? "entry",
          stopMode: stopDecision?.stopMode ?? "sampled-fallback",
          selectedStopPoint: stopDecision?.selectedStopPoint ?? stopPoint,
          appliedStopPoint: stopPoint,
          finalTokenPosition: buildSimplePositionPayload(toState)
        });
        logTriggerSuppressedReason("movement-already-stopped", {
          movementSequenceId,
          tokenId: tokenDocument.id,
          regionId: regionDocument.id,
          partId: filterResult.partId ?? null,
          onMoveSuppressed,
          onEnterSuppressed,
          onExitSuppressed,
          stopReason: stopDecision?.stopReason ?? "entry",
          stopMode: stopDecision?.stopMode ?? "sampled-fallback"
        });
      }
    }
  }

  debug("Checked token against managed Region.", {
    movementSequenceId,
    tokenId: tokenDocument.id,
    regionId: regionDocument.id,
    partId: filterResult.partId ?? null,
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
    targetFilterGlobal: filterResult.targetFilterGlobal,
    targetFilterPart: filterResult.targetFilterPart,
    targetFilterEffective: filterResult.targetFilterEffective,
    targetMatched: filterResult.targetMatched,
    sourceActorUuid: filterResult.sourceActorUuid ?? null,
    sourceTokenId: filterResult.sourceTokenId ?? null,
    sourceDisposition: filterResult.sourceDisposition ?? null,
    targetActorUuid: filterResult.targetActorUuid ?? null,
    targetDisposition: filterResult.targetDisposition ?? null,
    moveStepMode: stepMode,
    moveConfiguredStep: roundDistanceValue(configuredStep),
    moveInsideCellCount: insideCellCount,
    remainingInsideCells: remainingInsideCellCount,
    computedSteps: moveTriggerCount,
    effectiveTriggerCount,
    movementStopGlobalEnabled: Boolean(
      enterMovementStopResolution?.globalEnabled ||
      moveMovementStopResolution?.globalEnabled ||
      exitMovementStopResolution?.globalEnabled
    ),
    movementStopGlobalMode: {
      onEnter: enterMovementStopResolution?.globalMode ?? "off",
      onMove: moveMovementStopResolution?.globalMode ?? "off",
      onExit: exitMovementStopResolution?.globalMode ?? "off"
    },
    movementStopLegacyFlagDetected: Boolean(
      enterMovementStopResolution?.legacyFlagDetected ||
      moveMovementStopResolution?.legacyFlagDetected ||
      exitMovementStopResolution?.legacyFlagDetected
    ),
    movementStopResolvedFrom: {
      onEnter: enterMovementStopResolution?.resolvedFrom ?? null,
      onMove: moveMovementStopResolution?.resolvedFrom ?? null,
      onExit: exitMovementStopResolution?.resolvedFrom ?? null
    },
    stopSkippedBecauseGlobalDisabled: {
      onEnter: enterMovementStopResolution?.stopSkippedBecauseGlobalDisabled ?? false,
      onMove: moveMovementStopResolution?.stopSkippedBecauseGlobalDisabled ?? false,
      onExit: exitMovementStopResolution?.stopSkippedBecauseGlobalDisabled ?? false
    },
    onEnterMovementStopEnabled: enterMovementStopResolution?.enabled ?? false,
    onMoveMovementStopEnabled: moveMovementStopResolution?.enabled ?? false,
    fromX: fromState?.position?.x ?? null,
    fromY: fromState?.position?.y ?? null,
    toX: toState?.position?.x ?? null,
    toY: toState?.position?.y ?? null,
    fromInside,
    toInside,
    crossedBoundary: movementAnalysis.crossedBoundary,
    movementStartedInside,
    entryConsumedFirstMoveStep,
    onMoveEligibleAfterEntry,
    pathLength: roundDistanceValue(pathLength),
    insideDistance: roundDistanceValue(insideDistance),
    remainingInsideDistance: roundDistanceValue(remainingInsideDistance),
    stepDistance: roundDistanceValue(stepDistance),
    triggerCount: moveTriggerCount,
    enterDetected,
    exitDetected,
    onEnterTriggered,
    onMoveTriggered,
    stopTrigger: stopHandledByRegion ? stopDecision.trigger : null,
    stopReason: stopHandledByRegion ? stopDecision.stopReason ?? null : null,
    stopMode,
    firstInsideCell,
    stopPoint,
    onMoveThresholdPoint,
    stopApplied,
    triggerSuppressedBecauseMovementAlreadyStopped,
    onMoveSuppressed,
    onEnterSuppressed,
    onExitSuppressed,
    movementInterrupted: stopHandledByRegion,
    effectApplied,
    skipped: !effectApplied && (enterDetected || exitDetected || moveTriggerCount > 0)
  });
  if (effectApplied) {
    logV14RuntimeDiagnostic("partTriggerApplied", {
      movementSequenceId,
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      partId: filterResult.partId ?? null,
      triggerTiming: {
        onEnter: enterDetected,
        onMove: moveTriggerCount > 0,
        onExit: exitDetected
      },
      effectApplied,
      onEnterTriggered,
      onMoveTriggered,
      effectiveTriggerCount,
      skipped: false
    });
  } else if (enterDetected || exitDetected || moveTriggerCount > 0) {
    logPzEffectDiagnostic("PZ EFFECT EXECUTION SKIPPED", {
      movementSequenceId,
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      partId: filterResult.partId ?? null,
      triggerType: resolveEvaluationTriggerType(evaluation),
      previousInside: fromInside,
      currentInside: toInside,
      onEnterEnabled: Boolean(onEnter?.enabled),
      onMoveEnabled: Boolean(onMove?.enabled),
      effectMode: resolveFirstCandidateTrigger(evaluation)?.mode ?? null,
      simpleEffect: resolveFirstCandidateTrigger(evaluation)?.simpleEffect ?? null,
      damageFormula: resolveFirstCandidateTrigger(evaluation)?.damage?.formula ?? null,
      damageType: resolveFirstCandidateTrigger(evaluation)?.damage?.type ?? null,
      activityUuid: resolveFirstCandidateTrigger(evaluation)?.activity?.uuid ?? null,
      skippedReason: resolveSkippedEffectReason(evaluation, {
        filterResult,
        onEnterTriggered,
        onMoveTriggered,
        triggerSuppressedBecauseMovementAlreadyStopped
      })
    });
  }

  return {
    onMoveSuppressed,
    effectiveTriggerCount,
    effectApplied
  };
}

async function applyEnterTriggerIfNeeded(tokenDocument, regionDocument, onEnter, {
  moveSource,
  movementSequenceId = null,
  fromInside = null,
  toInside = null,
  movementMode,
  enterDetected,
  enterMovementModeMatched,
  entryCenter,
  movementStopResolution = null,
  stopPoint,
  stopHandledByRegion,
  stopDecision,
  movementAnalysis = null
}) {
  logV14RuntimeDiagnostic("triggerTimingResolved", {
    tokenId: tokenDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    triggerTiming: "onEnter",
    triggerCandidateFound: Boolean(enterDetected),
    triggerEnabled: Boolean(onEnter?.enabled),
    movementMode,
    movementModeMatched: enterMovementModeMatched
  });

  if (!enterDetected) {
    logTriggerSuppressedReason("onEnter-not-detected", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      triggerTiming: "onEnter"
    });
    return false;
  }

  if (!onEnter.enabled) {
    debug("Skipped managed Region effect because onEnter is disabled.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id
    });
    logTriggerSuppressedReason("onEnter-disabled", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      triggerTiming: "onEnter"
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
    logTriggerSuppressedReason("onEnter-movement-mode-mismatch", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      triggerTiming: "onEnter",
      movementMode,
      requiredMovementMode: onEnter.movementMode ?? "any"
    });
    return false;
  }

  if (isDuplicateMovementTrigger("enter", regionDocument, tokenDocument, moveSource, entryCenter)) {
    debug("Skipped managed Region effect because the entry was deduplicated.", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id
    });
    logTriggerSuppressedReason("onEnter-deduplicated", {
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      triggerTiming: "onEnter",
      moveSource
    });
    return false;
  }

  const application = await applyConfiguredTriggerEffect({
    regionDocument,
    tokenDocument,
    triggerConfig: onEnter,
    timing: "onEnter",
    context: {
      movementSequenceId,
      previousInside: fromInside,
      currentInside: toInside,
      triggerType: "onEnter",
      moveSource
    }
  });

  debug("Managed Region onEnter effect completed.", {
    tokenId: tokenDocument.id,
    regionId: regionDocument.id,
    moveSource,
    movementMode,
    requiredMovementMode: onEnter.movementMode ?? "any",
    movementModeMatched: true,
    movementStopGlobalEnabled: movementStopResolution?.globalEnabled ?? false,
    movementStopGlobalMode: movementStopResolution?.globalMode ?? "off",
    movementStopLegacyFlagDetected: movementStopResolution?.legacyFlagDetected ?? false,
    movementStopResolvedFrom: movementStopResolution?.resolvedFrom ?? null,
    stopSkippedBecauseGlobalDisabled: movementStopResolution?.stopSkippedBecauseGlobalDisabled ?? false,
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
  movementSequenceId = null,
  fromInside = null,
  toInside = null,
  movementMode,
  moveTriggerCount,
  stepMode,
  configuredStep,
  rawInsideCellCount,
  remainingInsideCellCount,
  moveMovementModeMatched,
  movementStopResolution = null,
  fromState,
  toState,
  rawInsideDistance,
  remainingInsideDistance,
  movementDistanceInside = null,
  accumulateMovementDistance = false,
  movementStartedInside,
  entryConsumedFirstMoveStep,
  onMoveEligibleAfterEntry,
  pathLength,
  stepDistance,
  stopPoint,
  onMoveThresholdPoint,
  stopHandledByRegion,
  stopDecision,
  movementAnalysis = null
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
  const executionKey = buildMovementExecutionKey({
    movementSequenceId,
    tokenDocument,
    regionDocument,
    partId,
    triggerId: "onMove"
  });

  if (moveTriggerCount <= 0 && !accumulateMovementDistance) {
    return false;
  }

  const executionClaim = claimMovementExecution(executionKey);
  if (executionClaim.duplicate) return false;

  const distanceProgress = accumulateMovementDistance
    ? resolveMovementDistanceProgress({
      regionDocument,
      tokenDocument,
      insideDistance: movementDistanceInside ?? rawInsideDistance,
      interval: configuredStep,
      toInside
    })
    : null;
  const effectiveTriggerCount = distanceProgress?.completeIntervals ?? moveTriggerCount;

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
        movementStartedInside,
        entryConsumedFirstMoveStep,
        onMoveEligibleAfterEntry,
        pathLength: roundDistanceValue(pathLength),
        insideDistance: roundDistanceValue(rawInsideDistance),
        remainingInsideDistance: roundDistanceValue(remainingInsideDistance),
        insideCellCount: rawInsideCellCount,
        remainingInsideCells: remainingInsideCellCount,
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
        movementStartedInside,
        entryConsumedFirstMoveStep,
        onMoveEligibleAfterEntry,
        pathLength: roundDistanceValue(pathLength),
        insideDistance: roundDistanceValue(rawInsideDistance),
        remainingInsideDistance: roundDistanceValue(remainingInsideDistance),
        insideCellCount: rawInsideCellCount,
        remainingInsideCells: remainingInsideCellCount,
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
      movementStartedInside,
      entryConsumedFirstMoveStep,
      onMoveEligibleAfterEntry,
      pathLength: roundDistanceValue(pathLength),
      insideDistance: roundDistanceValue(rawInsideDistance),
      remainingInsideDistance: roundDistanceValue(remainingInsideDistance),
      insideCellCount: rawInsideCellCount,
      remainingInsideCells: remainingInsideCellCount,
      stepDistance: roundDistanceValue(stepDistance),
      triggerCount: effectiveTriggerCount
    });
    return false;
  }

  if (!movementSequenceId && isDuplicateOnMoveTrigger(
    regionDocument,
    tokenDocument,
    moveSource,
    fromState,
    toState,
    effectiveTriggerCount,
    remainingInsideDistance,
    {
      stepMode,
      configuredStep,
      insideCellCount: remainingInsideCellCount
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
      movementStartedInside,
      entryConsumedFirstMoveStep,
      onMoveEligibleAfterEntry,
      pathLength: roundDistanceValue(pathLength),
      insideDistance: roundDistanceValue(rawInsideDistance),
      remainingInsideDistance: roundDistanceValue(remainingInsideDistance),
      insideCellCount: rawInsideCellCount,
      remainingInsideCells: remainingInsideCellCount,
      stepDistance: roundDistanceValue(stepDistance),
      triggerCount: effectiveTriggerCount
    });
    return false;
  }

  if (distanceProgress) commitMovementDistanceProgress(distanceProgress);

  if (effectiveTriggerCount <= 0) {
    return false;
  }

  let appliedCount = 0;
  let activityFound = null;
  let activityTriggered = false;
  let simpleEffectApplied = false;

  const applicationCount = onMove?.aggregateApplications !== false ? 1 : effectiveTriggerCount;
  const effectiveTrigger = applicationCount === 1 && effectiveTriggerCount > 1
    ? buildAggregatedDistanceTrigger(onMove, effectiveTriggerCount)
    : onMove;
  for (let index = 0; index < applicationCount; index += 1) {
    let application;
    try {
      application = await applyConfiguredTriggerEffect({
        regionDocument,
        tokenDocument,
        triggerConfig: effectiveTrigger,
        timing: "onMove",
        context: {
          movementSequenceId,
          previousInside: fromInside,
          currentInside: toInside,
          triggerType: "onMove",
          moveSource
        }
      });
    } catch (error) {
      debug("Managed Region onMove effect failed.", {
        errorName: error?.name ?? null,
        errorMessage: error?.message ?? String(error),
        errorStack: error?.stack ?? null,
        movementSequenceId,
        tokenUuid: tokenDocument?.uuid ?? tokenDocument?.id ?? null,
        regionId: regionDocument?.id ?? null,
        partId,
        executionKey
      });
      throw error;
    }

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
    movementStopGlobalEnabled: movementStopResolution?.globalEnabled ?? false,
    movementStopGlobalMode: movementStopResolution?.globalMode ?? "off",
    movementStopLegacyFlagDetected: movementStopResolution?.legacyFlagDetected ?? false,
    movementStopResolvedFrom: movementStopResolution?.resolvedFrom ?? null,
    stopSkippedBecauseGlobalDisabled: movementStopResolution?.stopSkippedBecauseGlobalDisabled ?? false,
    movementStartedInside,
    entryConsumedFirstMoveStep,
    onMoveEligibleAfterEntry,
    stopPoint,
    stopReason: stopHandledByRegion ? stopDecision?.stopReason ?? null : null,
    onMoveThresholdPoint,
    movementInterrupted: stopHandledByRegion && stopDecision.trigger === "onMove",
    activityFound,
    activityTriggered,
    simpleEffectApplied,
    pathLength: roundDistanceValue(pathLength),
    insideDistance: roundDistanceValue(rawInsideDistance),
    remainingInsideDistance: roundDistanceValue(remainingInsideDistance),
    insideCellCount: rawInsideCellCount,
    remainingInsideCells: remainingInsideCellCount,
    stepDistance: roundDistanceValue(stepDistance),
    triggerCount: effectiveTriggerCount,
    appliedCount,
    effectApplied: appliedCount > 0
  });

  return appliedCount > 0;
}

function resolveMovementDistanceProgress({ regionDocument, tokenDocument, insideDistance, interval, toInside }) {
  const safeInterval = Math.max(coerceNumber(interval, 0), 0);
  const key = buildMovementDistanceRemainderKey(regionDocument, tokenDocument);
  const previousRemainder = Math.max(coerceNumber(movementDistanceRemainders.get(key), 0), 0);
  return { key, ...calculateMovementDistanceProgress(previousRemainder, insideDistance, safeInterval), clearAfter: !toInside };
}

export function calculateMovementDistanceProgress(previousRemainder, insideDistance, interval) {
  const safeInterval = Math.max(coerceNumber(interval, 0), 0);
  const previous = Math.max(coerceNumber(previousRemainder, 0), 0);
  const total = previous + Math.max(coerceNumber(insideDistance, 0), 0);
  const epsilon = safeInterval > 0 ? Math.max(1e-9, safeInterval * 1e-9) : 1e-9;
  let completeIntervals = safeInterval > 0 ? Math.floor((total + epsilon) / safeInterval) : 0;
  let newRemainder = safeInterval > 0 ? Math.max(0, total - completeIntervals * safeInterval) : 0;
  if (newRemainder <= epsilon) newRemainder = 0;
  else if (safeInterval - newRemainder <= epsilon) {
    completeIntervals += 1;
    newRemainder = 0;
  }
  return { previousRemainder: previous, completeIntervals, newRemainder };
}

function commitMovementDistanceProgress(progress) {
  if (progress.clearAfter || progress.newRemainder <= 0.0001) movementDistanceRemainders.delete(progress.key);
  else movementDistanceRemainders.set(progress.key, progress.newRemainder);
}

function buildMovementDistanceRemainderKey(regionDocument, tokenDocument) {
  const combat = globalThis.game?.combat;
  const scope = combat?.started
    ? `${combat.id ?? "combat"}:${combat.round ?? 0}:${combat.turn ?? 0}`
    : "exploration";
  return `${regionDocument?.uuid ?? regionDocument?.id}|${tokenDocument?.uuid ?? tokenDocument?.id}|${scope}`;
}

export function multiplyDiceFormula(formula, count) {
  const multiplier = Math.max(1, Math.floor(coerceNumber(count, 1)));
  const normalized = String(formula ?? "").trim();
  const match = normalized.match(/^(\d+)d(\d+)$/i);
  if (match) return `${Number(match[1]) * multiplier}d${match[2]}`;
  return `(${normalized || "0"}) * ${multiplier}`;
}

function buildAggregatedDistanceTrigger(trigger, count) {
  const formula = trigger?.simpleEffect?.formula ?? trigger?.damage?.formula ?? "0";
  const aggregatedFormula = multiplyDiceFormula(formula, count);
  return {
    ...trigger,
    simpleEffect: { ...(trigger?.simpleEffect ?? {}), formula: aggregatedFormula },
    damage: { ...(trigger?.damage ?? {}), formula: aggregatedFormula }
  };
}

async function applyExitTriggerIfNeeded(tokenDocument, regionDocument, onExit, {
  moveSource,
  movementSequenceId = null,
  fromInside = null,
  toInside = null,
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

  await cleanupWhileInsideStatusesForRegionToken({
    regionDocument,
    tokenDocument,
    cleanupReason: "onExit-detected"
  });

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
    timing: "onExit",
    context: {
      movementSequenceId,
      previousInside: fromInside,
      currentInside: toInside,
      triggerType: "onExit",
      moveSource
    }
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
  const candidates = [];

  for (const evaluation of evaluations) {
    const {
      regionDocument,
      normalizedDefinition,
      onMove,
      moveMovementModeMatched,
      moveMovementStopResolution,
      movementAnalysis,
      filterResult,
      stepMode,
      configuredStep,
      fromState
    } = evaluation;

    if (!normalizedDefinition?.enabled || !filterResult.allowed) {
      continue;
    }

    if (!onMove.enabled) {
      continue;
    }

    if (!moveMovementStopResolution?.enabled) {
      if (moveMovementStopResolution?.stopSkippedBecauseGlobalDisabled) {
        debug("Skipped managed Region movement stop because the global movement-stop setting is disabled.", {
          movementSequenceId,
          tokenId: tokenDocument?.id ?? null,
          regionId: regionDocument?.id ?? null,
          moveSource,
          movementMode,
          trigger: "onMove",
          movementStopGlobalEnabled: moveMovementStopResolution?.globalEnabled ?? false,
          movementStopGlobalMode: moveMovementStopResolution?.globalMode ?? "off",
          movementStopLegacyFlagDetected: moveMovementStopResolution?.legacyFlagDetected ?? false,
          movementStopResolvedFrom: moveMovementStopResolution?.resolvedFrom ?? null,
          stopSkippedBecauseGlobalDisabled: true
        });
      }
      continue;
    }

    if (!moveMovementModeMatched) {
      debug("Skipped managed Region movement stop because movement mode did not match.", {
        movementSequenceId,
        tokenId: tokenDocument?.id ?? null,
        regionId: regionDocument?.id ?? null,
        moveSource,
        movementMode,
        trigger: "onMove",
        stopSupported: true,
        stopRequested: true,
        requiredMovementMode: onMove.movementMode ?? "any",
        movementModeMatched: false
      });
      continue;
    }

    const resolvedStepMode = normalizeOnMoveStepMode(stepMode);
    const stopState = resolvedStepMode === "grid-cell"
      ? movementAnalysis.firstGridMoveTriggerState
      : movementAnalysis.firstMoveTriggerState;
    const stopPathDistancePixels = resolvedStepMode === "grid-cell"
      ? movementAnalysis.firstGridMoveTriggerPathDistancePixels
      : movementAnalysis.firstMoveTriggerPathDistancePixels;
    const stopSegmentIndex = resolvedStepMode === "grid-cell"
      ? movementAnalysis.firstGridMoveTriggerSegmentIndex
      : movementAnalysis.firstMoveTriggerSegmentIndex;
    const dedupInsideDistance = resolvedStepMode === "distance"
      ? coerceNumber(configuredStep, 0)
      : 0;
    const dedupInsideCellCount = resolvedStepMode === "grid-cell"
      ? normalizeOnMoveCellStep(configuredStep, 1)
      : 0;

    if (!stopState) {
      debug("Skipped managed Region movement stop because no onMove threshold state was available.", {
        movementSequenceId,
        tokenId: tokenDocument?.id ?? null,
        regionId: regionDocument?.id ?? null,
        moveSource,
        movementMode,
        trigger: "onMove",
        stopSupported: true,
        stopRequested: true,
        stopReason: "move",
        stepMode: resolvedStepMode,
        configuredStep: roundDistanceValue(configuredStep)
      });
      continue;
    }

    if (
      checkOnMoveTriggerDedup(
        regionDocument,
        tokenDocument,
        moveSource,
        fromState,
        stopState,
        1,
        dedupInsideDistance,
        {
          stepMode: resolvedStepMode,
          configuredStep,
          insideCellCount: dedupInsideCellCount
        },
        { record: false }
      )
    ) {
      continue;
    }

    candidates.push({
      regionDocument,
      regionId: regionDocument.id,
      trigger: "onMove",
      stopReason: "move",
      stopMode: resolvedStepMode,
      stepMode: resolvedStepMode,
      configuredStep,
      firstInsideCellState: movementAnalysis.firstInsideCellState ?? null,
      pathDistancePixels: stopPathDistancePixels ?? 0,
      stopState,
      segmentIndex: stopSegmentIndex ?? 1,
      onMoveThresholdState: stopState,
      selectedStopPoint: buildStopPointPayload(stopState)
    });
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) => {
    const distanceDelta = (left.pathDistancePixels ?? 0) - (right.pathDistancePixels ?? 0);
    if (distanceDelta !== 0) {
      return distanceDelta;
    }

    return String(left.regionId ?? "").localeCompare(String(right.regionId ?? ""));
  });

  const decision = candidates[0];

  debug("Selected managed Region movement stop decision.", {
    movementSequenceId,
    tokenId: tokenDocument?.id ?? null,
    regionId: decision.regionId ?? null,
    moveSource,
    movementMode,
    trigger: "onMove",
    stopReason: decision.stopReason ?? "move",
    stopMode: decision.stopMode ?? "distance",
    stepMode: decision.stepMode ?? null,
    configuredStep: roundDistanceValue(decision.configuredStep),
    selectedStopPoint: decision.selectedStopPoint ?? buildSimplePositionPayload(decision.stopState),
    onMoveThresholdPoint: buildSimplePositionPayload(decision.onMoveThresholdState)
  });

  return decision;
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
    enterMovementStopResolution,
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

  if (!enterDetected || !onEnter.enabled || !enterMovementModeMatched) {
    return null;
  }

  if (!enterMovementStopResolution?.enabled) {
    if (enterMovementStopResolution?.stopSkippedBecauseGlobalDisabled) {
      debug("Skipped managed Region onEnter stop plan because the global movement-stop setting is disabled.", {
        tokenUuid: tokenDocument?.uuid ?? null,
        movementSequenceId,
        regionId: regionDocument?.id ?? null,
        moveSource,
        movementMode,
        trigger: "onEnter",
        movementStopGlobalEnabled: enterMovementStopResolution?.globalEnabled ?? false,
        movementStopGlobalMode: enterMovementStopResolution?.globalMode ?? "off",
        movementStopLegacyFlagDetected: enterMovementStopResolution?.legacyFlagDetected ?? false,
        movementStopResolvedFrom: enterMovementStopResolution?.resolvedFrom ?? null,
        stopSkippedBecauseGlobalDisabled: true
      });
    }
    return null;
  }

  const entryPointState = movementAnalysis.firstEntryState ?? movementAnalysis.firstInsideCellState ?? null;
  const selectedStopState = movementAnalysis.firstEntryState ?? movementAnalysis.firstInsideCellState ?? null;
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
    entryCell: buildGridCellPayload(selectedStopState),
    firstInsideCellState: selectedStopState
      ? duplicateStopState(selectedStopState)
      : null,
    selectedStopPoint: buildStopPointPayload(selectedStopState),
    selectedStopState: duplicateStopState(selectedStopState),
    stopMode: "sampled-fallback",
    selectedPathDistancePixels: movementAnalysis.firstEntryPathDistancePixels ?? movementAnalysis.firstInsideCellPathDistancePixels ?? 0,
    segmentIndex: movementAnalysis.firstEntrySegmentIndex ?? movementAnalysis.firstInsideCellSegmentIndex ?? 1,
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
      enterMovementStopResolution,
      moveMovementStopResolution,
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
      enterMovementStopResolution?.enabled &&
      enterMovementModeMatched &&
      movementAnalysis.firstEntryState &&
      !checkMovementTriggerDedup(
        "enter",
        regionDocument,
        tokenDocument,
        moveSource,
        movementAnalysis.firstEntryState.center,
        { record: false }
      )
    ) {
      candidates.push({
        regionDocument,
        regionId: regionDocument.id,
        trigger: "onEnter",
        stopReason: "entry",
        stopMode: "sampled-fallback",
        firstInsideCellState: movementAnalysis.firstEntryState,
        pathDistancePixels: movementAnalysis.firstEntryPathDistancePixels ?? 0,
        stopState: movementAnalysis.firstEntryState,
        segmentIndex: movementAnalysis.firstEntrySegmentIndex ?? 1,
        onMoveThresholdState: null
      });
    }

    if (
      !movementAnalysis.crossedBoundary &&
      onMove.enabled &&
      moveMovementStopResolution?.enabled &&
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
  movementFamilyId = null,
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
      movementStopGlobalEnabled: true,
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
    usedRollbackFallback: false,
    movementFamilyId
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
      usedRollbackFallback: false,
      movementFamilyId
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
      usedRollbackFallback: true,
      movementFamilyId
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
    deleteHandledMovementInterruption(tokenDocument, movementSequenceId, movementFamilyId);

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
  movementFamilyId = null,
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
    movementFamilyId,
    originalFromState,
    originalToState,
    stopDecision
  });

  debug("Applied managed Region onEnter stop from plan.", {
    tokenUuid,
    movementSequenceId,
    regionId: stopDecision?.regionId ?? null,
    stopReason: stopDecision?.stopReason ?? "entry",
    stopMode: stopDecision?.stopMode ?? "sampled-fallback",
    entryPoint,
    entryCell,
    selectedStopPoint,
    appliedStopPoint: interruption?.appliedStopPoint ?? null,
    finalTokenPosition: buildSimplePositionPayload(snapshotTokenState(tokenDocument)),
    animationRedirected: Boolean(interruption?.animationRedirected),
    animationRestartedToStop: Boolean(interruption?.animationRestartedToStop),
    usedTeleportFallback: Boolean(interruption?.usedTeleportFallback),
    usedNativeTruncation: Boolean(interruption?.usedNativeTruncation),
    usedFallback: Boolean(
      interruption?.usedRollbackFallback ||
      interruption?.usedTeleportFallback ||
      interruption?.animationRestartedToStop
    ),
    skippedBecauseAlreadyHandled: Boolean(alreadyApplied),
    alreadyApplied
  });

  debug("Resolved managed Region onEnter stop result.", {
    tokenUuid,
    movementSequenceId,
    regionId: stopDecision?.regionId ?? null,
    stopReason: stopDecision?.stopReason ?? "entry",
    stopMode: stopDecision?.stopMode ?? "sampled-fallback",
    entryPoint,
    entryCell,
    selectedStopPoint,
    appliedStopPoint: interruption?.appliedStopPoint ?? null,
    finalTokenPosition: buildSimplePositionPayload(snapshotTokenState(tokenDocument)),
    animationRedirected: Boolean(interruption?.animationRedirected),
    animationRestartedToStop: Boolean(interruption?.animationRestartedToStop),
    usedTeleportFallback: Boolean(interruption?.usedTeleportFallback),
    usedNativeTruncation: Boolean(interruption?.usedNativeTruncation),
    usedFallback: Boolean(
      interruption?.usedRollbackFallback ||
      interruption?.usedTeleportFallback ||
      interruption?.animationRestartedToStop
    ),
    skippedBecauseAlreadyHandled: Boolean(alreadyApplied),
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

  if (evaluation.enterMovementStopResolution?.stopSkippedBecauseGlobalDisabled) {
    return "global-stop-disabled";
  }

  if (!evaluation.enterMovementStopResolution?.enabled) {
    return "stop-not-supported";
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
    Object.prototype.hasOwnProperty.call(changed ?? {}, "height") ||
    Object.prototype.hasOwnProperty.call(changed ?? {}, "elevation");
}

function hasTranslationChange(changed) {
  return Object.prototype.hasOwnProperty.call(changed ?? {}, "x") ||
    Object.prototype.hasOwnProperty.call(changed ?? {}, "y");
}

function refreshTrackedTokenStates(scene) {
  lastKnownTokenStates.clear();
  regionInsideStates.clear();
  movementDistanceRemainders.clear();
  processedMovementExecutions.clear();
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

  debugVerbose("Refreshed tracked token states.", {
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

function buildMovementFamilyId(tokenDocument, movement, movementPath) {
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

  const firstPoint = points[0] ?? movementPath?.fromState?.position ?? null;
  const lastPoint = points[points.length - 1] ?? movementPath?.toState?.position ?? null;
  if (!firstPoint || !lastPoint) {
    return null;
  }

  return [
    buildMovementPointKey(firstPoint),
    buildMovementPointKey(lastPoint)
  ].join(">");
}

function buildMovementPointKey(point) {
  return [
    Math.round(coerceNumber(point?.x, 0)),
    Math.round(coerceNumber(point?.y, 0)),
    Math.round(coerceNumber(point?.elevation, 0))
  ].join(":");
}

function getHandledMovementInterruption(tokenDocument, movementSequenceId, movementFamilyId = null) {
  cleanupExpiredHandledMovementInterruptions();

  const sequenceKey = buildHandledMovementInterruptionKey(tokenDocument, movementSequenceId, "sequence");
  if (sequenceKey && handledMovementInterruptions.has(sequenceKey)) {
    return handledMovementInterruptions.get(sequenceKey) ?? null;
  }

  const familyKey = buildHandledMovementInterruptionKey(tokenDocument, movementFamilyId, "family");
  if (familyKey && handledMovementInterruptions.has(familyKey)) {
    return handledMovementInterruptions.get(familyKey) ?? null;
  }

  return null;
}

function markHandledMovementInterruption(tokenDocument, movementSequenceId, stopDecision, {
  stopPoint = null,
  usedRollbackFallback = false,
  movementFamilyId = null
} = {}) {
  const sequenceKey = buildHandledMovementInterruptionKey(tokenDocument, movementSequenceId, "sequence");
  const familyKey = buildHandledMovementInterruptionKey(tokenDocument, movementFamilyId, "family");
  if ((!sequenceKey && !familyKey) || !stopDecision) {
    return;
  }

  const record = {
    regionId: stopDecision.regionId ?? null,
    trigger: stopDecision.trigger ?? null,
    stopReason: stopDecision.stopReason ?? null,
    stopMode: stopDecision.stopMode ?? "sampled-fallback",
    stepMode: stopDecision.stepMode ?? null,
    configuredStep: stopDecision.configuredStep ?? null,
    firstInsideCell: buildGridCellPayload(stopDecision.firstInsideCellState),
    stopPoint: stopPoint ?? buildStopPointPayload(stopDecision.stopState),
    onMoveThresholdPoint: buildSimplePositionPayload(stopDecision.onMoveThresholdState),
    stopState: duplicateStopState(stopDecision.stopState),
    usedRollbackFallback,
    movementFamilyId,
    expiresAt: Date.now() + MOVEMENT_SEQUENCE_TTL_MS
  };

  if (sequenceKey) {
    handledMovementInterruptions.set(sequenceKey, record);
  }

  if (familyKey) {
    handledMovementInterruptions.set(familyKey, record);
  }
}

function deleteHandledMovementInterruption(tokenDocument, movementSequenceId, movementFamilyId = null) {
  const sequenceKey = buildHandledMovementInterruptionKey(tokenDocument, movementSequenceId, "sequence");
  const familyKey = buildHandledMovementInterruptionKey(tokenDocument, movementFamilyId, "family");

  if (sequenceKey) {
    handledMovementInterruptions.delete(sequenceKey);
  }

  if (familyKey) {
    handledMovementInterruptions.delete(familyKey);
  }
}

function buildHandledMovementInterruptionKey(tokenDocument, keyValue, scope = "sequence") {
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!tokenUuid || !keyValue) {
    return null;
  }

  return `${tokenUuid}|${scope}|${keyValue}`;
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

export function analyzeMovementAcrossRegion(tokenDocument, regionDocument, pathStates, fromInside, {
  stepDistancePixels = null,
  gridCellStep = null,
  membershipTest = testTokenInsideManagedRegion,
  sampleStepPixels = null
} = {}) {
  const states = compactStatePath(pathStates);
  if (!states.length) {
    return {
      crossedBoundary: false,
      sawEntry: false,
      sawExit: false,
      movementStartedInside: Boolean(fromInside),
      entryConsumedFirstMoveStep: false,
      pathLengthPixels: 0,
      insideDistancePixels: 0,
      remainingInsideDistancePixels: 0,
      insideCellCount: 0,
      remainingInsideCellCount: 0,
      firstEntryState: null,
      firstEntryPathDistancePixels: null,
      firstEntrySegmentIndex: null,
      firstEntryTransitionIndex: null,
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
      firstGridMoveTriggerSegmentIndex: null,
      transitions: []
    };
  }

  let previousInside = Boolean(fromInside);
  let crossedBoundary = false;
  let sawEntry = false;
  let sawExit = false;
  const movementStartedInside = Boolean(fromInside);
  let entryConsumedFirstMoveStep = false;
  let pathLengthPixels = 0;
  let insideDistancePixels = 0;
  let remainingInsideDistancePixels = 0;
  let insideCellCount = 0;
  let remainingInsideCellCount = 0;
  let firstEntryState = null;
  let firstEntryPathDistancePixels = null;
  let firstEntrySegmentIndex = null;
  let firstEntryTransitionIndex = null;
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
  let gridAwareInsideDistancePixels = 0;
  let gridAwareRemainingInsideDistancePixels = 0;
  let entryGridCellConsumed = Boolean(fromInside);
  let entryDistanceConsumed = Boolean(fromInside);
  const transitions = [];

  for (let index = 1; index < states.length; index += 1) {
    const gridTraversalStates = buildGridCellTraversalStates(states[index - 1], states[index]);
    const startingCell = getSquareGridCellCoordinates(states[index - 1]);
    let previousGridState = startingCell
      ? buildStateAtSquareGridCell(states[index - 1], states[index], startingCell.row, startingCell.col, 0)
      : states[index - 1];
    let previousGridInside = membershipTest(tokenDocument, regionDocument, previousGridState);

    for (const gridState of gridTraversalStates) {
      const nativeGridSegmentDistancePixels = measureStateDistanceWithGrid(previousGridState, gridState, regionDocument?.parent);
      gridPathDistancePixels += nativeGridSegmentDistancePixels;
      const gridInside = membershipTest(tokenDocument, regionDocument, gridState);
      const gridInsideContributionPixels = gridInside ? nativeGridSegmentDistancePixels : 0;

      if (!firstInsideCellState && gridInside) {
        firstInsideCellState = gridState;
        firstInsideCellPathDistancePixels = gridPathDistancePixels;
        firstInsideCellSegmentIndex = index;
      }

      if (gridInside) {
        insideCellCount += 1;
        const consumeEntryGridCell = !entryGridCellConsumed;
        if (consumeEntryGridCell) {
          entryGridCellConsumed = true;
          entryConsumedFirstMoveStep = true;
        } else {
          remainingInsideCellCount += 1;
        }

        if (
          !firstGridMoveTriggerState &&
          gridCellStep !== null &&
          gridCellStep > 0 &&
          remainingInsideCellCount >= gridCellStep
        ) {
          firstGridMoveTriggerState = gridState;
          firstGridMoveTriggerPathDistancePixels = gridPathDistancePixels;
          firstGridMoveTriggerSegmentIndex = index;
        }
      }

      gridAwareInsideDistancePixels += gridInsideContributionPixels;
      if (entryGridCellConsumed) gridAwareRemainingInsideDistancePixels += gridInsideContributionPixels;

      previousGridState = gridState;
      previousGridInside = gridInside;
    }

    const segmentSamples = sampleSegmentStates(states[index - 1], states[index], { sampleStepPixels });
    let previousState = states[index - 1];

    for (const sampleState of segmentSamples) {
      const sampleInside = membershipTest(tokenDocument, regionDocument, sampleState);
      const segmentDistancePixels = measureStateDistance(previousState, sampleState);
      const previousInsideDistancePixels = insideDistancePixels;
      const previousRemainingInsideDistancePixels = remainingInsideDistancePixels;
      const insideContributionPixels = segmentDistancePixels * estimateInsideDistanceFactor(previousInside, sampleInside);
      pathLengthPixels += segmentDistancePixels;
      insideDistancePixels += insideContributionPixels;

      const consumeEntryDistance =
        !entryDistanceConsumed &&
        !previousInside &&
        sampleInside &&
        insideContributionPixels > 0;
      if (consumeEntryDistance) {
        entryDistanceConsumed = true;
        entryConsumedFirstMoveStep = true;
      } else {
        remainingInsideDistancePixels += insideContributionPixels;
      }

      if (!firstInsideStepState && sampleInside && segmentDistancePixels > 0) {
        firstInsideStepState = sampleState;
        firstInsideStepPathDistancePixels = pathLengthPixels;
        firstInsideStepSegmentIndex = index;
      }

      if (previousInside !== sampleInside) {
        crossedBoundary = true;
        if (!previousInside && sampleInside) {
          sawEntry = true;
          transitions.push(buildMovementTransition("onEnter", sampleState, {
            pathDistancePixels: pathLengthPixels,
            segmentIndex: index,
            fromInside: previousInside,
            toInside: sampleInside
          }));
          if (!firstEntryState) {
            firstEntryState = sampleState;
            firstEntryPathDistancePixels = pathLengthPixels;
            firstEntrySegmentIndex = index;
            firstEntryTransitionIndex = transitions.length - 1;
          }
        }
        if (previousInside && !sampleInside) {
          sawExit = true;
          transitions.push(buildMovementTransition("onExit", sampleState, {
            pathDistancePixels: pathLengthPixels,
            segmentIndex: index,
            fromInside: previousInside,
            toInside: sampleInside
          }));
        }
      }

      if (
        !firstMoveTriggerState &&
        stepDistancePixels !== null &&
        stepDistancePixels > 0 &&
        previousRemainingInsideDistancePixels < stepDistancePixels &&
        remainingInsideDistancePixels >= stepDistancePixels
      ) {
        firstMoveTriggerState = sampleState;
        firstMoveTriggerPathDistancePixels = pathLengthPixels;
        firstMoveTriggerSegmentIndex = index;
      }

      previousInside = sampleInside;
      previousState = sampleState;
    }
  }

  const useGridAwareDistance = isSquareGridStopModeAvailable(regionDocument?.parent);
  if (useGridAwareDistance) {
    insideDistancePixels = gridAwareInsideDistancePixels;
    remainingInsideDistancePixels = gridAwareRemainingInsideDistancePixels;
  }

  return {
    crossedBoundary,
    sawEntry,
    sawExit,
    transitions,
    movementStartedInside,
    entryConsumedFirstMoveStep,
    pathLengthPixels,
    insideDistancePixels,
    remainingInsideDistancePixels,
    insideCellCount,
    remainingInsideCellCount,
    firstEntryState,
    firstEntryPathDistancePixels,
    firstEntrySegmentIndex,
    firstEntryTransitionIndex,
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

function buildMovementTransition(type, state, {
  pathDistancePixels = 0,
  segmentIndex = null,
  fromInside = null,
  toInside = null
} = {}) {
  return {
    type,
    state,
    position: buildSimplePositionPayload(state),
    center: state?.center ? { x: state.center.x, y: state.center.y } : null,
    pathDistancePixels,
    segmentIndex,
    fromInside,
    toInside
  };
}

function summarizeMovementTransitions(transitions = [], totalPathDistancePixels = 0) {
  const total = Math.max(coerceNumber(totalPathDistancePixels, 0), 0);
  return Array.from(transitions ?? []).map((transition, index) => {
    const pathDistancePixels = coerceNumber(transition?.pathDistancePixels, 0);
    return {
      index,
      type: transition?.type ?? null,
      position: transition?.position ?? buildSimplePositionPayload(transition?.state),
      progress: total > 0 ? pathDistancePixels / total : null,
      pathDistancePixels,
      segmentIndex: transition?.segmentIndex ?? null,
      fromInside: transition?.fromInside ?? null,
      toInside: transition?.toInside ?? null
    };
  });
}

function sampleSegmentStates(fromState, toState, { sampleStepPixels = null } = {}) {
  if (!fromState || !toState) {
    return [];
  }

  const dx = toState.position.x - fromState.position.x;
  const dy = toState.position.y - fromState.position.y;
  const distance = Math.hypot(dx, dy);
  const gridSize = Math.max(coerceNumber(canvas?.grid?.size, 100), 1);
  const requestedStep = coerceNumber(sampleStepPixels, null);
  const effectiveStep = requestedStep !== null && requestedStep > 0
    ? Math.min(gridSize / 2, requestedStep)
    : gridSize / 2;
  const steps = Math.max(1, Math.ceil(distance / Math.max(effectiveStep, 1)));
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

function resolveThinWallSampleStepPixels(regionDocument) {
  const shapes = Array.from(regionDocument?.shapes ?? regionDocument?._source?.shapes ?? []);
  const thicknesses = shapes.flatMap((shape) => {
    const type = String(shape?.type ?? "").toLowerCase();
    if (type === "line") return [coerceNumber(shape?.width, null)];
    if (type === "ring") {
      return [Math.max(0, coerceNumber(shape?.innerWidth, 0)) + Math.max(0, coerceNumber(shape?.outerWidth, 0))];
    }
    return [];
  }).filter((value) => value !== null && value > 0);
  const gridSize = Math.max(coerceNumber(canvas?.grid?.size, 100), 1);
  const minimumThickness = thicknesses.length ? Math.min(...thicknesses) : gridSize / 10;
  return Math.max(1, Math.min(gridSize / 10, minimumThickness / 4));
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

function markRecentMoveTokenEvent(tokenDocument, toState, metadata = {}) {
  recentMoveTokenEvents.set(tokenDocument.uuid, {
    x: toState?.position?.x ?? null,
    y: toState?.position?.y ?? null,
    timestamp: Date.now(),
    ...metadata
  });
}

function completeRecentMoveTokenEvent(tokenDocument, movementSequenceId) {
  const record = recentMoveTokenEvents.get(tokenDocument?.uuid);
  if (!record || record.movementSequenceId !== movementSequenceId) return;
  record.pending = false;
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

  debugVerbose("Resolved token movement mode for Region evaluation.", {
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

export function consumeNativeRegionEventMovementMode(tokenDocument) {
  return resolveMovementModeForEvaluation(tokenDocument, {
    moveSource: "native-attached-region",
    consume: true
  });
}

export function managedMovementModeMatches(actualMovementMode, requiredMovementMode) {
  return movementModeMatches(actualMovementMode, requiredMovementMode);
}

function getMovementInvocationId(tokenDocument, movement, hookSource) {
  if (movement && typeof movement === "object") {
    const existing = movementInvocationIds.get(movement);
    if (existing) return existing;
  }
  movementInvocationCounter += 1;
  const invocationId = `${hookSource}:${tokenDocument?.uuid ?? tokenDocument?.id ?? "token"}:${movementInvocationCounter}`;
  if (movement && typeof movement === "object") movementInvocationIds.set(movement, invocationId);
  return invocationId;
}

function buildMovementExecutionKey({ movementSequenceId, tokenDocument, regionDocument, partId, triggerId }) {
  return [
    regionDocument?.parent?.id ?? tokenDocument?.parent?.id ?? "scene",
    movementSequenceId ?? "sequence-unknown",
    tokenDocument?.uuid ?? tokenDocument?.id ?? "token",
    regionDocument?.id ?? "region",
    partId ?? "part-none",
    triggerId ?? "onMove"
  ].join("|");
}

export function claimMovementExecution(executionKey) {
  cleanupProcessedMovementExecutions();
  const key = String(executionKey ?? "").trim();
  if (!key) return { firstSeen: true, duplicate: false };
  if (processedMovementExecutions.has(key)) return { firstSeen: false, duplicate: true };
  processedMovementExecutions.set(key, Date.now() + MOVEMENT_SEQUENCE_TTL_MS);
  return { firstSeen: true, duplicate: false };
}

function cleanupProcessedMovementExecutions() {
  const now = Date.now();
  for (const [key, expiresAt] of processedMovementExecutions.entries()) {
    if (expiresAt <= now) processedMovementExecutions.delete(key);
  }
}

function measureStateDistanceWithGrid(fromState, toState, scene = canvas?.scene ?? null) {
  // Token movement is measured from its document anchor. Using the footprint
  // center here would make Large tokens travel farther when a grid cell is rebuilt.
  const fromPoint = fromState?.position ?? fromState?.center ?? null;
  const toPoint = toState?.position ?? toState?.center ?? null;
  if (!fromPoint || !toPoint) return 0;

  try {
    const result = canvas?.grid?.measurePath?.([fromPoint, toPoint]);
    const measuredDistance = coerceNumber(result?.distance, null);
    if (measuredDistance !== null && measuredDistance >= 0) {
      return distanceToPixels(measuredDistance, scene);
    }
  } catch {
    // Fall back to geometric distance when the native grid API is unavailable.
  }

  return measureStateDistance(fromState, toState);
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
