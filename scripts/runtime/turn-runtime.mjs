import { applyConfiguredTriggerEffect } from "./entry-effects.mjs";
import {
  debug,
  evaluateManagedRegionTargetFilter,
  findManagedRegions,
  getRegionRuntimeFlags,
  getTokenCenter,
  isPrimaryGM,
  testTokenInsideManagedRegion
} from "./utils.mjs";

const combatStateCache = new Map();
const processedTurnEffects = new Map();

let hooksRegistered = false;

export function registerTurnRuntimeHooks() {
  if (hooksRegistered) {
    return;
  }

  Hooks.on("createCombat", onCreateCombat);
  Hooks.on("updateCombat", onUpdateCombat);
  Hooks.on("deleteCombat", onDeleteCombat);

  hooksRegistered = true;
}

export function primeTurnRuntimeState() {
  if (!isPrimaryGM()) {
    return;
  }

  combatStateCache.clear();

  for (const combat of game.combats?.contents ?? []) {
    combatStateCache.set(combat.id, snapshotCombatState(combat));
  }

  debug("Primed persistent-zones turn runtime state.", {
    trackedCombats: combatStateCache.size
  });
}

function onCreateCombat(combat) {
  if (!isPrimaryGM()) {
    return;
  }

  combatStateCache.set(combat.id, snapshotCombatState(combat));
}

async function onUpdateCombat(combat, changed) {
  if (!isPrimaryGM()) {
    return;
  }

  const previousState = combatStateCache.get(combat.id) ?? null;
  const currentState = snapshotCombatState(combat);
  combatStateCache.set(combat.id, currentState);

  if (!didCombatTimingChange(previousState, currentState, changed)) {
    return;
  }

  await processCombatTiming(combat, previousState, "end");
  await processCombatTiming(combat, currentState, "start");
  cleanupProcessedTurnEffects(combat.id, currentState.round);
}

function onDeleteCombat(combat) {
  combatStateCache.delete(combat?.id ?? null);
  clearProcessedTurnEffectsForCombat(combat?.id ?? null);
}

async function processCombatTiming(combat, state, timing) {
  if (!state?.combatantId) {
    return;
  }

  const tokenDocument = resolveCombatantTokenDocument(combat, state);
  const scene = tokenDocument?.parent ?? game.scenes?.get?.(combat?.sceneId) ?? null;

  if (!scene || !tokenDocument?.actor) {
    return;
  }

  const managedRegions = findManagedRegions(scene);
  if (!managedRegions.length) {
    return;
  }

  for (const regionDocument of managedRegions) {
    const runtime = getRegionRuntimeFlags(regionDocument);
    const normalizedDefinition = runtime?.normalizedDefinition ?? null;
    const triggerConfig = getTurnTriggerConfig(normalizedDefinition, timing);
    const partId =
      runtime?.partId ??
      runtime?.part?.id ??
      normalizedDefinition?.part?.id ??
      null;
    const triggerTiming = timing === "start" ? "onStartTurn" : "onEndTurn";
    const triggerMode = String(triggerConfig?.mode ?? "none");
    const selectedActivity =
      triggerConfig?.activity?.id ??
      triggerConfig?.activityId ??
      null;
    const filterResult = evaluateManagedRegionTargetFilter(
      tokenDocument,
      regionDocument,
      normalizedDefinition
    );
    const tokenInside = testTokenInsideManagedRegion(
      tokenDocument,
      regionDocument,
      snapshotTokenState(tokenDocument)
    );
    const dedupeKey = buildTurnEffectKey(combat, state, timing, tokenDocument, regionDocument);
    const alreadyApplied = processedTurnEffects.has(dedupeKey);

    let effectApplied = false;

    if (normalizedDefinition?.enabled && triggerConfig.enabled && tokenInside && !filterResult.allowed) {
      debug("Skipped managed Region turn effect because target filter rejected the token.", {
        combatId: combat?.id ?? null,
        round: state.round,
        turn: state.turn,
        tokenId: tokenDocument.id,
        regionId: regionDocument.id,
        partId,
        triggerTiming,
        targetFilter: filterResult.targetFilter,
        targetMatched: filterResult.targetMatched,
        sourceActorUuid: filterResult.sourceActorUuid ?? null,
        sourceTokenId: filterResult.sourceTokenId ?? null,
        sourceDisposition: filterResult.sourceDisposition ?? null,
        targetActorUuid: filterResult.targetActorUuid ?? null,
        targetDisposition: filterResult.targetDisposition ?? null,
        reason: filterResult.reason
      });
    }

    if (
      normalizedDefinition?.enabled &&
      triggerConfig.enabled &&
      tokenInside &&
      filterResult.allowed &&
      !alreadyApplied
    ) {
      const application = await applyConfiguredTriggerEffect({
        regionDocument,
        tokenDocument,
        triggerConfig,
        timing: triggerTiming
      });

      if (!application.skipped) {
        processedTurnEffects.set(dedupeKey, {
          combatId: combat.id,
          round: state.round,
          turn: state.turn,
          timing
        });
      }

      effectApplied = Boolean(application.applied && !application.skipped);
    }

    debug("Checked managed Region turn effect.", {
      combatId: combat?.id ?? null,
      round: state.round,
      turn: state.turn,
      tokenId: tokenDocument.id,
      regionId: regionDocument.id,
      partId,
      triggerTiming,
      triggerMode,
      selectedActivity,
      targetFilter: filterResult.targetFilter,
      targetMatched: filterResult.targetMatched,
      sourceActorUuid: filterResult.sourceActorUuid ?? null,
      sourceTokenId: filterResult.sourceTokenId ?? null,
      sourceDisposition: filterResult.sourceDisposition ?? null,
      targetActorUuid: filterResult.targetActorUuid ?? null,
      targetDisposition: filterResult.targetDisposition ?? null,
      tokenInside,
      alreadyApplied,
      effectApplied,
      skippedBecauseTargetFilter: tokenInside && !filterResult.allowed,
      reason: !filterResult.allowed ? filterResult.reason : null
    });
  }
}

function snapshotCombatState(combat) {
  const combatant = combat?.combatant ?? null;

  return {
    combatantId: combatant?.id ?? null,
    tokenId: combatant?.tokenId ?? combatant?.token?.id ?? null,
    round: Number(combat?.round ?? 0) || 0,
    turn: Number(combat?.turn ?? -1) || -1
  };
}

function didCombatTimingChange(previousState, currentState, changed) {
  if (!previousState) {
    return Boolean(currentState?.combatantId);
  }

  if (
    previousState.combatantId !== currentState?.combatantId ||
    previousState.round !== currentState?.round ||
    previousState.turn !== currentState?.turn
  ) {
    return true;
  }

  return Boolean(
    Object.prototype.hasOwnProperty.call(changed ?? {}, "round") ||
    Object.prototype.hasOwnProperty.call(changed ?? {}, "turn") ||
    Object.prototype.hasOwnProperty.call(changed ?? {}, "combatantId")
  );
}

function resolveCombatantTokenDocument(combat, state) {
  const combatant = combat?.combatants?.get?.(state?.combatantId ?? "") ?? null;
  if (!combatant) {
    return null;
  }

  return (
    combatant.token?.document ??
    combatant.token ??
    game.scenes?.get?.(combat?.sceneId)?.tokens?.get?.(combatant.tokenId) ??
    null
  );
}

function getTurnTriggerConfig(normalizedDefinition, timing) {
  if (timing === "start") {
    return normalizedDefinition?.triggers?.onStartTurn ?? {};
  }

  return normalizedDefinition?.triggers?.onEndTurn ?? {};
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

function buildTurnEffectKey(combat, state, timing, tokenDocument, regionDocument) {
  return [
    combat?.id ?? "combat",
    state?.round ?? 0,
    state?.turn ?? -1,
    timing,
    tokenDocument?.uuid ?? tokenDocument?.id ?? "token",
    regionDocument?.uuid ?? regionDocument?.id ?? "region"
  ].join("|");
}

function cleanupProcessedTurnEffects(combatId, currentRound) {
  const minimumRound = Number(currentRound ?? 0) - 1;

  for (const [key, entry] of processedTurnEffects.entries()) {
    if (entry.combatId !== combatId) {
      continue;
    }

    if (entry.round < minimumRound) {
      processedTurnEffects.delete(key);
    }
  }
}

function clearProcessedTurnEffectsForCombat(combatId) {
  if (!combatId) {
    return;
  }

  for (const [key, entry] of processedTurnEffects.entries()) {
    if (entry.combatId === combatId) {
      processedTurnEffects.delete(key);
    }
  }
}
