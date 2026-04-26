import {
  DEBUG_LOG_LEVEL_SETTING_KEY,
  MODULE_ID,
  MOVEMENT_STOP_GLOBAL_MODE_MIGRATED_SETTING_KEY,
  MOVEMENT_STOP_GLOBAL_MODE_SETTING_KEY,
  MOVEMENT_STOP_GLOBAL_SETTING_KEY
} from "./constants.mjs";

export const MOVEMENT_STOP_GLOBAL_MODES = Object.freeze({
  off: "off",
  onEnter: "on-enter",
  onEnterAndMove: "on-enter-and-move"
});

export const PERSISTENT_ZONES_LOG_LEVELS = Object.freeze({
  minimal: "minimal",
  standard: "standard",
  verbose: "verbose"
});

export function registerPersistentZoneModuleSettings() {
  game.settings.register(MODULE_ID, MOVEMENT_STOP_GLOBAL_SETTING_KEY, {
    name: "PERSISTENT_ZONES.Settings.MovementStopGlobalLegacy.Name",
    hint: "PERSISTENT_ZONES.Settings.MovementStopGlobalLegacy.Hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, MOVEMENT_STOP_GLOBAL_MODE_SETTING_KEY, {
    name: "PERSISTENT_ZONES.Settings.MovementStopGlobalMode.Name",
    hint: "PERSISTENT_ZONES.Settings.MovementStopGlobalMode.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: buildLocalizedChoices({
      [MOVEMENT_STOP_GLOBAL_MODES.off]: "PERSISTENT_ZONES.Settings.MovementStopGlobalMode.Choices.Off",
      [MOVEMENT_STOP_GLOBAL_MODES.onEnter]: "PERSISTENT_ZONES.Settings.MovementStopGlobalMode.Choices.OnEnter",
      [MOVEMENT_STOP_GLOBAL_MODES.onEnterAndMove]: "PERSISTENT_ZONES.Settings.MovementStopGlobalMode.Choices.OnEnterAndMove"
    }),
    default: MOVEMENT_STOP_GLOBAL_MODES.off
  });

  game.settings.register(MODULE_ID, MOVEMENT_STOP_GLOBAL_MODE_MIGRATED_SETTING_KEY, {
    name: "PERSISTENT_ZONES.Settings.MovementStopGlobalModeMigrated.Name",
    hint: "PERSISTENT_ZONES.Settings.MovementStopGlobalModeMigrated.Hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, DEBUG_LOG_LEVEL_SETTING_KEY, {
    name: "PERSISTENT_ZONES.Settings.DebugLogLevel.Name",
    hint: "PERSISTENT_ZONES.Settings.DebugLogLevel.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: buildLocalizedChoices({
      [PERSISTENT_ZONES_LOG_LEVELS.minimal]: "PERSISTENT_ZONES.Settings.DebugLogLevel.Choices.Minimal",
      [PERSISTENT_ZONES_LOG_LEVELS.standard]: "PERSISTENT_ZONES.Settings.DebugLogLevel.Choices.Standard",
      [PERSISTENT_ZONES_LOG_LEVELS.verbose]: "PERSISTENT_ZONES.Settings.DebugLogLevel.Choices.Verbose"
    }),
    default: PERSISTENT_ZONES_LOG_LEVELS.standard
  });
}

export async function migrateLegacyMovementStopGlobalSetting() {
  if (!game.user?.isGM) {
    return {
      changed: false,
      skipped: true,
      reason: "user-not-gm"
    };
  }

  const alreadyMigrated = Boolean(
    game.settings.get(MODULE_ID, MOVEMENT_STOP_GLOBAL_MODE_MIGRATED_SETTING_KEY)
  );
  const legacyEnabled = Boolean(
    game.settings.get(MODULE_ID, MOVEMENT_STOP_GLOBAL_SETTING_KEY)
  );
  const currentMode = normalizeMovementStopGlobalMode(
    game.settings.get(MODULE_ID, MOVEMENT_STOP_GLOBAL_MODE_SETTING_KEY)
  );

  if (alreadyMigrated) {
    return {
      changed: false,
      migrated: true,
      legacyEnabled,
      globalMode: currentMode,
      migratedFrom: "already-migrated"
    };
  }

  let nextMode = currentMode;
  let changed = false;
  let migratedFrom = "default";

  if (legacyEnabled && currentMode === MOVEMENT_STOP_GLOBAL_MODES.off) {
    nextMode = MOVEMENT_STOP_GLOBAL_MODES.onEnterAndMove;
    await game.settings.set(MODULE_ID, MOVEMENT_STOP_GLOBAL_MODE_SETTING_KEY, nextMode);
    changed = true;
    migratedFrom = "legacy-enabled";
  }

  await game.settings.set(MODULE_ID, MOVEMENT_STOP_GLOBAL_MODE_MIGRATED_SETTING_KEY, true);

  return {
    changed,
    migrated: true,
    legacyEnabled,
    globalMode: nextMode,
    migratedFrom
  };
}

export function getMovementStopGlobalMode() {
  return normalizeMovementStopGlobalMode(
    game.settings.get(MODULE_ID, MOVEMENT_STOP_GLOBAL_MODE_SETTING_KEY)
  );
}

export function isMovementStopGlobalEnabled() {
  return getMovementStopGlobalMode() !== MOVEMENT_STOP_GLOBAL_MODES.off;
}

export function isMovementStopSupportedTiming(timing) {
  return timing === "onEnter" || timing === "onMove";
}

export function isMovementStopEnabledForTiming(timing, mode = getMovementStopGlobalMode()) {
  const normalizedMode = normalizeMovementStopGlobalMode(mode);
  const normalizedTiming = String(timing ?? "").trim();

  if (!isMovementStopSupportedTiming(normalizedTiming)) {
    return false;
  }

  if (normalizedMode === MOVEMENT_STOP_GLOBAL_MODES.onEnterAndMove) {
    return normalizedTiming === "onEnter" || normalizedTiming === "onMove";
  }

  if (normalizedMode === MOVEMENT_STOP_GLOBAL_MODES.onEnter) {
    return normalizedTiming === "onEnter";
  }

  return false;
}

export function getSupportedMovementStopTimingsForMode(mode = getMovementStopGlobalMode()) {
  const normalizedMode = normalizeMovementStopGlobalMode(mode);

  if (normalizedMode === MOVEMENT_STOP_GLOBAL_MODES.onEnterAndMove) {
    return ["onEnter", "onMove"];
  }

  if (normalizedMode === MOVEMENT_STOP_GLOBAL_MODES.onEnter) {
    return ["onEnter"];
  }

  return [];
}

export function getPersistentZonesLogLevel() {
  return normalizePersistentZonesLogLevel(
    game.settings.get(MODULE_ID, DEBUG_LOG_LEVEL_SETTING_KEY)
  );
}

export function resolveMovementStopGlobalState(triggerConfig = {}, timing = null) {
  const globalMode = getMovementStopGlobalMode();
  const globalEnabled = globalMode !== MOVEMENT_STOP_GLOBAL_MODES.off;
  const supportedTiming = isMovementStopSupportedTiming(timing);
  const timingEnabled = supportedTiming && isMovementStopEnabledForTiming(timing, globalMode);
  const legacyFlagDetected = Boolean(
    triggerConfig &&
    typeof triggerConfig === "object" &&
    (
      Object.prototype.hasOwnProperty.call(triggerConfig, "stopMovementOnTrigger") ||
      Object.prototype.hasOwnProperty.call(triggerConfig, "stopOnTrigger")
    )
  );

  return {
    enabled: timingEnabled,
    globalEnabled,
    globalMode,
    supportedTiming,
    timingEnabled,
    legacyFlagDetected,
    resolvedFrom: supportedTiming
      ? (
        timingEnabled
          ? "global-mode"
          : (
            globalEnabled
              ? "global-mode-timing-disabled"
              : "global-mode-off"
          )
      )
      : "unsupported-timing",
    stopSkippedBecauseGlobalDisabled: supportedTiming && !globalEnabled,
    stopSkippedBecauseTimingDisabled: supportedTiming && globalEnabled && !timingEnabled
  };
}

export function detectLegacyMovementStopFlags(definition) {
  return scanForLegacyMovementStopFlags(definition);
}

export function normalizeMovementStopGlobalMode(value) {
  const normalizedValue = String(value ?? "").trim().toLowerCase();

  if (normalizedValue === MOVEMENT_STOP_GLOBAL_MODES.onEnterAndMove) {
    return MOVEMENT_STOP_GLOBAL_MODES.onEnterAndMove;
  }

  if (normalizedValue === MOVEMENT_STOP_GLOBAL_MODES.onEnter) {
    return MOVEMENT_STOP_GLOBAL_MODES.onEnter;
  }

  return MOVEMENT_STOP_GLOBAL_MODES.off;
}

export function normalizePersistentZonesLogLevel(value) {
  const normalizedValue = String(value ?? "").trim().toLowerCase();

  if (normalizedValue === PERSISTENT_ZONES_LOG_LEVELS.minimal) {
    return PERSISTENT_ZONES_LOG_LEVELS.minimal;
  }

  if (normalizedValue === PERSISTENT_ZONES_LOG_LEVELS.verbose) {
    return PERSISTENT_ZONES_LOG_LEVELS.verbose;
  }

  return PERSISTENT_ZONES_LOG_LEVELS.standard;
}

function buildLocalizedChoices(choiceKeyMap = {}) {
  return Object.fromEntries(
    Object.entries(choiceKeyMap).map(([value, key]) => [
      value,
      game.i18n?.localize?.(key) ?? value
    ])
  );
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
