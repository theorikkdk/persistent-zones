import { MODULE_ID } from "../constants.mjs";

const STATUS_RECOVERY_MODES = new Set([
  "none",
  "save-start-turn",
  "save-end-turn"
]);

const STATUS_RECOVERY_DC_MODES = new Set(["inherit", "custom"]);
const STATUS_RECOVERY_PROVIDERS = new Set(["auto", "midi", "native"]);
const FALLBACK_ABILITY_IDS = new Set(["str", "dex", "con", "int", "wis", "cha"]);
const MIDI_OVERTIME_CHANGE_KEY = "flags.midi-qol.OverTime";

export const UNSUPPORTED_STATUS_RECOVERY_PROVIDER_ID = "unsupported";

/**
 * Normalize the portable recovery intent stored by Persistent Zones.
 *
 * `inherit` deliberately does not resolve a DC here. The provider resolves it
 * when the status ActiveEffect is applied, using the cast context, then stores
 * that concrete value on the effect.
 */
export function normalizeStatusRecovery(recoveryLike) {
  const recovery = isPlainObject(recoveryLike) ? recoveryLike : {};
  const requestedMode = normalizeChoice(recovery.mode, "none");
  const mode = STATUS_RECOVERY_MODES.has(requestedMode) ? requestedMode : "none";
  const requiresSave = mode === "save-start-turn" || mode === "save-end-turn";
  const requestedDcMode = normalizeChoice(recovery.dcMode, "inherit");
  const dcMode = STATUS_RECOVERY_DC_MODES.has(requestedDcMode) ? requestedDcMode : "inherit";
  const requestedProvider = normalizeChoice(recovery.provider ?? recovery.requestedProvider, "auto");
  const provider = STATUS_RECOVERY_PROVIDERS.has(requestedProvider) ? requestedProvider : "auto";

  return {
    mode,
    ability: requiresSave ? normalizeAbilityId(recovery.ability) : null,
    dcMode,
    customDC: dcMode === "custom" ? normalizePositiveNumber(recovery.customDC) : null,
    removeOnSuccess: normalizeBoolean(recovery.removeOnSuccess, true),
    provider,
    effectFamilyId: normalizeNullableString(recovery.effectFamilyId),
    potency: normalizeRecoveryPotency(recovery.potency)
  };
}

export function getStatusRecoveryCapabilities() {
  const midiActive = isModuleActive("midi-qol");
  const daeActive = isModuleActive("dae");
  const midiAvailable = midiActive && daeActive;

  return {
    midi: {
      available: midiAvailable,
      providerId: "midi",
      supportsSaveStartTurn: false,
      supportsSaveEndTurn: midiAvailable,
      supportsRemoveOnSuccess: midiAvailable,
      midiActive,
      daeActive,
      reason: midiAvailable
        ? "midi-and-dae-active"
        : !midiActive
          ? "midi-inactive"
          : "dae-inactive"
    },
    native: {
      available: false,
      providerId: "native",
      supportsSaveStartTurn: false,
      supportsSaveEndTurn: false,
      supportsRemoveOnSuccess: false,
      reason: "native-provider-not-implemented"
    }
  };
}

export function resolveStatusRecoveryProvider(recoveryLike, context = {}) {
  const recovery = normalizeStatusRecovery(recoveryLike);
  const capabilities = context.capabilities ?? getStatusRecoveryCapabilities();
  const requestedProvider = recovery.provider;
  let selectedProvider = null;
  let reason = "recovery-disabled";

  if (recovery.mode !== "none") {
    if (requestedProvider === "native") {
      selectedProvider = capabilities.native?.available
        ? "native"
        : UNSUPPORTED_STATUS_RECOVERY_PROVIDER_ID;
      reason = capabilities.native?.available
        ? "requested-native-available"
        : capabilities.native?.reason ?? "requested-native-unavailable";
    } else if (requestedProvider === "midi") {
      selectedProvider = capabilities.midi?.available
        ? "midi"
        : UNSUPPORTED_STATUS_RECOVERY_PROVIDER_ID;
      reason = capabilities.midi?.available
        ? "requested-midi-available"
        : capabilities.midi?.reason ?? "requested-midi-unavailable";
    } else if (capabilities.midi?.available) {
      selectedProvider = "midi";
      reason = "auto-selected-midi";
    } else {
      selectedProvider = UNSUPPORTED_STATUS_RECOVERY_PROVIDER_ID;
      reason = "auto-no-provider-available";
    }

    logProviderDecision({ recovery, capabilities, selectedProvider, reason });
  }

  return {
    recovery,
    requestedProvider,
    selectedProvider,
    providerAvailable: Boolean(
      selectedProvider && selectedProvider !== UNSUPPORTED_STATUS_RECOVERY_PROVIDER_ID
    ),
    capabilities,
    reason
  };
}

export function buildStatusRecoveryPatch(recoveryLike, context = {}) {
  const decision = resolveStatusRecoveryProvider(recoveryLike, context);
  const recovery = decision.recovery;
  const persistenceMode = normalizeChoice(context.persistenceMode, "persistent");
  const resolvedDC = resolveEffectiveRecoveryDC(recovery, context);
  let reason = decision.reason;
  let overtimeValue = null;
  let patch = null;

  if (recovery.mode === "none") {
    reason = "recovery-disabled";
  } else if (persistenceMode !== "persistent") {
    reason = "unsupported-persistence-mode";
  } else if (recovery.mode !== "save-end-turn") {
    reason = "unsupported-recovery-mode";
  } else if (decision.selectedProvider !== "midi") {
    reason = decision.reason;
  } else if (!recovery.ability) {
    reason = "missing-or-invalid-ability";
  } else if (recovery.dcMode === "inherit" && resolvedDC === null) {
    reason = "missing-inherited-dc";
  } else if (recovery.dcMode === "custom" && resolvedDC === null) {
    reason = "missing-or-invalid-custom-dc";
  } else if (recovery.removeOnSuccess !== true) {
    reason = "unsupported-removeOnSuccess-false";
  } else {
    overtimeValue = [
      "turn=end",
      "rollType=save",
      `saveAbility=${recovery.ability}`,
      `saveDC=${resolvedDC}`,
      "saveCount=1-"
    ].join(",");
    patch = {
      system: {
        changes: [{
          key: MIDI_OVERTIME_CHANGE_KEY,
          type: "override",
          value: overtimeValue
        }]
      },
      flags: {
        [MODULE_ID]: {
          statusRecovery: {
            mode: recovery.mode,
            ability: recovery.ability,
            dcMode: recovery.dcMode,
            customDC: recovery.customDC,
            resolvedDC,
            removeOnSuccess: recovery.removeOnSuccess,
            requestedProvider: recovery.provider,
            selectedProvider: decision.selectedProvider,
            overtimeValue,
            effectFamilyId: recovery.effectFamilyId,
            potency: recovery.potency
          }
        }
      }
    };
    reason = "midi-overtime-patch-built";
  }

  const result = {
    patch,
    applied: Boolean(patch),
    decision,
    resolvedDC,
    overtimeValue,
    reason
  };
  logRecoveryPatch({
    effectStatusId: context.effectStatusId,
    recovery,
    persistenceMode,
    decision,
    resolvedDC,
    patchApplied: result.applied,
    overtimeValue,
    reason
  });
  return result;
}

export async function updateStatusRecovery(effect, recoveryLike, context = {}) {
  const result = buildStatusRecoveryPatch(recoveryLike, context);
  if (!effect || !result.patch || typeof effect.update !== "function") {
    return { ...result, effect, updated: false };
  }

  const retainedChanges = Array.from(effect.system?.changes ?? effect.changes ?? [])
    .filter((change) => !isManagedOvertimeChange(effect, change))
    .map((change) => typeof change?.toObject === "function" ? change.toObject() : { ...change });
  await effect.update({
    "system.changes": [...retainedChanges, ...result.patch.system.changes],
    [`flags.${MODULE_ID}.statusRecovery`]: result.patch.flags[MODULE_ID].statusRecovery
  });
  return { ...result, effect, updated: true };
}

export async function removeStatusRecovery(effect) {
  if (!effect || typeof effect.update !== "function") {
    return { effect, removed: false, reason: "missing-updatable-effect" };
  }

  const changes = Array.from(effect.system?.changes ?? effect.changes ?? []);
  const retainedChanges = changes
    .filter((change) => !isManagedOvertimeChange(effect, change))
    .map((change) => typeof change?.toObject === "function" ? change.toObject() : { ...change });
  if (retainedChanges.length === changes.length) {
    return { effect, removed: false, reason: "managed-overtime-not-found" };
  }

  await effect.update({ "system.changes": retainedChanges });
  return { effect, removed: true, reason: "managed-overtime-removed" };
}

export function hasManagedStatusRecoveryOvertime(effect) {
  return Array.from(effect?.system?.changes ?? effect?.changes ?? [])
    .some((change) => isManagedOvertimeChange(effect, change));
}

function isManagedOvertimeChange(effect, change) {
  if (change?.key !== MIDI_OVERTIME_CHANGE_KEY) return false;
  const managedValue = effect?.flags?.[MODULE_ID]?.statusRecovery?.overtimeValue ?? null;
  return Boolean(managedValue && String(change?.value ?? "") === String(managedValue));
}

function normalizeRecoveryPotency(value) {
  const potency = isPlainObject(value) ? value : {};
  const comparatorId = normalizeNullableString(potency.comparatorId);
  const numericValue = potency.value === null || potency.value === undefined || potency.value === ""
    ? null
    : Number(potency.value);
  return {
    comparatorId,
    value: Number.isFinite(numericValue) ? numericValue : null,
    comparable: potency.comparable === true || Boolean(comparatorId)
  };
}

function normalizeNullableString(value) {
  return String(value ?? "").trim() || null;
}

function resolveEffectiveRecoveryDC(recovery, context) {
  const candidate = recovery.dcMode === "custom"
    ? recovery.customDC
    : context.resolvedDC ?? context.saveDC;
  return normalizePositiveNumber(candidate);
}

function normalizeAbilityId(value) {
  const ability = String(value ?? "").trim().toLowerCase();
  if (!ability) return null;

  const configuredAbilities = globalThis.CONFIG?.DND5E?.abilities;
  const configuredIds = configuredAbilities && typeof configuredAbilities === "object"
    ? new Set(Object.keys(configuredAbilities).map((key) => String(key).toLowerCase()))
    : FALLBACK_ABILITY_IDS;
  return configuredIds.has(ability) ? ability : null;
}

function normalizePositiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function normalizeChoice(value, fallback) {
  return String(value ?? fallback).trim().toLowerCase();
}

function isModuleActive(moduleId) {
  return globalThis.game?.modules?.get?.(moduleId)?.active === true;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function logProviderDecision({ recovery, capabilities, selectedProvider, reason }) {
  console.warn(
    `[persistent-zones] PZ STATUS RECOVERY PROVIDER DECISION | ` +
    `recoveryMode=${recovery.mode} | requestedProvider=${recovery.provider} | ` +
    `selectedProvider=${selectedProvider} | midiActive=${capabilities.midi?.midiActive === true} | ` +
    `daeActive=${capabilities.midi?.daeActive === true} | ` +
    `providerAvailable=${selectedProvider !== UNSUPPORTED_STATUS_RECOVERY_PROVIDER_ID} | reason=${reason}`
  );
}

function logRecoveryPatch({
  effectStatusId,
  recovery,
  persistenceMode,
  decision,
  resolvedDC,
  patchApplied,
  overtimeValue,
  reason
}) {
  if (recovery.mode === "none") return;
  console.warn(
    `[persistent-zones] PZ STATUS RECOVERY PATCH | ` +
    `effectStatusId=${effectStatusId ?? "null"} | recoveryMode=${recovery.mode} | ` +
    `persistenceMode=${persistenceMode} | requestedProvider=${recovery.provider} | ` +
    `selectedProvider=${decision.selectedProvider ?? "null"} | ability=${recovery.ability ?? "null"} | ` +
    `dcMode=${recovery.dcMode} | resolvedDC=${resolvedDC ?? "null"} | patchApplied=${patchApplied === true} | ` +
    `overtimeValue=${overtimeValue ?? "null"} | reason=${reason}`
  );
}
