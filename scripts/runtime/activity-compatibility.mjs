import {
  coerceNumber
} from "./utils.mjs";

export const ZONE_TRIGGER_SUPPORTED_ACTIVITY_TYPES = Object.freeze([
  "damage",
  "save"
]);

export function resolveZoneTriggeredActivityCompatibility(activity) {
  const activityType = normalizeZoneTriggerActivityType(activity?.type ?? activity?.metadata?.type);
  const saveAbility = resolveActivitySaveAbility(activity);
  const saveDc = coerceNumber(activity?.save?.dc?.value, null);
  const damagePartCount = getActivityDamagePartCount(activity);
  const effectCount = getActivityEffectCount(activity);
  const targetTemplateType = String(activity?.target?.template?.type ?? "").trim().toLowerCase() || null;
  const reasons = [];
  const reasonCodes = [];

  if (!ZONE_TRIGGER_SUPPORTED_ACTIVITY_TYPES.includes(activityType)) {
    reasonCodes.push({
      code: "unsupported-type",
      activityType
    });
    reasons.push(`Activity type "${activityType || "unknown"}" is not supported by zone-trigger activity mode.`);
  }

  if (activityType === "damage" && damagePartCount < 1) {
    reasonCodes.push({
      code: "missing-damage-parts",
      activityType
    });
    reasons.push("Damage activity has no damage parts to resolve.");
  }

  if (activityType === "save") {
    if (!saveAbility) {
      reasonCodes.push({
        code: "missing-save-ability",
        activityType
      });
      reasons.push("Save activity has no target save ability.");
    }

    if (saveDc === null) {
      reasonCodes.push({
        code: "missing-save-dc",
        activityType
      });
      reasons.push("Save activity has no resolved save DC.");
    }
  }

  return {
    supported: reasons.length === 0,
    code: reasons.length === 0
      ? `${activityType || "unknown"}-targeted`
      : `unsupported-${activityType || "unknown"}`,
    reasons,
    reasonCodes,
    reasonsText: reasons.join(" | "),
    activityType,
    saveAbility,
    saveDc,
    damagePartCount,
    effectCount,
    activityEffectsIgnored: effectCount > 0,
    targetTemplateType,
    usedFullActivityFlow: false,
    templateCreationPrevented: Boolean(targetTemplateType),
    consumptionPrevented: true,
    concentrationPrevented: true
  };
}

export function normalizeZoneTriggerActivityType(value) {
  return String(value ?? "").trim().toLowerCase();
}

function resolveActivitySaveAbility(activity) {
  const abilities = Array.from(activity?.save?.ability ?? [])
    .map((ability) => String(ability ?? "").trim().toLowerCase())
    .filter(Boolean);

  return abilities[0] ?? null;
}

function getActivityDamagePartCount(activity) {
  return Array.isArray(activity?.damage?.parts) ? activity.damage.parts.length : 0;
}

function getActivityEffectCount(activity) {
  if (Array.isArray(activity?.effects)) {
    return activity.effects.length;
  }

  if (typeof activity?.effects?.size === "number") {
    return activity.effects.size;
  }

  return Array.from(activity?.effects ?? []).filter(Boolean).length;
}
