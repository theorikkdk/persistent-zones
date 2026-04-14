import {
  DEFAULT_CONCENTRATION_STATUS_ID,
  DEFAULT_ZONE_LABEL,
  LEGACY_ENCOUNTERPLUS_IMPORTER_MODULE_ID
} from "../constants.mjs";
import {
  coerceBoolean,
  coerceNumber,
  duplicateData,
  isPlainObject,
  pickFirstDefined,
  safeGet
} from "./utils.mjs";

export function getLegacyEncounterPlusZonePayload(item) {
  if (!item) {
    return null;
  }

  const regionRule = duplicateData(
    item.getFlag?.(LEGACY_ENCOUNTERPLUS_IMPORTER_MODULE_ID, "regionRule")
  );
  const regionMeta = duplicateData(
    item.getFlag?.(LEGACY_ENCOUNTERPLUS_IMPORTER_MODULE_ID, "regionMeta")
  );

  return {
    source: LEGACY_ENCOUNTERPLUS_IMPORTER_MODULE_ID,
    hasConfig: hasLegacyEncounterPlusZoneConfig(regionRule, regionMeta),
    regionRule,
    regionMeta
  };
}

export function getLegacyZoneDefinitionFromEncounterPlusItem(item) {
  const payload = getLegacyEncounterPlusZonePayload(item);
  if (!payload?.hasConfig) {
    return null;
  }

  const rule = isPlainObject(payload.regionRule) ? payload.regionRule : {};
  const meta = isPlainObject(payload.regionMeta) ? payload.regionMeta : {};

  return {
    source: {
      type: "legacy-fallback",
      module: LEGACY_ENCOUNTERPLUS_IMPORTER_MODULE_ID
    },
    label: pickFirstDefined(
      meta.label,
      meta.name,
      rule.label,
      rule.name,
      item?.name,
      DEFAULT_ZONE_LABEL
    ),
    itemUuid: item?.uuid ?? null,
    actorUuid: pickFirstDefined(
      meta.actorUuid,
      meta.sourceActorUuid,
      rule.actorUuid,
      rule.sourceActorUuid,
      item?.actor?.uuid
    ),
    casterUuid: pickFirstDefined(
      meta.casterUuid,
      meta.sourceCasterUuid,
      rule.casterUuid,
      rule.sourceCasterUuid
    ),
    dc: coerceNumber(
      pickFirstDefined(
        meta.dc,
        safeGet(meta, ["save", "dc"]),
        rule.dc,
        safeGet(rule, ["save", "dc"]),
        safeGet(item, ["system", "save", "dc"])
      ),
      null
    ),
    castLevel: coerceNumber(
      pickFirstDefined(
        meta.castLevel,
        meta.level,
        rule.castLevel,
        rule.level,
        safeGet(item, ["system", "level"])
      ),
      null
    ),
    template: {
      type: pickFirstDefined(
        meta.templateType,
        rule.templateType,
        meta.shape,
        rule.shape,
        null
      )
    },
    concentration: {
      required: coerceBoolean(
        pickFirstDefined(
          safeGet(meta, ["concentration", "required"]),
          meta.requiresConcentration,
          meta.concentrationRequired,
          safeGet(rule, ["concentration", "required"]),
          rule.requiresConcentration,
          rule.concentrationRequired,
          safeGet(item, ["system", "concentration"]),
          safeGet(item, ["system", "properties", "concentration"])
        ),
        null
      ),
      effectUuid: pickFirstDefined(
        safeGet(meta, ["concentration", "effectUuid"]),
        meta.concentrationEffectUuid,
        safeGet(rule, ["concentration", "effectUuid"]),
        rule.concentrationEffectUuid
      ),
      effectId: pickFirstDefined(
        safeGet(meta, ["concentration", "effectId"]),
        meta.concentrationEffectId,
        safeGet(rule, ["concentration", "effectId"]),
        rule.concentrationEffectId
      ),
      actorUuid: pickFirstDefined(
        safeGet(meta, ["concentration", "actorUuid"]),
        safeGet(rule, ["concentration", "actorUuid"]),
        meta.casterUuid,
        rule.casterUuid,
        meta.actorUuid,
        rule.actorUuid,
        item?.actor?.uuid
      ),
      statusId: pickFirstDefined(
        safeGet(meta, ["concentration", "statusId"]),
        safeGet(rule, ["concentration", "statusId"]),
        DEFAULT_CONCENTRATION_STATUS_ID
      ),
      originUuid: pickFirstDefined(
        safeGet(meta, ["concentration", "originUuid"]),
        safeGet(rule, ["concentration", "originUuid"]),
        item?.uuid
      )
    },
    legacy: {
      regionRule: payload.regionRule,
      regionMeta: payload.regionMeta
    }
  };
}

export function hasLegacyEncounterPlusZoneConfig(regionRule, regionMeta) {
  if (isPlainObject(regionRule)) {
    return Object.keys(regionRule).length > 0;
  }

  if (regionRule !== null && regionRule !== undefined) {
    return true;
  }

  if (isPlainObject(regionMeta)) {
    return Object.keys(regionMeta).length > 0;
  }

  return false;
}
