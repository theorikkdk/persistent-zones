export function resolveTriggerActionConfiguration({
  zoneConfiguration = null,
  triggerId = null,
  triggerConfig = null
} = {}) {
  const config = triggerConfig ?? getTriggerFromZoneConfiguration(zoneConfiguration, triggerId) ?? {};
  const mode = normalizeTriggerMode(config.mode);
  const simpleEffect = config.simpleEffect ?? {};
  const statuses = config.statuses ?? simpleEffect.statuses ?? {};
  const healing = config.healing ?? simpleEffect.healing ?? {};
  const temporaryHitPoints = config.temporaryHitPoints ?? simpleEffect.temporaryHitPoints ?? {};
  const linkedActivity = config.linkedActivity ?? config.activity ?? {};

  return {
    mode,
    targetFilter: { mode: normalizeTriggerTargetFilterMode(config.targetFilter?.mode) },
    frequency: normalizeTriggerFrequency(config.frequency),
    frequencyGroup: String(config.frequencyGroup ?? "").trim() || null,
    requiredAbsentStatuses: normalizeStatusIdList(config.requiredAbsentStatuses ?? config.excludedStatuses),
    requiredAbsentSourceStatuses: normalizeStatusIdList(config.requiredAbsentSourceStatuses),
    damage: config.damage ?? simpleEffect.damage ?? {},
    save: config.save ?? simpleEffect.save ?? {},
    statuses,
    healing,
    temporaryHitPoints,
    linkedActivity: {
      id: linkedActivity.id ?? linkedActivity.activityId ?? null,
      uuid: linkedActivity.uuid ?? linkedActivity.activityUuid ?? null
    },
    movement: {
      movementMode: config.movementMode ?? "any",
      stepMode: config.stepMode ?? "distance",
      distanceStep: config.distanceStep ?? null,
      cellStep: config.cellStep ?? null,
      stopMovementOnTrigger: config.stopMovementOnTrigger ?? false
    },
    source: triggerConfig ? "trigger-config" : "zone-configuration",
    enabled: config.enabled !== false && mode !== "none"
  };
}

function getTriggerFromZoneConfiguration(zoneConfiguration, triggerId) {
  const triggers = zoneConfiguration?.triggers ?? {};
  switch (String(triggerId ?? "")) {
    case "create":
    case "onCreate":
      return triggers.onCreate ?? triggers.create ?? null;
    case "enter":
    case "onEnter":
      return triggers.enter ?? triggers.onEnter ?? null;
    case "move":
    case "onMove":
      return triggers.move ?? triggers.onMove ?? null;
    case "exit":
    case "onExit":
      return triggers.exit ?? triggers.onExit ?? null;
    case "turnStart":
    case "onStartTurn":
      return triggers.turnStart ?? triggers.onStartTurn ?? null;
    case "turnEnd":
    case "onEndTurn":
      return triggers.turnEnd ?? triggers.onEndTurn ?? null;
    default:
      return null;
  }
}

function normalizeTriggerTargetFilterMode(value) {
  const mode = String(value ?? "all").trim().toLowerCase();
  return ["all", "allies", "enemies", "self", "others"].includes(mode) ? mode : "all";
}

function normalizeTriggerFrequency(value) {
  return String(value ?? "unlimited").trim().toLowerCase() === "once-per-turn" ? "once-per-turn" : "unlimited";
}

function normalizeStatusIdList(value) {
  const values = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return Array.from(new Set(values.map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean)));
}

function normalizeTriggerMode(value) {
  const normalized = String(value ?? "none").trim().toLowerCase();
  if (normalized === "simple-effect" || normalized === "simple") {
    return "simple";
  }
  if (normalized === "linked-activity" || normalized === "activity") {
    return "activity";
  }
  return "none";
}
