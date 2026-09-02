import {
  FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE,
  MAX_NATIVE_MOVEMENT_COST_MULTIPLIER,
  MODULE_ID
} from "../constants.mjs";
import { evaluateTriggerTargetFilter, normalizeTriggerTargetFilterMode } from "./utils.mjs";

export function registerFilteredMovementCostRegionBehavior() {
  const Base = globalThis.foundry?.data?.regionBehaviors?.RegionBehaviorType;
  const fields = globalThis.foundry?.data?.fields;
  if (!Base || !fields || !globalThis.CONFIG?.RegionBehavior?.dataModels) return false;

  class PersistentZoneFilteredMovementCostBehavior extends Base {
    static defineSchema() {
      return {
        multiplier: new fields.NumberField({ required: true, nullable: false, initial: 2, min: 1, max: MAX_NATIVE_MOVEMENT_COST_MULTIPLIER, step: 0.25 }),
        targetFilter: new fields.SchemaField({
          mode: new fields.StringField({ required: false, initial: "all", choices: ["all", "allies", "enemies", "self", "others"] })
        })
      };
    }

    _getTerrainEffects(tokenDocument, _segment, _options) {
      return getFilteredMovementCostTerrainEffects({
        regionDocument: this.region,
        tokenDocument,
        multiplier: this.multiplier,
        targetFilter: this.targetFilter
      });
    }
  }

  CONFIG.RegionBehavior.dataModels[FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE] = PersistentZoneFilteredMovementCostBehavior;
  CONFIG.RegionBehavior.typeIcons ??= {};
  CONFIG.RegionBehavior.typeIcons[FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE] = "fa-solid fa-person-walking-arrow-right";
  return Boolean(CONFIG.RegionBehavior.dataModels[FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE]);
}

export function buildFilteredMovementCostBehaviorData({ multiplier = 2, targetFilter = null } = {}) {
  return {
    name: "Persistent Zones — Filtered Movement Cost",
    type: FILTERED_MOVEMENT_COST_BEHAVIOR_TYPE,
    system: {
      multiplier: clampMovementCostMultiplier(multiplier),
      targetFilter: { mode: normalizeTriggerTargetFilterMode(targetFilter?.mode) }
    },
    flags: { [MODULE_ID]: { nativeBehavior: { kind: "filtered-movement-cost" } } }
  };
}

export function getFilteredMovementCostTerrainEffects({
  regionDocument,
  tokenDocument,
  multiplier = 2,
  targetFilter = null
} = {}) {
  const mode = normalizeTriggerTargetFilterMode(targetFilter?.mode);
  const filterResult = evaluateTriggerTargetFilter({
    regionDocument,
    tokenDocument,
    triggerConfig: { targetFilter: { mode } }
  });
  if (!filterResult.allowed) return [];

  const difficulty = clampMovementCostMultiplier(multiplier);
  return difficulty > 1 ? [{ name: "difficulty", difficulty }] : [];
}

function clampMovementCostMultiplier(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 2;
  return Math.min(MAX_NATIVE_MOVEMENT_COST_MULTIPLIER, Math.max(1, numeric));
}
