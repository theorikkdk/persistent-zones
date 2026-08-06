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

export async function syncLinkedDocumentsForRegion({
  templateDocument,
  regionDocument,
  normalizedDefinition = null,
  shapes = null
} = {}) {
  const scene = regionDocument?.parent ?? templateDocument?.parent ?? null;
  if (!scene || !regionDocument) {
    return { wallIds: [], lightIds: [], syncApplied: false };
  }

  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const activeDefinition = normalizedDefinition ?? runtime.normalizedDefinition ?? null;
  const linkedDocuments = duplicateData(runtime.linkedDocuments) ?? { wallIds: [], lightIds: [] };
  const shapeData = getFinalRegionShapeData(regionDocument, shapes);
  const geometrySummary = summarizeLinkedGeometrySource({ scene, regionDocument, shapes: shapeData });
  for (const row of geometrySummary) {
    console.warn(`[${MODULE_ID}][linked] PZ LINKED GEOMETRY SOURCE`, row);
  }

  const wallResult = await syncLinkedWalls({
    scene,
    templateDocument,
    regionDocument,
    linkedWalls: activeDefinition?.linkedWalls ?? {},
    shapes: shapeData,
    existingIds: linkedDocuments.wallIds ?? [],
    itemUuid: runtime.itemUuid ?? activeDefinition?.itemUuid ?? null
  });

  const lightResult = await syncLinkedLight({
    scene,
    templateDocument,
    regionDocument,
    linkedLight: activeDefinition?.linkedLight ?? {},
    shapes: shapeData,
    existingIds: linkedDocuments.lightIds ?? [],
    templateDistance: activeDefinition?.template?.distance ?? templateDocument?.distance ?? null,
    itemUuid: runtime.itemUuid ?? activeDefinition?.itemUuid ?? null
  });

  const wallIds = wallResult.ids ?? [];
  const lightIds = lightResult.ids ?? [];
  const nextLinkedDocuments = { wallIds, lightIds };
  await updateRegionLinkedDocuments(regionDocument, nextLinkedDocuments);
  console.warn(`[${MODULE_ID}][linked] PZ LINKED DOCUMENT SYNC RESULT`, {
    reason: "syncLinkedDocumentsForRegion",
    regionId: regionDocument?.id ?? null,
    groupId: runtime.groupId ?? null,
    shapeType: geometrySummary.map((row) => row.shapeType).filter(Boolean).join(",") || null,
    existingWallCount: wallResult.existingCount ?? 0,
    createdWallIds: wallResult.createdIds ?? [],
    updatedWallIds: wallResult.updatedIds ?? [],
    deletedWallIds: wallResult.deletedIds ?? [],
    existingLightCount: lightResult.existingCount ?? 0,
    createdLightIds: lightResult.createdIds ?? [],
    updatedLightIds: lightResult.updatedIds ?? [],
    deletedLightIds: lightResult.deletedIds ?? [],
    geometryChanged: Boolean(wallResult.geometryChanged || lightResult.geometryChanged),
    positionChanged: Boolean(wallResult.positionChanged || lightResult.positionChanged),
    elevationChanged: Boolean(wallResult.elevationChanged || lightResult.elevationChanged),
    syncSucceeded: true,
    syncErrors: []
  });

  debug("linkedDocsSync", {
    templateId: templateDocument?.id ?? runtime.templateId ?? null,
    regionId: regionDocument?.id ?? null,
    wallIds,
    lightIds,
    syncApplied: true
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
  console.warn(`[${MODULE_ID}][lifecycle] PZ LINKED DOCUMENT CLEANUP RESULT`, {
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

  if (!linkedWalls?.enabled) {
    return deleteLinkedWallDocuments(scene, regionDocument, templateDocument, existingWalls, "disabled");
  }

  const desiredWalls = buildLinkedWallData({
    templateDocument,
    regionDocument,
    linkedWalls,
    shapes,
    itemUuid
  });

  if (!desiredWalls.length) {
    return deleteLinkedWallDocuments(scene, regionDocument, templateDocument, existingWalls, "unsupported-shape");
  }

  const existingUsesWallHeight = existingWalls.some((wallDocument) => wallDocument?.flags?.["wall-height"] !== undefined);
  const desiredUsesWallHeight = desiredWalls.some((wallData) => wallData?.flags?.["wall-height"] !== undefined);
  const wallHeightModeChanged = existingUsesWallHeight !== desiredUsesWallHeight;
  const orderedExisting = orderLinkedDocumentsForDesired(existingWalls, "wall");

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
      deletedIds: [],
      geometryChanged: true,
      positionChanged: true,
      elevationChanged: false
    };
  }

  const reusableCount = wallHeightModeChanged ? 0 : Math.min(orderedExisting.length, desiredWalls.length);
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
  const deletedIds = excessWalls.map((document) => document.id).filter(Boolean);
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

  if (!linkedLight?.enabled) {
    return deleteLinkedLightDocuments(scene, regionDocument, templateDocument, existingLights, "disabled");
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
    return deleteLinkedLightDocuments(scene, regionDocument, templateDocument, existingLights, "unsupported-shape");
  }

  const orderedExisting = orderLinkedDocumentsForDesired(existingLights, "light");
  if (orderedExisting.length === desiredLights.length && orderedExisting.length) {
    const updates = orderedExisting.map((lightDocument, index) => ({
      _id: lightDocument.id,
      ...desiredLights[index]
    }));
    const updated = await scene.updateEmbeddedDocuments("AmbientLight", updates, { persistentZonesLinkedSync: true });
    const linkedDocumentIds = orderedExisting.map((document) => document.id);

    debug("Linked light document updated.", {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      linkedDocumentIds,
      syncApplied: true
    });

    return {
      ids: linkedDocumentIds,
      existingCount: existingLights.length,
      createdIds: [],
      updatedIds: Array.from(updated ?? []).map((document) => document?.id ?? null).filter(Boolean),
      deletedIds: [],
      geometryChanged: true,
      positionChanged: true,
      elevationChanged: updates.some((update) => update.elevation !== undefined)
    };
  }

  const reusableCount = Math.min(orderedExisting.length, desiredLights.length);
  const updatedIds = [];
  if (reusableCount) {
    const updates = orderedExisting.slice(0, reusableCount).map((lightDocument, index) => ({
      _id: lightDocument.id,
      ...desiredLights[index]
    }));
    const updated = await scene.updateEmbeddedDocuments("AmbientLight", updates, { persistentZonesLinkedSync: true });
    updatedIds.push(...Array.from(updated ?? []).map((document) => document?.id ?? null).filter(Boolean));
  }

  const excessLights = orderedExisting.slice(reusableCount);
  const deletedIds = excessLights.map((document) => document.id).filter(Boolean);
  if (deletedIds.length) {
    await scene.deleteEmbeddedDocuments("AmbientLight", deletedIds, { persistentZonesLinkedSync: true }).catch(() => []);
    debug("Linked light documents deleted.", {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      linkedDocumentIds: deletedIds,
      reason: "recreate",
      syncApplied: true
    });
  }

  const lightsToCreate = desiredLights.slice(reusableCount);
  const created = lightsToCreate.length
    ? await scene.createEmbeddedDocuments("AmbientLight", lightsToCreate, { persistentZonesLinkedSync: true })
    : [];
  const linkedDocumentIds = (Array.isArray(created) ? created : [])
    .map((document) => document?.id ?? null)
    .filter(Boolean);
  const finalIds = [
    ...orderedExisting.slice(0, reusableCount).map((document) => document.id).filter(Boolean),
    ...linkedDocumentIds
  ];

  debug("Linked light document created.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentIds,
    syncApplied: linkedDocumentIds.length > 0
  });

  return {
    ids: finalIds,
    existingCount: existingLights.length,
    createdIds: linkedDocumentIds,
    updatedIds,
    deletedIds,
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
  const segments = buildWallSegmentsFromShapes(shapes, {
    circleSegments: normalizeLinkedWallSegments(linkedWalls?.segments)
  });
  if (!segments.length) {
    return [];
  }

  const move = resolveWallMovementValue(linkedWalls?.move, linkedWalls?.mode ?? linkedWalls?.wallMode);
  const sight = resolveWallSenseValue(linkedWalls?.sight, linkedWalls?.mode ?? linkedWalls?.wallMode);
  const light = resolveWallSenseValue(linkedWalls?.light, linkedWalls?.mode ?? linkedWalls?.wallMode);
  const sound = resolveWallSenseValue(linkedWalls?.sound, "none");
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
  console.warn(`[${MODULE_ID}][linked] PZ LINKED WALL GEOMETRY PLAN`, geometryPlan);

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
      dir: 0,
      door: 0,
      ds: 0,
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
    return [];
  }

  debug("Prepared linked light config.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentKind: "light",
    linkedLightBright: bright,
    linkedLightDim: dim,
    linkedLightLuminosity: coerceNumber(linkedLight?.luminosity, DEFAULT_LINKED_LIGHT_LUMINOSITY)
  });
  console.warn(`[${MODULE_ID}][linked] PZ LINKED LIGHT LAYOUT PLAN`, layout.logData);

  return layout.positions.map((position, index) => ({
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
      layoutAngle: position.angle ?? null
    })
  }));
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

  for (const id of Array.from(existingIds ?? [])) {
    const document = collection?.get?.(id);
    if (document) {
      existing.set(document.id, document);
    }
  }

  for (const document of collection?.contents ?? []) {
    const pzFlags = document?.flags?.[MODULE_ID] ?? {};
    const linkedFlag = pzFlags.linkedDocument ?? null;
    const documentKind = pzFlags.linkedDocumentType ?? linkedFlag?.kind ?? null;
    if (documentKind !== kind) {
      continue;
    }

    if (
      pzFlags.regionId === regionDocument?.id ||
      pzFlags.regionUuid === regionDocument?.uuid ||
      linkedFlag?.regionId === regionDocument?.id ||
      linkedFlag?.regionUuid === regionDocument?.uuid
    ) {
      existing.set(document.id, document);
    }
  }

  return Array.from(existing.values());
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
        layoutAngle
      }
    }
  };
}

function buildWallSegmentsFromShapes(shapes, {
  circleSegments = DEFAULT_LINKED_WALL_SEGMENTS
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
    wallPresetId: linkedWalls?.presetId ?? linkedWalls?.id ?? null,
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

function findLinkedLightCenter(shapes, templateDocument) {
  const shapeList = Array.from(shapes ?? []);
  if (!shapeList.length) {
    return findTemplateCenter(templateDocument);
  }

  if (shapeList.length === 1) {
    return findShapeCenter(shapeList[0]) ?? findTemplateCenter(templateDocument);
  }

  const shapeCenters = shapeList
    .map((shape) => findShapeCenter(shape))
    .filter(Boolean);

  if (!shapeCenters.length) {
    return findTemplateCenter(templateDocument);
  }

  return {
    x: shapeCenters.reduce((sum, point) => sum + point.x, 0) / shapeCenters.length,
    y: shapeCenters.reduce((sum, point) => sum + point.y, 0) / shapeCenters.length
  };
}

function buildLinkedLightLayout({
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

  if (ring && ring.innerRadius > 0 && ring.outerRadius > ring.innerRadius) {
    const lightPathRadius = (ring.innerRadius + ring.outerRadius) / 2;
    const circumference = Math.PI * 2 * lightPathRadius;
    const safetyCap = Math.max(3, Math.min(24, Math.round(coerceNumber(linkedLight?.maxCount, 16))));
    const requestedLightCount = Math.max(3, Math.ceil(circumference / Math.max(effectiveCoverageRadius * 1.5, gridSize)));
    const finalLightCount = Math.min(requestedLightCount, safetyCap);
    const safetyCapApplied = finalLightCount < requestedLightCount;
    const positions = [];
    for (let index = 0; index < finalLightCount; index += 1) {
      const angle = (index / finalLightCount) * Math.PI * 2;
      const x = ring.centerX + Math.cos(angle) * lightPathRadius;
      const y = ring.centerY + Math.sin(angle) * lightPathRadius;
      positions.push({ x, y, angle });
    }
    const everyLightInsideRegion = positions.every((position) => isPointInsideRingBand(position, ring));
    return {
      layoutType: "ring-path",
      positions,
      logData: {
        regionId: regionDocument?.id ?? null,
        groupId: getRegionRuntimeFlags(regionDocument)?.groupId ?? null,
        shapeType: "ring",
        centerX: ring.centerX,
        centerY: ring.centerY,
        innerRadius: ring.innerRadius,
        outerRadius: ring.outerRadius,
        lightPathRadius,
        configuredBright,
        configuredDim,
        effectiveCoverageRadius,
        circumference,
        requestedLightCount,
        finalLightCount,
        safetyCapApplied,
        lightPositions: positions.map((position) => ({
          x: Math.round(position.x * 100) / 100,
          y: Math.round(position.y * 100) / 100,
          angle: Math.round(position.angle * 1000) / 1000
        })),
        everyLightInsideRegion
      }
    };
  }

  const center = findLinkedLightCenter(shapes, templateDocument);
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

function isPointInsideRingBand(point, ring) {
  const dx = coerceNumber(point?.x, 0) - ring.centerX;
  const dy = coerceNumber(point?.y, 0) - ring.centerY;
  const distance = Math.hypot(dx, dy);
  return distance >= ring.innerRadius && distance <= ring.outerRadius;
}

function resolveLinkedLightElevation(regionDocument, linkedLight = {}) {
  const explicit = coerceNumber(linkedLight?.elevation, null);
  if (explicit !== null) {
    return explicit;
  }
  return coerceNumber(regionDocument?.elevation ?? regionDocument?.document?.elevation, null);
}

function findShapeCenter(shape) {
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
    case "rectangle":
      return findRectangleCenter(shape);
    case "polygon":
      return findPolygonCenter(shape.points);
    default:
      return null;
  }
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
      return CONST?.WALL_SENSE_TYPES?.LIMITED ?? 10;
    case "proximity":
      return CONST?.WALL_SENSE_TYPES?.PROXIMITY ?? CONST?.WALL_SENSE_TYPES?.NORMAL ?? 20;
    case "distance":
      return CONST?.WALL_SENSE_TYPES?.DISTANCE ?? CONST?.WALL_SENSE_TYPES?.NORMAL ?? 20;
    case "normal":
      return CONST?.WALL_SENSE_TYPES?.NORMAL ?? 20;
    case "none":
    default:
      return CONST?.WALL_SENSE_TYPES?.NONE ?? 0;
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
