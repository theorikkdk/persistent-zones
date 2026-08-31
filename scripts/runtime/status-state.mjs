import { MODULE_ID } from "../constants.mjs";
import { hasManagedStatusRecoveryOvertime } from "./status-recovery.mjs";
import {
  buildRecoveryGroupKey,
  isRecoveryPromotionPending,
  markRecoveryPromotionDeferred,
  reconcileRecoveryArbitration
} from "./status-recovery-arbitration.mjs";

const pendingExpiredSourceDeletions = new Set();

export function registerStatusStateHooks() {
  Hooks.on("updateActiveEffect", (effect, changed = {}, options = {}, userId = null) => {
    if (userId && userId !== game.user?.id) return;
    Promise.resolve(handleUpdatedStatusSource(effect, changed, options)).catch((caughtError) => {
      console.error("[persistent-zones] Failed to cleanup an inactive status source.", caughtError, {
        effectId: effect?.id ?? null,
        actorUuid: effect?.parent?.uuid ?? null
      });
    });
  });

  Hooks.on("deleteActiveEffect", (effect, options = {}, userId = null) => {
    if (userId && userId !== game.user?.id) return;
    Promise.resolve(handleDeletedStatusEffect(effect, options)).catch((caughtError) => {
      console.error("[persistent-zones] Failed to reconcile aggregate status after ActiveEffect deletion.", caughtError, {
        effectId: effect?.id ?? null,
        actorUuid: effect?.parent?.uuid ?? null
      });
    });
  });
}

export function getManagedStatusSources(actor, statusId) {
  const normalizedStatusId = normalizeStatusId(statusId);
  if (!actor || !normalizedStatusId) return [];
  return Array.from(actor.effects ?? []).filter((effect) => {
    const flags = effect?.flags?.[MODULE_ID] ?? {};
    return flags.managedTriggeredEffect === true &&
      flags.statusId === normalizedStatusId &&
      effect?.active === true;
  });
}

export function getCanonicalStatusEffect(actor, statusId) {
  const status = getConfiguredStatus(statusId);
  const canonicalEffectId = String(status?._id ?? "").trim();
  if (!actor || !canonicalEffectId) return null;
  return actor.effects?.get?.(canonicalEffectId) ??
    Array.from(actor.effects ?? []).find((effect) => effect?.id === canonicalEffectId) ??
    null;
}

export async function ensureAggregateStatus(actor, statusId, {
  missingAction = "create"
} = {}) {
  const normalizedStatusId = normalizeStatusId(statusId);
  const sources = getManagedStatusSources(actor, normalizedStatusId);
  let canonical = getCanonicalStatusEffect(actor, normalizedStatusId);
  const canonicalExisted = Boolean(canonical);

  if (!actor || !normalizedStatusId || sources.length === 0) {
    return logAggregateDecision({
      actor,
      statusId: normalizedStatusId,
      sources,
      canonical,
      action: "keep"
    });
  }

  if (!canonical) {
    const toggled = await actor.toggleStatusEffect(normalizedStatusId, { active: true });
    canonical = getCanonicalStatusEffect(actor, normalizedStatusId);
    const createdByPersistentZones = Boolean(
      canonical && toggled && toggled !== true && toggled !== false && toggled?.id === canonical.id
    );
    if (createdByPersistentZones) {
      await canonical.update({
        [`flags.${MODULE_ID}.managedAggregateStatus`]: true,
        [`flags.${MODULE_ID}.statusId`]: normalizedStatusId
      });
      canonical = getCanonicalStatusEffect(actor, normalizedStatusId) ?? canonical;
    }
  }

  return logAggregateDecision({
    actor,
    statusId: normalizedStatusId,
    sources,
    canonical,
    action: canonicalExisted ? "keep" : missingAction
  });
}

export async function reconcileAggregateStatus(actor, statusId, {
  missingAction = "recreate"
} = {}) {
  const normalizedStatusId = normalizeStatusId(statusId);
  const sources = getManagedStatusSources(actor, normalizedStatusId);
  const canonical = getCanonicalStatusEffect(actor, normalizedStatusId);
  const canonicalOwnedByPZ = isCanonicalOwnedByPersistentZones(canonical, normalizedStatusId);

  if (sources.length > 0) {
    if (canonical) {
      return logAggregateDecision({
        actor,
        statusId: normalizedStatusId,
        sources,
        canonical,
        action: "keep"
      });
    }
    return ensureAggregateStatus(actor, normalizedStatusId, { missingAction });
  }

  if (canonical && canonicalOwnedByPZ) {
    await actor.toggleStatusEffect(normalizedStatusId, { active: false });
    return logAggregateDecision({
      actor,
      statusId: normalizedStatusId,
      sources,
      canonical: null,
      action: "remove",
      canonicalOwnedByPZ: true
    });
  }

  return logAggregateDecision({
    actor,
    statusId: normalizedStatusId,
    sources,
    canonical,
    action: canonical ? "preserve-external" : "keep"
  });
}

export async function handleDeletedStatusEffect(effect, options = {}) {
  const actor = effect?.parent ?? null;
  const flags = effect?.flags?.[MODULE_ID] ?? {};
  if (!actor) return;

  if (flags.managedTriggeredEffect === true && flags.statusId) {
    const recoveryGroupKey = flags.recoveryGroupKey ?? (flags.statusRecovery
      ? buildRecoveryGroupKey(flags)
      : null);
    const deferActivation = Boolean(
      recoveryGroupKey && isRecoveryPromotionPending(actor, recoveryGroupKey)
    );
    const canonicalRemovalCascade = options?.persistentZonesCanonicalStatusRemoval === true;
    const result = canonicalRemovalCascade
      ? {
          sourceCount: getManagedStatusSources(actor, flags.statusId).length,
          action: "suppress-recreate-after-canonical-removal"
        }
      : await reconcileAggregateStatus(actor, flags.statusId, {
          missingAction: "recreate"
        });
    if (recoveryGroupKey) {
      await reconcileRecoveryArbitration(actor, recoveryGroupKey, {
        deferActivation,
        removedSourceId: effect?.id ?? null,
        reason: deferActivation
          ? options?.expiryReason ?? "midi-recovery-expiration"
          : "source-deleted"
      });
    }
    console.warn(
      `[persistent-zones] PZ STATUS SOURCE REMOVED | ` +
      `effectId=${effect?.id ?? "null"} | statusId=${flags.statusId} | ` +
      `remainingSourceCount=${result.sourceCount} | aggregateAction=${result.action}`
    );
    return;
  }

  const canonicalStatusId = getCanonicalStatusId(effect);
  if (!canonicalStatusId) return;
  const matchedSources = getManagedStatusSources(actor, canonicalStatusId);
  const matchedSourceIds = matchedSources.map((source) => source?.id).filter(Boolean);
  if (matchedSourceIds.length > 0) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", matchedSourceIds, {
      persistentZonesCanonicalStatusRemoval: true,
      persistentZonesStatusId: canonicalStatusId
    });
  }
}

async function handleUpdatedStatusSource(effect, changed = {}, options = {}) {
  const actor = effect?.parent ?? null;
  const flags = effect?.flags?.[MODULE_ID] ?? {};
  if (!actor || flags.managedTriggeredEffect !== true || !flags.statusId) return;

  const disabled = effect?.disabled === true;
  const expired = effect?.duration?.expired === true;
  const sourceCountBefore = getManagedStatusSources(actor, flags.statusId).length + (effect?.active === true ? 0 : 1);
  if (effect?.active === true) {
    logExpiredStatusSource({
      actor,
      effect,
      flags,
      disabled,
      expired,
      sourceCountBefore,
      action: "ignore-still-active"
    });
    return;
  }

  const deletionKey = effect?.uuid ?? `${actor.uuid}.${effect?.id ?? "unknown"}`;
  if (pendingExpiredSourceDeletions.has(deletionKey)) return;
  if (!actor.effects?.get?.(effect.id)) return;

  pendingExpiredSourceDeletions.add(deletionKey);
  if (expired && hasManagedStatusRecoveryOvertime(effect)) {
    markRecoveryPromotionDeferred(
      actor,
      effect,
      options?.["expiry-reason"] ?? options?.expiryReason ?? "midi-recovery-expiration"
    );
  }
  logExpiredStatusSource({
    actor,
    effect,
    flags,
    disabled,
    expired,
    sourceCountBefore,
    action: "delete-source"
  });
  try {
    await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id], {
      persistentZonesExpiredStatusSourceCleanup: true,
      sourceUpdateKeys: Object.keys(changed ?? {}),
      expiryReason: options?.["expiry-reason"] ?? options?.expiryReason ?? null
    });
  } finally {
    pendingExpiredSourceDeletions.delete(deletionKey);
  }
}

function getCanonicalStatusId(effect) {
  const effectId = String(effect?.id ?? "").trim();
  if (!effectId) return null;
  const status = getConfiguredStatuses().find((entry) => entry?._id === effectId) ?? null;
  return normalizeStatusId(status?.id);
}

function getConfiguredStatus(statusId) {
  const normalizedStatusId = normalizeStatusId(statusId);
  if (!normalizedStatusId) return null;
  return globalThis.CONFIG?.statusEffects?.[normalizedStatusId] ??
    getConfiguredStatuses().find((entry) => entry?.id === normalizedStatusId) ??
    null;
}

function getConfiguredStatuses() {
  const statuses = globalThis.CONFIG?.statusEffects ?? [];
  return Array.isArray(statuses) ? statuses : Object.values(statuses);
}

function isCanonicalOwnedByPersistentZones(canonical, statusId) {
  const flags = canonical?.flags?.[MODULE_ID] ?? {};
  return flags.managedAggregateStatus === true && flags.statusId === statusId;
}

function normalizeStatusId(value) {
  return String(value ?? "").trim() || null;
}

function logAggregateDecision({
  actor,
  statusId,
  sources = [],
  canonical = null,
  action,
  canonicalOwnedByPZ = null
}) {
  const owned = canonicalOwnedByPZ ?? isCanonicalOwnedByPersistentZones(canonical, statusId);
  const result = {
    actorUuid: actor?.uuid ?? null,
    statusId,
    sourceCount: sources.length,
    canonicalEffectId: canonical?.id ?? null,
    canonicalExists: Boolean(canonical),
    canonicalOwnedByPZ: owned,
    action
  };
  console.warn(
    `[persistent-zones] PZ AGGREGATE STATUS DECISION | ` +
    `actorUuid=${result.actorUuid ?? "null"} | statusId=${result.statusId ?? "null"} | ` +
    `sourceCount=${result.sourceCount} | canonicalEffectId=${result.canonicalEffectId ?? "null"} | ` +
    `canonicalExists=${result.canonicalExists} | canonicalOwnedByPZ=${result.canonicalOwnedByPZ} | ` +
    `action=${result.action}`
  );
  return result;
}

function logExpiredStatusSource({
  actor,
  effect,
  flags,
  disabled,
  expired,
  sourceCountBefore,
  action
}) {
  console.warn(
    `[persistent-zones] PZ STATUS SOURCE EXPIRED | ` +
    `actorUuid=${actor?.uuid ?? "null"} | effectId=${effect?.id ?? "null"} | ` +
    `statusId=${flags.statusId ?? "null"} | recoveryMode=${flags.statusRecovery?.mode ?? "none"} | ` +
    `disabled=${disabled} | expired=${expired} | sourceCountBefore=${sourceCountBefore} | action=${action}`
  );
}
