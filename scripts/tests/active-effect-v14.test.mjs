import assert from "node:assert/strict";

globalThis.game = { time: { worldTime: 120 } };
globalThis.CONFIG = { time: { secondTime: 1, roundTime: 6, turnTime: 6 } };

const { isManagedOwnerEffect, resolveActiveEffectExpiration } = await import("../runtime/active-effect-compat.mjs");
const { buildStatusRecoveryPatch } = await import("../runtime/status-recovery.mjs");

{
  const effectData = { start: { time: 100 }, duration: { value: 10, units: "seconds" } };
  assert.equal(resolveActiveEffectExpiration({}, { effectData, worldTime: 109 }).expired, false);
  const expired = resolveActiveEffectExpiration({}, { effectData, worldTime: 110 });
  assert.equal(expired.expired, true, "a modern duration.value/units effect must expire at its endpoint");
  assert.equal(expired.modernExpired, true);
}

{
  const duration = { value: 10, units: "seconds" };
  Object.defineProperty(duration, "seconds", {
    get: () => { throw new Error("deprecated duration.seconds shim was accessed"); }
  });
  Object.defineProperty(duration, "startTime", {
    get: () => { throw new Error("deprecated duration.startTime shim was accessed"); }
  });
  assert.equal(resolveActiveEffectExpiration({}, {
    effectData: { start: { time: 100 }, duration },
    worldTime: 110
  }).expired, true, "modern expiration must not access Foundry's deprecated duration shims");
}

{
  const expired = resolveActiveEffectExpiration({}, {
    effectData: { duration: { startTime: 100, seconds: 10 } },
    worldTime: 110
  });
  assert.equal(expired.expired, true, "a persisted legacy time duration must still expire");
  assert.equal(expired.legacyExpired, true);
}

{
  const combat = { round: 4, turn: 0, turns: [{}, {}, {}] };
  const effectData = { start: { round: 2, turn: 0, time: 0 }, duration: { value: 2, units: "rounds" } };
  assert.equal(resolveActiveEffectExpiration({}, { effectData, combat }).expired, true,
    "a modern combat duration must use effect.start round and turn");
}

{
  const expired = resolveActiveEffectExpiration({}, {
    effectData: { duration: { rounds: 1, turns: 0, startRound: 2, startTurn: 1 } },
    combat: { round: 3, turn: 1, turns: [{}, {}, {}] }
  });
  assert.equal(expired.expired, true, "a persisted legacy combat duration must still expire");
}

{
  const managedOwnerFlags = {
    "persistent-zones": {
      managedOwnerEffect: true,
      regionId: "region-id",
      groupId: "group-id",
      castInstanceId: "cast-id"
    }
  };
  const effectData = {
    flags: structuredClone(managedOwnerFlags),
    start: { time: 100 },
    duration: { value: 10, units: "seconds" }
  };
  resolveActiveEffectExpiration({}, { effectData, worldTime: 110 });
  assert.deepEqual(effectData.flags, managedOwnerFlags, "expiration reads must not mutate PZ owner flags");
  assert.equal(isManagedOwnerEffect({ toObject: () => effectData }, "persistent-zones"), true,
    "a dedicated owner effect must still be recognized from persisted PZ flags");
}

{
  const recovery = buildStatusRecoveryPatch({
    mode: "save-end-turn",
    ability: "con",
    dcMode: "custom",
    customDC: 14,
    removeOnSuccess: true,
    provider: "midi"
  }, {
    persistenceMode: "persistent",
    capabilities: {
      midi: { available: true, reason: "midi-and-dae-active" },
      native: { available: false, reason: "native-provider-not-implemented" }
    }
  });
  const change = recovery.patch.system.changes[0];
  assert.equal(change.type, "override", "new recovery changes must use the V14 string override type");
  assert.equal(Object.hasOwn(change, "mode"), false, "new recovery changes must not write the deprecated numeric mode");
  assert.equal(recovery.resolvedDC, 14, "recovery DC resolution must remain unchanged");
  assert.equal(recovery.patch.flags["persistent-zones"].statusRecovery.ability, "con");
}

console.log("active-effect-v14 tests passed");
