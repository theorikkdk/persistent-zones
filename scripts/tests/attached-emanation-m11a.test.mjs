import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../module.json", import.meta.url), "utf8"));
const manifestBehaviorTypes = Object.keys(manifest.documentTypes?.RegionBehavior ?? {})
  .map((type) => `${manifest.id}.${type}`);
globalThis.canvas = { scene: null };
globalThis.game = {
  model: { RegionBehavior: Object.fromEntries(manifestBehaviorTypes.map((type) => [type, {}])) },
  user: { id: "gm", isGM: true, active: true },
  users: { activeGM: { id: "gm" } }
};
class RegionBehaviorType {}
globalThis.foundry = {
  data: { regionBehaviors: { RegionBehaviorType } },
  utils: { deepClone: structuredClone }
};
globalThis.CONST = { REGION_EVENTS: { TOKEN_ENTER: "tokenEnter", TOKEN_EXIT: "tokenExit" } };
globalThis.CONFIG = {
  RegionBehavior: {
    dataModels: {},
    typeIcons: {},
    documentClass: { get TYPES() { return Object.keys(game.model.RegionBehavior); } }
  }
};

const { getPersistentZoneActivityDefinition } = await import("../activity/persistent-zone-activity-utils.mjs");
const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const { normalizePreset, resolvePresetPersistentZoneForScene } = await import("../presets/preset-utils.mjs");
const { BUILTIN_PRESETS } = await import("../presets/builtins.mjs");
const {
  buildAttachedEmanationBehaviorData,
  classifyAttachedRegionTransition,
  finalizeAttachedEmanationCreation,
  handleAttachedRegionTransition,
  getAttachedEmanationBehaviorRegistration,
  initializeAttachedEmanationTransitionState,
  registerAttachedEmanationRegionBehavior
} = await import("../runtime/attached-emanation-runtime.mjs");
const { isLegacyMovementRuntimeRegion, markNextMovementMode } = await import("../runtime/entry-runtime.mjs");
const { applyRegionOnCreateTrigger } = await import("../runtime/on-create-runtime.mjs");

test("M11A RegionBehavior is registered in CONFIG and in the manifest-backed Document types", () => {
  assert.deepEqual(manifestBehaviorTypes, ["persistent-zones.attachedEmanation"]);
  assert.equal(registerAttachedEmanationRegionBehavior(), true);
  const registration = getAttachedEmanationBehaviorRegistration();
  assert.equal(registration.type, "persistent-zones.attachedEmanation");
  assert.equal(registration.configRegistered, true);
  assert.equal(registration.documentTypeRegistered, true);
  assert.equal(registration.valid, true);
  const behavior = buildAttachedEmanationBehaviorData();
  assert.equal(behavior.type, registration.type);
  assert.equal(CONFIG.RegionBehavior.documentClass.TYPES.includes(behavior.type), true);
});

test("M11A RegionBehavior registration precedes Activity type registration during init", () => {
  const moduleSource = readFileSync(new URL("../module.mjs", import.meta.url), "utf8");
  const behaviorRegistration = moduleSource.indexOf("registerAttachedEmanationRegionBehavior();");
  const activityRegistration = moduleSource.indexOf("registerPersistentZoneActivityType();");
  assert.notEqual(behaviorRegistration, -1);
  assert.notEqual(activityRegistration, -1);
  assert.equal(behaviorRegistration < activityRegistration, true);
});

function activity(persistentZone) {
  return {
    id: "activity",
    uuid: "Actor.actor.Item.item.Activity.activity",
    type: "persistent-zone",
    name: "Attached test",
    persistentZone,
    _source: { persistentZone, target: { template: { type: "circle", size: "10", units: "ft" } } },
    item: { uuid: "Actor.actor.Item.item", actor: { uuid: "Actor.actor" } }
  };
}

test("legacy and explicit fixed placement remain fixed", () => {
  for (const placement of [undefined, { mode: "fixed" }]) {
    const definition = getPersistentZoneActivityDefinition(activity({
      schemaVersion: 3,
      enabled: true,
      ...(placement ? { placement } : {}),
      geometry: { type: "circle", radius: 10, units: "ft" }
    }));
    assert.equal(definition.placement.mode, "fixed");
    assert.equal(definition.geometry.type, "circle");
  }
});

test("attached emanation survives Activity conversion and runtime normalization", () => {
  const raw = getPersistentZoneActivityDefinition(activity({
    schemaVersion: 3,
    enabled: true,
    placement: { mode: "attached-source" },
    geometry: { type: "emanation", radius: 10, units: "ft" },
    parts: [],
    linkedWalls: { enabled: true },
    linkedLights: { enabled: true }
  }));
  assert.equal(raw.placement.mode, "attached-source");
  assert.deepEqual(raw.geometry, { type: "emanation", radius: 10, units: "ft" });
  assert.equal(raw.linkedWalls.enabled, false);
  assert.equal(raw.linkedLight.enabled, false);
  const normalized = normalizeZoneDefinition(raw);
  assert.equal(normalized.placement.mode, "attached-source");
  assert.equal(normalized.geometry.type, "emanation");
  assert.equal(normalized.geometry.radius, 10);
});

test("M11D defaults wall restriction only for supported mono-part geometries", () => {
  const defaultCircle = normalizeZoneDefinition({
    enabled: true,
    placement: { mode: "fixed" },
    geometry: { type: "circle", radius: 10, units: "ft" },
    parts: []
  });
  assert.deepEqual(defaultCircle.obstacles, {
    mode: "wall-restricted",
    restrictionType: "move",
    priority: 0
  });

  const rectangle = normalizeZoneDefinition({
    enabled: true,
    placement: { mode: "fixed" },
    geometry: { type: "rectangle", width: 10, height: 10, units: "ft" },
    parts: []
  });
  assert.equal(rectangle.obstacles.mode, "unrestricted");

  const multipart = normalizeZoneDefinition({
    enabled: true,
    placement: { mode: "fixed" },
    geometry: { type: "circle", radius: 10, units: "ft" },
    parts: [
      { id: "primary", role: "primary", geometry: { type: "template" } },
      { id: "secondary", role: "secondary", geometry: { type: "template" } }
    ]
  });
  assert.equal(multipart.obstacles.mode, "unrestricted");

  const explicitUnrestricted = normalizeZoneDefinition({
    enabled: true,
    geometry: { type: "circle", radius: 10, units: "ft" },
    obstacles: { mode: "unrestricted" }
  });
  assert.equal(explicitUnrestricted.obstacles.mode, "unrestricted");

  const explicitCustom = normalizeZoneDefinition({
    enabled: true,
    geometry: { type: "circle", radius: 10, units: "ft" },
    obstacles: { mode: "wall-restricted", restrictionType: "sound", priority: 4 }
  });
  assert.deepEqual(explicitCustom.obstacles, {
    mode: "wall-restricted",
    restrictionType: "sound",
    priority: 4
  });
});

test("SRD obstacle exceptions leave Moonbeam and Insect Plague unrestricted while Spike Growth inherits M11D", () => {
  const normalizeSrdPreset = (id) => {
    const preset = BUILTIN_PRESETS.find((candidate) => candidate.id === id);
    const template = { type: "circle", size: preset.persistentZone.geometry.radius, units: "ft" };
    const definition = getPersistentZoneActivityDefinition({
      id,
      uuid: `Actor.actor.Item.item.Activity.${id}`,
      type: "persistent-zone",
      name: id,
      persistentZone: preset.persistentZone,
      _source: { persistentZone: preset.persistentZone, target: { template } },
      item: { uuid: "Actor.actor.Item.item", actor: { uuid: "Actor.actor" } }
    });
    return { definition, normalized: normalizeZoneDefinition(definition) };
  };

  const spikeGrowth = normalizeSrdPreset("srd-5.2.1.spike-growth");
  assert.deepEqual(spikeGrowth.definition.obstacles, {
    mode: "wall-restricted",
    restrictionType: "move",
    priority: 0
  });
  assert.equal(spikeGrowth.normalized.obstacles.mode, "wall-restricted");
  assert.deepEqual(normalizeSrdPreset("srd-5.2.1.moonbeam").normalized.obstacles, {
    mode: "unrestricted",
    restrictionType: "sight",
    priority: 0
  });
  assert.deepEqual(normalizeSrdPreset("srd-5.2.1.insect-plague").normalized.obstacles, {
    mode: "unrestricted",
    restrictionType: "sight",
    priority: 0
  });
});

test("unsupported multipart attached configuration fails safe to fixed", () => {
  const definition = getPersistentZoneActivityDefinition(activity({
    schemaVersion: 3,
    enabled: true,
    placement: { mode: "attached-source" },
    geometry: { type: "emanation", radius: 10, units: "ft" },
    parts: [
      { id: "primary", geometry: { type: "template" } },
      { id: "secondary", geometry: { type: "template" } }
    ]
  }));
  assert.equal(definition.placement.mode, "fixed");
});

test("native transition cause separates creation, target movement, and zone movement", () => {
  assert.equal(classifyAttachedRegionTransition({ data: { movement: { id: "move" } } }).cause, "targetMovement");
  assert.equal(classifyAttachedRegionTransition({ data: {} }).cause, "zoneMovement");
  assert.equal(classifyAttachedRegionTransition({ data: {} }, {
    runtime: { attachedTransitionState: { creationPhase: true } },
    tokenId: "source",
    timing: "onEnter"
  }).cause, "regionCreation");
  assert.equal(classifyAttachedRegionTransition({ data: {} }, {
    runtime: { attachedTransitionState: { creationPhase: false, pendingInitialEnterTokenIds: ["target"] } },
    tokenId: "target",
    timing: "onEnter"
  }).cause, "regionCreation");
});

test("creation occupants use onCreate once and native initial enter is suppressed", async () => {
  const source = token("source");
  const runtime = attachedRuntime({
    onCreate: enabledTrigger(),
    onEnter: enabledTrigger()
  });
  initializeAttachedEmanationTransitionState(runtime);
  const region = mockRegion(runtime, [source]);
  let onCreateApplications = 0;
  const onCreate = await applyRegionOnCreateTrigger(region, {
    collectCandidates: () => [source],
    testInside: () => true,
    settle: async () => {},
    applyEffect: async ({ timing }) => {
      assert.equal(timing, "onCreate");
      onCreateApplications += 1;
      return { applied: true };
    }
  });
  let nativeApplications = 0;
  const native = await handleAttachedRegionTransition(region, nativeEvent(source), "onEnter", {
    applyEffect: async () => { nativeApplications += 1; return { applied: true }; }
  });
  assert.equal(onCreate.appliedCount, 1);
  assert.equal(onCreateApplications, 1);
  assert.equal(nativeApplications, 0);
  assert.equal(native.reason, "initial-region-creation-enter");
});

test("a delayed native initial enter is suppressed after creation finalization", async () => {
  const target = token("delayed-target");
  target.testInsideRegion = () => true;
  const runtime = attachedRuntime({ onEnter: enabledTrigger(), onExit: enabledTrigger() });
  initializeAttachedEmanationTransitionState(runtime);
  const region = mockRegion(runtime, [target]);
  await finalizeAttachedEmanationCreation(region);
  let applications = 0;
  const first = await handleAttachedRegionTransition(region, nativeEvent(target), "onEnter", {
    applyEffect: async () => { applications += 1; return { applied: true }; }
  });
  const duplicate = await handleAttachedRegionTransition(region, nativeEvent(target), "onEnter", {
    applyEffect: async () => { applications += 1; return { applied: true }; }
  });
  assert.equal(applications, 0);
  assert.equal(first.reason, "delayed-initial-region-creation-enter");
  assert.equal(duplicate.reason, "delayed-initial-region-creation-enter");
  await handleAttachedRegionTransition(region, nativeEvent(target), "onExit", {
    applyEffect: async () => { applications += 1; return { applied: true }; },
    cleanupStatuses: async () => {}
  });
  await handleAttachedRegionTransition(region, nativeEvent(target), "onEnter", {
    applyEffect: async () => { applications += 1; return { applied: true }; }
  });
  assert.equal(applications, 2, "a real exit releases suppression so the next zone enter is applied");
});

test("zone and target movement each route exactly once through the native behavior", async () => {
  const target = token("target");
  const runtime = attachedRuntime({ onEnter: enabledTrigger(), onExit: enabledTrigger() });
  runtime.attachedTransitionState = { creationPhase: false, pendingInitialEnterTokenIds: [] };
  const region = mockRegion(runtime, [target]);
  const applications = [];
  const applyEffect = async (data) => { applications.push(data); return { applied: true }; };
  await handleAttachedRegionTransition(region, nativeEvent(target), "onEnter", { applyEffect });
  await handleAttachedRegionTransition(region, nativeEvent(target), "onExit", { applyEffect, cleanupStatuses: async () => {} });
  markNextMovementMode(target, "forced");
  await handleAttachedRegionTransition(region, nativeEvent(target, { movement: { passed: { waypoints: [] } } }), "onEnter", { applyEffect });
  await handleAttachedRegionTransition(region, nativeEvent(target, { movement: { passed: { waypoints: [] } } }), "onExit", { applyEffect, cleanupStatuses: async () => {} });
  assert.deepEqual(applications.map(({ timing }) => timing), ["onEnter", "onExit", "onEnter", "onExit"]);
  assert.equal(applications[0].context.movementMode, undefined);
  assert.equal(applications[1].context.movementMode, undefined);
  assert.equal(applications[2].context.movementMode, "forced");
  assert.equal(applications[3].context.movementMode, "voluntary");
});

test("attached regions are excluded from the legacy movement runtime while fixed regions remain eligible", () => {
  assert.equal(isLegacyMovementRuntimeRegion(mockRegion(attachedRuntime(), [])), false);
  assert.equal(isLegacyMovementRuntimeRegion(mockRegion({
    normalizedDefinition: { placement: { mode: "fixed" } }
  }, [])), true);
});

test("wall-restricted fixed Regions use native boundary events without legacy duplicate movement", async () => {
  const target = token("restricted-target");
  const runtime = {
    normalizedDefinition: {
      placement: { mode: "fixed" },
      obstacles: { mode: "wall-restricted", restrictionType: "sight", priority: 0 },
      triggers: { onEnter: enabledTrigger(), onExit: enabledTrigger() }
    },
    attachedTransitionState: { creationPhase: false, pendingInitialEnterTokenIds: [] }
  };
  const region = mockRegion(runtime, [target]);
  assert.equal(isLegacyMovementRuntimeRegion(region), false);
  const timings = [];
  await handleAttachedRegionTransition(region, nativeEvent(target), "onEnter", {
    applyEffect: async ({ timing, context }) => {
      timings.push([timing, context.moveSource]);
      return { applied: true };
    }
  });
  await handleAttachedRegionTransition(region, nativeEvent(target), "onExit", {
    applyEffect: async ({ timing, context }) => {
      timings.push([timing, context.moveSource]);
      return { applied: true };
    },
    cleanupStatuses: async () => {}
  });
  assert.deepEqual(timings, [["onEnter", "native-restricted-region"], ["onExit", "native-restricted-region"]]);
});

test("wall-restricted fixed Regions re-enter the movement runtime only for an onMove trigger", () => {
  const withoutOnMove = mockRegion({
    normalizedDefinition: {
      placement: { mode: "fixed" },
      obstacles: { mode: "wall-restricted", restrictionType: "move", priority: 0 },
      triggers: { onEnter: enabledTrigger(), onExit: enabledTrigger() }
    }
  }, []);
  const withOnMove = mockRegion({
    normalizedDefinition: {
      placement: { mode: "fixed" },
      obstacles: { mode: "wall-restricted", restrictionType: "move", priority: 0 },
      triggers: { onMove: enabledTrigger() }
    }
  }, []);
  assert.equal(isLegacyMovementRuntimeRegion(withoutOnMove), false);
  assert.equal(isLegacyMovementRuntimeRegion(withOnMove), true);
});

test("attached emanation configuration remains valid and isolated", () => {
  const config = {
    placement: { mode: "attached-source" },
    geometry: { type: "emanation", radius: 10, units: "ft" },
    parts: [],
    linkedWalls: { enabled: false },
    linkedLights: { enabled: false },
    triggers: {
      enter: { enabled: true, targetFilter: { mode: "others" } },
      exit: { enabled: true, targetFilter: { mode: "others" } }
    }
  };
  assert.equal(config.placement.mode, "attached-source");
  assert.equal(config.geometry.type, "emanation");
  assert.equal(config.linkedWalls.enabled, false);
  assert.equal(config.linkedLights.enabled, false);
  assert.equal(config.parts.length, 0);
  assert.equal(config.triggers.enter.enabled, true);
  assert.equal(config.triggers.exit.enabled, true);
  assert.equal(config.triggers.enter.targetFilter.mode, "others");
  assert.equal(config.triggers.exit.targetFilter.mode, "others");
  assert.deepEqual(resolvePresetPersistentZoneForScene(config, {
    grid: { units: "m", distance: 1.5, size: 100 }
  }).geometry, { type: "emanation", radius: 3, units: "m" });
});

function enabledTrigger(overrides = {}) {
  return { enabled: true, mode: "simple", movementMode: "any", ...overrides };
}

function attachedRuntime(triggers = {}) {
  return {
    contractVersion: 1,
    sourceTokenUuid: "Scene.scene.Token.source",
    normalizedDefinition: {
      enabled: true,
      placement: { mode: "attached-source" },
      triggers
    }
  };
}

function token(id) {
  return {
    id,
    uuid: `Scene.scene.Token.${id}`,
    actor: { uuid: `Actor.${id}` },
    disposition: 1
  };
}

function mockRegion(runtime, tokens) {
  const sceneTokens = { contents: tokens };
  const region = {
    id: "attached-region",
    flags: { "persistent-zones": { runtime } },
    parent: {
      id: "scene",
      tokens: sceneTokens,
      regions: { has: () => true }
    },
    toObject() { return { flags: this.flags }; },
    async update(changes) {
      const state = changes["flags.persistent-zones.runtime.attachedTransitionState"];
      if (state) this.flags["persistent-zones"].runtime.attachedTransitionState = structuredClone(state);
      const completed = changes["flags.persistent-zones.runtime.onCreateTriggerCompleted"];
      if (completed !== undefined) this.flags["persistent-zones"].runtime.onCreateTriggerCompleted = completed;
      return this;
    }
  };
  return region;
}

function nativeEvent(tokenDocument, data = {}) {
  return { data: { token: tokenDocument, ...data } };
}
