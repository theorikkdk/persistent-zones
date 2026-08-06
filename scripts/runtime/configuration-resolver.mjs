import {
  PERSISTENT_ZONE_ACTIVITY_TYPE
} from "../constants.mjs";
import {
  buildLegacyDefinitionFromPersistentZoneActivity,
  getActivityId,
  getActivityUuid,
  getPersistentZoneActivityDefinition,
  isPersistentZoneActivity
} from "../activity/persistent-zone-activity-utils.mjs";
import {
  getZoneDefinitionFromItem,
  normalizeZoneDefinition
} from "./zone-definition.mjs";

export function resolvePersistentZoneConfiguration({
  actor = null,
  item = null,
  activity = null,
  workflow = null,
  usage = null,
  templateDocument = null,
  regionDocument = null,
  rawDefinition = null,
  entryPoint = null
} = {}) {
  const resolvedActivity = activity ?? resolveActivityFromUsageOrWorkflow({ item, workflow, usage });
  const activityDefinition = getPersistentZoneActivityDefinition(resolvedActivity);
  const legacyDefinition = rawDefinition ?? getZoneDefinitionFromItem(item);
  const selectedDefinition = activityDefinition ?? legacyDefinition ?? null;
  const source = activityDefinition ? "activity" : legacyDefinition ? "legacy-item-flag" : "none";
  const normalizedDefinition = selectedDefinition
    ? normalizeZoneDefinition(selectedDefinition, {
      item,
      actor,
      caster: actor,
      templateDocument
    })
    : null;

  logConfigurationSourceDecision({
    entryPoint,
    source,
    item,
    activity: resolvedActivity,
    activityDefinition,
    legacyDefinition,
    normalizedDefinition,
    workflow,
    usage,
    templateDocument,
    regionDocument
  });

  return {
    source,
    activity: resolvedActivity,
    rawDefinition: selectedDefinition,
    normalizedDefinition,
    usedActivityDefinition: Boolean(activityDefinition),
    usedLegacyDefinition: !activityDefinition && Boolean(legacyDefinition),
    hasConfiguration: Boolean(selectedDefinition)
  };
}

export function findPersistentZoneActivityOnItem(item, {
  activityId = null,
  activityUuid = null,
  fallbackToSinglePersistentZoneActivity = false
} = {}) {
  const activities = getItemActivities(item);
  if (!activities.length) {
    return null;
  }

  const normalizedId = normalizeIdentifier(activityId);
  const normalizedUuid = normalizeIdentifier(activityUuid);
  if (normalizedUuid) {
    const byUuid = activities.find((activity) => normalizeIdentifier(getActivityUuid(activity)) === normalizedUuid);
    if (byUuid) {
      return byUuid;
    }
  }

  if (normalizedId) {
    const byId = activities.find((activity) => normalizeIdentifier(getActivityId(activity)) === normalizedId);
    if (byId) {
      return byId;
    }
  }

  if (fallbackToSinglePersistentZoneActivity) {
    const persistentZoneActivities = activities.filter((activity) => isPersistentZoneActivity(activity));
    if (persistentZoneActivities.length === 1) {
      return persistentZoneActivities[0];
    }
  }

  return null;
}

export function getItemActivities(item) {
  const activities = item?.system?.activities;
  if (!activities) {
    return [];
  }

  if (typeof activities.values === "function") {
    return Array.from(activities.values()).filter(Boolean);
  }

  if (Array.isArray(activities)) {
    return activities.filter(Boolean);
  }

  if (typeof activities === "object") {
    return Object.values(activities).filter(Boolean);
  }

  return [];
}

function resolveActivityFromUsageOrWorkflow({ item = null, workflow = null, usage = null } = {}) {
  const activity =
    usage?.activity ??
    workflow?.activity ??
    workflow?.activityData ??
    null;
  if (activity) {
    return activity;
  }

  const activityId =
    usage?.activityId ??
    workflow?.activityId ??
    workflow?.activity?.id ??
    workflow?.activityData?.id ??
    null;
  const activityUuid =
    usage?.activityUuid ??
    workflow?.activityUuid ??
    workflow?.activity?.uuid ??
    workflow?.activityData?.uuid ??
    null;

  return findPersistentZoneActivityOnItem(item, {
    activityId,
    activityUuid,
    fallbackToSinglePersistentZoneActivity: false
  });
}

function logConfigurationSourceDecision({
  entryPoint,
  source,
  item,
  activity,
  activityDefinition,
  legacyDefinition,
  normalizedDefinition,
  workflow,
  usage,
  templateDocument,
  regionDocument
} = {}) {
  const geometryFromProfile =
    normalizedDefinition?.parts?.[0]?.geometry?.type ??
    normalizedDefinition?.geometry?.type ??
    null;
  const message = [
    "PZ CONFIGURATION SOURCE DECISION",
    `entryPoint=${entryPoint ?? "unknown"}`,
    `source=${source}`,
    `itemUuid=${item?.uuid ?? null}`,
    `activityId=${getActivityId(activity) ?? null}`,
    `activityUuid=${getActivityUuid(activity) ?? null}`,
    `activityType=${activity?.type ?? null}`,
    `isPersistentZoneActivity=${isPersistentZoneActivity(activity)}`,
    `activityDefinition=${Boolean(activityDefinition)}`,
    `legacyDefinition=${Boolean(legacyDefinition)}`,
    `profileId=${normalizedDefinition?.selectedVariantId ?? normalizedDefinition?.selectedVariant?.id ?? null}`,
    `geometryFromProfile=${geometryFromProfile}`,
    `templateId=${templateDocument?.id ?? null}`,
    `regionId=${regionDocument?.id ?? null}`,
    `workflowId=${workflow?.id ?? workflow?.uuid ?? null}`,
    `usageActivityId=${usage?.activityId ?? null}`
  ].join(" | ");

  console.warn(`[persistent-zones] ${message}`);
}

function normalizeIdentifier(value) {
  return String(value ?? "").trim() || null;
}

