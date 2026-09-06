import {
  convertCanonicalDistanceToSceneUnits,
  normalizeCanonicalDistanceUnit
} from "../activity/activity-distance.mjs";
import { MODULE_ID } from "../constants.mjs";

export const PRESET_SCHEMA_VERSION = 1;

const PERSISTENT_ZONE_KEYS = new Set([
  "schemaVersion", "enabled", "geometry", "parts", "triggers", "damage", "save", "effects",
  "placement", "movement", "translation", "controlledMovement", "terrain", "linkedWalls", "linkedLights", "lifecycle", "elevation", "obstacles", "obscuration"
]);

const RUNTIME_IDENTITY_KEYS = new Set([
  "actorUuid", "itemUuid", "activityId", "activityUuid", "regionId", "regionUuid", "sourceRegionId",
  "groupId", "ownerEffectUuid", "activeEffectUuid", "concentrationEffectUuid", "templateId", "templateUuid",
  "workflowId", "messageId", "castInstanceId", "ringOperationId"
]);

export function normalizePreset(value) {
  if (!isObject(value)) return null;
  const id = String(value.id ?? "").trim();
  const name = String(value.name ?? "").trim();
  const version = Number(value.version);
  if (!id || !name || version !== PRESET_SCHEMA_VERSION || !isObject(value.persistentZone)) return null;

  const persistentZone = sanitizePersistentZoneConfiguration(value.persistentZone);
  if (!isValidPersistentZoneConfiguration(persistentZone)) return null;

  const source = ["builtin", "user", "srd-5.2.1"].includes(value.source) ? value.source : "user";
  return {
    id,
    version,
    source,
    name,
    description: String(value.description ?? "").trim(),
    category: String(value.category ?? "general").trim() || "general",
    tags: Array.isArray(value.tags) ? value.tags.map(tag => String(tag).trim()).filter(Boolean) : [],
    system: {
      id: String(value.system?.id ?? "dnd5e").trim() || "dnd5e",
      minimum: String(value.system?.minimum ?? "5").trim() || "5"
    },
    ...(source === "srd-5.2.1" ? {
      rulesVersion: String(value.rulesVersion ?? "2024"),
      spell: value.spell === true,
      attribution: {
        title: String(value.attribution?.title ?? "System Reference Document 5.2.1"),
        url: String(value.attribution?.url ?? "https://www.dndbeyond.com/srd"),
        license: String(value.attribution?.license ?? "CC BY 4.0"),
        licenseUrl: String(value.attribution?.licenseUrl ?? "https://creativecommons.org/licenses/by/4.0/legalcode")
      }
    } : {}),
    persistentZone
  };
}

export function extractPresetDataFromActivity(activity, metadata = {}) {
  const persistentZone = activity?.persistentZone ?? activity?._source?.persistentZone ??
    activity?.toObject?.()?.persistentZone ?? null;
  return normalizePreset({
    id: metadata.id ?? "user.activity-preset",
    version: PRESET_SCHEMA_VERSION,
    source: metadata.source ?? "user",
    name: metadata.name ?? activity?.name ?? "Persistent Zone preset",
    description: metadata.description ?? "",
    category: metadata.category ?? "custom",
    tags: metadata.tags ?? [],
    system: metadata.system ?? { id: "dnd5e", minimum: "5" },
    persistentZone
  });
}

export async function applyPresetToActivity(activity, presetOrData, {
  activityUpdates = {},
  scene = globalThis.canvas?.scene ?? null
} = {}) {
  const preset = normalizePreset(presetOrData);
  if (!preset) throw new Error("Invalid Persistent Zones preset.");
  const item = activity?.item ?? activity?.parent ?? null;
  if (!item || typeof item.updateActivity !== "function" || !activity?.id) {
    throw new Error("The Persistent Zone Activity is not embedded in an updateable Item.");
  }
  const persistentZone = resolvePresetPersistentZoneForScene(preset.persistentZone, scene);
  await item.updateActivity(activity.id, { "-=persistentZone": null });
  await item.updateActivity(activity.id, { ...clone(activityUpdates), persistentZone });
  const controlledMovement = persistentZone?.controlledMovement;
  if (controlledMovement?.enabled !== true) return { preset, persistentZone };

  const companion = await ensureControlledMovementCompanionActivity(item, activity.id);
  const resolvedPersistentZone = clone(persistentZone);
  resolvedPersistentZone.controlledMovement = {
    ...resolvedPersistentZone.controlledMovement,
    activationActivityId: companion.id
  };
  await item.updateActivity(activity.id, { persistentZone: resolvedPersistentZone });
  return { preset, persistentZone: resolvedPersistentZone, controlledMovementActivity: companion };
}

/** Ensure one native D&D5e Utility Activity controls this exact PZ Activity. */
export async function ensureControlledMovementCompanionActivity(item, primaryActivityId) {
  if (!item?.createActivity || !item?.updateActivity || !primaryActivityId) {
    throw new Error("The Persistent Zone Activity is not embedded in an updateable Item.");
  }
  const existing = Array.from(item.system?.activities?.values?.() ?? []).find((activity) => {
    const config = activity?.flags?.[MODULE_ID]?.controlledZoneMovement ?? activity?._source?.flags?.[MODULE_ID]?.controlledZoneMovement;
    return activity?.type === "utility" && config?.enabled === true && config?.primaryActivityId === primaryActivityId;
  });
  const source = {
    name: localize("PERSISTENT_ZONES.ControlledMovement.ActivityName", "Move Zone"),
    type: "utility",
    activation: { type: "bonus", value: 1 },
    // This Utility is a command for an already-active cast, never a second concentration use.
    duration: { value: null, units: "inst", concentration: false, override: true },
    consumption: { scaling: { allowed: false }, spellSlot: false, targets: [] },
    flags: { [MODULE_ID]: { controlledZoneMovement: { enabled: true, primaryActivityId } } }
  };
  if (existing) {
    await item.updateActivity(existing.id, source);
    return existing;
  }
  const before = new Set(Array.from(item.system?.activities?.keys?.() ?? []));
  await item.createActivity("utility", source, { renderSheet: false });
  const created = Array.from(item.system?.activities?.values?.() ?? []).find((activity) => !before.has(activity?.id));
  if (!created) throw new Error("D&D5e did not retain the controlled movement Utility Activity.");
  return created;
}

export function resolvePresetPersistentZoneForScene(persistentZone, scene = globalThis.canvas?.scene ?? null) {
  const resolved = clone(persistentZone ?? {});
  const geometry = resolved.geometry;
  if (!isObject(geometry)) return resolved;

  const sourceUnits = normalizeCanonicalDistanceUnit(geometry.units);
  const sceneUnits = normalizeCanonicalDistanceUnit(scene?.grid?.units ?? scene?.grid?.unit);
  if (sourceUnits === "scene" || sceneUnits === "scene") {
    convertTranslationForScene(resolved.translation, scene, sceneUnits);
    convertControlledMovementForScene(resolved.controlledMovement, scene, sceneUnits);
    convertTriggerTargetingForScene(resolved.triggers, scene, sceneUnits, sourceUnits);
    convertElevationForScene(resolved.elevation, scene, sceneUnits);
    for (const part of Array.isArray(resolved.parts) ? resolved.parts : []) {
      convertElevationForScene(part?.elevation, scene, sceneUnits);
    }
    return resolved;
  }
  for (const field of [
    "width", "height", "radius", "ringReferenceRadius", "ringInnerWidth", "ringOuterWidth",
    "wallLength", "wallThickness"
  ]) {
    if (geometry[field] === undefined || geometry[field] === null) continue;
    geometry[field] = convertCanonicalDistanceToSceneUnits(geometry[field], sourceUnits, scene);
  }
  if (isObject(geometry.scaling) && geometry.scaling.radiusPerLevel !== undefined && geometry.scaling.radiusPerLevel !== null) {
    geometry.scaling.radiusPerLevel = convertCanonicalDistanceToSceneUnits(
      geometry.scaling.radiusPerLevel,
      sourceUnits,
      scene
    );
  }
  for (const part of Array.isArray(resolved.parts) ? resolved.parts : []) {
    const partGeometry = part?.geometry;
    if (!isObject(partGeometry)) continue;
    for (const field of ["offsetStart", "offsetEnd", "axisLength", "width"]) {
      if (partGeometry[field] === undefined || partGeometry[field] === null) continue;
      partGeometry[field] = convertCanonicalDistanceToSceneUnits(partGeometry[field], sourceUnits, scene);
    }
    convertElevationForScene(part?.elevation, scene, sceneUnits);
  }
  convertElevationForScene(resolved.elevation, scene, sceneUnits);
  if (isObject(resolved.linkedWalls) && resolved.linkedWalls.height !== undefined && resolved.linkedWalls.height !== null) {
    resolved.linkedWalls.height = convertCanonicalDistanceToSceneUnits(resolved.linkedWalls.height, sourceUnits, scene);
  }
  if (isObject(resolved.linkedLights)) {
    for (const field of ["bright", "dim"]) {
      if (resolved.linkedLights[field] === undefined || resolved.linkedLights[field] === null) continue;
      resolved.linkedLights[field] = convertCanonicalDistanceToSceneUnits(resolved.linkedLights[field], sourceUnits, scene);
    }
  }
  if (isObject(resolved.movement) && resolved.movement.distanceStep !== undefined && resolved.movement.distanceStep !== null) {
    resolved.movement.distanceStep = convertCanonicalDistanceToSceneUnits(resolved.movement.distanceStep, sourceUnits, scene);
    resolved.movement.units = sceneUnits;
  }
  convertTranslationForScene(resolved.translation, scene, sceneUnits);
  convertControlledMovementForScene(resolved.controlledMovement, scene, sceneUnits);
  convertTriggerTargetingForScene(resolved.triggers, scene, sceneUnits, sourceUnits);
  geometry.units = sceneUnits;
  return resolved;
}

function convertTranslationForScene(translation, scene, sceneUnits) {
  if (!isObject(translation) || translation.distance === undefined || translation.distance === null) return;
  const sourceUnits = normalizeCanonicalDistanceUnit(translation.units);
  if (sourceUnits === "scene" || sceneUnits === "scene") return;
  translation.distance = convertCanonicalDistanceToSceneUnits(translation.distance, sourceUnits, scene);
  translation.units = sceneUnits;
}

function convertControlledMovementForScene(controlledMovement, scene, sceneUnits) {
  if (!isObject(controlledMovement)) return;
  const sourceUnits = normalizeCanonicalDistanceUnit(controlledMovement.units);
  if (sourceUnits === "scene" || sceneUnits === "scene") return;
  for (const field of ["maxDistance", "physicalRadius"]) {
    if (controlledMovement[field] === undefined || controlledMovement[field] === null) continue;
    controlledMovement[field] = convertCanonicalDistanceToSceneUnits(controlledMovement[field], sourceUnits, scene);
  }
  controlledMovement.units = sceneUnits;
}

function convertTriggerTargetingForScene(triggers, scene, sceneUnits, sourceUnits = null) {
  if (!isObject(triggers)) return;
  for (const trigger of Object.values(triggers)) {
    const targeting = trigger?.targeting;
    if (!isObject(targeting) || targeting.mode !== "proximity" || targeting.distance === undefined || targeting.distance === null) continue;
    const units = sourceUnits ?? normalizeCanonicalDistanceUnit(trigger?.units ?? "ft");
    if (units === "scene" || sceneUnits === "scene") continue;
    targeting.distance = convertCanonicalDistanceToSceneUnits(targeting.distance, units, scene);
  }
}

function convertElevationForScene(elevation, scene, sceneUnits) {
  if (!isObject(elevation) || elevation.enabled === false || elevation.inherit === true) return;
  const sourceUnits = normalizeCanonicalDistanceUnit(elevation.units);
  if (sourceUnits === "scene" || sceneUnits === "scene") return;
  for (const field of ["bottom", "top"]) {
    if (elevation[field] === undefined || elevation[field] === null) continue;
    elevation[field] = convertCanonicalDistanceToSceneUnits(elevation[field], sourceUnits, scene);
  }
  elevation.units = sceneUnits;
}

export function sanitizePersistentZoneConfiguration(value) {
  if (!isObject(value)) return null;
  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PERSISTENT_ZONE_KEYS.has(key)) continue;
    sanitized[key] = sanitizeValue(entry, [key]);
  }
  return sanitized;
}

function sanitizeValue(value, path) {
  if (Array.isArray(value)) return value.map((entry, index) => sanitizeValue(entry, [...path, index]));
  if (!isObject(value)) return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (RUNTIME_IDENTITY_KEYS.has(key)) continue;
    if (path.at(-1) === "linkedActivity" && ["id", "uuid"].includes(key)) {
      if (entry === null || entry === "") output[key] = null;
      continue;
    }
    output[key] = sanitizeValue(entry, [...path, key]);
  }
  return output;
}

function isValidPersistentZoneConfiguration(config) {
  if (!isObject(config)) return false;
  const schemaVersion = Number(config.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) return false;
  const geometryType = String(config.geometry?.type ?? "").trim();
  if (!geometryType || !["circle", "rectangle", "ring", "wall", "emanation"].includes(geometryType)) return false;
  if (config.parts !== undefined && !Array.isArray(config.parts)) return false;
  if (Array.isArray(config.parts)) {
    const ids = new Set();
    for (const part of config.parts) {
      if (!isObject(part)) return false;
      const id = String(part.id ?? "").trim();
      const type = String(part.geometry?.type ?? "").trim();
      if (!id || ids.has(id) || !["template", "side-of-line", "side-of-ring"].includes(type)) return false;
      ids.add(id);
    }
  }
  return true;
}

function clone(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localize(key, fallback) {
  const value = globalThis.game?.i18n?.localize?.(key);
  return value && value !== key ? value : fallback;
}
