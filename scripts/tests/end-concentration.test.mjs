import assert from "node:assert/strict";
import test from "node:test";

const { applyTriggeredEndConcentration } = await import("../runtime/entry-effects.mjs");

test("end concentration uses the native D&D5e concentration effect only after a failed configured save", async () => {
  const concentrationEffect = { id: "concentration" };
  const deleted = [];
  const actor = {
    concentration: { effects: { first: () => concentrationEffect } },
    async endConcentration(effect) { deleted.push(effect.id); return [effect]; }
  };
  const config = { enabled: true };
  assert.equal((await applyTriggeredEndConcentration({ actor, config, saveEnabled: true, saveResult: { success: true } })).applied, false);
  assert.equal((await applyTriggeredEndConcentration({ actor, config, saveEnabled: true, saveResult: { success: false } })).applied, true);
  assert.deepEqual(deleted, ["concentration"]);
});

test("end concentration remains a safe no-op when its effect is absent or disabled", async () => {
  const actor = { concentration: { effects: { first: () => null } }, async endConcentration() { assert.fail("must not end concentration"); } };
  assert.equal((await applyTriggeredEndConcentration({ actor, config: { enabled: true } })).skipped, true);
  assert.equal((await applyTriggeredEndConcentration({ actor, config: { enabled: false } })).skipped, true);
});
