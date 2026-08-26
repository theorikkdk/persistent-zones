const STATUS_RECOVERY_MODES = new Set([
  "none",
  "save-start-turn",
  "save-end-turn"
]);

const STATUS_RECOVERY_DC_MODES = new Set(["inherit", "custom"]);
const STATUS_RECOVERY_PROVIDERS = new Set(["auto", "midi", "native"]);
const FALLBACK_ABILITY_IDS = new Set(["str", "dex", "con", "int", "wis", "cha"]);

export const UNSUPPORTED_STATUS_RECOVERY_PROVIDER_ID = "unsupported";

/**
 * Normalize the portable recovery intent stored by Persistent Zones.
 *
 * `inherit` deliberately does not resolve a DC here. A later execution lot will
 * resolve it when the status ActiveEffect is applied, using the cast context,
 * then persist that concrete value on the effect.
 */
export function normalizeStatusRecovery(recoveryLike) {
  const recovery = isPlainObject(recoveryLike) ? recoveryLike : {};
  const requestedMode = normalizeChoice(recovery.mode, "none");
  const mode = STATUS_RECOVERY_MODES.has(requestedMode) ? requestedMode : "none";
  const requiresSave = mode === "save-start-turn" || mode === "save-end-turn";
  const requestedDcMode = normalizeChoice(recovery.dcMode, "inherit");
  const dcMode = STATUS_RECOVERY_DC_MODES.has(requestedDcMode) ? requestedDcMode : "inherit";
  const requestedProvider = normalizeChoice(recovery.provider, "auto");
  const provider = STATUS_RECOVERY_PROVIDERS.has(requestedProvider) ? requestedProvider : "auto";

  return {
    mode,
    ability: requiresSave ? normalizeAbilityId(recovery.ability) : null,
    dcMode,
    customDC: dcMode === "custom" ? normalizePositiveNumber(recovery.customDC) : null,
    removeOnSuccess: normalizeBoolean(recovery.removeOnSuccess, true),
    provider
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
      supportsSaveStartTurn: midiAvailable,
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

// Provider mutation is intentionally not implemented in LOT 2E-B.
export function buildStatusRecoveryPatch(recoveryLike, context = {}) {
  const decision = resolveStatusRecoveryProvider(recoveryLike, context);
  return { patch: null, applied: false, decision, reason: "provider-execution-not-implemented" };
}

export async function updateStatusRecovery(effect, recoveryLike, context = {}) {
  const result = buildStatusRecoveryPatch(recoveryLike, context);
  return { ...result, effect, updated: false };
}

export async function removeStatusRecovery(effect) {
  return { effect, removed: false, reason: "provider-execution-not-implemented" };
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
