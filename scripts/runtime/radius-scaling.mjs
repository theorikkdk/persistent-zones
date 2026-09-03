import { coerceNumber } from "./utils.mjs";

const MODES = new Set(["none", "per-level"]);

/** Resolve an activity-owned radius once, at cast time. */
export function resolveScaledRadius({ radius = null, scaling = null, castLevel = null, itemBaseLevel = null } = {}) {
  const source = scaling && typeof scaling === "object" ? scaling : {};
  const mode = MODES.has(String(source.mode ?? "").trim().toLowerCase()) ? String(source.mode).trim().toLowerCase() : "none";
  const configuredBase = positiveInteger(source.baseLevel);
  const baseLevelMode = ["item", "fixed"].includes(String(source.baseLevelMode ?? "").trim().toLowerCase())
    ? String(source.baseLevelMode).trim().toLowerCase() : configuredBase ? "fixed" : "item";
  const resolvedBaseLevel = baseLevelMode === "item" ? positiveInteger(itemBaseLevel) ?? configuredBase ?? 1 : configuredBase ?? 1;
  const resolvedCastLevel = positiveInteger(castLevel);
  const radiusPerLevel = Math.max(0, coerceNumber(source.radiusPerLevel, 0) ?? 0);
  const extraLevels = mode === "per-level" && resolvedCastLevel ? Math.max(0, resolvedCastLevel - resolvedBaseLevel) : 0;
  return {
    radius: Math.max(0, (coerceNumber(radius, 0) ?? 0) + (extraLevels * radiusPerLevel)),
    extraLevels,
    scaling: { mode: mode === "per-level" && radiusPerLevel > 0 ? "per-level" : "none", baseLevelMode, baseLevel: configuredBase ?? 1, itemBaseLevel: positiveInteger(itemBaseLevel), resolvedBaseLevel, radiusPerLevel }
  };
}

/** Write a world-distance radius into D&D5e's native MeasuredTemplate creation payload. */
export function applyResolvedRadiusToTemplateData(templateData, radius) {
  const resolved = coerceNumber(radius, null);
  if (!templateData || resolved === null || resolved <= 0) return false;
  templateData.distance = resolved;
  templateData.flags ??= {};
  templateData.flags.dnd5e ??= {};
  templateData.flags.dnd5e.dimensions ??= {};
  templateData.flags.dnd5e.dimensions.size = resolved;
  return true;
}

function positiveInteger(value) {
  const number = coerceNumber(value, null);
  return number !== null && number >= 1 ? Math.floor(number) : null;
}
