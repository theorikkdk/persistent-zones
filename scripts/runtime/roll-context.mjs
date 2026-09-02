import { MODULE_ID } from "../constants.mjs";

const TIMING_REASON_KEYS = Object.freeze({
  create: "PERSISTENT_ZONES.RollContext.Reasons.Create",
  onCreate: "PERSISTENT_ZONES.RollContext.Reasons.Create",
  enter: "PERSISTENT_ZONES.RollContext.Reasons.Enter",
  onEnter: "PERSISTENT_ZONES.RollContext.Reasons.Enter",
  exit: "PERSISTENT_ZONES.RollContext.Reasons.Exit",
  onExit: "PERSISTENT_ZONES.RollContext.Reasons.Exit",
  move: "PERSISTENT_ZONES.RollContext.Reasons.Move",
  onMove: "PERSISTENT_ZONES.RollContext.Reasons.Move",
  turnStart: "PERSISTENT_ZONES.RollContext.Reasons.TurnStart",
  onStartTurn: "PERSISTENT_ZONES.RollContext.Reasons.TurnStart",
  turnEnd: "PERSISTENT_ZONES.RollContext.Reasons.TurnEnd",
  onEndTurn: "PERSISTENT_ZONES.RollContext.Reasons.TurnEnd",
  escape: "PERSISTENT_ZONES.RollContext.Reasons.Escape"
});

/** Build display-only context for the native D&D5e roll APIs. */
export function buildPersistentZoneRollContext({
  sourceName = null,
  rollType = "save",
  ability = null,
  skill = null,
  timing = "custom"
} = {}) {
  const source = nonEmptyString(sourceName) ?? localize("PERSISTENT_ZONES.RollContext.SourceFallback");
  const roll = buildRollLabel({ rollType, ability, skill });
  const reason = buildTimingReason(timing);
  const title = format("PERSISTENT_ZONES.RollContext.Title", { source, roll, reason });
  return { title, flavor: title, source, roll, reason };
}

/**
 * Preserve display-only PZ context on the native D20Roll. The Core Roll
 * Resolver reads the Roll, not the D&D5e dialog/message configuration.
 */
export function buildPersistentZoneRollProcessConfig(context) {
  const title = nonEmptyString(context?.title);
  if (!title) return {};
  return {
    rolls: [{
      options: {
        [MODULE_ID]: {
          rollContext: { title }
        }
      }
    }]
  };
}

/** Return PZ-only display context stored on a Core/D&D5e Roll. */
export function getPersistentZoneRollResolverContext(resolver) {
  return nonEmptyString(resolver?.roll?.options?.[MODULE_ID]?.rollContext?.title);
}

/**
 * Add context to Foundry's native manual Roll Resolver without changing its
 * implementation, template, or any non-PZ roll.
 */
export function renderPersistentZoneRollResolver(resolver, element) {
  const title = getPersistentZoneRollResolverContext(resolver);
  if (!title || !element?.querySelector || !globalThis.document?.createElement) return;
  if (element.querySelector("[data-pz-roll-context]")) return;

  const formula = element.querySelector(".roll-resolver .formula") ?? element.querySelector(".formula");
  if (!formula?.before) return;

  const context = document.createElement("p");
  context.dataset.pzRollContext = "true";
  context.classList.add("pz-roll-context");
  context.textContent = title;
  formula.before(context);
}

export function registerPersistentZoneRollResolverHook() {
  if (typeof globalThis.Hooks?.on !== "function") return;
  Hooks.on("renderRollResolver", renderPersistentZoneRollResolver);
}

export function buildRollLabel({ rollType = "save", ability = null, skill = null } = {}) {
  const normalizedType = String(rollType ?? "save").trim().toLowerCase();
  const abilityLabel = getAbilityLabel(ability);
  const skillLabel = getSkillLabel(skill);
  if (normalizedType === "skill") return format("PERSISTENT_ZONES.RollContext.SkillCheck", { skill: skillLabel });
  if (normalizedType === "ability") return format("PERSISTENT_ZONES.RollContext.AbilityCheck", { ability: abilityLabel });
  return format("PERSISTENT_ZONES.RollContext.SavingThrow", { ability: abilityLabel });
}

export function buildTimingReason(timing = "custom") {
  const key = TIMING_REASON_KEYS[String(timing ?? "custom").trim()] ?? "PERSISTENT_ZONES.RollContext.Reasons.Generic";
  return localize(key);
}

function getAbilityLabel(ability) {
  const id = String(ability ?? "").trim().toLowerCase();
  return localize(globalThis.CONFIG?.DND5E?.abilities?.[id]?.label ?? id.toUpperCase());
}

function getSkillLabel(skill) {
  const id = String(skill ?? "").trim().toLowerCase();
  return localize(globalThis.CONFIG?.DND5E?.skills?.[id]?.label ?? id.toUpperCase());
}

function localize(key) {
  return globalThis.game?.i18n?.localize?.(key) ?? key;
}

function format(key, data) {
  return globalThis.game?.i18n?.format?.(key, data) ?? localize(key).replace(/\{(\w+)\}/g, (_match, name) => data[name] ?? "");
}

function nonEmptyString(value) {
  const result = String(value ?? "").trim();
  return result || null;
}
