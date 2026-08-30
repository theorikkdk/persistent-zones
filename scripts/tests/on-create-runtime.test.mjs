import assert from "node:assert/strict";
import test from "node:test";

import { applyRegionOnCreateTrigger } from "../runtime/on-create-runtime.mjs";

test("onCreate completion marker is persisted once even when the trigger is disabled", async () => {
  const runtime = { normalizedDefinition: { enabled: true, triggers: { onCreate: { enabled: false } } } };
  let updates = 0;
  const region = {
    id: "region-1",
    flags: { "persistent-zones": { runtime } },
    getFlag: () => runtime,
    parent: { tokens: { contents: [] } },
    async update(changes) {
      updates += 1;
      runtime.onCreateTriggerCompleted = changes["flags.persistent-zones.runtime.onCreateTriggerCompleted"];
    }
  };

  assert.equal((await applyRegionOnCreateTrigger(region)).reason, "trigger-disabled");
  assert.equal((await applyRegionOnCreateTrigger(region)).reason, "already-completed");
  assert.equal(updates, 1);
});

test("onCreate evaluates an already-present stationary token before writing completed", async () => {
  const { region, runtime } = buildEnabledRegion();
  const token = { id: "token-inside", uuid: "Scene.scene.Token.token-inside", actor: { uuid: "Actor.actor" } };
  let completedDuringEffect = null;
  const result = await applyRegionOnCreateTrigger(region, {
    collectCandidates: () => [token],
    testInside: () => true,
    settle: async () => {},
    applyEffect: async ({ timing, triggerConfig }) => {
      completedDuringEffect = runtime.onCreateTriggerCompleted === true;
      assert.equal(timing, "onCreate");
      assert.equal(triggerConfig.frequency, "once-per-turn");
      assert.equal(triggerConfig.frequencyGroup, "m2-shared");
      return { applied: true, skipped: false };
    }
  });
  assert.equal(result.applied, true);
  assert.equal(completedDuringEffect, false);
  assert.equal(runtime.onCreateTriggerCompleted, true);
});

test("onCreate retries candidate discovery once before completing", async () => {
  const { region, runtime } = buildEnabledRegion();
  const token = { id: "late-token", actor: { uuid: "Actor.actor" } };
  let collections = 0;
  let effects = 0;
  await applyRegionOnCreateTrigger(region, {
    collectCandidates: () => (++collections === 1 ? [] : [token]),
    testInside: () => true,
    settle: async () => {},
    applyEffect: async () => { effects += 1; return { applied: true, skipped: false }; }
  });
  assert.equal(collections, 2);
  assert.equal(effects, 1);
  assert.equal(runtime.onCreateTriggerCompleted, true);
});

function buildEnabledRegion() {
  const runtime = {
    partId: "primary",
    normalizedDefinition: {
      enabled: true,
      triggers: { onCreate: { enabled: true, mode: "simple", frequency: "once-per-turn", frequencyGroup: "m2-shared" } }
    }
  };
  const region = {
    id: "region-enabled",
    flags: { "persistent-zones": { runtime } },
    getFlag: () => runtime,
    parent: { id: "scene", tokens: { contents: [] } },
    async update(changes) { runtime.onCreateTriggerCompleted = changes["flags.persistent-zones.runtime.onCreateTriggerCompleted"]; }
  };
  return { region, runtime };
}
