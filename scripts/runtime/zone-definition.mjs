import {
  DEFAULT_CONCENTRATION_STATUS_ID,
  DEFAULT_ZONE_LABEL,
  DEFINITION_FLAG_KEY,
  MODULE_ID,
  NORMALIZED_DEFINITION_VERSION,
  SUPPORTED_TEMPLATE_TYPES
} from "../constants.mjs";
import {
  coerceBoolean,
  coerceNumber,
  duplicateData,
  isPlainObject,
  pickFirstDefined,
  safeGet
} from "./utils.mjs";

export function getZoneDefinitionFromItem(item) {
  if (!item) {
    return null;
  }

  return (
    duplicateData(
      item.getFlag?.(MODULE_ID, DEFINITION_FLAG_KEY) ??
        item?.flags?.[MODULE_ID]?.[DEFINITION_FLAG_KEY]
    ) ?? null
  );
}

export function normalizeZoneDefinition(
  rawDefinition,
  {
    item = null,
    actor = null,
    caster = null,
    templateDocument = null
  } = {}
) {
  const sourceDefinition = duplicateData(rawDefinition);
  const definition = isPlainObject(sourceDefinition) ? sourceDefinition : {};
  const templateDefinition = isPlainObject(definition.template) ? definition.template : {};
  const concentrationDefinition = isPlainObject(definition.concentration)
    ? definition.concentration
    : {};
  const triggerDefinition = isPlainObject(definition.triggers) ? definition.triggers : {};

  const templateType = String(
    pickFirstDefined(
      templateDocument?.t,
      templateDefinition.type,
      definition.templateType,
      definition.shape,
      ""
    )
  ).toLowerCase();

  const actorUuid = pickFirstDefined(
    actor?.uuid,
    definition.actorUuid,
    item?.actor?.uuid
  );

  const casterUuid = pickFirstDefined(
    caster?.uuid,
    definition.casterUuid,
    actorUuid
  );

  const dc = coerceNumber(
    pickFirstDefined(
      definition.dc,
      safeGet(definition, ["save", "dc"]),
      safeGet(item, ["system", "save", "dc"])
    ),
    null
  );

  const castLevel = coerceNumber(
    pickFirstDefined(
      definition.castLevel,
      definition.level,
      safeGet(item, ["system", "level"])
    ),
    null
  );

  const concentration = {
    required: coerceBoolean(
      pickFirstDefined(
        concentrationDefinition.required,
        definition.requiresConcentration,
        definition.concentrationRequired,
        safeGet(item, ["system", "concentration"]),
        safeGet(item, ["system", "properties", "concentration"])
      ),
      null
    ),
    effectUuid: pickFirstDefined(
      concentrationDefinition.effectUuid,
      definition.concentrationEffectUuid
    ),
    effectId: pickFirstDefined(
      concentrationDefinition.effectId,
      definition.concentrationEffectId
    ),
    actorUuid: pickFirstDefined(
      concentrationDefinition.actorUuid,
      casterUuid,
      actorUuid
    ),
    statusId: pickFirstDefined(
      concentrationDefinition.statusId,
      DEFAULT_CONCENTRATION_STATUS_ID
    ),
    originUuid: pickFirstDefined(
      concentrationDefinition.originUuid,
      item?.uuid
    )
  };

  const normalizedDefinition = {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: normalizeSource(definition.source),
    enabled: coerceBoolean(
      pickFirstDefined(definition.enabled, definition.active, true),
      true
    ),
    label: pickFirstDefined(definition.label, definition.name, item?.name, DEFAULT_ZONE_LABEL),
    itemUuid: pickFirstDefined(definition.itemUuid, item?.uuid, null),
    actorUuid: actorUuid ?? null,
    casterUuid: casterUuid ?? null,
    dc,
    castLevel,
    shapeMode: String(
      pickFirstDefined(definition.shapeMode, "template")
    ).toLowerCase(),
    template: {
      type: templateType || null,
      distance: coerceNumber(
        pickFirstDefined(templateDefinition.distance, definition.distance, templateDocument?.distance),
        null
      ),
      angle: coerceNumber(
        pickFirstDefined(templateDefinition.angle, definition.angle, templateDocument?.angle),
        null
      ),
      direction: coerceNumber(
        pickFirstDefined(templateDefinition.direction, definition.direction, templateDocument?.direction),
        null
      ),
      width: coerceNumber(
        pickFirstDefined(templateDefinition.width, definition.width, templateDocument?.width),
        null
      ),
      elevation: coerceNumber(
        pickFirstDefined(templateDefinition.elevation, definition.elevation, templateDocument?.elevation),
        0
      )
    },
    concentration,
    targeting: normalizeTargeting(definition.targeting),
    triggers: normalizeTriggers(triggerDefinition, dc),
    limits: collectCurrentLimits(definition),
    validation: {
      isValid: true,
      reasons: []
    }
  };

  normalizedDefinition.validation.reasons = collectValidationReasons({
    sourceDefinition,
    normalizedDefinition
  });
  normalizedDefinition.validation.isValid =
    normalizedDefinition.validation.reasons.length === 0;

  return normalizedDefinition;
}

function normalizeSource(sourceDefinition) {
  if (!isPlainObject(sourceDefinition)) {
    return {
      type: "item-flag",
      module: MODULE_ID
    };
  }

  return {
    type: pickFirstDefined(sourceDefinition.type, "item-flag"),
    module: pickFirstDefined(sourceDefinition.module, MODULE_ID)
  };
}

function normalizeTargeting(targetingDefinition) {
  const definition = isPlainObject(targetingDefinition) ? targetingDefinition : {};

  return {
    mode: String(pickFirstDefined(definition.mode, "all")).toLowerCase(),
    includeSelf: coerceBoolean(pickFirstDefined(definition.includeSelf, true), true)
  };
}

function normalizeTriggers(triggerDefinition, dc) {
  return {
    onEnter: normalizeOnEnter(triggerDefinition.onEnter, dc)
  };
}

function normalizeOnEnter(onEnterDefinition, dc) {
  const definition = isPlainObject(onEnterDefinition) ? onEnterDefinition : {};
  const damageDefinition = isPlainObject(definition.damage) ? definition.damage : {};
  const saveDefinition = isPlainObject(definition.save) ? definition.save : {};

  return {
    enabled: coerceBoolean(
      pickFirstDefined(definition.enabled, definition.active, false),
      false
    ),
    damage: {
      enabled: coerceBoolean(
        pickFirstDefined(damageDefinition.enabled, definition.damage, false),
        false
      ),
      formula: pickFirstDefined(damageDefinition.formula, damageDefinition.roll, null),
      amount: coerceNumber(damageDefinition.amount, null),
      type: pickFirstDefined(damageDefinition.type, "force")
    },
    save: {
      enabled: coerceBoolean(
        pickFirstDefined(saveDefinition.enabled, false),
        false
      ),
      ability: String(pickFirstDefined(saveDefinition.ability, saveDefinition.abilityId, "")).toLowerCase() || null,
      dc: coerceNumber(pickFirstDefined(saveDefinition.dc, dc), null),
      onSuccess: String(pickFirstDefined(saveDefinition.onSuccess, "half")).toLowerCase()
    }
  };
}

function collectValidationReasons({ sourceDefinition, normalizedDefinition }) {
  const reasons = [];

  if (!isPlainObject(sourceDefinition)) {
    reasons.push('flags["persistent-zones"].definition must be an object.');
  }

  if (!normalizedDefinition.template.type) {
    reasons.push("Template type could not be determined.");
  } else if (!SUPPORTED_TEMPLATE_TYPES.includes(normalizedDefinition.template.type)) {
    reasons.push(`Template type "${normalizedDefinition.template.type}" is not supported by this MVP.`);
  }

  if (normalizedDefinition.shapeMode !== "template") {
    reasons.push(`shapeMode "${normalizedDefinition.shapeMode}" is not supported by this MVP.`);
  }

  const onEnter = normalizedDefinition.triggers.onEnter;
  if (onEnter.enabled && onEnter.damage.enabled) {
    if (!onEnter.damage.formula && onEnter.damage.amount === null) {
      reasons.push("onEnter damage requires a formula or amount.");
    }
  }

  if (onEnter.enabled && onEnter.save.enabled) {
    if (!onEnter.save.ability) {
      reasons.push("onEnter save requires an ability.");
    }
    if (onEnter.save.dc === null) {
      reasons.push("onEnter save requires a DC.");
    }
  }

  return reasons;
}

function collectCurrentLimits(definition) {
  const limits = [];

  if (safeGet(definition, ["triggers", "onTurnStart"]) !== undefined) {
    limits.push("Turn start logic is not executed in this MVP step.");
  }

  if (safeGet(definition, ["triggers", "onTurnEnd"]) !== undefined) {
    limits.push("Turn end logic is not executed in this MVP step.");
  }

  if (safeGet(definition, ["movement"]) !== undefined) {
    limits.push("Movement-through-zone logic is not executed in this MVP step.");
  }

  if (safeGet(definition, ["forcedMovement"]) !== undefined) {
    limits.push("Forced movement is not executed in this MVP step.");
  }

  if (safeGet(definition, ["difficultTerrain"]) !== undefined) {
    limits.push("Difficult terrain is not executed in this MVP step.");
  }

  if (safeGet(definition, ["linkedWalls"]) !== undefined) {
    limits.push("Linked walls are not created in this MVP step.");
  }

  if (safeGet(definition, ["linkedLights"]) !== undefined) {
    limits.push("Linked lights are not created in this MVP step.");
  }

  return limits;
}
