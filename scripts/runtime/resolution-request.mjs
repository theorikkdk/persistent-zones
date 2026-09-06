import { coerceNumber } from "./utils.mjs";

/** A serializable description of one PZ trigger resolution. */
export function buildResolutionRequest({ regionDocument, tokenDocument, runtime = {}, timing = "custom", triggerConfig = {}, context = {} } = {}) {
  return {
    kind: "persistent-zones-resolution-request",
    source: {
      regionUuid: regionDocument?.uuid ?? null,
      regionId: regionDocument?.id ?? null,
      groupId: runtime.groupId ?? null,
      castInstanceId: runtime.castInstanceId ?? null,
      itemUuid: runtime.itemUuid ?? null,
      activityId: runtime.activityId ?? null,
      sourceTokenUuid: runtime.sourceTokenUuid ?? null
    },
    target: { tokenUuid: tokenDocument?.uuid ?? null, actorUuid: tokenDocument?.actor?.uuid ?? null },
    trigger: {
      timing: String(timing ?? "custom"),
      movementSequenceId: context.movementSequenceId ?? null,
      turnContext: context.turnContext ?? null
    },
    save: structuredClone(triggerConfig.save ?? {}),
    damage: structuredClone(triggerConfig.damage ?? {}),
    recovery: {
      healing: structuredClone(triggerConfig.healing ?? {}),
      temporaryHitPoints: structuredClone(triggerConfig.temporaryHitPoints ?? {})
    },
    statuses: structuredClone(triggerConfig.statuses ?? {})
  };
}

export function buildDamageDescription({ value = 0, type = "force", properties = [] } = {}) {
  return {
    value: Math.max(coerceNumber(value, 0), 0),
    type: String(type ?? "force").trim().toLowerCase() || "force",
    properties: properties instanceof Set ? properties : new Set(properties ?? [])
  };
}

/**
 * Delegate typed damage, healing, and temporary HP to the D&D5e Actor API.
 * PZ never writes HP directly on the native-resolution path.
 */
export async function resolveNativeDamageApplication({ actor, entries = [] } = {}) {
  const normalizedEntries = Array.from(entries ?? []).filter((entry) => coerceNumber(entry?.value, 0) > 0);
  if (!normalizedEntries.length) return { status: "resolved", applied: false, entries: [] };
  if (typeof actor?.applyDamage !== "function") {
    return { status: "error", applied: false, entries: normalizedEntries, error: "native-actor-apply-damage-unavailable" };
  }
  try {
    const nativeResult = await actor.applyDamage(normalizedEntries);
    return { status: "resolved", applied: true, entries: normalizedEntries, nativeResult };
  } catch (caughtError) {
    return { status: "error", applied: false, entries: normalizedEntries, error: caughtError?.message ?? "native-damage-application-failed" };
  }
}
