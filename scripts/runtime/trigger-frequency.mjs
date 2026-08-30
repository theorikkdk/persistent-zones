import { MODULE_ID, RUNTIME_FLAG_KEY } from "../constants.mjs";
import { getRegionRuntimeFlags } from "./utils.mjs";

const MAX_LEDGER_ENTRIES = 200;

export function normalizeTriggerFrequency(value) {
  return String(value ?? "unlimited").trim().toLowerCase() === "once-per-turn" ? "once-per-turn" : "unlimited";
}

export function buildTriggerFrequencyIdentity({ combat = globalThis.game?.combat ?? null, regionDocument = null, tokenDocument = null, triggerConfig = {}, timing = "custom" } = {}) {
  if (!combat?.started || combat?.round == null || combat?.turn == null || !combat?.combatant) return null;
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const frequencyGroup = String(triggerConfig?.frequencyGroup ?? "").trim() || String(timing ?? "custom");
  const regionScope = String(runtime.groupId ?? regionDocument?.id ?? "unknown-region");
  const targetScope = String(tokenDocument?.uuid ?? tokenDocument?.id ?? "unknown-token");
  return {
    key: [combat.id, Number(combat.round), Number(combat.turn), combat.combatant.id ?? combat.combatant.tokenId ?? "unknown-combatant", targetScope, regionScope, frequencyGroup].join("|"),
    combatId: combat.id,
    round: Number(combat.round),
    turn: Number(combat.turn),
    combatantId: combat.combatant.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    regionScope,
    frequencyGroup
  };
}

export async function claimTriggerFrequency({ regionDocument, tokenDocument, triggerConfig = {}, timing = "custom", combat = globalThis.game?.combat ?? null } = {}) {
  const frequency = normalizeTriggerFrequency(triggerConfig?.frequency);
  if (frequency === "unlimited") return { allowed: true, frequency, reason: "unlimited" };
  const identity = buildTriggerFrequencyIdentity({ combat, regionDocument, tokenDocument, triggerConfig, timing });
  if (!identity) return { allowed: true, frequency, reason: "outside-combat-unlimited" };
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const siblingRegions = Array.from(regionDocument?.parent?.regions?.contents ?? [])
    .filter((candidate) => String(getRegionRuntimeFlags(candidate)?.groupId ?? candidate?.id ?? "") === identity.regionScope);
  const ledgerRegions = siblingRegions.length ? siblingRegions : [regionDocument];
  const currentLedger = ledgerRegions.flatMap((candidate) => {
    const ledger = getRegionRuntimeFlags(candidate)?.triggerFrequencyLedger;
    return Array.isArray(ledger) ? ledger.filter((entry) => entry && typeof entry === "object") : [];
  });
  if (currentLedger.some((entry) => entry.key === identity.key)) return { allowed: false, frequency, reason: "already-applied-this-turn", identity };
  const nextLedger = [...currentLedger.filter((entry) => entry.combatId === identity.combatId && Number(entry.round) >= identity.round - 1).slice(-(MAX_LEDGER_ENTRIES - 1)), identity];
  await regionDocument.update({ [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.triggerFrequencyLedger`]: nextLedger }, { persistentZonesTriggerFrequency: true });
  return { allowed: true, frequency, reason: "claimed", identity };
}
