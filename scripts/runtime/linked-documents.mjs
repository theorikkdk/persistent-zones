import { MODULE_ID, RUNTIME_FLAG_KEY } from "../constants.mjs";
import {
  coerceBoolean,
  coerceNumber,
  debug,
  distanceToPixels,
  duplicateData,
  getRegionRuntimeFlags,
  getRegionShapeData,
  getTemplateType,
  isWallHeightSupported
} from "./utils.mjs";

const DEFAULT_LINKED_WALL_SEGMENTS = 24;
const DEFAULT_LINKED_LIGHT_ALPHA = 0.15;
const DEFAULT_LINKED_LIGHT_LUMINOSITY = 0.5;
const DEFAULT_LINKED_LIGHT_ANGLE = 360;
const DEFAULT_LINKED_LIGHT_COLOR = "#fff4b0";
const DEFAULT_RING_LIGHT_MAX_COUNT = 24;
const DEFAULT_RING_LIGHT_OVERLAP_TARGET = 0.28;
const MAX_RING_LIGHT_ANGULAR_GAP = Math.PI / 4;
const linkedSyncStates = new Map();
let linkedSyncRequestCounter = 0;

export async function syncLinkedDocumentsForRegion({
  templateDocument,
  regionDocument,
  normalizedDefinition = null,
  shapes = null,
  reason = "syncLinkedDocumentsForRegion"
} = {}) {
  return enqueueLinkedDocumentsSync({
    templateDocument,
    regionDocument,
    normalizedDefinition,
    shapes,
    reason
  });
}

async function enqueueLinkedDocumentsSync({
  templateDocument,
  regionDocument,
  normalizedDefinition = null,
  shapes = null,
  reason = "syncLinkedDocumentsForRegion"
} = {}) {
  const scene = regionDocument?.parent ?? templateDocument?.parent ?? null;
  if (!scene || !regionDocument) {
    return { wallIds: [], lightIds: [], syncApplied: false };
  }
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const key = buildLinkedSyncKey(scene, regionDocument);
  const requestId = `linked-sync-${++linkedSyncRequestCounter}`;
  const requestedAt = Date.now();
  const revision = requestedAt;
  const existingState = linkedSyncStates.get(key);
  safeLinkedDiagnosticLog("PZ LINKED SYNC REQUEST", {
    requestId,
    sceneId: scene?.id ?? null,
    regionId: regionDocument?.id ?? null,
    groupId: runtime.groupId ?? null,
    reason,
    revision,
    requestedAt,
    runningRequestId: existingState?.currentRequestId ?? null,
    rerunRequested: Boolean(existingState?.rerunRequested),
    internalSyncOption: false
  });

  if (existingState?.running) {
    const previousLatestRevision = existingState.latestRequestedRevision;
    existingState.latestArgs = { templateDocument, regionDocument, normalizedDefinition, shapes, reason };
    existingState.latestRequestedRevision = revision;
    existingState.latestReason = reason;
    existingState.rerunRequested = true;
    safeLinkedDiagnosticLog("PZ LINKED SYNC COALESCED", {
      runningRequestId: existingState.currentRequestId,
      incomingRequestId: requestId,
      regionId: regionDocument?.id ?? null,
      previousLatestRevision,
      newLatestRevision: revision,
      latestReason: reason
    });
    return existingState.completionPromise;
  }

  const state = {
    running: true,
    currentRequestId: requestId,
    latestRequestedRevision: revision,
    latestReason: reason,
    latestArgs: { templateDocument, regionDocument, normalizedDefinition, shapes, reason },
    rerunRequested: false,
    completionPromise: null
  };
  state.completionPromise = runLinkedDocumentsSyncQueue(key, state);
  linkedSyncStates.set(key, state);
  return state.completionPromise;
}

async function runLinkedDocumentsSyncQueue(key, state) {
  let result = { wallIds: [], lightIds: [], syncApplied: false };
  try {
    let guard = 0;
    do {
      guard += 1;
      state.rerunRequested = false;
      const requestId = state.currentRequestId;
      result = await syncLinkedDocumentsForRegionNow({
        ...state.latestArgs,
        requestId,
        revision: state.latestRequestedRevision
      });
      if (state.rerunRequested) {
        state.currentRequestId = `linked-sync-${++linkedSyncRequestCounter}`;
      }
    } while (state.rerunRequested && guard < 3);
    return result;
  } finally {
    linkedSyncStates.delete(key);
  }
}

async function syncLinkedDocumentsForRegionNow({
  templateDocument,
  regionDocument,
  normalizedDefinition = null,
  shapes = null,
  reason = "syncLinkedDocumentsForRegion",
  requestId = null,
  revision = null
} = {}) {
  const scene = regionDocument?.parent ?? templateDocument?.parent ?? null;
  const currentRegion = scene?.regions?.get?.(regionDocument?.id) ?? regionDocument;
  if (!scene || !currentRegion) {
    return { wallIds: [], lightIds: [], syncApplied: false };
  }

  const runtime = getRegionRuntimeFlags(currentRegion) ?? {};
  const activeDefinition = normalizedDefinition ?? runtime.normalizedDefinition ?? null;
  const linkedDocuments = duplicateData(runtime.linkedDocuments) ?? { wallIds: [], lightIds: [] };
  const shapeData = getFinalRegionShapeData(currentRegion, shapes);
  const geometrySummary = summarizeLinkedGeometrySource({ scene, regionDocument: currentRegion, shapes: shapeData });
  const initialWalls = collectLinkedDocuments({ scene, regionDocument: currentRegion, existingIds: linkedDocuments.wallIds ?? [], collectionName: "walls", kind: "wall" });
  const initialLights = collectLinkedDocuments({ scene, regionDocument: currentRegion, existingIds: linkedDocuments.lightIds ?? [], collectionName: "lights", kind: "light" });
  const startedAt = Date.now();
  safeLinkedDiagnosticLog("PZ LINKED SYNC START", {
    requestId,
    sceneId: scene?.id ?? null,
    regionId: currentRegion?.id ?? null,
    revision,
    startedAt,
    existingWallCount: initialWalls.length,
    existingLightCount: initialLights.length,
    existingWallKeys: initialWalls.map((document) => getLinkedWallKey(document)).filter(Boolean),
    existingLightSlots: initialLights.map((document) => getLinkedLightSlotKey(document)).filter(Boolean)
  });
  for (const row of geometrySummary) {
    safeLinkedDiagnosticLog("PZ LINKED GEOMETRY SOURCE", row);
  }

  const wallResult = await syncLinkedWalls({
    scene,
    templateDocument,
    regionDocument: currentRegion,
    linkedWalls: activeDefinition?.linkedWalls ?? {},
    shapes: shapeData,
    existingIds: linkedDocuments.wallIds ?? [],
    itemUuid: runtime.itemUuid ?? activeDefinition?.itemUuid ?? null
  });

  const lightResult = await syncLinkedLight({
    scene,
    templateDocument,
    regionDocument: currentRegion,
    linkedLight: activeDefinition?.linkedLight ?? {},
    shapes: shapeData,
    existingIds: linkedDocuments.lightIds ?? [],
    templateDistance: activeDefinition?.template?.distance ?? templateDocument?.distance ?? null,
    itemUuid: runtime.itemUuid ?? activeDefinition?.itemUuid ?? null
  });

  const wallIds = wallResult.ids ?? [];
  const lightIds = lightResult.ids ?? [];
  const nextLinkedDocuments = { wallIds, lightIds };
  await updateRegionLinkedDocuments(currentRegion, nextLinkedDocuments);
  safeLinkedDiagnosticLog("PZ LINKED DOCUMENT SYNC RESULT", {
    reason,
    regionId: currentRegion?.id ?? null,
    groupId: runtime.groupId ?? null,
    shapeType: geometrySummary.map((row) => row.shapeType).filter(Boolean).join(",") || null,
    existingWallCount: wallResult.existingCount ?? 0,
    createdWallIds: wallResult.createdIds ?? [],
    updatedWallIds: wallResult.updatedIds ?? [],
    deletedWallIds: wallResult.deletedIds ?? [],
    wallSyncSucceeded: wallResult.syncSucceeded !== false,
    wallCountAfterSync: wallIds.length,
    wallPreset: activeDefinition?.linkedWalls?.presetId ?? activeDefinition?.linkedWalls?.id ?? activeDefinition?.linkedWalls?.preset ?? null,
    wallsExistAfterSync: wallIds.every((wallId) => Boolean(scene?.walls?.get?.(wallId))),
    existingLightCount: lightResult.existingCount ?? 0,
    createdLightIds: lightResult.createdIds ?? [],
    updatedLightIds: lightResult.updatedIds ?? [],
    deletedLightIds: lightResult.deletedIds ?? [],
    lightSyncSucceeded: lightResult.syncSucceeded !== false,
    lightCountAfterSync: lightIds.length,
    geometryChanged: Boolean(wallResult.geometryChanged || lightResult.geometryChanged),
    positionChanged: Boolean(wallResult.positionChanged || lightResult.positionChanged),
    elevationChanged: Boolean(wallResult.elevationChanged || lightResult.elevationChanged),
    syncSucceeded: true,
    syncErrors: []
  });

  debug("linkedDocsSync", {
    templateId: templateDocument?.id ?? runtime.templateId ?? null,
    regionId: currentRegion?.id ?? null,
    wallIds,
    lightIds,
    syncApplied: true
  });

  safeLinkedDiagnosticLog("PZ LINKED SYNC END", {
    requestId,
    regionId: currentRegion?.id ?? null,
    revision,
    createdWallIds: wallResult.createdIds ?? [],
    updatedWallIds: wallResult.updatedIds ?? [],
    deletedWallIds: wallResult.deletedIds ?? [],
    createdLightIds: lightResult.createdIds ?? [],
    updatedLightIds: lightResult.updatedIds ?? [],
    deletedLightIds: lightResult.deletedIds ?? [],
    duplicateWallIdsDeleted: wallResult.duplicateIdsDeleted ?? [],
    duplicateLightIdsDeleted: lightResult.duplicateIdsDeleted ?? [],
    finalWallCount: wallIds.length,
    finalLightCount: lightIds.length,
    staleRequest: false,
    rerunScheduled: Boolean(linkedSyncStates.get(buildLinkedSyncKey(scene, currentRegion))?.rerunRequested),
    durationMs: Date.now() - startedAt,
    syncSucceeded: true,
    errors: []
  });

  return {
    ...nextLinkedDocuments,
    syncApplied: true
  };
}

export async function cleanupLinkedDocumentsForRegion(regionDocument, {
  reason = "manual",
  skipRuntimeUpdate = false
} = {}) {
  const scene = regionDocument?.parent ?? null;
  if (!scene || !regionDocument) {
    return { wallIds: [], lightIds: [] };
  }

  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const wallDocuments = collectLinkedDocuments({
    scene,
    regionDocument,
    existingIds: runtime.linkedDocuments?.wallIds ?? [],
    collectionName: "walls",
    kind: "wall"
  });
  const lightDocuments = collectLinkedDocuments({
    scene,
    regionDocument,
    existingIds: runtime.linkedDocuments?.lightIds ?? [],
    collectionName: "lights",
    kind: "light"
  });

  const wallIds = wallDocuments.map((document) => document.id);
  const lightIds = lightDocuments.map((document) => document.id);
  const linkedWallIdsBefore = Array.from(runtime.linkedDocuments?.wallIds ?? []);
  const linkedLightIdsBefore = Array.from(runtime.linkedDocuments?.lightIds ?? []);

  if (wallIds.length) {
    await scene.deleteEmbeddedDocuments("Wall", wallIds).catch(() => []);
    debug("Linked wall documents deleted.", {
      templateId: runtime.templateId ?? null,
      regionId: regionDocument.id,
      linkedDocumentIds: wallIds,
      reason,
      syncApplied: true
    });
  }

  if (lightIds.length) {
    await scene.deleteEmbeddedDocuments("AmbientLight", lightIds).catch(() => []);
    debug("Linked light documents deleted.", {
      templateId: runtime.templateId ?? null,
      regionId: regionDocument.id,
      linkedDocumentIds: lightIds,
      reason,
      syncApplied: true
    });
  }

  if (!skipRuntimeUpdate && scene?.regions?.get?.(regionDocument.id)) {
    await updateRegionLinkedDocuments(regionDocument, { wallIds: [], lightIds: [] });
  }

  const remainingWallIds = linkedWallIdsBefore.filter((wallId) => Boolean(scene?.walls?.get?.(wallId)));
  const remainingLightIds = linkedLightIdsBefore.filter((lightId) => Boolean(scene?.lights?.get?.(lightId)));
  const remainingManagedWallIdsForRegion = collectLinkedDocuments({
    scene,
    regionDocument,
    existingIds: [],
    collectionName: "walls",
    kind: "wall"
  }).map((document) => document.id);
  const remainingManagedLightIdsForRegion = collectLinkedDocuments({
    scene,
    regionDocument,
    existingIds: [],
    collectionName: "lights",
    kind: "light"
  }).map((document) => document.id);
  safeLinkedDiagnosticLog("PZ LINKED DOCUMENT CLEANUP RESULT", {
    regionId: regionDocument?.id ?? null,
    groupId: runtime.groupId ?? null,
    ownerEffectUuid: runtime.ownerEffectUuid ?? runtime.activeEffectUuid ?? runtime.concentrationEffectUuid ?? null,
    expectedWallIds: linkedWallIdsBefore,
    expectedLightIds: linkedLightIdsBefore,
    linkedWallIdsBefore,
    linkedLightIdsBefore,
    deletedWallIds: wallIds,
    deletedLightIds: lightIds,
    missingWallIds: linkedWallIdsBefore.filter((wallId) => !wallIds.includes(wallId) && !remainingWallIds.includes(wallId)),
    missingLightIds: linkedLightIdsBefore.filter((lightId) => !lightIds.includes(lightId) && !remainingLightIds.includes(lightId)),
    remainingWallIds,
    remainingLightIds,
    remainingManagedWallIdsForRegion,
    remainingManagedLightIdsForRegion,
    cleanupReason: reason
  });

  return { wallIds, lightIds };
}

async function syncLinkedWalls({
  scene,
  templateDocument,
  regionDocument,
  linkedWalls,
  shapes,
  existingIds = [],
  itemUuid = null
}) {
  const existingWalls = collectLinkedDocuments({
    scene,
    regionDocument,
    existingIds,
    collectionName: "walls",
    kind: "wall"
  });
  const wallDuplicateReconciliation = await reconcileDuplicateLinkedDocuments(scene, regionDocument, existingWalls, {
    kind: "wall",
    existingIds
  });
  const usableExistingWalls = wallDuplicateReconciliation.keptDocuments;

  if (!linkedWalls?.enabled) {
    logLinkedWallDecision({
      regionDocument,
      shapes,
      linkedWalls,
      segmentCount: 0,
      payloadCount: 0,
      existingWallCount: usableExistingWalls.length,
      creationRequested: false
    });
    return deleteLinkedWallDocuments(scene, regionDocument, templateDocument, usableExistingWalls, "disabled");
  }

  const desiredWalls = buildLinkedWallData({
    templateDocument,
    regionDocument,
    linkedWalls,
    shapes,
    itemUuid
  });

  if (!desiredWalls.length) {
    logLinkedWallDecision({
      regionDocument,
      shapes,
      linkedWalls,
      segmentCount: 0,
      payloadCount: 0,
      existingWallCount: usableExistingWalls.length,
      creationRequested: false
    });
    return deleteLinkedWallDocuments(scene, regionDocument, templateDocument, usableExistingWalls, "unsupported-shape");
  }

  const existingUsesWallHeight = usableExistingWalls.some((wallDocument) => wallDocument?.flags?.["wall-height"] !== undefined);
  const desiredUsesWallHeight = desiredWalls.some((wallData) => wallData?.flags?.["wall-height"] !== undefined);
  const wallHeightModeChanged = existingUsesWallHeight !== desiredUsesWallHeight;
  const orderedExisting = orderLinkedDocumentsForDesired(usableExistingWalls, "wall");
  const reusableCount = wallHeightModeChanged ? 0 : Math.min(orderedExisting.length, desiredWalls.length);
  const payloadCount = desiredWalls.length - reusableCount;
  logLinkedWallDecision({
    regionDocument,
    shapes,
    linkedWalls,
    segmentCount: desiredWalls.length,
    payloadCount,
    existingWallCount: usableExistingWalls.length,
    creationRequested: payloadCount > 0
  });

  if (orderedExisting.length === desiredWalls.length && orderedExisting.length && !wallHeightModeChanged) {
    const updates = orderedExisting.map((wallDocument, index) => ({
      _id: wallDocument.id,
      ...desiredWalls[index]
    }));

    const updated = await scene.updateEmbeddedDocuments("Wall", updates, { persistentZonesLinkedSync: true });
    const linkedDocumentIds = orderedExisting.map((document) => document.id);

    debug("Linked wall documents updated.", {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      linkedDocumentIds,
      syncApplied: true
    });

    return {
      ids: linkedDocumentIds,
      existingCount: existingWalls.length,
      createdIds: [],
      updatedIds: Array.from(updated ?? []).map((document) => document?.id ?? null).filter(Boolean),
      deletedIds: wallDuplicateReconciliation.deletedIds,
      duplicateIdsDeleted: wallDuplicateReconciliation.deletedIds,
      geometryChanged: true,
      positionChanged: true,
      elevationChanged: false
    };
  }

  const updatedIds = [];
  if (reusableCount) {
    const updates = orderedExisting.slice(0, reusableCount).map((wallDocument, index) => ({
      _id: wallDocument.id,
      ...desiredWalls[index]
    }));
    const updated = await scene.updateEmbeddedDocuments("Wall", updates, { persistentZonesLinkedSync: true });
    updatedIds.push(...Array.from(updated ?? []).map((document) => document?.id ?? null).filter(Boolean));
  }

  const excessWalls = wallHeightModeChanged ? orderedExisting : orderedExisting.slice(reusableCount);
  const deletedIds = [
    ...wallDuplicateReconciliation.deletedIds,
    ...excessWalls.map((document) => document.id).filter(Boolean)
  ];
  if (deletedIds.length) {
    await scene.deleteEmbeddedDocuments("Wall", deletedIds, { persistentZonesLinkedSync: true }).catch(() => []);
    debug("Linked wall documents deleted.", {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      linkedDocumentIds: deletedIds,
      reason: wallHeightModeChanged ? "recreate-wall-height" : "recreate",
      syncApplied: true
    });
  }

  const wallsToCreate = desiredWalls.slice(reusableCount);
  const created = wallsToCreate.length
    ? await scene.createEmbeddedDocuments("Wall", wallsToCreate, { persistentZonesLinkedSync: true })
    : [];
  const linkedDocumentIds = (Array.isArray(created) ? created : [])
    .map((document) => document?.id ?? null)
    .filter(Boolean);
  const finalIds = [
    ...orderedExisting.slice(0, reusableCount).map((document) => document.id).filter(Boolean),
    ...linkedDocumentIds
  ];

  debug("Linked wall documents created.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentIds,
    syncApplied: linkedDocumentIds.length > 0
  });

  return {
    ids: finalIds,
    existingCount: existingWalls.length,
    createdIds: linkedDocumentIds,
    updatedIds,
    deletedIds,
    duplicateIdsDeleted: wallDuplicateReconciliation.deletedIds,
    geometryChanged: true,
    positionChanged: true,
    elevationChanged: false
  };
}

async function syncLinkedLight({
  scene,
  templateDocument,
  regionDocument,
  linkedLight,
  shapes,
  existingIds = [],
  templateDistance = null,
  itemUuid = null
}) {
  const existingLights = collectLinkedDocuments({
    scene,
    regionDocument,
    existingIds,
    collectionName: "lights",
    kind: "light"
  });
  const lightDuplicateReconciliation = await reconcileDuplicateLinkedDocuments(scene, regionDocument, existingLights, {
    kind: "light",
    existingIds
  });
  const usableExistingLights = lightDuplicateReconciliation.keptDocuments;

  if (!linkedLight?.enabled) {
    return deleteLinkedLightDocuments(scene, regionDocument, templateDocument, usableExistingLights, "disabled");
  }

  const desiredLights = buildLinkedLightData({
    templateDocument,
    regionDocument,
    linkedLight,
    shapes,
    templateDistance,
    itemUuid
  });

  if (!desiredLights.length) {
    const deleteResult = await deleteLinkedLightDocuments(scene, regionDocument, templateDocument, usableExistingLights, "no-valid-light-slots");
    deleteResult.deletedIds = [...(deleteResult.deletedIds ?? []), ...lightDuplicateReconciliation.deletedIds];
    deleteResult.duplicateIdsDeleted = lightDuplicateReconciliation.deletedIds;
    logLinkedLightSceneClipResult({
      regionDocument,
      reason: "no-valid-light-slots",
      theoreticalSlots: desiredLights._pzTheoreticalSlots ?? [],
      acceptedSlots: [],
      rejectedOutsideSceneSlots: desiredLights._pzRejectedOutsideSceneSlots ?? [],
      existingLights: usableExistingLights,
      updatedSlots: [],
      createdSlots: [],
      deletedSlots: existingLights.map((document) => getLinkedLightSlotKey(document)).filter(Boolean),
      syncSucceeded: true,
      errors: []
    });
    return deleteResult;
  }

  const desiredBySlot = new Map(desiredLights.map((light) => [getLinkedLightSlotKey(light), light]));
  const existingBySlot = new Map(orderLinkedDocumentsForDesired(usableExistingLights, "light")
    .map((document) => [getLinkedLightSlotKey(document), document])
    .filter(([slot]) => Boolean(slot)));
  const updates = [];
  const updatedSlots = [];
  for (const [slot, desiredLight] of desiredBySlot.entries()) {
    const existingLight = existingBySlot.get(slot);
    if (!existingLight) {
      continue;
    }
    updates.push({
      _id: existingLight.id,
      ...desiredLight
    });
    updatedSlots.push(slot);
  }

  if (updates.length) {
    updates.forEach((payload) => logLinkedLightDocumentPayload(payload, desiredLights));
  }
  const updated = updates.length
    ? await scene.updateEmbeddedDocuments("AmbientLight", updates, { persistentZonesLinkedSync: true })
    : [];
  const slotsToDelete = Array.from(existingBySlot.keys()).filter((slot) => !desiredBySlot.has(slot));
  const deletedIds = slotsToDelete.map((slot) => existingBySlot.get(slot)?.id).filter(Boolean);
  if (deletedIds.length) {
    await scene.deleteEmbeddedDocuments("AmbientLight", deletedIds, { persistentZonesLinkedSync: true }).catch(() => []);
    debug("Linked light document updated.", {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      linkedDocumentIds: Array.from(updated ?? []).map((document) => document?.id ?? null).filter(Boolean),
      syncApplied: true
    });
  }

  const lightsToCreate = Array.from(desiredBySlot.entries())
    .filter(([slot]) => !existingBySlot.has(slot))
    .map(([, desiredLight]) => desiredLight);
  if (lightsToCreate.length) {
    lightsToCreate.forEach((payload) => logLinkedLightDocumentPayload(payload, desiredLights));
  }
  const created = lightsToCreate.length
    ? await scene.createEmbeddedDocuments("AmbientLight", lightsToCreate, { persistentZonesLinkedSync: true })
    : [];
  const createdIds = (Array.isArray(created) ? created : [])
    .map((document) => document?.id ?? null)
    .filter(Boolean);
  const createdSlots = lightsToCreate.map((light) => getLinkedLightSlotKey(light)).filter(Boolean);
  const finalIds = [
    ...Array.from(desiredBySlot.keys())
      .map((slot) => existingBySlot.get(slot)?.id)
      .filter(Boolean),
    ...createdIds
  ];

  logLinkedLightSceneClipResult({
    regionDocument,
    reason: "sync-linked-light",
    theoreticalSlots: desiredLights._pzTheoreticalSlots ?? Array.from(desiredBySlot.keys()),
    acceptedSlots: Array.from(desiredBySlot.keys()),
    rejectedOutsideSceneSlots: desiredLights._pzRejectedOutsideSceneSlots ?? [],
    existingLights: usableExistingLights,
    updatedSlots,
    createdSlots,
    deletedSlots: slotsToDelete,
    syncSucceeded: true,
    errors: []
  });

  return {
    ids: finalIds,
    existingCount: existingLights.length,
    createdIds,
    updatedIds: Array.from(updated ?? []).map((document) => document?.id ?? null).filter(Boolean),
    deletedIds: [...lightDuplicateReconciliation.deletedIds, ...deletedIds],
    duplicateIdsDeleted: lightDuplicateReconciliation.deletedIds,
    geometryChanged: true,
    positionChanged: true,
    elevationChanged: desiredLights.some((light) => light.elevation !== undefined)
  };
}

async function deleteLinkedWallDocuments(scene, regionDocument, templateDocument, existingWalls, reason) {
  if (!existingWalls.length) {
    return { ids: [], existingCount: 0, createdIds: [], updatedIds: [], deletedIds: [], geometryChanged: false, positionChanged: false, elevationChanged: false };
  }

  const linkedDocumentIds = existingWalls.map((document) => document.id);
  await scene.deleteEmbeddedDocuments("Wall", linkedDocumentIds, { persistentZonesLinkedSync: true }).catch(() => []);

  debug("Linked wall documents deleted.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentIds,
    reason,
    syncApplied: true
  });

  return { ids: [], existingCount: existingWalls.length, createdIds: [], updatedIds: [], deletedIds: linkedDocumentIds, geometryChanged: true, positionChanged: false, elevationChanged: false };
}

async function deleteLinkedLightDocuments(scene, regionDocument, templateDocument, existingLights, reason) {
  if (!existingLights.length) {
    return { ids: [], existingCount: 0, createdIds: [], updatedIds: [], deletedIds: [], geometryChanged: false, positionChanged: false, elevationChanged: false };
  }

  const linkedDocumentIds = existingLights.map((document) => document.id);
  await scene.deleteEmbeddedDocuments("AmbientLight", linkedDocumentIds, { persistentZonesLinkedSync: true }).catch(() => []);

  debug("Linked light documents deleted.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentIds,
    reason,
    syncApplied: true
  });

  return { ids: [], existingCount: existingLights.length, createdIds: [], updatedIds: [], deletedIds: linkedDocumentIds, geometryChanged: true, positionChanged: false, elevationChanged: false };
}

function buildLinkedWallData({
  templateDocument,
  regionDocument,
  linkedWalls,
  shapes,
  itemUuid = null
}) {
  const geometryDecision = resolveLinkedWallGeometryDecision(shapes, linkedWalls?.geometry);
  const segments = buildWallSegmentsFromShapes(shapes, {
    circleSegments: normalizeLinkedWallSegments(linkedWalls?.segments),
    grid: regionDocument?.parent === globalThis.canvas?.scene ? globalThis.canvas?.grid : null,
    wallGeometry: geometryDecision.selectedWallGeometry
  });
  safeLinkedDiagnosticLog("PZ LINKED WALL GEOMETRY DECISION", {
    regionId: regionDocument?.id ?? null,
    sourceShapeType: geometryDecision.sourceShapeType,
    requestedWallGeometry: geometryDecision.requestedWallGeometry,
    selectedWallGeometry: geometryDecision.selectedWallGeometry,
    wallPreset: linkedWalls?.preset ?? linkedWalls?.resolvedPreset ?? null,
    generatedSegmentCount: segments.length,
    segments: segments.map((segment, index) => ({
      boundary: segment.boundary ?? "outer",
      segmentIndex: segment.segmentIndex ?? index
    })),
    reason: geometryDecision.reason
  });
  if (!segments.length) {
    return [];
  }

  const move = resolveWallMovementValue(linkedWalls?.move, linkedWalls?.mode ?? linkedWalls?.wallMode);
  const sight = resolveWallSenseValue(linkedWalls?.sight, linkedWalls?.mode ?? linkedWalls?.wallMode);
  const light = resolveWallSenseValue(linkedWalls?.light, linkedWalls?.mode ?? linkedWalls?.wallMode);
  const sound = resolveWallSenseValue(linkedWalls?.sound, "none");
  const directionEligible = geometryDecision.sourceShapeType === "line"
    && geometryDecision.selectedWallGeometry === "centerline";
  const direction = resolveWallDirectionValue(
    linkedWalls?.preset === "custom" && directionEligible ? linkedWalls?.dir : "both"
  );
  const wallHeightSupported = isWallHeightSupported();
  const wallHeightTop = coerceNumber(linkedWalls?.height, null);
  const wallHeightBottom = coerceNumber(linkedWalls?.bottom, 0);
  const wallHeightApplied = wallHeightSupported && wallHeightTop !== null;

  debug("Prepared linked wall config.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentKind: "wall",
    segmentCount: segments.length,
    wallHeightSupported,
    wallHeightApplied,
    wallHeightTop,
    wallHeightBottom
  });

  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const geometryPlan = summarizeWallGeometryPlan({
    regionDocument,
    linkedWalls,
    segments,
    shapes
  });
  safeLinkedDiagnosticLog("PZ LINKED WALL GEOMETRY PLAN", geometryPlan);

  return segments.map((segment, index) => {
    const flags = buildLinkedDocumentFlags({
      kind: "wall",
      templateDocument,
      regionDocument,
      itemUuid,
      groupId: runtime.groupId ?? null,
      boundary: segment.boundary ?? "outer",
      segmentIndex: segment.segmentIndex ?? index
    });

    if (wallHeightApplied) {
      flags["wall-height"] = {
        top: wallHeightTop,
        bottom: wallHeightBottom
      };
    }

    return {
      c: segment.c ?? segment,
      move,
      sight,
      light,
      sound,
      dir: direction,
      door: 0,
      ds: 0,
      ...(linkedWalls?.preset === "custom" ? {
        threshold: {
          sight: coerceNumber(linkedWalls?.threshold?.sight, null),
          light: coerceNumber(linkedWalls?.threshold?.light, null),
          sound: coerceNumber(linkedWalls?.threshold?.sound, null),
          attenuation: false
        }
      } : {}),
      flags
    };
  });
}

function buildLinkedLightData({
  templateDocument,
  regionDocument,
  linkedLight,
  shapes,
  templateDistance = null,
  itemUuid = null
}) {
  const defaultBright = coerceNumber(templateDistance, 0);
  const radius = coerceNumber(linkedLight?.radius, null);
  let bright = coerceNumber(linkedLight?.bright, radius ?? defaultBright);
  let dim = coerceNumber(linkedLight?.dim, bright ? bright * 2 : radius ? radius * 2 : defaultBright ? defaultBright * 2 : 0);

  if (bright === null) {
    bright = 0;
  }
  if (dim === null) {
    dim = Math.max(bright, 0);
  }

  const animation = normalizeLinkedLightAnimation(linkedLight?.animation);
  const scene = regionDocument?.parent ?? templateDocument?.parent ?? canvas?.scene ?? null;
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const layout = buildLinkedLightLayout({
    scene,
    regionDocument,
    templateDocument,
    linkedLight,
    shapes,
    bright,
    dim
  });
  if (!layout.positions.length) {
    const emptyLights = [];
    Object.defineProperties(emptyLights, {
      _pzTheoreticalSlots: { value: layout.positions._pzTheoreticalSlots ?? [], enumerable: false },
      _pzRejectedOutsideSceneSlots: { value: layout.positions._pzRejectedOutsideSceneSlots ?? [], enumerable: false }
    });
    return emptyLights;
  }

  debug("Prepared linked light config.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentKind: "light",
    linkedLightBright: bright,
    linkedLightDim: dim,
    linkedLightLuminosity: coerceNumber(linkedLight?.luminosity, DEFAULT_LINKED_LIGHT_LUMINOSITY)
  });
  safeLinkedDiagnosticLog("PZ LINKED LIGHT LAYOUT PLAN", layout.logData);

  const lightDocuments = layout.positions.map((position, index) => ({
    x: position.x,
    y: position.y,
    rotation: 0,
    walls: coerceBoolean(linkedLight?.walls, false) ?? false,
    vision: coerceBoolean(linkedLight?.vision, false) ?? false,
    hidden: coerceBoolean(linkedLight?.hidden, false) ?? false,
    config: {
      alpha: coerceNumber(linkedLight?.alpha, DEFAULT_LINKED_LIGHT_ALPHA),
      angle: coerceNumber(linkedLight?.angle, DEFAULT_LINKED_LIGHT_ANGLE),
      bright,
      dim,
      coloration: 1,
      luminosity: coerceNumber(linkedLight?.luminosity, DEFAULT_LINKED_LIGHT_LUMINOSITY),
      attenuation: 0.5,
      saturation: 0,
      contrast: 0,
      shadows: 0,
      color: linkedLight?.color ?? DEFAULT_LINKED_LIGHT_COLOR,
      darkness: { min: 0, max: 1 },
      animation
    },
    ...(resolveLinkedLightElevation(regionDocument, linkedLight) !== null ? { elevation: resolveLinkedLightElevation(regionDocument, linkedLight) } : {}),
    flags: buildLinkedDocumentFlags({
      kind: "light",
      templateDocument,
      regionDocument,
      itemUuid,
      groupId: runtime.groupId ?? null,
      lightIndex: index,
      layoutType: layout.layoutType,
      layoutSlot: position.slot ?? null,
      layoutTrack: position.track ?? null,
      layoutTrackRadius: position.trackRadius ?? null,
      layoutAngle: position.angle ?? null
    })
  }));
  Object.defineProperties(lightDocuments, {
    _pzTheoreticalSlots: { value: layout.positions._pzTheoreticalSlots ?? layout.positions.map((position) => position.slot).filter(Boolean), enumerable: false },
    _pzRejectedOutsideSceneSlots: { value: layout.positions._pzRejectedOutsideSceneSlots ?? [], enumerable: false },
    _pzBrightSource: { value: linkedLight?.resolutionSources?.bright ?? "runtime-fallback", enumerable: false },
    _pzDimSource: { value: linkedLight?.resolutionSources?.dim ?? "runtime-fallback", enumerable: false }
  });
  return lightDocuments;
}

function collectLinkedDocuments({
  scene,
  regionDocument,
  existingIds = [],
  collectionName,
  kind
}) {
  const collection = scene?.[collectionName];
  const existing = new Map();
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const expectedGroupId = runtime.groupId ?? null;

  for (const id of Array.from(existingIds ?? [])) {
    const document = collection?.get?.(id);
    if (document && isManagedLinkedDocumentForRegion(document, regionDocument, kind, expectedGroupId)) {
      existing.set(document.id, document);
    }
  }

  for (const document of collection?.contents ?? []) {
    if (isManagedLinkedDocumentForRegion(document, regionDocument, kind, expectedGroupId)) {
      existing.set(document.id, document);
    }
  }

  return Array.from(existing.values());
}

function isManagedLinkedDocumentForRegion(document, regionDocument, kind, expectedGroupId = null) {
  const pzFlags = document?.flags?.[MODULE_ID] ?? {};
  const linkedFlag = pzFlags.linkedDocument ?? null;
  const documentKind = pzFlags.linkedDocumentType ?? linkedFlag?.kind ?? null;
  if (documentKind !== kind) {
    return false;
  }
  if (pzFlags.managedLinkedDocument !== true && !linkedFlag) {
    return false;
  }
  const regionMatches = pzFlags.regionId === regionDocument?.id ||
    pzFlags.regionUuid === regionDocument?.uuid ||
    linkedFlag?.regionId === regionDocument?.id ||
    linkedFlag?.regionUuid === regionDocument?.uuid;
  if (!regionMatches) {
    return false;
  }
  const documentGroupId = pzFlags.groupId ?? linkedFlag?.groupId ?? null;
  return !(expectedGroupId && documentGroupId && documentGroupId !== expectedGroupId);
}

async function updateRegionLinkedDocuments(regionDocument, linkedDocuments) {
  if (!regionDocument?.parent?.regions?.get?.(regionDocument.id)) {
    return;
  }

  await regionDocument.update({
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.linkedDocuments`]: linkedDocuments
  }, {
    persistentZonesLinkedSync: true
  });
}

function buildLinkedDocumentFlags({
  kind,
  templateDocument,
  regionDocument,
  itemUuid = null,
  groupId = null,
  boundary = null,
  segmentIndex = null,
  lightIndex = null,
  layoutType = null,
  layoutSlot = null,
  layoutTrack = null,
  layoutTrackRadius = null,
  layoutAngle = null
}) {
  return {
    [MODULE_ID]: {
      managedLinkedDocument: true,
      linkedDocumentType: kind,
      regionId: regionDocument?.id ?? null,
      regionUuid: regionDocument?.uuid ?? null,
      groupId,
      ...(boundary ? { boundary } : {}),
      ...(segmentIndex !== null ? { segmentIndex } : {}),
      ...(lightIndex !== null ? { lightIndex } : {}),
      ...(layoutType ? { layoutType } : {}),
      ...(layoutSlot !== null ? { layoutSlot } : {}),
      ...(layoutTrack !== null ? { layoutTrack } : {}),
      ...(layoutTrackRadius !== null ? { layoutTrackRadius } : {}),
      ...(layoutAngle !== null ? { layoutAngle } : {}),
      linkedDocument: {
        kind,
        templateId: templateDocument?.id ?? null,
        templateUuid: templateDocument?.uuid ?? null,
        regionId: regionDocument?.id ?? null,
        regionUuid: regionDocument?.uuid ?? null,
        itemUuid,
        groupId,
        boundary,
        segmentIndex,
        lightIndex,
        layoutType,
        layoutSlot,
        layoutTrack,
        layoutTrackRadius,
        layoutAngle
      }
    }
  };
}

function buildWallSegmentsFromShapes(shapes, {
  circleSegments = DEFAULT_LINKED_WALL_SEGMENTS,
  grid = null,
  wallGeometry = "centerline"
} = {}) {
  const segments = [];

  for (const shape of Array.from(shapes ?? [])) {
    switch (shape?.type) {
      case "circle":
        segments.push(...buildCircleWallSegments(shape, calculateCircleSegmentCount(shape, circleSegments), "outer"));
        break;
      case "ring":
        segments.push(...buildRingWallSegments(shape, circleSegments));
        break;
      case "emanation":
        segments.push(...buildEmanationWallSegments(shape, circleSegments));
        break;
      case "ellipse":
        segments.push(...buildEllipseWallSegments(shape, circleSegments));
        break;
      case "line":
        segments.push(...buildLineWallSegments(shape, grid, wallGeometry));
        break;
      case "rectangle":
        segments.push(...buildRectangleWallSegments(shape));
        break;
      case "polygon":
        segments.push(...buildPolygonWallSegments(shape.points));
        break;
      default:
        break;
    }
  }

  return segments;
}

function buildLineWallSegments(shape, grid = null, wallGeometry = "centerline") {
  const x = coerceNumber(shape?.x, null);
  const y = coerceNumber(shape?.y, null);
  const length = coerceNumber(shape?.length, 0);
  const width = coerceNumber(shape?.width, 0);
  const rotation = coerceNumber(shape?.rotation, 0);
  if (x === null || y === null || length <= 0) {
    return [];
  }

  const axisX = buildNativeLineRay({ x, y, length, rotation, gridBased: shape?.gridBased }, grid);
  if (wallGeometry !== "perimeter" || width <= 0) {
    return [{
      c: [axisX.a.x, axisX.a.y, axisX.b.x, axisX.b.y],
      boundary: "centerline",
      segmentIndex: 0
    }];
  }

  const axisY = buildNativeLineRay({
    x,
    y,
    length: width,
    rotation: rotation + 90,
    gridBased: shape?.gridBased,
    alignment: 0.5
  }, grid);
  const points = [
    axisY.a,
    axisY.b,
    { x: axisY.b.x + axisX.dx, y: axisY.b.y + axisX.dy },
    { x: axisY.a.x + axisX.dx, y: axisY.a.y + axisX.dy }
  ];
  return points.map((fromPoint, index) => {
    const toPoint = points[(index + 1) % points.length];
    return {
      c: [fromPoint.x, fromPoint.y, toPoint.x, toPoint.y],
      boundary: "perimeter",
      segmentIndex: index
    };
  });
}

function buildNativeLineRay({ x, y, length, rotation, gridBased = false, alignment = 0 } = {}, grid = null) {
  const from = { x, y };
  let to;
  if (gridBased && grid && !grid.isGridless && typeof grid.getTranslatedPoint === "function") {
    const distancePixels = coerceNumber(grid.size, 0) / coerceNumber(grid.distance, 1);
    to = grid.getTranslatedPoint(from, rotation, length / distancePixels);
  } else {
    const radians = (rotation * Math.PI) / 180;
    to = {
      x: x + (Math.cos(radians) * length),
      y: y + (Math.sin(radians) * length)
    };
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return {
    a: { x: from.x - (dx * alignment), y: from.y - (dy * alignment) },
    b: { x: to.x - (dx * alignment), y: to.y - (dy * alignment) },
    dx,
    dy
  };
}

function resolveLinkedWallGeometryDecision(shapes, requestedGeometry) {
  const sourceShape = Array.from(shapes ?? [])[0] ?? null;
  const sourceShapeType = sourceShape?.type ?? null;
  const requestedWallGeometry = normalizeLinkedWallGeometry(requestedGeometry);
  if (sourceShapeType === "line") {
    if (requestedWallGeometry === "perimeter" && coerceNumber(sourceShape?.width, 0) <= 0) {
      return {
        sourceShapeType,
        requestedWallGeometry,
        selectedWallGeometry: "centerline",
        reason: "line-perimeter-requires-positive-width"
      };
    }
    return {
      sourceShapeType,
      requestedWallGeometry,
      selectedWallGeometry: requestedWallGeometry,
      reason: requestedWallGeometry === "perimeter" ? "native-line-rectangle-perimeter" : "native-line-centerline"
    };
  }
  return {
    sourceShapeType,
    requestedWallGeometry,
    selectedWallGeometry: "perimeter",
    reason: "native-shape-boundary"
  };
}

function normalizeLinkedWallGeometry(value) {
  return String(value ?? "centerline").trim().toLowerCase() === "perimeter"
    ? "perimeter"
    : "centerline";
}

function buildCircleWallSegments(shape, count, boundary = "outer") {
  const radius = coerceNumber(shape?.radius, 0);
  const centerX = coerceNumber(shape?.x, 0);
  const centerY = coerceNumber(shape?.y, 0);
  if (!radius) {
    return [];
  }

  const safeCount = Math.max(8, count);
  const segments = [];
  for (let index = 0; index < safeCount; index += 1) {
    const angleA = (index / safeCount) * Math.PI * 2;
    const angleB = ((index + 1) / safeCount) * Math.PI * 2;
    segments.push({
      c: [
        centerX + Math.cos(angleA) * radius,
        centerY + Math.sin(angleA) * radius,
        centerX + Math.cos(angleB) * radius,
        centerY + Math.sin(angleB) * radius
      ],
      boundary,
      segmentIndex: index
    });
  }

  return segments;
}

function buildRingWallSegments(shape, requestedSegments) {
  const geometry = resolveRingGeometry(shape);
  if (!geometry || geometry.outerRadius <= 0) {
    return [];
  }
  const outerCount = calculateRadiusSegmentCount(geometry.outerRadius, requestedSegments);
  const innerCount = geometry.innerRadius > 0 ? calculateRadiusSegmentCount(geometry.innerRadius, requestedSegments) : 0;
  const outerSegments = buildCircleWallSegments({
    type: "circle",
    x: geometry.centerX,
    y: geometry.centerY,
    radius: geometry.outerRadius
  }, outerCount, "outer");
  const innerSegments = innerCount
    ? buildCircleWallSegments({
      type: "circle",
      x: geometry.centerX,
      y: geometry.centerY,
      radius: geometry.innerRadius
    }, innerCount, "inner")
    : [];
  return [...outerSegments, ...innerSegments];
}

function buildEmanationWallSegments(shape, count) {
  const center = findEmanationCenter(shape);
  const radius = coerceNumber(shape?.radius, 0);
  if (!radius || radius <= 0) {
    return [];
  }

  return buildCircleWallSegments({
    type: "circle",
    x: center.x,
    y: center.y,
    radius
  }, calculateRadiusSegmentCount(radius, count), "outer");
}

function buildEllipseWallSegments(shape, count) {
  const width = coerceNumber(shape?.width, null);
  const height = coerceNumber(shape?.height, null);
  const radiusX = coerceNumber(shape?.radiusX, width !== null ? width / 2 : null);
  const radiusY = coerceNumber(shape?.radiusY, height !== null ? height / 2 : null);
  const centerX = coerceNumber(shape?.cx ?? shape?.x, 0);
  const centerY = coerceNumber(shape?.cy ?? shape?.y, 0);
  const rotation = (coerceNumber(shape?.rotation, 0) * Math.PI) / 180;

  if (!radiusX || !radiusY) {
    return [];
  }

  const safeCount = Math.max(8, count);
  const points = [];
  for (let index = 0; index < safeCount; index += 1) {
    const angle = (index / safeCount) * Math.PI * 2;
    const localPoint = {
      x: centerX + Math.cos(angle) * radiusX,
      y: centerY + Math.sin(angle) * radiusY
    };
    points.push(rotation ? rotatePoint(localPoint, { x: centerX, y: centerY }, rotation) : localPoint);
  }

  return buildSegmentsFromPoints(points, true);
}

function buildRectangleWallSegments(shape) {
  const x = coerceNumber(shape?.x, 0);
  const y = coerceNumber(shape?.y, 0);
  const width = coerceNumber(shape?.width, 0);
  const height = coerceNumber(shape?.height, 0);
  if (!width || !height) {
    return [];
  }

  const rotation = (coerceNumber(shape?.rotation, 0) * Math.PI) / 180;
  const origin = { x, y };
  const points = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height }
  ].map((point) => rotatePoint(point, origin, rotation));

  return buildSegmentsFromPoints(points, true);
}

function buildPolygonWallSegments(points) {
  if (!Array.isArray(points) || points.length < 6) {
    return [];
  }

  const polygonPoints = [];
  for (let index = 0; index < points.length; index += 2) {
    polygonPoints.push({
      x: coerceNumber(points[index], 0),
      y: coerceNumber(points[index + 1], 0)
    });
  }

  return buildSegmentsFromPoints(polygonPoints, true);
}

function buildSegmentsFromPoints(points, closed = false) {
  const segments = [];
  const limit = closed ? points.length : points.length - 1;

  for (let index = 0; index < limit; index += 1) {
    const fromPoint = points[index];
    const toPoint = points[(index + 1) % points.length];
    if (!fromPoint || !toPoint) {
      continue;
    }

    segments.push([fromPoint.x, fromPoint.y, toPoint.x, toPoint.y]);
  }

  return segments;
}

function getFinalRegionShapeData(regionDocument, shapes = null) {
  const finalShapes = getRegionShapeData(regionDocument);
  if (Array.isArray(finalShapes) && finalShapes.length) {
    return duplicateData(finalShapes);
  }
  return Array.isArray(shapes) && shapes.length ? duplicateData(shapes) : [];
}

function summarizeLinkedGeometrySource({ scene = null, regionDocument = null, shapes = [] } = {}) {
  return Array.from(shapes ?? []).map((shape, shapeIndex) => {
    const ring = shape?.type === "ring" ? resolveRingGeometry(shape) : null;
    const radius = coerceNumber(shape?.radius, null);
    return {
      regionId: regionDocument?.id ?? null,
      regionUuid: regionDocument?.uuid ?? null,
      shapeType: shape?.type ?? null,
      shapeIndex,
      centerX: coerceNumber(shape?.x ?? shape?.cx, null),
      centerY: coerceNumber(shape?.y ?? shape?.cy, null),
      radius,
      innerWidth: coerceNumber(shape?.innerWidth, null),
      outerWidth: coerceNumber(shape?.outerWidth, null),
      innerRadius: ring?.innerRadius ?? (radius !== null ? 0 : null),
      outerRadius: ring?.outerRadius ?? radius,
      geometrySource: "final-region-document-shapes",
      sceneGridSize: coerceNumber(scene?.grid?.size ?? canvas?.grid?.size, null),
      sceneGridDistance: coerceNumber(scene?.grid?.distance, null)
    };
  });
}

function resolveRingGeometry(shape) {
  if (shape?.type !== "ring") {
    return null;
  }
  const radius = coerceNumber(shape?.radius, 0);
  const innerWidth = Math.max(0, coerceNumber(shape?.innerWidth, 0));
  const outerWidth = Math.max(0, coerceNumber(shape?.outerWidth, 0));
  const centerX = coerceNumber(shape?.x, 0);
  const centerY = coerceNumber(shape?.y, 0);
  return {
    centerX,
    centerY,
    radius,
    innerWidth,
    outerWidth,
    innerRadius: Math.max(0, radius - innerWidth),
    outerRadius: Math.max(0, radius + outerWidth)
  };
}

function calculateCircleSegmentCount(shape, requestedSegments) {
  const radius = coerceNumber(shape?.radius, 0);
  return calculateRadiusSegmentCount(radius, requestedSegments);
}

function calculateRadiusSegmentCount(radius, requestedSegments = DEFAULT_LINKED_WALL_SEGMENTS) {
  const gridSize = coerceNumber(canvas?.grid?.size, 100) || 100;
  const requested = Math.round(coerceNumber(requestedSegments, 0));
  const byRadius = Math.ceil((Math.PI * 2 * Math.max(radius, 0)) / Math.max(gridSize / 2, 16));
  return Math.min(Math.max(requested || byRadius, 12, byRadius), 96);
}

function summarizeWallGeometryPlan({
  regionDocument = null,
  linkedWalls = {},
  segments = [],
  shapes = []
} = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const firstShape = Array.from(shapes ?? [])[0] ?? null;
  const ring = firstShape?.type === "ring" ? resolveRingGeometry(firstShape) : null;
  const outerSegments = segments.filter((segment) => (segment.boundary ?? "outer") === "outer");
  const innerSegments = segments.filter((segment) => segment.boundary === "inner");
  return {
    regionId: regionDocument?.id ?? null,
    groupId: runtime.groupId ?? null,
    shapeType: firstShape?.type ?? null,
    innerRadius: ring?.innerRadius ?? 0,
    outerRadius: ring?.outerRadius ?? coerceNumber(firstShape?.radius, null),
    outerSegmentCount: outerSegments.length,
    innerSegmentCount: innerSegments.length,
    outerWallPointCount: outerSegments.length,
    innerWallPointCount: innerSegments.length,
    closedOuterLoop: outerSegments.length > 2,
    closedInnerLoop: innerSegments.length > 2,
    wallPresetId: linkedWalls?.preset ?? linkedWalls?.presetId ?? linkedWalls?.id ?? null,
    requestedWallGeometry: normalizeLinkedWallGeometry(linkedWalls?.geometry),
    segments: segments.map((segment, index) => ({
      boundary: segment.boundary ?? "outer",
      segmentIndex: segment.segmentIndex ?? index,
      coordinates: Array.from(segment.c ?? segment)
    })),
    wallConfig: duplicateData(linkedWalls ?? {})
  };
}

function orderLinkedDocumentsForDesired(documents = [], kind = "wall") {
  return Array.from(documents ?? []).sort((a, b) => {
    const flagA = a?.flags?.[MODULE_ID] ?? {};
    const flagB = b?.flags?.[MODULE_ID] ?? {};
    const boundaryA = flagA.boundary ?? flagA.linkedDocument?.boundary ?? "";
    const boundaryB = flagB.boundary ?? flagB.linkedDocument?.boundary ?? "";
    const indexKey = kind === "light" ? "lightIndex" : "segmentIndex";
    const indexA = coerceNumber(flagA[indexKey] ?? flagA.linkedDocument?.[indexKey], 0);
    const indexB = coerceNumber(flagB[indexKey] ?? flagB.linkedDocument?.[indexKey], 0);
    return String(boundaryA).localeCompare(String(boundaryB)) || indexA - indexB;
  });
}

function getLinkedLightSlotKey(documentOrData) {
  const flags = documentOrData?.flags?.[MODULE_ID] ?? {};
  const linked = flags.linkedDocument ?? {};
  const explicitSlot = flags.layoutSlot ?? linked.layoutSlot ?? null;
  if (explicitSlot !== null && explicitSlot !== undefined) {
    return String(explicitSlot);
  }
  const track = flags.layoutTrack ?? linked.layoutTrack ?? null;
  const index = flags.lightIndex ?? linked.lightIndex ?? null;
  if (track !== null && index !== null) {
    return `${track}:${index}`;
  }
  if (index !== null) {
    return `legacy:${index}`;
  }
  return null;
}

function getLinkedWallKey(documentOrData) {
  const flags = documentOrData?.flags?.[MODULE_ID] ?? {};
  const linked = flags.linkedDocument ?? {};
  const boundary = flags.boundary ?? linked.boundary ?? "outer";
  const segmentIndex = flags.segmentIndex ?? linked.segmentIndex ?? null;
  if (segmentIndex === null || segmentIndex === undefined) {
    return null;
  }
  return `${boundary}:${segmentIndex}`;
}

async function reconcileDuplicateLinkedDocuments(scene, regionDocument, documents = [], {
  kind = "wall",
  existingIds = []
} = {}) {
  const keyGetter = kind === "light" ? getLinkedLightSlotKey : getLinkedWallKey;
  const byKey = new Map();
  for (const document of Array.from(documents ?? [])) {
    const key = keyGetter(document);
    if (!key) {
      continue;
    }
    if (!byKey.has(key)) {
      byKey.set(key, []);
    }
    byKey.get(key).push(document);
  }
  const keptDocuments = [];
  const deletedIds = [];
  const duplicatedKeys = [];
  const existingIdSet = new Set(Array.from(existingIds ?? []));
  for (const [key, group] of byKey.entries()) {
    const sorted = Array.from(group).sort((a, b) => {
      const aPreferred = existingIdSet.has(a?.id) ? 0 : 1;
      const bPreferred = existingIdSet.has(b?.id) ? 0 : 1;
      return aPreferred - bPreferred || String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
    });
    const [kept, ...duplicates] = sorted;
    if (kept) {
      keptDocuments.push(kept);
    }
    if (duplicates.length) {
      duplicatedKeys.push(key);
      deletedIds.push(...duplicates.map((document) => document?.id).filter(Boolean));
    }
  }
  const withoutKey = Array.from(documents ?? []).filter((document) => !keyGetter(document));
  keptDocuments.push(...withoutKey);
  if (deletedIds.length) {
    const embeddedName = kind === "light" ? "AmbientLight" : "Wall";
    await scene.deleteEmbeddedDocuments(embeddedName, deletedIds, { persistentZonesLinkedSync: true }).catch(() => []);
  }
  if (deletedIds.length) {
    const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
    safeLinkedDiagnosticLog("PZ LINKED DOCUMENT DUPLICATE RECONCILIATION", {
      sceneId: scene?.id ?? null,
      regionId: regionDocument?.id ?? null,
      groupId: runtime.groupId ?? null,
      duplicatedWallKeys: kind === "wall" ? duplicatedKeys : [],
      keptWallIds: kind === "wall" ? keptDocuments.map((document) => document?.id).filter(Boolean) : [],
      deletedDuplicateWallIds: kind === "wall" ? deletedIds : [],
      duplicatedLightSlots: kind === "light" ? duplicatedKeys : [],
      keptLightIds: kind === "light" ? keptDocuments.map((document) => document?.id).filter(Boolean) : [],
      deletedDuplicateLightIds: kind === "light" ? deletedIds : [],
      reconciliationReason: "logical-key-deduplication"
    });
  }
  return { keptDocuments, deletedIds, duplicatedKeys };
}

function buildLinkedSyncKey(scene, regionDocument) {
  return `${scene?.id ?? "scene"}:${regionDocument?.id ?? "region"}`;
}

function resolveScenePlaceableBounds(scene = null) {
  const dimensions = canvas?.scene?.id === scene?.id ? canvas?.dimensions ?? null : null;
  const rect = dimensions?.sceneRect ?? dimensions?.rect ?? null;
  if (rect) {
    const minX = coerceNumber(rect.x ?? rect.left, 0);
    const minY = coerceNumber(rect.y ?? rect.top, 0);
    const width = coerceNumber(rect.width, 0);
    const height = coerceNumber(rect.height, 0);
    return {
      minX,
      minY,
      maxX: minX + width,
      maxY: minY + height,
      width,
      height,
      source: "canvas.dimensions.sceneRect"
    };
  }
  const sceneX = coerceNumber(dimensions?.sceneX, null);
  const sceneY = coerceNumber(dimensions?.sceneY, null);
  const sceneWidth = coerceNumber(dimensions?.sceneWidth, null);
  const sceneHeight = coerceNumber(dimensions?.sceneHeight, null);
  if (sceneX !== null && sceneY !== null && sceneWidth !== null && sceneHeight !== null) {
    return {
      minX: sceneX,
      minY: sceneY,
      maxX: sceneX + sceneWidth,
      maxY: sceneY + sceneHeight,
      width: sceneWidth,
      height: sceneHeight,
      source: "canvas.dimensions.sceneX-sceneY-sceneWidth-sceneHeight"
    };
  }
  const width = coerceNumber(scene?.width, null);
  const height = coerceNumber(scene?.height, null);
  const padding = coerceNumber(scene?.padding, 0) ?? 0;
  const gridSize = coerceNumber(scene?.grid?.size ?? canvas?.grid?.size, 100) || 100;
  if (width !== null && height !== null) {
    const padPixels = padding > 0 && padding < 1 ? Math.max(width, height) * padding : padding * gridSize;
    return {
      minX: -padPixels,
      minY: -padPixels,
      maxX: width + padPixels,
      maxY: height + padPixels,
      width: width + (padPixels * 2),
      height: height + (padPixels * 2),
      source: "scene.width-height-padding"
    };
  }
  return {
    minX: 0,
    minY: 0,
    maxX: Number.POSITIVE_INFINITY,
    maxY: Number.POSITIVE_INFINITY,
    width: null,
    height: null,
    source: "unbounded-fallback"
  };
}

function isPointInsideSceneBounds(point, bounds, margin = 0) {
  if (!bounds) {
    return true;
  }
  return coerceNumber(point?.x, 0) >= bounds.minX + margin &&
    coerceNumber(point?.x, 0) <= bounds.maxX - margin &&
    coerceNumber(point?.y, 0) >= bounds.minY + margin &&
    coerceNumber(point?.y, 0) <= bounds.maxY - margin;
}

function logLinkedLightSceneClipResult({
  regionDocument = null,
  reason = "manual",
  theoreticalSlots = [],
  acceptedSlots = [],
  rejectedOutsideSceneSlots = [],
  existingLights = [],
  updatedSlots = [],
  createdSlots = [],
  deletedSlots = [],
  syncSucceeded = true,
  errors = []
} = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  safeLinkedDiagnosticLog("PZ LINKED LIGHT SCENE CLIP RESULT", {
    regionId: regionDocument?.id ?? null,
    groupId: runtime.groupId ?? null,
    reason,
    theoreticalSlots: duplicateData(theoreticalSlots),
    acceptedSlots: duplicateData(acceptedSlots),
    rejectedOutsideSceneSlots: duplicateData(rejectedOutsideSceneSlots),
    existingSlotsBefore: Array.from(existingLights ?? []).map((document) => getLinkedLightSlotKey(document)).filter(Boolean),
    updatedSlots: duplicateData(updatedSlots),
    createdSlots: duplicateData(createdSlots),
    deletedSlots: duplicateData(deletedSlots),
    clampedPositionCount: 0,
    syncSucceeded,
    errors: duplicateData(errors)
  });
}

function resolveLinkedLightAnchor(shapes, templateDocument, regionDocument) {
  const shapeList = Array.from(shapes ?? []);
  const shape = shapeList[0] ?? null;
  const scene = regionDocument?.parent ?? templateDocument?.parent ?? canvas?.scene ?? null;
  const grid = scene === globalThis.canvas?.scene ? globalThis.canvas?.grid : null;
  let point = null;
  let selectedAnchorSource = null;
  let reason = null;

  if (!shapeList.length) {
    point = findTemplateCenter(templateDocument);
    selectedAnchorSource = "template-fallback";
    reason = "final-region-has-no-shapes";
  } else if (shapeList.length === 1) {
    point = findShapeCenter(shape, { grid });
    if (point) {
      selectedAnchorSource = "final-region-shape";
      reason = shape?.type === "line" ? "native-line-geometric-center" : "native-shape-geometric-center";
    } else {
      point = findTemplateCenter(templateDocument);
      selectedAnchorSource = "template-fallback";
      reason = "final-region-shape-center-unsupported";
    }
  } else {
    const shapeCenters = shapeList
      .map((entry) => findShapeCenter(entry, { grid }))
      .filter(Boolean);
    if (shapeCenters.length) {
      point = {
        x: shapeCenters.reduce((sum, entry) => sum + entry.x, 0) / shapeCenters.length,
        y: shapeCenters.reduce((sum, entry) => sum + entry.y, 0) / shapeCenters.length
      };
      selectedAnchorSource = "final-region-shapes-average";
      reason = "multiple-native-shape-centers";
    } else {
      point = findTemplateCenter(templateDocument);
      selectedAnchorSource = "template-fallback";
      reason = "final-region-shape-centers-unsupported";
    }
  }

  return {
    point,
    logData: {
      regionId: regionDocument?.id ?? null,
      shapeType: shape?.type ?? null,
      regionX: coerceNumber(shape?.x, null),
      regionY: coerceNumber(shape?.y, null),
      lineLength: shape?.type === "line" ? coerceNumber(shape?.length, null) : null,
      lineWidth: shape?.type === "line" ? coerceNumber(shape?.width, null) : null,
      lineRotation: shape?.type === "line" ? coerceNumber(shape?.rotation, null) : null,
      gridBased: shape?.type === "line" ? Boolean(shape?.gridBased) : null,
      templateX: coerceNumber(templateDocument?.x, null),
      templateY: coerceNumber(templateDocument?.y, null),
      templateDistance: coerceNumber(templateDocument?.distance, null),
      templateDirection: coerceNumber(templateDocument?.direction, null),
      selectedAnchorSource,
      calculatedCenterX: point?.x ?? null,
      calculatedCenterY: point?.y ?? null,
      reason
    }
  };
}

export function buildLinkedLightLayout({
  scene = null,
  regionDocument = null,
  templateDocument = null,
  linkedLight = {},
  shapes = [],
  bright = 0,
  dim = 0
} = {}) {
  const shape = Array.from(shapes ?? [])[0] ?? null;
  const ring = shape?.type === "ring" ? resolveRingGeometry(shape) : null;
  const gridSize = coerceNumber(scene?.grid?.size ?? canvas?.grid?.size, 100) || 100;
  const configuredBright = coerceNumber(bright, 0) ?? 0;
  const configuredDim = coerceNumber(dim, 0) ?? 0;
  const effectiveCoverageRadius = Math.max(
    distanceToPixels(configuredDim || configuredBright, scene),
    gridSize
  );

  if (shape?.type === "line") {
    const anchor = resolveLinkedLightAnchor(shapes, templateDocument, regionDocument);
    safeLinkedDiagnosticLog("PZ LINKED LIGHT ANCHOR DECISION", anchor.logData);
    const plan = buildAdaptiveLineLightPlan({
      shape,
      grid: scene === globalThis.canvas?.scene ? globalThis.canvas?.grid : null,
      gridSize,
      effectiveCoverageRadius,
      linkedLight
    });
    if (!plan) {
      return { layoutType: "line-path", positions: [], logData: { regionId: regionDocument?.id ?? null, shapeType: "line", everyLightInsideRegion: false } };
    }
    const sceneBounds = resolveScenePlaceableBounds(scene);
    const sceneMargin = Math.max(1, Math.min(gridSize * 0.02, 8));
    const theoreticalPositions = plan.tracks.flatMap((track) => {
      const positions = [];
      for (let index = 0; index < track.finalCount; index += 1) {
        const t = (index + 0.5) / track.finalCount;
        positions.push({
          x: plan.axis.a.x + (plan.axis.dx * t) + (plan.normal.x * track.offset),
          y: plan.axis.a.y + (plan.axis.dy * t) + (plan.normal.y * track.offset),
          angle: null,
          track: track.name,
          trackIndex: track.index,
          trackRadius: Math.abs(track.offset),
          slot: `${track.name}:${index}`
        });
      }
      return positions;
    });
    const positions = theoreticalPositions.filter((position) => isPointInsideSceneBounds(position, sceneBounds, sceneMargin));
    const rejectedOutsideSceneSlots = theoreticalPositions
      .filter((position) => !isPointInsideSceneBounds(position, sceneBounds, sceneMargin))
      .map((position) => position.slot);
    const result = {
      layoutType: "line-path",
      positions,
      logData: {
        regionId: regionDocument?.id ?? null,
        lineLength: plan.sourceLength,
        lineWidth: plan.sourceWidth,
        rotation: plan.rotation,
        startX: plan.axis.a.x,
        startY: plan.axis.a.y,
        endX: plan.axis.b.x,
        endY: plan.axis.b.y,
        effectiveCoverageRadius,
        overlapTarget: plan.overlapTarget,
        selectedTrackCount: plan.tracks.length,
        requestedLightCount: plan.totalTheoreticalLightCount,
        theoreticalLightCount: plan.totalTheoreticalLightCount,
        finalLightCount: positions.length,
        maxCount: plan.safetyCap,
        safetyCapApplied: plan.safetyCapApplied,
        spacing: plan.tracks.map((track) => roundForLog(plan.axisLength / Math.max(track.finalCount, 1))),
        trackOffsets: plan.tracks.map((track) => roundForLog(track.offset)),
        lightPositions: positions.map((position) => ({
          slot: position.slot,
          x: roundForLog(position.x),
          y: roundForLog(position.y),
          track: position.track
        })),
        rejectedOutsideSceneSlots,
        reason: plan.layoutReason
      }
    };
    safeLinkedDiagnosticLog("PZ LINKED LIGHT LINE LAYOUT PLAN", result.logData);
    Object.defineProperties(result.positions, {
      _pzTheoreticalSlots: { value: theoreticalPositions.map((position) => position.slot), enumerable: false },
      _pzRejectedOutsideSceneSlots: { value: rejectedOutsideSceneSlots, enumerable: false }
    });
    return result;
  }

  if (ring && ring.innerRadius > 0 && ring.outerRadius > ring.innerRadius) {
    const sceneBounds = resolveScenePlaceableBounds(scene);
    safeLinkedDiagnosticLog("PZ LINKED SCENE BOUNDS RESOLVED", {
      sceneId: scene?.id ?? null,
      minX: sceneBounds.minX,
      minY: sceneBounds.minY,
      maxX: sceneBounds.maxX,
      maxY: sceneBounds.maxY,
      width: sceneBounds.width,
      height: sceneBounds.height,
      boundsSource: sceneBounds.source,
      canvasReady: Boolean(canvas?.ready),
      sceneDimensions: duplicateData(canvas?.dimensions ?? null)
    });
    const plan = buildAdaptiveRingLightPlan({
      ring,
      gridSize,
      effectiveCoverageRadius,
      linkedLight
    });
    const sceneMargin = Math.max(1, Math.min(gridSize * 0.02, 8));
    const theoreticalPositions = plan.tracks.flatMap((track, trackIndex) => {
      const trackPositions = [];
      for (let index = 0; index < track.finalCount; index += 1) {
        const angle = track.angularOffset + (index / track.finalCount) * Math.PI * 2;
        const safeTrackRadius = clampTrackRadiusInsideRing(track.radius, ring, plan.margin);
        const x = ring.centerX + Math.cos(angle) * safeTrackRadius;
        const y = ring.centerY + Math.sin(angle) * safeTrackRadius;
        trackPositions.push({
          x,
          y,
          angle: normalizeRadians(angle),
          track: track.name ?? trackIndex,
          trackIndex,
          trackRadius: safeTrackRadius,
          slot: `${track.name ?? trackIndex}:${index}`
        });
      }
      return trackPositions;
    });
    const insideRegionPositions = theoreticalPositions.filter((position) => isPointInsideRingBand(position, ring, plan.margin));
    const positions = insideRegionPositions.filter((position) => isPointInsideSceneBounds(position, sceneBounds, sceneMargin));
    const rejectedOutsideRegionSlots = theoreticalPositions
      .filter((position) => !isPointInsideRingBand(position, ring, plan.margin))
      .map((position) => position.slot);
    const rejectedOutsideSceneSlots = insideRegionPositions
      .filter((position) => !isPointInsideSceneBounds(position, sceneBounds, sceneMargin))
      .map((position) => position.slot);
    const everyLightInsideRegion = positions.every((position) => isPointInsideRingBand(position, ring, plan.margin));
    const everyCreatedLightInsideRegion = everyLightInsideRegion;
    const everyCreatedLightInsideScene = positions.every((position) => isPointInsideSceneBounds(position, sceneBounds, sceneMargin));
    const visualAudits = plan.tracks.map((track, trackIndex) => buildRingLightVisualCoverageAudit({
      regionDocument,
      track,
      trackIndex,
      effectiveCoverageRadius,
      requiredRadialReach: plan.requiredRadialReach
    }));
    for (const audit of visualAudits) {
      safeLinkedDiagnosticLog("PZ LINKED LIGHT VISUAL COVERAGE AUDIT", audit);
    }
    const result = {
      layoutType: "ring-path",
      positions,
      logData: {
        regionId: regionDocument?.id ?? null,
        groupId: getRegionRuntimeFlags(regionDocument)?.groupId ?? null,
        innerRadius: ring.innerRadius,
        outerRadius: ring.outerRadius,
        bandWidth: plan.bandWidth,
        effectiveCoverageRadius,
        requiredRadialReach: plan.requiredRadialReach,
        selectedTrackCount: plan.tracks.length,
        trackRadii: plan.tracks.map((track) => roundForLog(track.radius)),
        theoreticalCountsPerTrack: plan.tracks.map((track) => track.theoreticalCount),
        finalCountsPerTrack: plan.tracks.map((track) => track.finalCount),
        totalTheoreticalLightCount: plan.totalTheoreticalLightCount,
        totalFinalLightCount: positions.length,
        angularSteps: plan.tracks.map((track) => roundForLog(track.angularStep)),
        angularOffsets: plan.tracks.map((track) => roundForLog(track.angularOffset)),
        overlapTarget: plan.overlapTarget,
        safetyCap: plan.safetyCap,
        safetyCapApplied: plan.safetyCapApplied,
        theoreticalLightCount: theoreticalPositions.length,
        insideRegionLightCount: insideRegionPositions.length,
        insideSceneLightCount: positions.length,
        rejectedOutsideRegionSlots,
        rejectedOutsideSceneSlots,
        createdLightCount: positions.length,
        sceneBounds,
        sceneMargin,
        lightPositions: positions.map((position) => ({
          x: roundForLog(position.x),
          y: roundForLog(position.y),
          angle: roundForLog(position.angle),
          track: position.track,
          slot: position.slot,
          trackRadius: roundForLog(position.trackRadius)
        })),
        everyLightInsideRegion,
        everyCreatedLightInsideRegion,
        everyCreatedLightInsideScene,
        layoutReason: plan.layoutReason,
        configuredBright,
        configuredDim
      }
    };
    Object.defineProperties(result.positions, {
      _pzTheoreticalSlots: { value: theoreticalPositions.map((position) => position.slot), enumerable: false },
      _pzRejectedOutsideSceneSlots: { value: rejectedOutsideSceneSlots, enumerable: false }
    });
    return result;
  }

  const anchor = resolveLinkedLightAnchor(shapes, templateDocument, regionDocument);
  safeLinkedDiagnosticLog("PZ LINKED LIGHT ANCHOR DECISION", anchor.logData);
  const center = anchor.point;
  if (!center) {
    return { layoutType: "center", positions: [], logData: { regionId: regionDocument?.id ?? null, groupId: getRegionRuntimeFlags(regionDocument)?.groupId ?? null, shapeType: shape?.type ?? null, everyLightInsideRegion: false } };
  }
  const radius = coerceNumber(shape?.radius, null);
  return {
    layoutType: "center",
    positions: [{ x: center.x, y: center.y, angle: null }],
    logData: {
      regionId: regionDocument?.id ?? null,
      groupId: getRegionRuntimeFlags(regionDocument)?.groupId ?? null,
      shapeType: shape?.type ?? null,
      centerX: center.x,
      centerY: center.y,
      innerRadius: 0,
      outerRadius: radius,
      lightPathRadius: 0,
      configuredBright,
      configuredDim,
      effectiveCoverageRadius,
      circumference: radius ? Math.PI * 2 * radius : null,
      requestedLightCount: 1,
      finalLightCount: 1,
      safetyCapApplied: false,
      lightPositions: [{ x: Math.round(center.x * 100) / 100, y: Math.round(center.y * 100) / 100, angle: null }],
      everyLightInsideRegion: true
    }
  };
}

function buildAdaptiveRingLightPlan({
  ring,
  gridSize,
  effectiveCoverageRadius,
  linkedLight = {}
} = {}) {
  const bandWidth = Math.max(0, ring.outerRadius - ring.innerRadius);
  const margin = Math.max(1, Math.min(gridSize * 0.05, bandWidth * 0.08));
  const overlapTarget = clampNumber(coerceNumber(linkedLight?.overlap, DEFAULT_RING_LIGHT_OVERLAP_TARGET), 0.2, 0.35);
  const requiredRadialReach = (bandWidth / 2) + margin;
  const visuallyThickBand = bandWidth >= gridSize * 1.5;
  const radialCoverageWeak = effectiveCoverageRadius < requiredRadialReach * 1.25;
  const selectedTrackCount = radialCoverageWeak || visuallyThickBand ? 2 : 1;
  const minimumCap = selectedTrackCount * 3;
  const safetyCap = Math.max(minimumCap, Math.min(64, Math.round(coerceNumber(linkedLight?.maxCount, DEFAULT_RING_LIGHT_MAX_COUNT))));
  const unclampedRadii = selectedTrackCount === 1
    ? [{ name: "middle", radius: (ring.innerRadius + ring.outerRadius) / 2 }]
    : [
      { name: "inner", radius: ring.innerRadius + bandWidth * 0.3 },
      { name: "outer", radius: ring.innerRadius + bandWidth * 0.7 }
    ];
  const tracks = unclampedRadii.map((track) => {
    const radius = clampTrackRadiusInsideRing(track.radius, ring, margin);
    const circumference = Math.PI * 2 * radius;
    const chordSpacing = Math.max(gridSize, effectiveCoverageRadius * (1 - overlapTarget));
    const countByCoverage = Math.ceil(circumference / chordSpacing);
    const countByAngularGap = Math.ceil((Math.PI * 2) / MAX_RING_LIGHT_ANGULAR_GAP);
    const theoreticalCount = Math.max(selectedTrackCount === 1 ? 6 : 4, countByCoverage, countByAngularGap);
    return {
      ...track,
      radius,
      circumference,
      theoreticalCount,
      finalCount: theoreticalCount,
      angularStep: (Math.PI * 2) / theoreticalCount,
      angularOffset: 0
    };
  });
  const totalTheoreticalLightCount = tracks.reduce((sum, track) => sum + track.theoreticalCount, 0);
  const safetyCapApplied = totalTheoreticalLightCount > safetyCap;
  if (safetyCapApplied) {
    distributeRingLightCapAcrossTracks(tracks, safetyCap);
  }
  for (const [index, track] of tracks.entries()) {
    track.angularStep = (Math.PI * 2) / Math.max(track.finalCount, 1);
    track.angularOffset = index === 0 ? track.angularStep / 2 : track.angularStep;
  }
  return {
    bandWidth,
    margin,
    overlapTarget,
    requiredRadialReach,
    safetyCap,
    safetyCapApplied,
    totalTheoreticalLightCount,
    tracks,
    layoutReason: selectedTrackCount === 1
      ? "single-track-radial-coverage-sufficient"
      : radialCoverageWeak ? "two-tracks-effective-coverage-below-band-reach" : "two-tracks-visually-thick-band"
  };
}

function distributeRingLightCapAcrossTracks(tracks, safetyCap) {
  const total = tracks.reduce((sum, track) => sum + track.theoreticalCount, 0);
  let remaining = safetyCap;
  tracks.forEach((track, index) => {
    const tracksLeft = tracks.length - index;
    const minimumForTrack = Math.min(track.theoreticalCount, 3);
    const proportional = Math.max(minimumForTrack, Math.floor((track.theoreticalCount / total) * safetyCap));
    const maximumAllowed = remaining - ((tracksLeft - 1) * 3);
    track.finalCount = Math.max(minimumForTrack, Math.min(proportional, maximumAllowed));
    remaining -= track.finalCount;
  });
  let index = 0;
  while (remaining > 0 && tracks.length) {
    tracks[index % tracks.length].finalCount += 1;
    remaining -= 1;
    index += 1;
  }
}

function clampTrackRadiusInsideRing(radius, ring, margin = 1) {
  const lower = ring.innerRadius + margin;
  const upper = ring.outerRadius - margin;
  if (upper <= lower) {
    return (ring.innerRadius + ring.outerRadius) / 2;
  }
  return Math.min(Math.max(radius, lower), upper);
}

function buildRingLightVisualCoverageAudit({
  regionDocument = null,
  track = {},
  trackIndex = 0,
  effectiveCoverageRadius = 0,
  requiredRadialReach = 0
} = {}) {
  const lightCount = Math.max(track.finalCount ?? 0, 0);
  const maximumAngularGap = lightCount ? (Math.PI * 2) / lightCount : null;
  const maximumArcGap = maximumAngularGap !== null ? maximumAngularGap * track.radius : null;
  const estimatedCoverageGap = maximumArcGap !== null ? Math.max(0, maximumArcGap - (effectiveCoverageRadius * 2)) : null;
  const radialCoverageSatisfied = effectiveCoverageRadius >= requiredRadialReach;
  const tangentialCoverageSatisfied = maximumAngularGap !== null && maximumAngularGap <= MAX_RING_LIGHT_ANGULAR_GAP;
  return {
    regionId: regionDocument?.id ?? null,
    trackIndex,
    trackRadius: roundForLog(track.radius),
    lightCount,
    maximumAngularGap: roundForLog(maximumAngularGap),
    maximumArcGap: roundForLog(maximumArcGap),
    estimatedCoverageGap: roundForLog(estimatedCoverageGap),
    radialCoverageSatisfied,
    tangentialCoverageSatisfied,
    visualCoverageSatisfied: radialCoverageSatisfied && tangentialCoverageSatisfied && (estimatedCoverageGap ?? 0) <= 0
  };
}

function isPointInsideRingBand(point, ring, margin = 0) {
  const dx = coerceNumber(point?.x, 0) - ring.centerX;
  const dy = coerceNumber(point?.y, 0) - ring.centerY;
  const distance = Math.hypot(dx, dy);
  return distance > ring.innerRadius + margin && distance < ring.outerRadius - margin;
}

function clampNumber(value, min, max) {
  const numeric = Number.isFinite(value) ? value : min;
  return Math.min(Math.max(numeric, min), max);
}

function normalizeRadians(value) {
  const fullCircle = Math.PI * 2;
  return ((value % fullCircle) + fullCircle) % fullCircle;
}

function roundForLog(value) {
  if (!Number.isFinite(value)) {
    return value ?? null;
  }
  return Math.round(value * 100) / 100;
}

function buildAdaptiveLineLightPlan({
  shape,
  grid = null,
  gridSize,
  effectiveCoverageRadius,
  linkedLight = {}
} = {}) {
  const x = coerceNumber(shape?.x, null);
  const y = coerceNumber(shape?.y, null);
  const sourceLength = coerceNumber(shape?.length, 0);
  const sourceWidth = Math.max(0, coerceNumber(shape?.width, 0));
  const rotation = coerceNumber(shape?.rotation, 0);
  if (x === null || y === null || sourceLength <= 0) {
    return null;
  }

  const axis = buildNativeLineRay({ x, y, length: sourceLength, rotation, gridBased: shape?.gridBased }, grid);
  const transverse = sourceWidth > 0
    ? buildNativeLineRay({
      x,
      y,
      length: sourceWidth,
      rotation: rotation + 90,
      gridBased: shape?.gridBased,
      alignment: 0.5
    }, grid)
    : null;
  const axisLength = Math.hypot(axis.dx, axis.dy);
  const actualWidth = transverse ? Math.hypot(transverse.dx, transverse.dy) : 0;
  if (axisLength <= 0) {
    return null;
  }

  const overlapTarget = clampNumber(coerceNumber(linkedLight?.overlap, DEFAULT_RING_LIGHT_OVERLAP_TARGET), 0.2, 0.35);
  const margin = Math.max(1, Math.min(gridSize * 0.05, actualWidth * 0.08));
  const requiredRadialReach = (actualWidth / 2) + margin;
  const visuallyThickBand = actualWidth >= gridSize * 1.5;
  const radialCoverageWeak = effectiveCoverageRadius < requiredRadialReach * 1.25;
  const requestedTrackCount = radialCoverageWeak || visuallyThickBand ? 2 : 1;
  const requestedMaxCount = Math.max(1, Math.min(64, Math.round(coerceNumber(linkedLight?.maxCount, DEFAULT_RING_LIGHT_MAX_COUNT))));
  const selectedTrackCount = requestedTrackCount === 2 && requestedMaxCount >= 2 ? 2 : 1;
  const safetyCap = requestedMaxCount;
  const targetSpacing = Math.max(gridSize, effectiveCoverageRadius * (1 - overlapTarget));
  const theoreticalCountPerTrack = Math.max(1, Math.ceil(axisLength / targetSpacing));
  const totalTheoreticalLightCount = theoreticalCountPerTrack * selectedTrackCount;
  const safetyCapApplied = totalTheoreticalLightCount > safetyCap;
  const usableHalfWidth = Math.max(0, (actualWidth / 2) - margin);
  const offset = Math.min(actualWidth * 0.2, usableHalfWidth);
  const tracks = selectedTrackCount === 1
    ? [{ name: "middle", index: 0, offset: 0, theoreticalCount: theoreticalCountPerTrack, finalCount: theoreticalCountPerTrack }]
    : [
      { name: "left", index: 0, offset: -offset, theoreticalCount: theoreticalCountPerTrack, finalCount: theoreticalCountPerTrack },
      { name: "right", index: 1, offset, theoreticalCount: theoreticalCountPerTrack, finalCount: theoreticalCountPerTrack }
    ];
  if (safetyCapApplied) {
    distributeLineLightCapAcrossTracks(tracks, safetyCap);
  }
  const normalLength = transverse ? Math.hypot(transverse.dx, transverse.dy) : 0;
  const normal = normalLength > 0
    ? { x: transverse.dx / normalLength, y: transverse.dy / normalLength }
    : { x: -axis.dy / axisLength, y: axis.dx / axisLength };

  return {
    axis,
    axisLength,
    normal,
    sourceLength,
    sourceWidth,
    rotation,
    overlapTarget,
    requiredRadialReach,
    safetyCap,
    safetyCapApplied,
    totalTheoreticalLightCount,
    tracks,
    layoutReason: selectedTrackCount === 1
      ? requestedTrackCount === 2 ? "single-track-max-count-too-low" : "single-track-radial-coverage-sufficient"
      : radialCoverageWeak ? "two-tracks-effective-coverage-below-line-half-width" : "two-tracks-visually-thick-line"
  };
}

function distributeLineLightCapAcrossTracks(tracks, safetyCap) {
  const baseCount = Math.floor(safetyCap / tracks.length);
  let remainder = safetyCap % tracks.length;
  for (const track of tracks) {
    track.finalCount = Math.max(1, Math.min(track.theoreticalCount, baseCount + (remainder > 0 ? 1 : 0)));
    if (remainder > 0) {
      remainder -= 1;
    }
  }
}

function logLinkedWallDecision({
  regionDocument = null,
  shapes = [],
  linkedWalls = {},
  segmentCount = 0,
  payloadCount = 0,
  existingWallCount = 0,
  creationRequested = false
} = {}) {
  const shapeType = Array.from(shapes ?? [])[0]?.type ?? null;
  const wallPreset = linkedWalls?.presetId ?? linkedWalls?.id ?? linkedWalls?.preset ?? null;
  console.log(
    `[${MODULE_ID}][linked] PZ LINKED WALL DECISION | regionId=${regionDocument?.id ?? null} | ` +
    `shapeType=${shapeType} | wallsEnabled=${linkedWalls?.enabled === true} | wallPreset=${wallPreset} | ` +
    `segmentCount=${segmentCount} | payloadCount=${payloadCount} | existingWallCount=${existingWallCount} | ` +
    `creationRequested=${creationRequested}`
  );
}

function logLinkedLightDocumentPayload(payload, desiredLights = []) {
  const config = payload?.config ?? {};
  console.log(
    `[${MODULE_ID}][linked] PZ LINKED LIGHT DOCUMENT PAYLOAD | ` +
    `slot=${getLinkedLightSlotKey(payload)} | x=${payload?.x ?? null} | y=${payload?.y ?? null} | ` +
    `bright=${config.bright ?? null} | dim=${config.dim ?? null} | ` +
    `brightSource=${desiredLights?._pzBrightSource ?? "runtime-fallback"} | ` +
    `dimSource=${desiredLights?._pzDimSource ?? "runtime-fallback"} | ` +
    `color=${config.color ?? null} | alpha=${config.alpha ?? null} | ` +
    `luminosity=${config.luminosity ?? null} | hidden=${payload?.hidden ?? null} | ` +
    `walls=${payload?.walls ?? null} | animation.type=${config.animation?.type ?? null}`
  );
}

function safeLinkedDiagnosticLog(label, data = {}) {
  try {
    console.warn(`[${MODULE_ID}][linked] ${label}`, duplicateData(data ?? {}));
  } catch (caughtError) {
    console.warn(`[${MODULE_ID}][linked] ${label} failed`, {
      reason: caughtError?.message ?? "unknown"
    });
  }
}

function resolveLinkedLightElevation(regionDocument, linkedLight = {}) {
  const explicit = coerceNumber(linkedLight?.elevation, null);
  if (explicit !== null) {
    return explicit;
  }
  return coerceNumber(regionDocument?.elevation ?? regionDocument?.document?.elevation, null);
}

function findShapeCenter(shape, { grid = null } = {}) {
  switch (shape?.type) {
    case "circle":
      return {
        x: coerceNumber(shape.x, 0),
        y: coerceNumber(shape.y, 0)
      };
    case "emanation":
      return findEmanationCenter(shape);
    case "ellipse":
      return findEllipseCenter(shape);
    case "line":
      return findLineCenter(shape, grid);
    case "rectangle":
      return findRectangleCenter(shape);
    case "polygon":
      return findPolygonCenter(shape.points);
    default:
      return null;
  }
}

function findLineCenter(shape, grid = null) {
  const x = coerceNumber(shape?.x, null);
  const y = coerceNumber(shape?.y, null);
  const length = coerceNumber(shape?.length, 0);
  if (x === null || y === null || length <= 0) {
    return null;
  }

  const axis = buildNativeLineRay({
    x,
    y,
    length,
    rotation: coerceNumber(shape?.rotation, 0),
    gridBased: shape?.gridBased
  }, grid);
  return {
    x: (axis.a.x + axis.b.x) / 2,
    y: (axis.a.y + axis.b.y) / 2
  };
}

function findEmanationCenter(shape) {
  const base = shape?.base ?? {};
  if (base.type === "token") {
    const gridSize = coerceNumber(canvas?.grid?.size, 100) || 100;
    const width = Math.max(coerceNumber(base.width, 1), 0.1) * gridSize;
    const height = Math.max(coerceNumber(base.height, 1), 0.1) * gridSize;
    return {
      x: coerceNumber(base.x, 0) + (width / 2),
      y: coerceNumber(base.y, 0) + (height / 2)
    };
  }

  return {
    x: coerceNumber(base.x ?? shape?.x, 0),
    y: coerceNumber(base.y ?? shape?.y, 0)
  };
}

function findEllipseCenter(shape) {
  return {
    x: coerceNumber(shape?.cx ?? shape?.x, 0),
    y: coerceNumber(shape?.cy ?? shape?.y, 0)
  };
}

function findRectangleCenter(shape) {
  const x = coerceNumber(shape?.x, 0);
  const y = coerceNumber(shape?.y, 0);
  const width = coerceNumber(shape?.width, 0);
  const height = coerceNumber(shape?.height, 0);
  const center = {
    x: x + (width / 2),
    y: y + (height / 2)
  };
  const rotation = (coerceNumber(shape?.rotation, 0) * Math.PI) / 180;

  return rotation ? rotatePoint(center, { x, y }, rotation) : center;
}

function findPolygonCenter(points) {
  if (!Array.isArray(points) || points.length < 6) {
    return null;
  }

  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let index = 0; index < points.length; index += 2) {
    sumX += coerceNumber(points[index], 0);
    sumY += coerceNumber(points[index + 1], 0);
    count += 1;
  }

  return count ? { x: sumX / count, y: sumY / count } : null;
}

function findTemplateCenter(templateDocument) {
  if (!templateDocument) {
    return null;
  }

  const type = getTemplateType(templateDocument);
  const x = coerceNumber(templateDocument.x, 0);
  const y = coerceNumber(templateDocument.y, 0);
  const scene = templateDocument.parent ?? canvas?.scene ?? null;
  const distance = distanceToPixels(templateDocument.distance, scene);

  if (type === "ray") {
    const direction = (coerceNumber(templateDocument.direction, 0) * Math.PI) / 180;
    return {
      x: x + Math.cos(direction) * (distance / 2),
      y: y + Math.sin(direction) * (distance / 2)
    };
  }

  return { x, y };
}

function rotatePoint(point, origin, radians) {
  if (!radians) {
    return { x: point.x, y: point.y };
  }

  const translatedX = point.x - origin.x;
  const translatedY = point.y - origin.y;

  return {
    x: origin.x + (translatedX * Math.cos(radians)) - (translatedY * Math.sin(radians)),
    y: origin.y + (translatedX * Math.sin(radians)) + (translatedY * Math.cos(radians))
  };
}

function normalizeLinkedWallMode(value) {
  const normalized = String(value ?? "move").toLowerCase();
  return ["move", "sight", "both"].includes(normalized) ? normalized : "move";
}

function normalizeLinkedWallSegments(value) {
  const numericValue = Math.round(coerceNumber(value, DEFAULT_LINKED_WALL_SEGMENTS));
  return Math.min(Math.max(numericValue, 8), 64);
}

function resolveWallMovementValue(value, modeFallback = "move") {
  const fallbackChannel = deriveWallChannelFallback(modeFallback).move;
  const normalized = normalizeWallMovementChannel(value ?? fallbackChannel);

  switch (normalized) {
    case "limited":
      debug("Normalized invalid linked wall movement value at document build time.", {
        requestedValue: value,
        normalizedValue: "normal"
      });
      return CONST?.WALL_MOVEMENT_TYPES?.NORMAL ?? 20;
    case "normal":
      return CONST?.WALL_MOVEMENT_TYPES?.NORMAL ?? 20;
    case "none":
    default:
      return CONST?.WALL_MOVEMENT_TYPES?.NONE ?? 0;
  }
}

function resolveWallSenseValue(value, modeFallback = "none") {
  const fallbackChannel = deriveWallChannelFallback(modeFallback).sight;
  const normalized = normalizeWallSenseChannel(value ?? fallbackChannel);

  switch (normalized) {
    case "limited":
      return CONST?.EDGE_SENSE_TYPES?.LIMITED ?? 10;
    case "proximity":
      return CONST?.EDGE_SENSE_TYPES?.PROXIMITY ?? CONST?.EDGE_SENSE_TYPES?.NORMAL ?? 20;
    case "distance":
      return CONST?.EDGE_SENSE_TYPES?.DISTANCE ?? CONST?.EDGE_SENSE_TYPES?.NORMAL ?? 20;
    case "normal":
      return CONST?.EDGE_SENSE_TYPES?.NORMAL ?? 20;
    case "none":
    default:
      return CONST?.EDGE_SENSE_TYPES?.NONE ?? 0;
  }
}

function resolveWallDirectionValue(value) {
  switch (String(value ?? "both").trim().toLowerCase()) {
    case "left":
      return CONST.EDGE_DIRECTIONS.LEFT;
    case "right":
      return CONST.EDGE_DIRECTIONS.RIGHT;
    case "both":
    default:
      return CONST.EDGE_DIRECTIONS.BOTH;
  }
}

function deriveWallChannelFallback(modeFallback) {
  switch (normalizeLinkedWallMode(modeFallback)) {
    case "both":
      return {
        move: "normal",
        sight: "normal"
      };
    case "sight":
      return {
        move: "none",
        sight: "normal"
      };
    case "move":
    default:
      return {
        move: "normal",
        sight: "none"
      };
  }
}

function normalizeWallMovementChannel(value) {
  const normalized = String(value ?? "none").trim().toLowerCase();
  return ["none", "normal", "limited"].includes(normalized) ? normalized : "none";
}

function normalizeWallSenseChannel(value) {
  const normalized = String(value ?? "none").trim().toLowerCase();
  return ["none", "normal", "limited", "proximity", "distance"].includes(normalized)
    ? normalized
    : "none";
}

function normalizeLinkedLightAnimation(value) {
  const animation = value && typeof value === "object" ? value : {};

  return {
    type: animation.type ?? null,
    speed: coerceNumber(animation.speed, 1),
    intensity: coerceNumber(animation.intensity, 1),
    reverse: coerceBoolean(animation.reverse, false) ?? false
  };
}
