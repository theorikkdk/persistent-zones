import { coerceNumber } from "./utils.mjs";

const SCALING_MODES = new Set(["none", "per-level"]);

/** Normalize optional, activity-owned damage scaling without changing legacy damage. */
export function normalizeDamageScaling(value, { itemBaseLevel = null } = {}) {
  const source = value && typeof value === "object" ? value : {};
  const mode = SCALING_MODES.has(String(source.mode ?? "").trim().toLowerCase())
    ? String(source.mode).trim().toLowerCase()
    : "none";
  const configuredBaseLevel = coercePositiveInteger(source.baseLevel);
  // Existing configurations predate baseLevelMode. Their explicit numeric value
  // remains a fixed reference rather than silently changing semantics.
  const requestedBaseLevelMode = String(source.baseLevelMode ?? "").trim().toLowerCase();
  const baseLevelMode = ["item", "fixed"].includes(requestedBaseLevelMode)
    ? requestedBaseLevelMode
    : configuredBaseLevel !== null
      ? "fixed"
      : "item";
  const baseLevel = Math.max(1, Math.floor(coerceNumber(source.baseLevel, 1) ?? 1));
  const normalizedItemBaseLevel = coercePositiveInteger(itemBaseLevel) ?? coercePositiveInteger(source.itemBaseLevel);
  const resolvedBaseLevel = baseLevelMode === "item"
    ? normalizedItemBaseLevel ?? baseLevel
    : baseLevel;
  const perLevelFormula = String(source.perLevelFormula ?? "").trim();
  return {
    mode: mode === "per-level" && perLevelFormula ? "per-level" : "none",
    baseLevelMode,
    baseLevel,
    itemBaseLevel: normalizedItemBaseLevel,
    resolvedBaseLevel,
    perLevelFormula
  };
}

/**
 * Produce a Roll formula from a base expression plus one complete expression
 * per slot level above the configured reference level.
 */
export function resolveScaledFormula({ formula = null, scaling = null, castLevel = null, itemBaseLevel = null } = {}) {
  const baseFormula = String(formula ?? "").trim();
  const normalizedScaling = normalizeDamageScaling(scaling, { itemBaseLevel });
  const resolvedCastLevel = Math.floor(coerceNumber(castLevel, null) ?? 0);
  const extraLevels = normalizedScaling.mode === "per-level"
    ? Math.max(0, resolvedCastLevel - normalizedScaling.resolvedBaseLevel)
    : 0;
  const formulaParts = [baseFormula];
  for (let index = 0; index < extraLevels; index += 1) {
    formulaParts.push(`(${normalizedScaling.perLevelFormula})`);
  }
  return {
    formula: formulaParts.filter(Boolean).join(" + ") || null,
    castLevel: resolvedCastLevel || null,
    extraLevels,
    scaling: normalizedScaling,
    rollData: {
      castLevel: resolvedCastLevel || null,
      pz: {
        castLevel: resolvedCastLevel || null,
        baseLevel: normalizedScaling.resolvedBaseLevel,
        extraLevels
      }
    }
  };
}

// Compatibility alias for the first damage-only caller. The resolver itself
// is intentionally independent of the effect that consumes the formula.
export const resolveScaledDamageFormula = resolveScaledFormula;

function coercePositiveInteger(value) {
  const numeric = coerceNumber(value, null);
  return numeric !== null && numeric >= 1 ? Math.floor(numeric) : null;
}
