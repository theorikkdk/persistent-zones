import {
  DEFAULT_CONCENTRATION_STATUS_ID,
  DEFAULT_ZONE_LABEL,
  DEFINITION_FLAG_KEY,
  MODULE_ID,
  NORMALIZED_DEFINITION_VERSION,
  SUPPORTED_TEMPLATE_TYPES
} from "../constants.mjs";
import { getLegacyZoneDefinitionFromEncounterPlusItem } from "./adapter-encounterplus.mjs";
import {
  coerceBoolean,
  coerceNumber,
  duplicateData,
  isPlainObject,
  pickFirstDefined,
  safeGet
} from "./utils.mjs";

export function getZoneDefinitionFromItem(
  item,
  { allowLegacyFallback = true } = {}
) {
  if (!item) {
    return null;
  }

  const storedDefinition = duplicateData(
    item.getFlag?.(MODULE_ID, DEFINITION_FLAG_KEY) ??
      item?.flags?.[MODULE_ID]?.[DEFINITION_FLAG_KEY]
  );

  if (storedDefinition !== undefined && storedDefinition !== null) {
    return storedDefinition;
  }

  if (!allowLegacyFallback) {
    return null;
  }

  return getLegacyZoneDefinitionFromEncounterPlusItem(item);
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
  const templateDefinition = isPlainObject(definition.template)
    ? definition.template
    : {};
  const concentrationDefinition = isPlainObject(definition.concentration)
    ? definition.concentration
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
    definition.sourceActorUuid,
    item?.actor?.uuid
  );

  const casterUuid = pickFirstDefined(
    caster?.uuid,
    definition.casterUuid,
    definition.sourceCasterUuid,
    actorUuid
  );

  const dc = coerceNumber(
    pickFirstDefined(
      definition.dc,
      safeGet(definition, ["save", "dc"]),
      safeGet(item, ["system", "save", "dc"]),
      safeGet(item, ["system", "activities", "save", "dc"])
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
      definition.concentrationActorUuid,
      casterUuid,
      actorUuid
    ),
    statusId: pickFirstDefined(
      concentrationDefinition.statusId,
      definition.concentrationStatusId,
      DEFAULT_CONCENTRATION_STATUS_ID
    ),
    originUuid: pickFirstDefined(
      concentrationDefinition.originUuid,
      definition.concentrationOriginUuid,
      item?.uuid
    )
  };

  const validationReasons = collectValidationReasons({
    sourceDefinition,
    templateType
  });

  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: normalizeSource(definition.source),
    enabled: coerceBoolean(
      pickFirstDefined(definition.enabled, definition.active, true),
      true
    ),
    label: pickFirstDefined(
      definition.label,
      definition.name,
      item?.name,
      DEFAULT_ZONE_LABEL
    ),
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
        pickFirstDefined(
          templateDefinition.distance,
          definition.distance,
          templateDocument?.distance
        ),
        null
      ),
      angle: coerceNumber(
        pickFirstDefined(
          templateDefinition.angle,
          definition.angle,
          templateDocument?.angle
        ),
        null
      ),
      direction: coerceNumber(
        pickFirstDefined(
          templateDefinition.direction,
          definition.direction,
          templateDocument?.direction
        ),
        null
      ),
      width: coerceNumber(
        pickFirstDefined(
          templateDefinition.width,
          definition.width,
          templateDocument?.width
        ),
        null
      ),
      elevation: coerceNumber(
        pickFirstDefined(
          templateDefinition.elevation,
          definition.elevation,
          templateDocument?.elevation
        ),
        0
      )
    },
    concentration,
    triggers: normalizeTriggers(definition.triggers),
    limits: collectCurrentLimits(definition),
    validation: {
      isValid: validationReasons.length === 0,
      reasons: validationReasons
    }
  };
}

export const buildNormalizedZoneDefinition = normalizeZoneDefinition;

function collectValidationReasons({ sourceDefinition, templateType }) {
  const reasons = [];

  if (sourceDefinition === null || sourceDefinition === undefined) {
    reasons.push('flags["persistent-zones"].definition is missing on the source Item.');
  } else if (!isPlainObject(sourceDefinition)) {
    reasons.push('flags["persistent-zones"].definition must be an object.');
  } else if (!Object.keys(sourceDefinition).length) {
    reasons.push('flags["persistent-zones"].definition is empty.');
  }

  if (!templateType) {
    reasons.push("Template type could not be determined.");
  } else if (!SUPPORTED_TEMPLATE_TYPES.includes(templateType)) {
    reasons.push(`Template type "${templateType}" is not supported by this MVP.`);
  }

  return reasons;
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

function normalizeTriggers(triggerDefinition) {
  if (!isPlainObject(triggerDefinition)) {
    return {};
  }

  return duplicateData(triggerDefinition);
}

function collectCurrentLimits(definition) {
  const sources = [
    definition,
    safeGet(definition, ["legacy", "regionRule"]),
    safeGet(definition, ["legacy", "regionMeta"])
  ];
  const limits = [];

  if (hasAnyPath(sources, ["damage"])) {
    limits.push("Damage data is preserved but ignored in step 1.");
  }

  if (hasAnyPath(sources, ["save"]) || hasAnyPath(sources, ["runtimeSave"])) {
    limits.push("Runtime saves are not executed in step 1.");
  }

  if (hasAnyPath(sources, ["turn"]) || hasAnyPath(sources, ["turns"])) {
    limits.push("Turn logic is not executed in step 1.");
  }

  if (hasAnyPath(sources, ["difficultTerrain"])) {
    limits.push("Difficult terrain is not executed in step 1.");
  }

  if (hasAnyPath(sources, ["forcedMovement"])) {
    limits.push("Forced movement is not executed in step 1.");
  }

  if (
    hasAnyPath(sources, ["onExit"]) ||
    hasAnyPath(sources, ["exit"]) ||
    hasAnyPath(sources, ["movement"])
  ) {
    limits.push("Exit and movement-through-zone logic are not executed in step 1.");
  }

  if (hasAnyPath(sources, ["linkedWalls"])) {
    limits.push("Linked walls are not created in step 1.");
  }

  if (hasAnyPath(sources, ["linkedLights"])) {
    limits.push("Linked lights are not created in step 1.");
  }

  return limits;
}

function hasAnyPath(sources, path) {
  return sources.some((source) => safeGet(source, path) !== undefined);
}
