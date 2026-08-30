import { BUILTIN_PRESETS } from "./builtins.mjs";
import { normalizePreset } from "./preset-utils.mjs";

const PRESETS = Object.freeze(BUILTIN_PRESETS.map(normalizePreset).filter(Boolean));

export function getBuiltinPersistentZonePresets() {
  return PRESETS.map(preset => structuredClone(preset));
}

export function getPersistentZonePreset(id) {
  const preset = PRESETS.find(candidate => candidate.id === String(id ?? ""));
  return preset ? structuredClone(preset) : null;
}
