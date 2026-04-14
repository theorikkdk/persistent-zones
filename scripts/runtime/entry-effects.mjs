import { debug, coerceNumber, error, pickFirstDefined } from "./utils.mjs";

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

  if (!actor) {
    return buildSkippedResult("Token has no Actor.");
  }

  if (!configuredTrigger.enabled) {
    return buildSkippedResult(`${normalizedTiming} is not enabled.`);
  }

  if (!configuredTrigger.damage?.enabled && !configuredTrigger.save?.enabled) {
    return buildSkippedResult(`${normalizedTiming} has no enabled save or damage.`);
  }

  try {
    const saveResult = configuredTrigger.save?.enabled
      ? await resolveSaveResult(actor, configuredTrigger.save, regionDocument, tokenDocument, normalizedTiming)
      : null;
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

    debug(`Applied ${normalizedTiming} effect.`, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      actorUuid: actor.uuid,
      timing: normalizedTiming,
      save: saveResult,
      damage: damageResult,
      appliedDamage
    });

    return {
      applied: Boolean(saveResult || configuredTrigger.damage?.enabled),
      skipped: false,
      timing: normalizedTiming,
      save: saveResult,
      damage: damageResult,
      appliedDamage
    };
  } catch (caughtError) {
    error("Failed to apply configured trigger effect.", caughtError, {
      regionId: regionDocument?.id ?? null,
      tokenId: tokenDocument?.id ?? null,
      timing: normalizedTiming
    });

    return buildSkippedResult("Effect application failed.", {
      timing: normalizedTiming,
      error: caughtError?.message ?? "unknown"
    });
  }
}

async function resolveSaveResult(actor, saveConfig, regionDocument, tokenDocument, timing = "custom") {
  const ability = String(saveConfig.ability ?? "").toLowerCase();
  const dc = coerceNumber(saveConfig.dc, null);
  let roll = null;
  const timingLabel = String(timing || "custom");

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
