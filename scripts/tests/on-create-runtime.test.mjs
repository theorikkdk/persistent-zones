import assert from "node:assert/strict";
import test from "node:test";

globalThis.CONST ??= { GRID_TYPES: { GRIDLESS: 0, SQUARE: 1 } };
globalThis.game ??= { version: "14.367", settings: { settings: new Map(), get: () => "off" } };
globalThis.canvas ??= {
  scene: { id: "scene", grid: { type: 1, size: 100, distance: 1.5, units: "m" } },
  grid: { type: 1, size: 100 },
  tokens: { placeables: [] }
};

const { applyRegionOnCreateTrigger } = await import("../runtime/on-create-runtime.mjs");

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

test("thin-wall onCreate uses positive geometric intersection for Medium and Large tokens", async () => {
  for (const size of [1, 2]) {
    const token = buildToken(`token-${size}`, 200, 200, size, size);
    const region = buildThinWallRegion({ tokens: [token] });
    let effects = 0;
    const result = await applyRegionOnCreateTrigger(region, {
      settle: async () => {},
      applyEffect: async ({ triggerConfig, timing }) => {
        effects += 1;
        assert.equal(timing, "onCreate");
        assert.equal(triggerConfig.frequency, "unlimited");
        assert.equal(triggerConfig.simpleEffect.save.ability, "dex");
        assert.equal(triggerConfig.simpleEffect.save.onSave, "half");
        assert.deepEqual(triggerConfig.simpleEffect.damage, { enabled: true, formula: "5d8", type: "fire" });
        return { applied: true, skipped: false };
      }
    });
    assert.equal(result.appliedCount, 1);
    assert.equal(effects, 1);
  }
});

test("thin-wall onCreate excludes a token without geometric intersection", async () => {
  const token = buildToken("outside", 20, 200, 1, 1);
  const region = buildThinWallRegion({ tokens: [token] });
  let effects = 0;
  const result = await applyRegionOnCreateTrigger(region, {
    settle: async () => {},
    applyEffect: async () => { effects += 1; return { applied: true, skipped: false }; }
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "not-inside");
  assert.equal(effects, 0);
});

test("multipart overlap applies onCreate only from wall-body, never hot-side", async () => {
  const token = buildToken("overlap", 200, 200, 1, 1);
  const wallBody = buildThinWallRegion({ id: "wall-body", tokens: [token] });
  const hotSide = buildThinWallRegion({ id: "hot-side", tokens: [token], onCreateEnabled: false, interactionMode: "area" });
  let effects = 0;
  const bodyResult = await applyRegionOnCreateTrigger(wallBody, {
    settle: async () => {},
    applyEffect: async () => { effects += 1; return { applied: true, skipped: false }; }
  });
  const hotResult = await applyRegionOnCreateTrigger(hotSide, {
    settle: async () => {},
    applyEffect: async () => { effects += 1; return { applied: true, skipped: false }; }
  });
  assert.equal(bodyResult.appliedCount, 1);
  assert.equal(hotResult.reason, "trigger-disabled");
  assert.equal(effects, 1);
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

function buildThinWallRegion({ id = "wall-body", tokens = [], onCreateEnabled = true, interactionMode = "thin-wall" } = {}) {
  const trigger = {
    enabled: onCreateEnabled,
    mode: "simple-effect",
    frequency: "unlimited",
    frequencyGroup: "",
    targetFilter: { mode: "all" },
    simpleEffect: {
      save: { enabled: true, ability: "dex", dcMode: "inherit", dc: null, onSave: "half" },
      damage: { enabled: true, formula: "5d8", type: "fire" }
    }
  };
  const runtime = {
    partId: id,
    normalizedDefinition: {
      enabled: true,
      interaction: { mode: interactionMode },
      targeting: { mode: "all" },
      part: { id },
      triggers: { onCreate: trigger }
    }
  };
  const region = {
    id,
    shapes: [{ type: "line", x: 250, y: 0, length: 500, width: 20, rotation: 90 }],
    flags: { "persistent-zones": { runtime } },
    getFlag: () => runtime,
    parent: { id: "scene", grid: canvas.scene.grid, tokens: { contents: tokens } },
    async update(changes) { runtime.onCreateTriggerCompleted = changes["flags.persistent-zones.runtime.onCreateTriggerCompleted"]; }
  };
  return region;
}

function buildToken(id, x, y, width, height) {
  return { id, uuid: `Scene.scene.Token.${id}`, x, y, width, height, actor: { uuid: `Actor.${id}` } };
}
