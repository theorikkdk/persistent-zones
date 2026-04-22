import {
  coerceNumber
} from "./utils.mjs";

export const ZONE_TRIGGER_SUPPORTED_ACTIVITY_TYPES = Object.freeze([
  "damage",
  "save",
  "heal"
]);

export function resolveZoneTriggeredActivityCompatibility(activity) {
  const activitySummary = inspectZoneTriggeredActivity(activity);

  return {
    supported: activitySummary.compatible,
    code: activitySummary.compatibility,
    reasons: activitySummary.reasons,
    reasonCodes: activitySummary.reasonCodes,
    reasonsText: activitySummary.compatibilityReason,
    activityId: activitySummary.activityId,
    activityName: activitySummary.activityName,
    activityTypeRaw: activitySummary.activityTypeRaw,
    activityType: activitySummary.activityType,
    healCompatibilityMode: activitySummary.healCompatibilityMode,
    saveAbility: activitySummary.nativeSignals.save.primaryAbility,
    saveAbilities: activitySummary.nativeSignals.save.abilities,
    saveDc: activitySummary.nativeSignals.save.dc,
    damagePartCount: activitySummary.nativeSignals.damage.partCount,
    damageTypes: activitySummary.nativeSignals.damage.types,
    damageIsHealingLike: activitySummary.nativeSignals.damage.isHealingLike,
    healingPartCount: activitySummary.nativeSignals.healing.partCount,
    healingTypes: activitySummary.nativeSignals.healing.types,
    supportsHealing: activitySummary.nativeSignals.healing.types.includes("healing"),
    supportsTempHp: activitySummary.nativeSignals.healing.types.includes("temphp"),
    effectCount: activitySummary.nativeSignals.effects.count,
    activityEffectsIgnored: activitySummary.nativeSignals.effects.count > 0,
    targetTemplateType: activitySummary.nativeSignals.targetTemplateType,
    usedFullActivityFlow: false,
    templateCreationPrevented: Boolean(activitySummary.nativeSignals.targetTemplateType),
    consumptionPrevented: true,
    concentrationPrevented: true
  };
}

export function inspectZoneTriggeredActivity(activity) {
  const activityId = resolveActivityIdentifier(activity);
  const activityName = resolveActivityName(activity);
  const visibleLabel = activityName || activityId || null;
  const activityTypeRaw = resolveZoneTriggerActivityTypeRaw(activity);
  const damageProfile = getActivityDamageProfile(activity);
  const healingProfile = getActivityHealingProfile(activity);
  const saveProfile = getActivitySaveProfile(activity);
  const effectCount = getActivityEffectCount(activity);
  const targetTemplateType = resolveTargetTemplateType(activity);
  const activityType = normalizeZoneTriggerActivityType(activityTypeRaw, {
    damageProfile,
    healingProfile,
    saveProfile
  });
  const healCompatibilityMode = resolveHealCompatibilityMode({
    activityType,
    activityTypeRaw,
    typeDeclared: activity?.type,
    metadataType: activity?.metadata?.type,
    constructorType: activity?.constructor?.metadata?.type,
    damageProfile,
    healingProfile
  });
  const reasons = [];
  const reasonCodes = [];

  if (!ZONE_TRIGGER_SUPPORTED_ACTIVITY_TYPES.includes(activityType)) {
    reasonCodes.push({
      code: "unsupported-type",
      activityType
    });
    reasons.push(`Activity type "${activityType || "unknown"}" is not supported by zone-trigger activity mode.`);
  }

  if (activityType === "damage" && damageProfile.partCount < 1) {
    reasonCodes.push({
      code: "missing-damage-parts",
      activityType
    });
    reasons.push("Damage activity has no damage parts to resolve.");
  }

  if (activityType === "save") {
    if (!saveProfile.primaryAbility) {
      reasonCodes.push({
        code: "missing-save-ability",
        activityType
      });
      reasons.push("Save activity has no target save ability.");
    }

    if (saveProfile.dc === null) {
      reasonCodes.push({
        code: "missing-save-dc",
        activityType
      });
      reasons.push("Save activity has no resolved save DC.");
    }
  }

  if (activityType === "heal" && healCompatibilityMode === "unsupported") {
    reasonCodes.push({
      code: "missing-healing-parts",
      activityType
    });
    reasons.push("Healing activity has no healing formula to resolve.");
  }

  return {
    activityId,
    activityName,
    visibleLabel,
    typeDeclared: normalizeNullableString(activity?.type),
    metadataType: normalizeNullableString(activity?.metadata?.type),
    constructorType: normalizeNullableString(activity?.constructor?.metadata?.type),
    activityTypeRaw,
    activityType,
    healCompatibilityMode,
    compatible: reasons.length === 0,
    compatibility: reasons.length === 0
      ? `${activityType || "unknown"}-targeted`
      : `unsupported-${activityType || "unknown"}`,
    compatibilityReason: reasons.join(" | "),
    reasons,
    reasonCodes,
    nativeSignals: {
      damage: damageProfile,
      healing: healingProfile,
      save: saveProfile,
      effects: {
        count: effectCount
      },
      targetTemplateType
    }
  };
}

export function normalizeZoneTriggerActivityType(value, context = {}) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (normalized === "healing") {
    return "heal";
  }

  if (["heal", "damage", "save"].includes(normalized)) {
    return normalized;
  }

  const damageProfile = context.damageProfile ?? getActivityDamageProfile(context.activity);
  const healingProfile = context.healingProfile ?? getActivityHealingProfile(context.activity);
  const saveProfile = context.saveProfile ?? getActivitySaveProfile(context.activity);

  if (healingProfile.partCount > 0 || damageProfile.isHealingLike) {
    return "heal";
  }

  if (damageProfile.partCount > 0) {
    return "damage";
  }

  if (saveProfile.primaryAbility || saveProfile.dc !== null) {
    return "save";
  }

  return normalized;
}

export function resolveZoneTriggerActivityTypeRaw(activity) {
  return String(
    activity?.type ??
    activity?.metadata?.type ??
    activity?.constructor?.metadata?.type ??
    activity?.documentName ??
    ""
  ).trim().toLowerCase();
}

function getActivityDamageProfile(activity) {
  let selectedParts = [];
  let source = "none";

  for (const candidate of collectActivityDataCandidates(activity)) {
    const parts = Array.isArray(candidate?.data?.damage?.parts)
      ? candidate.data.damage.parts
      : [];
    if (!parts.length) {
      continue;
    }

    if (parts.length > selectedParts.length) {
      selectedParts = parts;
      source = candidate.source;
    }
  }

  const formulas = selectedParts
    .map((part) => resolveDamagePartFormula(part))
    .filter(Boolean);
  const types = Array.from(new Set(selectedParts.flatMap((part) => normalizeActivityDamageTypes(
    part?.types ?? part?.type ?? []
  ))));
  const isHealingLike =
    selectedParts.length > 0 &&
    types.length > 0 &&
    types.every((type) => isHealingType(type));

  return {
    source,
    partCount: selectedParts.length,
    formulas,
    types,
    isHealingLike
  };
}

function getActivityHealingProfile(activity) {
  let source = "none";
  let formula = "";
  let types = [];
  let hasHealingField = false;

  for (const candidate of collectActivityDataCandidates(activity)) {
    const healing = candidate?.data?.healing;
    if (!isRecord(healing)) {
      continue;
    }

    hasHealingField = true;
    const candidateFormula = resolveActivityHealingFormulaFromField(healing);
    const candidateTypes = normalizeActivityDamageTypes(healing?.types);

    if (!formula && candidateFormula) {
      formula = candidateFormula;
      source = candidate.source;
    }

    if (!types.length && candidateTypes.length) {
      types = candidateTypes;
      if (source === "none") {
        source = candidate.source;
      }
    }
  }

  return {
    source,
    hasHealingField,
    partCount: formula ? 1 : 0,
    formula,
    types: types.length ? types : ["healing"]
  };
}

function getActivitySaveProfile(activity) {
  let abilities = [];
  let abilitySource = "none";
  let dc = null;
  let dcSource = "none";

  for (const candidate of collectActivityDataCandidates(activity)) {
    const save = candidate?.data?.save;
    if (!isRecord(save)) {
      continue;
    }

    const candidateAbilities = normalizeActivityAbilitySet(save?.ability);
    if (!abilities.length && candidateAbilities.length) {
      abilities = candidateAbilities;
      abilitySource = candidate.source;
    }

    const candidateDc = resolveActivitySaveDc(save);
    if (dc === null && candidateDc !== null) {
      dc = candidateDc;
      dcSource = candidate.source;
    }
  }

  return {
    abilitySource,
    abilities,
    primaryAbility: abilities[0] ?? null,
    dc,
    dcSource
  };
}

function collectActivityDataCandidates(activity) {
  const candidates = [];
  const seen = new Set();

  pushActivityCandidate(candidates, seen, activity, "live");
  pushActivityCandidate(candidates, seen, activity?._source, "source");

  if (typeof activity?.toObject === "function") {
    try {
      pushActivityCandidate(candidates, seen, activity.toObject(), "object");
    } catch (_error) {
      // Ignore toObject failures in diagnostics.
    }
  }

  return candidates;
}

function pushActivityCandidate(candidates, seen, data, source) {
  if (!isRecord(data) || seen.has(data)) {
    return;
  }

  seen.add(data);
  candidates.push({
    source,
    data
  });
}

function resolveActivityIdentifier(activity) {
  return String(
    activity?.id ??
    activity?._id ??
    activity?._source?._id ??
    ""
  ).trim() || null;
}

function resolveActivityName(activity) {
  return String(
    activity?.name ??
    activity?._source?.name ??
    ""
  ).trim() || null;
}

function resolveActivitySaveDc(save) {
  const value = coerceNumber(
    save?.dc?.value ??
    save?.dc?.formula,
    null
  );

  return value;
}

function resolveActivityHealingFormulaFromField(healing) {
  const directFormula = String(healing?.formula ?? "").trim();
  if (directFormula) {
    return directFormula;
  }

  const customFormula = String(healing?.custom?.formula ?? "").trim();
  if (healing?.custom?.enabled && customFormula) {
    return customFormula;
  }

  const number = coerceNumber(healing?.number, 0);
  const denomination = coerceNumber(healing?.denomination, 0);
  const bonus = String(healing?.bonus ?? "").trim();
  let formula = "";

  if (number > 0 && denomination > 0) {
    formula = `${number}d${denomination}`;
  }

  if (bonus) {
    formula = formula ? `${formula} + ${bonus}` : bonus;
  }

  return formula.trim();
}

function resolveDamagePartFormula(part) {
  if (!isRecord(part)) {
    return "";
  }

  const directFormula = String(part?.formula ?? "").trim();
  if (directFormula) {
    return directFormula;
  }

  const customFormula = String(part?.custom?.formula ?? "").trim();
  if (part?.custom?.enabled && customFormula) {
    return customFormula;
  }

  const number = coerceNumber(part?.number, 0);
  const denomination = coerceNumber(part?.denomination, 0);
  const bonus = String(part?.bonus ?? "").trim();
  let formula = "";

  if (number > 0 && denomination > 0) {
    formula = `${number}d${denomination}`;
  }

  if (bonus) {
    formula = formula ? `${formula} + ${bonus}` : bonus;
  }

  return formula.trim();
}

function normalizeActivityAbilitySet(value) {
  if (value instanceof Set) {
    return Array.from(value)
      .map(normalizeActivityAbility)
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .map(normalizeActivityAbility)
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const normalized = normalizeActivityAbility(value);
    return normalized ? [normalized] : [];
  }

  return [];
}

function normalizeActivityAbility(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeActivityDamageTypes(value) {
  if (value instanceof Set) {
    return Array.from(value)
      .map(normalizeActivityDamageType)
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .map(normalizeActivityDamageType)
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const normalized = normalizeActivityDamageType(value);
    return normalized ? [normalized] : [];
  }

  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([_key, enabled]) => Boolean(enabled))
      .map(([key]) => normalizeActivityDamageType(key))
      .filter(Boolean);
  }

  return [];
}

function normalizeActivityDamageType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();

  switch (normalized) {
    case "temp":
    case "temp-hp":
    case "temporary-hp":
    case "temporaryhp":
      return "temphp";
    default:
      return normalized;
  }
}

function isHealingType(type) {
  return ["healing", "temphp"].includes(String(type ?? "").trim().toLowerCase());
}

function resolveTargetTemplateType(activity) {
  return String(activity?.target?.template?.type ?? "").trim().toLowerCase() || null;
}

function resolveHealCompatibilityMode({
  activityType,
  activityTypeRaw,
  typeDeclared,
  metadataType,
  constructorType,
  damageProfile,
  healingProfile
} = {}) {
  if (activityType !== "heal") {
    return "not-heal";
  }

  if (healingProfile?.partCount > 0) {
    return "healing-formula";
  }

  if (damageProfile?.isHealingLike) {
    return "healing-damage-parts";
  }

  const explicitTypeSignals = [
    activityTypeRaw,
    typeDeclared,
    metadataType,
    constructorType
  ].map(normalizeNullableString).filter(Boolean);
  const explicitlyTypedHeal = explicitTypeSignals.some((value) => ["heal", "healing"].includes(value));

  if (healingProfile?.hasHealingField && explicitlyTypedHeal) {
    return "typed-heal-field";
  }

  if (healingProfile?.types?.length && explicitlyTypedHeal) {
    return "typed-heal-types";
  }

  if (explicitlyTypedHeal) {
    return "typed-heal";
  }

  if (healingProfile?.hasHealingField || healingProfile?.types?.length) {
    return "healing-field";
  }

  return "unsupported";
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

function normalizeNullableString(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object";
}
