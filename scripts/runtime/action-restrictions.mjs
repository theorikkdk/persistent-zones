import { MODULE_ID } from "../constants.mjs";

let registered = false;

/** Native D&D5e hook: reject only matching Activity activation types before consumption. */
export function registerPersistentZoneActionRestrictions() {
  if (registered) return;
  registered = true;
  Hooks.on("dnd5e.preUseActivity", (activity) => {
    const activation = String(activity?.activation?.type ?? "").trim().toLowerCase();
    const key = activation === "action" ? "action" : ["bonus", "bonusaction", "bonus-action"].includes(activation) ? "bonusAction" : null;
    if (!key) return true;
    const effect = Array.from(activity?.actor?.effects ?? []).find((entry) => entry?.disabled !== true && entry?.flags?.[MODULE_ID]?.actionRestrictions?.[key] === true);
    if (!effect) return true;
    const label = key === "action" ? "PERSISTENT_ZONES.ActionRestrictions.Action" : "PERSISTENT_ZONES.ActionRestrictions.BonusAction";
    ui.notifications?.warn?.(game.i18n?.format?.("PERSISTENT_ZONES.ActionRestrictions.Blocked", { action: game.i18n?.localize?.(label) ?? label }) ?? "This activity is currently restricted.");
    return false;
  });
}

export async function cleanupStatusesUntilEndOfTurn(combat, turnContext) {
  const expected = { combatId: combat?.id ?? null, round: Number(turnContext?.round ?? 0), turn: Number(turnContext?.turn ?? -1), combatantId: turnContext?.combatantId ?? null };
  if (!expected.combatId || expected.turn < 0) return [];
  const token = combat?.combatants?.get?.(expected.combatantId)?.token?.document ?? combat?.combatants?.get?.(expected.combatantId)?.token ?? null;
  const actor = token?.actor ?? null;
  const ids = Array.from(actor?.effects ?? []).filter((effect) => {
    const flags = effect?.flags?.[MODULE_ID] ?? {};
    const duration = flags.turnDuration ?? {};
    return flags.managedTriggeredEffect === true && flags.persistenceMode === "until-end-of-current-turn" &&
      duration.combatId === expected.combatId && Number(duration.round) === expected.round && Number(duration.turn) === expected.turn;
  }).map((effect) => effect.id).filter(Boolean);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { persistentZonesTurnDurationCleanup: true });
  return ids;
}
