import assert from "node:assert/strict";
import test from "node:test";

import { buildDamageDescription, buildResolutionRequest, resolveNativeDamageApplication } from "../runtime/resolution-request.mjs";
import { commitTriggerFrequency, releaseTriggerFrequency, reserveTriggerFrequency } from "../runtime/trigger-frequency.mjs";

test("native resolution preserves typed damage for D&D5e mitigation", async () => {
  const applied = [];
  const actor = { async applyDamage(entries) { applied.push(...entries); return { amount: 0 }; } };
  const result = await resolveNativeDamageApplication({ actor, entries: [buildDamageDescription({ value: 12, type: "fire" })] });
  assert.equal(result.status, "resolved");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].value, 12);
  assert.equal(applied[0].type, "fire");
  assert.ok(applied[0].properties instanceof Set);
});

test("native resolution reports an error instead of writing hit points itself", async () => {
  const result = await resolveNativeDamageApplication({ actor: {}, entries: [buildDamageDescription({ value: 5, type: "poison" })] });
  assert.equal(result.status, "error");
  assert.equal(result.error, "native-actor-apply-damage-unavailable");
});

test("resolution request is serializable and scopes source, target, and trigger", () => {
  const request = buildResolutionRequest({
    regionDocument: { id: "region", uuid: "Scene.s.Region.region" },
    tokenDocument: { uuid: "Scene.s.Token.target", actor: { uuid: "Actor.target" } },
    runtime: { groupId: "cast", castInstanceId: "cast-1", itemUuid: "Item.source", activityId: "activity" },
    timing: "onEnter",
    triggerConfig: { damage: { enabled: true, formula: "2d6", type: "fire" } }
  });
  assert.equal(request.source.groupId, "cast");
  assert.equal(request.target.actorUuid, "Actor.target");
  assert.equal(request.trigger.timing, "onEnter");
  assert.equal(request.damage.type, "fire");
});

test("frequency reservation commits only after resolution and releases cancellations", async () => {
  const region = buildRegion();
  const input = { regionDocument: region, tokenDocument: { id: "target" }, triggerConfig: { frequency: "once-per-turn", frequencyGroup: "native" }, timing: "onEnter", combat };
  const cancelled = await reserveTriggerFrequency(input);
  assert.equal(cancelled.allowed, true);
  releaseTriggerFrequency(cancelled);
  assert.equal((await reserveTriggerFrequency(input)).allowed, true);
  const committed = await reserveTriggerFrequency({ ...input, triggerConfig: { frequency: "once-per-turn", frequencyGroup: "other" } });
  await commitTriggerFrequency(committed);
  assert.equal((await reserveTriggerFrequency({ ...input, triggerConfig: { frequency: "once-per-turn", frequencyGroup: "other" } })).allowed, false);
});

const combat = { id: "combat", started: true, round: 1, turn: 0, combatant: { id: "combatant", tokenId: "active" } };
function buildRegion() {
  const runtime = { groupId: "cast", triggerFrequencyLedger: [] };
  const region = { id: "region", flags: { "persistent-zones": { runtime } }, getFlag: () => runtime, async update(changes) { runtime.triggerFrequencyLedger = changes["flags.persistent-zones.runtime.triggerFrequencyLedger"]; } };
  region.parent = { regions: { contents: [region] } };
  return region;
}
