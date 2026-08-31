import assert from "node:assert/strict";
import test from "node:test";

globalThis.CONFIG = {
  statusEffects: [
    { id: "prone", _id: "prone", name: "Prone" },
    { id: "poisoned", _id: "poisoned", name: "Poisoned" }
  ]
};

const {
  ensureAggregateStatus,
  getManagedStatusSources,
  handleDeletedStatusEffect
} = await import("../runtime/status-state.mjs");

test("manual canonical status removal deletes only matching PZ sources and permits a future trigger", async () => {
  const actor = buildActor([
    source("prone-a", "prone", "Region.a"),
    source("prone-b", "prone", "Region.b"),
    source("poisoned-a", "poisoned", "Region.c")
  ]);
  const deletedCanonical = canonical("prone", actor);

  await handleDeletedStatusEffect(deletedCanonical, {});

  assert.deepEqual(actor.deletedIds.sort(), ["prone-a", "prone-b"]);
  assert.equal(actor.lastDeleteOptions.persistentZonesCanonicalStatusRemoval, true);
  assert.equal(getManagedStatusSources(actor, "prone").length, 0);
  assert.equal(getManagedStatusSources(actor, "poisoned").length, 1);
  assert.equal(actor.toggleCalls.length, 0, "manual removal must not immediately recreate the canonical status");

  actor.effects.push(source("prone-next-trigger", "prone", "Region.a"));
  await ensureAggregateStatus(actor, "prone");
  assert.deepEqual(actor.toggleCalls, [{ statusId: "prone", options: { active: true } }]);
});

test("source cleanup marked as a canonical-removal cascade cannot recreate the status", async () => {
  const actor = buildActor([source("remaining-prone", "prone", "Region.other")]);
  const deletedSource = source("deleted-prone", "prone", "Region.deleted");
  deletedSource.parent = actor;
  await handleDeletedStatusEffect(deletedSource, { persistentZonesCanonicalStatusRemoval: true });
  assert.equal(actor.toggleCalls.length, 0);
});

test("ordinary source cleanup still reconciles an aggregate owned by another source", async () => {
  const actor = buildActor([source("remaining-prone", "prone", "Region.other")]);
  const deletedSource = source("deleted-prone", "prone", "Region.deleted");
  deletedSource.parent = actor;
  await handleDeletedStatusEffect(deletedSource, {});
  assert.deepEqual(actor.toggleCalls, [{ statusId: "prone", options: { active: true } }]);
});

function source(id, statusId, origin) {
  return {
    id,
    uuid: `Actor.test.ActiveEffect.${id}`,
    origin,
    active: true,
    flags: { "persistent-zones": { managedTriggeredEffect: true, statusId } }
  };
}

function canonical(statusId, actor) {
  return {
    id: statusId,
    uuid: `${actor.uuid}.ActiveEffect.${statusId}`,
    parent: actor,
    flags: {},
    statuses: new Set([statusId]),
    async update(changes) {
      this.flags["persistent-zones"] ??= {};
      if (changes["flags.persistent-zones.managedAggregateStatus"] !== undefined) {
        this.flags["persistent-zones"].managedAggregateStatus = changes["flags.persistent-zones.managedAggregateStatus"];
      }
      if (changes["flags.persistent-zones.statusId"] !== undefined) {
        this.flags["persistent-zones"].statusId = changes["flags.persistent-zones.statusId"];
      }
    }
  };
}

function buildActor(initialEffects) {
  const effects = [...initialEffects];
  effects.get = (id) => effects.find((effect) => effect.id === id) ?? null;
  const actor = {
    uuid: "Actor.test",
    effects,
    deletedIds: [],
    lastDeleteOptions: null,
    toggleCalls: [],
    async deleteEmbeddedDocuments(_documentName, ids, options) {
      this.deletedIds.push(...ids);
      this.lastDeleteOptions = options;
      for (const id of ids) {
        const index = effects.findIndex((effect) => effect.id === id);
        if (index >= 0) effects.splice(index, 1);
      }
    },
    async toggleStatusEffect(statusId, options) {
      this.toggleCalls.push({ statusId, options });
      const effect = canonical(statusId, this);
      effects.push(effect);
      return effect;
    }
  };
  for (const effect of effects) effect.parent = actor;
  return actor;
}
