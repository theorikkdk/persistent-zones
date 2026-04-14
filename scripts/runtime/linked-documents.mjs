import { MODULE_ID, RUNTIME_FLAG_KEY } from "../constants.mjs";
import {
  coerceBoolean,
  coerceNumber,
  debug,
  distanceToPixels,
  duplicateData,
  getRegionRuntimeFlags,
  getRegionShapeData,
  getTemplateType
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
  const shapeData = Array.isArray(shapes) && shapes.length
    ? duplicateData(shapes)
    : getRegionShapeData(regionDocument);

  const wallIds = await syncLinkedWalls({
    scene,
    templateDocument,
    regionDocument,
    linkedWalls: activeDefinition?.linkedWalls ?? {},
    shapes: shapeData,
    existingIds: linkedDocuments.wallIds ?? [],
    itemUuid: runtime.itemUuid ?? activeDefinition?.itemUuid ?? null
  });

  const lightIds = await syncLinkedLight({
    scene,
    templateDocument,
    regionDocument,
    linkedLight: activeDefinition?.linkedLight ?? {},
    shapes: shapeData,
    existingIds: linkedDocuments.lightIds ?? [],
    templateDistance: activeDefinition?.template?.distance ?? templateDocument?.distance ?? null,
    itemUuid: runtime.itemUuid ?? activeDefinition?.itemUuid ?? null
  });

  const nextLinkedDocuments = { wallIds, lightIds };
  await updateRegionLinkedDocuments(regionDocument, nextLinkedDocuments);

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

  if (existingWalls.length === desiredWalls.length && existingWalls.length) {
    const updates = existingWalls.map((wallDocument, index) => ({
      _id: wallDocument.id,
      ...desiredWalls[index]
    }));

    await scene.updateEmbeddedDocuments("Wall", updates);
    const linkedDocumentIds = existingWalls.map((document) => document.id);

    debug("Linked wall documents updated.", {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      linkedDocumentIds,
      syncApplied: true
    });

    return linkedDocumentIds;
  }

  if (existingWalls.length) {
    await scene.deleteEmbeddedDocuments("Wall", existingWalls.map((document) => document.id)).catch(() => []);
    debug("Linked wall documents deleted.", {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      linkedDocumentIds: existingWalls.map((document) => document.id),
      reason: "recreate",
      syncApplied: true
    });
  }

  const created = await scene.createEmbeddedDocuments("Wall", desiredWalls);
  const linkedDocumentIds = (Array.isArray(created) ? created : [])
    .map((document) => document?.id ?? null)
    .filter(Boolean);

  debug("Linked wall documents created.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentIds,
    syncApplied: linkedDocumentIds.length > 0
  });

  return linkedDocumentIds;
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

  const desiredLight = buildLinkedLightData({
    templateDocument,
    regionDocument,
    linkedLight,
    shapes,
    templateDistance,
    itemUuid
  });

  if (!desiredLight) {
    return deleteLinkedLightDocuments(scene, regionDocument, templateDocument, existingLights, "unsupported-shape");
  }

  if (existingLights.length === 1) {
    await scene.updateEmbeddedDocuments("AmbientLight", [{
      _id: existingLights[0].id,
      ...desiredLight
    }]);

    debug("Linked light document updated.", {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      linkedDocumentIds: [existingLights[0].id],
      syncApplied: true
    });

    return [existingLights[0].id];
  }

  if (existingLights.length) {
    await scene.deleteEmbeddedDocuments("AmbientLight", existingLights.map((document) => document.id)).catch(() => []);
    debug("Linked light documents deleted.", {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      linkedDocumentIds: existingLights.map((document) => document.id),
      reason: "recreate",
      syncApplied: true
    });
  }

  const created = await scene.createEmbeddedDocuments("AmbientLight", [desiredLight]);
  const linkedDocumentIds = (Array.isArray(created) ? created : [])
    .map((document) => document?.id ?? null)
    .filter(Boolean);

  debug("Linked light document created.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentIds,
    syncApplied: linkedDocumentIds.length > 0
  });

  return linkedDocumentIds;
}

async function deleteLinkedWallDocuments(scene, regionDocument, templateDocument, existingWalls, reason) {
  if (!existingWalls.length) {
    return [];
  }

  const linkedDocumentIds = existingWalls.map((document) => document.id);
  await scene.deleteEmbeddedDocuments("Wall", linkedDocumentIds).catch(() => []);

  debug("Linked wall documents deleted.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentIds,
    reason,
    syncApplied: true
  });

  return [];
}

async function deleteLinkedLightDocuments(scene, regionDocument, templateDocument, existingLights, reason) {
  if (!existingLights.length) {
    return [];
  }

  const linkedDocumentIds = existingLights.map((document) => document.id);
  await scene.deleteEmbeddedDocuments("AmbientLight", linkedDocumentIds).catch(() => []);

  debug("Linked light documents deleted.", {
    templateId: templateDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    linkedDocumentIds,
    reason,
    syncApplied: true
  });

  return [];
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

  return segments.map((c) => ({
    c,
    move,
    sight,
    light,
    sound,
    dir: 0,
    door: 0,
    ds: 0,
    flags: buildLinkedDocumentFlags({
      kind: "wall",
      templateDocument,
      regionDocument,
      itemUuid
    })
  }));
}

function buildLinkedLightData({
  templateDocument,
  regionDocument,
  linkedLight,
  shapes,
  templateDistance = null,
  itemUuid = null
}) {
  const center = findLinkedLightCenter(shapes, templateDocument);
  if (!center) {
    return null;
  }

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

  return {
    x: center.x,
    y: center.y,
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
    flags: buildLinkedDocumentFlags({
      kind: "light",
      templateDocument,
      regionDocument,
      itemUuid
    })
  };
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
    const linkedFlag = document?.flags?.[MODULE_ID]?.linkedDocument ?? null;
    if (!linkedFlag || linkedFlag.kind !== kind) {
      continue;
    }

    if (
      linkedFlag.regionId === regionDocument?.id ||
      linkedFlag.regionUuid === regionDocument?.uuid
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
  });
}

function buildLinkedDocumentFlags({
  kind,
  templateDocument,
  regionDocument,
  itemUuid = null
}) {
  return {
    [MODULE_ID]: {
      linkedDocument: {
        kind,
        templateId: templateDocument?.id ?? null,
        templateUuid: templateDocument?.uuid ?? null,
        regionId: regionDocument?.id ?? null,
        regionUuid: regionDocument?.uuid ?? null,
        itemUuid
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
        segments.push(...buildCircleWallSegments(shape, circleSegments));
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

function buildCircleWallSegments(shape, count) {
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
    segments.push([
      centerX + Math.cos(angleA) * radius,
      centerY + Math.sin(angleA) * radius,
      centerX + Math.cos(angleB) * radius,
      centerY + Math.sin(angleB) * radius
    ]);
  }

  return segments;
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

function findShapeCenter(shape) {
  switch (shape?.type) {
    case "circle":
      return {
        x: coerceNumber(shape.x, 0),
        y: coerceNumber(shape.y, 0)
      };
    case "rectangle":
      return findRectangleCenter(shape);
    case "polygon":
      return findPolygonCenter(shape.points);
    default:
      return null;
  }
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
