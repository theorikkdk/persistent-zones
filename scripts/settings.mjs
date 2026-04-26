import {
  MODULE_ID,
  MOVEMENT_STOP_GLOBAL_SETTING_KEY
} from "./constants.mjs";

export function registerPersistentZoneModuleSettings() {
  game.settings.register(MODULE_ID, MOVEMENT_STOP_GLOBAL_SETTING_KEY, {
    name: "PERSISTENT_ZONES.Settings.MovementStopGlobal.Name",
    hint: "PERSISTENT_ZONES.Settings.MovementStopGlobal.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}

export function isMovementStopGlobalEnabled() {
  return Boolean(game.settings.get(MODULE_ID, MOVEMENT_STOP_GLOBAL_SETTING_KEY));
}

export function isMovementStopSupportedTiming(timing) {
  return timing === "onEnter" || timing === "onMove";
}

export function resolveMovementStopGlobalState(triggerConfig = {}, timing = null) {
  const globalEnabled = isMovementStopGlobalEnabled();
  const supportedTiming = isMovementStopSupportedTiming(timing);
  const legacyFlagDetected = Boolean(
    triggerConfig &&
    typeof triggerConfig === "object" &&
    (
      Object.prototype.hasOwnProperty.call(triggerConfig, "stopMovementOnTrigger") ||
      Object.prototype.hasOwnProperty.call(triggerConfig, "stopOnTrigger")
    )
  );

  return {
    enabled: supportedTiming && globalEnabled,
    globalEnabled,
    supportedTiming,
    legacyFlagDetected,
    resolvedFrom: supportedTiming ? "global-setting" : "unsupported-timing",
    stopSkippedBecauseGlobalDisabled: supportedTiming && !globalEnabled
  };
}

export function detectLegacyMovementStopFlags(definition) {
  return scanForLegacyMovementStopFlags(definition);
}

function scanForLegacyMovementStopFlags(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "stopMovementOnTrigger") ||
    Object.prototype.hasOwnProperty.call(value, "stopOnTrigger")
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => scanForLegacyMovementStopFlags(entry));
  }

  return Object.values(value).some((entry) => scanForLegacyMovementStopFlags(entry));
}
