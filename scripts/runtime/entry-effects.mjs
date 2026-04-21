import {
  debug,
  coerceNumber,
  error,
  fromUuidSafe,
  getRegionRuntimeFlags,
  pickFirstDefined
} from "./utils.mjs";
import {
  normalizeZoneTriggerActivityType,
  resolveZoneTriggeredActivityCompatibility
} from "./activity-compatibility.mjs";

export async function applyOnEnterEffect({
  regionDocument,
  tokenDocument,
  normalizedDefinition
}) {
  return applyConfiguredTriggerEffect({
    regionDocument,
    tokenDocument,
    triggerConfig: normalizedDefinition?.triggers?.onEnter ?? {},
    timing: "onEnter"
  });
}

export async function applyConfiguredTriggerEffect({
  regionDocument,
  tokenDocument,
  triggerConfig,
  timing = "custom"
}) {
  const actor = tokenDocument?.actor ?? null;
  const normalizedTiming = String(timing || "custom");
  const configuredTrigger = triggerConfig ?? {};
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const partId = runtime.partId ?? runtime.part?.id ?? runtime.normalizedDefinition?.part?.id ?? null;
  const triggerMode = resolveTriggerEffectMode(configuredTrigger);

  if (!actor) {
    return buildSkippedResult("Token has no Actor.", {
      timing: normalizedTiming,
      partId,
      triggerMode
    });
  }

  if (!configuredTrigger.enabled) {
    return buildSkippedResult(`${normalizedTiming} is not enabled.`, {
      timing: normalizedTiming,
      partId,
      triggerMode
    });
  }

  if (triggerMode === "none") {
    debug(`Skipped ${normalizedTiming} effect because mode = none.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      partId,
      timing: normalizedTiming,
      triggerMode
    });

    return buildSkippedResult(`${normalizedTiming} mode is none.`, {
      timing: normalizedTiming,
      partId,
      triggerMode
    });
  }

  if (triggerMode === "activity") {
    return applyActivityTriggerEffect({
      regionDocument,
      tokenDocument,
      triggerConfig: configuredTrigger,
      timing: normalizedTiming,
      partId
    });
  }

  if (!configuredTrigger.damage?.enabled && !configuredTrigger.save?.enabled) {
    return buildSkippedResult(`${normalizedTiming} has no enabled save or damage.`, {
      timing: normalizedTiming,
      partId,
      triggerMode
    });
  }

  try {
    const saveResult = configuredTrigger.save?.enabled
      ? await resolveSaveResult(actor, configuredTrigger.save, regionDocument, tokenDocument, normalizedTiming)
      : null;

    if (saveResult?.unresolved) {
      return buildSkippedResult("Save DC could not be resolved.", {
        timing: normalizedTiming,
        partId,
        triggerMode,
        save: saveResult
      });
    }

    const damageResult = configuredTrigger.damage?.enabled
      ? await resolveDamageResult(
        configuredTrigger.damage,
        saveResult,
        regionDocument,
        tokenDocument,
        normalizedTiming
      )
      : buildNoDamageResult(configuredTrigger.damage);
    const appliedDamage = coerceNumber(damageResult?.appliedDamage, 0);

    if (appliedDamage > 0) {
      await applyDamageToActor(actor, appliedDamage);
    }

    debug(`Applied ${normalizedTiming} simple effect.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      actorUuid: actor.uuid,
      partId,
      timing: normalizedTiming,
      triggerMode,
      save: saveResult,
      damage: damageResult,
      appliedDamage
    });

    return {
      applied: Boolean(saveResult || configuredTrigger.damage?.enabled),
      skipped: false,
      partId,
      triggerMode,
      timing: normalizedTiming,
      save: saveResult,
      damage: damageResult,
      appliedDamage
    };
  } catch (caughtError) {
    error("Failed to apply configured trigger effect.", caughtError, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      partId,
      timing: normalizedTiming
    });

    return buildSkippedResult("Effect application failed.", {
      timing: normalizedTiming,
      partId,
      triggerMode,
      error: caughtError?.message ?? "unknown"
    });
  }
}

async function applyActivityTriggerEffect({
  regionDocument,
  tokenDocument,
  triggerConfig,
  timing = "custom",
  partId = null
}) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const triggerMode = "activity";
  const selectedActivity = triggerConfig?.activity?.id ?? null;
  const item = await resolveRuntimeItem(runtime);
  const activity = resolveItemActivity(item, triggerConfig?.activity ?? {});

  if (!item) {
    debug(`Skipped ${timing} activity effect because no source Item could be resolved.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      partId,
      timing,
      triggerMode,
      selectedActivity,
      activityFound: false
    });

    return buildSkippedResult("Activity source Item could not be resolved.", {
      timing,
      partId,
      triggerMode,
      selectedActivity,
      activityFound: false
    });
  }

  if (!activity || typeof activity.use !== "function") {
    debug(`Skipped ${timing} activity effect because the configured activity could not be found.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      itemUuid: item?.uuid ?? null,
      partId,
      timing,
      triggerMode,
      selectedActivity,
      activityFound: false
    });

    return buildSkippedResult("Configured activity could not be found on the source Item.", {
      timing,
      partId,
      triggerMode,
      selectedActivity,
      activityFound: false,
      itemUuid: item?.uuid ?? null
    });
  }

  const activityCompatibility = resolveZoneTriggeredActivityCompatibility(activity);

  debug(`Resolved ${timing} activity compatibility.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    itemUuid: item?.uuid ?? null,
    partId,
    timing,
    triggerMode,
    selectedActivity,
    activityFound: true,
    activityType: activityCompatibility.activityType,
    activityCompatibility: activityCompatibility.code,
    activitySupported: activityCompatibility.supported,
    usedFullActivityFlow: false,
    templateCreationPrevented: activityCompatibility.templateCreationPrevented,
    consumptionPrevented: activityCompatibility.consumptionPrevented,
    concentrationPrevented: activityCompatibility.concentrationPrevented,
    reasonsText: activityCompatibility.reasonsText
  });

  if (!activityCompatibility.supported) {
    debug(`Skipped ${timing} activity effect because the configured activity is not compatible with zone-trigger execution.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      itemUuid: item?.uuid ?? null,
      partId,
      timing,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityType: activityCompatibility.activityType,
      activityCompatibility: activityCompatibility.code,
      usedFullActivityFlow: false,
      templateCreationPrevented: activityCompatibility.templateCreationPrevented,
      consumptionPrevented: activityCompatibility.consumptionPrevented,
      concentrationPrevented: activityCompatibility.concentrationPrevented,
      reasonsText: activityCompatibility.reasonsText
    });

    return buildSkippedResult("Configured activity is not compatible with zone-trigger execution.", {
      timing,
      partId,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityType: activityCompatibility.activityType,
      activityCompatibility: activityCompatibility.code,
      usedFullActivityFlow: false,
      templateCreationPrevented: activityCompatibility.templateCreationPrevented,
      consumptionPrevented: activityCompatibility.consumptionPrevented,
      concentrationPrevented: activityCompatibility.concentrationPrevented,
      reasons: activityCompatibility.reasons,
      reasonsText: activityCompatibility.reasonsText
    });
  }

  try {
    const activityResult = await executeZoneTriggeredActivity({
      activity,
      item,
      regionDocument,
      tokenDocument,
      timing,
      compatibility: activityCompatibility
    });
    const activityTriggered = activityResult?.triggered === true;

    debug(`Triggered ${timing} activity effect.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      itemUuid: item?.uuid ?? null,
      partId,
      timing,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityType: activityCompatibility.activityType,
      activityCompatibility: activityCompatibility.code,
      activityTriggered,
      usedFullActivityFlow: false,
      templateCreationPrevented: activityCompatibility.templateCreationPrevented,
      consumptionPrevented: activityCompatibility.consumptionPrevented,
      concentrationPrevented: activityCompatibility.concentrationPrevented
    });

    return {
      applied: activityTriggered,
      skipped: !activityTriggered,
      timing,
      partId,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityType: activityCompatibility.activityType,
      activityCompatibility: activityCompatibility.code,
      activityTriggered,
      itemUuid: item?.uuid ?? null,
      activityName: activity?.name ?? null,
      usedFullActivityFlow: false,
      templateCreationPrevented: activityCompatibility.templateCreationPrevented,
      consumptionPrevented: activityCompatibility.consumptionPrevented,
      concentrationPrevented: activityCompatibility.concentrationPrevented,
      ...activityResult
    };
  } catch (caughtError) {
    error("Failed to trigger configured activity effect.", caughtError, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      itemUuid: item?.uuid ?? null,
      partId,
      timing,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityType: activityCompatibility.activityType,
      activityCompatibility: activityCompatibility.code
    });

    return buildSkippedResult("Configured activity failed.", {
      timing,
      partId,
      triggerMode,
      selectedActivity,
      activityFound: true,
      activityType: activityCompatibility.activityType,
      activityCompatibility: activityCompatibility.code,
      usedFullActivityFlow: false,
      templateCreationPrevented: activityCompatibility.templateCreationPrevented,
      consumptionPrevented: activityCompatibility.consumptionPrevented,
      concentrationPrevented: activityCompatibility.concentrationPrevented,
      error: caughtError?.message ?? "unknown"
    });
  }
}

async function executeZoneTriggeredActivity({
  activity,
  item,
  regionDocument,
  tokenDocument,
  timing = "custom",
  compatibility = {}
}) {
  switch (compatibility.activityType) {
    case "damage":
      return executeZoneTriggeredDamageActivity({
        activity,
        item,
        regionDocument,
        tokenDocument,
        timing,
        compatibility
      });
    case "save":
      return executeZoneTriggeredSaveActivity({
        activity,
        item,
        regionDocument,
        tokenDocument,
        timing,
        compatibility
      });
    default:
      return {
        triggered: false,
        activityType: compatibility.activityType ?? null
      };
  }
}

async function executeZoneTriggeredDamageActivity({
  activity,
  item,
  regionDocument,
  tokenDocument,
  timing = "custom",
  compatibility = {}
}) {
  const actor = tokenDocument?.actor ?? null;
  const damageRolls = await rollZoneTriggeredActivityDamage({
    activity,
    item,
    regionDocument,
    tokenDocument,
    timing
  });
  const rawDamages = buildDamageEntriesFromRolls(damageRolls);
  const appliedDamage = await applyDamageEntriesToActor(actor, rawDamages);

  return {
    triggered: rawDamages.length > 0,
    activityType: compatibility.activityType ?? "damage",
    save: null,
    damage: {
      type: "activity",
      rollCount: Array.isArray(damageRolls) ? damageRolls.length : 0,
      damageCount: rawDamages.length,
      damages: rawDamages,
      appliedDamage
    }
  };
}

async function executeZoneTriggeredSaveActivity({
  activity,
  item,
  regionDocument,
  tokenDocument,
  timing = "custom",
  compatibility = {}
}) {
  const actor = tokenDocument?.actor ?? null;
  const saveResult = await rollZoneTriggeredActivitySave({
    activity,
    regionDocument,
    tokenDocument,
    timing,
    saveAbility: compatibility.saveAbility,
    saveDc: compatibility.saveDc
  });
  const damageRolls = compatibility.damagePartCount > 0
    ? await rollZoneTriggeredActivityDamage({
      activity,
      item,
      regionDocument,
      tokenDocument,
      timing
    })
    : [];
  const rawDamages = buildDamageEntriesFromRolls(damageRolls);
  const adjustedDamages = adjustDamageEntriesForSave(
    rawDamages,
    saveResult,
    String(activity?.damage?.onSave ?? "half").toLowerCase()
  );
  const appliedDamage = await applyDamageEntriesToActor(actor, adjustedDamages);

  return {
    triggered: Boolean(saveResult || adjustedDamages.length),
    activityType: compatibility.activityType ?? "save",
    save: saveResult,
    damage: {
      type: "activity",
      rollCount: Array.isArray(damageRolls) ? damageRolls.length : 0,
      damageCount: adjustedDamages.length,
      damages: adjustedDamages,
      appliedDamage,
      damageOnSave: String(activity?.damage?.onSave ?? "half").toLowerCase()
    }
  };
}

async function rollZoneTriggeredActivitySave({
  activity,
  regionDocument,
  tokenDocument,
  timing = "custom",
  saveAbility = null,
  saveDc = null
}) {
  const actor = tokenDocument?.actor ?? null;
  if (!actor || !saveAbility || saveDc === null || typeof actor.rollSavingThrow !== "function") {
    return null;
  }

  const rollResult = await actor.rollSavingThrow({
    ability: saveAbility,
    target: saveDc
  }, {
    configure: false
  }, {
    data: {
      flavor: `${regionDocument?.name ?? "Persistent Zone"}: ${timing} activity save`,
      speaker: ChatMessage.getSpeaker({ actor, token: tokenDocument })
    }
  });
  const saveRoll = Array.isArray(rollResult) ? rollResult[0] : rollResult;
  if (!saveRoll) {
    return null;
  }
  const total = coerceNumber(saveRoll?.total, null);
  const success = total !== null ? total >= saveDc : false;

  debug(`Calculated ${timing} activity save.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    actorUuid: actor?.uuid ?? null,
    timing,
    triggerMode: "activity",
    activityType: "save",
    ability: saveAbility,
    dc: saveDc,
    total,
    success
  });

  return {
    ability: saveAbility,
    dc: saveDc,
    total,
    success,
    onSuccess: String(activity?.damage?.onSave ?? "half").toLowerCase()
  };
}

async function rollZoneTriggeredActivityDamage({
  activity,
  item,
  regionDocument,
  tokenDocument,
  timing = "custom"
}) {
  if (typeof activity?.rollDamage !== "function") {
    return [];
  }

  const rolls = await activity.rollDamage({}, {
    configure: false
  }, {
    create: true,
    data: {
      flavor: `${item?.name ?? regionDocument?.name ?? "Persistent Zone"}: ${timing} activity damage`
    }
  });

  debug(`Calculated ${timing} activity damage.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    actorUuid: tokenDocument?.actor?.uuid ?? null,
    itemUuid: item?.uuid ?? null,
    timing,
    triggerMode: "activity",
    activityType: normalizeZoneTriggerActivityType(activity?.type ?? activity?.metadata?.type),
    rollCount: Array.isArray(rolls) ? rolls.length : 0
  });

  return Array.isArray(rolls) ? rolls : [];
}

function buildDamageEntriesFromRolls(rolls) {
  if (!Array.isArray(rolls) || !rolls.length) {
    return [];
  }

  return rolls
    .map((roll) => {
      const total = coerceNumber(roll?.total, 0);
      const damageType = roll?.options?.type ?? null;
      const isHealing = Boolean(damageType && CONFIG?.DND5E?.healingTypes?.[damageType]);
      const properties = Array.isArray(roll?.options?.properties)
        ? roll.options.properties
        : roll?.options?.properties instanceof Set
          ? Array.from(roll.options.properties)
          : [];

      return {
        value: isHealing ? -Math.max(total, 0) : Math.max(total, 0),
        type: damageType,
        properties: new Set(properties)
      };
    })
    .filter((entry) => entry.value !== 0);
}

function adjustDamageEntriesForSave(damages, saveResult, onSuccess = "half") {
  if (!Array.isArray(damages) || !damages.length || !saveResult?.success) {
    return Array.isArray(damages) ? damages : [];
  }

  return damages
    .map((entry) => {
      if (!entry || entry.value <= 0) {
        return entry;
      }

      return {
        ...entry,
        value: adjustDamageForSave(entry.value, {
          success: true,
          onSuccess
        })
      };
    })
    .filter((entry) => coerceNumber(entry?.value, 0) !== 0);
}

async function applyDamageEntriesToActor(actor, damages) {
  if (!actor || !Array.isArray(damages) || !damages.length) {
    return 0;
  }

  const calculatedDamage = typeof actor.calculateDamage === "function"
    ? actor.calculateDamage(damages)
    : null;
  const appliedDamage = coerceNumber(
    calculatedDamage?.amount,
    damages.reduce((sum, entry) => sum + coerceNumber(entry?.value, 0), 0)
  );

  if (typeof actor.applyDamage === "function") {
    await actor.applyDamage(damages);
    return appliedDamage;
  }

  await applyDamageToActor(actor, Math.max(appliedDamage, 0));
  return appliedDamage;
}

async function resolveSaveResult(actor, saveConfig, regionDocument, tokenDocument, timing = "custom") {
  const ability = String(saveConfig.ability ?? "").toLowerCase();
  const dc = await resolveConfiguredSaveDc(saveConfig, regionDocument);
  let roll = null;
  const timingLabel = String(timing || "custom");

  if (dc === null) {
    debug(`Skipped ${timingLabel} save because no DC could be resolved.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      actorUuid: actor?.uuid ?? null,
      timing: timingLabel,
      ability
    });

    return {
      ability,
      dc: null,
      total: null,
      success: false,
      unresolved: true,
      onSuccess: String(saveConfig.onSuccess ?? "half").toLowerCase()
    };
  }

  if (typeof actor.rollAbilitySave === "function") {
    roll = await actor.rollAbilitySave(ability, {
      chatMessage: true,
      fastForward: true,
      flavor: `${regionDocument?.name ?? "Persistent Zone"}: ${timingLabel} save`
    });
  } else {
    const bonus = getManualSaveBonus(actor, ability);
    roll = new Roll("1d20 + @bonus", { bonus });
    await roll.evaluate();
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor, token: tokenDocument }),
      flavor: `${regionDocument?.name ?? "Persistent Zone"}: ${timingLabel} save (${ability.toUpperCase()})`
    });
  }

  const total = coerceNumber(roll?.total, null);
  const success = total !== null && dc !== null ? total >= dc : false;

  const result = {
    ability,
    dc,
    total,
    success,
    onSuccess: String(saveConfig.onSuccess ?? "half").toLowerCase()
  };

  debug(`Calculated ${timingLabel} save.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    actorUuid: actor?.uuid ?? null,
    timing: timingLabel,
    ability: result.ability,
    dc: result.dc,
    total: result.total,
    success: result.success
  });

  return result;
}

async function resolveConfiguredSaveDc(saveConfig, regionDocument) {
  const dcMode = normalizeSaveDcMode(saveConfig?.dcMode, saveConfig?.dcSource, saveConfig?.dc);
  const explicitDc = coerceNumber(saveConfig?.dc, null);
  if (dcMode !== "auto") {
    return explicitDc;
  }

  const dcSource = normalizeSaveDcSource(saveConfig?.dcSource);
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const sourceActor = await resolveSaveSourceActor(dcSource, runtime);
  const resolvedDc = coerceNumber(
    pickFirstDefined(
      getActorSaveDc(sourceActor),
      runtime.dc,
      explicitDc
    ),
    null
  );

  debug("Resolved configured save DC.", {
    regionId: regionDocument?.id ?? null,
    dcMode,
    dcSource,
    sourceActorUuid: sourceActor?.uuid ?? null,
    resolvedDc,
    fallbackDc: coerceNumber(pickFirstDefined(runtime.dc, explicitDc), null)
  });

  return resolvedDc;
}

async function resolveDamageResult(damageConfig, saveResult, regionDocument, tokenDocument, timing = "custom") {
  const timingLabel = String(timing || "custom");
  const roll =
    damageConfig.formula
      ? new Roll(String(damageConfig.formula))
      : null;

  if (roll) {
    await roll.evaluate();
  }

  const rolledDamage = coerceNumber(roll?.total, damageConfig.amount ?? 0);
  const appliedDamage = adjustDamageForSave(rolledDamage, saveResult);

  if (roll) {
    await roll.toMessage({
      flavor: `Persistent Zones ${timingLabel} damage (${damageConfig.type ?? "untyped"})`
    });
  }

  const result = {
    type: damageConfig.type ?? "force",
    formula: damageConfig.formula ?? null,
    rolledDamage,
    appliedDamage
  };

  debug(`Calculated ${timingLabel} damage.`, {
    regionId: regionDocument?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    timing: timingLabel,
    type: result.type,
    formula: result.formula,
    rolledDamage: result.rolledDamage,
    appliedDamage: result.appliedDamage
  });

  return result;
}

function adjustDamageForSave(baseDamage, saveResult) {
  if (!saveResult?.success) {
    return baseDamage;
  }

  switch (saveResult.onSuccess) {
    case "none":
      return 0;
    case "half":
      return Math.floor(baseDamage / 2);
    case "full":
    default:
      return baseDamage;
  }
}

async function applyDamageToActor(actor, appliedDamage) {
  const hpValue = coerceNumber(actor?.system?.attributes?.hp?.value, null);
  if (hpValue === null) {
    return;
  }

  const tempHp = coerceNumber(actor?.system?.attributes?.hp?.temp, 0);
  let remainingDamage = appliedDamage;
  const newTempHp = Math.max(tempHp - remainingDamage, 0);
  remainingDamage -= tempHp - newTempHp;
  const newHpValue = Math.max(hpValue - remainingDamage, 0);

  await actor.update({
    "system.attributes.hp.temp": newTempHp,
    "system.attributes.hp.value": newHpValue
  });
}

function getManualSaveBonus(actor, ability) {
  return coerceNumber(
    pickFirstDefined(
      actor?.system?.abilities?.[ability]?.save,
      actor?.system?.abilities?.[ability]?.bonuses?.save,
      actor?.system?.abilities?.[ability]?.mod,
      0
    ),
    0
  );
}

async function resolveSaveSourceActor(dcSource, runtime) {
  const sourceOrder =
    dcSource === "actor"
      ? [runtime.actorUuid, runtime.casterUuid, runtime.itemUuid]
      : [runtime.casterUuid, runtime.actorUuid, runtime.itemUuid];

  for (const sourceUuid of sourceOrder) {
    if (!sourceUuid) {
      continue;
    }

    const resolvedDocument = await fromUuidSafe(sourceUuid);
    if (resolvedDocument?.documentName === "Actor") {
      return resolvedDocument;
    }

    if (resolvedDocument?.actor?.documentName === "Actor") {
      return resolvedDocument.actor;
    }
  }

  return null;
}

function getActorSaveDc(actor) {
  return coerceNumber(
    pickFirstDefined(
      actor?.system?.attributes?.spell?.dc,
      actor?.system?.attributes?.spelldc,
      actor?.system?.attributes?.spellcasting?.dc,
      actor?.system?.spells?.spellcasting?.dc,
      actor?.system?.spells?.dc
    ),
    null
  );
}

function normalizeSaveDcMode(dcMode, dcSource, dc) {
  if (String(dcMode ?? "").toLowerCase() === "auto") {
    return "auto";
  }

  if (dcSource) {
    return "auto";
  }

  return dc === null || dc === undefined ? "manual" : "manual";
}

function normalizeSaveDcSource(value) {
  const normalized = String(value ?? "caster").toLowerCase();
  return ["caster", "actor", "token"].includes(normalized) ? normalized : "caster";
}

function resolveTriggerEffectMode(triggerConfig = {}) {
  const explicitMode = String(triggerConfig?.mode ?? "").trim().toLowerCase();
  if (["none", "simple", "activity"].includes(explicitMode)) {
    return explicitMode;
  }

  if (triggerConfig?.activity?.id) {
    return "activity";
  }

  return "simple";
}

async function resolveRuntimeItem(runtime = {}) {
  const resolvedItem = await fromUuidSafe(runtime?.itemUuid ?? null);
  if (resolvedItem?.documentName === "Item") {
    return resolvedItem;
  }

  if (resolvedItem?.item?.documentName === "Item") {
    return resolvedItem.item;
  }

  return null;
}

function resolveItemActivity(item, activityConfig = {}) {
  const activityId = String(activityConfig?.id ?? "").trim();
  const activityUuid = String(activityConfig?.uuid ?? "").trim();
  const activityName = String(activityConfig?.name ?? "").trim().toLowerCase();

  if (!item?.system?.activities) {
    return null;
  }

  if (activityId && typeof item.system.activities.get === "function") {
    const directActivity = item.system.activities.get(activityId);
    if (directActivity) {
      return directActivity;
    }
  }

  const activities = Array.from(item.system.activities ?? [])
    .map((entry) => Array.isArray(entry) ? entry[1] : entry)
    .filter(Boolean);

  return activities.find((activity) => {
    if (activityId && String(activity?.id ?? "").trim() === activityId) {
      return true;
    }

    if (activityUuid && String(activity?.uuid ?? "").trim() === activityUuid) {
      return true;
    }

    if (activityName && String(activity?.name ?? "").trim().toLowerCase() === activityName) {
      return true;
    }

    return false;
  }) ?? null;
}

function buildSkippedResult(reason, extra = {}) {
  return {
    applied: false,
    skipped: true,
    reason,
    ...extra
  };
}

function buildNoDamageResult(damageConfig = {}) {
  return {
    type: damageConfig?.type ?? "force",
    formula: damageConfig?.formula ?? null,
    rolledDamage: 0,
    appliedDamage: 0
  };
}
