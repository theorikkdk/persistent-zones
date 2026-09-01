export const MODULE_ID = "persistent-zones";
export const MODULE_API_NAMESPACE = "persistentZones";
export const MOVEMENT_STOP_GLOBAL_SETTING_KEY = "movementStopGlobalEnabled";
export const MOVEMENT_STOP_GLOBAL_MODE_SETTING_KEY = "movementStopGlobalMode";
export const MOVEMENT_STOP_GLOBAL_MODE_MIGRATED_SETTING_KEY = "movementStopGlobalModeMigrated";
export const DEBUG_LOG_LEVEL_SETTING_KEY = "debugLogLevel";
export const REGION_HIGHLIGHT_MODE_SETTING_KEY = "regionHighlightMode";
export const REGION_VISIBILITY_SETTING_KEY = "regionVisibility";

export const DEFINITION_FLAG_KEY = "definition";
export const RUNTIME_FLAG_KEY = "runtime";
export const PERSISTENT_ZONE_ACTIVITY_TYPE = "persistent-zone";
export const ACTIVITY_DEFINITION_FIELD_KEY = "persistentZone";
export const ACTIVITY_DEFINITION_SCHEMA_VERSION = 3;
export const NORMALIZED_DEFINITION_VERSION = 2;

export const DEFAULT_REGION_COLOR = "#3B7A57";
export const DEFAULT_ZONE_LABEL = "Persistent Zone";
export const DEFAULT_CONCENTRATION_STATUS_ID = "concentrating";
export const DEBUG_PREFIX = `[${MODULE_ID}]`;
export const NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE = "dnd5e.difficultTerrain";
export const STANDARD_DIFFICULT_TERRAIN_MULTIPLIER = 2;
export const ATTACHED_EMANATION_BEHAVIOR_TYPE = `${MODULE_ID}.attachedEmanation`;

export const SUPPORTED_TEMPLATE_TYPES = Object.freeze([
  "circle",
  "cone",
  "ray",
  "rect"
]);

export const ENTRY_DEDUP_TTL_MS = 750;
