import assert from "node:assert/strict";
import test from "node:test";

globalThis.CONST = { TOKEN_DISPOSITIONS: { FRIENDLY: 1, NEUTRAL: 0, HOSTILE: -1, SECRET: -2 } };
globalThis.game = { settings: { settings: new Map() } };
globalThis.canvas = { scene: null };
globalThis.Roll = class {
  constructor(formula) { this.formula = formula; this.total = 0; }
  async evaluate() { this.total = Number(this.formula) || 0; return this; }
  async toMessage() {}
};

const { evaluateTriggerTargetFilter } = await import("../runtime/utils.mjs");
const { applyConfiguredTriggerEffect } = await import("../runtime/entry-effects.mjs");
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");

test("all, self, and others use the exact source Token UUID", () => {
  const fixture = buildFixture(1);
  for (const target of [fixture.source, fixture.ally, fixture.enemy, fixture.neutral]) {
    assert.equal(evaluate(fixture, "all", target).allowed, true);
  }
  assert.equal(evaluate(fixture, "self", fixture.source).allowed, true);
  assert.equal(evaluate(fixture, "self", fixture.ally).allowed, false);
  assert.equal(evaluate(fixture, "others", fixture.source).allowed, false);
  for (const target of [fixture.ally, fixture.enemy, fixture.neutral]) {
    assert.equal(evaluate(fixture, "others", target).allowed, true);
  }
});

test("allies and enemies implement friendly/hostile camps and exclude neutral", () => {
  const friendly = buildFixture(1);
  assert.equal(evaluate(friendly, "allies", friendly.source).allowed, true);
  assert.equal(evaluate(friendly, "allies", friendly.ally).allowed, true);
  assert.equal(evaluate(friendly, "allies", friendly.enemy).allowed, false);
  assert.equal(evaluate(friendly, "allies", friendly.neutral).allowed, false);
  assert.equal(evaluate(friendly, "enemies", friendly.enemy).allowed, true);
  assert.equal(evaluate(friendly, "enemies", friendly.ally).allowed, false);
  assert.equal(evaluate(friendly, "enemies", friendly.neutral).allowed, false);

  const hostile = buildFixture(-1);
  assert.equal(evaluate(hostile, "allies", hostile.ally).allowed, true);
  assert.equal(evaluate(hostile, "allies", hostile.enemy).allowed, false);
  assert.equal(evaluate(hostile, "enemies", hostile.enemy).allowed, true);
  assert.equal(evaluate(hostile, "enemies", hostile.ally).allowed, false);
});

test("missing source identity or disposition fails closed except for all", () => {
  const fixture = buildFixture(1);
  fixture.runtime.sourceTokenUuid = null;
  assert.equal(evaluate(fixture, "all", fixture.enemy).allowed, true);
  for (const mode of ["self", "others", "allies", "enemies"]) {
    assert.equal(evaluate(fixture, mode, fixture.enemy).allowed, false);
  }
  fixture.runtime.sourceTokenUuid = fixture.source.uuid;
  fixture.source.disposition = null;
  fixture.runtime.sourceDisposition = null;
  assert.equal(evaluate(fixture, "allies", fixture.ally).reason, "source-disposition-unavailable");
  assert.equal(evaluate(fixture, "enemies", fixture.enemy).allowed, false);
});

test("trigger modes stay independent across timings and multipart parts", () => {
  const fixture = buildFixture(1);
  const timings = ["onCreate", "enter", "exit", "move", "turnStart", "turnEnd"];
  for (const timing of timings) {
    assert.equal(evaluate(fixture, "enemies", fixture.enemy, timing).allowed, true);
    assert.equal(evaluate(fixture, "enemies", fixture.ally, timing).allowed, false);
  }
  const partA = { ...fixture, runtime: { ...fixture.runtime, partId: "part-a" } };
  const partB = { ...fixture, runtime: { ...fixture.runtime, partId: "part-b" } };
  assert.equal(evaluate(partA, "enemies", fixture.enemy, "enter").allowed, true);
  assert.equal(evaluate(partB, "allies", fixture.enemy, "enter").allowed, false);
  assert.equal(evaluate(partA, "enemies", fixture.ally, "enter").allowed, false);
  assert.equal(evaluate(partB, "allies", fixture.ally, "enter").allowed, true);
});

test("rejection happens before saving throws and once-per-turn claims for every trigger", async () => {
  const fixture = buildFixture(1);
  let saveCount = 0;
  let frequencyWriteCount = 0;
  fixture.ally.actor.rollSavingThrow = async () => {
    saveCount += 1;
    return { total: 20 };
  };
  fixture.region.setFlag = async () => {
    frequencyWriteCount += 1;
  };
  const triggerConfig = {
    enabled: true,
    mode: "simple-effect",
    targetFilter: { mode: "enemies" },
    frequency: "once-per-turn",
    save: { enabled: true, ability: "dex", dc: 12 },
    damage: { enabled: true, formula: "1", type: "fire" }
  };
  for (const timing of ["onCreate", "onEnter", "onExit", "onMove", "onStartTurn", "onEndTurn"]) {
    const result = await applyConfiguredTriggerEffect({
      regionDocument: fixture.region,
      tokenDocument: fixture.ally,
      triggerConfig,
      timing
    });
    assert.equal(result.skipped, true, timing);
  }
  assert.equal(saveCount, 0);
  assert.equal(frequencyWriteCount, 0);
});

test("turnEnd allies healing survives normalization and updates only friendly targets", async () => {
  const fixture = buildFixture(1);
  for (const target of [fixture.source, fixture.ally, fixture.enemy, fixture.neutral]) installHitPoints(target, 5, 10);
  const normalized = normalizeZoneDefinition({
    enabled: true,
    targeting: { mode: "all" },
    triggers: {
      turnEnd: {
        enabled: true,
        mode: "simple-effect",
        targetFilter: { mode: "allies" },
        simpleEffect: { healing: { enabled: true, formula: "1" } }
      }
    }
  });
  fixture.runtime.normalizedDefinition = normalized;
  const trigger = normalized.triggers.onEndTurn;
  assert.equal(trigger.targetFilter.mode, "allies");
  assert.deepEqual(trigger.healing, { enabled: true, formula: "1" });

  for (const target of [fixture.source, fixture.ally, fixture.enemy, fixture.neutral]) {
    await applyConfiguredTriggerEffect({
      regionDocument: fixture.region,
      tokenDocument: target,
      triggerConfig: trigger,
      timing: "onEndTurn"
    });
  }
  assert.equal(fixture.source.actor.system.attributes.hp.value, 6);
  assert.equal(fixture.ally.actor.system.attributes.hp.value, 6);
  assert.equal(fixture.enemy.actor.system.attributes.hp.value, 5);
  assert.equal(fixture.neutral.actor.system.attributes.hp.value, 5);
  assert.equal(fixture.enemy.actor.applyDamageCalls, 0);
  assert.equal(fixture.neutral.actor.applyDamageCalls, 0);

  const startAlias = normalizeZoneDefinition({
    enabled: true,
    triggers: { turnStart: { enabled: true, mode: "simple-effect", targetFilter: { mode: "self" } } }
  });
  assert.equal(startAlias.triggers.onStartTurn.targetFilter.mode, "self");
});

test("enter enemies damage remains restricted to hostile targets", async () => {
  const fixture = buildFixture(1);
  for (const target of [fixture.source, fixture.ally, fixture.enemy, fixture.neutral]) installHitPoints(target, 5, 10);
  const trigger = {
    enabled: true,
    mode: "simple-effect",
    targetFilter: { mode: "enemies" },
    damage: { enabled: true, formula: "1", type: "fire" }
  };
  for (const target of [fixture.source, fixture.ally, fixture.enemy, fixture.neutral]) {
    await applyConfiguredTriggerEffect({ regionDocument: fixture.region, tokenDocument: target, triggerConfig: trigger, timing: "onEnter" });
  }
  assert.equal(fixture.source.actor.system.attributes.hp.value, 5);
  assert.equal(fixture.ally.actor.system.attributes.hp.value, 5);
  assert.equal(fixture.enemy.actor.system.attributes.hp.value, 4);
  assert.equal(fixture.neutral.actor.system.attributes.hp.value, 5);
});

function evaluate(fixture, mode, tokenDocument, triggerId = "enter") {
  fixture.region.flags["persistent-zones"].runtime = fixture.runtime;
  return evaluateTriggerTargetFilter({
    regionDocument: fixture.region,
    runtime: fixture.runtime,
    triggerConfig: { targetFilter: { mode } },
    triggerId,
    tokenDocument
  });
}

function buildFixture(sourceDisposition) {
  const scene = { id: "scene", tokens: { contents: [] } };
  const token = (id, disposition) => ({
    id,
    uuid: `Scene.scene.Token.${id}`,
    disposition,
    actor: { uuid: `Actor.${id}` },
    parent: scene
  });
  const source = token("source", sourceDisposition);
  const ally = token("ally", sourceDisposition);
  const enemy = token("enemy", sourceDisposition === 1 ? -1 : 1);
  const neutral = token("neutral", 0);
  scene.tokens.contents = [source, ally, enemy, neutral];
  canvas.scene = scene;
  const runtime = {
    partId: "primary",
    sourceTokenUuid: source.uuid,
    sourceDisposition,
    normalizedDefinition: { targeting: { mode: "all" } }
  };
  const region = { id: "region", parent: scene, flags: { "persistent-zones": { runtime } } };
  return { scene, source, ally, enemy, neutral, runtime, region };
}

function installHitPoints(target, value, max) {
  target.actor.system = { attributes: { hp: { value, max, temp: 0 } } };
  target.actor.applyDamageCalls = 0;
  target.actor.applyDamage = async (entries) => {
    target.actor.applyDamageCalls += 1;
    for (const entry of entries) {
      if (entry.type === "healing") target.actor.system.attributes.hp.value = Math.min(max, target.actor.system.attributes.hp.value + entry.value);
      else if (entry.type !== "temphp") target.actor.system.attributes.hp.value = Math.max(0, target.actor.system.attributes.hp.value - entry.value);
    }
  };
  target.actor.update = async (updates) => {
    if (updates["system.attributes.hp.value"] !== undefined) {
      target.actor.system.attributes.hp.value = updates["system.attributes.hp.value"];
    }
    if (updates["system.attributes.hp.temp"] !== undefined) {
      target.actor.system.attributes.hp.temp = updates["system.attributes.hp.temp"];
    }
  };
}
