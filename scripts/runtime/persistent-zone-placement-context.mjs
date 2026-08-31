import { PERSISTENT_ZONE_ACTIVITY_TYPE } from "../constants.mjs";

const PLACEMENT_CONTEXT_TTL_MS = 30_000;
const placementContexts = [];
let placementSequence = 0;

export function registerPersistentZonePlacementContext({
  userId = null,
  sceneId = null,
  itemUuid = null,
  activityId = null,
  activityUuid = null,
  activityType = null,
  geometryType = null,
  targetTemplateType = null,
  nativeTemplateType = null
} = {}) {
  pruneExpiredPlacementContexts();

  const context = {
    userId: normalizeIdentifier(userId),
    sceneId: normalizeIdentifier(sceneId),
    itemUuid: normalizeIdentifier(itemUuid),
    activityId: normalizeIdentifier(activityId),
    activityUuid: normalizeIdentifier(activityUuid),
    activityType: normalizeIdentifier(activityType),
    geometryType: normalizeGeometryType(geometryType),
    targetTemplateType: normalizeIdentifier(targetTemplateType)?.toLowerCase() ?? null,
    nativeTemplateType: normalizeIdentifier(nativeTemplateType)?.toLowerCase() ?? null,
    placementSequence: ++placementSequence,
    createdAt: Date.now()
  };

  if (
    !context.userId ||
    !context.sceneId ||
    !context.itemUuid ||
    !context.activityId ||
    !context.activityUuid ||
    context.activityType !== PERSISTENT_ZONE_ACTIVITY_TYPE
  ) {
    return null;
  }

  const existingIndex = placementContexts.findIndex((candidate) =>
    candidate.userId === context.userId &&
    candidate.sceneId === context.sceneId &&
    candidate.itemUuid === context.itemUuid &&
    candidate.activityId === context.activityId &&
    candidate.activityUuid === context.activityUuid
  );
  if (existingIndex >= 0) {
    placementContexts.splice(existingIndex, 1);
  }
  placementContexts.push(context);
  return { ...context };
}

export function findPersistentZonePlacementContext({
  userId = null,
  sceneId = null,
  itemUuid = null,
  regionShapeType = null
} = {}) {
  pruneExpiredPlacementContexts();
  const requestedItemUuid = normalizeIdentifier(itemUuid);
  const scopedContexts = [...placementContexts].reverse().filter((context) =>
    context.userId === normalizeIdentifier(userId) &&
    context.sceneId === normalizeIdentifier(sceneId) &&
    (!requestedItemUuid || context.itemUuid === requestedItemUuid) &&
    context.activityType === PERSISTENT_ZONE_ACTIVITY_TYPE
  );
  const exactMatch = scopedContexts.find((context) =>
    isGeometryCompatibleWithRegionShape(context.geometryType, regionShapeType)
  ) ?? null;
  const activeContext = scopedContexts[0] ?? null;
  const rectangleLineHandoff =
    String(regionShapeType ?? "").trim().toLowerCase() === "line" &&
    activeContext?.geometryType === "rectangle" &&
    activeContext?.nativeTemplateType === "rect";
  const match = rectangleLineHandoff ? activeContext : exactMatch;
  return match ? { ...match } : null;
}

export function consumePersistentZonePlacementContext(context) {
  if (!context) {
    return null;
  }
  pruneExpiredPlacementContexts();
  const index = placementContexts.findIndex((candidate) =>
    candidate.userId === context.userId &&
    candidate.sceneId === context.sceneId &&
    candidate.itemUuid === context.itemUuid &&
    candidate.activityId === context.activityId &&
    candidate.activityUuid === context.activityUuid &&
    candidate.createdAt === context.createdAt
  );
  if (index < 0) {
    return null;
  }
  return { ...placementContexts.splice(index, 1)[0] };
}

function pruneExpiredPlacementContexts() {
  const cutoff = Date.now() - PLACEMENT_CONTEXT_TTL_MS;
  for (let index = placementContexts.length - 1; index >= 0; index -= 1) {
    if (placementContexts[index].createdAt < cutoff) {
      placementContexts.splice(index, 1);
    }
  }
}

function isGeometryCompatibleWithRegionShape(geometryType, regionShapeType) {
  const geometry = normalizeGeometryType(geometryType);
  const shape = String(regionShapeType ?? "").trim().toLowerCase();
  if (geometry === "circle") {
    return shape === "ellipse" || shape === "circle";
  }
  if (geometry === "wall") {
    return shape === "line" || shape === "ray";
  }
  if (geometry === "ring") {
    return shape === "ellipse" || shape === "circle" || shape === "ring";
  }
  if (geometry === "rectangle") {
    return shape === "rectangle" || shape === "rect" || shape === "polygon";
  }
  return false;
}

function normalizeGeometryType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "rect" || normalized === "square") return "rectangle";
  return ["circle", "rectangle", "wall", "ring"].includes(normalized) ? normalized : null;
}

function normalizeIdentifier(value) {
  return String(value ?? "").trim() || null;
}
