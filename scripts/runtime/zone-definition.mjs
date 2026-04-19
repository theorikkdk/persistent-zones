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
    geometry: normalizeGeometryDefinition(null, {
      templateDocument,
      templateDefinition,
      definition
    }),
    limits: collectCurrentLimits(definition),
    parts: [],
    group: {
      mode: "single",
      partCount: 0
    },
    validation: {
      isValid: true,
      reasons: []
    }
  };

  normalizedDefinition.parts = normalizeZoneParts({
    definition,
    normalizedDefinition,
    templateDocument,
    templateDefinition,
    triggerDefinition,
    terrainDefinition,
    movementCostDefinition,
    linkedWallsDefinition,
    linkedLightDefinition,
    dc
  });
  normalizedDefinition.group = {
    mode: normalizedDefinition.parts.length > 1 ? "parts" : "single",
    partCount: normalizedDefinition.parts.length
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

function normalizeZoneParts({
  definition,
  normalizedDefinition,
  templateDocument,
  templateDefinition,
  triggerDefinition,
  terrainDefinition,
  movementCostDefinition,
  linkedWallsDefinition,
  linkedLightDefinition,
  dc
}) {
  const sourceParts = Array.isArray(definition.parts)
    ? definition.parts
    : Array.isArray(definition.zones)
      ? definition.zones
      : [];

  if (!sourceParts.length) {
    return [buildDefaultZonePart(normalizedDefinition)];
  }

  return sourceParts.map((partDefinition, index) => normalizeZonePart(partDefinition, index, {
    normalizedDefinition,
    templateDocument,
    templateDefinition,
    triggerDefinition,
    terrainDefinition,
    movementCostDefinition,
    linkedWallsDefinition,
    linkedLightDefinition,
    dc
  }));
}

function buildDefaultZonePart(normalizedDefinition) {
  return {
    id: "primary",
    label: normalizedDefinition.label,
    geometry: duplicateData(normalizedDefinition.geometry),
    targeting: duplicateData(normalizedDefinition.targeting),
    terrain: duplicateData(normalizedDefinition.terrain),
    linkedWalls: duplicateData(normalizedDefinition.linkedWalls),
    linkedLight: duplicateData(normalizedDefinition.linkedLight),
    triggers: duplicateData(normalizedDefinition.triggers)
  };
}

function normalizeZonePart(partLikeDefinition, index, {
  normalizedDefinition,
  templateDocument,
  templateDefinition,
  triggerDefinition,
  terrainDefinition,
  movementCostDefinition,
  linkedWallsDefinition,
  linkedLightDefinition,
  dc
}) {
  const partDefinition = isPlainObject(partLikeDefinition) ? partLikeDefinition : {};
  const mergedTriggerDefinition = mergePlainObjects(triggerDefinition, partDefinition.triggers);
  const mergedTerrainDefinition = mergePlainObjects(
    terrainDefinition,
    isPlainObject(partDefinition.terrain) ? partDefinition.terrain : {}
  );
  const mergedMovementCostDefinition = mergePlainObjects(
    movementCostDefinition,
    isPlainObject(partDefinition.movementCost) ? partDefinition.movementCost : {}
  );
  const mergedLinkedWallsDefinition = mergePlainObjects(
    linkedWallsDefinition,
    isPlainObject(partDefinition.linkedWalls) ? partDefinition.linkedWalls : {}
  );
  const mergedLinkedLightDefinition = mergePlainObjects(
    linkedLightDefinition,
    isPlainObject(partDefinition.linkedLight)
      ? partDefinition.linkedLight
      : isPlainObject(partDefinition.linkedLights)
        ? partDefinition.linkedLights
        : {}
  );
  const mergedTargetingDefinition = mergePlainObjects(
    normalizedDefinition.targeting,
    isPlainObject(partDefinition.targeting) ? partDefinition.targeting : {}
  );

  return {
    id: pickFirstDefined(partDefinition.id, partDefinition.key, `part-${index + 1}`),
    label: pickFirstDefined(partDefinition.label, partDefinition.name, normalizedDefinition.label),
    geometry: normalizeGeometryDefinition(partDefinition.geometry, {
      templateDocument,
      templateDefinition,
      definition: partDefinition
    }),
    targeting: normalizeTargeting(mergedTargetingDefinition),
    terrain: normalizeTerrain({
      terrainDefinition: mergedTerrainDefinition,
      movementCostDefinition: mergedMovementCostDefinition,
      definition: partDefinition
    }),
    linkedWalls: normalizeLinkedWalls(mergedLinkedWallsDefinition),
    linkedLight: normalizeLinkedLight(mergedLinkedLightDefinition, {
      templateDistance: pickFirstDefined(
        templateDefinition.distance,
        normalizedDefinition.template?.distance,
        templateDocument?.distance
      )
    }),
    triggers: normalizeTriggers(mergedTriggerDefinition, dc)
  };
}

function normalizeGeometryDefinition(geometryLikeDefinition, {
  templateDocument = null,
  templateDefinition = {},
  definition = {}
} = {}) {
  const geometryDefinition = isPlainObject(geometryLikeDefinition) ? geometryLikeDefinition : {};
  const geometryType = String(
    pickFirstDefined(
      geometryDefinition.type,
      geometryDefinition.mode,
      geometryDefinition.kind,
      "template"
    )
  ).toLowerCase();

  if (geometryType === "ring" || geometryType === "annulus") {
    const templateDistance = coerceNumber(
      pickFirstDefined(
        templateDefinition.distance,
        definition.distance,
        templateDocument?.distance
      ),
      null
    );
    const outerRadiusRatio = coerceNumber(
      pickFirstDefined(
        geometryDefinition.outerRadiusRatio,
        geometryDefinition.outerRatio
      ),
      null
    );
    const innerRadiusRatio = coerceNumber(
      pickFirstDefined(
        geometryDefinition.innerRadiusRatio,
        geometryDefinition.innerRatio
      ),
      null
    );
    const defaultOuterRadius = coerceNumber(
      pickFirstDefined(
        geometryDefinition.outerRadius,
        geometryDefinition.outer,
        geometryDefinition.radius,
        outerRadiusRatio !== null && templateDistance !== null
          ? templateDistance * outerRadiusRatio
          : null,
        templateDistance
      ),
      null
    );
    const defaultInnerRadius = coerceNumber(
      pickFirstDefined(
        geometryDefinition.innerRadius,
        geometryDefinition.inner,
        geometryDefinition.holeRadius,
        innerRadiusRatio !== null && templateDistance !== null
          ? templateDistance * innerRadiusRatio
          : null,
        0
      ),
      0
    );

    return {
      type: "ring",
      centerMode: "template",
      innerRadius: defaultInnerRadius === null ? null : Math.max(0, defaultInnerRadius),
      innerRadiusRatio,
      outerRadius: defaultOuterRadius,
      outerRadiusRatio,
      segments: normalizeRingSegmentCount(
        pickFirstDefined(geometryDefinition.segments, geometryDefinition.segmentCount, 24)
      )
    };
  }

  if (geometryType === "side-of-line" || geometryType === "sideofline") {
    const templateDistance = coerceNumber(
      pickFirstDefined(
        templateDefinition.distance,
        definition.distance,
        templateDocument?.distance
      ),
      null
    );
    const offsetStart = coerceNumber(
      pickFirstDefined(
        geometryDefinition.offsetStart,
        geometryDefinition.startOffset,
        0
      ),
      0
    );
    const offsetEnd = coerceNumber(
      pickFirstDefined(
        geometryDefinition.offsetEnd,
        geometryDefinition.endOffset,
        geometryDefinition.sideDistance,
        geometryDefinition.distance,
        geometryDefinition.width,
        geometryDefinition.depth
      ),
      null
    );

    return {
      type: "side-of-line",
      axisMode: "template",
      offsetReference: normalizeOffsetReferenceMode(
        pickFirstDefined(
          geometryDefinition.offsetReference,
          geometryDefinition.referenceMode,
          geometryDefinition.anchorMode,
          "axis"
        )
      ),
      side: normalizeDirectionalSide(
        pickFirstDefined(
          geometryDefinition.side,
          geometryDefinition.facing,
          geometryDefinition.zoneSide,
          "left"
        )
      ),
      offsetStart: Math.max(0, offsetStart),
      offsetEnd,
      axisLength: coerceNumber(
        pickFirstDefined(
          geometryDefinition.axisLength,
          geometryDefinition.length,
          templateDistance
        ),
        null
      )
    };
  }

  return {
    type: "template"
  };
}

function normalizeRingSegmentCount(value) {
  const numericValue = Math.round(coerceNumber(value, 24));
  return Math.min(Math.max(numericValue, 8), 64);
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

  if (!Array.isArray(normalizedDefinition.parts) || !normalizedDefinition.parts.length) {
    reasons.push("At least one zone part must be available after normalization.");
  } else {
    normalizedDefinition.parts.forEach((part, index) => {
      validateZonePartConfig(part, index, reasons, {
        templateType: normalizedDefinition.template.type
      });
    });
  }

  return reasons;
}

function collectCurrentLimits(definition) {
  const limits = [];
  const hasRingGeometry =
    safeGet(definition, ["geometry", "type"]) === "ring" ||
    safeGet(definition, ["geometry", "type"]) === "annulus" ||
    Array.isArray(definition.parts) &&
      definition.parts.some((part) => {
        const type = safeGet(part, ["geometry", "type"]);
        return type === "ring" || type === "annulus";
      }) ||
    Array.isArray(definition.zones) &&
      definition.zones.some((part) => {
        const type = safeGet(part, ["geometry", "type"]);
        return type === "ring" || type === "annulus";
      });
  const hasSideOfLineGeometry =
    safeGet(definition, ["geometry", "type"]) === "side-of-line" ||
    Array.isArray(definition.parts) &&
      definition.parts.some((part) => safeGet(part, ["geometry", "type"]) === "side-of-line") ||
    Array.isArray(definition.zones) &&
      definition.zones.some((part) => safeGet(part, ["geometry", "type"]) === "side-of-line");

  if (safeGet(definition, ["movement"]) !== undefined) {
    limits.push("Movement-through-zone logic is not executed in this MVP step.");
  }

  if (Array.isArray(definition.parts) || Array.isArray(definition.zones)) {
    limits.push("Multi-part zones currently create one managed Region per part.");
  }

  if (hasRingGeometry) {
    limits.push("Ring geometry is approximated with multiple polygon shapes inside one Region part in this MVP.");
  }

  if (hasSideOfLineGeometry) {
    limits.push("side-of-line currently derives its reference axis from the template direction and is primarily intended for ray-like templates in this MVP.");
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

function validateZonePartConfig(part, index, reasons, {
  templateType = null
} = {}) {
  if (!part?.id) {
    reasons.push(`Part ${index + 1} requires an id.`);
  }

  const geometryType = String(part?.geometry?.type ?? "template").toLowerCase();
  if (!["template", "ring", "side-of-line"].includes(geometryType)) {
    reasons.push(`Part "${part?.id ?? index + 1}" uses unsupported geometry "${geometryType}".`);
    return;
  }

  if (geometryType === "ring") {
    const innerRadius = coerceNumber(part?.geometry?.innerRadius, null);
    const outerRadius = coerceNumber(part?.geometry?.outerRadius, null);
    const innerRadiusRatio = coerceNumber(part?.geometry?.innerRadiusRatio, null);

    if (outerRadius !== null && outerRadius <= 0) {
      reasons.push(`Part "${part?.id ?? index + 1}" ring geometry requires a positive outerRadius.`);
    }

    if ((innerRadius === null && innerRadiusRatio === null) || (innerRadius !== null && innerRadius < 0)) {
      reasons.push(`Part "${part?.id ?? index + 1}" ring geometry requires an innerRadius greater than or equal to 0.`);
    }

    if (innerRadius !== null && outerRadius !== null && innerRadius >= outerRadius) {
      reasons.push(`Part "${part?.id ?? index + 1}" ring geometry requires innerRadius to be smaller than outerRadius.`);
    }
  }

  if (geometryType === "side-of-line") {
    const side = normalizeDirectionalSide(part?.geometry?.side);
    const offsetReference = normalizeOffsetReferenceMode(part?.geometry?.offsetReference);
    const offsetStart = coerceNumber(part?.geometry?.offsetStart, null);
    const offsetEnd = coerceNumber(part?.geometry?.offsetEnd, null);
    const axisLength = coerceNumber(part?.geometry?.axisLength, null);

    if (!["left", "right"].includes(side)) {
      reasons.push(`Part "${part?.id ?? index + 1}" side-of-line geometry requires side to be "left" or "right".`);
    }

    if (!["axis", "body-edge"].includes(offsetReference)) {
      reasons.push(`Part "${part?.id ?? index + 1}" side-of-line geometry requires offsetReference to be "axis" or "body-edge".`);
    }

    if (offsetStart === null || offsetStart < 0) {
      reasons.push(`Part "${part?.id ?? index + 1}" side-of-line geometry requires offsetStart to be greater than or equal to 0.`);
    }

    if (offsetEnd === null || offsetEnd <= 0) {
      reasons.push(`Part "${part?.id ?? index + 1}" side-of-line geometry requires a positive offsetEnd.`);
    }

    if (offsetStart !== null && offsetEnd !== null && offsetEnd <= offsetStart) {
      reasons.push(`Part "${part?.id ?? index + 1}" side-of-line geometry requires offsetEnd to be greater than offsetStart.`);
    }

    if (axisLength !== null && axisLength <= 0) {
      reasons.push(`Part "${part?.id ?? index + 1}" side-of-line geometry requires a positive axisLength when provided.`);
    }

    if (!["ray", "rect"].includes(String(templateType ?? "").toLowerCase())) {
      reasons.push(`Part "${part?.id ?? index + 1}" side-of-line geometry currently requires a ray or rect template.`);
    }
  }
}

function mergePlainObjects(baseValue, overrideValue) {
  const baseObject = isPlainObject(baseValue) ? duplicateData(baseValue) : {};
  const overrideObject = isPlainObject(overrideValue) ? overrideValue : {};
  const merged = { ...baseObject };

  for (const [key, value] of Object.entries(overrideObject)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergePlainObjects(merged[key], value);
      continue;
    }

    merged[key] = duplicateData(value);
  }

  return merged;
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

function normalizeDirectionalSide(value) {
  const normalized = String(value ?? "left").toLowerCase();
  return normalized === "right" ? "right" : "left";
}

function normalizeOffsetReferenceMode(value) {
  const normalized = String(value ?? "axis").toLowerCase();
  return normalized === "body-edge" ? "body-edge" : "axis";
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
