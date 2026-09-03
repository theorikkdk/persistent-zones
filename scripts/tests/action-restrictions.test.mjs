import assert from "node:assert/strict";
import test from "node:test";

const handlers = new Map();
globalThis.Hooks = { on: (name, callback) => handlers.set(name, callback) };
globalThis.game = {
  i18n: {
    localize: (key) => key,
    format: (_key, data) => `Blocked: ${data.action}`
  }
};
globalThis.ui = { notifications: { warn: () => {} } };

const {
  cleanupStatusesUntilEndOfTurn,
  registerPersistentZoneActionRestrictions
} = await import("../runtime/action-restrictions.mjs");

test("PZ action restrictions stop only matching native D&D5e activity activations", () => {
  const warnings = [];
  globalThis.ui.notifications.warn = (message) => warnings.push(message);
  registerPersistentZoneActionRestrictions();
  const hook = handlers.get("dnd5e.preUseActivity");
  const actor = {
    effects: [{ disabled: false, flags: { "persistent-zones": { actionRestrictions: { action: true, bonusAction: false } } } }]
  };
  assert.equal(hook({ actor, activation: { type: "action" } }), false);
  assert.equal(hook({ actor, activation: { type: "bonus" } }), true);
  assert.equal(hook({ actor, activation: { type: "reaction" } }), true);
  assert.equal(warnings.length, 1);
});

test("PZ until-end-of-current-turn cleanup removes only statuses from that exact combat turn", async () => {
  const deleted = [];
  const actor = {
    effects: [
      { id: "remove", flags: { "persistent-zones": { managedTriggeredEffect: true, persistenceMode: "until-end-of-current-turn", turnDuration: { combatId: "combat", round: 2, turn: 1 } } } },
      { id: "keep-turn", flags: { "persistent-zones": { managedTriggeredEffect: true, persistenceMode: "until-end-of-current-turn", turnDuration: { combatId: "combat", round: 2, turn: 2 } } } },
      { id: "keep-persistent", flags: { "persistent-zones": { managedTriggeredEffect: true, persistenceMode: "persistent" } } }
    ],
    async deleteEmbeddedDocuments(type, ids) { deleted.push({ type, ids }); }
  };
  const combat = {
    id: "combat",
    combatants: new Map([["combatant", { token: { document: { actor } } }]])
  };
  const ids = await cleanupStatusesUntilEndOfTurn(combat, { combatantId: "combatant", round: 2, turn: 1 });
  assert.deepEqual(ids, ["remove"]);
  assert.deepEqual(deleted, [{ type: "ActiveEffect", ids: ["remove"] }]);
});
