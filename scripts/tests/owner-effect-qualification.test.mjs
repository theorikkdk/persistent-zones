import assert from "node:assert/strict";

const {
  isStatusSourceEffect,
  qualifyLifecycleOwnerCandidate,
  shouldHandleLifecycleEffect
} = await import("../runtime/owner-effect-qualification.mjs");

const MODULE_ID = "persistent-zones";

{
  const statusSource = {
    parent: { uuid: "Actor.B" },
    flags: {
      [MODULE_ID]: {
        managedTriggeredEffect: true,
        statusId: "poisoned",
        regionId: "region-A",
        regionUuid: "Scene.scene.Region.region-A",
        tokenUuid: "Scene.scene.Token.target-B",
        statusRecovery: { mode: "save-end-turn" }
      }
    }
  };
  assert.equal(isStatusSourceEffect(statusSource, MODULE_ID), true);
  const rejected = qualifyLifecycleOwnerCandidate({
    statusSourceEffect: true,
    concentrationEffect: false,
    actorRequired: true,
    actorMatches: false,
    itemRequired: true,
    itemMatches: false,
    activityRequired: true,
    activityMatches: true
  });
  assert.deepEqual(rejected, { eligible: false, reason: "status-source-effect-excluded" },
    "an explicit Region and matching activity cannot make a target status source into a lifecycle owner");
  assert.equal(shouldHandleLifecycleEffect(statusSource, MODULE_ID, { referencedRegionCount: 1 }), false,
    "a Recovery update or deletion must not trigger lifecycle cleanup even for a legacy bad reference");
}

{
  const concentration = qualifyLifecycleOwnerCandidate({
    concentrationEffect: true,
    actorRequired: true,
    actorMatches: true,
    itemRequired: true,
    itemMatches: true,
    activityRequired: true,
    activityMatches: true
  });
  assert.deepEqual(concentration, { eligible: true, reason: "structured-concentration-owner" },
    "the caster's structured concentration effect must remain eligible");
  assert.equal(shouldHandleLifecycleEffect({ flags: {} }, MODULE_ID, { referencedRegionCount: 3 }), true,
    "deleting a real owner must still clean every referenced multipart sibling");
}

{
  const dedicated = qualifyLifecycleOwnerCandidate({
    dedicatedOwnerEffect: true,
    actorRequired: true,
    actorMatches: false,
    itemRequired: true,
    itemMatches: false
  });
  assert.deepEqual(dedicated, { eligible: true, reason: "dedicated-owner-effect" },
    "an explicitly matched dedicated PZ owner must remain eligible");
}

{
  const unrelated = qualifyLifecycleOwnerCandidate({
    concentrationEffect: true,
    actorRequired: true,
    actorMatches: false,
    itemRequired: true,
    itemMatches: true,
    activityRequired: true,
    activityMatches: true
  });
  assert.equal(unrelated.eligible, false, "an effect owned by another Actor must never own the caster's Region");
  assert.equal(unrelated.reason, "caster-actor-mismatch");
}

{
  const groupRegions = ["primary", "secondary", "outer"].map((partId) => ({
    partId,
    owner: qualifyLifecycleOwnerCandidate({
      concentrationEffect: true,
      actorRequired: true,
      actorMatches: true,
      itemRequired: true,
      itemMatches: true,
      activityRequired: true,
      activityMatches: true
    })
  }));
  assert.equal(groupRegions.every((region) => region.owner.eligible), true,
    "every multipart sibling must accept the same valid concentration owner identity");
}

console.log("owner-effect-qualification tests passed");
