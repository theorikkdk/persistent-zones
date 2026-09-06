import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry ??= { utils: { deepClone: structuredClone, randomID: () => "controlled-session" } };
globalThis.canvas ??= { scene: { grid: { size: 100, distance: 1.5, units: "m" } } };
globalThis.game ??= { user: { id: "gm", isGM: true }, users: { activeGM: { id: "gm", isGM: true } }, settings: { get: () => "minimal" } };

const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const {
  closeControlledZoneMovementSession,
  commitControlledZoneMovement,
  analyzeControlledTokenCollision,
  openControlledZoneMovementSession,
  preventControlledMovementConcentration,
  resolveControlledTokenCollision,
  startControlledZoneMovementFromActivity,
  validateDestination
} = await import("../runtime/controlled-zone-movement-runtime.mjs");

test("controlled movement normalizes a configurable maximum distance without changing legacy translation", () => {
  const normalized = normalizeZoneDefinition({
    enabled: true,
    geometry: { type: "circle", radius: 3, units: "m" },
    controlledMovement: { enabled: true, activationActivityId: "move-zone", maxDistance: 9, physicalRadius: 0.75, units: "m" }
  }, { item: { name: "Controlled", system: { level: 1 } } });
  assert.deepEqual(normalized.controlledMovement, {
    enabled: true,
    activationActivityId: "move-zone",
    maxDistance: 9,
    physicalRadius: 0.75,
    units: "m",
    sceneUnits: "m"
  });
  assert.equal(normalized.translation.enabled, false);
});

test("controlled movement accepts an in-range destination, persists the selected Region, and leaves another Region unchanged", async () => {
  const { scene, region, other } = setupScene();
  globalThis.fromUuid = async (uuid) => uuid === region.uuid ? region : null;
  const opened = await openControlledZoneMovementSession({ regionDocument: region, preview: false });
  assert.equal(opened.ok, true);
  const result = await commitControlledZoneMovement(opened.session, { x: 700, y: 100 });
  assert.equal(result.ok, true);
  assert.equal(region._source.shapes[0].x, 700);
  assert.equal(other._source.shapes[0].x, 500);
  assert.equal(region.lastUpdateOptions.persistentZonesControlledMovement, true);
  assert.equal(scene.regions.contents.length, 2);
  assert.equal((await commitControlledZoneMovement(opened.session, { x: 700, y: 100 })).reason, "session-closed");
});

test("a Utility Activity opens a session only for its explicitly linked PZ Activity", async () => {
  const { scene, region, other } = setupScene();
  other.flags["persistent-zones"].runtime.activityId = "another-zone";
  const source = { id: "source", uuid: "Scene.controlled-scene.Token.source", parent: scene, actor: { uuid: "Actor.a" } };
  scene.tokens.contents = [source];
  region.flags["persistent-zones"].runtime.sourceTokenUuid = source.uuid;
  region.flags["persistent-zones"].runtime.sourceTokenId = source.id;
  const activity = {
    item: { uuid: "Actor.a.Item.controlled" },
    actor: { uuid: "Actor.a" },
    flags: { "persistent-zones": { controlledZoneMovement: { enabled: true, primaryActivityId: "zone" } } }
  };
  const opened = await startControlledZoneMovementFromActivity(activity, { tokenDocument: source });
  assert.equal(opened.ok, true);
  assert.equal(opened.session.regionUuid, region.uuid);
  closeControlledZoneMovementSession(opened.session);
});

test("the controlled-movement Utility never begins or replaces an active concentration", async () => {
  const { scene, region, other } = setupScene();
  other.flags["persistent-zones"].runtime.activityId = "another-zone";
  const concentration = { id: "concentration", uuid: "Actor.a.ActiveEffect.concentration", disabled: false };
  const source = {
    id: "source", uuid: "Scene.controlled-scene.Token.source", parent: scene,
    actor: { uuid: "Actor.a", effects: new Map([[concentration.id, concentration]]) }
  };
  scene.tokens.contents = [source];
  region.flags["persistent-zones"].runtime.sourceTokenUuid = source.uuid;
  region.flags["persistent-zones"].runtime.sourceTokenId = source.id;
  region.flags["persistent-zones"].runtime.ownerEffectUuid = concentration.uuid;
  region.getFlag = () => region.flags["persistent-zones"].runtime;
  const activity = {
    id: "move-zone",
    item: { uuid: "Actor.a.Item.controlled", actor: source.actor },
    actor: source.actor,
    flags: { "persistent-zones": { controlledZoneMovement: { enabled: true, primaryActivityId: "zone" } } }
  };
  const usage = { concentration: { begin: true, end: concentration.id } };
  assert.equal(preventControlledMovementConcentration(activity, usage), true);
  assert.deepEqual(usage.concentration, { begin: false, end: null });
  assert.equal(source.actor.effects.get(concentration.id), concentration, "the existing effect is untouched");

  const opened = await startControlledZoneMovementFromActivity(activity, { tokenDocument: source });
  assert.equal(opened.ok, true, "the active Region remains available to the command");
  const moved = await commitControlledZoneMovement(opened.session, { x: 400, y: 100 });
  assert.equal(moved.ok, true, "moving the Region does not affect concentration");
  assert.equal(source.actor.effects.get(concentration.id), concentration, "a successful move does not affect concentration");
  const reopened = await startControlledZoneMovementFromActivity(activity, { tokenDocument: source });
  assert.equal(reopened.ok, true, "reusing the Utility does not recreate concentration");
  closeControlledZoneMovementSession(reopened.session, "cancelled");
  assert.equal(source.actor.effects.get(concentration.id), concentration, "cancelling does not affect concentration");
});

test("controlled movement rejects an out-of-range destination rather than silently clamping it", async () => {
  const { region } = setupScene();
  const opened = await openControlledZoneMovementSession({ regionDocument: region, preview: false });
  const validation = validateDestination(opened.session, { x: 1_100, y: 100 });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "destination-out-of-range");
  const result = await commitControlledZoneMovement(opened.session, { x: 1_100, y: 100 });
  assert.equal(result.ok, false);
  assert.equal(region._source.shapes[0].x, 100);
  closeControlledZoneMovementSession(opened.session);
});

test("controlled movement cancellation leaves the Region unchanged and discards the session", async () => {
  const { region } = setupScene();
  const opened = await openControlledZoneMovementSession({ regionDocument: region, preview: false });
  assert.equal(closeControlledZoneMovementSession(opened.session), "cancelled");
  const result = await commitControlledZoneMovement(opened.session, { x: 400, y: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session-closed");
  assert.equal(region._source.shapes[0].x, 100);
});

test("controlled movement stops at the first outside-to-inside PZ membership transition and carries no effects", async () => {
  const { scene, region } = setupScene();
  globalThis.fromUuid = async (uuid) => uuid === region.uuid ? region : null;
  scene.tokens.contents = [mockToken("first", scene, { x: 400, y: 50, disposition: 1 })];
  const opened = await openControlledZoneMovementSession({ regionDocument: region, preview: false });
  const result = await commitControlledZoneMovement(opened.session, { x: 700, y: 100 });
  assert.equal(result.ok, true);
  assert.ok(region._source.shapes[0].x > 350 && region._source.shapes[0].x < 360, "the true Region stops only when the Token reaches the 50% membership threshold");
  assert.equal(result.collidedTokenUuid, "Scene.controlled-scene.Token.first");
  assert.equal(result.collisionPoint.y, 100);
  assert.ok(Math.abs(result.collisionDistance - (region._source.shapes[0].x - 100)) < 1e-4);
  assert.equal("damage" in result, false, "this primitive resolves no damage");
});

test("real controlled movement ignores Tokens beyond the destination and selects the first qualifying Token", async () => {
  const { scene, region } = setupScene();
  globalThis.fromUuid = async (uuid) => uuid === region.uuid ? region : null;
  scene.tokens.contents = [
    mockToken("after", scene, { x: 800, y: 50 }),
    mockToken("second", scene, { x: 500, y: 50 }),
    mockToken("first", scene, { x: 300, y: 50 })
  ];
  const opened = await openControlledZoneMovementSession({ regionDocument: region, preview: false });
  const result = await commitControlledZoneMovement(opened.session, { x: 700, y: 100 });
  assert.equal(result.collidedTokenUuid, "Scene.controlled-scene.Token.first");
  assert.ok(region._source.shapes[0].x > 250 && region._source.shapes[0].x < 260);
});

test("PZ membership uses the full Large footprint and treats every disposition equally", () => {
  const { scene, region } = setupScene();
  const origin = { x: 100, y: 100 };
  const destination = { x: 700, y: 100 };
  const largeFriendly = mockToken("large-friendly", scene, { x: 300, y: 50, width: 2, height: 2, disposition: 1 });
  const hostile = mockToken("hostile", scene, { x: 600, y: 50, disposition: -1 });
  scene.tokens.contents = [largeFriendly, hostile];
  const collision = resolveControlledTokenCollision({ scene, regionDocument: region, origin, destination });
  assert.equal(collision.tokenUuid, "Scene.controlled-scene.Token.large-friendly");
  assert.ok(collision.coverageRatio >= 0.5, "the complete Large footprint reaches the shared 50% threshold");
  assert.ok(collision.collisionPoint.x > 350 && collision.collisionPoint.x < 360, "the first qualifying Large Token still wins over a later hostile Token");
});

test("a geometric touch below 50% membership coverage does not stop controlled movement", () => {
  const { scene, region } = setupScene();
  const origin = { x: 100, y: 100 };
  const destination = { x: 400, y: 100 };
  scene.tokens.contents = [mockToken("partial", scene, { x: 450, y: 50 })];
  const collision = resolveControlledTokenCollision({ scene, regionDocument: region, origin, destination });
  assert.equal(collision, null, "a touched Token remains outside until the central threshold is reached");
});

test("controlled movement preserves the Large Token 25% / 49% continue and 50% stop boundary", () => {
  const { scene, region } = setupScene();
  // A 1-by-2-cell Region sweeps across a 2-by-2-cell Token. Its horizontal
  // overlap is therefore the total-footprint coverage: 25%, 49%, then 50%.
  region._source.shapes = [{ type: "rectangle", x: 0, y: 0, width: 100, height: 200 }];
  const large = mockToken("large-boundary", scene, { x: 400, y: 0, width: 2, height: 2 });
  scene.tokens.contents = [large];
  const origin = { x: 0, y: 0 };

  const quarter = resolveControlledTokenCollision({ scene, regionDocument: region, origin, destination: { x: 350, y: 0 } });
  const fortyNinePercent = resolveControlledTokenCollision({ scene, regionDocument: region, origin, destination: { x: 398, y: 0 } });
  const threshold = resolveControlledTokenCollision({ scene, regionDocument: region, origin, destination: { x: 700, y: 0 } });

  assert.equal(quarter, null, "25% remains OUTSIDE");
  assert.equal(fortyNinePercent, null, "49% remains OUTSIDE");
  assert.equal(threshold?.tokenId, "large-boundary");
  assert.ok(threshold.coverageRatio >= 0.5, "50% is the first INSIDE state");
  assert.ok(threshold.collisionPoint.x > 399 && threshold.collisionPoint.x < 401);
});

test("an unrestricted footprint-50 candidate never sends a synthetic Region to Foundry native membership", () => {
  const { scene, region } = setupScene();
  region.flags["persistent-zones"].runtime.normalizedDefinition.obstacles = { mode: "unrestricted" };
  const token = mockToken("large-candidate", scene, { x: 400, y: 0, width: 2, height: 2 });
  let nativeCalls = 0;
  token.testInsideRegion = () => {
    nativeCalls += 1;
    throw new Error("a footprint-only candidate must not invoke native Region membership");
  };
  scene.tokens.contents = [token];
  const collision = resolveControlledTokenCollision({
    scene,
    regionDocument: region,
    origin: { x: 100, y: 100 },
    destination: { x: 700, y: 100 },
    physicalRadius: 100
  });
  assert.equal(nativeCalls, 0);
  assert.equal(collision?.tokenId, "large-candidate");
  assert.ok(collision.coverageRatio >= 0.5, "the candidate is selected only after its full-footprint threshold is reached");
});

test("default collision geometry sweeps the visible Region before its center reaches a Large Token", () => {
  const { scene, region } = setupScene();
  region._source.shapes[0].radius = 300;
  const token = mockToken("large-visible-zone", scene, { x: 600, y: 0, width: 2, height: 2 });
  scene.tokens.contents = [token];
  const origin = { x: 100, y: 100 };
  const destination = { x: 1_000, y: 100 };
  const collision = resolveControlledTokenCollision({ scene, regionDocument: region, origin, destination, physicalRadius: 0 });
  assert.equal(collision?.tokenId, "large-visible-zone");
  assert.equal(collision?.collisionGeometry?.source, "region-shapes");
  assert.ok(collision.coverageRatio >= 0.5, "the first stop is the first central membership entry");
  assert.ok(collision.collisionPoint.x < 600, "the visible circle first reaches the Token while its center remains outside the Token footprint");
  assert.ok(collision.collisionDistance < Math.hypot(700 - origin.x, 0), "the pointer may remain far beyond the resolved collision");
});

test("a Token already inside at the start does not stop real controlled movement at t=0", async () => {
  const { scene, region } = setupScene();
  region._source.shapes[0].x = 450;
  globalThis.fromUuid = async (uuid) => uuid === region.uuid ? region : null;
  scene.tokens.contents = [mockToken("start-inside", scene, { x: 400, y: 50 })];
  const opened = await openControlledZoneMovementSession({ regionDocument: region, preview: false });
  const result = await commitControlledZoneMovement(opened.session, { x: 100, y: 100 });
  assert.equal(result.collidedTokenUuid, null);
  assert.equal(region._source.shapes[0].x, 100);
});

test("a Token can leave and later re-enter during one sweep, stopping only on the later central transition", () => {
  const { scene, region } = setupScene();
  globalThis.game.settings.get = () => "foundry-native";
  const token = mockToken("re-enter", scene, { x: 400, y: 50 });
  token.testInsideRegion = (candidate) => {
    const x = candidate._source.shapes[0].x;
    return x <= 200 || x >= 500;
  };
  scene.tokens.contents = [token];
  const collision = resolveControlledTokenCollision({
    scene,
    regionDocument: region,
    origin: { x: 100, y: 100 },
    destination: { x: 700, y: 100 },
    physicalRadius: 0
  });
  assert.equal(collision?.tokenId, "re-enter");
  assert.equal(collision.startMembership, true, "initial membership never blocks at t=0");
  assert.ok(collision.collisionPoint.x > 499 && collision.collisionPoint.x < 501, "only the later OUTSIDE-to-INSIDE transition stops the zone");
  assert.equal(collision.transition, "outside-to-inside");
});

test("controlled movement uses the central Foundry-native membership decision", () => {
  const { scene, region } = setupScene();
  globalThis.game.settings.get = () => "foundry-native";
  const token = mockToken("re-enter", scene, { x: 400, y: 50 });
  let nativeCalls = 0;
  token.testInsideRegion = (candidate) => {
    nativeCalls += 1;
    return candidate._source.shapes[0].x >= 350;
  };
  scene.tokens.contents = [token];
  const collision = resolveControlledTokenCollision({
    scene,
    regionDocument: region,
    origin: { x: 100, y: 100 },
    destination: { x: 700, y: 100 },
    physicalRadius: 0
  });
  assert.equal(collision?.tokenId, "re-enter");
  assert.ok(nativeCalls > 0);
  assert.ok(collision.collisionPoint.x > 349 && collision.collisionPoint.x < 351);
  assert.equal(collision.transition, "outside-to-inside");
});

test("the earlier of a move wall or central Token transition determines the controlled destination", async () => {
  const { scene, region } = setupScene({ physicalRadius: 0.75 });
  globalThis.fromUuid = async (uuid) => uuid === region.uuid ? region : null;
  scene.tokens.contents = [mockToken("behind-wall", scene, { x: 500, y: 50 })];
  globalThis.CONFIG.Canvas.polygonBackends.move.testCollision = () => [{ x: 300, y: 100 }];
  let opened = await openControlledZoneMovementSession({ regionDocument: region, preview: false });
  let result = await commitControlledZoneMovement(opened.session, { x: 700, y: 100 });
  assert.equal(result.collidedTokenUuid, null);
  assert.equal(region._source.shapes[0].x, 298, "the wall wins before a Token behind it");

  region._source.shapes[0].x = 100;
  scene.tokens.contents = [mockToken("before-wall", scene, { x: 200, y: 50 })];
  opened = await openControlledZoneMovementSession({ regionDocument: region, preview: false });
  result = await commitControlledZoneMovement(opened.session, { x: 700, y: 100 });
  assert.equal(result.collidedTokenUuid, "Scene.controlled-scene.Token.before-wall");
  assert.ok(region._source.shapes[0].x < 298, "the Token transition wins before the wall");
});

test("controlled movement uses existing PZ sampled membership fallback on gridless scenes", () => {
  const { scene, region } = setupScene();
  scene.grid.type = globalThis.CONST.GRID_TYPES.GRIDLESS;
  const origin = { x: 100, y: 100 };
  const destination = { x: 700, y: 100 };
  scene.tokens.contents = [mockToken("gridless", scene, { x: 400, y: 50 })];
  const collision = resolveControlledTokenCollision({ scene, regionDocument: region, origin, destination });
  assert.equal(collision?.tokenUuid, "Scene.controlled-scene.Token.gridless");
  assert.equal(collision?.transition, "outside-to-inside");
});

test("controlled movement preserves a Foundry V14 canvas placeable actor when its Scene TokenDocument lacks one", async () => {
  const { scene, region } = setupScene({ physicalRadius: 0.75 });
  globalThis.fromUuid = async (uuid) => uuid === region.uuid ? region : null;
  const tokenDocument = mockToken("canvas-token", scene, { x: 400, y: 50 });
  tokenDocument.actor = null;
  const placeableActor = { id: "canvas-actor", uuid: "Actor.canvas-token" };
  scene.tokens.contents = [tokenDocument];
  globalThis.canvas.tokens = { placeables: [{ id: "canvas-token-placeable", document: tokenDocument, actor: placeableActor }] };
  const analysis = analyzeControlledTokenCollision({
    scene,
    regionDocument: region,
    origin: { x: 100, y: 100 },
    destination: { x: 700, y: 100 },
    physicalRadius: 50
  });
  assert.equal(analysis.candidateTokenCount, 1);
  assert.equal(analysis.candidateDiagnostics[0].reason, "accepted");
  assert.equal(analysis.candidateDiagnostics[0].actorId, "canvas-actor");
  const opened = await openControlledZoneMovementSession({ regionDocument: region, preview: false });
  const result = await commitControlledZoneMovement(opened.session, { x: 700, y: 100 });
  assert.equal(result.collidedTokenUuid, tokenDocument.uuid);
});

test("controlled movement accepts iterable Foundry Scene token collections instead of assuming an Array contents field", () => {
  const { scene, region } = setupScene();
  const tokenDocument = mockToken("iterable-token", scene, { x: 400, y: 50 });
  scene.tokens.contents = new Set([tokenDocument]);
  const analysis = analyzeControlledTokenCollision({
    scene,
    regionDocument: region,
    origin: { x: 100, y: 100 },
    destination: { x: 700, y: 100 },
    physicalRadius: 50
  });
  assert.equal(analysis.candidateTokenCount, 1);
  assert.equal(analysis.collision?.tokenId, "iterable-token");
});

test("controlled movement broad-phases a crowded scene before precise membership sweeps", () => {
  const { scene, region } = setupScene();
  let distantMembershipCalls = 0;
  const distant = Array.from({ length: 80 }, (_value, index) => {
    const token = mockToken(`distant-${index}`, scene, { x: 10_000 + index * 150, y: 10_000 });
    token.testInsideRegion = () => { distantMembershipCalls += 1; return false; };
    return token;
  });
  const nearA = mockToken("near-a", scene, { x: 400, y: 50 });
  const nearB = mockToken("near-b", scene, { x: 500, y: 50 });
  scene.tokens.contents = [...distant, nearA, nearB];
  const analysis = analyzeControlledTokenCollision({
    scene,
    regionDocument: region,
    origin: { x: 100, y: 100 },
    destination: { x: 700, y: 100 }
  });
  assert.equal(analysis.tokenCollection.tokens.length, 82);
  assert.equal(analysis.candidateTokenCount, 2);
  assert.equal(distantMembershipCalls, 0, "Tokens outside the swept bounds never enter precise membership testing");
  assert.ok(analysis.metrics.membershipCalls > 0);
});

test("a non-owner cannot open a controlled-movement session or gain Region update authority", async () => {
  const { scene, region } = setupScene();
  const source = {
    id: "source", uuid: "Scene.controlled-scene.Token.source", parent: scene,
    actor: { testUserPermission: () => false }
  };
  scene.tokens = { contents: [source], get: (id) => id === source.id ? source : null };
  region.flags["persistent-zones"].runtime.sourceTokenId = source.id;
  globalThis.game = { user: { id: "player", isGM: false }, users: { activeGM: { id: "gm", isGM: true } }, settings: { get: () => "minimal" } };
  const opened = await openControlledZoneMovementSession({ regionDocument: region, preview: false });
  assert.equal(opened.ok, false);
  assert.equal(opened.reason, "permission-denied");
});

function setupScene({ physicalRadius = 0 } = {}) {
  globalThis.game = {
    version: "14.367",
    user: { id: "gm", isGM: true },
    users: { activeGM: { id: "gm", isGM: true }, get: () => ({ id: "gm", isGM: true }) },
    settings: { get: () => "minimal" }
  };
  const scene = { id: "controlled-scene", grid: { size: 100, distance: 1.5, units: "m" }, tokens: { contents: [] } };
  const runtime = {
    contractVersion: 1,
    itemUuid: "Actor.a.Item.controlled",
    actorUuid: "Actor.a",
    activityId: "zone",
    normalizedDefinition: normalizeZoneDefinition({
      enabled: true,
      geometry: { type: "circle", radius: 3, units: "m" },
      controlledMovement: { enabled: true, activationActivityId: "move-zone", maxDistance: 9, physicalRadius, units: "m" }
    }, { item: { name: "Controlled", system: { level: 1 } } })
  };
  const region = mockRegion("controlled", scene, runtime, 100, 100);
  const other = mockRegion("other", scene, structuredClone(runtime), 500, 100);
  scene.regions = { contents: [region, other] };
  globalThis.canvas = { scene, interface: null, tokens: { placeables: [] } };
  globalThis.CONST = { GRID_TYPES: { GRIDLESS: 0, SQUARE: 1 } };
  globalThis.CONFIG = { Canvas: { polygonBackends: { move: { testCollision: () => [] } } } };
  return { scene, region, other };
}

function mockToken(id, scene, { x, y, width = 1, height = 1, disposition = 0 } = {}) {
  return {
    id,
    uuid: `Scene.${scene.id}.Token.${id}`,
    parent: scene,
    x,
    y,
    width,
    height,
    actor: { uuid: `Actor.${id}`, disposition },
    disposition,
    testInsideRegion: (region) => {
      assert.equal(typeof region?.includedInLevel, "function", "native candidate must be a RegionDocument-compatible clone");
      return true;
    }
  };
}

function mockRegion(id, scene, runtime, x, y) {
  const flags = { "persistent-zones": { runtime } };
  const region = {
    id,
    uuid: `Scene.${scene.id}.Region.${id}`,
    documentName: "Region",
    parent: scene,
    flags,
    _source: { flags, shapes: [{ type: "circle", x, y, radius: 100 }] },
    getFlag: () => runtime,
    toObject: () => ({ flags, shapes: structuredClone(region._source.shapes) }),
    includedInLevel: () => true,
    clone({ shapes = region._source.shapes } = {}) {
      return {
        ...region,
        _source: { ...region._source, shapes: structuredClone(shapes) },
        toObject: () => ({ flags, shapes: structuredClone(shapes) }),
        includedInLevel: () => true
      };
    },
    async update({ shapes }, options = {}) {
      region._source.shapes = structuredClone(shapes);
      region.lastUpdateOptions = options;
      return region;
    }
  };
  return region;
}
