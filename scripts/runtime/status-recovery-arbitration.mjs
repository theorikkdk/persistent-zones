import { MODULE_ID } from "../constants.mjs";
import {
  hasManagedStatusRecoveryOvertime,
  removeStatusRecovery,
  updateStatusRecovery
} from "./status-recovery.mjs";

const SUPPORTED_COMPARATORS = new Set(["equal", "higher-save-dc", "higher-cast-level", "explicit-rank"]);
const pendingPromotions = new Map();
let hooksRegistered = false;
let sourceApplicationSequence = 0;

export function registerStatusRecoveryArbitrationHooks() {
  if (hooksRegistered) return;
  Hooks.on("updateCombat", (combat) => {
    Promise.resolve(activatePendingRecoveryPromotions(combat)).catch((error) => {
      console.error("[persistent-zones] Failed to activate deferred recovery promotions.", error);
    });
  });
  hooksRegistered = true;
}

export function buildRecoverySourceIdentity({ item = null, activityId = null, runtime = {}, recovery = {}, regionDocument = null } = {}) {
  const explicitFamilyId = normalizeIdentifier(recovery.effectFamilyId);
  const compendiumSource = normalizeCanonicalCompendiumSource(
    item?._stats?.compendiumSource ?? item?._source?._stats?.compendiumSource
  );
  const duplicateSource = normalizeIdentifier(
    item?._stats?.duplicateSource ?? item?._source?._stats?.duplicateSource
  );
  const itemIdentifier = normalizeIdentifier(
    item?.identifier ?? item?.system?.identifier ?? item?.system?.source?.identifier ?? item?.flags?.dnd5e?.identifier
  );
  const rulesEdition = normalizeIdentifier(
    item?.system?.source?.rules ?? item?.system?.source?.rulesVersion ?? item?.system?.rules
  ) ?? "unspecified";
  const stableActivityId = normalizeIdentifier(activityId ?? runtime.activityId);
  const itemUuid = normalizeIdentifier(item?.uuid ?? runtime.itemUuid);
  let effectFamilyId = explicitFamilyId;
  let effectFamilySource = "explicit";

  if (!effectFamilyId && compendiumSource) {
    effectFamilyId = joinIdentity(
      "dnd5e",
      rulesEdition,
      "compendium",
      compendiumSource,
      stableActivityId ?? "unknown-activity"
    );
    effectFamilySource = "canonical-compendium";
  } else if (!effectFamilyId) {
    effectFamilyId = joinIdentity("local", itemUuid ?? "unknown-item", stableActivityId ?? "unknown-activity");
    effectFamilySource = "local-conservative";
    console.warn(
      `[persistent-zones] PZ RECOVERY EFFECT FAMILY FALLBACK | itemUuid=${itemUuid ?? "null"} | ` +
      `activityId=${stableActivityId ?? "null"} | effectFamilyId=${effectFamilyId}`
    );
  }

  console.warn(
    `[persistent-zones] PZ RECOVERY EFFECT FAMILY DECISION | itemUuid=${itemUuid ?? "null"} | ` +
    `activityId=${stableActivityId ?? "null"} | explicitFamilyId=${explicitFamilyId ?? "null"} | ` +
    `compendiumSource=${compendiumSource ?? "null"} | duplicateSource=${duplicateSource ?? "null"} | ` +
    `itemIdentifier=${itemIdentifier ?? "null"} | resolvedEffectFamilyId=${effectFamilyId} | ` +
    `resolutionMode=${effectFamilySource}`
  );

  const castIdentity = normalizeIdentifier(runtime.castInstanceId ?? runtime.ringOperationId);
  const regionIdentity = normalizeIdentifier(regionDocument?.uuid ?? regionDocument?.id ?? runtime.regionId);
  const sourceInstanceId = joinIdentity("source", castIdentity ?? "unknown-cast", regionIdentity ?? "unknown-region");
  const worldTime = Number(globalThis.game?.time?.worldTime);
  const sourceAppliedAt = Date.now();
  sourceApplicationSequence = (sourceApplicationSequence + 1) % 1000;
  return {
    effectFamilyId,
    effectFamilySource,
    sourceInstanceId,
    sourceAppliedAt,
    sourceAppliedOrder: (sourceAppliedAt * 1000) + sourceApplicationSequence,
    sourceAppliedWorldTime: Number.isFinite(worldTime) ? worldTime : null,
    potency: normalizePotency(recovery.potency, {
      resolvedDC: recovery.resolvedDC,
      castLevel: runtime.castLevel
    }),
    itemUuid,
    activityId: stableActivityId,
    castLevel: normalizeNumber(runtime.castLevel)
  };
}

export function buildRecoveryGroupKey(flags = {}) {
  const recovery = flags.statusRecovery ?? {};
  return joinIdentity(
    "recovery",
    flags.effectFamilyId ?? "unknown-family",
    flags.statusId ?? "unknown-status",
    recovery.mode ?? "none",
    recovery.ability ?? "none",
    recovery.selectedProvider ?? recovery.requestedProvider ?? "none"
  );
}

export async function reconcileRecoveryArbitration(actor, recoveryGroupKey = null, {
  deferActivation = false,
  removedSourceId = null,
  reason = "source-change"
} = {}) {
  if (!actor) return [];
  const groups = collectRecoveryGroups(actor, recoveryGroupKey);
  const results = [];
  for (const [groupKey, sources] of groups) {
    const decision = selectDominantSource(sources);
    const previous = sources.find((source) => hasManagedStatusRecoveryOvertime(source)) ?? null;
    const selected = decision.selectedSource;
    const actions = [];

    for (const source of sources) {
      if (source === selected && !deferActivation) continue;
      const removal = await removeStatusRecovery(source);
      if (removal.removed) actions.push(`remove:${source.id}`);
    }

    if (selected && deferActivation) {
      pendingPromotions.set(buildPendingKey(actor, groupKey), {
        actor,
        recoveryGroupKey: groupKey,
        pendingSourceId: selected.id,
        removedSourceId,
        reason,
        deferredCombatState: getCombatState(globalThis.game?.combat)
      });
      console.warn(
        `[persistent-zones] PZ RECOVERY PROMOTION DEFERRED | actorUuid=${actor.uuid ?? "null"} | ` +
        `recoveryGroupKey=${groupKey} | removedSourceId=${removedSourceId ?? "null"} | ` +
        `pendingSourceId=${selected.id ?? "null"} | reason=${reason}`
      );
      actions.push(`defer:${selected.id}`);
    } else if (selected && !hasManagedStatusRecoveryOvertime(selected)) {
      const recovery = selected.flags?.[MODULE_ID]?.statusRecovery ?? {};
      const update = await updateStatusRecovery(selected, recovery, {
        persistenceMode: selected.flags?.[MODULE_ID]?.persistenceMode,
        resolvedDC: recovery.resolvedDC,
        effectStatusId: selected.flags?.[MODULE_ID]?.statusId
      });
      if (update.updated) actions.push(`apply:${selected.id}`);
    }

    logDecision(actor, groupKey, sources, decision, previous, actions);
    results.push({ groupKey, ...decision, previousSource: previous, actions });
  }
  return results;
}

export function markRecoveryPromotionDeferred(actor, effect, reason = "midi-recovery-expiration") {
  const flags = effect?.flags?.[MODULE_ID] ?? {};
  const recoveryGroupKey = flags.recoveryGroupKey ?? buildRecoveryGroupKey(flags);
  pendingPromotions.set(buildPendingKey(actor, recoveryGroupKey), {
    actor,
    recoveryGroupKey,
    pendingSourceId: null,
    removedSourceId: effect?.id ?? null,
    reason,
    deferredCombatState: getCombatState(globalThis.game?.combat)
  });
  return recoveryGroupKey;
}

export function isRecoveryPromotionPending(actor, recoveryGroupKey) {
  return pendingPromotions.has(buildPendingKey(actor, recoveryGroupKey));
}

async function activatePendingRecoveryPromotions(combat) {
  const currentCombatState = getCombatState(combat);
  const pending = Array.from(pendingPromotions.entries())
    .filter(([, entry]) => entry.deferredCombatState !== currentCombatState);
  for (const entry of pending) {
    pendingPromotions.delete(entry[0]);
    const promotion = entry[1];
    const results = await reconcileRecoveryArbitration(promotion.actor, promotion.recoveryGroupKey, {
      reason: "deferred-promotion-activation"
    });
    const selected = results?.[0]?.selectedSource ?? null;
    console.warn(
      `[persistent-zones] PZ RECOVERY PROMOTION ACTIVATED | actorUuid=${promotion.actor?.uuid ?? "null"} | ` +
      `recoveryGroupKey=${promotion.recoveryGroupKey} | removedSourceId=${promotion.removedSourceId ?? "null"} | ` +
      `selectedSourceId=${selected?.id ?? "null"}`
    );
  }
}

function collectRecoveryGroups(actor, requestedGroupKey) {
  const groups = new Map();
  for (const effect of Array.from(actor?.effects ?? [])) {
    const flags = effect?.flags?.[MODULE_ID] ?? {};
    if (flags.managedTriggeredEffect !== true || effect.active !== true) continue;
    if (!flags.statusRecovery || flags.statusRecovery.mode === "none") continue;
    const groupKey = flags.recoveryGroupKey ?? buildRecoveryGroupKey(flags);
    if (requestedGroupKey && groupKey !== requestedGroupKey) continue;
    const sources = groups.get(groupKey) ?? [];
    sources.push(effect);
    groups.set(groupKey, sources);
  }
  return groups;
}

function selectDominantSource(sources) {
  if (sources.length === 0) return { selectedSource: null, comparatorId: null, potencyValues: [], reason: "non-comparable" };
  if (sources.length === 1) {
    const potency = getPotency(sources[0]);
    return { selectedSource: sources[0], comparatorId: potency.comparatorId, potencyValues: [potency.value], reason: "only-source" };
  }

  const potencies = sources.map(getPotency);
  const comparatorId = potencies[0].comparatorId;
  const comparable = Boolean(
    comparatorId && SUPPORTED_COMPARATORS.has(comparatorId) &&
    potencies.every((potency) => potency.comparable && potency.comparatorId === comparatorId)
  );
  const previous = sources.find((source) => hasManagedStatusRecoveryOvertime(source)) ?? null;
  if (!comparable) {
    return { selectedSource: previous, comparatorId, potencyValues: potencies.map((potency) => potency.value), reason: "non-comparable" };
  }
  if (comparatorId === "equal") {
    return { selectedSource: mostRecent(sources), comparatorId, potencyValues: potencies.map((potency) => potency.value), reason: "equal-most-recent" };
  }

  const scored = sources.map((source, index) => ({ source, value: potencies[index].value }));
  if (scored.some((entry) => !Number.isFinite(entry.value))) {
    return { selectedSource: previous, comparatorId, potencyValues: scored.map((entry) => entry.value), reason: "non-comparable" };
  }
  const highest = Math.max(...scored.map((entry) => entry.value));
  const strongest = scored.filter((entry) => entry.value === highest).map((entry) => entry.source);
  return {
    selectedSource: strongest.length === 1 ? strongest[0] : mostRecent(strongest),
    comparatorId,
    potencyValues: scored.map((entry) => entry.value),
    reason: strongest.length === 1 ? "higher-potency" : "equal-most-recent"
  };
}

function getPotency(effect) {
  return effect?.flags?.[MODULE_ID]?.potency ?? { comparatorId: null, value: null, comparable: false };
}

function normalizePotency(value, { resolvedDC = null, castLevel = null } = {}) {
  const potency = value && typeof value === "object" ? value : {};
  const comparatorId = normalizeIdentifier(potency.comparatorId);
  let normalizedValue = normalizeNumber(potency.value);
  if (comparatorId === "higher-save-dc") normalizedValue = normalizeNumber(resolvedDC);
  if (comparatorId === "higher-cast-level") normalizedValue = normalizeNumber(castLevel);
  return { comparatorId, value: normalizedValue, comparable: Boolean(comparatorId) || potency.comparable === true };
}

function mostRecent(sources) {
  return [...sources].sort((left, right) => {
    const leftFlags = left.flags?.[MODULE_ID] ?? {};
    const rightFlags = right.flags?.[MODULE_ID] ?? {};
    const timeDelta = Number(rightFlags.sourceAppliedOrder ?? rightFlags.sourceAppliedAt ?? 0) -
      Number(leftFlags.sourceAppliedOrder ?? leftFlags.sourceAppliedAt ?? 0);
    if (timeDelta) return timeDelta;
    return 0;
  })[0] ?? null;
}

function logDecision(actor, groupKey, sources, decision, previous, actions) {
  const familyId = sources[0]?.flags?.[MODULE_ID]?.effectFamilyId ?? null;
  const statusId = sources[0]?.flags?.[MODULE_ID]?.statusId ?? null;
  const reason = previous && decision.selectedSource?.id === previous.id && decision.reason !== "non-comparable"
    ? "unchanged"
    : decision.reason;
  console.warn(
    `[persistent-zones] PZ RECOVERY ARBITRATION DECISION | actorUuid=${actor?.uuid ?? "null"} | ` +
    `statusId=${statusId ?? "null"} | effectFamilyId=${familyId ?? "null"} | recoveryGroupKey=${groupKey} | ` +
    `sourceIds=${sources.map((source) => source.id).join(",") || "none"} | ` +
    `comparatorId=${decision.comparatorId ?? "null"} | potencyValues=${decision.potencyValues.join(",")} | ` +
    `selectedSourceId=${decision.selectedSource?.id ?? "null"} | previousSelectedSourceId=${previous?.id ?? "null"} | ` +
    `decisionReason=${reason} | overtimeActions=${actions.join(",") || "none"}`
  );
}

function buildPendingKey(actor, groupKey) {
  return `${actor?.uuid ?? actor?.id ?? "unknown-actor"}::${groupKey}`;
}

function getCombatState(combat) {
  return `${combat?.id ?? "none"}:${combat?.round ?? "none"}:${combat?.turn ?? "none"}`;
}

function joinIdentity(...parts) {
  return parts.map((part) => encodeURIComponent(String(part))).join(":");
}

function normalizeIdentifier(value) {
  return String(value ?? "").trim() || null;
}

function normalizeCanonicalCompendiumSource(value) {
  const source = normalizeIdentifier(value);
  return source && /^Compendium\.[^.]+\.[^.]+\.Item\.[^.]+$/i.test(source)
    ? source
    : null;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
