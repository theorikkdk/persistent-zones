import assert from "node:assert/strict";

globalThis.ChatMessage = {
  getSpeaker: ({ actor, token }) => ({ actor: actor?.id, token: token?.id })
};

const { buildSimpleSaveResult, rollSimpleActorSave } = await import("../runtime/simple-save.mjs");

{
  let modernArguments = null;
  let legacyCalled = false;
  const expectedRoll = { total: 18 };
  const actor = {
    id: "modern-actor",
    async rollSavingThrow(...args) {
      modernArguments = args;
      return [expectedRoll];
    },
    async rollAbilitySave() {
      legacyCalled = true;
      return { total: 1 };
    }
  };

  const result = await rollSimpleActorSave({
    actor,
    ability: "con",
    dc: 15,
    flavor: "Toxic Cloud: onEnter save",
    tokenDocument: { id: "token-id" }
  });

  assert.equal(result, expectedRoll, "the first D&D5e saving throw roll must be returned");
  assert.equal(legacyCalled, false, "rollAbilitySave must not run when rollSavingThrow exists");
  assert.deepEqual(modernArguments, [
    { ability: "con", target: 15 },
    { configure: false },
    {
      data: {
        flavor: "Toxic Cloud: onEnter save",
        speaker: { actor: "modern-actor", token: "token-id" }
      }
    }
  ], "PZ must delegate the ability, DC, native modifiers, and fast-forward behavior to D&D5e");
}

{
  let legacyArguments = null;
  const actor = {
    async rollAbilitySave(...args) {
      legacyArguments = args;
      return { total: 14 };
    }
  };

  const result = await rollSimpleActorSave({
    actor,
    ability: "dex",
    dc: 12,
    flavor: "Legacy save"
  });

  assert.equal(result.total, 14, "the historical save result must remain available");
  assert.deepEqual(legacyArguments, ["dex", {
    chatMessage: true,
    fastForward: true,
    flavor: "Legacy save"
  }], "rollAbilitySave must be isolated behind the absence of rollSavingThrow");
}

{
  const messages = [];
  globalThis.Roll = class {
    constructor(formula, data) {
      this.formula = formula;
      this.data = data;
      this.total = 9;
    }

    async evaluate() {}

    async toMessage(message) {
      messages.push(message);
    }
  };

  const result = await rollSimpleActorSave({
    actor: { id: "old-actor", system: { abilities: { wis: { save: 3 } } } },
    ability: "wis",
    dc: 10,
    flavor: "Manual fallback"
  });

  assert.equal(result.formula, "1d20 + @bonus");
  assert.equal(result.data.bonus, 3);
  assert.equal(messages.length, 1, "the final historical fallback must still create a chat message");
}

{
  assert.deepEqual(buildSimpleSaveResult({
    ability: "con",
    dc: 15,
    roll: { total: 15 },
    onSuccess: "half"
  }), {
    ability: "con",
    dc: 15,
    total: 15,
    success: true,
    onSuccess: "half"
  }, "a total equal to the DC must succeed");

  assert.equal(buildSimpleSaveResult({
    ability: "con",
    dc: 15,
    roll: { total: 14 },
    onSuccess: "none"
  }).success, false, "a total below the DC must fail");
}

console.log("simple-save tests passed");
