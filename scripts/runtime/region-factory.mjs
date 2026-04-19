import {
  DEFAULT_REGION_COLOR,
  MODULE_ID,
  NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE,
  RUNTIME_FLAG_KEY,
  STANDARD_DIFFICULT_TERRAIN_MULTIPLIER
} from "../constants.mjs";
import {
  buildManagedRegionFlags,
  coerceNumber,
  debug,
  distanceToPixels,
  duplicateData,
  error,
  findManagedRegions,
  fromUuidSafe,
  getRegionRuntimeFlags,
  getTemplateType,
  isPrimaryGM,
  translateFlatPoints,
  trimClosingPolygonPoint,
  wait
} from "./utils.mjs";
import {
  cleanupLinkedDocumentsForRegion,
  syncLinkedDocumentsForRegion
} from "./linked-documents.mjs";
import { resolveTemplateSourceContext } from "./template-source-context.mjs";
import {
  getZoneDefinitionFromItem,
  normalizeZoneDefinition
} from "./zone-definition.mjs";

let hooksRegistered = false;
const pendingTemplateSync = new Set();
const DEFAULT_RING_SEGMENTS = 24;

export function registerRegionFactoryHooks() {
  if (hooksRegistered) {
    return;
  }

  Hooks.on("createMeasuredTemplate", onCreateMeasuredTemplate);
  Hooks.on("updateMeasuredTemplate", onUpdateMeasuredTemplate);
  Hooks.on("deleteRegion", onDeleteRegion);
  hooksRegistered = true;
}

async function onCreateMeasuredTemplate(templateDocument, options, userId) {
  if (!isPrimaryGM()) {
    return;
  }

  try {
    await createRegionFromTemplate(templateDocument, { userId });
  } catch (caughtError) {
    error("Failed to create Region from MeasuredTemplate.", caughtError, {
      templateId: templateDocument?.id ?? null
    });
  }
}

async function onUpdateMeasuredTemplate(templateDocument, changed, options, userId) {
  if (!isPrimaryGM()) {
    return;
  }

  const updateKeys = collectRelevantTemplateUpdateKeys(changed);
  if (!updateKeys.length) {
    return;
  }

  const syncKey = buildTemplateSyncKey(templateDocument);
  if (pendingTemplateSync.has(syncKey)) {
    debug("Skipped template sync because a sync is already pending.", {
      templateId: templateDocument?.id ?? null,
      updateKeys
    });
    return;
  }

  pendingTemplateSync.add(syncKey);

  try {
    await syncRegionToTemplate(templateDocument, {
      changed,
      options,
      updateKeys,
      userId
    });
  } catch (caughtError) {
    error("Failed to sync Region from updated MeasuredTemplate.", caughtError, {
      templateId: templateDocument?.id ?? null,
      updateKeys
    });
  } finally {
    pendingTemplateSync.delete(syncKey);
  }
}

export async function createRegionFromTemplate(
  templateDocument,
  {
    force = false,
    userId = null,
    item = null,
    actor = null,
    caster = null,
    rawDefinition = null
  } = {}
) {
  const scene = templateDocument?.parent ?? null;

  if (!scene) {
    debug("Skipped Region creation because the template has no parent Scene.", {
      templateId: templateDocument?.id ?? null
    });
    return null;
  }

  const existingRegions = findManagedRegionsForTemplate(scene, templateDocument);
  if (existingRegions.length && !force) {
    debug("Skipped Region creation because a managed Region already exists.", {
      templateId: templateDocument.id,
      regionId: existingRegions[0]?.id ?? null,
      regionCount: existingRegions.length
    });
    return existingRegions[0] ?? null;
  }

  const resolvedContext = await resolveTemplateSourceContext(templateDocument);
  const sourceContext = {
    item: item ?? resolvedContext.item ?? null,
    actor: actor ?? item?.actor ?? resolvedContext.actor ?? null,
    caster: caster ?? resolvedContext.caster ?? actor ?? item?.actor ?? null
  };

  if (!sourceContext.item) {
    debug("Skipped template without a resolvable linked item.", {
      templateId: templateDocument.id,
      userId,
      resolutionNotes: resolvedContext.report?.notes ?? [],
      matched: resolvedContext.report?.matched ?? []
    });
    return null;
  }

  const zoneDefinition = rawDefinition ?? getZoneDefinitionFromItem(sourceContext.item);
  if (!zoneDefinition) {
    debug("Skipped template without a persistent-zones definition on the linked item.", {
      templateId: templateDocument.id,
      itemUuid: sourceContext.item.uuid
    });
    return null;
  }

  const normalizedDefinition = normalizeZoneDefinition(zoneDefinition, {
    item: sourceContext.item,
    actor: sourceContext.actor,
    caster: sourceContext.caster,
    templateDocument
  });

  if (!normalizedDefinition.validation.isValid) {
    const validationReasons = Array.isArray(normalizedDefinition.validation.reasons)
      ? normalizedDefinition.validation.reasons
      : [];
    debug("Skipped template with an invalid normalized zone definition.", {
      templateId: templateDocument.id,
      reasons: validationReasons,
      reasonsText: validationReasons.join(" | ")
    });
    return null;
  }

  const groupPlan = await buildManagedRegionGroupPlan({
    templateDocument,
    normalizedDefinition,
    sourceContext,
    existingRegions
  });

  if (!groupPlan.parts.length) {
    debug("Skipped template because no supported Region shape could be produced.", {
      templateId: templateDocument.id,
      templateType: getTemplateType(templateDocument)
    });
    return null;
  }

  if (existingRegions.length && force) {
    await deleteManagedRegionGroup(existingRegions, {
      reason: "force-recreate-group"
    });
  }

  const createdRegions = await scene.createEmbeddedDocuments(
    "Region",
    groupPlan.parts.map((partPlan) => partPlan.regionData)
  );

  for (let index = 0; index < createdRegions.length; index += 1) {
    const createdRegion = createdRegions[index] ?? null;
    const partPlan = groupPlan.parts[index] ?? null;
    if (!createdRegion || !partPlan) {
      continue;
    }

    await syncLinkedDocumentsSafely({
      templateDocument,
      regionDocument: createdRegion,
      normalizedDefinition: partPlan.runtimeDefinition,
      shapes: partPlan.shapes,
      stage: "create-region"
    });

    debug("Created managed Region part from MeasuredTemplate.", {
      templateId: templateDocument.id,
      regionGroupId: groupPlan.groupId,
      regionId: createdRegion.id,
      partId: partPlan.partId,
      geometryType: partPlan.geometryType,
      side: partPlan.geometrySide ?? null,
      offsetReference: partPlan.geometryOffsetReference ?? null,
      offsetStart: partPlan.geometryOffsetStart ?? null,
      offsetEnd: partPlan.geometryOffsetEnd ?? null
    });
  }

  debug("Created managed Region group from MeasuredTemplate.", {
    templateId: templateDocument.id,
    regionGroupId: groupPlan.groupId,
    regionCount: createdRegions.length,
    geometryTypes: groupPlan.parts.map((partPlan) => partPlan.geometryType),
    partIds: groupPlan.parts.map((partPlan) => partPlan.partId)
  });

  return createdRegions?.[0] ?? null;
}

async function syncRegionToTemplate(templateDocument, {
  changed = {},
  updateKeys = [],
  userId = null
} = {}) {
  const scene = templateDocument?.parent ?? null;
  if (!scene) {
    debug("Skipped template sync because the template has no parent Scene.", {
      templateId: templateDocument?.id ?? null,
      updateKeys,
      strategy: "update-region",
      syncApplied: false
    });
    return null;
  }

  const existingRegions = findManagedRegionsForTemplate(scene, templateDocument);
  if (!existingRegions.length) {
    const createdRegion = await createRegionFromTemplate(templateDocument, { userId });
    debug("Synced managed Region group from updated MeasuredTemplate.", {
      templateId: templateDocument?.id ?? null,
      regionId: createdRegion?.id ?? null,
      regionCount: createdRegion ? 1 : 0,
      updateKeys,
      strategy: "create-region-group",
      syncApplied: Boolean(createdRegion)
    });
    return createdRegion;
  }

  const syncPayload = await buildRegionSyncPayload(templateDocument, existingRegions);
  if (!syncPayload || !syncPayload.parts.length) {
    debug("Skipped template sync because Region group sync payload could not be built.", {
      templateId: templateDocument?.id ?? null,
      regionId: existingRegions[0]?.id ?? null,
      regionCount: existingRegions.length,
      updateKeys,
      strategy: "update-region",
      syncApplied: false
    });
    return existingRegions[0] ?? null;
  }

  if (existingRegions.length > 1 || syncPayload.parts.length > 1) {
    const recreatedRegions = await recreateManagedRegionGroupFromTemplate(templateDocument, existingRegions, syncPayload);
    debug("Synced managed Region group from updated MeasuredTemplate.", {
      templateId: templateDocument?.id ?? null,
      regionGroupId: syncPayload.groupId,
      regionId: recreatedRegions?.[0]?.id ?? null,
      regionCount: recreatedRegions.length,
      updateKeys,
      strategy: "recreate-group",
      syncApplied: recreatedRegions.length > 0
    });
    return recreatedRegions[0] ?? null;
  }

  const existingRegion = existingRegions[0];
  const partPlan = syncPayload.parts[0] ?? null;
  if (!partPlan) {
    return existingRegion;
  }

  try {
    await existingRegion.update(buildRegionUpdateData(partPlan.regionData));
    await syncLinkedDocumentsSafely({
      templateDocument,
      regionDocument: existingRegion,
      normalizedDefinition: partPlan.runtimeDefinition,
      shapes: partPlan.shapes,
      stage: "update-region"
    });

    debug("Synced managed Region part from updated MeasuredTemplate.", {
      templateId: templateDocument?.id ?? null,
      regionId: existingRegion.id,
      regionGroupId: syncPayload.groupId,
      partId: partPlan.partId,
      geometryType: partPlan.geometryType,
      side: partPlan.geometrySide ?? null,
      offsetReference: partPlan.geometryOffsetReference ?? null,
      offsetStart: partPlan.geometryOffsetStart ?? null,
      offsetEnd: partPlan.geometryOffsetEnd ?? null,
      updateKeys,
      strategy: "update-region",
      syncApplied: true
    });

    debug("Synced managed Region group from updated MeasuredTemplate.", {
      templateId: templateDocument?.id ?? null,
      regionGroupId: syncPayload.groupId,
      regionId: existingRegion.id,
      regionCount: 1,
      updateKeys,
      strategy: "update-region",
      syncApplied: true
    });
    return existingRegion;
  } catch (caughtError) {
    debug("Direct Region update failed during template sync; attempting recreate group fallback.", {
      templateId: templateDocument?.id ?? null,
      regionId: existingRegion.id,
      regionGroupId: syncPayload.groupId,
      updateKeys,
      strategy: "recreate-group",
      reason: caughtError?.message ?? "unknown"
    });

    const recreatedRegions = await recreateManagedRegionGroupFromTemplate(templateDocument, existingRegions, syncPayload);
    debug("Synced managed Region group from updated MeasuredTemplate.", {
      templateId: templateDocument?.id ?? null,
      regionGroupId: syncPayload.groupId,
      regionId: recreatedRegions?.[0]?.id ?? null,
      regionCount: recreatedRegions.length,
      updateKeys,
      strategy: "recreate-group",
      syncApplied: recreatedRegions.length > 0
    });
    return recreatedRegions[0] ?? null;
  }
}

export function findManagedRegionForTemplate(scene, templateDocument) {
  return findManagedRegionsForTemplate(scene, templateDocument)[0] ?? null;
}

function findManagedRegionsForTemplate(scene, templateDocument) {
  const templateId = templateDocument?.id ?? null;
  const templateUuid = templateDocument?.uuid ?? null;

  return findManagedRegions(scene, (region) => {
    const runtime = getRegionRuntimeFlags(region);
    return runtime?.templateId === templateId || runtime?.templateUuid === templateUuid;
  });
}

async function onDeleteRegion(regionDocument) {
  if (!isPrimaryGM()) {
    return;
  }

  if (!getRegionRuntimeFlags(regionDocument)) {
    return;
  }

  try {
    await cleanupLinkedDocumentsForRegion(regionDocument, {
      reason: "region-deleted",
      skipRuntimeUpdate: true
    });
  } catch (caughtError) {
    error("Failed to cleanup linked documents after Region deletion.", caughtError, {
      regionId: regionDocument?.id ?? null,
      templateId: getRegionRuntimeFlags(regionDocument)?.templateId ?? null
    });
  }
}

function buildRegionCreateData({
  templateDocument,
  normalizedDefinition,
  sourceContext,
  shapes,
  existingRuntime = null,
  groupId = null,
  partId = null,
  partIndex = 0,
  partCount = 1,
  geometryType = "template"
}) {
  const behaviors = buildNativeRegionBehaviors({
    normalizedDefinition,
    sourceContext
  });
  const runtimeFlags = {
    templateId: templateDocument.id ?? null,
    templateUuid: templateDocument.uuid ?? null,
    itemUuid: normalizedDefinition.itemUuid ?? sourceContext.item?.uuid ?? null,
    actorUuid: normalizedDefinition.actorUuid ?? sourceContext.actor?.uuid ?? null,
    casterUuid: normalizedDefinition.casterUuid ?? sourceContext.caster?.uuid ?? null,
    dc: normalizedDefinition.dc ?? null,
    castLevel: normalizedDefinition.castLevel ?? null,
    groupId,
    partId,
    partIndex,
    partCount,
    geometryType,
    linkedDocuments: duplicateLinkedDocuments(existingRuntime?.linkedDocuments),
    normalizedDefinition
  };

  return {
    name: buildRegionName(normalizedDefinition, sourceContext),
    color: DEFAULT_REGION_COLOR,
    elevation: coerceNumber(templateDocument.elevation, 0),
    shapes,
    behaviors,
    flags: buildManagedRegionFlags(runtimeFlags)
  };
}

async function buildRegionSyncPayload(templateDocument, regionDocuments) {
  const primaryRegion = Array.isArray(regionDocuments) ? regionDocuments[0] ?? null : regionDocuments ?? null;
  const sourceContext = await resolveRegionSourceContext(templateDocument, primaryRegion);
  const runtime = getRegionRuntimeFlags(primaryRegion) ?? {};
  let normalizedDefinition = runtime.normalizedDefinition ?? null;

  if (sourceContext.item) {
    const zoneDefinition = getZoneDefinitionFromItem(sourceContext.item);
    if (zoneDefinition) {
      normalizedDefinition = normalizeZoneDefinition(zoneDefinition, {
        item: sourceContext.item,
        actor: sourceContext.actor,
        caster: sourceContext.caster,
        templateDocument
      });
    }
  }

  if (!normalizedDefinition?.validation?.isValid) {
    const validationReasons = Array.isArray(normalizedDefinition?.validation?.reasons)
      ? normalizedDefinition.validation.reasons
      : [];
    debug("Skipped Region sync because the normalized definition is invalid.", {
      templateId: templateDocument?.id ?? null,
      regionId: primaryRegion?.id ?? null,
      reasons: validationReasons,
      reasonsText: validationReasons.join(" | ")
    });
    return null;
  }

  return buildManagedRegionGroupPlan({
    templateDocument,
    normalizedDefinition,
    sourceContext,
    existingRegions: Array.isArray(regionDocuments)
      ? regionDocuments
      : primaryRegion
        ? [primaryRegion]
        : []
  });
}

function buildRegionUpdateData(regionData) {
  return {
    name: regionData.name,
    elevation: regionData.elevation,
    shapes: regionData.shapes,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]: regionData.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY] ?? null
  };
}

async function recreateManagedRegionGroupFromTemplate(templateDocument, regionDocuments, groupPlan) {
  const scene = templateDocument?.parent ?? regionDocuments?.[0]?.parent ?? null;
  if (!scene || !groupPlan?.parts?.length) {
    return [];
  }

  await deleteManagedRegionGroup(regionDocuments, {
    reason: "region-group-recreate"
  });

  const createdRegions = await scene.createEmbeddedDocuments(
    "Region",
    groupPlan.parts.map((partPlan) => partPlan.regionData)
  );

  for (let index = 0; index < createdRegions.length; index += 1) {
    const createdRegion = createdRegions[index] ?? null;
    const partPlan = groupPlan.parts[index] ?? null;
    if (!createdRegion || !partPlan) {
      continue;
    }

    await syncLinkedDocumentsSafely({
      templateDocument,
      regionDocument: createdRegion,
      normalizedDefinition: partPlan.runtimeDefinition,
      shapes: partPlan.shapes,
      stage: "recreate-region"
    });
  }

  return createdRegions;
}

async function resolveRegionSourceContext(templateDocument, regionDocument) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const resolvedContext = await resolveTemplateSourceContext(templateDocument);
  const itemByRuntime = await resolveDocumentFromRuntimeUuid(runtime.itemUuid, "Item");
  const actorByRuntime = await resolveDocumentFromRuntimeUuid(runtime.actorUuid, "Actor");
  const casterByRuntime = await resolveDocumentFromRuntimeUuid(runtime.casterUuid, "Actor");

  return {
    item: itemByRuntime ?? resolvedContext.item ?? null,
    actor: actorByRuntime ?? resolvedContext.actor ?? itemByRuntime?.actor ?? null,
    caster: casterByRuntime ?? resolvedContext.caster ?? actorByRuntime ?? itemByRuntime?.actor ?? null
  };
}

async function buildManagedRegionGroupPlan({
  templateDocument,
  normalizedDefinition,
  sourceContext,
  existingRegions = []
}) {
  const groupId = buildManagedRegionGroupId(templateDocument, existingRegions);
  const sourceParts = Array.isArray(normalizedDefinition?.parts) && normalizedDefinition.parts.length
    ? normalizedDefinition.parts
    : [{
      id: "primary",
      label: normalizedDefinition?.label ?? "primary",
      geometry: { type: "template" },
      targeting: duplicateData(normalizedDefinition?.targeting ?? {}),
      terrain: duplicateData(normalizedDefinition?.terrain ?? {}),
      linkedWalls: duplicateData(normalizedDefinition?.linkedWalls ?? {}),
      linkedLight: duplicateData(normalizedDefinition?.linkedLight ?? {}),
      triggers: duplicateData(normalizedDefinition?.triggers ?? {})
    }];

  const preparedParts = [];

  for (const [index, zonePart] of sourceParts.entries()) {
    const shapes = await buildRegionShapesForZonePart(templateDocument, zonePart);
    if (!Array.isArray(shapes) || !shapes.length) {
      debug("Skipped managed Region part because no supported Region shape could be produced.", {
        templateId: templateDocument?.id ?? null,
        regionGroupId: groupId,
        partId: zonePart?.id ?? `part-${index + 1}`,
        geometryType: zonePart?.geometry?.type ?? "template"
      });
      continue;
    }

    preparedParts.push({
      zonePart,
      shapes,
      existingRuntime: resolveExistingRuntimeForPart(existingRegions, zonePart?.id ?? null),
      geometrySide: zonePart?.geometry?.side ?? null,
      geometryOffsetReference: zonePart?.geometry?.offsetReference ?? null,
      geometryOffsetStart: zonePart?.geometry?.offsetStart ?? null,
      geometryOffsetEnd: zonePart?.geometry?.offsetEnd ?? null
    });
  }

  const partCount = preparedParts.length;
  const parts = preparedParts.map((preparedPart, index) => {
    const runtimeDefinition = buildPartRuntimeDefinition(normalizedDefinition, preparedPart.zonePart, {
      groupId,
      partIndex: index,
      partCount
    });

    return {
      partId: preparedPart.zonePart.id ?? `part-${index + 1}`,
      partIndex: index,
      geometryType: preparedPart.zonePart?.geometry?.type ?? "template",
      geometrySide: preparedPart.geometrySide ?? null,
      geometryOffsetReference: preparedPart.geometryOffsetReference ?? null,
      geometryOffsetStart: preparedPart.geometryOffsetStart ?? null,
      geometryOffsetEnd: preparedPart.geometryOffsetEnd ?? null,
      runtimeDefinition,
      shapes: preparedPart.shapes,
      regionData: buildRegionCreateData({
        templateDocument,
        normalizedDefinition: runtimeDefinition,
        sourceContext,
        shapes: preparedPart.shapes,
        existingRuntime: preparedPart.existingRuntime,
        groupId,
        partId: preparedPart.zonePart.id ?? `part-${index + 1}`,
        partIndex: index,
        partCount,
        geometryType: preparedPart.zonePart?.geometry?.type ?? "template"
      })
    };
  });

  return {
    groupId,
    parts
  };
}

function buildManagedRegionGroupId(templateDocument, existingRegions = []) {
  const existingGroupId = existingRegions
    .map((regionDocument) => getRegionRuntimeFlags(regionDocument)?.groupId ?? null)
    .find(Boolean);

  if (existingGroupId) {
    return existingGroupId;
  }

  return [
    MODULE_ID,
    templateDocument?.uuid ?? templateDocument?.id ?? "template",
    "group"
  ].join(":");
}

function buildPartRuntimeDefinition(normalizedDefinition, zonePart, {
  groupId,
  partIndex,
  partCount
}) {
  return {
    ...duplicateData(normalizedDefinition),
    label: zonePart?.label ?? normalizedDefinition?.label ?? "Persistent Zone",
    geometry: duplicateData(zonePart?.geometry ?? { type: "template" }),
    targeting: duplicateData(zonePart?.targeting ?? normalizedDefinition?.targeting ?? {}),
    terrain: duplicateData(zonePart?.terrain ?? normalizedDefinition?.terrain ?? {}),
    linkedWalls: duplicateData(zonePart?.linkedWalls ?? normalizedDefinition?.linkedWalls ?? {}),
    linkedLight: duplicateData(zonePart?.linkedLight ?? normalizedDefinition?.linkedLight ?? {}),
    triggers: duplicateData(zonePart?.triggers ?? normalizedDefinition?.triggers ?? {}),
    parts: [duplicateData(zonePart)],
    group: {
      id: groupId,
      mode: partCount > 1 ? "parts" : "single",
      partCount,
      partIndex: partIndex + 1
    },
    part: {
      id: zonePart?.id ?? `part-${partIndex + 1}`,
      label: zonePart?.label ?? normalizedDefinition?.label ?? "Persistent Zone",
      geometryType: zonePart?.geometry?.type ?? "template"
    }
  };
}

function resolveExistingRuntimeForPart(existingRegions, partId) {
  if (!Array.isArray(existingRegions) || !existingRegions.length) {
    return null;
  }

  if (partId) {
    const matchingRuntime = existingRegions
      .map((regionDocument) => getRegionRuntimeFlags(regionDocument))
      .find((runtime) => runtime?.partId === partId);

    if (matchingRuntime) {
      return matchingRuntime;
    }
  }

  return getRegionRuntimeFlags(existingRegions[0]) ?? null;
}

async function buildRegionShapesForZonePart(templateDocument, zonePart) {
  const geometryType = String(zonePart?.geometry?.type ?? "template").toLowerCase();

  switch (geometryType) {
    case "side-of-line":
      return await buildSideOfLineShapesFromGeometry(templateDocument, zonePart?.geometry ?? {});
    case "ring":
      return buildRingShapesFromGeometry(templateDocument, zonePart?.geometry ?? {});
    case "template":
    default:
      return buildRegionShapesFromTemplate(templateDocument);
  }
}

function buildRingShapesFromGeometry(templateDocument, geometry) {
  const outerRadius = distanceToPixels(
    geometry?.outerRadius ?? templateDocument?.distance ?? 0,
    templateDocument?.parent ?? null
  );
  const innerRadius = distanceToPixels(
    geometry?.innerRadius ?? 0,
    templateDocument?.parent ?? null
  );
  const segmentCount = Math.min(
    Math.max(Math.round(coerceNumber(geometry?.segments, DEFAULT_RING_SEGMENTS)), 8),
    64
  );
  const centerX = coerceNumber(templateDocument?.x, 0);
  const centerY = coerceNumber(templateDocument?.y, 0);

  if (!outerRadius || outerRadius <= 0 || innerRadius < 0 || innerRadius >= outerRadius) {
    debug("Rejected Region shape build for unsupported ring geometry.", {
      templateId: templateDocument?.id ?? null,
      templateType: getTemplateType(templateDocument),
      builder: "ring-annulus",
      details: {
        innerRadius,
        outerRadius,
        segmentCount
      }
    });
    return [];
  }

  const shapes = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const startAngle = (index / segmentCount) * Math.PI * 2;
    const endAngle = ((index + 1) / segmentCount) * Math.PI * 2;

    shapes.push({
      type: "polygon",
      points: [
        centerX + Math.cos(startAngle) * outerRadius,
        centerY + Math.sin(startAngle) * outerRadius,
        centerX + Math.cos(endAngle) * outerRadius,
        centerY + Math.sin(endAngle) * outerRadius,
        centerX + Math.cos(endAngle) * innerRadius,
        centerY + Math.sin(endAngle) * innerRadius,
        centerX + Math.cos(startAngle) * innerRadius,
        centerY + Math.sin(startAngle) * innerRadius
      ]
    });
  }

  debug("Using Region shape builder.", {
    templateId: templateDocument?.id ?? null,
    templateType: getTemplateType(templateDocument),
    builder: "ring-annulus",
    details: {
      centerX,
      centerY,
      innerRadius,
      outerRadius,
      segmentCount
    }
  });

  return shapes;
}

async function buildSideOfLineShapesFromGeometry(templateDocument, geometry) {
  const templateType = getTemplateType(templateDocument);
  const direction = coerceNumber(templateDocument?.direction, 0);
  const axisLength = distanceToPixels(
    geometry?.axisLength ?? templateDocument?.distance ?? 0,
    templateDocument?.parent ?? null
  );
  const offsetStart = distanceToPixels(
    geometry?.offsetStart ?? 0,
    templateDocument?.parent ?? null
  );
  const offsetEnd = distanceToPixels(
    geometry?.offsetEnd ?? geometry?.sideDistance ?? 0,
    templateDocument?.parent ?? null
  );
  const startX = coerceNumber(templateDocument?.x, 0);
  const startY = coerceNumber(templateDocument?.y, 0);
  const radians = degreesToRadians(direction);
  const unitX = Math.cos(radians);
  const unitY = Math.sin(radians);
  const side = String(geometry?.side ?? "left").toLowerCase() === "right" ? "right" : "left";
  const offsetReference = String(geometry?.offsetReference ?? "axis").toLowerCase() === "body-edge"
    ? "body-edge"
    : "axis";
  const sideMultiplier = side === "right" ? -1 : 1;
  const normalX = unitY * sideMultiplier;
  const normalY = -unitX * sideMultiplier;
  const endX = startX + unitX * axisLength;
  const endY = startY + unitY * axisLength;
  const bodyEdge = offsetReference === "body-edge"
    ? await measureTemplateBodyEdgeDistance(templateDocument, {
      originX: startX,
      originY: startY,
      normalX,
      normalY
    })
    : 0;
  const bandStart = bodyEdge + offsetStart;
  const bandEnd = bodyEdge + offsetEnd;
  const startOffsetX = normalX * bandStart;
  const startOffsetY = normalY * bandStart;
  const endOffsetX = normalX * bandEnd;
  const endOffsetY = normalY * bandEnd;

  if (!["ray", "rect"].includes(templateType) || axisLength <= 0 || offsetStart < 0 || offsetEnd <= offsetStart) {
    debug("Rejected Region shape build for unsupported side-of-line geometry.", {
      templateId: templateDocument?.id ?? null,
      templateType,
      builder: "side-of-line-template-axis",
      details: {
        direction,
        side,
        offsetReference,
        bodyEdge,
        axisLength,
        offsetStart,
        offsetEnd,
        bandStart,
        bandEnd
      }
    });
    return [];
  }

  const finalShape = {
    type: "polygon",
    points: [
      startX + startOffsetX,
      startY + startOffsetY,
      endX + startOffsetX,
      endY + startOffsetY,
      endX + endOffsetX,
      endY + endOffsetY,
      startX + endOffsetX,
      startY + endOffsetY
    ]
  };

  debug("Using Region shape builder.", {
    templateId: templateDocument?.id ?? null,
    templateType,
    builder: "side-of-line-template-axis",
    details: {
      startX,
      startY,
      endX,
      endY,
      direction,
      side,
      offsetReference,
      bodyEdge,
      axisLength,
      offsetStart,
      offsetEnd,
      generatedBandBounds: {
        bandStart,
        bandEnd
      },
      axisMode: geometry?.axisMode ?? "template"
    }
  });

  return [finalShape];
}

async function measureTemplateBodyEdgeDistance(templateDocument, {
  originX,
  originY,
  normalX,
  normalY
}) {
  const bodyShapes = await buildRegionShapesFromTemplate(templateDocument);
  if (!Array.isArray(bodyShapes) || !bodyShapes.length) {
    return 0;
  }

  let maxDistance = 0;

  for (const shape of bodyShapes) {
    maxDistance = Math.max(
      maxDistance,
      measureShapePositiveOffset(shape, {
        originX,
        originY,
        normalX,
        normalY
      })
    );
  }

  return maxDistance;
}

function measureShapePositiveOffset(shape, {
  originX,
  originY,
  normalX,
  normalY
}) {
  if (!shape || typeof shape !== "object") {
    return 0;
  }

  if (shape.type === "circle") {
    const centerOffset = projectPointOntoNormal({
      pointX: coerceNumber(shape.x, 0),
      pointY: coerceNumber(shape.y, 0),
      originX,
      originY,
      normalX,
      normalY
    });
    return Math.max(0, centerOffset + coerceNumber(shape.radius, 0));
  }

  const points = collectShapePoints(shape);
  if (!points.length) {
    return 0;
  }

  return Math.max(
    0,
    ...points.map(([pointX, pointY]) => projectPointOntoNormal({
      pointX,
      pointY,
      originX,
      originY,
      normalX,
      normalY
    }))
  );
}

function collectShapePoints(shape) {
  if (shape?.type === "polygon" && Array.isArray(shape.points)) {
    return flatPointsToPairs(shape.points);
  }

  if (shape?.type === "rectangle") {
    const x = coerceNumber(shape.x, 0);
    const y = coerceNumber(shape.y, 0);
    const width = coerceNumber(shape.width, 0);
    const height = coerceNumber(shape.height, 0);

    return [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height]
    ];
  }

  return [];
}

function flatPointsToPairs(points) {
  const pairs = [];

  for (let index = 0; index < points.length - 1; index += 2) {
    pairs.push([
      coerceNumber(points[index], 0),
      coerceNumber(points[index + 1], 0)
    ]);
  }

  return pairs;
}

function projectPointOntoNormal({
  pointX,
  pointY,
  originX,
  originY,
  normalX,
  normalY
}) {
  return ((pointX - originX) * normalX) + ((pointY - originY) * normalY);
}

async function deleteManagedRegionGroup(regionDocuments, {
  reason = "manual-group-cleanup"
} = {}) {
  const documents = Array.isArray(regionDocuments)
    ? regionDocuments.filter(Boolean)
    : regionDocuments
      ? [regionDocuments]
      : [];
  if (!documents.length) {
    return [];
  }

  const scene = documents[0]?.parent ?? null;
  if (!scene) {
    return [];
  }

  const regionIds = documents
    .map((regionDocument) => regionDocument?.id ?? null)
    .filter((regionId) => regionId && scene?.regions?.get?.(regionId));

  if (!regionIds.length) {
    return [];
  }

  for (const regionDocument of documents) {
    if (!regionDocument || !scene?.regions?.get?.(regionDocument.id)) {
      continue;
    }

    await cleanupLinkedDocumentsForRegion(regionDocument, {
      reason,
      skipRuntimeUpdate: true
    });
  }

  await scene.deleteEmbeddedDocuments("Region", regionIds);

  debug("Cleaned managed Region group.", {
    sceneId: scene?.id ?? null,
    regionGroupId: getRegionRuntimeFlags(documents[0])?.groupId ?? null,
    regionIds,
    reason
  });

  return regionIds;
}

async function resolveDocumentFromRuntimeUuid(uuid, documentName) {
  const resolved = await fromUuidSafe(uuid);
  return resolved?.documentName === documentName ? resolved : null;
}

function buildNativeRegionBehaviors({
  normalizedDefinition,
  sourceContext
}) {
  const terrain = normalizedDefinition?.terrain ?? {};
  if (!terrain.difficult) {
    debug("No native Region movement-cost behavior requested by normalized definition.", {
      label: normalizedDefinition?.label ?? null,
      terrain
    });
    return [];
  }

  const multiplier = coerceNumber(terrain.multiplier, STANDARD_DIFFICULT_TERRAIN_MULTIPLIER);
  const behaviorType = terrain.behaviorType ?? NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE;
  if (!CONFIG?.RegionBehavior?.dataModels?.[behaviorType]) {
    debug("Skipped native Region behavior because the behavior type is unavailable.", {
      label: normalizedDefinition?.label ?? null,
      behaviorType
    });
    return [];
  }

  const behaviorData = {
    name: buildTerrainBehaviorName(normalizedDefinition, sourceContext),
    type: behaviorType,
    system: {
      magical: Boolean(terrain.system?.magical),
      types: Array.from(terrain.system?.types ?? []),
      ignoredDispositions: Array.from(terrain.system?.ignoredDispositions ?? [])
    },
    flags: {
      [MODULE_ID]: {
        nativeBehavior: {
          kind: "difficult-terrain",
          multiplier
        }
      }
    }
  };

  debug("Prepared native Region behavior for movement cost.", {
    label: normalizedDefinition?.label ?? null,
    behaviorType,
    multiplier,
    system: behaviorData.system
  });

  return [behaviorData];
}

async function buildRegionShapesFromTemplate(templateDocument) {
  const renderedResult = await buildShapesFromRenderedTemplate(templateDocument);
  if (renderedResult.shapes.length) {
    debug("Using Region shape builder.", {
      templateId: templateDocument?.id ?? null,
      templateType: getTemplateType(templateDocument),
      builder: renderedResult.builder,
      details: renderedResult.details
    });
    return renderedResult.shapes;
  }

  const templateType = getTemplateType(templateDocument);

  switch (templateType) {
    case "circle":
      return logBuiltShapes(templateDocument, "document-circle", [buildCircleShapeFromDocument(templateDocument)]);
    case "rect":
      debug("Falling back to document rect builder because rendered template geometry was unavailable.", {
        templateId: templateDocument?.id ?? null,
        templateType,
        renderedBuilder: renderedResult.builder,
        renderedReason: renderedResult.reason ?? null
      });
      return buildRectShapesFromDocument(templateDocument);
    case "ray":
      return logBuiltShapes(templateDocument, "document-ray", [buildRayShapeFromDocument(templateDocument)]);
    default:
      debug("Rejected Region shape build for unsupported template type.", {
        templateId: templateDocument?.id ?? null,
        templateType,
        renderedBuilder: renderedResult.builder,
        renderedReason: renderedResult.reason ?? null
      });
      return [];
  }
}

async function buildShapesFromRenderedTemplate(templateDocument) {
  const templateType = getTemplateType(templateDocument);
  const placeable = await resolveTemplatePlaceable(templateDocument);
  const renderedShape = placeable?.shape ?? null;

  if (!renderedShape) {
    return {
      shapes: [],
      builder: "rendered-shape",
      reason: "No rendered shape was available on the template placeable."
    };
  }

  if (hasFlatPoints(renderedShape.points)) {
    const points = trimClosingPolygonPoint(
      translateFlatPoints(renderedShape.points, templateDocument.x ?? 0, templateDocument.y ?? 0)
    );
    const shape = {
      type: "polygon",
      points
    };
    if (templateType === "rect") {
      logRectShapeDecision(templateDocument, {
        builder: "rendered-polygon",
        accepted: true,
        anchor: "rendered-shape-relative-origin",
        finalShape: shape
      });
    }
    return {
      shapes: [shape],
      builder: "rendered-polygon",
      details: {
        points: points.length / 2
      }
    };
  }

  if (hasPixiCircleShape(renderedShape)) {
    return {
      shapes: [{
        type: "circle",
        x: (templateDocument.x ?? 0) + (renderedShape.x ?? 0),
        y: (templateDocument.y ?? 0) + (renderedShape.y ?? 0),
        radius: renderedShape.radius
      }],
      builder: "rendered-circle",
      details: {
        x: (templateDocument.x ?? 0) + (renderedShape.x ?? 0),
        y: (templateDocument.y ?? 0) + (renderedShape.y ?? 0),
        radius: renderedShape.radius
      }
    };
  }

  if (hasPixiRectangleShape(renderedShape)) {
    const shape = {
      type: "rectangle",
      x: (templateDocument.x ?? 0) + (renderedShape.x ?? 0),
      y: (templateDocument.y ?? 0) + (renderedShape.y ?? 0),
      width: renderedShape.width,
      height: renderedShape.height,
      rotation: 0
    };
    if (templateType === "rect") {
      logRectShapeDecision(templateDocument, {
        builder: "rendered-rectangle",
        accepted: true,
        anchor: "rendered-rectangle-top-left",
        finalShape: shape
      });
    }
    return {
      shapes: [shape],
      builder: "rendered-rectangle",
      details: {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height
      }
    };
  }

  return {
    shapes: [],
    builder: "rendered-shape",
    reason: "Rendered shape existed but did not match a supported conversion path."
  };
}

async function resolveTemplatePlaceable(templateDocument) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const placeable =
      templateDocument?.object ??
      canvas?.templates?.get?.(templateDocument?.id) ??
      canvas?.templates?.placeables?.find((candidate) => candidate.document?.id === templateDocument?.id) ??
      null;

    if (placeable?.shape) {
      return placeable;
    }

    await wait(15);
  }

  return null;
}

function buildCircleShapeFromDocument(templateDocument) {
  return {
    type: "circle",
    x: templateDocument.x ?? 0,
    y: templateDocument.y ?? 0,
    radius: distanceToPixels(templateDocument.distance, templateDocument.parent)
  };
}

function buildRayShapeFromDocument(templateDocument) {
  const length = distanceToPixels(templateDocument.distance, templateDocument.parent);
  const width = distanceToPixels(templateDocument.width || 5, templateDocument.parent);

  return {
    type: "rectangle",
    x: templateDocument.x ?? 0,
    y: (templateDocument.y ?? 0) - width / 2,
    width: length,
    height: width,
    rotation: coerceNumber(templateDocument.direction, 0)
  };
}

function buildRectShapesFromDocument(templateDocument) {
  const rectShape = getFoundryRectShape(templateDocument);
  if (rectShape) {
    const finalShape = normalizeRectangleShape({
      type: "rectangle",
      x: (templateDocument.x ?? 0) + rectShape.x,
      y: (templateDocument.y ?? 0) + rectShape.y,
      width: rectShape.width,
      height: rectShape.height,
      rotation: 0
    });

    logRectShapeDecision(templateDocument, {
      builder: "document-rect-foundry",
      accepted: true,
      anchor: "template-origin-corner",
      finalShape
    });

    return logBuiltShapes(templateDocument, "document-rect-foundry", [finalShape], finalShape);
  }

  const diagonalPixels = distanceToPixels(templateDocument.distance, templateDocument.parent);
  const size = diagonalPixels > 0 ? diagonalPixels / Math.SQRT2 : 0;

  if (!size || size <= 0) {
    logRectShapeDecision(templateDocument, {
      builder: "document-rect-fallback",
      accepted: false,
      anchor: "template-origin-corner",
      reason: "Template distance did not produce a positive square size.",
      finalShape: null
    });
    return [];
  }

  const finalShape = {
    type: "rectangle",
    x: coerceNumber(templateDocument.x, 0),
    y: coerceNumber(templateDocument.y, 0),
    width: size,
    height: size,
    rotation: 0
  };

  logRectShapeDecision(templateDocument, {
    builder: "document-rect-fallback",
    accepted: true,
    anchor: "template-origin-corner",
    finalShape
  });

  return logBuiltShapes(templateDocument, "document-rect-fallback", [finalShape], finalShape);
}

function hasPixiCircleShape(shape) {
  return shape && typeof shape.radius === "number" && typeof shape.x === "number" && typeof shape.y === "number";
}

function hasPixiRectangleShape(shape) {
  return (
    shape &&
    typeof shape.width === "number" &&
    typeof shape.height === "number" &&
    typeof shape.x === "number" &&
    typeof shape.y === "number" &&
    !Array.isArray(shape.points) &&
    typeof shape.radius !== "number"
  );
}

function hasFlatPoints(points) {
  return (Array.isArray(points) || ArrayBuffer.isView(points)) && Number(points.length) >= 6;
}

function logBuiltShapes(templateDocument, builder, shapes, details = undefined) {
  debug("Using Region shape builder.", {
    templateId: templateDocument?.id ?? null,
    templateType: getTemplateType(templateDocument),
    builder,
    details
  });

  return shapes;
}

function buildRegionName(normalizedDefinition, sourceContext) {
  const itemName = sourceContext.item?.name ?? normalizedDefinition.label ?? "Persistent Zone";
  const casterName = sourceContext.caster?.name ?? sourceContext.actor?.name ?? null;
  const baseName = casterName ? `${itemName}(${casterName})` : itemName;
  const partId = normalizedDefinition?.part?.id ?? null;
  const partCount = coerceNumber(normalizedDefinition?.group?.partCount, 1);

  if (partId && partCount > 1) {
    return `${baseName} [${partId}]`;
  }

  return baseName;
}

function buildTerrainBehaviorName(normalizedDefinition, sourceContext) {
  const regionName = buildRegionName(normalizedDefinition, sourceContext);
  return `${regionName} Difficult Terrain`;
}

async function syncLinkedDocumentsSafely({
  templateDocument,
  regionDocument,
  normalizedDefinition = null,
  shapes = null,
  stage = "sync-region"
} = {}) {
  try {
    return await syncLinkedDocumentsForRegion({
      templateDocument,
      regionDocument,
      normalizedDefinition,
      shapes
    });
  } catch (caughtError) {
    error("Failed to sync linked documents for managed Region.", caughtError, {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      stage
    });
    return {
      wallIds: [],
      lightIds: [],
      syncApplied: false
    };
  }
}

function duplicateLinkedDocuments(linkedDocuments) {
  const wallIds = Array.isArray(linkedDocuments?.wallIds)
    ? Array.from(new Set(linkedDocuments.wallIds.filter(Boolean)))
    : [];
  const lightIds = Array.isArray(linkedDocuments?.lightIds)
    ? Array.from(new Set(linkedDocuments.lightIds.filter(Boolean)))
    : [];

  return { wallIds, lightIds };
}

function collectRelevantTemplateUpdateKeys(changed) {
  const flattened = flattenObject(changed);
  const relevantPrefixes = ["x", "y", "distance", "direction", "angle", "width", "t", "elevation"];

  return Object.keys(flattened).filter((key) =>
    relevantPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))
  );
}

function buildTemplateSyncKey(templateDocument) {
  return `${templateDocument?.parent?.id ?? "scene"}::${templateDocument?.id ?? "template"}`;
}

function flattenObject(value, prefix = "", result = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) {
      result[prefix] = value;
    }
    return result;
  }

  const entries = Object.entries(value);
  if (!entries.length && prefix) {
    result[prefix] = value;
    return result;
  }

  for (const [key, nestedValue] of entries) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (nestedValue && typeof nestedValue === "object" && !Array.isArray(nestedValue)) {
      flattenObject(nestedValue, nextPrefix, result);
    } else {
      result[nextPrefix] = nestedValue;
    }
  }

  return result;
}

function getFoundryRectShape(templateDocument) {
  const objectClass =
    CONFIG?.MeasuredTemplate?.objectClass ??
    canvas?.templates?.constructor?.placeableClass ??
    null;

  if (typeof objectClass?.getRectShape !== "function") {
    return null;
  }

  try {
    return objectClass.getRectShape(
      coerceNumber(templateDocument.distance, 0),
      coerceNumber(templateDocument.direction, 0)
    );
  } catch (caughtError) {
    debug("Foundry rect shape helper failed.", {
      templateId: templateDocument?.id ?? null,
      error: caughtError?.message ?? "unknown"
    });
    return null;
  }
}

function normalizeRectangleShape(shape) {
  const x = coerceNumber(shape.x, 0);
  const y = coerceNumber(shape.y, 0);
  const width = coerceNumber(shape.width, 0);
  const height = coerceNumber(shape.height, 0);

  return {
    type: "rectangle",
    x: width >= 0 ? x : x + width,
    y: height >= 0 ? y : y + height,
    width: Math.abs(width),
    height: Math.abs(height),
    rotation: coerceNumber(shape.rotation, 0)
  };
}

function degreesToRadians(value) {
  return (coerceNumber(value, 0) * Math.PI) / 180;
}

function logRectShapeDecision(templateDocument, {
  builder,
  accepted,
  anchor,
  finalShape,
  reason = null
}) {
  debug(accepted ? "Accepted Region rect builder." : "Rejected Region rect builder.", {
    templateId: templateDocument?.id ?? null,
    templateType: getTemplateType(templateDocument),
    builder,
    template: {
      x: templateDocument?.x ?? null,
      y: templateDocument?.y ?? null,
      distance: templateDocument?.distance ?? null,
      direction: templateDocument?.direction ?? null,
      angle: templateDocument?.angle ?? null
    },
    anchor,
    finalShape,
    reason
  });
}
