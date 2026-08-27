import {
  ACTIVITY_DEFINITION_FIELD_KEY,
  ACTIVITY_DEFINITION_SCHEMA_VERSION,
  PERSISTENT_ZONE_ACTIVITY_TYPE
} from "../constants.mjs";
import { normalizeStatusRecovery } from "../runtime/status-recovery.mjs";

export function isPersistentZoneActivity(activity) {
  return String(
    activity?.type ??
    activity?.metadata?.type ??
    activity?.constructor?.metadata?.type ??
    ""
  ).trim() === PERSISTENT_ZONE_ACTIVITY_TYPE;
}

export function getPersistentZoneActivityDefinition(activity) {
  if (!isPersistentZoneActivity(activity)) {
    return null;
  }

  const config =
    activity?.[ACTIVITY_DEFINITION_FIELD_KEY] ??
    activity?._source?.[ACTIVITY_DEFINITION_FIELD_KEY] ??
    activity?.toObject?.()?.[ACTIVITY_DEFINITION_FIELD_KEY] ??
    null;

  if (!config || typeof config !== "object") {
    return null;
  }

  return buildLegacyDefinitionFromPersistentZoneActivity(activity, config);
}

export function getActivityUuid(activity) {
  return String(activity?.uuid ?? "").trim() || null;
}

export function getActivityId(activity) {
  return String(activity?.id ?? activity?._id ?? activity?._source?._id ?? "").trim() || null;
}

export function buildLegacyDefinitionFromPersistentZoneActivity(activity, config) {
  const source = duplicate(config);
  const geometry = source.geometry ?? {};
  const damage = source.damage ?? {};
  const save = source.save ?? {};
  const movement = source.movement ?? {};
  const terrain = source.terrain ?? {};
  const linkedWalls = source.linkedWalls ?? {};
  const linkedLights = source.linkedLights ?? source.linkedLight ?? {};
  const geometryType = normalizeGeometryType(geometry.type);
  const linkedWallPreset = String(linkedWalls.preset ?? "solid").trim().toLowerCase() || "solid";
  const activityId = getActivityId(activity);
  const activityUuid = getActivityUuid(activity);
  const itemUuid = getActivityItem(activity)?.uuid ?? null;

  const definition = {
    schemaVersion: ACTIVITY_DEFINITION_SCHEMA_VERSION,
    source: "activity",
    enabled: source.enabled !== false,
    label: activity?.name ?? null,
    itemUuid,
    activityId,
    activityUuid,
    activityType: PERSISTENT_ZONE_ACTIVITY_TYPE,
    template: buildTemplateDefinition(activity, geometryType, geometry),
    geometry: buildGeometryDefinition(geometryType, geometry),
    concentration: {
      required: Boolean(activity?.duration?.concentration)
    },
    targeting: {
      mode: "all"
    },
    triggers: buildTriggerDefinitions(source.triggers, {
      damage,
      save,
      movement,
      itemUuid,
      activityId
    }),
    linkedWalls: {
      enabled: Boolean(linkedWalls.enabled),
      preset: linkedWallPreset,
      geometry: normalizeLinkedWallGeometry(linkedWalls.geometry),
      height: linkedWalls.height ?? null,
      ...(linkedWallPreset === "custom" ? {
        move: normalizeLinkedWallMovement(linkedWalls.move),
        sight: normalizeLinkedWallSense(linkedWalls.sight),
        light: normalizeLinkedWallSense(linkedWalls.light),
        sound: normalizeLinkedWallSense(linkedWalls.sound),
        threshold: {
          sight: numberOrNull(linkedWalls.threshold?.sight),
          light: numberOrNull(linkedWalls.threshold?.light),
          sound: numberOrNull(linkedWalls.threshold?.sound),
          attenuation: false
        }
      } : {})
    },
    linkedLight: {
      enabled: Boolean(linkedLights.enabled),
      preset: linkedLights.preset ?? "glow",
      bright: linkedLights.bright ?? null,
      dim: linkedLights.dim ?? null,
      max: linkedLights.max ?? 24,
      color: linkedLights.color ?? null
    },
    terrain: {
      enabled: false,
      requestedEnabled: Boolean(terrain.enabled),
      multiplier: numberOrNull(terrain.multiplier) ?? 2,
      runtimeSupported: false
    },
    lifecycle: duplicate(source.lifecycle ?? {})
  };

  if (geometryType === "wall") {
    definition.templateType = "ray";
  }

  return definition;
}

function buildTemplateDefinition(activity, geometryType, geometry) {
  const template = activity?._source?.target?.template ?? activity?.target?.template ?? {};
  const units = template.units ?? "ft";

  if (geometryType === "wall") {
    return {
      typeSource: "manual",
      type: "ray",
      distance: numberOrNull(geometry.wallLength) ?? numberOrNull(template.size),
      width: numberOrNull(geometry.wallThickness) ?? numberOrNull(template.width),
      units
    };
  }

  const radius = geometryType === "ring"
    ? numberOrNull(geometry.ringReferenceRadius) ?? numberOrNull(geometry.radius) ?? numberOrNull(template.size)
    : numberOrNull(geometry.radius) ?? numberOrNull(template.size);

  return {
    typeSource: "manual",
    type: "circle",
    distance: radius,
    units
  };
}

function getActivityItem(activity) {
  return activity?.item ?? activity?.parent ?? null;
}

function buildGeometryDefinition(geometryType, geometry) {
  if (geometryType === "ring") {
    const referenceRadius = numberOrNull(geometry.ringReferenceRadius) ?? numberOrNull(geometry.radius);
    const innerWidth = numberOrNull(geometry.ringInnerWidth) ?? 0;
    const outerWidth = numberOrNull(geometry.ringOuterWidth) ?? 0;
    const thickness = Math.max(innerWidth + outerWidth, innerWidth, outerWidth, 0);
    return {
      type: "ring",
      referenceRadius,
      referenceRadiusMode: geometry.referenceRadiusMode ?? "outer-edge",
      thickness,
      innerWidth,
      outerWidth
    };
  }

  if (geometryType === "wall") {
    return {
      type: "template",
      wallLength: numberOrNull(geometry.wallLength),
      wallThickness: numberOrNull(geometry.wallThickness)
    };
  }

  return {
    type: "circle",
    radius: numberOrNull(geometry.radius)
  };
}

function buildTriggerDefinitions(triggers = {}, { damage = {}, save = {}, movement = {}, itemUuid = null, activityId = null } = {}) {
  return {
    onEnter: buildTriggerConfig(resolveActivityTriggerSource(triggers, "enter", "onEnter"), { damage, save, movement, triggerId: "enter", itemUuid, activityId }),
    onExit: buildTriggerConfig(resolveActivityTriggerSource(triggers, "exit", "onExit"), { damage, save, movement, triggerId: "exit", itemUuid, activityId }),
    onMove: buildTriggerConfig(resolveActivityTriggerSource(triggers, "move", "onMove"), { damage, save, movement, triggerId: "move", itemUuid, activityId }),
    onStartTurn: buildTriggerConfig(resolveActivityTriggerSource(triggers, "turnStart", "onStartTurn"), { damage, save, movement, triggerId: "turnStart", itemUuid, activityId }),
    onEndTurn: buildTriggerConfig(resolveActivityTriggerSource(triggers, "turnEnd", "onEndTurn"), { damage, save, movement, triggerId: "turnEnd", itemUuid, activityId })
  };
}

function resolveActivityTriggerSource(triggers, canonicalKey, legacyKey) {
  const canonical = triggers?.[canonicalKey];
  if (canonical && typeof canonical === "object") {
    return {
      source: canonical,
      perTriggerConfigFound: hasPerTriggerActionConfig(canonical),
      legacyFallback: false
    };
  }

  const legacy = triggers?.[legacyKey];
  return {
    source: legacy && typeof legacy === "object" ? legacy : {},
    perTriggerConfigFound: hasPerTriggerActionConfig(legacy),
    legacyFallback: true
  };
}

function buildTriggerConfig(triggerSource = {}, { damage = {}, save = {}, movement = {}, triggerId = null, itemUuid = null, activityId = null } = {}) {
  const trigger = triggerSource.source ?? {};
  const perTriggerConfigFound = Boolean(triggerSource.perTriggerConfigFound);
  const simpleEffect = trigger.simpleEffect ?? {};
  const perTriggerDamage = simpleEffect.damage ?? trigger.damage ?? null;
  const perTriggerHealing = simpleEffect.healing ?? trigger.healing ?? null;
  const perTriggerTemporaryHitPoints = simpleEffect.temporaryHitPoints ?? trigger.temporaryHitPoints ?? null;
  const perTriggerSave = simpleEffect.save ?? trigger.save ?? null;
  const perTriggerStatuses = simpleEffect.statuses ?? trigger.statuses ?? null;
  const linkedActivity = trigger.linkedActivity ?? trigger.activity ?? {};
  const damageConfig = perTriggerDamage ?? damage;
  const saveConfig = perTriggerSave ?? save;
  const enabled = Boolean(trigger.enabled);
  const rawMode = normalizeTriggerMode(trigger.mode);
  const mode = enabled ? rawMode : "none";
  const selectedSource = perTriggerConfigFound ? "per-trigger" : "activity-global-fallback";
  logTriggerEffectConfigurationDecision({
    itemUuid,
    activityId,
    triggerId,
    triggerMode: mode,
    perTriggerConfigFound,
    oldGlobalConfigFound: hasOldGlobalActionConfig({ damage, save }),
    selectedSource,
    migrationFallbackUsed: !perTriggerConfigFound && hasOldGlobalActionConfig({ damage, save }),
    damageEnabled: Boolean(damageConfig?.enabled),
    saveEnabled: Boolean(saveConfig?.enabled),
    statusesEnabled: Boolean(perTriggerStatuses?.enabled),
    linkedActivityId: linkedActivity?.id ?? linkedActivity?.activityId ?? null,
    decisionReason: perTriggerConfigFound ? "per-trigger-config-found" : "legacy-global-action-config-fallback"
  });

  return {
    enabled,
    mode,
    triggerId,
    movementMode: movement.movementMode ?? "any",
    stepMode: movement.stepMode ?? "distance",
    distanceStep: numberOrNull(movement.distanceStep) ?? 5,
    cellStep: numberOrNull(movement.cellStep) ?? 1,
    damage: {
      enabled: mode === "simple" && Boolean(damageConfig?.enabled),
      formula: String(damageConfig?.formula ?? "").trim(),
      type: String(damageConfig?.type ?? "fire").trim() || "fire"
    },
    healing: {
      enabled: mode === "simple" && Boolean(perTriggerHealing?.enabled),
      formula: String(perTriggerHealing?.formula ?? "").trim()
    },
    temporaryHitPoints: {
      enabled: mode === "simple" && Boolean(perTriggerTemporaryHitPoints?.enabled),
      formula: String(perTriggerTemporaryHitPoints?.formula ?? "").trim()
    },
    save: {
      enabled: mode === "simple" && Boolean(saveConfig?.enabled),
      ability: String(saveConfig?.ability ?? "dex").trim() || "dex",
      dcMode: String(saveConfig?.dcMode ?? "auto").trim() === "manual" ? "manual" : "auto",
      dc: numberOrNull(saveConfig?.dc),
      onSave: String(saveConfig?.onSave ?? "half").trim() === "none" ? "none" : "half"
    },
    simpleEffect: {
      type: "damage",
      formula: String(damageConfig?.formula ?? "").trim(),
      healing: {
        enabled: mode === "simple" && Boolean(perTriggerHealing?.enabled),
        formula: String(perTriggerHealing?.formula ?? "").trim()
      },
      temporaryHitPoints: {
        enabled: mode === "simple" && Boolean(perTriggerTemporaryHitPoints?.enabled),
        formula: String(perTriggerTemporaryHitPoints?.formula ?? "").trim()
      },
      statuses: {
        enabled: mode === "simple" && Boolean(perTriggerStatuses?.enabled),
        statusId: String(perTriggerStatuses?.statusId ?? "").trim() || null,
        persistenceMode: normalizeStatusPersistenceMode(perTriggerStatuses?.persistenceMode, triggerId),
        recovery: normalizeStatusRecovery(perTriggerStatuses?.recovery)
      }
    },
    statuses: {
      enabled: mode === "simple" && Boolean(perTriggerStatuses?.enabled),
      statusId: String(perTriggerStatuses?.statusId ?? "").trim() || null,
      persistenceMode: normalizeStatusPersistenceMode(perTriggerStatuses?.persistenceMode, triggerId),
      recovery: normalizeStatusRecovery(perTriggerStatuses?.recovery)
    },
    activity: {
      id: mode === "activity" ? String(linkedActivity?.id ?? linkedActivity?.activityId ?? "").trim() || null : null,
      uuid: mode === "activity" ? String(linkedActivity?.uuid ?? linkedActivity?.activityUuid ?? "").trim() || null : null
    },
    linkedActivity: {
      id: mode === "activity" ? String(linkedActivity?.id ?? linkedActivity?.activityId ?? "").trim() || null : null,
      uuid: mode === "activity" ? String(linkedActivity?.uuid ?? linkedActivity?.activityUuid ?? "").trim() || null : null
    }
  };
}

function normalizeTriggerMode(value) {
  const normalized = String(value ?? "none").trim().toLowerCase();
  if (normalized === "simple-effect" || normalized === "simple") {
    return "simple";
  }
  if (normalized === "linked-activity" || normalized === "activity") {
    return "activity";
  }
  return "none";
}

function normalizeStatusPersistenceMode(value, triggerId) {
  const normalized = String(value ?? "persistent").trim().toLowerCase();
  if (triggerId === "exit") {
    return "persistent";
  }
  return normalized === "while-inside-region" ? "while-inside-region" : "persistent";
}

function hasPerTriggerActionConfig(trigger) {
  return Boolean(
    trigger?.simpleEffect?.damage ||
    trigger?.simpleEffect?.healing ||
    trigger?.simpleEffect?.temporaryHitPoints ||
    trigger?.simpleEffect?.save ||
    trigger?.simpleEffect?.statuses ||
    trigger?.linkedActivity ||
    trigger?.damage ||
    trigger?.healing ||
    trigger?.temporaryHitPoints ||
    trigger?.save ||
    trigger?.statuses ||
    trigger?.activity
  );
}

function hasOldGlobalActionConfig({ damage = {}, save = {} } = {}) {
  return Boolean(damage?.enabled || damage?.formula || save?.enabled);
}

function logTriggerEffectConfigurationDecision(data = {}) {
  console.warn(
    `[persistent-zones] PZ TRIGGER EFFECT CONFIGURATION DECISION | itemUuid=${data.itemUuid ?? "null"} | activityId=${data.activityId ?? "null"} | triggerId=${data.triggerId ?? "null"} | triggerMode=${data.triggerMode ?? "null"} | perTriggerConfigFound=${data.perTriggerConfigFound === true} | oldGlobalConfigFound=${data.oldGlobalConfigFound === true} | selectedSource=${data.selectedSource ?? "null"} | migrationFallbackUsed=${data.migrationFallbackUsed === true} | damageEnabled=${data.damageEnabled === true} | saveEnabled=${data.saveEnabled === true} | statusesEnabled=${data.statusesEnabled === true} | linkedActivityId=${data.linkedActivityId ?? "null"} | decisionReason=${data.decisionReason ?? "null"}`
  );
}

function normalizeGeometryType(value) {
  const normalized = String(value ?? "circle").trim().toLowerCase();
  return ["circle", "ring", "wall"].includes(normalized) ? normalized : "circle";
}

function normalizeLinkedWallGeometry(value) {
  return String(value ?? "centerline").trim().toLowerCase() === "perimeter"
    ? "perimeter"
    : "centerline";
}

function normalizeLinkedWallMovement(value) {
  return String(value ?? "normal").trim().toLowerCase() === "none" ? "none" : "normal";
}

function normalizeLinkedWallSense(value) {
  const normalized = String(value ?? "normal").trim().toLowerCase();
  return ["none", "limited", "normal", "proximity", "distance"].includes(normalized) ? normalized : "normal";
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function duplicate(value) {
  return foundry.utils.deepClone(value ?? {});
}
