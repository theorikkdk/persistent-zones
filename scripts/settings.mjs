import {
  DEBUG_LOG_LEVEL_SETTING_KEY,
  MODULE_ID,
  MOVEMENT_STOP_GLOBAL_MODE_MIGRATED_SETTING_KEY,
  MOVEMENT_STOP_GLOBAL_MODE_SETTING_KEY,
  MOVEMENT_STOP_GLOBAL_SETTING_KEY,
  REGION_HIGHLIGHT_MODE_SETTING_KEY,
  REGION_VISIBILITY_SETTING_KEY
} from "./constants.mjs";

export const MOVEMENT_STOP_GLOBAL_MODES = Object.freeze({
  off: "off",
  onEnter: "on-enter",
  onEnterAndMove: "on-enter-and-move"
});

export const MOVEMENT_STOP_ACTIVITY_MODES = Object.freeze({
  inherit: "inherit",
  off: "off",
  onEnter: "on-enter",
  onMove: "on-move",
  onEnterAndMove: "on-enter-and-move"
});

export const PERSISTENT_ZONES_LOG_LEVELS = Object.freeze({
  minimal: "minimal",
  standard: "standard",
  verbose: "verbose"
});

export const REGION_HIGHLIGHT_MODE_SETTINGS = Object.freeze({
  authentic: "authentic",
  grid: "grid"
});

export const REGION_VISIBILITY_SETTINGS = Object.freeze({
  layer: "layer",
  gamemaster: "gamemaster",
  always: "always"
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

  game.settings.register(MODULE_ID, REGION_HIGHLIGHT_MODE_SETTING_KEY, {
    name: "PERSISTENT_ZONES.Settings.RegionHighlightMode.Name",
    hint: "PERSISTENT_ZONES.Settings.RegionHighlightMode.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: buildLocalizedChoices({
      [REGION_HIGHLIGHT_MODE_SETTINGS.authentic]: "PERSISTENT_ZONES.Settings.RegionHighlightMode.Choices.Authentic",
      [REGION_HIGHLIGHT_MODE_SETTINGS.grid]: "PERSISTENT_ZONES.Settings.RegionHighlightMode.Choices.Grid"
    }),
    default: REGION_HIGHLIGHT_MODE_SETTINGS.authentic
  });

  game.settings.register(MODULE_ID, REGION_VISIBILITY_SETTING_KEY, {
    name: "PERSISTENT_ZONES.Settings.RegionVisibility.Name",
    hint: "PERSISTENT_ZONES.Settings.RegionVisibility.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: buildLocalizedChoices({
      [REGION_VISIBILITY_SETTINGS.layer]: "PERSISTENT_ZONES.Settings.RegionVisibility.Choices.Layer",
      [REGION_VISIBILITY_SETTINGS.gamemaster]: "PERSISTENT_ZONES.Settings.RegionVisibility.Choices.Gamemaster",
      [REGION_VISIBILITY_SETTINGS.always]: "PERSISTENT_ZONES.Settings.RegionVisibility.Choices.Always"
    }),
    default: REGION_VISIBILITY_SETTINGS.gamemaster
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
  const normalizedMode = normalizeMovementStopResolvedMode(mode);
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

  if (normalizedMode === MOVEMENT_STOP_ACTIVITY_MODES.onMove) {
    return normalizedTiming === "onMove";
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
  const activityMode = normalizeMovementStopActivityMode(triggerConfig?.interruptionMode);
  const resolvedMode = activityMode === MOVEMENT_STOP_ACTIVITY_MODES.inherit ? globalMode : activityMode;
  const timingEnabled = supportedTiming && isMovementStopEnabledForTiming(timing, resolvedMode);
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
    activityMode,
    resolvedMode,
    supportedTiming,
    timingEnabled,
    legacyFlagDetected,
    resolvedFrom: supportedTiming
      ? (
        timingEnabled
          ? (activityMode === MOVEMENT_STOP_ACTIVITY_MODES.inherit ? "global-mode" : "activity-override")
          : (
            activityMode !== MOVEMENT_STOP_ACTIVITY_MODES.inherit
              ? "activity-override-disabled-for-timing"
              : globalEnabled
                ? "global-mode-timing-disabled"
                : "global-mode-off"
          )
      )
      : "unsupported-timing",
    stopSkippedBecauseGlobalDisabled: supportedTiming && activityMode === MOVEMENT_STOP_ACTIVITY_MODES.inherit && !globalEnabled,
    stopSkippedBecauseTimingDisabled: supportedTiming && !timingEnabled
  };
}

function normalizeMovementStopResolvedMode(value) {
  const activityMode = normalizeMovementStopActivityMode(value);
  return activityMode === MOVEMENT_STOP_ACTIVITY_MODES.inherit
    ? MOVEMENT_STOP_GLOBAL_MODES.off
    : activityMode;
}

export function normalizeMovementStopActivityMode(value) {
  const normalizedValue = String(value ?? "").trim().toLowerCase();
  if (Object.values(MOVEMENT_STOP_ACTIVITY_MODES).includes(normalizedValue)) return normalizedValue;
  return MOVEMENT_STOP_ACTIVITY_MODES.inherit;
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
