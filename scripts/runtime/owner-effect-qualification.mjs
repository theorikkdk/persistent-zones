export function isStatusSourceEffect(activeEffect, moduleId) {
  const data = activeEffect?.toObject?.() ?? {};
  const flags = {
    ...(data?.flags?.[moduleId] ?? {}),
    ...(activeEffect?.flags?.[moduleId] ?? {})
  };
  return Boolean(
    flags.managedTriggeredEffect === true ||
    flags.statusRecovery ||
    (flags.statusId && flags.tokenUuid && (flags.regionId || flags.regionUuid))
  );
}

export function qualifyLifecycleOwnerCandidate({
  dedicatedOwnerEffect = false,
  statusSourceEffect = false,
  concentrationEffect = false,
  actorRequired = false,
  actorMatches = false,
  itemRequired = false,
  itemMatches = false,
  activityRequired = false,
  activityMatches = false,
  workflowMatches = false
} = {}) {
  if (dedicatedOwnerEffect) return { eligible: true, reason: "dedicated-owner-effect" };
  if (statusSourceEffect) return { eligible: false, reason: "status-source-effect-excluded" };
  if (actorRequired && !actorMatches) return { eligible: false, reason: "caster-actor-mismatch" };
  if (itemRequired && !itemMatches) return { eligible: false, reason: "source-item-mismatch" };
  if (!concentrationEffect) return { eligible: false, reason: "missing-concentration-signal" };
  if (activityRequired && !activityMatches && !workflowMatches) {
    return { eligible: false, reason: "activity-or-workflow-mismatch" };
  }
  return { eligible: true, reason: "structured-concentration-owner" };
}

export function shouldHandleLifecycleEffect(activeEffect, moduleId, { referencedRegionCount = 0 } = {}) {
  return referencedRegionCount > 0 && !isStatusSourceEffect(activeEffect, moduleId);
}
