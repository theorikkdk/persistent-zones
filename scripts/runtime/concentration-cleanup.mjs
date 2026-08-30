import {
  MODULE_ID,
  RUNTIME_FLAG_KEY
} from "../constants.mjs";
import {
  debug,
  error,
  findManagedRegions,
  fromUuidSafe,
  getRegionRuntimeFlags,
  isPrimaryGM,
  pickFirstDefined
} from "./utils.mjs";
import { cleanupLinkedDocumentsForRegion } from "./linked-documents.mjs";
import { createRegionFromTemplate } from "./region-factory.mjs";
import { findManagedRegionContractsByItem } from "./v14-region-contract.mjs";
import { getZoneDefinitionFromItem } from "./zone-definition.mjs";
import { shouldHandleLifecycleEffect } from "./owner-effect-qualification.mjs";

let hooksRegistered = false;
const pendingRegionCleanup = new Set();
const pendingStartupReconciliations = new Set();
const STARTUP_CLEANUP_REASONS = new Set(["ready", "canvas-ready"]);
const STARTUP_RECONCILIATION_DELAY_MS = 2000;

export function registerConcentrationCleanupHooks() {
  if (hooksRegistered) {
    return;
  }

  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("deleteMeasuredTemplate", onDeleteMeasuredTemplate);
  Hooks.on("deleteItem", onDeleteItem);
  Hooks.on("deleteActiveEffect", onDeleteActiveEffect);
  Hooks.on("updateActiveEffect", onUpdateActiveEffect);

  hooksRegistered = true;
}

export async function cleanupSceneRegions(scene, { reason = "manual" } = {}) {
  if (!scene) {
    return [];
  }

  const regionsToDelete = [];
  const managedRegions = findManagedRegions(scene);
  const groupedRegions = groupManagedRegionsByCleanupKey(managedRegions);

  for (const region of managedRegions) {
    logCleanupCandidateRegion(region, { scene, reason });
    const validation = await validateManagedRegion(region, { scene, reason });
    if (validation.deferStartupReconciliation) {
      scheduleStartupRegionReconciliation(scene, reason);
      continue;
    }
    if (!validation.isValid) {
      const groupKey = buildManagedRegionCleanupKey(region);
      const groupRegions = groupedRegions.get(groupKey) ?? [region];
      const groupRegionIds = groupRegions
        .map((groupRegion) => groupRegion?.id ?? null)
        .filter(Boolean);
      const pendingIds = groupRegionIds.filter((regionId) => pendingRegionCleanup.has(regionId));

      if (pendingIds.length === groupRegionIds.length) {
        debug("Skipped Region cleanup because deletion is already pending.", {
          regionId: region.id,
          regionGroupKey: groupKey,
          sceneId: scene.id,
          reason,
          detail: validation.reason
        });
        continue;
      }

      debug("Scheduling Region cleanup.", {
        regionId: region.id,
        regionGroupKey: groupKey,
        regionIds: groupRegionIds,
        sceneId: scene.id,
        reason,
        detail: validation.reason
      });
      for (const groupRegion of groupRegions) {
        await logStartupRegionReconciliation(groupRegion, {
          scene,
          reason,
          cleanupFunction: "cleanupSceneRegions",
          deletionReason: validation.reason
        });
      }

      for (const regionId of groupRegionIds) {
        if (pendingRegionCleanup.has(regionId)) {
          continue;
        }

        pendingRegionCleanup.add(regionId);
        regionsToDelete.push(regionId);
      }
    }
  }

  if (!regionsToDelete.length) {
    return [];
  }

  const existingRegionIds = regionsToDelete.filter((regionId) => scene?.regions?.get?.(regionId));
  if (!existingRegionIds.length) {
    for (const regionId of regionsToDelete) {
      pendingRegionCleanup.delete(regionId);
    }
    return [];
  }

  try {
    for (const regionId of existingRegionIds) {
      const regionDocument = scene?.regions?.get?.(regionId) ?? null;
      if (regionDocument) {
        try {
          await cleanupLinkedDocumentsForRegion(regionDocument, {
            reason,
            skipRuntimeUpdate: true
          });
        } catch (caughtError) {
          error("Failed to cleanup linked documents before Region deletion.", caughtError, {
            regionId,
            sceneId: scene.id,
            reason
          });
        }
      }
    }

    for (const [groupKey, groupRegionIds] of groupExistingRegionIdsByKey(scene, existingRegionIds).entries()) {
      debug("Cleaned managed Region group.", {
        sceneId: scene.id,
        regionGroupKey: groupKey,
        regionIds: groupRegionIds,
        reason
      });
    }

    return await scene.deleteEmbeddedDocuments("Region", existingRegionIds, {
      persistentZonesCleanup: true
    });
  } catch (caughtError) {
    const message = String(caughtError?.message ?? "");
    if (message.toLowerCase().includes("does not exist")) {
      debug("Ignored Region cleanup race because the Region was already deleted.", {
        sceneId: scene.id,
        reason,
        regionIds: existingRegionIds
      });
      return [];
    }

    throw caughtError;
  } finally {
    for (const regionId of regionsToDelete) {
      pendingRegionCleanup.delete(regionId);
    }
  }
}

function groupManagedRegionsByCleanupKey(regionDocuments) {
  const groups = new Map();

  for (const regionDocument of Array.from(regionDocuments ?? [])) {
    const key = buildManagedRegionCleanupKey(regionDocument);
    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(regionDocument);
  }

  return groups;
}

function groupExistingRegionIdsByKey(scene, regionIds) {
  const groups = new Map();

  for (const regionId of Array.from(regionIds ?? [])) {
    const regionDocument = scene?.regions?.get?.(regionId) ?? null;
    const key = buildManagedRegionCleanupKey(regionDocument);
    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(regionId);
  }

  return groups;
}

function buildManagedRegionCleanupKey(regionDocument) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  return String(
    runtime.groupId ??
    runtime.templateUuid ??
    runtime.templateId ??
    regionDocument?.uuid ??
    regionDocument?.id ??
    "managed-region"
  );
}

export async function cleanupWorldRegions({ reason = "manual" } = {}) {
  const deleted = [];

  for (const scene of game.scenes.contents) {
    const deletedInScene = await cleanupSceneRegions(scene, { reason });
    deleted.push(...deletedInScene);
  }

  return deleted;
}

export async function cleanupRegionsForItem(itemOrUuid, { reason = "manual" } = {}) {
  const itemUuid = await resolveManagedItemUuid(itemOrUuid);
  if (!itemUuid) {
    debug("Skipped managed Region Item cleanup because no Item could be resolved.", {
      itemOrUuid,
      reason
    });
    return [];
  }

  const deleted = [];

  for (const scene of game.scenes.contents) {
    const matchingRegions = findManagedRegionContractsByItem(scene, itemUuid)
      .map(({ regionDocument }) => regionDocument);

    if (!matchingRegions.length) {
      continue;
    }

    const candidateRegionIds = matchingRegions
      .map((regionDocument) => regionDocument?.id ?? null)
      .filter(Boolean);
    const regionIdsToDelete = candidateRegionIds.filter((regionId) => {
      if (pendingRegionCleanup.has(regionId)) {
        return false;
      }

      return Boolean(scene?.regions?.get?.(regionId));
    });

    if (!regionIdsToDelete.length) {
      debug("Skipped managed Region Item cleanup because deletion is already pending.", {
        itemUuid,
        sceneId: scene.id,
        reason,
        regionIds: candidateRegionIds
      });
      continue;
    }

    for (const regionId of regionIdsToDelete) {
      pendingRegionCleanup.add(regionId);
    }

    try {
      for (const regionId of regionIdsToDelete) {
        const regionDocument = scene?.regions?.get?.(regionId) ?? null;
        if (!regionDocument) {
          continue;
        }

        try {
          await cleanupLinkedDocumentsForRegion(regionDocument, {
            reason,
            skipRuntimeUpdate: true
          });
        } catch (caughtError) {
          error("Failed to cleanup linked documents before Item Region deletion.", caughtError, {
            itemUuid,
            regionId,
            sceneId: scene.id,
            reason
          });
        }
      }

      for (const [groupKey, groupRegionIds] of groupExistingRegionIdsByKey(scene, regionIdsToDelete).entries()) {
        debug("Cleaned managed Item Region group.", {
          itemUuid,
          sceneId: scene.id,
          regionGroupKey: groupKey,
          regionIds: groupRegionIds,
          reason
        });
      }

      const deletedInScene = await scene.deleteEmbeddedDocuments("Region", regionIdsToDelete);
      deleted.push(...deletedInScene);
    } catch (caughtError) {
      const message = String(caughtError?.message ?? "");
      if (message.toLowerCase().includes("does not exist")) {
        debug("Ignored managed Item Region cleanup race because the Region was already deleted.", {
          itemUuid,
          sceneId: scene.id,
          reason,
          regionIds: regionIdsToDelete
        });
        continue;
      }

      throw caughtError;
    } finally {
      for (const regionId of regionIdsToDelete) {
        pendingRegionCleanup.delete(regionId);
      }
    }
  }

  return deleted;
}

export async function rebuildActiveRegionsForItem(itemOrUuid, { reason = "manual" } = {}) {
  const itemUuid = await resolveManagedItemUuid(itemOrUuid);
  debug("regionRebuildAttempt", {
    itemUuid,
    reason,
    scope: "item-save"
  });

  if (!itemUuid) {
    debug("regionRebuildSkipped", {
      itemOrUuid,
      reason,
      scope: "item-save",
      skippedReason: "missing-item",
      activeRegionsRebuildSkipped: true
    });
    return {
      itemUuid: null,
      rebuildNeeded: false,
      rebuiltCount: 0,
      cleanedCount: 0,
      templateCount: 0
    };
  }

  const itemDocument =
    itemOrUuid?.documentName === "Item"
      ? itemOrUuid
      : await fromUuidSafe(itemUuid);
  const templateEntries = new Map();
  let activeRegionCount = 0;

  for (const scene of game.scenes.contents) {
    const matchingRegions = findManagedRegionContractsByItem(scene, itemUuid)
      .map(({ regionDocument }) => regionDocument);

    if (!matchingRegions.length) {
      continue;
    }

    activeRegionCount += matchingRegions.length;

    for (const regionDocument of matchingRegions) {
      const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
      const templateUuid = String(runtime.templateUuid ?? "").trim();
      if (!templateUuid || templateEntries.has(templateUuid)) {
        continue;
      }

      templateEntries.set(templateUuid, {
        templateUuid,
        sceneId: scene.id,
        regionId: regionDocument?.id ?? null,
        groupId: runtime.groupId ?? null
      });
    }
  }

  if (!activeRegionCount) {
    const zoneDefinition = getZoneDefinitionFromItem(itemDocument);
    const ringSummary = summarizeRingDefinitionForRebuild(zoneDefinition);
    if (ringSummary.hasRingDefinition) {
      console.warn("[persistent-zones][v14-branch] ringCreationSkipped: no-active-regions | entryPoint=rebuildRegionsForItem | selectedCompatibilityPath=item-save-rebuild", {
        itemUuid,
        itemName: itemDocument?.name ?? null,
        reason,
        scope: "item-save",
        ringCreationSkipped: true,
        ringCreationSkipReason: "no-active-regions",
        regionPlanSkipped: true,
        regionPlanSkipReason: "rebuild-only-path-has-no-existing-managed-regions",
        ...ringSummary
      });
    }
    debug("regionRebuildSkipped", {
      itemUuid,
      itemName: itemDocument?.name ?? null,
      reason,
      scope: "item-save",
      skippedReason: "no-active-regions",
      activeRegionsRebuildSkipped: true
    });
    return {
      itemUuid,
      rebuildNeeded: false,
      rebuiltCount: 0,
      cleanedCount: 0,
      templateCount: 0
    };
  }

  debug("Detected active managed Region rebuild requirement.", {
    itemUuid,
    itemName: itemDocument?.name ?? null,
    reason,
    activeRegionsRebuildNeeded: true,
    activeRegionCount,
    templateCount: templateEntries.size
  });

  const cleaned = await cleanupRegionsForItem(itemDocument ?? itemUuid, {
    reason: `${reason}-rebuild-cleanup`
  });

  const zoneDefinition = getZoneDefinitionFromItem(itemDocument);
  if (!itemDocument || !zoneDefinition) {
    debug("regionRebuildSkipped", {
      itemUuid,
      itemName: itemDocument?.name ?? null,
      reason,
      scope: "item-save",
      skippedReason: "missing-definition-after-cleanup",
      activeRegionsRebuildSkipped: true,
      cleanedCount: cleaned.length,
      templateCount: templateEntries.size
    });
    return {
      itemUuid,
      rebuildNeeded: true,
      rebuiltCount: 0,
      cleanedCount: cleaned.length,
      templateCount: templateEntries.size
    };
  }

  const rebuiltRegions = [];
  const skippedTemplates = [];

  for (const templateEntry of templateEntries.values()) {
    const templateDocument = await fromUuidSafe(templateEntry.templateUuid);
    if (templateDocument?.documentName !== "MeasuredTemplate") {
      skippedTemplates.push({
        ...templateEntry,
        reason: "missing-template"
      });
      continue;
    }

    const createdRegion = await createRegionFromTemplate(templateDocument, {
      force: true,
      item: itemDocument,
      rawDefinition: zoneDefinition
    });

    if (createdRegion) {
      rebuiltRegions.push(createdRegion);
      continue;
    }

    skippedTemplates.push({
      ...templateEntry,
      reason: "create-returned-null"
    });
  }

  if (!rebuiltRegions.length) {
    debug("regionRebuildSkipped", {
      itemUuid,
      itemName: itemDocument?.name ?? null,
      reason,
      scope: "item-save",
      skippedReason: "no-linked-templates-recreated",
      activeRegionsRebuildSkipped: true,
      cleanedCount: cleaned.length,
      templateCount: templateEntries.size,
      skippedTemplates
    });
  } else {
    debug("regionRebuildSuccess", {
      itemUuid,
      itemName: itemDocument?.name ?? null,
      reason,
      scope: "item-save",
      activeRegionsRebuilt: true,
      cleanedCount: cleaned.length,
      rebuiltCount: rebuiltRegions.length,
      templateCount: templateEntries.size,
      skippedTemplates
    });
  }

  return {
    itemUuid,
    rebuildNeeded: true,
    rebuiltCount: rebuiltRegions.length,
    cleanedCount: cleaned.length,
    templateCount: templateEntries.size,
    skippedTemplates
  };
}

async function onCanvasReady(scene) {
  if (!isPrimaryGM()) {
    return;
  }

  try {
    await cleanupSceneRegions(scene ?? canvas?.scene ?? null, { reason: "canvas-ready" });
  } catch (caughtError) {
    error("Failed to cleanup Regions on canvasReady.", caughtError);
  }
}

async function resolveManagedItemUuid(itemOrUuid) {
  if (!itemOrUuid) {
    return null;
  }

  if (itemOrUuid?.documentName === "Item") {
    return itemOrUuid.uuid ?? null;
  }

  if (typeof itemOrUuid !== "string") {
    return null;
  }

  const resolvedDocument = await fromUuidSafe(itemOrUuid);
  if (resolvedDocument?.documentName === "Item") {
    return resolvedDocument.uuid ?? null;
  }

  if (resolvedDocument?.parent?.documentName === "Item") {
    return resolvedDocument.parent.uuid ?? null;
  }

  return null;
}

async function onDeleteMeasuredTemplate(templateDocument) {
  if (!isPrimaryGM()) {
    return;
  }

  try {
    await cleanupSceneRegions(templateDocument?.parent ?? null, { reason: "template-deleted" });
  } catch (caughtError) {
    error("Failed to cleanup Regions after template deletion.", caughtError, {
      templateId: templateDocument?.id ?? null
    });
  }
}

async function onDeleteItem(item) {
  if (!isPrimaryGM()) {
    return;
  }

  try {
    await cleanupWorldRegions({ reason: "item-deleted" });
  } catch (caughtError) {
    error("Failed to cleanup Regions after item deletion.", caughtError, {
      itemUuid: item?.uuid ?? null
    });
  }
}

async function onDeleteActiveEffect(activeEffect, options = {}) {
  if (!isPrimaryGM()) {
    return;
  }
  if (options?.persistentZonesRegionLifecycleCleanup) {
    return;
  }
  try {
    logOwnerEffectEvent("deleteActiveEffect", activeEffect);
    const ownerEffectUuid = activeEffect?.uuid ?? null;
    const matchingRegions = findManagedRegionsByOwnerEffect(ownerEffectUuid);
    if (!shouldHandleLifecycleEffect(activeEffect, MODULE_ID, { referencedRegionCount: matchingRegions.length })) {
      return;
    }
    logOwnerEffectDeletePlan(activeEffect, matchingRegions);
    if (isPersistentZonesDedicatedOwnerEffect(activeEffect)) {
      logDedicatedOwnerDeletePlan(activeEffect, matchingRegions);
    }
    console.info("[persistent-zones][lifecycle] OWNER EFFECT DELETED", {
      ownerEffectUuid,
      effectId: activeEffect?.id ?? null,
      regionCount: matchingRegions.length
    });

    for (const { scene, regions } of groupRegionsByScene(matchingRegions)) {
      const regionIds = regions.map((region) => region?.id ?? null).filter(Boolean);
      for (const region of regions) {
        await cleanupLinkedDocumentsForRegion(region, {
          reason: "owner-effect-deleted",
          skipRuntimeUpdate: true
        });
      }
      if (regionIds.length) {
        await scene.deleteEmbeddedDocuments("Region", regionIds, {
          persistentZonesEffectLifecycleCleanup: true
        });
        console.info("[persistent-zones][lifecycle] REGION REMOVED FROM EFFECT", {
          ownerEffectUuid,
          sceneId: scene?.id ?? null,
          regionIds
        });
      }
    }
  } catch (caughtError) {
    error("Failed to cleanup Regions after ActiveEffect deletion.", caughtError, {
      effectId: activeEffect?.id ?? null
    });
  }
}

async function onUpdateActiveEffect(activeEffect, changed = {}, options = {}) {
  if (!isPrimaryGM()) {
    return;
  }
  if (options?.persistentZonesRegionLifecycleCleanup) {
    return;
  }
  try {
    logOwnerEffectEvent("updateActiveEffect", activeEffect);
    const ownerEffectUuid = activeEffect?.uuid ?? null;
    const matchingRegions = findManagedRegionsByOwnerEffect(ownerEffectUuid);
    if (!shouldHandleLifecycleEffect(activeEffect, MODULE_ID, { referencedRegionCount: matchingRegions.length })) {
      return;
    }
    const changedKeys = Object.keys(changed ?? {});
    const disabledChanged = changedKeys.includes("disabled") || changedKeys.some((key) => key.endsWith(".disabled"));
    if (!disabledChanged) {
      await cleanupWorldRegions({ reason: `active-effect-${activeEffect?.id ?? "unknown"}` });
      return;
    }

    const disabled = Boolean(activeEffect?.disabled);
    for (const { scene, regions } of groupRegionsByScene(matchingRegions)) {
      for (const region of regions) {
        await region.update({
          hidden: disabled,
          [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.runtimeDisabled`]: disabled,
          [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.disabledByEffect`]: disabled ? ownerEffectUuid : null,
          [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.normalizedDefinition.enabled`]: !disabled
        }, {
          persistentZonesEffectLifecycleUpdate: true
        });
      }
      console.info(`[persistent-zones][lifecycle] ${disabled ? "REGION DISABLED FROM EFFECT" : "REGION REENABLED FROM EFFECT"}`, {
        ownerEffectUuid,
        sceneId: scene?.id ?? null,
        regionIds: regions.map((region) => region?.id ?? null).filter(Boolean)
      });
    }
  } catch (caughtError) {
    error("Failed to update Regions after ActiveEffect update.", caughtError, {
      effectId: activeEffect?.id ?? null
    });
  }
}

function findManagedRegionsByOwnerEffect(ownerEffectUuid) {
  if (!ownerEffectUuid) {
    return [];
  }

  const matches = [];
  for (const scene of game?.scenes?.contents ?? []) {
    for (const region of findManagedRegions(scene)) {
      const runtime = getRegionRuntimeFlags(region) ?? {};
      if (getOwnerEffectUuidFromRuntime(runtime) === ownerEffectUuid) {
        matches.push(region);
      }
    }
  }
  return matches;
}

function groupRegionsByScene(regions = []) {
  const groups = new Map();
  for (const region of regions) {
    const scene = region?.parent ?? null;
    if (!scene) {
      continue;
    }
    const group = groups.get(scene.id) ?? { scene, regions: [] };
    group.regions.push(region);
    groups.set(scene.id, group);
  }
  return Array.from(groups.values());
}

function getOwnerEffectUuidFromRuntime(runtime = {}) {
  return (
    runtime.ownerEffectUuid ??
    runtime.activeEffectUuid ??
    runtime.concentrationEffectUuid ??
    runtime.normalizedDefinition?.concentration?.effectUuid ??
    null
  );
}

async function validateManagedRegion(regionDocument, { scene = null, reason = "manual" } = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument);
  if (!runtime) {
    return { isValid: true };
  }

  const v14LifecycleValidation = await validateV14NativeManagedRegionLifecycle(regionDocument, {
    scene,
    reason,
    cleanupFunction: "cleanupSceneRegions"
  });
  if (v14LifecycleValidation) {
    return v14LifecycleValidation;
  }

  const ringProtection = getV14NativeCleanupProtection(regionDocument);
  if (ringProtection.protected) {
    return {
      isValid: true,
      reason: ringProtection.reason
    };
  }

  const linkedTemplate = await fromUuidSafe(runtime.templateUuid);
  if (!linkedTemplate) {
    return { isValid: false, reason: "The linked MeasuredTemplate no longer exists." };
  }

  const linkedItem = await fromUuidSafe(runtime.itemUuid);
  if (!linkedItem) {
    return { isValid: false, reason: "The linked Item no longer exists." };
  }

  const normalizedDefinition = runtime.normalizedDefinition ?? {};
  if (!requiresConcentrationValidation(normalizedDefinition)) {
    return { isValid: true };
  }

  return validateConcentrationState({ linkedItem, normalizedDefinition, runtime });
}

async function validateV14NativeManagedRegionLifecycle(regionDocument, {
  scene = null,
  reason = "manual",
  cleanupFunction = "cleanupSceneRegions"
} = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  if (String(runtime.architecturePath ?? "").toLowerCase() !== "v14-region-native") {
    return null;
  }

  const ownerEffectUuid = getOwnerEffectUuidFromRuntime(runtime);
  const itemUuid = runtime.itemUuid ?? null;
  const actorUuid =
    runtime.actorUuid ??
    runtime.casterUuid ??
    runtime.normalizedDefinition?.concentration?.actorUuid ??
    null;
  const item = itemUuid ? await fromUuidSafe(itemUuid) : null;
  const actor = actorUuid ? await fromUuidSafe(actorUuid) : null;
  const ownerEffect = await resolveOwnerEffectForRuntime(runtime, { actor });
  const state = {
    scene,
    regionDocument,
    runtime,
    cleanupFunction,
    deletionReason: null,
    ownerEffect,
    item,
    actor
  };

  if (ownerEffectUuid && ownerEffect) {
    await logStartupRegionReconciliation(regionDocument, {
      ...state,
      reason,
      deletionReason: ownerEffect.disabled ? "owner-effect-disabled-region-retained" : "owner-effect-resolved-region-retained"
    });
    return { isValid: true, reason: "v14-owner-effect-resolved" };
  }

  if (isStartupCleanupReason(reason) && ownerEffectUuid && !ownerEffect) {
    await logStartupRegionReconciliation(regionDocument, {
      ...state,
      reason,
      deletionReason: "startup-owner-effect-unresolved-deferred"
    });
    return {
      isValid: true,
      reason: "startup-owner-effect-unresolved-deferred",
      deferStartupReconciliation: true
    };
  }

  if (ownerEffectUuid && !ownerEffect) {
    await logStartupRegionReconciliation(regionDocument, {
      ...state,
      reason,
      deletionReason: "owner-effect-missing-confirmed"
    });
    return { isValid: false, reason: "The linked owner ActiveEffect no longer exists." };
  }

  if (requiresConcentrationValidation(runtime.normalizedDefinition ?? {})) {
    return validateConcentrationState({
      linkedItem: item,
      normalizedDefinition: runtime.normalizedDefinition ?? {},
      runtime
    });
  }

  if (itemUuid && item) {
    return { isValid: true, reason: "v14-item-resolved-without-owner-effect" };
  }

  if (isStartupCleanupReason(reason) && itemUuid && !item) {
    await logStartupRegionReconciliation(regionDocument, {
      ...state,
      reason,
      deletionReason: "startup-item-unresolved-deferred"
    });
    return {
      isValid: true,
      reason: "startup-item-unresolved-deferred",
      deferStartupReconciliation: true
    };
  }

  if (itemUuid && !item) {
    await logStartupRegionReconciliation(regionDocument, {
      ...state,
      reason,
      deletionReason: "item-missing-confirmed"
    });
    return { isValid: false, reason: "The linked Item no longer exists." };
  }

  return { isValid: true, reason: "v14-native-region-no-owner-link" };
}

async function resolveOwnerEffectForRuntime(runtime = {}, { actor = null } = {}) {
  const ownerEffectUuid = getOwnerEffectUuidFromRuntime(runtime);
  if (ownerEffectUuid) {
    const resolved = await fromUuidSafe(ownerEffectUuid);
    if (resolved?.documentName === "ActiveEffect") {
      return resolved;
    }
  }

  const effectId =
    runtime.activeEffectId ??
    runtime.concentrationEffectId ??
    runtime.normalizedDefinition?.concentration?.effectId ??
    extractActiveEffectIdFromUuid(ownerEffectUuid);
  if (!effectId) {
    return null;
  }

  const resolvedActor = actor ?? await resolveConcentrationActor({
    concentration: runtime.normalizedDefinition?.concentration ?? {},
    runtime,
    linkedItem: null
  });
  return Array.from(resolvedActor?.effects ?? []).find((effect) => effect?.id === effectId) ?? null;
}

function extractActiveEffectIdFromUuid(uuid) {
  const parts = String(uuid ?? "").split(".");
  const effectIndex = parts.findIndex((part) => part === "ActiveEffect");
  return effectIndex >= 0 ? parts[effectIndex + 1] ?? null : null;
}

function logCleanupCandidateRegion(regionDocument, { scene = null, reason = "manual" } = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  console.warn(`[persistent-zones][cleanup] cleanupCandidateRegion: id=${regionDocument?.id ?? null} reason=${reason} architecturePath=${runtime.architecturePath ?? "null"} geometryType=${runtime.geometryType ?? "null"} groupId=${runtime.groupId ?? "null"} partId=${runtime.partId ?? "null"} ringOperationId=${runtime.ringOperationId ?? "null"}`);
  debug("cleanupCandidateRegion", {
    sceneId: scene?.id ?? null,
    regionId: regionDocument?.id ?? null,
    reason,
    architecturePath: runtime.architecturePath ?? null,
    geometryType: runtime.geometryType ?? null,
    regionSourceStrategy: runtime.regionSourceStrategy ?? null,
    groupId: runtime.groupId ?? null,
    partId: runtime.partId ?? null,
    ringOperationId: runtime.ringOperationId ?? null,
    cleanupPolicy: runtime.cleanupPolicy ?? null,
    skipConcentrationCleanup: runtime.skipConcentrationCleanup ?? null,
    lifecycle: runtime.lifecycle ?? null
  });
}

function isStartupCleanupReason(reason) {
  return STARTUP_CLEANUP_REASONS.has(String(reason ?? ""));
}

function scheduleStartupRegionReconciliation(scene, reason = "startup") {
  if (!scene?.id) {
    return;
  }

  const key = `${scene.id}:${reason}`;
  if (pendingStartupReconciliations.has(key)) {
    return;
  }

  pendingStartupReconciliations.add(key);
  setTimeout(async () => {
    try {
      await cleanupSceneRegions(scene, { reason: `${reason}-deferred` });
    } catch (caughtError) {
      error("Failed deferred startup Region reconciliation.", caughtError, {
        sceneId: scene?.id ?? null,
        reason
      });
    } finally {
      pendingStartupReconciliations.delete(key);
    }
  }, STARTUP_RECONCILIATION_DELAY_MS);
}

async function logStartupRegionReconciliation(regionDocument, {
  scene = null,
  reason = "manual",
  runtime = null,
  cleanupFunction = "cleanupSceneRegions",
  deletionReason = null,
  ownerEffect = undefined,
  item = undefined,
  actor = undefined
} = {}) {
  if (!isStartupCleanupReason(reason) && !String(reason ?? "").includes("deferred")) {
    return;
  }

  const runtimeFlags = runtime ?? getRegionRuntimeFlags(regionDocument) ?? {};
  const ownerEffectUuid = getOwnerEffectUuidFromRuntime(runtimeFlags);
  const itemUuid = runtimeFlags.itemUuid ?? null;
  const actorUuid =
    runtimeFlags.actorUuid ??
    runtimeFlags.casterUuid ??
    runtimeFlags.normalizedDefinition?.concentration?.actorUuid ??
    null;
  const resolvedItem = item === undefined && itemUuid
    ? await fromUuidSafe(itemUuid)
    : item;
  const resolvedActor = actor === undefined && actorUuid
    ? await fromUuidSafe(actorUuid)
    : actor;
  const resolvedOwnerEffect = ownerEffect === undefined
    ? await resolveOwnerEffectForRuntime(runtimeFlags, { actor: resolvedActor })
    : ownerEffect;

  console.warn("[persistent-zones][startup] PZ STARTUP REGION RECONCILIATION", {
    sceneId: scene?.id ?? regionDocument?.parent?.id ?? null,
    regionId: regionDocument?.id ?? null,
    groupId: runtimeFlags.groupId ?? null,
    partId: runtimeFlags.partId ?? null,
    ownerEffectUuid,
    itemUuid,
    actorUuid,
    ownerEffectResolved: Boolean(resolvedOwnerEffect),
    ownerEffectDisabled: Boolean(resolvedOwnerEffect?.disabled),
    itemResolved: Boolean(resolvedItem),
    actorResolved: Boolean(resolvedActor),
    cleanupFunction,
    deletionReason,
    foundryReady: Boolean(game?.ready),
    canvasReady: Boolean(canvas?.ready)
  });
}

function getV14NativeCleanupProtection(regionDocument) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? null;
  if (!runtime) {
    return { protected: false, reason: "missing-runtime" };
  }

  const architecturePath = String(runtime.architecturePath ?? "").toLowerCase();
  const geometryType = String(runtime.geometryType ?? runtime.normalizedDefinition?.geometry?.type ?? "").toLowerCase();
  const strategy = String(runtime.regionSourceStrategy ?? "").toLowerCase();
  const isV14Native = architecturePath === "v14-region-native";
  const isNativeRegion =
    strategy === "v14-native-region-shapes" ||
    runtime.creationSource === "persistent-zones-v14-native-region";
  const isRingSegment =
    geometryType === "ring" ||
    strategy === "v14-region-native-segment-group" ||
    runtime.creationSource === "persistent-zones-internal-ring-segment" ||
    Boolean(runtime.ringOperationId);
  const hasContract =
    Boolean(runtime.itemUuid) &&
    Boolean(runtime.groupId) &&
    Boolean(runtime.partId) &&
    (isNativeRegion || Boolean(runtime.ringOperationId));
  const hasPersistentPolicy =
    runtime.cleanupPolicy === "persistent-zone" ||
    runtime.skipConcentrationCleanup === true ||
    runtime.lifecycle === "manual";

  if (isV14Native && (isNativeRegion || isRingSegment) && hasContract && hasPersistentPolicy) {
    return {
      protected: true,
      reason: isNativeRegion ? "valid-v14-native-persistent-zone" : "valid-v14-ring-persistent-zone",
      architecturePath: runtime.architecturePath ?? null,
      geometryType: runtime.geometryType ?? null,
      regionSourceStrategy: runtime.regionSourceStrategy ?? null,
      groupId: runtime.groupId ?? null,
      partId: runtime.partId ?? null,
      itemUuid: runtime.itemUuid ?? null,
      ringOperationId: runtime.ringOperationId ?? null,
      cleanupPolicy: runtime.cleanupPolicy ?? null,
      skipConcentrationCleanup: runtime.skipConcentrationCleanup ?? null,
      lifecycle: runtime.lifecycle ?? null
    };
  }

  if (isV14Native && (isNativeRegion || isRingSegment)) {
    return {
      protected: false,
      reason: isNativeRegion ? "v14-native-region-incomplete-contract" : "v14-ring-segment-incomplete-contract",
      architecturePath: runtime.architecturePath ?? null,
      geometryType: runtime.geometryType ?? null,
      regionSourceStrategy: runtime.regionSourceStrategy ?? null,
      groupId: runtime.groupId ?? null,
      partId: runtime.partId ?? null,
      itemUuid: runtime.itemUuid ?? null,
      ringOperationId: runtime.ringOperationId ?? null,
      cleanupPolicy: runtime.cleanupPolicy ?? null,
      skipConcentrationCleanup: runtime.skipConcentrationCleanup ?? null,
      lifecycle: runtime.lifecycle ?? null
    };
  }

  return { protected: false, reason: "not-v14-native-region" };
}

function requiresConcentrationValidation(normalizedDefinition) {
  const concentration = normalizedDefinition?.concentration ?? {};

  return Boolean(
    concentration.required === true ||
      concentration.effectUuid ||
      concentration.effectId ||
      concentration.actorUuid
  );
}

async function validateConcentrationState({ linkedItem, normalizedDefinition, runtime }) {
  const concentration = normalizedDefinition.concentration ?? {};

  if (concentration.effectUuid) {
    const effectByUuid = await fromUuidSafe(concentration.effectUuid);
    if (isUsableConcentrationEffect(effectByUuid, concentration, linkedItem)) {
      return { isValid: true };
    }

    return { isValid: false, reason: "The linked concentration effect is missing or inactive." };
  }

  const actor = await resolveConcentrationActor({ concentration, runtime, linkedItem });
  if (!actor) {
    return concentration.required === true
      ? { isValid: false, reason: "No actor could be resolved to validate concentration." }
      : { isValid: true };
  }

  const matchingEffect = Array.from(actor.effects ?? []).find((effect) =>
    isUsableConcentrationEffect(effect, concentration, linkedItem)
  );

  if (matchingEffect) {
    return { isValid: true };
  }

  return concentration.required === true
    ? { isValid: false, reason: "The required concentration effect is no longer active." }
    : { isValid: true };
}

async function resolveConcentrationActor({ concentration, runtime, linkedItem }) {
  const actorUuid = pickFirstDefined(
    concentration.actorUuid,
    runtime.casterUuid,
    runtime.actorUuid,
    linkedItem.actor?.uuid
  );

  if (actorUuid) {
    const resolved = await fromUuidSafe(actorUuid);
    if (resolved?.documentName === "Actor") {
      return resolved;
    }

    if (resolved?.actor) {
      return resolved.actor;
    }
  }

  return linkedItem?.actor ?? null;
}

function isUsableConcentrationEffect(activeEffect, concentration, linkedItem) {
  if (!activeEffect || activeEffect.disabled) {
    return false;
  }

  if (concentration.effectId && activeEffect.id === concentration.effectId) {
    return true;
  }

  if (concentration.effectUuid && activeEffect.uuid === concentration.effectUuid) {
    return true;
  }

  const statuses =
    activeEffect.statuses instanceof Set
      ? Array.from(activeEffect.statuses)
      : Array.isArray(activeEffect.statuses)
        ? activeEffect.statuses
        : [];

  const normalizedStatuses = statuses.map((status) => String(status).toLowerCase());
  const statusId = String(concentration.statusId ?? "concentrating").toLowerCase();
  const hasConcentrationStatus =
    normalizedStatuses.includes(statusId) ||
    normalizedStatuses.includes("concentrating") ||
    normalizedStatuses.includes("concentration");

  if (!hasConcentrationStatus) {
    return false;
  }

  const origin = activeEffect.origin ?? "";
  const expectedOrigin = concentration.originUuid ?? linkedItem?.uuid ?? "";

  if (!expectedOrigin) {
    return true;
  }

  return origin === expectedOrigin || origin.startsWith(expectedOrigin);
}

function summarizeRingDefinitionForRebuild(zoneDefinition) {
  const parts = Array.isArray(zoneDefinition?.parts) ? zoneDefinition.parts : [];
  const partGeometryTypes = parts.map((part) => String(part?.geometry?.type ?? "template").toLowerCase());
  const normalizedGeometryType = String(zoneDefinition?.geometry?.type ?? "").toLowerCase() || null;
  const selectedGeometryType = partGeometryTypes.find((geometryType) => geometryType.includes("ring"))
    ?? (normalizedGeometryType?.includes("ring") ? normalizedGeometryType : null);

  return {
    hasRingDefinition: Boolean(selectedGeometryType),
    selectedGeometryType,
    normalizedGeometryType,
    partGeometryTypes,
    partCountExpected: partGeometryTypes.length || (normalizedGeometryType ? 1 : 0)
  };
}

function logOwnerEffectEvent(hookName, activeEffect) {
  const summary = summarizeOwnerEffect(activeEffect);
  console.warn(
    `[persistent-zones][lifecycle] PZ OWNER EFFECT EVENT | hookName=${hookName} | timestamp=${Date.now()} | effectId=${summary.effectId ?? "null"} | effectUuid=${summary.effectUuid ?? "null"} | effectName=${summary.effectName ?? "null"} | actorUuid=${summary.actorUuid ?? "null"} | origin=${summary.origin ?? "null"} | itemUuid=${summary.itemUuid ?? "null"} | activityId=${summary.activityId ?? "null"} | workflowId=${summary.workflowId ?? "null"} | messageId=${summary.messageId ?? "null"} | templateId=${summary.templateId ?? "null"} | templateUuid=${summary.templateUuid ?? "null"} | regionId=${summary.regionId ?? "null"} | regionUuid=${summary.regionUuid ?? "null"} | flagsDnd5e=${summary.flagsDnd5eJson} | flagsMidiQol=${summary.flagsMidiQolJson} | dependents=${summary.dependentsJson} | disabled=${summary.disabled} | duration=${summary.durationJson} | concentrationStatus=${summary.concentrationStatus ?? "null"}`
  );
}

function logOwnerEffectDeletePlan(activeEffect, matchingRegions = []) {
  const regionRows = Array.from(matchingRegions ?? []).map((region) => {
    const runtime = getRegionRuntimeFlags(region) ?? {};
    return {
      regionId: region?.id ?? null,
      groupId: runtime.groupId ?? null,
      runtimeOwnerEffectUuid: getOwnerEffectUuidFromRuntime(runtime)
    };
  });
  console.warn(
    `[persistent-zones][lifecycle] PZ OWNER EFFECT DELETE PLAN | deletedEffectUuid=${activeEffect?.uuid ?? "null"} | matchingRegionIds=${stringifyCompact(regionRows.map((row) => row.regionId).filter(Boolean))} | matchingRegionGroupIds=${stringifyCompact(regionRows.map((row) => row.groupId).filter(Boolean))} | runtimeOwnerEffectUuids=${stringifyCompact(regionRows.map((row) => row.runtimeOwnerEffectUuid ?? null))} | deletionIds=${stringifyCompact(regionRows.map((row) => row.regionId).filter(Boolean))}`
  );
}

function logDedicatedOwnerDeletePlan(activeEffect, matchingRegions = []) {
  const effectData = activeEffect?.toObject?.() ?? {};
  const targetRegionId = getPropertyPath(effectData, `flags.${MODULE_ID}.regionId`) ?? null;
  const targetGroupId = getPropertyPath(effectData, `flags.${MODULE_ID}.groupId`) ?? null;
  const matchingRegionIds = Array.from(matchingRegions ?? []).map((region) => region?.id ?? null).filter(Boolean);
  console.warn(
    `[persistent-zones][lifecycle] PZ DEDICATED OWNER DELETE PLAN | deletedEffectUuid=${activeEffect?.uuid ?? "null"} | targetRegionId=${targetRegionId ?? "null"} | targetGroupId=${targetGroupId ?? "null"} | matchingRegionIds=${stringifyCompact(matchingRegionIds)} | deletionIds=${stringifyCompact(matchingRegionIds)} | deletionReason=dedicated-owner-effect-deleted`
  );
}

function summarizeOwnerEffect(activeEffect) {
  const data = activeEffect?.toObject?.() ?? {};
  const dnd5eFlags = data.flags?.dnd5e ?? activeEffect?.flags?.dnd5e ?? null;
  const midiFlags = data.flags?.["midi-qol"] ?? activeEffect?.flags?.["midi-qol"] ?? null;
  const regionReference = findFirstReference(data, /(?:Scene\.[^.]+\.Region\.[^.\s"',}]+|Region\.[^.\s"',}]+)/);
  const templateReference = findFirstReference(data, /(?:Scene\.[^.]+\.MeasuredTemplate\.[^.\s"',}]+|MeasuredTemplate\.[^.\s"',}]+)/);
  return {
    effectId: activeEffect?.id ?? data._id ?? null,
    effectUuid: activeEffect?.uuid ?? null,
    effectName: activeEffect?.name ?? data.name ?? data.label ?? null,
    actorUuid: activeEffect?.parent?.uuid ?? null,
    origin: activeEffect?.origin ?? data.origin ?? null,
    itemUuid: resolveActiveEffectItemUuid(activeEffect, data),
    activityId: resolveActiveEffectActivityId(data),
    workflowId: getPropertyPath(data, "flags.midi-qol.workflowId") ?? getPropertyPath(data, "flags.dnd5e.workflowId") ?? null,
    messageId: getPropertyPath(data, "flags.midi-qol.messageId") ?? getPropertyPath(data, "flags.dnd5e.messageId") ?? null,
    templateId: templateReference?.id ?? getPropertyPath(data, "flags.dnd5e.templateId") ?? getPropertyPath(data, "flags.midi-qol.templateId") ?? null,
    templateUuid: templateReference?.uuid ?? getPropertyPath(data, "flags.dnd5e.templateUuid") ?? getPropertyPath(data, "flags.midi-qol.templateUuid") ?? null,
    regionId: regionReference?.id ?? getPropertyPath(data, "flags.dnd5e.regionId") ?? getPropertyPath(data, "flags.midi-qol.regionId") ?? null,
    regionUuid: regionReference?.uuid ?? getPropertyPath(data, "flags.dnd5e.regionUuid") ?? getPropertyPath(data, "flags.midi-qol.regionUuid") ?? null,
    flagsDnd5eJson: stringifyCompact(dnd5eFlags),
    flagsMidiQolJson: stringifyCompact(midiFlags),
    dependentsJson: stringifyCompact(data.dependents ?? activeEffect?.dependents ?? null),
    disabled: Boolean(activeEffect?.disabled ?? data.disabled),
    durationJson: stringifyCompact(data.duration ?? activeEffect?.duration ?? null),
    concentrationStatus: getPropertyPath(data, "statuses.concentrating") ?? getPropertyPath(data, "flags.dnd5e.concentration") ?? getPropertyPath(data, "flags.midi-qol.concentration") ?? null
  };
}

function isPersistentZonesDedicatedOwnerEffect(activeEffect) {
  const data = activeEffect?.toObject?.() ?? {};
  return Boolean(
    activeEffect?.flags?.[MODULE_ID]?.managedOwnerEffect === true ||
      data.flags?.[MODULE_ID]?.managedOwnerEffect === true
  );
}

function resolveActiveEffectItemUuid(activeEffect, effectData = null) {
  const data = effectData ?? activeEffect?.toObject?.() ?? {};
  const candidates = [
    activeEffect?.origin,
    data.origin,
    getPropertyPath(data, "flags.dnd5e.itemUuid"),
    getPropertyPath(data, "flags.dnd5e.item.uuid"),
    getPropertyPath(data, "flags.dnd5e.activity.item.uuid"),
    getPropertyPath(data, "flags.dnd5e.activity.itemUuid"),
    getPropertyPath(data, "flags.midi-qol.itemUuid"),
    getPropertyPath(data, "flags.midi-qol.item.uuid")
  ];
  return candidates.map(extractItemUuidFromValue).find(Boolean) ?? null;
}

function resolveActiveEffectActivityId(effectData = null) {
  const data = effectData ?? {};
  return [
    getPropertyPath(data, "flags.dnd5e.activityId"),
    getPropertyPath(data, "flags.dnd5e.activity.id"),
    getPropertyPath(data, "flags.dnd5e.activity.uuid"),
    getPropertyPath(data, "flags.midi-qol.activityId"),
    getPropertyPath(data, "flags.midi-qol.activityUuid")
  ].map((value) => String(value ?? "").split(".").pop()).find(Boolean) ?? null;
}

function extractItemUuidFromValue(value) {
  const text = String(value ?? "");
  if (!text) {
    return null;
  }
  const match = text.match(/Actor\.[^.]+\.Item\.[^.]+/);
  return match?.[0] ?? null;
}

function findFirstReference(source, pattern) {
  const text = stringifyCompact(source);
  const match = text.match(pattern);
  if (!match?.[0]) {
    return null;
  }
  const uuid = match[0];
  return {
    uuid,
    id: uuid.split(".").pop()
  };
}

function getPropertyPath(source, path) {
  if (!source || !path) {
    return null;
  }
  return String(path).split(".").reduce((value, key) => value?.[key], source);
}

function stringifyCompact(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (_caughtError) {
    return "\"[unserializable]\"";
  }
}
