/**
 * Resolve the actual spell-slot level selected for one D&D5e Activity use.
 * D&D5e 5.3.x stores the selected slot as `usage.spell.slot` (for example
 * `spell4`). Its `usage.scaling` value is only the delta from the Item's
 * base level, so it must not be treated as the absolute slot level.
 */
export function resolvePersistentZoneCastLevel({ usage = {}, item = null, actor = null } = {}) {
  const baseItemLevel = toPositiveInteger(item?.system?.level);
  const selectedSlot = normalizeIdentifier(usage?.spell?.slot ?? usage?.spellSlot ?? null);
  const usageScaling = toFiniteNumber(usage?.scaling);
  const spellLevel = toPositiveInteger(
    usage?.spell?.level ??
    usage?.spellLevel?.value ??
    usage?.spellLevel ??
    null
  );
  const slotLevel = selectedSlot
    ? toPositiveInteger(actor?.system?.spells?.[selectedSlot]?.level) ?? parseSpellSlotLevel(selectedSlot)
    : null;

  if (slotLevel) {
    return { baseItemLevel, selectedSlot, usageScaling, spellLevel, castLevel: slotLevel, source: "usage.spell.slot" };
  }
  if (spellLevel) {
    return { baseItemLevel, selectedSlot, usageScaling, spellLevel, castLevel: spellLevel, source: "usage.spell.level" };
  }
  if (baseItemLevel && usageScaling !== null) {
    return {
      baseItemLevel,
      selectedSlot,
      usageScaling,
      spellLevel,
      castLevel: Math.max(1, baseItemLevel + Math.max(0, Math.floor(usageScaling))),
      source: "usage.scaling-plus-item-level"
    };
  }
  return { baseItemLevel, selectedSlot, usageScaling, spellLevel, castLevel: baseItemLevel, source: "item.system.level-fallback" };
}

function parseSpellSlotLevel(value) {
  const match = /^spell(\d+)$/i.exec(String(value ?? "").trim());
  return match ? toPositiveInteger(match[1]) : null;
}

function normalizeIdentifier(value) {
  return String(value ?? "").trim() || null;
}

function toPositiveInteger(value) {
  const number = toFiniteNumber(value);
  return number !== null && number >= 1 ? Math.floor(number) : null;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
