import { MODULE_ID, RUNTIME_FLAG_KEY } from "../constants.mjs";
import { getRegionRuntimeFlags } from "./utils.mjs";

const MAX_LEDGER_ENTRIES = 200;
const pendingFrequencyReservations = new Set();

export function normalizeTriggerFrequency(value) {
  return String(value ?? "unlimited").trim().toLowerCase() === "once-per-turn" ? "once-per-turn" : "unlimited";
}

export function buildTriggerFrequencyIdentity({ combat = globalThis.game?.combat ?? null, turnContext = null, regionDocument = null, tokenDocument = null, triggerConfig = {}, timing = "custom" } = {}) {
  const eventCombatId = turnContext?.combatId ?? combat?.id ?? null;
  const eventRound = turnContext?.round ?? combat?.round;
  const eventTurn = turnContext?.turn ?? combat?.turn;
  const eventCombatantId = turnContext?.combatantId ?? combat?.combatant?.id ?? combat?.combatant?.tokenId ?? null;
  if (!combat?.started || !eventCombatId || eventRound == null || eventTurn == null || !eventCombatantId) return null;
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const configuredFrequencyGroup = String(triggerConfig?.frequencyGroup ?? "").trim();
  const frequencyGroup = configuredFrequencyGroup || String(timing ?? "custom");
  const regionScope = String(runtime.groupId ?? regionDocument?.id ?? "unknown-region");
  const targetScope = String(tokenDocument?.uuid ?? tokenDocument?.id ?? "unknown-token");
  // A declared group is the complete trigger identity within a cast. In
  // particular, do not retain the current combatant: native Region events can
  // be delivered after combat has advanced while a turn effect uses its saved
  // combatant state. The combat/round/turn tuple remains the turn boundary.
  const keyParts = configuredFrequencyGroup
    ? [eventCombatId, Number(eventRound), Number(eventTurn), targetScope, regionScope, frequencyGroup]
    : [eventCombatId, Number(eventRound), Number(eventTurn), eventCombatantId, targetScope, regionScope, frequencyGroup];
  return {
    key: keyParts.join("|"),
    combatId: eventCombatId,
    round: Number(eventRound),
    turn: Number(eventTurn),
    combatantId: eventCombatantId,
    tokenId: tokenDocument?.id ?? null,
    regionScope,
    frequencyGroup,
    sharedFrequencyGroup: Boolean(configuredFrequencyGroup)
  };
}

export async function claimTriggerFrequency({ regionDocument, tokenDocument, triggerConfig = {}, timing = "custom", combat = globalThis.game?.combat ?? null, turnContext = null } = {}) {
  const reservation = await reserveTriggerFrequency({ regionDocument, tokenDocument, triggerConfig, timing, combat, turnContext });
  if (!reservation.allowed || reservation.frequency === "unlimited" || !reservation.identity) return reservation;
  return commitTriggerFrequency(reservation);
}

/**
 * Reserve an once-per-turn key while an asynchronous native resolution is in
 * flight. The persistent ledger is deliberately untouched until commit.
 */
export async function reserveTriggerFrequency({ regionDocument, tokenDocument, triggerConfig = {}, timing = "custom", combat = globalThis.game?.combat ?? null, turnContext = null } = {}) {
  const frequency = normalizeTriggerFrequency(triggerConfig?.frequency);
  if (frequency === "unlimited") return { allowed: true, frequency, reason: "unlimited" };
  const identity = buildTriggerFrequencyIdentity({ combat, turnContext, regionDocument, tokenDocument, triggerConfig, timing });
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
  if (pendingFrequencyReservations.has(identity.key)) return { allowed: false, frequency, reason: "resolution-pending", identity };
  pendingFrequencyReservations.add(identity.key);
  return { allowed: true, frequency, reason: "reserved", identity, regionDocument, reservationKey: identity.key };
}

export async function commitTriggerFrequency(reservation = {}) {
  const { frequency, identity, regionDocument } = reservation;
  if (frequency === "unlimited" || !identity || !regionDocument) return { ...reservation, allowed: true, reason: "unlimited" };
  try {
    const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
    const siblingRegions = Array.from(regionDocument?.parent?.regions?.contents ?? [])
      .filter((candidate) => String(getRegionRuntimeFlags(candidate)?.groupId ?? candidate?.id ?? "") === identity.regionScope);
    const ledgerRegions = siblingRegions.length ? siblingRegions : [regionDocument];
    const currentLedger = ledgerRegions.flatMap((candidate) => {
      const ledger = getRegionRuntimeFlags(candidate)?.triggerFrequencyLedger;
      return Array.isArray(ledger) ? ledger.filter((entry) => entry && typeof entry === "object") : [];
    });
    if (currentLedger.some((entry) => entry.key === identity.key)) return { ...reservation, allowed: false, reason: "already-applied-this-turn" };
    const nextLedger = [...currentLedger.filter((entry) => entry.combatId === identity.combatId && Number(entry.round) >= identity.round - 1).slice(-(MAX_LEDGER_ENTRIES - 1)), identity];
    await regionDocument.update({ [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.triggerFrequencyLedger`]: nextLedger }, { persistentZonesTriggerFrequency: true });
    return { ...reservation, allowed: true, reason: "committed" };
  } finally {
    pendingFrequencyReservations.delete(reservation.reservationKey ?? identity?.key);
  }
}

export function releaseTriggerFrequency(reservation = {}) {
  if (reservation?.reservationKey) pendingFrequencyReservations.delete(reservation.reservationKey);
  return { ...reservation, released: true, reason: "released" };
}
