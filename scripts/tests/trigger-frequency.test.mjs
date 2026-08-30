import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTriggerFrequencyIdentity,
  claimTriggerFrequency,
  normalizeTriggerFrequency
} from "../runtime/trigger-frequency.mjs";

const combat = {
  id: "combat-1",
  started: true,
  round: 2,
  turn: 3,
  combatant: { id: "combatant-1", tokenId: "active-token" }
};

test("frequency defaults to unlimited and outside combat remains unlimited", async () => {
  assert.equal(normalizeTriggerFrequency(), "unlimited");
  const result = await claimTriggerFrequency({
    regionDocument: buildRegion(),
    tokenDocument: { id: "target" },
    triggerConfig: { frequency: "once-per-turn" },
    combat: null
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "outside-combat-unlimited");
});

test("shared group produces one identity per combat turn, target and cast group", () => {
  const region = buildRegion();
  const input = { combat, regionDocument: region, tokenDocument: { id: "target", uuid: "Scene.scene.Token.target" }, triggerConfig: { frequencyGroup: "hazard" } };
  const enter = buildTriggerFrequencyIdentity({ ...input, timing: "onEnter" });
  const move = buildTriggerFrequencyIdentity({ ...input, timing: "onMove" });
  assert.equal(enter.key, move.key);
  assert.notEqual(enter.key, buildTriggerFrequencyIdentity({ ...input, combat: { ...combat, turn: 4 } }).key);
  assert.notEqual(enter.key, buildTriggerFrequencyIdentity({ ...input, tokenDocument: { id: "other" } }).key);
});

test("once-per-turn claim persists on the Region and blocks a shared second trigger", async () => {
  const region = buildRegion();
  const first = await claimTriggerFrequency({ regionDocument: region, tokenDocument: { id: "target" }, triggerConfig: { frequency: "once-per-turn", frequencyGroup: "shared" }, timing: "onEnter", combat });
  const second = await claimTriggerFrequency({ regionDocument: region, tokenDocument: { id: "target" }, triggerConfig: { frequency: "once-per-turn", frequencyGroup: "shared" }, timing: "onMove", combat });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(region.flags["persistent-zones"].runtime.triggerFrequencyLedger.length, 1);
});

test("once-per-turn scopes remain independent across groups, targets, casts and turns", async () => {
  const region = buildRegion();
  const common = { regionDocument: region, triggerConfig: { frequency: "once-per-turn", frequencyGroup: "shared" }, timing: "onEnter", combat };
  assert.equal((await claimTriggerFrequency({ ...common, tokenDocument: { id: "target-a" } })).allowed, true);
  assert.equal((await claimTriggerFrequency({ ...common, tokenDocument: { id: "target-a" }, triggerConfig: { frequency: "once-per-turn", frequencyGroup: "other" } })).allowed, true);
  assert.equal((await claimTriggerFrequency({ ...common, tokenDocument: { id: "target-b" } })).allowed, true);
  assert.equal((await claimTriggerFrequency({ ...common, tokenDocument: { id: "target-a" }, combat: { ...combat, turn: 4, combatant: { id: "combatant-2" } } })).allowed, true);
  assert.equal((await claimTriggerFrequency({ ...common, tokenDocument: { id: "target-a" }, combat: { ...combat, round: 3 } })).allowed, true);

  const otherCast = buildRegion("other-cast");
  assert.equal((await claimTriggerFrequency({ ...common, regionDocument: otherCast, tokenDocument: { id: "target-a" } })).allowed, true);
});

test("persisted ledger still blocks after a simulated reload", async () => {
  const region = buildRegion();
  const request = { regionDocument: region, tokenDocument: { id: "target" }, triggerConfig: { frequency: "once-per-turn", frequencyGroup: "shared" }, timing: "onEnter", combat };
  await claimTriggerFrequency(request);
  const reloadedRegion = buildRegion("cast-group", structuredClone(region.flags["persistent-zones"].runtime.triggerFrequencyLedger));
  assert.equal((await claimTriggerFrequency({ ...request, regionDocument: reloadedRegion })).allowed, false);
});

function buildRegion(groupId = "cast-group", ledger = []) {
  const runtime = { groupId, triggerFrequencyLedger: ledger };
  const region = {
    id: "region-1",
    flags: { "persistent-zones": { runtime } },
    getFlag: () => runtime,
    async update(changes) {
      runtime.triggerFrequencyLedger = changes["flags.persistent-zones.runtime.triggerFrequencyLedger"];
    }
  };
  region.parent = { regions: { contents: [region] } };
  return region;
}
