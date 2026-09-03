import {
  ACTIVITY_DEFINITION_SCHEMA_VERSION,
  MODULE_ID,
  PERSISTENT_ZONE_ACTIVITY_TYPE
} from "../constants.mjs";
import { PersistentZoneActivity } from "./persistent-zone-activity.mjs";
import { PersistentZoneActivitySheet } from "./persistent-zone-activity-sheet.mjs";
import { centerRectanglePosition, convertCanonicalDistanceToSceneUnits, distanceToScenePixels } from "./activity-distance.mjs";
import { resolvePersistentZoneCastLevel } from "./cast-level.mjs";
import { applyResolvedRadiusToTemplateData, resolveScaledRadius } from "../runtime/radius-scaling.mjs";

let rectanglePlacementHooksRegistered = false;
const pendingScaledRadiusPlacements = new Map();

export function registerPersistentZoneActivityType() {
  const activityTypes = CONFIG?.DND5E?.activityTypes;
  if (!activityTypes) {
    console.warn(`[${MODULE_ID}][activity] persistent-zone activity registration skipped | reason=dnd5e-activity-types-unavailable`);
    return false;
  }
  registerRectanglePlacementHooks();

  if (activityTypes[PERSISTENT_ZONE_ACTIVITY_TYPE]) {
    console.warn(`[${MODULE_ID}][activity] persistent-zone activity registration skipped | reason=activity-type-already-registered`);
    return false;
  }

  const config = {
    documentClass: PersistentZoneActivity,
    sheetClass: PersistentZoneActivitySheet,
    typeLabel: "PERSISTENT_ZONES.Activity.Title",
    configurable: true,
    persistentZones: {
      moduleId: MODULE_ID,
      schemaVersion: ACTIVITY_DEFINITION_SCHEMA_VERSION
    }
  };

  PersistentZoneActivity.localize?.();
  activityTypes[PERSISTENT_ZONE_ACTIVITY_TYPE] = config;
  console.warn(`[${MODULE_ID}][activity] persistent-zone activity registered | type=${PERSISTENT_ZONE_ACTIVITY_TYPE}`);
  return true;
}

function registerRectanglePlacementHooks() {
  if (rectanglePlacementHooksRegistered) return;
  rectanglePlacementHooksRegistered = true;
  Hooks.on("dnd5e.preCreateActivityTemplate", preparePersistentZoneRectangleTemplate);
  Hooks.on("dnd5e.preCreateActivityTemplate", preparePersistentZoneScaledRadiusTemplate);
  Hooks.on("dnd5e.createActivityTemplate", centerPersistentZoneRectangleTemplates);
  Hooks.on("dnd5e.createActivityTemplate", clearPersistentZoneScaledRadiusPlacement);
  Hooks.on("dnd5e.preActivityConsumption", capturePersistentZoneScaledRadius);
}

/**
 * D&D5e finalizes usageConfig.scaling after its configuration dialog, then calls this
 * hook before consumption and template placement. This is the first stable upcast context.
 */
export function capturePersistentZoneScaledRadius(activity, usageConfig) {
  const geometry = activity?.persistentZone?.geometry ?? activity?._source?.persistentZone?.geometry ?? {};
  if (String(activity?.type ?? "") !== PERSISTENT_ZONE_ACTIVITY_TYPE) return;
  if (!["circle", "emanation"].includes(String(geometry.type ?? "").toLowerCase())) return;
  const cast = resolvePersistentZoneCastLevel({ usage: usageConfig, item: activity.item, actor: activity.actor });
  const resolved = resolveScaledRadius({
    radius: geometry.radius,
    scaling: geometry.scaling,
    castLevel: cast.castLevel,
    itemBaseLevel: activity.item?.system?.level
  });
  if (resolved.scaling.mode !== "per-level") return;
  const scene = globalThis.canvas?.scene ?? null;
  const radius = convertCanonicalDistanceToSceneUnits(resolved.radius, geometry.units, scene);
  pendingScaledRadiusPlacements.set(getActivityPlacementKey(activity), {
    cast,
    radius,
    geometry: foundry.utils.deepClone(geometry)
  });
}

/**
 * AbilityTemplate.fromActivity consumes templateData.distance in scene units.
 * This hook is intentionally after the usage configuration has selected the slot
 * and immediately before D&D5e constructs the MeasuredTemplate Document.
 */
export function preparePersistentZoneScaledRadiusTemplate(activity, templateData) {
  const placement = pendingScaledRadiusPlacements.get(getActivityPlacementKey(activity));
  const geometry = placement?.geometry ?? activity?.persistentZone?.geometry ?? activity?._source?.persistentZone?.geometry ?? {};
  if (String(activity?.type ?? "") !== PERSISTENT_ZONE_ACTIVITY_TYPE || geometry?.scaling?.mode !== "per-level") return;
  const scene = globalThis.canvas?.scene ?? null;
  const cast = placement?.cast ?? resolvePersistentZoneCastLevel({ item: activity.item, actor: activity.actor });
  const resolved = placement?.radius ?? convertCanonicalDistanceToSceneUnits(resolveScaledRadius({
    radius: geometry.radius,
    scaling: geometry.scaling,
    castLevel: cast.castLevel,
    itemBaseLevel: activity.item?.system?.level
  }).radius, geometry.units, scene);
  if (!Number.isFinite(Number(resolved)) || Number(resolved) <= 0) return;
  applyResolvedRadiusToTemplateData(templateData, Number(resolved));
}

function clearPersistentZoneScaledRadiusPlacement(activity) {
  pendingScaledRadiusPlacements.delete(getActivityPlacementKey(activity));
}

function getActivityPlacementKey(activity) {
  return String(activity?.uuid ?? `${activity?.item?.uuid ?? "Item.unknown"}.Activity.${activity?.id ?? "unknown"}`);
}

export function preparePersistentZoneRectangleTemplate(activity, templateData) {
  const geometry = activity?.persistentZone?.geometry ?? activity?._source?.persistentZone?.geometry ?? {};
  if (String(activity?.type ?? "") !== PERSISTENT_ZONE_ACTIVITY_TYPE || String(geometry.type ?? "").toLowerCase() !== "rectangle") return;
  const scene = globalThis.canvas?.scene ?? null;
  const width = convertCanonicalDistanceToSceneUnits(geometry.width, geometry.units, scene);
  const height = convertCanonicalDistanceToSceneUnits(geometry.height, geometry.units, scene);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return;
  const gridAligned = templateData.t === "rect";
  templateData.width = height;
  templateData.distance = gridAligned ? Math.hypot(width, height) : width;
  if (gridAligned) templateData.direction = Math.atan2(height, width) * 180 / Math.PI;
  templateData.flags ??= {};
  templateData.flags[MODULE_ID] = {
    ...(templateData.flags[MODULE_ID] ?? {}),
    centeredRectangle: true,
    width,
    height,
    units: scene?.grid?.units ?? geometry.units ?? "scene",
    widthPixels: distanceToScenePixels(width, "scene", scene),
    heightPixels: distanceToScenePixels(height, "scene", scene)
  };
}

export function centerPersistentZoneRectangleTemplates(activity, templates = []) {
  if (String(activity?.type ?? "") !== PERSISTENT_ZONE_ACTIVITY_TYPE) return;
  for (const template of templates) {
    const rectangle = template?.document?.flags?.[MODULE_ID];
    if (!rectangle?.centeredRectangle || typeof template.getSnappedPosition !== "function") continue;
    const original = template.getSnappedPosition.bind(template);
    template.getSnappedPosition = (point) => centerRectanglePosition(original(point), template.document, rectangle);
  }
}
