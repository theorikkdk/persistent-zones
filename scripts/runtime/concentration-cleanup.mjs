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
import { getZoneDefinitionFromItem } from "./zone-definition.mjs";

let hooksRegistered = false;
const pendingRegionCleanup = new Set();

export function registerConcentrationCleanupHooks() {
  if (hooksRegistered) {
    return;
  }

  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("deleteMeasuredTemplate", onDeleteMeasuredTemplate);
  Hooks.on("deleteItem", onDeleteItem);
  Hooks.on("deleteActiveEffect", onActiveEffectLifecycleChange);
  Hooks.on("updateActiveEffect", onActiveEffectLifecycleChange);

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
    const validation = await validateManagedRegion(region);
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

    return await scene.deleteEmbeddedDocuments("Region", existingRegionIds);
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
    const matchingRegions = findManagedRegions(scene, (regionDocument) => {
      const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
      return runtime.itemUuid === itemUuid;
    });

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
  if (!itemUuid) {
    debug("Skipped active managed Region rebuild because no Item could be resolved.", {
      itemOrUuid,
      reason,
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
    const matchingRegions = findManagedRegions(scene, (regionDocument) => {
      const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
      return runtime.itemUuid === itemUuid;
    });

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
    debug("Skipped active managed Region rebuild because no active Regions were found for the Item.", {
      itemUuid,
      itemName: itemDocument?.name ?? null,
      reason,
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
    debug("Skipped active managed Region rebuild because no active definition could be resolved after cleanup.", {
      itemUuid,
      itemName: itemDocument?.name ?? null,
      reason,
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
    debug("Skipped active managed Region rebuild because no linked templates could be recreated.", {
      itemUuid,
      itemName: itemDocument?.name ?? null,
      reason,
      activeRegionsRebuildSkipped: true,
      cleanedCount: cleaned.length,
      templateCount: templateEntries.size,
      skippedTemplates
    });
  } else {
    debug("Rebuilt active managed Regions for Item.", {
      itemUuid,
      itemName: itemDocument?.name ?? null,
      reason,
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

async function onActiveEffectLifecycleChange(activeEffect) {
  if (!isPrimaryGM()) {
    return;
  }

  try {
    await cleanupWorldRegions({ reason: `active-effect-${activeEffect?.id ?? "unknown"}` });
  } catch (caughtError) {
    error("Failed to cleanup Regions after ActiveEffect change.", caughtError, {
      effectId: activeEffect?.id ?? null
    });
  }
}

async function validateManagedRegion(regionDocument) {
  const runtime = getRegionRuntimeFlags(regionDocument);
  if (!runtime) {
    return { isValid: true };
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

  return linkedItem.actor ?? null;
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
