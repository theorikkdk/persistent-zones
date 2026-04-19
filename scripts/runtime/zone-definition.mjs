import {
  DEFAULT_CONCENTRATION_STATUS_ID,
  DEFAULT_ZONE_LABEL,
  DEFINITION_FLAG_KEY,
  MODULE_ID,
  NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE,
  NORMALIZED_DEFINITION_VERSION,
  STANDARD_DIFFICULT_TERRAIN_MULTIPLIER,
  SUPPORTED_TEMPLATE_TYPES
} from "../constants.mjs";
import {
  coerceBoolean,
  coerceNumber,
  debug,
  duplicateData,
  isPlainObject,
  pickFirstDefined,
  safeGet
} from "./utils.mjs";
import {
  resolveLinkedLightConfig,
  resolveLinkedWallConfig
} from "./linked-presets.mjs";

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
  const terrainDefinition = isPlainObject(definition.terrain) ? definition.terrain : {};
  const movementCostDefinition = isPlainObject(definition.movementCost) ? definition.movementCost : {};
  const linkedWallsDefinition = isPlainObject(definition.linkedWalls) ? definition.linkedWalls : {};
  const linkedLightDefinition = isPlainObject(definition.linkedLight)
    ? definition.linkedLight
    : isPlainObject(definition.linkedLights)
      ? definition.linkedLights
      : {};

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
    terrain: normalizeTerrain({
      terrainDefinition,
      movementCostDefinition,
      definition
    }),
    linkedWalls: normalizeLinkedWalls(linkedWallsDefinition),
    linkedLight: normalizeLinkedLight(linkedLightDefinition, {
      templateDistance: pickFirstDefined(templateDefinition.distance, definition.distance, templateDocument?.distance)
    }),
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

  if (
    definition.difficultTerrain !== undefined ||
    definition.terrain !== undefined ||
    definition.movementCost !== undefined ||
    normalizedDefinition.terrain.difficult
  ) {
    debug("Normalized zone terrain configuration.", {
      itemUuid: normalizedDefinition.itemUuid ?? null,
      label: normalizedDefinition.label,
      terrain: normalizedDefinition.terrain
    });
  }

  if (
    definition.linkedWalls !== undefined ||
    definition.linkedLight !== undefined ||
    definition.linkedLights !== undefined ||
    normalizedDefinition.linkedWalls.enabled ||
    normalizedDefinition.linkedLight.enabled
  ) {
    debug("Normalized linked document configuration.", {
      itemUuid: normalizedDefinition.itemUuid ?? null,
      label: normalizedDefinition.label,
      linkedWalls: normalizedDefinition.linkedWalls,
      linkedLight: normalizedDefinition.linkedLight
    });
  }

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

function normalizeTerrain({
  terrainDefinition,
  movementCostDefinition,
  definition
}) {
  const difficult = coerceBoolean(
    pickFirstDefined(
      terrainDefinition.difficult,
      terrainDefinition.enabled,
      movementCostDefinition.enabled,
      definition.difficultTerrain,
      false
    ),
    false
  );

  const multiplier = difficult
    ? coerceNumber(
      pickFirstDefined(
        terrainDefinition.multiplier,
        movementCostDefinition.multiplier,
        movementCostDefinition.costMultiplier,
        STANDARD_DIFFICULT_TERRAIN_MULTIPLIER
      ),
      STANDARD_DIFFICULT_TERRAIN_MULTIPLIER
    )
    : null;

  return {
    difficult,
    multiplier,
    behaviorType: difficult ? NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE : null,
    system: {
      magical: coerceBoolean(
        pickFirstDefined(
          terrainDefinition.magical,
          movementCostDefinition.magical,
          false
        ),
        false
      ),
      types: normalizeStringArray(
        pickFirstDefined(
          terrainDefinition.types,
          movementCostDefinition.types,
          []
        )
      ),
      ignoredDispositions: normalizeNumberArray(
        pickFirstDefined(
          terrainDefinition.ignoredDispositions,
          movementCostDefinition.ignoredDispositions,
          []
        )
      )
    }
  };
}

function normalizeLinkedWalls(linkedWallsDefinition) {
  const hasExplicitConfig = isPlainObject(linkedWallsDefinition) && Object.keys(linkedWallsDefinition).length > 0;
  const finalConfig = resolveLinkedWallConfig(linkedWallsDefinition);

  if (hasExplicitConfig || finalConfig.enabled || finalConfig.resolvedPreset) {
    debug("Resolved final linked wall config.", {
      finalConfig
    });
  }

  return finalConfig;
}

function normalizeLinkedLight(linkedLightDefinition, {
  templateDistance = null
} = {}) {
  const hasExplicitConfig = isPlainObject(linkedLightDefinition) && Object.keys(linkedLightDefinition).length > 0;
  const finalConfig = resolveLinkedLightConfig(linkedLightDefinition, {
    templateDistance
  });

  if (hasExplicitConfig || finalConfig.enabled || finalConfig.resolvedPreset) {
    debug("Resolved final linked light config.", {
      finalConfig
    });
  }

  return finalConfig;
}

function normalizeTriggers(triggerDefinition, dc) {
  const startTurnDefinition = pickFirstDefined(
    triggerDefinition.onStartTurn,
    triggerDefinition.onTurnStart
  );
  const endTurnDefinition = pickFirstDefined(
    triggerDefinition.onEndTurn,
    triggerDefinition.onTurnEnd
  );
  const moveDefinition = pickFirstDefined(
    triggerDefinition.onMove,
    triggerDefinition.onMovement
  );

  return {
    onEnter: normalizeTriggerConfig(triggerDefinition.onEnter, dc),
    onExit: normalizeTriggerConfig(triggerDefinition.onExit, dc),
    onMove: normalizeTriggerConfig(moveDefinition, dc),
    onStartTurn: normalizeTriggerConfig(startTurnDefinition, dc),
    onEndTurn: normalizeTriggerConfig(endTurnDefinition, dc)
  };
}

function normalizeTriggerConfig(triggerLikeDefinition, dc) {
  const definition = isPlainObject(triggerLikeDefinition) ? triggerLikeDefinition : {};
  const damageDefinition = isPlainObject(definition.damage) ? definition.damage : {};
  const saveDefinition = isPlainObject(definition.save) ? definition.save : {};

  return {
    enabled: coerceBoolean(
      pickFirstDefined(definition.enabled, definition.active, false),
      false
    ),
    movementMode: normalizeMovementMode(
      pickFirstDefined(definition.movementMode, "any")
    ),
    distanceStep: coerceNumber(
      pickFirstDefined(
        definition.distanceStep,
        definition.stepDistance,
        definition.distanceEvery
      ),
      null
    ),
    stopMovementOnTrigger: coerceBoolean(
      pickFirstDefined(
        definition.stopMovementOnTrigger,
        definition.stopOnTrigger,
        false
      ),
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
  const onExit = normalizedDefinition.triggers.onExit;
  const onMove = normalizedDefinition.triggers.onMove;
  const onStartTurn = normalizedDefinition.triggers.onStartTurn;
  const onEndTurn = normalizedDefinition.triggers.onEndTurn;

  validateTriggerConfig("onEnter", onEnter, reasons);
  validateTriggerConfig("onExit", onExit, reasons);
  validateTriggerConfig("onMove", onMove, reasons, { requireDistanceStep: true });
  validateTriggerConfig("onStartTurn", onStartTurn, reasons);
  validateTriggerConfig("onEndTurn", onEndTurn, reasons);

  return reasons;
}

function collectCurrentLimits(definition) {
  const limits = [];

  if (safeGet(definition, ["movement"]) !== undefined) {
    limits.push("Movement-through-zone logic is not executed in this MVP step.");
  }

  if (safeGet(definition, ["forcedMovement"]) !== undefined) {
    limits.push("Forced movement is not executed in this MVP step.");
  }

  if (
    safeGet(definition, ["terrain", "multiplier"]) !== undefined ||
    safeGet(definition, ["movementCost", "multiplier"]) !== undefined ||
    safeGet(definition, ["movementCost", "costMultiplier"]) !== undefined
  ) {
    limits.push("Custom movement cost multipliers are not yet supported; standard difficult terrain is used when enabled.");
  }

  if (safeGet(definition, ["linkedWalls"]) !== undefined) {
    limits.push("Linked walls are limited to compatible circle, rectangle, and polygon region shapes in this MVP.");
  }

  if (
    safeGet(definition, ["linkedLight"]) !== undefined ||
    safeGet(definition, ["linkedLights"]) !== undefined
  ) {
    limits.push("Linked light uses a single native AmbientLight with simple position and bright/dim settings in this MVP.");
  }

  return limits;
}

function validateTriggerConfig(triggerName, triggerConfig, reasons, {
  requireDistanceStep = false
} = {}) {
  if (!triggerConfig?.enabled) {
    return;
  }

  if (requireDistanceStep) {
    if (triggerConfig.distanceStep === null || triggerConfig.distanceStep <= 0) {
      reasons.push(`${triggerName} requires a positive distanceStep.`);
    }
  }

  if (!triggerConfig.damage.enabled && !triggerConfig.save.enabled) {
    reasons.push(`${triggerName} requires damage or save to be enabled.`);
    return;
  }

  if (triggerConfig.damage.enabled) {
    if (!triggerConfig.damage.formula && triggerConfig.damage.amount === null) {
      reasons.push(`${triggerName} damage requires a formula or amount.`);
    }
  }

  if (triggerConfig.save.enabled) {
    if (!triggerConfig.save.ability) {
      reasons.push(`${triggerName} save requires an ability.`);
    }
    if (triggerConfig.save.dc === null) {
      reasons.push(`${triggerName} save requires a DC.`);
    }
  }
}

function normalizeMovementMode(value) {
  const normalized = String(value ?? "any").toLowerCase();
  return ["any", "voluntary", "forced"].includes(normalized) ? normalized : "any";
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean);
}

function normalizeNumberArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => coerceNumber(value, null))
    .filter((value) => value !== null);
}
