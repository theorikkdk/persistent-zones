import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { BUILTIN_PRESETS } from "../presets/builtins.mjs";

import {
  attemptStatusEscape,
  buildStatusEscapeEffectFlag,
  buildStatusEscapeTurnKey,
  normalizeStatusEscape,
  resolveAbilityCheckTotal,
  resolveStatusEscapeDC
} from "../runtime/status-escape.mjs";

test("escape configuration defaults safely and resolves inherited or custom DC", () => {
  assert.deepEqual(normalizeStatusEscape(), {
    enabled: false, actionType: "action", checkType: "ability", ability: "str",
    dcMode: "inherit", customDC: null, removeOnSuccess: true,
    prompt: { enabled: true, title: null, message: null }
  });
  assert.equal(resolveStatusEscapeDC({ enabled: true }, { saveDC: 15 }), 15);
  assert.equal(resolveStatusEscapeDC({ enabled: true, dcMode: "custom", customDC: 13 }, { saveDC: 15 }), 13);
  assert.equal(buildStatusEscapeEffectFlag({ enabled: false }), null);

  const requiredKeys = ["Title", "Message", "UsesAction", "Check", "DC", "SuccessRemoves", "Yes", "No", "ManualAction", "Success", "Failure", "EffectRemoved", "EffectRemains", "AlreadyAttempted", "EffectFallback", "SourceFallback"];
  for (const language of ["en", "fr"]) {
    const translations = JSON.parse(fs.readFileSync(new URL(`../../lang/${language}.json`, import.meta.url), "utf8"));
    for (const key of requiredKeys) assert.equal(typeof translations.PERSISTENT_ZONES.Escape[key], "string", `${language} Escape.${key}`);
  }
  assert.equal(BUILTIN_PRESETS.some(({ id }) => id === "test.m9-escape-action"), false);
  for (const id of ["srd-5.2.1.grease", "srd-5.2.1.wall-of-fire-line", "srd-5.2.1.wall-of-fire-ring", "srd-5.2.1.moonbeam", "srd-5.2.1.spike-growth", "srd-5.2.1.insect-plague"]) {
    assert.equal(BUILTIN_PRESETS.some((preset) => preset.id === id), true, id);
  }
  const combat = buildCombat({ uuid: "Actor.a" });
  assert.notEqual(buildStatusEscapeTurnKey(combat, { uuid: "Effect.one" }), buildStatusEscapeTurnKey(combat, { uuid: "Effect.two" }));
});

test("native roll totals accept the D&D5e array result", () => {
  assert.equal(resolveAbilityCheckTotal([{ total: 17 }]), 17);
  assert.equal(resolveAbilityCheckTotal(null), null);
});

test("one exact source can be removed on success without deleting its sibling", async () => {
  const deleted = [];
  const actor = {
    uuid: "Actor.a", isOwner: true,
    testUserPermission: () => true,
    async deleteEmbeddedDocuments(_type, ids) { deleted.push(...ids); }
  };
  const effect = buildEffect(actor, "one", 12);
  const sibling = buildEffect(actor, "two", 12);
  const documents = new Map([[effect.uuid, effect], [effect.origin, { uuid: effect.origin }]]);
  const result = await attemptStatusEscape({
    effect, allowOutsideCombat: true, user: { id: "owner" },
    resolveUuid: async (uuid) => documents.get(uuid) ?? null,
    rollAbility: async ({ ability }) => (assert.equal(ability, "dex"), [{ total: 14 }]),
    postResult: async () => null
  });
  assert.equal(result.success, true);
  assert.deepEqual(deleted, [effect.id]);
  assert.notEqual(effect.id, sibling.id);
});

test("a failed attempt is consumed for its combat turn but resets next turn", async () => {
  const actor = { uuid: "Actor.a", isOwner: true, testUserPermission: () => true };
  const effect = buildEffect(actor, "one", 18);
  const combat = buildCombat(actor);
  const resolveUuid = async (uuid) => uuid === effect.origin ? { uuid } : effect;
  const options = { effect, combat, user: { id: "owner" }, resolveUuid, rollAbility: async () => [{ total: 8 }], postResult: async () => null };
  assert.equal((await attemptStatusEscape(options)).attempted, true);
  assert.equal((await attemptStatusEscape(options)).reason, "already-attempted-this-turn");
  combat.turn = 2;
  assert.equal((await attemptStatusEscape(options)).attempted, true);
});

test("missing source and non-owner attempts are safe no-ops", async () => {
  const actor = { isOwner: false, testUserPermission: () => false };
  const effect = buildEffect(actor, "one", 12);
  assert.equal((await attemptStatusEscape({ effect, allowOutsideCombat: true, user: { id: "player" } })).reason, "not-authorized");
  actor.testUserPermission = () => true;
  assert.equal((await attemptStatusEscape({ effect, allowOutsideCombat: true, user: { id: "owner" }, resolveUuid: async () => null })).reason, "source-not-found");
});

function buildEffect(actor, id, dc) {
  const statusEscape = buildStatusEscapeEffectFlag({ enabled: true, ability: "dex" }, { resolvedDC: dc, statusId: "restrained" });
  return {
    id, uuid: `Actor.a.ActiveEffect.${id}`, documentName: "ActiveEffect", parent: actor,
    origin: "Item.source", flags: { "persistent-zones": { statusEscape } },
    async update(changes) { this.flags["persistent-zones"].statusEscape = changes["flags.persistent-zones.statusEscape"]; }
  };
}

function buildCombat(actor) {
  const token = { id: "token", uuid: "Scene.s.Token.token", actor };
  return { id: "combat", started: true, round: 1, turn: 1, combatant: { id: "combatant", token } };
}
