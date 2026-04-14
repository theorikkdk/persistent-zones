export const MODULE_ID = "persistent-zones";
export const MODULE_API_NAMESPACE = "persistentZones";

export const DEFINITION_FLAG_KEY = "definition";
export const RUNTIME_FLAG_KEY = "runtime";
export const NORMALIZED_DEFINITION_VERSION = 1;
export const LEGACY_ENCOUNTERPLUS_IMPORTER_MODULE_ID = "encounterplus-importer";

export const DEFAULT_REGION_COLOR = "#3B7A57";
export const DEFAULT_ZONE_LABEL = "Persistent Zone";
export const DEFAULT_CONCENTRATION_STATUS_ID = "concentrating";
export const DEBUG_PREFIX = `[${MODULE_ID}]`;

export const SUPPORTED_TEMPLATE_TYPES = Object.freeze([
  "circle",
  "cone",
  "ray",
  "rect"
]);
