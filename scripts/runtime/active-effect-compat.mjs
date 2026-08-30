export function resolveActiveEffectExpiration(activeEffect, {
  effectData = null,
  worldTime = globalThis.game?.time?.worldTime,
  combat = globalThis.game?.combat ?? null
} = {}) {
  const data = effectData ?? activeEffect?.toObject?.() ?? {};
  const sourceDuration = data?.duration ?? {};
  const preparedDuration = activeEffect?.duration ?? sourceDuration;
  const start = data?.start ?? activeEffect?.start ?? null;
  const durationExpired = preparedDuration?.expired === true || sourceDuration?.expired === true;
  const remaining = firstFinite([
    preparedDuration?.secondsRemaining,
    preparedDuration?.remaining,
    sourceDuration?.secondsRemaining,
    sourceDuration?.remaining,
    sourceDuration?.remainingTime,
    activeEffect?.remaining
  ]);
  const remainingExpired = Number.isFinite(remaining) && remaining <= 0;
  const modernExpired = isModernDurationExpired({ duration: sourceDuration, preparedDuration, start, worldTime, combat });
  const legacyExpired = isLegacyDurationExpired(sourceDuration, { worldTime, combat });
  return {
    expired: Boolean(durationExpired || remainingExpired || modernExpired || legacyExpired),
    durationExpired,
    remaining,
    remainingExpired,
    modernExpired,
    legacyExpired
  };
}

export function isManagedOwnerEffect(activeEffect, moduleId) {
  const data = activeEffect?.toObject?.() ?? {};
  return Boolean(
    activeEffect?.flags?.[moduleId]?.managedOwnerEffect === true ||
    data.flags?.[moduleId]?.managedOwnerEffect === true
  );
}

function isModernDurationExpired({ duration, preparedDuration, start, worldTime, combat }) {
  const value = finiteNumber(duration?.value ?? preparedDuration?.value);
  const units = String(duration?.units ?? preparedDuration?.units ?? "").trim().toLowerCase();
  if (!Number.isFinite(value) || value <= 0 || !units || !start) return false;
  if (["round", "rounds", "turn", "turns"].includes(units)) {
    return isModernCombatDurationExpired({ value, units, start, combat });
  }
  const startTime = finiteNumber(start?.time);
  const currentWorldTime = finiteNumber(worldTime);
  const seconds = firstFinite([
    preparedDuration !== duration ? preparedDuration?.seconds : null,
    convertDurationToSeconds(value, units)
  ]);
  return Number.isFinite(startTime) && Number.isFinite(currentWorldTime) && Number.isFinite(seconds) &&
    currentWorldTime >= startTime + seconds;
}

function isModernCombatDurationExpired({ value, units, start, combat }) {
  const startRound = finiteNumber(start?.round);
  const startTurn = finiteNumber(start?.turn) ?? 0;
  const currentRound = finiteNumber(combat?.round);
  const currentTurn = finiteNumber(combat?.turn) ?? 0;
  const turnCount = Math.max(Array.from(combat?.turns ?? []).length, 1);
  if (!Number.isFinite(startRound) || !Number.isFinite(currentRound)) return false;
  const elapsedTurns = ((currentRound - startRound) * turnCount) + (currentTurn - startTurn);
  const targetTurns = units.startsWith("round") ? value * turnCount : value;
  return elapsedTurns >= targetTurns;
}

function isLegacyDurationExpired(duration, { worldTime, combat }) {
  const seconds = readLegacyNumber(duration, "seconds");
  const startTime = readLegacyNumber(duration, "startTime");
  const currentWorldTime = finiteNumber(worldTime);
  if (Number.isFinite(seconds) && seconds > 0 && Number.isFinite(startTime) &&
      Number.isFinite(currentWorldTime) && currentWorldTime >= startTime + seconds) return true;

  const rounds = readLegacyNumber(duration, "rounds");
  const turns = readLegacyNumber(duration, "turns") ?? 0;
  const startRound = readLegacyNumber(duration, "startRound");
  const startTurn = readLegacyNumber(duration, "startTurn") ?? 0;
  const currentRound = finiteNumber(combat?.round);
  const currentTurn = finiteNumber(combat?.turn) ?? 0;
  const turnCount = Math.max(Array.from(combat?.turns ?? []).length, 1);
  if (!Number.isFinite(rounds) || rounds <= 0 || !Number.isFinite(startRound) || !Number.isFinite(currentRound)) return false;
  const elapsedTurns = ((currentRound - startRound) * turnCount) + (currentTurn - startTurn);
  return elapsedTurns >= (rounds * turnCount) + turns;
}

function readLegacyNumber(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object ?? {}, key);
  if (!descriptor || typeof descriptor.get === "function") return null;
  return finiteNumber(descriptor.value);
}

function convertDurationToSeconds(value, units) {
  const singular = units.replace(/s$/, "");
  const calendar = globalThis.game?.time?.calendar;
  if (typeof calendar?.componentsToTime === "function") {
    const converted = finiteNumber(calendar.componentsToTime({ [singular]: value }));
    if (Number.isFinite(converted)) return converted;
  }
  const configured = finiteNumber(globalThis.CONFIG?.time?.[`${singular}Time`]);
  if (Number.isFinite(configured)) return value * configured;
  const secondsByUnit = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };
  return secondsByUnit[singular] ? value * secondsByUnit[singular] : null;
}

function firstFinite(values) {
  for (const value of values) {
    const numeric = finiteNumber(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
