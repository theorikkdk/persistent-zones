export async function rollSimpleActorSave({
  actor,
  ability,
  dc,
  flavor,
  tokenDocument = null
} = {}) {
  if (typeof actor?.rollSavingThrow === "function") {
    const rollResult = await actor.rollSavingThrow({
      ability,
      target: dc
    }, {
      configure: false
    }, {
      data: {
        flavor,
        speaker: ChatMessage.getSpeaker({ actor, token: tokenDocument })
      }
    });

    return Array.isArray(rollResult) ? rollResult[0] ?? null : rollResult;
  }

  if (typeof actor?.rollAbilitySave === "function") {
    return actor.rollAbilitySave(ability, {
      chatMessage: true,
      fastForward: true,
      flavor
    });
  }

  const bonus = getManualSaveBonus(actor, ability);
  const roll = new Roll("1d20 + @bonus", { bonus });
  await roll.evaluate();
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor, token: tokenDocument }),
    flavor: `${flavor} (${String(ability).toUpperCase()})`
  });
  return roll;
}

export function buildSimpleSaveResult({ ability, dc, roll, onSuccess = "half" } = {}) {
  const numericTotal = Number(roll?.total);
  const total = Number.isFinite(numericTotal) ? numericTotal : null;
  return {
    ability,
    dc,
    total,
    success: total !== null && dc !== null ? total >= dc : false,
    onSuccess: String(onSuccess ?? "half").toLowerCase()
  };
}

function getManualSaveBonus(actor, ability) {
  return coerceNumber(
    pickFirstDefined(
      actor?.system?.abilities?.[ability]?.save,
      actor?.system?.abilities?.[ability]?.bonuses?.save,
      actor?.system?.abilities?.[ability]?.mod,
      0
    ),
    0
  );
}
import { coerceNumber, pickFirstDefined } from "./utils.mjs";
