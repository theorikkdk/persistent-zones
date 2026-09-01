import {
  debug,
  coerceNumber,
  error,
  evaluateTriggerTargetFilter,
  fromUuidSafe,
  getRegionRuntimeFlags,
  pickFirstDefined
} from "./utils.mjs";
import { MODULE_ID } from "../constants.mjs";
import {
  normalizeZoneTriggerActivityType,
  resolveZoneTriggeredActivityCompatibility
} from "./activity-compatibility.mjs";
import { resolveTriggerActionConfiguration } from "./trigger-action-config.mjs";
import { buildStatusRecoveryPatch } from "./status-recovery.mjs";
import { buildStatusEscapeEffectFlag, normalizeStatusEscape } from "./status-escape.mjs";
import { ensureAggregateStatus } from "./status-state.mjs";
import { buildSimpleSaveResult, rollSimpleActorSave } from "./simple-save.mjs";
import {
  buildRecoveryGroupKey,
  buildRecoverySourceIdentity,
  reconcileRecoveryArbitration
} from "./status-recovery-arbitration.mjs";
import { claimTriggerFrequency } from "./trigger-frequency.mjs";

export async function applyOnEnterEffect({
  regionDocument,
  tokenDocument,
  normalizedDefinition
}) {
  return applyConfiguredTriggerEffect({
    regionDocument,
    tokenDocument,
    triggerConfig: normalizedDefinition?.triggers?.onEnter ?? {},
    timing: "onEnter"
  });
}

export async function applyConfiguredTriggerEffect({
  regionDocument,
  tokenDocument,
  triggerConfig,
  timing = "custom",
  context = {}
}) {
  const actor = tokenDocument?.actor ?? null;
  const normalizedTiming = String(timing || "custom");
  const configuredTrigger = triggerConfig ?? {};
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const partId = runtime.partId ?? runtime.part?.id ?? runtime.normalizedDefinition?.part?.id ?? null;
  const actionConfig = resolveTriggerActionConfiguration({
    zoneConfiguration: runtime.normalizedDefinition,
    triggerId: normalizedTiming,
    triggerConfig: configuredTrigger
  });
  const resolvedTrigger = {
    ...configuredTrigger,
    mode: actionConfig.mode,
    targetFilter: actionConfig.targetFilter,
    frequency: actionConfig.frequency,
    frequencyGroup: actionConfig.frequencyGroup,
    requiredAbsentStatuses: actionConfig.requiredAbsentStatuses,
    requiredAbsentSourceStatuses: actionConfig.requiredAbsentSourceStatuses,
    damage: actionConfig.damage,
    save: actionConfig.save,
    statuses: actionConfig.statuses,
    healing: actionConfig.healing,
    temporaryHitPoints: actionConfig.temporaryHitPoints,
    simpleEffect: {
      ...(configuredTrigger.simpleEffect ?? {}),
      healing: actionConfig.healing,
      temporaryHitPoints: actionConfig.temporaryHitPoints,
      statuses: actionConfig.statuses
    },
    linkedActivity: actionConfig.linkedActivity,
    activity: actionConfig.linkedActivity
  };
  const triggerMode = actionConfig.mode;
  const isV14RingRuntime = runtime.regionSourceStrategy === "v14-region-native-segment-group" ||
    String(runtime.geometryType ?? runtime.normalizedDefinition?.geometry?.type ?? "").toLowerCase() === "ring";
  const baseDiagnostic = {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    actorUuid: actor?.uuid ?? null,
    partId,
    groupId: runtime.groupId ?? null,
    architecturePath: runtime.architecturePath ?? null,
    geometryType: runtime.geometryType ?? runtime.normalizedDefinition?.geometry?.type ?? null,
    regionSourceStrategy: runtime.regionSourceStrategy ?? null,
    regionSegmentIndex: runtime.regionSegmentIndex ?? null,
    regionSegmentCount: runtime.regionSegmentCount ?? null,
    triggerTiming: normalizedTiming,
    triggerMode,
    movementSequenceId: context.movementSequenceId ?? null,
    triggerType: context.triggerType ?? normalizedTiming,
    previousInside: context.previousInside ?? null,
    currentInside: context.currentInside ?? null
  };

  const targetFilterDecision = evaluateTriggerTargetFilter({
    regionDocument,
    runtime,
    triggerConfig: resolvedTrigger,
    triggerId: normalizedTiming,
    tokenDocument
  });
  if (!targetFilterDecision.allowed) {
    return buildSkippedResult(`Target filter rejected the ${normalizedTiming} trigger.`, {
      ...baseDiagnostic,
      timing: normalizedTiming,
      partId,
      triggerMode,
      targetFilter: targetFilterDecision
    });
  }

  logV14RuntimeDiagnostic("triggerTiming", baseDiagnostic);
  logV14RuntimeDiagnostic("PZ EFFECT CONFIG RESOLVED", {
    ...baseDiagnostic,
    onEnterEnabled: normalizedTiming === "onEnter" ? Boolean(configuredTrigger?.enabled) : null,
    onMoveEnabled: normalizedTiming === "onMove" ? Boolean(configuredTrigger?.enabled) : null,
    effectMode: triggerMode,
    simpleEffect: resolvedTrigger?.simpleEffect ?? null,
    damageFormula: resolvedTrigger?.damage?.formula ?? resolvedTrigger?.simpleEffect?.formula ?? null,
    damageType: resolvedTrigger?.damage?.type ?? resolvedTrigger?.simpleEffect?.damageType ?? null,
    activityUuid: resolvedTrigger?.activity?.uuid ?? null,
    skippedReason: null
  });

  if (!actor) {
    logPzEffectSkipped("token-has-no-actor", baseDiagnostic, resolvedTrigger);
    logV14RuntimeDiagnostic("simpleEffectSuppressed", {
      ...baseDiagnostic,
      simpleEffectAllowed: false,
      simpleEffectSuppressed: true,
      simpleEffectSuppressedReason: "token-has-no-actor"
    });
    return buildSkippedResult("Token has no Actor.", {
      ...baseDiagnostic,
      timing: normalizedTiming,
      partId,
      triggerMode
    });
  }

  if (!actionConfig.enabled) {
    logPzEffectSkipped("trigger-disabled", baseDiagnostic, resolvedTrigger);
    logV14RuntimeDiagnostic("simpleEffectSuppressed", {
      ...baseDiagnostic,
      simpleEffectAllowed: false,
      simpleEffectSuppressed: true,
      simpleEffectSuppressedReason: "trigger-disabled"
    });
    return buildSkippedResult(`${normalizedTiming} is not enabled.`, {
      ...baseDiagnostic,
      timing: normalizedTiming,
      partId,
      triggerMode
    });
  }

  if (triggerMode === "none") {
    debug(`Skipped ${normalizedTiming} effect because mode = none.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      partId,
      timing: normalizedTiming,
      triggerMode
    });

    logPzEffectSkipped("no-effect-configured", baseDiagnostic, resolvedTrigger);
    logV14RuntimeDiagnostic("simpleEffectSuppressed", {
      ...baseDiagnostic,
      simpleEffectAllowed: false,
      simpleEffectSuppressed: true,
      simpleEffectSuppressedReason: "trigger-mode-none"
    });
    return buildSkippedResult(`${normalizedTiming} mode is none.`, {
      ...baseDiagnostic,
      timing: normalizedTiming,
      partId,
      triggerMode
    });
  }

  const absentStatusConflict = findRequiredAbsentStatusConflict(actor, resolvedTrigger.requiredAbsentStatuses);
  if (absentStatusConflict) {
    return buildSkippedResult(`${normalizedTiming} requires status ${absentStatusConflict} to be absent.`, {
      ...baseDiagnostic,
      timing: normalizedTiming,
      partId,
      triggerMode,
      requiredAbsentStatus: absentStatusConflict
    });
  }

  const absentSourceStatusConflict = findRequiredAbsentSourceStatusConflict({
    actor,
    regionDocument,
    tokenDocument,
    partId,
    requiredAbsentSourceStatuses: resolvedTrigger.requiredAbsentSourceStatuses
  });
  if (absentSourceStatusConflict) {
    return buildSkippedResult(`${normalizedTiming} requires source status ${absentSourceStatusConflict} to be absent.`, {
      ...baseDiagnostic,
      timing: normalizedTiming,
      partId,
      triggerMode,
      requiredAbsentSourceStatus: absentSourceStatusConflict
    });
  }

  const frequencyDecision = await claimTriggerFrequency({ regionDocument, tokenDocument, triggerConfig: resolvedTrigger, timing: normalizedTiming });
  logV14RuntimeDiagnostic("PZ TRIGGER FREQUENCY DECISION", {
    ...baseDiagnostic,
    frequency: frequencyDecision.frequency,
    frequencyGroup: frequencyDecision.identity?.frequencyGroup ?? resolvedTrigger?.frequencyGroup ?? null,
    frequencyAllowed: frequencyDecision.allowed,
    frequencyReason: frequencyDecision.reason,
    combatId: frequencyDecision.identity?.combatId ?? null,
    round: frequencyDecision.identity?.round ?? null,
    turn: frequencyDecision.identity?.turn ?? null
  });
  if (!frequencyDecision.allowed) {
    return buildSkippedResult(`${normalizedTiming} already applied for this frequency group this turn.`, { ...baseDiagnostic, timing: normalizedTiming, partId, triggerMode, frequency: frequencyDecision.frequency, frequencyReason: frequencyDecision.reason });
  }

  if (triggerMode === "activity") {
    logV14RuntimeDiagnostic("PZ EFFECT EXECUTOR SELECTED", {
      ...baseDiagnostic,
      effectMode: triggerMode,
      executor: "activity",
      activityUuid: resolvedTrigger?.activity?.uuid ?? null,
      damageFormula: null,
      damageType: null
    });
    return applyActivityTriggerEffect({
      regionDocument,
      tokenDocument,
      triggerConfig: resolvedTrigger,
      timing: normalizedTiming,
      partId,
      context
    });
  }

  const simpleEffect = resolveSimpleEffectConfig(resolvedTrigger);
  logV14RuntimeDiagnostic("PZ EFFECT EXECUTOR SELECTED", {
    ...baseDiagnostic,
    effectMode: triggerMode,
    executor: "simple",
    simpleEffect,
    damageFormula: simpleEffect.formula ?? resolvedTrigger?.damage?.formula ?? null,
    damageType: simpleEffect.damageType ?? resolvedTrigger?.damage?.type ?? null,
    activityUuid: resolvedTrigger?.activity?.uuid ?? null
  });
  logV14RuntimeDiagnostic("simpleEffectType", {
    ...baseDiagnostic,
    simpleEffectType: simpleEffect.type,
    simpleEffectFormula: simpleEffect.formula ?? null,
    simpleEffectAllowed: true
  });

  if (simpleEffect.type !== "damage" && !simpleEffect.formula) {
    logPzEffectSkipped("no-damage-formula", baseDiagnostic, resolvedTrigger, simpleEffect);
    logV14RuntimeDiagnostic("simpleEffectSuppressed", {
      ...baseDiagnostic,
      simpleEffectType: simpleEffect.type,
      simpleEffectFormula: simpleEffect.formula ?? null,
      simpleEffectAllowed: false,
      simpleEffectSuppressed: true,
      simpleEffectSuppressedReason: "missing-simple-effect-formula"
    });
    return buildSkippedResult(`${normalizedTiming} has no enabled simple effect formula.`, {
      ...baseDiagnostic,
      timing: normalizedTiming,
      partId,
      triggerMode,
      simpleEffectType: simpleEffect.type,
      simpleEffectFormula: simpleEffect.formula ?? null
    });
  }

  const statusesEnabled = Boolean(resolvedTrigger.statuses?.enabled && resolvedTrigger.statuses?.statusId);
  const healingEnabled = Boolean(resolvedTrigger.healing?.enabled && resolvedTrigger.healing?.formula);
  const temporaryHitPointsEnabled = Boolean(
    resolvedTrigger.temporaryHitPoints?.enabled && resolvedTrigger.temporaryHitPoints?.formula
  );
  if (
    simpleEffect.type === "damage" &&
    !resolvedTrigger.damage?.enabled &&
    !resolvedTrigger.save?.enabled &&
    !statusesEnabled &&
    !healingEnabled &&
    !temporaryHitPointsEnabled
  ) {
    logPzEffectSkipped("no-effect-configured", baseDiagnostic, resolvedTrigger, simpleEffect);
    logV14RuntimeDiagnostic("simpleEffectSuppressed", {
      ...baseDiagnostic,
      simpleEffectType: simpleEffect.type,
      simpleEffectFormula: simpleEffect.formula ?? null,
      simpleEffectAllowed: false,
      simpleEffectSuppressed: true,
      simpleEffectSuppressedReason: "damage-and-save-disabled"
    });
    return buildSkippedResult(`${normalizedTiming} has no enabled save or damage.`, {
      ...baseDiagnostic,
      timing: normalizedTiming,
      partId,
      triggerMode,
      simpleEffectType: simpleEffect.type,
      simpleEffectFormula: simpleEffect.formula ?? null
    });
  }

  try {
    logV14RuntimeDiagnostic("PZ EFFECT EXECUTION START", {
      ...baseDiagnostic,
      effectMode: triggerMode,
      simpleEffect,
      damageFormula: simpleEffect.formula ?? resolvedTrigger?.damage?.formula ?? null,
      damageType: simpleEffect.damageType ?? resolvedTrigger?.damage?.type ?? null,
      activityUuid: resolvedTrigger?.activity?.uuid ?? null,
      skippedReason: null
    });
    if (simpleEffect.type === "heal" || simpleEffect.type === "tempHP") {
      const simpleRecoveryResult = await resolveSimpleRecoveryResult(
        simpleEffect,
        regionDocument,
        tokenDocument,
        normalizedTiming
      );
      const effectEntries = simpleRecoveryResult.rolledTotal > 0
        ? [{
          value: simpleRecoveryResult.rolledTotal,
          type: simpleEffect.type === "heal" ? "healing" : "temphp",
          properties: new Set()
        }]
        : [];
      await applyDamageEntriesToActor(actor, effectEntries);
      const effectSummary = summarizeDamageEntries(effectEntries);

      debug(`Applied ${normalizedTiming} simple effect.`, {
        regionId: regionDocument?.id ?? null,
        tokenId: tokenDocument?.id ?? null,
        actorUuid: actor.uuid,
        partId,
        timing: normalizedTiming,
        triggerMode,
        simpleEffectType: simpleEffect.type,
        simpleEffectFormula: simpleEffect.formula ?? null,
        simpleEffectApplied: effectEntries.length > 0,
        healApplied: effectSummary.healingTotal,
        tempHpApplied: effectSummary.tempHpTotal
      });
      logV14RuntimeDiagnostic("simpleEffectApplied", {
        ...baseDiagnostic,
        simpleEffectType: simpleEffect.type,
        simpleEffectFormula: simpleEffect.formula ?? null,
        simpleEffectApplied: effectEntries.length > 0,
        healApplied: effectSummary.healingTotal,
        tempHpApplied: effectSummary.tempHpTotal
      });
      logV14RuntimeDiagnostic("PZ EFFECT EXECUTION SUCCESS", {
        ...baseDiagnostic,
        effectMode: triggerMode,
        simpleEffect,
        damageFormula: simpleEffect.formula ?? null,
        damageType: simpleEffect.damageType ?? null,
        activityUuid: resolvedTrigger?.activity?.uuid ?? null,
        applied: effectEntries.length > 0,
        skippedReason: effectEntries.length > 0 ? null : "no-effect-configured"
      });
      logV14RuntimeDiagnostic("partTriggerApplied", {
        ...baseDiagnostic,
        applied: effectEntries.length > 0,
        skipped: effectEntries.length === 0
      });
      if (isV14RingRuntime) {
        logV14RuntimeDiagnostic("v14RingEffectApplied", {
          ...baseDiagnostic,
          v14RingEffectApplied: effectEntries.length > 0,
          skipped: effectEntries.length === 0,
          healApplied: effectSummary.healingTotal,
          tempHpApplied: effectSummary.tempHpTotal
        });
      }
      return {
        applied: effectEntries.length > 0,
        skipped: effectEntries.length === 0,
        partId,
        triggerMode,
        timing: normalizedTiming,
        simpleEffectType: simpleEffect.type,
        simpleEffectFormula: simpleEffect.formula ?? null,
        simpleEffectApplied: effectEntries.length > 0,
        healApplied: effectSummary.healingTotal,
        tempHpApplied: effectSummary.tempHpTotal,
        healing: {
          type: "simple",
          effectType: simpleEffect.type,
          formula: simpleRecoveryResult.formula,
          rolledTotal: simpleRecoveryResult.rolledTotal,
          summary: effectSummary
        }
      };
    }

    const saveResult = resolvedTrigger.save?.enabled
      ? await resolveSaveResult(actor, resolvedTrigger.save, regionDocument, tokenDocument, normalizedTiming)
      : null;

    if (saveResult?.unresolved) {
      logPzEffectSkipped("save-dc-unresolved", baseDiagnostic, resolvedTrigger, simpleEffect);
      logV14RuntimeDiagnostic("simpleEffectSuppressed", {
        ...baseDiagnostic,
        simpleEffectType: simpleEffect.type,
        simpleEffectFormula: simpleEffect.formula ?? null,
        simpleEffectAllowed: false,
        simpleEffectSuppressed: true,
        simpleEffectSuppressedReason: "save-dc-unresolved"
      });
      return buildSkippedResult("Save DC could not be resolved.", {
        ...baseDiagnostic,
        timing: normalizedTiming,
        partId,
        triggerMode,
        save: saveResult
      });
    }

    const damageResult = resolvedTrigger.damage?.enabled
      ? await resolveDamageResult(
        resolvedTrigger.damage,
        saveResult,
        regionDocument,
        tokenDocument,
        normalizedTiming
      )
      : buildNoDamageResult(resolvedTrigger.damage);
    const appliedDamage = coerceNumber(damageResult?.appliedDamage, 0);

    if (appliedDamage > 0) {
      await applyDamageToActor(actor, appliedDamage);
    }
    logV14RuntimeDiagnostic("damageRoll", {
      ...baseDiagnostic,
      damageFormula: damageResult?.formula ?? resolvedTrigger?.damage?.formula ?? null,
      damageType: damageResult?.type ?? resolvedTrigger?.damage?.type ?? null,
      rolledDamage: damageResult?.rolledDamage ?? null,
      appliedDamage
    });
    logV14RuntimeDiagnostic("damageApplied", {
      ...baseDiagnostic,
      appliedDamage,
      damageType: damageResult?.type ?? resolvedTrigger?.damage?.type ?? null
    });

    const statusResult = await applyTriggeredStatuses({
      regionDocument,
      tokenDocument,
      triggerConfig: resolvedTrigger,
      timing: normalizedTiming,
      saveResult,
      baseDiagnostic
    });
    const healingResult = await applySimpleRecoveryEffect({
      actor,
      regionDocument,
      tokenDocument,
      timing: normalizedTiming,
      type: "heal",
      config: resolvedTrigger.healing
    });
    const temporaryHitPointsResult = await applySimpleRecoveryEffect({
      actor,
      regionDocument,
      tokenDocument,
      timing: normalizedTiming,
      type: "tempHP",
      config: resolvedTrigger.temporaryHitPoints
    });
    const recoverySummary = summarizeDamageEntries([
      ...(healingResult.entries ?? []),
      ...(temporaryHitPointsResult.entries ?? [])
    ]);
    const simpleEffectApplied = Boolean(
      saveResult ||
      resolvedTrigger.damage?.enabled ||
      statusResult.applied ||
      healingResult.applied ||
      temporaryHitPointsResult.applied
    );

    debug(`Applied ${normalizedTiming} simple effect.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      actorUuid: actor.uuid,
      partId,
      timing: normalizedTiming,
      triggerMode,
      simpleEffectType: simpleEffect.type,
      simpleEffectFormula: simpleEffect.formula ?? null,
      simpleEffectApplied,
      save: saveResult,
      damage: damageResult,
      appliedDamage,
      healApplied: recoverySummary.healingTotal,
      tempHpApplied: recoverySummary.tempHpTotal
    });
    logV14RuntimeDiagnostic("simpleEffectApplied", {
      ...baseDiagnostic,
      simpleEffectType: simpleEffect.type,
      simpleEffectFormula: simpleEffect.formula ?? null,
      simpleEffectApplied,
      save: saveResult,
      damage: damageResult,
      appliedDamage,
      healApplied: recoverySummary.healingTotal,
      tempHpApplied: recoverySummary.tempHpTotal
    });
    logV14RuntimeDiagnostic("PZ EFFECT EXECUTION SUCCESS", {
      ...baseDiagnostic,
      effectMode: triggerMode,
      simpleEffect,
      damageFormula: simpleEffect.formula ?? resolvedTrigger?.damage?.formula ?? null,
      damageType: simpleEffect.damageType ?? resolvedTrigger?.damage?.type ?? null,
      activityUuid: resolvedTrigger?.activity?.uuid ?? null,
      applied: simpleEffectApplied,
      appliedDamage,
      skippedReason: null
    });
    logV14RuntimeDiagnostic("partTriggerApplied", {
      ...baseDiagnostic,
      applied: simpleEffectApplied,
      skipped: false,
      appliedDamage,
      healApplied: recoverySummary.healingTotal,
      tempHpApplied: recoverySummary.tempHpTotal
    });
    if (isV14RingRuntime) {
      logV14RuntimeDiagnostic("v14RingEffectApplied", {
        ...baseDiagnostic,
        v14RingEffectApplied: simpleEffectApplied,
        skipped: false,
        appliedDamage,
        healApplied: recoverySummary.healingTotal,
        tempHpApplied: recoverySummary.tempHpTotal
      });
    }
    return {
      applied: simpleEffectApplied,
      skipped: false,
      partId,
      triggerMode,
      timing: normalizedTiming,
      simpleEffectType: simpleEffect.type,
      simpleEffectFormula: simpleEffect.formula ?? null,
      simpleEffectApplied,
      save: saveResult,
      damage: damageResult,
      statuses: statusResult,
      healing: healingResult,
      temporaryHitPoints: temporaryHitPointsResult,
      appliedDamage,
      healApplied: recoverySummary.healingTotal,
      tempHpApplied: recoverySummary.tempHpTotal
    };
  } catch (caughtError) {
    logV14RuntimeDiagnostic("PZ EFFECT EXECUTION FAILED", {
      ...baseDiagnostic,
      effectMode: triggerMode,
      simpleEffect: typeof simpleEffect !== "undefined" ? simpleEffect : null,
      damageFormula: typeof simpleEffect !== "undefined" ? simpleEffect?.formula ?? null : null,
      damageType: typeof simpleEffect !== "undefined" ? simpleEffect?.damageType ?? null : null,
      activityUuid: resolvedTrigger?.activity?.uuid ?? null,
      skippedReason: "effect-execution-error",
      error: caughtError?.message ?? "unknown"
    });
    error("Failed to apply configured trigger effect.", caughtError, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      partId,
      timing: normalizedTiming
    });

    return buildSkippedResult("Effect application failed.", {
      ...baseDiagnostic,
      timing: normalizedTiming,
      partId,
      triggerMode,
      error: caughtError?.message ?? "unknown"
    });
  }
}

export async function cleanupWhileInsideStatusesForRegionToken({
  regionDocument,
  tokenDocument,
  triggerId = null,
  cleanupReason = "region-exit"
} = {}) {
  const actor = tokenDocument?.actor ?? null;
  const regionId = regionDocument?.id ?? null;
  const sceneId = regionDocument?.parent?.id ?? canvas?.scene?.id ?? null;
  const tokenUuid = tokenDocument?.uuid ?? null;
  const matchedEffects = Array.from(actor?.effects ?? []).filter((effect) => {
    const flags = effect?.flags?.[MODULE_ID] ?? {};
    if (!flags.managedTriggeredEffect || flags.persistenceMode !== "while-inside-region") {
      return false;
    }
    if (flags.sceneId !== sceneId || flags.regionId !== regionId || flags.tokenUuid !== tokenUuid) {
      return false;
    }
    return !triggerId || flags.triggerId === triggerId;
  });
  const persistentEffects = Array.from(actor?.effects ?? []).filter((effect) => {
    const flags = effect?.flags?.[MODULE_ID] ?? {};
    return flags.managedTriggeredEffect &&
      flags.persistenceMode === "persistent" &&
      flags.sceneId === sceneId &&
      flags.regionId === regionId &&
      flags.tokenUuid === tokenUuid;
  });
  const matchedEffectIds = matchedEffects.map((effect) => effect.id).filter(Boolean);
  const removedEffectIds = [];
  const errors = [];

  for (const effectId of matchedEffectIds) {
    try {
      await actor.deleteEmbeddedDocuments("ActiveEffect", [effectId], { persistentZonesTriggeredStatusCleanup: true });
      removedEffectIds.push(effectId);
    } catch (caughtError) {
      errors.push(caughtError?.message ?? "unknown");
    }
  }

  logV14RuntimeDiagnostic("PZ WHILE INSIDE STATUS CLEANUP RESULT", {
    sceneId,
    regionId,
    tokenUuid,
    triggerId,
    matchedEffectIds,
    removedEffectIds,
    preservedPersistentEffectIds: persistentEffects.map((effect) => effect.id).filter(Boolean),
    cleanupReason,
    cleanupSucceeded: errors.length === 0,
    errors
  });

  return {
    matchedEffectIds,
    removedEffectIds,
    preservedPersistentEffectIds: persistentEffects.map((effect) => effect.id).filter(Boolean),
    cleanupSucceeded: errors.length === 0,
    errors
  };
}

export async function cleanupWhileInsideStatusesForRegion({
  regionDocument,
  cleanupReason = "region-deleted"
} = {}) {
  const sceneId = regionDocument?.parent?.id ?? canvas?.scene?.id ?? null;
  const regionId = regionDocument?.id ?? null;
  const matchedEffectIds = [];
  const removedEffectIds = [];
  const preservedPersistentEffectIds = [];
  const errors = [];

  for (const actor of game.actors?.contents ?? []) {
    const actorMatches = Array.from(actor?.effects ?? []).filter((effect) => {
      const flags = effect?.flags?.[MODULE_ID] ?? {};
      if (!flags.managedTriggeredEffect || flags.sceneId !== sceneId || flags.regionId !== regionId) {
        return false;
      }
      if (flags.persistenceMode === "persistent") {
        preservedPersistentEffectIds.push(effect.id);
        return false;
      }
      return flags.persistenceMode === "while-inside-region";
    });
    const ids = actorMatches.map((effect) => effect.id).filter(Boolean);
    matchedEffectIds.push(...ids);
    if (!ids.length) {
      continue;
    }

    try {
      await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { persistentZonesTriggeredStatusCleanup: true });
      removedEffectIds.push(...ids);
    } catch (caughtError) {
      errors.push(caughtError?.message ?? "unknown");
    }
  }

  logV14RuntimeDiagnostic("PZ WHILE INSIDE STATUS CLEANUP RESULT", {
    sceneId,
    regionId,
    tokenUuid: null,
    triggerId: null,
    matchedEffectIds,
    removedEffectIds,
    preservedPersistentEffectIds,
    cleanupReason,
    cleanupSucceeded: errors.length === 0,
    errors
  });

  return {
    matchedEffectIds,
    removedEffectIds,
    preservedPersistentEffectIds,
    cleanupSucceeded: errors.length === 0,
    errors
  };
}

async function applyActivityTriggerEffect({
  regionDocument,
  tokenDocument,
  triggerConfig,
  timing = "custom",
  partId = null,
  context = {}
}) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const triggerMode = "activity";
  const selectedActivity = triggerConfig?.activity?.id ?? null;
  const item = await resolveRuntimeItem(runtime);
  const activity = resolveItemActivity(item, triggerConfig?.activity ?? {});
  const baseDiagnostic = {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    partId,
    groupId: runtime.groupId ?? null,
    architecturePath: runtime.architecturePath ?? null,
    geometryType: runtime.geometryType ?? runtime.normalizedDefinition?.geometry?.type ?? null,
    regionSourceStrategy: runtime.regionSourceStrategy ?? null,
    regionSegmentIndex: runtime.regionSegmentIndex ?? null,
    regionSegmentCount: runtime.regionSegmentCount ?? null,
    triggerTiming: timing,
    triggerMode,
    movementSequenceId: context.movementSequenceId ?? null,
    triggerType: context.triggerType ?? timing,
    previousInside: context.previousInside ?? null,
    currentInside: context.currentInside ?? null
  };

  if (!item) {
    logPzEffectSkipped("no-activity-reference", baseDiagnostic, triggerConfig);
    debug(`Skipped ${timing} activity effect because no source Item could be resolved.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      partId,
      timing,
      triggerMode,
      selectedActivity,
      activityFound: false
    });

    return buildSkippedResult("Activity source Item could not be resolved.", {
      timing,
      partId,
      triggerMode,
      selectedActivity,
      activityFound: false
    });
  }

  if (!activity || typeof activity.use !== "function") {
    logPzEffectSkipped("no-activity-reference", baseDiagnostic, triggerConfig);
    debug(`Skipped ${timing} activity effect because the configured activity could not be found.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      itemUuid: item?.uuid ?? null,
      partId,
      timing,
      triggerMode,
      selectedActivity,
      activityFound: false
    });

    return buildSkippedResult("Configured activity could not be found on the source Item.", {
      timing,
      partId,
      triggerMode,
      selectedActivity,
      activityFound: false,
      itemUuid: item?.uuid ?? null
    });
  }

  const activityCompatibility = resolveZoneTriggeredActivityCompatibility(activity);
  logV14RuntimeDiagnostic("PZ EFFECT EXECUTION START", {
    ...baseDiagnostic,
    effectMode: triggerMode,
    simpleEffect: null,
    damageFormula: null,
    damageType: null,
    activityUuid: activity?.uuid ?? triggerConfig?.activity?.uuid ?? null,
    skippedReason: null
  });

  debug(`Resolved ${timing} activity compatibility.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    itemUuid: item?.uuid ?? null,
    partId,
    timing,
    triggerMode,
    selectedActivity,
    activityFound: true,
    activityTypeRaw: activityCompatibility.activityTypeRaw,
    activityType: activityCompatibility.activityType,
    healCompatibilityMode: activityCompatibility.healCompatibilityMode ?? null,
    activityCompatibility: activityCompatibility.code,
    activitySupported: activityCompatibility.supported,
    supportsHealing: activityCompatibility.supportsHealing ?? false,
    supportsTempHp: activityCompatibility.supportsTempHp ?? false,
    usedFullActivityFlow: false,
    templateCreationPrevented: activityCompatibility.templateCreationPrevented,
    consumptionPrevented: activityCompatibility.consumptionPrevented,
    concentrationPrevented: activityCompatibility.concentrationPrevented,
    reasonsText: activityCompatibility.reasonsText
  });

  if (!activityCompatibility.supported) {
    logPzEffectSkipped("executor-not-found", baseDiagnostic, triggerConfig);
    debug(`Skipped ${timing} activity effect because the configured activity is not compatible with zone-trigger execution.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      itemUuid: item?.uuid ?? null,
      partId,
      timing,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityTypeRaw: activityCompatibility.activityTypeRaw,
      activityType: activityCompatibility.activityType,
      healCompatibilityMode: activityCompatibility.healCompatibilityMode ?? null,
      activityCompatibility: activityCompatibility.code,
      supportsHealing: activityCompatibility.supportsHealing ?? false,
      supportsTempHp: activityCompatibility.supportsTempHp ?? false,
      usedFullActivityFlow: false,
      templateCreationPrevented: activityCompatibility.templateCreationPrevented,
      consumptionPrevented: activityCompatibility.consumptionPrevented,
      concentrationPrevented: activityCompatibility.concentrationPrevented,
      reasonsText: activityCompatibility.reasonsText
    });

    return buildSkippedResult("Configured activity is not compatible with zone-trigger execution.", {
      timing,
      partId,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityTypeRaw: activityCompatibility.activityTypeRaw,
      activityType: activityCompatibility.activityType,
      activityCompatibility: activityCompatibility.code,
      usedFullActivityFlow: false,
      templateCreationPrevented: activityCompatibility.templateCreationPrevented,
      consumptionPrevented: activityCompatibility.consumptionPrevented,
      concentrationPrevented: activityCompatibility.concentrationPrevented,
      reasons: activityCompatibility.reasons,
      reasonsText: activityCompatibility.reasonsText
    });
  }

  try {
    const activityResult = await executeZoneTriggeredActivity({
      activity,
      item,
      regionDocument,
      tokenDocument,
      timing,
      compatibility: activityCompatibility
    });
    const activityTriggered = activityResult?.triggered === true;

    debug(`Triggered ${timing} activity effect.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      itemUuid: item?.uuid ?? null,
      partId,
      timing,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityTypeRaw: activityCompatibility.activityTypeRaw,
      activityType: activityCompatibility.activityType,
      healCompatibilityMode: activityCompatibility.healCompatibilityMode ?? null,
      activityCompatibility: activityCompatibility.code,
      activityTriggered,
      supportsHealing: activityCompatibility.supportsHealing ?? false,
      supportsTempHp: activityCompatibility.supportsTempHp ?? false,
      usedFullActivityFlow: false,
      templateCreationPrevented: activityCompatibility.templateCreationPrevented,
      consumptionPrevented: activityCompatibility.consumptionPrevented,
      concentrationPrevented: activityCompatibility.concentrationPrevented
    });
    logV14RuntimeDiagnostic("activityExecuted", {
      ...baseDiagnostic,
      selectedActivity,
      activityUuid: activity?.uuid ?? triggerConfig?.activity?.uuid ?? null,
      activityTriggered,
      activityFound: true
    });
    logV14RuntimeDiagnostic("PZ EFFECT EXECUTION SUCCESS", {
      ...baseDiagnostic,
      effectMode: triggerMode,
      simpleEffect: null,
      damageFormula: null,
      damageType: null,
      activityUuid: activity?.uuid ?? triggerConfig?.activity?.uuid ?? null,
      applied: activityTriggered,
      skippedReason: activityTriggered ? null : "executor-returned-no-application"
    });
    logV14RuntimeDiagnostic("partTriggerApplied", {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      partId,
      triggerTiming: timing,
      triggerMode,
      selectedActivity,
      activityTriggered,
      activityFound: true
    });

    return {
      applied: activityTriggered,
      skipped: !activityTriggered,
      timing,
      partId,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityTypeRaw: activityCompatibility.activityTypeRaw,
      activityType: activityCompatibility.activityType,
      healCompatibilityMode: activityCompatibility.healCompatibilityMode ?? null,
      activityCompatibility: activityCompatibility.code,
      activityTriggered,
      itemUuid: item?.uuid ?? null,
      activityName: activity?.name ?? null,
      usedFullActivityFlow: false,
      templateCreationPrevented: activityCompatibility.templateCreationPrevented,
      consumptionPrevented: activityCompatibility.consumptionPrevented,
      concentrationPrevented: activityCompatibility.concentrationPrevented,
      ...activityResult
    };
  } catch (caughtError) {
    logV14RuntimeDiagnostic("PZ EFFECT EXECUTION FAILED", {
      ...baseDiagnostic,
      effectMode: triggerMode,
      simpleEffect: null,
      damageFormula: null,
      damageType: null,
      activityUuid: activity?.uuid ?? triggerConfig?.activity?.uuid ?? null,
      skippedReason: "effect-execution-error",
      error: caughtError?.message ?? "unknown"
    });
    error("Failed to trigger configured activity effect.", caughtError, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      itemUuid: item?.uuid ?? null,
      partId,
      timing,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityTypeRaw: activityCompatibility.activityTypeRaw,
      activityType: activityCompatibility.activityType,
      activityCompatibility: activityCompatibility.code
    });

    return buildSkippedResult("Configured activity failed.", {
      timing,
      partId,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityTypeRaw: activityCompatibility.activityTypeRaw,
      activityType: activityCompatibility.activityType,
      activityCompatibility: activityCompatibility.code,
      supportsHealing: activityCompatibility.supportsHealing ?? false,
      supportsTempHp: activityCompatibility.supportsTempHp ?? false,
      usedFullActivityFlow: false,
      templateCreationPrevented: activityCompatibility.templateCreationPrevented,
      consumptionPrevented: activityCompatibility.consumptionPrevented,
      concentrationPrevented: activityCompatibility.concentrationPrevented,
      error: caughtError?.message ?? "unknown"
    });
  }
}

async function applyTriggeredStatuses({
  regionDocument,
  tokenDocument,
  triggerConfig,
  timing,
  saveResult = null,
  baseDiagnostic = {}
} = {}) {
  const actor = tokenDocument?.actor ?? null;
  const statusConfig = triggerConfig?.statuses ?? triggerConfig?.simpleEffect?.statuses ?? {};
  const statusId = String(statusConfig?.statusId ?? "").trim();
  const persistenceMode = normalizeStatusPersistenceMode(statusConfig?.persistenceMode);
  const sceneId = regionDocument?.parent?.id ?? canvas?.scene?.id ?? null;
  const regionId = regionDocument?.id ?? null;
  const tokenUuid = tokenDocument?.uuid ?? null;
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const triggerId = normalizeStatusTriggerId(timing);
  const saveEnabled = Boolean(triggerConfig?.save?.enabled);
  const requiresFailedSave = saveEnabled;
  const saveSuccess = requiresFailedSave ? saveResult?.success === true : false;
  const saveFailed = requiresFailedSave ? saveResult?.success === false : false;
  const statusesConfigured = Boolean(actor && statusConfig?.enabled && statusId);
  const shouldApplyStatuses = shouldApplyTriggeredStatus({ statusesConfigured, saveEnabled, saveResult });
  const identity = {
    managedTriggeredEffect: true,
    persistenceMode,
    sceneId,
    regionId,
    groupId: runtime.groupId ?? null,
    partId: runtime.partId ?? runtime.part?.id ?? runtime.normalizedDefinition?.part?.id ?? null,
    tokenUuid,
    triggerId,
    statusId,
    castInstanceId: runtime.castInstanceId ?? runtime.ringOperationId ?? null
  };

  if (triggerId === "enter") {
    console.log(
      `[persistent-zones] PZ ENTER STATUS DECISION | regionId=${regionId} | tokenUuid=${tokenUuid} | ` +
      `triggerId=${triggerId} | saveEnabled=${saveEnabled} | saveSuccess=${saveSuccess} | saveFailed=${saveFailed} | ` +
      `statusesConfigured=${statusesConfigured} | statusIds=${statusId || null} | ` +
      `statusPersistence=${persistenceMode} | shouldApplyStatuses=${shouldApplyStatuses}`
    );
  }

  if (!shouldApplyStatuses) {
    logTriggeredStatusDecision({
      ...baseDiagnostic,
      sceneId,
      regionId,
      tokenUuid,
      triggerId,
      statusId,
      persistenceMode,
      existingExactEffectFound: false,
      applicationAllowed: false,
      decisionReason: !actor
        ? "token-has-no-actor"
        : !statusConfig?.enabled
          ? "statuses-disabled"
          : !statusId
            ? "missing-status-id"
            : saveSuccess
              ? "save-succeeded"
              : "save-result-unavailable"
    });
    return {
      applied: false,
      skipped: true,
      reason: statusesConfigured ? "status-save-condition-not-met" : "status-not-configured"
    };
  }

  const equivalentSources = findEquivalentTriggeredStatusSources(actor, identity);
  const existing = equivalentSources[0] ?? null;
  const duplicateSourceIds = equivalentSources.slice(1).map((effect) => effect?.id).filter(Boolean);
  if (duplicateSourceIds.length > 0) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", duplicateSourceIds, {
      persistentZonesDuplicateStatusSourceCleanup: true,
      persistentZonesStatusId: statusId,
      persistentZonesRegionId: regionId,
      persistentZonesPartId: identity.partId
    });
  }
  if (existing) {
    logTriggeredStatusDecision({
      ...baseDiagnostic,
      sceneId,
      regionId,
      tokenUuid,
      triggerId,
      statusId,
      persistenceMode,
      existingExactEffectFound: true,
      applicationAllowed: false,
      decisionReason: "existing-exact-effect-found"
    });
    return { applied: false, skipped: false, existingEffectId: existing.id, deduped: true };
  }

  const statusData = resolveStatusEffectData(statusId);
  const escapeConfig = normalizeStatusEscape(statusConfig?.escape);
  const escapeSourceActor = escapeConfig.enabled && escapeConfig.dcMode === "inherit"
    ? await resolveSaveSourceActor("caster", runtime)
    : null;
  const statusEscape = buildStatusEscapeEffectFlag(escapeConfig, {
    resolvedDC: saveResult?.dc ?? null,
    saveDC: getActorSaveDc(escapeSourceActor),
    statusId,
    statusName: statusData.name,
    sourceName: runtime.normalizedDefinition?.label ?? runtime.label ?? null,
    sourceActivityId: runtime.activityId ?? null
  });
  const recoveryPatchResult = buildStatusRecoveryPatch(statusConfig?.recovery, {
    effectStatusId: statusId,
    persistenceMode,
    resolvedDC: saveResult?.dc ?? null,
    itemUuid: runtime.itemUuid ?? null,
    activityId: runtime.activityId ?? null,
    triggerId,
    tokenUuid
  });
  const statusRecoveryPatch = recoveryPatchResult.patch;
  const recoveryConfig = statusRecoveryPatch?.flags?.[MODULE_ID]?.statusRecovery ?? null;
  const recoverySourceIdentity = recoveryConfig
    ? buildRecoverySourceIdentity({
        item: await resolveRuntimeItem(runtime),
        activityId: runtime.activityId,
        runtime,
        recovery: recoveryConfig,
        regionDocument
      })
    : null;
  const recoveryGroupKey = recoverySourceIdentity
    ? buildRecoveryGroupKey({
        ...identity,
        ...recoverySourceIdentity,
        statusRecovery: recoveryConfig
      })
    : null;
  console.log(
    `[persistent-zones] PZ STATUS APPLY REQUEST | regionId=${regionId} | tokenUuid=${tokenUuid} | ` +
    `statusId=${statusId} | persistenceMode=${persistenceMode} | castInstanceId=${identity.castInstanceId}`
  );
  const created = await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: `${statusData.name} — Persistent Zones source`,
    img: statusData.img,
    statuses: [],
    showIcon: globalThis.CONST?.ACTIVE_EFFECT_SHOW_ICON?.NEVER ?? 0,
    origin: regionDocument?.uuid ?? null,
    duration: {},
    system: {
      changes: []
    },
    flags: {
      [MODULE_ID]: {
        ...identity,
        ...(statusEscape ? { statusEscape } : {}),
        ...(recoveryConfig
          ? {
              ...recoverySourceIdentity,
              recoveryGroupKey,
              statusRecovery: recoveryConfig
            }
          : {})
      }
    }
  }], { persistentZonesTriggeredStatus: true });
  const createdEffect = Array.from(created ?? [])[0] ?? null;
  if (createdEffect) {
    console.warn(
      `[persistent-zones] PZ STATUS SOURCE CREATED | ` +
      `actorUuid=${actor?.uuid ?? "null"} | effectId=${createdEffect.id ?? "null"} | ` +
      `statusId=${statusId} | regionId=${regionId ?? "null"} | ` +
      `recoveryMode=${statusRecoveryPatch?.flags?.[MODULE_ID]?.statusRecovery?.mode ?? "none"}`
    );
    await ensureAggregateStatus(actor, statusId, { missingAction: "create" });
    if (recoveryGroupKey) {
      await reconcileRecoveryArbitration(actor, recoveryGroupKey, {
        reason: "source-created"
      });
    }
  }
  console.log(
    `[persistent-zones] PZ STATUS APPLY RESULT | regionId=${regionId} | tokenUuid=${tokenUuid} | ` +
    `statusId=${statusId} | effectCreated=${Boolean(createdEffect)} | effectId=${createdEffect?.id ?? null}`
  );

  logTriggeredStatusDecision({
    ...baseDiagnostic,
    sceneId,
    regionId,
    tokenUuid,
    triggerId,
    statusId,
    persistenceMode,
    existingExactEffectFound: false,
    applicationAllowed: true,
    decisionReason: "created-managed-triggered-status"
  });

  return {
    applied: Array.isArray(created) && created.length > 0,
    skipped: false,
    createdEffectIds: Array.from(created ?? []).map((effect) => effect.id).filter(Boolean)
  };
}

async function applySimpleRecoveryEffect({
  actor,
  regionDocument,
  tokenDocument,
  timing = "custom",
  type = "heal",
  config = {}
} = {}) {
  const enabled = Boolean(config?.enabled);
  const formula = String(config?.formula ?? "").trim();
  if (!actor || !enabled || !formula) {
    return {
      applied: false,
      skipped: true,
      skippedReason: !actor ? "token-has-no-actor" : !enabled ? "recovery-disabled" : "missing-recovery-formula",
      entries: []
    };
  }

  const simpleRecoveryResult = await resolveSimpleRecoveryResult(
    { type, formula },
    regionDocument,
    tokenDocument,
    timing
  );
  const entries = simpleRecoveryResult.rolledTotal > 0
    ? [{
      value: simpleRecoveryResult.rolledTotal,
      type: type === "tempHP" ? "temphp" : "healing",
      properties: new Set()
    }]
    : [];

  await applyDamageEntriesToActor(actor, entries);

  return {
    applied: entries.length > 0,
    skipped: entries.length === 0,
    skippedReason: entries.length > 0 ? null : "recovery-roll-zero",
    type,
    formula: simpleRecoveryResult.formula,
    rolledTotal: simpleRecoveryResult.rolledTotal,
    entries,
    summary: summarizeDamageEntries(entries)
  };
}

async function executeZoneTriggeredActivity({
  activity,
  item,
  regionDocument,
  tokenDocument,
  timing = "custom",
  compatibility = {}
}) {
  switch (compatibility.activityType) {
    case "damage":
      return executeZoneTriggeredDamageActivity({
        activity,
        item,
        regionDocument,
        tokenDocument,
        timing,
        compatibility
      });
    case "save":
      return executeZoneTriggeredSaveActivity({
        activity,
        item,
        regionDocument,
        tokenDocument,
        timing,
        compatibility
      });
    case "heal":
      return executeZoneTriggeredHealActivity({
        activity,
        item,
        regionDocument,
        tokenDocument,
        timing,
        compatibility
      });
    default:
      return {
        triggered: false,
        activityType: compatibility.activityType ?? null
      };
  }
}

async function executeZoneTriggeredDamageActivity({
  activity,
  item,
  regionDocument,
  tokenDocument,
  timing = "custom",
  compatibility = {}
}) {
  const actor = tokenDocument?.actor ?? null;
  const damageRolls = await rollZoneTriggeredActivityDamage({
    activity,
    item,
    regionDocument,
    tokenDocument,
    timing
  });
  const rawDamages = buildDamageEntriesFromRolls(damageRolls);
  const appliedDamage = await applyDamageEntriesToActor(actor, rawDamages);
  const entrySummary = summarizeDamageEntries(rawDamages);

  return {
    triggered: rawDamages.length > 0,
    activityType: compatibility.activityType ?? "damage",
    save: null,
    damage: {
      type: "activity",
      rollCount: Array.isArray(damageRolls) ? damageRolls.length : 0,
      damageCount: rawDamages.length,
      damages: rawDamages,
      appliedDamage,
      summary: entrySummary
    }
  };
}

async function executeZoneTriggeredSaveActivity({
  activity,
  item,
  regionDocument,
  tokenDocument,
  timing = "custom",
  compatibility = {}
}) {
  const actor = tokenDocument?.actor ?? null;
  const saveResult = await rollZoneTriggeredActivitySave({
    activity,
    regionDocument,
    tokenDocument,
    timing,
    saveAbility: compatibility.saveAbility,
    saveDc: compatibility.saveDc
  });
  const damageRolls = compatibility.damagePartCount > 0
    ? await rollZoneTriggeredActivityDamage({
      activity,
      item,
      regionDocument,
      tokenDocument,
      timing
    })
    : [];
  const rawDamages = buildDamageEntriesFromRolls(damageRolls);
  const adjustedDamages = adjustDamageEntriesForSave(
    rawDamages,
    saveResult,
    String(activity?.damage?.onSave ?? "half").toLowerCase()
  );
  const appliedDamage = await applyDamageEntriesToActor(actor, adjustedDamages);
  const entrySummary = summarizeDamageEntries(adjustedDamages);

  return {
    triggered: Boolean(saveResult || adjustedDamages.length),
    activityType: compatibility.activityType ?? "save",
    save: saveResult,
    damage: {
      type: "activity",
      rollCount: Array.isArray(damageRolls) ? damageRolls.length : 0,
      damageCount: adjustedDamages.length,
      damages: adjustedDamages,
      appliedDamage,
      damageOnSave: String(activity?.damage?.onSave ?? "half").toLowerCase(),
      summary: entrySummary
    }
  };
}

async function executeZoneTriggeredHealActivity({
  activity,
  item,
  regionDocument,
  tokenDocument,
  timing = "custom",
  compatibility = {}
}) {
  const actor = tokenDocument?.actor ?? null;
  const healingResolutionPath = resolveHealingResolutionPath(compatibility);
  const healingRolls = await rollZoneTriggeredActivityDamage({
    activity,
    item,
    regionDocument,
    tokenDocument,
    timing
  });
  const healingEntries = buildDamageEntriesFromRolls(healingRolls, {
    defaultType: compatibility.healingTypes?.[0] ?? "healing"
  });
  const appliedHealing = await applyDamageEntriesToActor(actor, healingEntries);
  const entrySummary = summarizeDamageEntries(healingEntries);

  debug(`Applied ${timing} activity healing.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    actorUuid: actor?.uuid ?? null,
    itemUuid: item?.uuid ?? null,
    timing,
    triggerMode: "activity",
    activityType: compatibility.activityType ?? "heal",
    healCompatibilityMode: compatibility.healCompatibilityMode ?? null,
    compatibilityReason: compatibility.reasonsText ?? "",
    healingResolutionPath,
    activityTriggered: healingEntries.length > 0,
    supportsHealing: compatibility.supportsHealing ?? false,
    supportsTempHp: compatibility.supportsTempHp ?? false,
    usedFullActivityFlow: false,
    templateCreationPrevented: compatibility.templateCreationPrevented ?? false,
    consumptionPrevented: compatibility.consumptionPrevented ?? true,
    rollCount: Array.isArray(healingRolls) ? healingRolls.length : 0,
    healingCount: entrySummary.healingCount,
    healingTotal: entrySummary.healingTotal,
    tempHpCount: entrySummary.tempHpCount,
    tempHpTotal: entrySummary.tempHpTotal
  });

  return {
    triggered: healingEntries.length > 0,
    activityType: compatibility.activityType ?? "heal",
    healCompatibilityMode: compatibility.healCompatibilityMode ?? null,
    healingResolutionPath,
    save: null,
    healing: {
      type: "activity",
      rollCount: Array.isArray(healingRolls) ? healingRolls.length : 0,
      healingCount: healingEntries.length,
      effects: healingEntries,
      appliedDamage: appliedHealing,
      summary: entrySummary
    }
  };
}

async function rollZoneTriggeredActivitySave({
  activity,
  regionDocument,
  tokenDocument,
  timing = "custom",
  saveAbility = null,
  saveDc = null
}) {
  const actor = tokenDocument?.actor ?? null;
  if (!actor || !saveAbility || saveDc === null || typeof actor.rollSavingThrow !== "function") {
    return null;
  }

  const rollResult = await actor.rollSavingThrow({
    ability: saveAbility,
    target: saveDc
  }, {
    configure: false
  }, {
    data: {
      flavor: `${regionDocument?.name ?? "Persistent Zone"}: ${timing} activity save`,
      speaker: ChatMessage.getSpeaker({ actor, token: tokenDocument })
    }
  });
  const saveRoll = Array.isArray(rollResult) ? rollResult[0] : rollResult;
  if (!saveRoll) {
    return null;
  }
  const total = coerceNumber(saveRoll?.total, null);
  const success = total !== null ? total >= saveDc : false;

  debug(`Calculated ${timing} activity save.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    actorUuid: actor?.uuid ?? null,
    timing,
    triggerMode: "activity",
    activityType: "save",
    ability: saveAbility,
    dc: saveDc,
    total,
    success
  });

  return {
    ability: saveAbility,
    dc: saveDc,
    total,
    success,
    onSuccess: String(activity?.damage?.onSave ?? "half").toLowerCase()
  };
}

async function rollZoneTriggeredActivityDamage({
  activity,
  item,
  regionDocument,
  tokenDocument,
  timing = "custom"
}) {
  if (typeof activity?.rollDamage !== "function") {
    return [];
  }

  const activityType = normalizeZoneTriggerActivityType(activity?.type ?? activity?.metadata?.type, {
    activity
  });
  const activityTypeRaw = String(
    activity?.type ??
    activity?.metadata?.type ??
    activity?.constructor?.metadata?.type ??
    ""
  ).trim().toLowerCase();

  const rolls = await activity.rollDamage({}, {
    configure: false
  }, {
    create: true,
    data: {
      flavor: `${item?.name ?? regionDocument?.name ?? "Persistent Zone"}: ${timing} activity ${activityType || "effect"}`
    }
  });

  debug(`Calculated ${timing} activity roll.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    actorUuid: tokenDocument?.actor?.uuid ?? null,
    itemUuid: item?.uuid ?? null,
    timing,
    triggerMode: "activity",
    activityTypeRaw,
    activityType,
    rollCount: Array.isArray(rolls) ? rolls.length : 0
  });

  return Array.isArray(rolls) ? rolls : [];
}

function buildDamageEntriesFromRolls(rolls, {
  defaultType = null
} = {}) {
  if (!Array.isArray(rolls) || !rolls.length) {
    return [];
  }

  return rolls
    .map((roll) => {
      const total = coerceNumber(roll?.total, 0);
      const damageType = roll?.options?.type ?? null;
      const properties = Array.isArray(roll?.options?.properties)
        ? roll.options.properties
        : roll?.options?.properties instanceof Set
          ? Array.from(roll.options.properties)
          : [];

      return {
        value: Math.max(total, 0),
        type: damageType ?? defaultType,
        properties: new Set(properties)
      };
    })
    .filter((entry) => entry.value !== 0);
}

function resolveHealingResolutionPath(compatibility = {}) {
  switch (String(compatibility?.healCompatibilityMode ?? "").trim().toLowerCase()) {
    case "healing-formula":
      return "rollDamage-healing-formula";
    case "healing-damage-parts":
      return "rollDamage-healing-damage-parts";
    case "typed-heal-field":
    case "typed-heal-types":
    case "typed-heal":
      return "rollDamage-typed-heal";
    case "healing-field":
      return "rollDamage-healing-field";
    default:
      return "rollDamage";
  }
}

function summarizeDamageEntries(entries) {
  return Array.from(entries ?? []).reduce((summary, entry) => {
    const value = Math.max(coerceNumber(entry?.value, 0), 0);
    const type = String(entry?.type ?? "").trim().toLowerCase();

    if (type === "healing") {
      summary.healingCount += 1;
      summary.healingTotal += value;
      return summary;
    }

    if (type === "temphp") {
      summary.tempHpCount += 1;
      summary.tempHpTotal += value;
      return summary;
    }

    summary.damageCount += 1;
    summary.damageTotal += value;
    return summary;
  }, {
    damageCount: 0,
    damageTotal: 0,
    healingCount: 0,
    healingTotal: 0,
    tempHpCount: 0,
    tempHpTotal: 0
  });
}

function adjustDamageEntriesForSave(damages, saveResult, onSuccess = "half") {
  if (!Array.isArray(damages) || !damages.length || !saveResult?.success) {
    return Array.isArray(damages) ? damages : [];
  }

  return damages
    .map((entry) => {
      if (!entry || entry.value <= 0) {
        return entry;
      }

      return {
        ...entry,
        value: adjustDamageForSave(entry.value, {
          success: true,
          onSuccess
        })
      };
    })
    .filter((entry) => coerceNumber(entry?.value, 0) !== 0);
}

async function applyDamageEntriesToActor(actor, damages) {
  if (!actor || !Array.isArray(damages) || !damages.length) {
    return 0;
  }

  const entrySummary = summarizeDamageEntries(damages);
  const calculatedDamage = typeof actor.calculateDamage === "function"
    ? actor.calculateDamage(damages)
    : null;
  const appliedDamage = coerceNumber(
    calculatedDamage?.amount,
    entrySummary.damageTotal - entrySummary.healingTotal
  );
  const appliedTempHp = coerceNumber(calculatedDamage?.temp, entrySummary.tempHpTotal);

  if (typeof actor.applyDamage === "function") {
    await actor.applyDamage(damages);
    return appliedDamage;
  }

  await applyDamageEntriesFallbackToActor(actor, {
    amount: appliedDamage,
    temp: appliedTempHp
  });
  return appliedDamage;
}

async function resolveSaveResult(actor, saveConfig, regionDocument, tokenDocument, timing = "custom") {
  const ability = String(saveConfig.ability ?? "").toLowerCase();
  const dc = await resolveConfiguredSaveDc(saveConfig, regionDocument);
  let roll = null;
  const timingLabel = String(timing || "custom");

  if (dc === null) {
    debug(`Skipped ${timingLabel} save because no DC could be resolved.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      actorUuid: actor?.uuid ?? null,
      timing: timingLabel,
      ability
    });

    return {
      ability,
      dc: null,
      total: null,
      success: false,
      unresolved: true,
      onSuccess: String(saveConfig.onSuccess ?? "half").toLowerCase()
    };
  }

  roll = await rollSimpleActorSave({
    actor,
    ability,
    dc,
    flavor: `${regionDocument?.name ?? "Persistent Zone"}: ${timingLabel} save`,
    tokenDocument
  });

  const result = buildSimpleSaveResult({
    ability,
    dc,
    roll,
    onSuccess: saveConfig.onSuccess
  });
  debug(`Calculated ${timingLabel} save.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    actorUuid: actor?.uuid ?? null,
    timing: timingLabel,
    ability: result.ability,
    dc: result.dc,
    total: result.total,
    success: result.success
  });

  return result;
}

async function resolveConfiguredSaveDc(saveConfig, regionDocument) {
  const dcMode = normalizeSaveDcMode(saveConfig?.dcMode, saveConfig?.dcSource, saveConfig?.dc);
  const explicitDc = coerceNumber(saveConfig?.dc, null);
  if (dcMode !== "auto") {
    return explicitDc;
  }

  const dcSource = normalizeSaveDcSource(saveConfig?.dcSource);
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const sourceActor = await resolveSaveSourceActor(dcSource, runtime);
  const resolvedDc = coerceNumber(
    pickFirstDefined(
      getActorSaveDc(sourceActor),
      runtime.dc,
      explicitDc
    ),
    null
  );

  debug("Resolved configured save DC.", {
    regionId: regionDocument?.id ?? null,
    dcMode,
    dcSource,
    sourceActorUuid: sourceActor?.uuid ?? null,
    resolvedDc,
    fallbackDc: coerceNumber(pickFirstDefined(runtime.dc, explicitDc), null)
  });

  return resolvedDc;
}

async function resolveDamageResult(damageConfig, saveResult, regionDocument, tokenDocument, timing = "custom") {
  const timingLabel = String(timing || "custom");
  const roll =
    damageConfig.formula
      ? new Roll(String(damageConfig.formula))
      : null;

  if (roll) {
    await roll.evaluate();
  }

  const rolledDamage = coerceNumber(roll?.total, damageConfig.amount ?? 0);
  const appliedDamage = adjustDamageForSave(rolledDamage, saveResult);

  if (roll) {
    await roll.toMessage({
      flavor: `Persistent Zones ${timingLabel} damage (${damageConfig.type ?? "untyped"})`
    });
  }

  const result = {
    type: damageConfig.type ?? "force",
    formula: damageConfig.formula ?? null,
    rolledDamage,
    appliedDamage
  };

  debug(`Calculated ${timingLabel} damage.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    timing: timingLabel,
    type: result.type,
    formula: result.formula,
    rolledDamage: result.rolledDamage,
    appliedDamage: result.appliedDamage
  });

  return result;
}

async function resolveSimpleRecoveryResult(simpleEffectConfig, regionDocument, tokenDocument, timing = "custom") {
  const timingLabel = String(timing || "custom");
  const effectType = normalizeSimpleEffectType(simpleEffectConfig?.type);
  const formula = String(simpleEffectConfig?.formula ?? "").trim();
  const roll = formula ? new Roll(formula) : null;

  if (roll) {
    await roll.evaluate();
    await roll.toMessage({
      flavor: `Persistent Zones ${timingLabel} ${effectType === "heal" ? "healing" : "temporary HP"}`
    });
  }

  const rolledTotal = Math.max(coerceNumber(roll?.total, 0), 0);

  debug(`Calculated ${timingLabel} simple effect.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    timing: timingLabel,
    simpleEffectType: effectType,
    simpleEffectFormula: formula || null,
    rolledTotal
  });

  return {
    type: effectType,
    formula: formula || null,
    rolledTotal
  };
}

function adjustDamageForSave(baseDamage, saveResult) {
  if (!saveResult?.success) {
    return baseDamage;
  }

  switch (saveResult.onSuccess) {
    case "none":
      return 0;
    case "half":
      return Math.floor(baseDamage / 2);
    case "full":
    default:
      return baseDamage;
  }
}

async function applyDamageToActor(actor, appliedDamage) {
  const hpValue = coerceNumber(actor?.system?.attributes?.hp?.value, null);
  if (hpValue === null) {
    return;
  }

  const tempHp = coerceNumber(actor?.system?.attributes?.hp?.temp, 0);
  let remainingDamage = appliedDamage;
  const newTempHp = Math.max(tempHp - remainingDamage, 0);
  remainingDamage -= tempHp - newTempHp;
  const newHpValue = Math.max(hpValue - remainingDamage, 0);

  await actor.update({
    "system.attributes.hp.temp": newTempHp,
    "system.attributes.hp.value": newHpValue
  });
}

async function applyDamageEntriesFallbackToActor(actor, {
  amount = 0,
  temp = 0
} = {}) {
  const hpValue = coerceNumber(actor?.system?.attributes?.hp?.value, null);
  if (hpValue === null) {
    return;
  }

  const hpMax = coerceNumber(actor?.system?.attributes?.hp?.max, hpValue);
  const tempHp = coerceNumber(actor?.system?.attributes?.hp?.temp, 0);
  let nextHpValue = hpValue;
  let nextTempHp = tempHp;

  if (amount > 0) {
    let remainingDamage = amount;
    nextTempHp = Math.max(tempHp - remainingDamage, 0);
    remainingDamage -= tempHp - nextTempHp;
    nextHpValue = Math.max(hpValue - remainingDamage, 0);
  } else if (amount < 0) {
    nextHpValue = Math.min(hpValue + Math.abs(amount), hpMax);
  }

  if (temp > nextTempHp) {
    nextTempHp = temp;
  }

  await actor.update({
    "system.attributes.hp.temp": nextTempHp,
    "system.attributes.hp.value": nextHpValue
  });
}

async function resolveSaveSourceActor(dcSource, runtime) {
  const sourceOrder =
    dcSource === "actor"
      ? [runtime.actorUuid, runtime.casterUuid, runtime.itemUuid]
      : [runtime.casterUuid, runtime.actorUuid, runtime.itemUuid];

  for (const sourceUuid of sourceOrder) {
    if (!sourceUuid) {
      continue;
    }

    const resolvedDocument = await fromUuidSafe(sourceUuid);
    if (resolvedDocument?.documentName === "Actor") {
      return resolvedDocument;
    }

    if (resolvedDocument?.actor?.documentName === "Actor") {
      return resolvedDocument.actor;
    }
  }

  return null;
}

function getActorSaveDc(actor) {
  return coerceNumber(
    pickFirstDefined(
      actor?.system?.attributes?.spell?.dc,
      actor?.system?.attributes?.spelldc,
      actor?.system?.attributes?.spellcasting?.dc,
      actor?.system?.spells?.spellcasting?.dc,
      actor?.system?.spells?.dc
    ),
    null
  );
}

function normalizeSaveDcMode(dcMode, dcSource, dc) {
  if (String(dcMode ?? "").toLowerCase() === "auto") {
    return "auto";
  }

  if (dcSource) {
    return "auto";
  }

  return dc === null || dc === undefined ? "manual" : "manual";
}

function normalizeSaveDcSource(value) {
  const normalized = String(value ?? "caster").toLowerCase();
  return ["caster", "actor", "token"].includes(normalized) ? normalized : "caster";
}

function normalizeSimpleEffectType(value) {
  const normalized = String(value ?? "damage").trim().toLowerCase();
  if (normalized === "heal") {
    return "heal";
  }

  if (normalized === "temphp") {
    return "tempHP";
  }

  return "damage";
}

function resolveSimpleEffectConfig(triggerConfig = {}) {
  const simpleEffectDefinition =
    typeof triggerConfig?.simpleEffect === "object" && triggerConfig.simpleEffect
      ? triggerConfig.simpleEffect
      : typeof triggerConfig?.effect === "object" && triggerConfig.effect
        ? triggerConfig.effect
        : {};
  const simpleEffectType = normalizeSimpleEffectType(
    pickFirstDefined(
      simpleEffectDefinition.type,
      triggerConfig?.simpleEffectType,
      triggerConfig?.damage?.enabled ? "damage" : null,
      "damage"
    )
  );
  const simpleEffectFormula = String(
    pickFirstDefined(
      simpleEffectDefinition.formula,
      triggerConfig?.damage?.formula,
      ""
    )
  ).trim();

  return {
    type: simpleEffectType,
    formula: simpleEffectFormula || null,
    damageType: simpleEffectType === "damage"
      ? pickFirstDefined(simpleEffectDefinition.damageType, triggerConfig?.damage?.type, "force")
      : null
  };
}

export function findEquivalentTriggeredStatusSources(actor, identity) {
  return Array.from(actor?.effects ?? []).filter((effect) => {
    const flags = effect?.flags?.[MODULE_ID] ?? {};
    return flags.managedTriggeredEffect === true &&
      flags.regionId === identity.regionId &&
      flags.tokenUuid === identity.tokenUuid &&
      (flags.partId ?? identity.partId ?? null) === (identity.partId ?? null) &&
      flags.statusId === identity.statusId &&
      effect?.active !== false;
  });
}

function resolveStatusEffectData(statusId) {
  const status = Array.from(CONFIG.statusEffects ?? []).find((entry) => entry.id === statusId) ?? {};
  return {
    name: game.i18n?.localize?.(status.name ?? status.label ?? statusId) ?? statusId,
    img: status.img ?? status.icon ?? "icons/svg/aura.svg"
  };
}

function normalizeStatusPersistenceMode(value) {
  return String(value ?? "persistent").trim().toLowerCase() === "while-inside-region"
    ? "while-inside-region"
    : "persistent";
}

export function findRequiredAbsentStatusConflict(actor, requiredAbsentStatuses = []) {
  if (!Array.isArray(requiredAbsentStatuses) || requiredAbsentStatuses.length === 0) return null;
  const actorStatuses = new Set(Array.from(actor?.statuses ?? []).map((status) => String(status?.id ?? status ?? "").trim().toLowerCase()).filter(Boolean));
  for (const effect of Array.from(actor?.effects ?? [])) {
    for (const status of Array.from(effect?.statuses ?? [])) actorStatuses.add(String(status).trim().toLowerCase());
  }
  return requiredAbsentStatuses.find((status) => actorStatuses.has(String(status).trim().toLowerCase())) ?? null;
}

export function findRequiredAbsentSourceStatusConflict({
  actor,
  regionDocument,
  tokenDocument,
  partId = null,
  requiredAbsentSourceStatuses = []
} = {}) {
  if (!Array.isArray(requiredAbsentSourceStatuses) || requiredAbsentSourceStatuses.length === 0) return null;
  const regionId = regionDocument?.id ?? null;
  const tokenUuid = tokenDocument?.uuid ?? null;
  if (!regionId || !tokenUuid) return null;
  return requiredAbsentSourceStatuses.find((statusId) => findEquivalentTriggeredStatusSources(actor, {
    regionId,
    partId,
    tokenUuid,
    statusId: String(statusId ?? "").trim().toLowerCase()
  }).length > 0) ?? null;
}

export function shouldApplyTriggeredStatus({ statusesConfigured = false, saveEnabled = false, saveResult = null } = {}) {
  return Boolean(statusesConfigured && (!saveEnabled || saveResult?.success === false));
}

function normalizeStatusTriggerId(timing) {
  switch (String(timing ?? "")) {
    case "onCreate":
      return "create";
    case "onEnter":
      return "enter";
    case "onMove":
      return "move";
    case "onExit":
      return "exit";
    case "onStartTurn":
      return "turnStart";
    case "onEndTurn":
      return "turnEnd";
    default:
      return String(timing ?? "custom");
  }
}

function logTriggeredStatusDecision(data = {}) {
  logV14RuntimeDiagnostic("PZ TRIGGERED STATUS APPLICATION DECISION", {
    sceneId: data.sceneId ?? null,
    regionId: data.regionId ?? null,
    tokenUuid: data.tokenUuid ?? null,
    triggerId: data.triggerId ?? null,
    statusId: data.statusId ?? null,
    persistenceMode: data.persistenceMode ?? null,
    existingExactEffectFound: data.existingExactEffectFound === true,
    applicationAllowed: data.applicationAllowed === true,
    decisionReason: data.decisionReason ?? null
  });
}

function resolveTriggerEffectMode(triggerConfig = {}) {
  const explicitMode = String(triggerConfig?.mode ?? "").trim().toLowerCase();
  if (["none", "simple", "activity"].includes(explicitMode)) {
    return explicitMode;
  }

  if (triggerConfig?.activity?.id) {
    return "activity";
  }

  return "simple";
}

async function resolveRuntimeItem(runtime = {}) {
  const resolvedItem = await fromUuidSafe(runtime?.itemUuid ?? null);
  if (resolvedItem?.documentName === "Item") {
    return resolvedItem;
  }

  if (resolvedItem?.item?.documentName === "Item") {
    return resolvedItem.item;
  }

  return null;
}

function resolveItemActivity(item, activityConfig = {}) {
  const activityId = String(activityConfig?.id ?? "").trim();
  const activityUuid = String(activityConfig?.uuid ?? "").trim();
  const activityName = String(activityConfig?.name ?? "").trim().toLowerCase();

  if (!item?.system?.activities) {
    return null;
  }

  if (activityId && typeof item.system.activities.get === "function") {
    const directActivity = item.system.activities.get(activityId);
    if (directActivity) {
      return directActivity;
    }
  }

  const activities = Array.from(item.system.activities ?? [])
    .map((entry) => Array.isArray(entry) ? entry[1] : entry)
    .filter(Boolean);

  return activities.find((activity) => {
    if (activityId && String(activity?.id ?? "").trim() === activityId) {
      return true;
    }

    if (activityUuid && String(activity?.uuid ?? "").trim() === activityUuid) {
      return true;
    }

    if (activityName && String(activity?.name ?? "").trim().toLowerCase() === activityName) {
      return true;
    }

    return false;
  }) ?? null;
}

function buildSkippedResult(reason, extra = {}) {
  logV14RuntimeDiagnostic("triggerSuppressedReason", {
    reason,
    ...extra
  });

  return {
    applied: false,
    skipped: true,
    reason,
    ...extra
  };
}

function logPzEffectSkipped(skippedReason, baseDiagnostic = {}, triggerConfig = {}, simpleEffect = null) {
  logV14RuntimeDiagnostic("PZ EFFECT EXECUTION SKIPPED", {
    ...baseDiagnostic,
    onEnterEnabled: baseDiagnostic.triggerTiming === "onEnter" ? Boolean(triggerConfig?.enabled) : null,
    onMoveEnabled: baseDiagnostic.triggerTiming === "onMove" ? Boolean(triggerConfig?.enabled) : null,
    effectMode: baseDiagnostic.triggerMode ?? triggerConfig?.mode ?? null,
    simpleEffect: simpleEffect ?? triggerConfig?.simpleEffect ?? null,
    damageFormula: simpleEffect?.formula ?? triggerConfig?.damage?.formula ?? triggerConfig?.simpleEffect?.formula ?? null,
    damageType: simpleEffect?.damageType ?? triggerConfig?.damage?.type ?? triggerConfig?.simpleEffect?.damageType ?? null,
    activityUuid: triggerConfig?.activity?.uuid ?? null,
    skippedReason
  });
}

function logV14RuntimeDiagnostic(message, data = {}) {
  if (!isFoundryV14OrNewer()) {
    return;
  }

  console.warn(`[${MODULE_ID}][v14-runtime] ${message}`, data);
}

function isFoundryV14OrNewer() {
  const version = String(globalThis.game?.version ?? globalThis.game?.data?.version ?? "");
  const major = Number.parseInt(version.split(".")[0], 10);
  return Number.isFinite(major) && major >= 14;
}

function buildNoDamageResult(damageConfig = {}) {
  return {
    type: damageConfig?.type ?? "force",
    formula: damageConfig?.formula ?? null,
    rolledDamage: 0,
    appliedDamage: 0
  };
}
