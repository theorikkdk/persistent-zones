import assert from "node:assert/strict";
import test from "node:test";

const translations = {
  "PERSISTENT_ZONES.RollContext.Title": "{source} — {roll} — {reason}",
  "PERSISTENT_ZONES.RollContext.SourceFallback": "Zone persistante",
  "PERSISTENT_ZONES.RollContext.SavingThrow": "JDS de {ability}",
  "PERSISTENT_ZONES.RollContext.AbilityCheck": "Test de {ability}",
  "PERSISTENT_ZONES.RollContext.SkillCheck": "Test de compétence : {skill}",
  "PERSISTENT_ZONES.RollContext.Reasons.Enter": "Entrée dans la zone",
  "PERSISTENT_ZONES.RollContext.Reasons.TurnEnd": "Fin du tour",
  "PERSISTENT_ZONES.RollContext.Reasons.Escape": "Action pour se libérer",
  "DND5E.AbilityDex": "Dextérité",
  "DND5E.AbilityStr": "Force",
  "DND5E.SkillAth": "Athlétisme"
};

globalThis.CONFIG = {
  DND5E: {
    abilities: { dex: { label: "DND5E.AbilityDex" }, str: { label: "DND5E.AbilityStr" } },
    skills: { ath: { label: "DND5E.SkillAth" } }
  }
};
globalThis.game = {
  i18n: {
    localize: (key) => translations[key] ?? key,
    format: (key, data) => (translations[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) => data[name] ?? "")
  }
};

const {
  buildPersistentZoneRollContext,
  buildPersistentZoneRollProcessConfig,
  getPersistentZoneRollResolverContext
} = await import("../runtime/roll-context.mjs");

test("save context localizes the source, ability, and trigger reason", () => {
  const context = buildPersistentZoneRollContext({ sourceName: "Graisse", rollType: "save", ability: "dex", timing: "onEnter" });
  assert.equal(context.title, "Graisse — JDS de Dextérité — Entrée dans la zone");
  assert.equal(context.flavor, context.title);
});

test("ability and skill escape contexts remain generic", () => {
  assert.equal(
    buildPersistentZoneRollContext({ sourceName: "Enchevêtrement", rollType: "ability", ability: "str", timing: "escape" }).title,
    "Enchevêtrement — Test de Force — Action pour se libérer"
  );
  assert.equal(
    buildPersistentZoneRollContext({ sourceName: "Tentacules noirs", rollType: "skill", skill: "ath", timing: "escape" }).title,
    "Tentacules noirs — Test de compétence : Athlétisme — Action pour se libérer"
  );
});

test("turn aliases resolve to the expected localized reason", () => {
  assert.equal(
    buildPersistentZoneRollContext({ sourceName: "Graisse", rollType: "save", ability: "dex", timing: "turnEnd" }).title,
    "Graisse — JDS de Dextérité — Fin du tour"
  );
});

test("only PZ D20Roll options expose context to the native Roll Resolver", () => {
  const context = buildPersistentZoneRollContext({ sourceName: "Graisse", rollType: "save", ability: "dex", timing: "onEnter" });
  const config = buildPersistentZoneRollProcessConfig(context);
  assert.equal(
    getPersistentZoneRollResolverContext({ roll: { options: config.rolls[0].options } }),
    "Graisse — JDS de Dextérité — Entrée dans la zone"
  );
  assert.equal(getPersistentZoneRollResolverContext({ roll: { options: {} } }), null, "ordinary D&D5e rolls must remain untouched");
});
