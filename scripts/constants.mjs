export const MODULE_ID = "persistent-zones";
export const MODULE_API_NAMESPACE = "persistentZones";

export const DEFINITION_FLAG_KEY = "definition";
export const RUNTIME_FLAG_KEY = "runtime";
export const NORMALIZED_DEFINITION_VERSION = 2;

export const DEFAULT_REGION_COLOR = "#3B7A57";
export const DEFAULT_ZONE_LABEL = "Persistent Zone";
export const DEFAULT_CONCENTRATION_STATUS_ID = "concentrating";
export const DEBUG_PREFIX = `[${MODULE_ID}]`;
export const NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE = "dnd5e.difficultTerrain";
export const STANDARD_DIFFICULT_TERRAIN_MULTIPLIER = 2;

export const SUPPORTED_TEMPLATE_TYPES = Object.freeze([
  "circle",
  "cone",
  "ray",
  "rect"
]);

export const ENTRY_DEDUP_TTL_MS = 750;
