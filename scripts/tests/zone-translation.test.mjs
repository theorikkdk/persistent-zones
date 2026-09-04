import assert from "node:assert/strict";
import test from "node:test";

globalThis.game ??= { user: { isGM: true } };
globalThis.canvas ??= { scene: { grid: { size: 100, distance: 5, units: "ft" } } };
globalThis.foundry ??= { utils: { deepClone: structuredClone } };

const { normalizeZoneDefinition } = await import("../runtime/zone-definition.mjs");
const { getPersistentZoneActivityDefinition } = await import("../activity/persistent-zone-activity-utils.mjs");
const { getPersistentZonePreset } = await import("../presets/preset-library.mjs");
const { applyPresetToActivity } = await import("../presets/preset-utils.mjs");
const {
  getRegionLogicalCenter,
  processSourceTurnZoneTranslations,
  resolveMoveCollision
} = await import("../runtime/zone-translation-runtime.mjs");

test("translation normalizes only the supported source-turn away-from-source mode", () => {
  const normalized = normalizeZoneDefinition({
    enabled: true,
    geometry: { type: "circle", radius: 10, units: "ft" },
    translation: { enabled: true, trigger: "source-turn-start", distance: 10, units: "ft", direction: "away-from-source" }
  }, { item: { name: "Translation", system: { level: 1 } } });
  assert.deepEqual(normalized.translation, {
    enabled: true, trigger: "source-turn-start", distance: 10, units: "ft", direction: "away-from-source", sceneUnits: "ft"
  });
});

test("translation logical center follows the Region shape, not a source token", () => {
  assert.deepEqual(getRegionLogicalCenter({ _source: { shapes: [{ type: "circle", x: 300, y: 200, radius: 100 }] } }), { x: 300, y: 200 });
});

test("move collision uses the V14 movement polygon backend for open, blocked, and diagonal paths", () => {
  setMoveCollisionBackend([]);
  const open = resolveMoveCollision({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.equal(open.reason, "full-distance");
  assert.equal(open.dx, 100);

  setMoveCollisionBackend([mockMoveWall("mid", 50, -100, 50, 100)]);
  const blocked = resolveMoveCollision({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.equal(blocked.reason, "blocked-by-move-wall");
  assert.ok(blocked.dx >= 48 && blocked.dx < 50);
  assert.equal(blocked.dy, 0);

  setMoveCollisionBackend([mockMoveWall("near", 1, -100, 1, 100)]);
  const near = resolveMoveCollision({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.equal(near.reason, "blocked-at-origin");
  assert.equal(near.dx, 0);

  setMoveCollisionBackend([mockMoveWall("open-door", 50, -100, 50, 100, { open: true })]);
  const openDoor = resolveMoveCollision({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.equal(openDoor.reason, "full-distance");
  assert.equal(openDoor.dx, 100);

  setMoveCollisionBackend([
    mockMoveWall("second", 80, -100, 80, 100),
    mockMoveWall("first", 30, -100, 30, 100)
  ]);
  const first = resolveMoveCollision({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.equal(first.firstCollision.edges.values().next().value.object.document.id, "first");
  assert.ok(first.dx >= 28 && first.dx < 30);

  setMoveCollisionBackend([mockMoveWall("diagonal", 50, 0, 50, 100)]);
  const diagonal = resolveMoveCollision({ x: 0, y: 0 }, { x: 100, y: 100 });
  assert.equal(diagonal.reason, "blocked-by-move-wall");
  assert.ok(diagonal.dx >= 49 && diagonal.dx < 50);
  assert.ok(diagonal.dy >= 49 && diagonal.dy < 50);
});

test("translation updates the Region only until the first movement wall", async () => {
  const scene = { id: "translation-collision", grid: { size: 100, distance: 1.5, units: "m" } };
  const source = mockToken("source-collision", 0, 0, scene);
  scene.tokens = { contents: [source] };
  globalThis.canvas = { scene, walls: {} };
  setMoveCollisionBackend([mockMoveWall("mid", 350, -100, 350, 300)]);
  const normalizedDefinition = normalizeZoneDefinition({
    enabled: true,
    geometry: { type: "circle", radius: 3, units: "m" },
    translation: { enabled: true, trigger: "source-turn-start", distance: 3, units: "m", direction: "away-from-source" }
  }, { item: { name: "Translation", system: { level: 1 } } });
  const region = mockRegion({
    id: "translation-collision-region",
    scene,
    runtime: {
      contractVersion: 1,
      itemUuid: "Actor.source.Item.translation",
      actorUuid: "Actor.source",
      sourceTokenId: source.id,
      sourceTokenUuid: source.uuid,
      normalizedDefinition
    },
    x: 250,
    y: 50
  });
  scene.regions = { contents: [region] };

  const result = await processSourceTurnZoneTranslations(
    { id: "translation-collision-combat" }, { combatantId: source.id, round: 1, turn: 0 }, source
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "blocked-by-move-wall");
  assert.ok(region._source.shapes[0].x >= 348 && region._source.shapes[0].x < 350);
});

test("applied translation preset reaches Region runtime flags and moves only on its source token turn", async () => {
  const scene = { id: "translation-scene", grid: { size: 100, distance: 1.5, units: "m" } };
  const source = mockToken("source", 0, 0, scene);
  const other = mockToken("other", 600, 0, scene);
  scene.tokens = { contents: [source, other] };
  globalThis.canvas = { scene, walls: { checkCollision: () => false } };
  setMoveCollisionBackend([]);

  const applied = {};
  const activity = {
    id: "translation-activity",
    item: {
      async updateActivity(_id, updates) {
        if (updates.persistentZone) applied.persistentZone = structuredClone(updates.persistentZone);
      }
    }
  };
  await applyPresetToActivity(activity, getPersistentZonePreset("debug.zone-translation"), { scene });
  const item = { uuid: "Actor.source.Item.translation", name: "Translation", system: { level: 1 } };
  const persistedActivity = {
    id: "translation-activity",
    uuid: "Actor.source.Item.translation.Activity.translation-activity",
    type: "persistent-zone",
    name: "Translation",
    item,
    persistentZone: structuredClone(applied.persistentZone),
    toObject: () => ({ persistentZone: structuredClone(applied.persistentZone) })
  };
  const activityDefinition = getPersistentZoneActivityDefinition(persistedActivity);
  assert.equal(activityDefinition.translation.enabled, true);
  assert.equal(activityDefinition.translation.distance, 3);
  assert.equal(activityDefinition.translation.units, "m");
  const normalizedDefinition = normalizeZoneDefinition(activityDefinition, { item, actor: { uuid: "Actor.source" } });
  assert.equal(normalizedDefinition.translation.enabled, true);
  assert.equal(normalizedDefinition.translation.distance, 3);
  assert.equal(normalizedDefinition.translation.units, "m");

  const region = mockRegion({
    id: "translation-region",
    scene,
    runtime: {
      contractVersion: 1,
      itemUuid: "Actor.source.Item.translation",
      actorUuid: "Actor.source",
      activityId: "translation-activity",
      sourceTokenId: source.id,
      sourceTokenUuid: source.uuid,
      normalizedDefinition
    },
    x: 250,
    y: 50
  });
  scene.regions = { contents: [region] };

  const otherResult = await processSourceTurnZoneTranslations(
    { id: "translation-combat" }, { combatantId: other.id, round: 1, turn: 0 }, other
  );
  assert.deepEqual(otherResult, []);
  assert.equal(region._source.shapes[0].x, 250);

  const sourceResult = await processSourceTurnZoneTranslations(
    { id: "translation-combat" }, { combatantId: source.id, round: 1, turn: 1 }, source
  );
  assert.equal(sourceResult.length, 1);
  assert.equal(sourceResult[0].moved, true);
  assert.equal(region._source.shapes[0].x, 450);
});

test("translation fails safely when a Region retains only an ambiguous source Actor", async () => {
  const scene = { id: "translation-missing-source", grid: { size: 100, distance: 5, units: "ft" } };
  const active = mockToken("active", 0, 0, scene);
  scene.tokens = { contents: [active] };
  globalThis.canvas = { scene, walls: { checkCollision: () => false } };
  const normalizedDefinition = normalizeZoneDefinition({
    enabled: true,
    geometry: { type: "circle", radius: 10, units: "ft" },
    translation: { enabled: true, trigger: "source-turn-start", distance: 10, units: "ft", direction: "away-from-source" }
  }, { item: { name: "Translation", system: { level: 1 } } });
  const region = mockRegion({
    id: "translation-no-source",
    scene,
    runtime: {
      contractVersion: 1,
      itemUuid: "Actor.source.Item.translation",
      actorUuid: "Actor.source",
      normalizedDefinition
    },
    x: 250,
    y: 50
  });
  scene.regions = { contents: [region] };

  const result = await processSourceTurnZoneTranslations(
    { id: "translation-combat-missing" }, { combatantId: active.id, round: 1, turn: 0 }, active
  );
  assert.deepEqual(result, []);
  assert.equal(region._source.shapes[0].x, 250);
});

function mockToken(id, x, y, scene) {
  return {
    id,
    uuid: `Scene.${scene.id}.Token.${id}`,
    parent: scene,
    x,
    y,
    width: 1,
    height: 1,
    testInsideRegion: () => false
  };
}

function mockRegion({ id, scene, runtime, x, y }) {
  const flags = { "persistent-zones": { runtime } };
  const region = {
    id,
    parent: scene,
    flags,
    _source: { flags, shapes: [{ type: "circle", x, y, radius: 100 }] },
    getFlag: () => runtime,
    toObject: () => ({ flags, shapes: structuredClone(region._source.shapes) }),
    async update({ shapes }) {
      region._source.shapes = structuredClone(shapes);
      return region;
    }
  };
  return region;
}

function mockMoveWall(id, x1, y1, x2, y2, { open = false, move = 1 } = {}) {
  return { id, x1, y1, x2, y2, open, move };
}

function setMoveCollisionBackend(walls) {
  globalThis.CONFIG = {
    Canvas: {
      polygonBackends: {
        move: {
          testCollision(origin, destination, { type, mode }) {
            assert.equal(type, "move");
            assert.equal(mode, "all");
            return walls
              .filter((wall) => wall.move !== 0 && !wall.open)
              .map((wall) => ({ wall, hit: lineIntersection(origin, destination, { x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }) }))
              .filter(({ hit }) => hit)
              .sort((a, b) => a.hit.t - b.hit.t)
              .map(({ wall, hit }) => ({
                x: hit.x,
                y: hit.y,
                edges: new Set([{ id: `Wall.${wall.id}`, move: wall.move, object: { document: { id: wall.id, move: wall.move, ds: wall.open ? 1 : 0 } } }])
              }));
          }
        }
      }
    }
  };
}

function lineIntersection(a, b, c, d) {
  const denominator = ((d.y - c.y) * (b.x - a.x)) - ((d.x - c.x) * (b.y - a.y));
  if (Math.abs(denominator) < 1e-9) return null;
  const ua = (((d.x - c.x) * (a.y - c.y)) - ((d.y - c.y) * (a.x - c.x))) / denominator;
  const ub = (((b.x - a.x) * (a.y - c.y)) - ((b.y - a.y) * (a.x - c.x))) / denominator;
  if (ua <= 0 || ua > 1 || ub < 0 || ub > 1) return null;
  return { t: ua, x: a.x + (ua * (b.x - a.x)), y: a.y + (ua * (b.y - a.y)) };
}
