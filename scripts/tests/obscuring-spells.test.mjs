import assert from "node:assert/strict";
import test from "node:test";
import { getPersistentZonePreset } from "../presets/preset-library.mjs";

globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.game = { user: { isGM: true, character: null }, i18n: { localize: (key) => key } };
globalThis.canvas = { scene: { grid: { units: "m" } }, tokens: { controlled: [] } };
globalThis.CONFIG = { RegionBehavior: { dataModels: {} } };

const { createObscuringSpellsTestItems } = await import("../runtime/debug-tools.mjs");

test("Fog Cloud, Sleet Storm, and Stinking Cloud use the shared 2D primitives", () => {
  const fog = getPersistentZonePreset("srd-5.2.1.fog-cloud");
  const sleet = getPersistentZonePreset("srd-5.2.1.sleet-storm");
  const stink = getPersistentZonePreset("srd-5.2.1.stinking-cloud");
  for (const preset of [fog, sleet, stink]) {
    assert.equal(preset.persistentZone.geometry.type, "circle");
    assert.deepEqual(preset.persistentZone.obstacles, { mode: "wall-restricted", restrictionType: "move", priority: 0 });
    assert.equal(preset.persistentZone.obscuration.mode, "heavily-obscured");
  }
  assert.equal(sleet.persistentZone.terrain.multiplier, 2);
  assert.equal(sleet.persistentZone.triggers.enter.frequencyGroup, sleet.persistentZone.triggers.turnStart.frequencyGroup);
  assert.equal(sleet.persistentZone.triggers.enter.simpleEffect.endConcentration.enabled, true);
  const status = stink.persistentZone.triggers.turnStart.simpleEffect.statuses;
  assert.equal(status.statusId, "poisoned");
  assert.equal(status.persistenceMode, "until-end-of-current-turn");
  assert.deepEqual(status.actionRestrictions, { action: true, bonusAction: true });
});

test("obscuring Debug/Test helper uses D&D5e Item#createActivity and stores metric-ready Activities", async () => {
  const deleted = [];
  const createdItems = [];
  const owner = {
    async createEmbeddedDocuments(type, sources) {
      assert.equal(type, "Item");
      return sources.map((source, index) => {
        const item = {
          id: `item-${index}`,
          uuid: `Actor.caster.Item.${index}`,
          source,
          system: { activities: new Map() },
          async createActivity(type, activity, options) {
            assert.equal(type, "persistent-zone");
            assert.equal(options.renderSheet, false);
            const id = `activity-${this.system.activities.size}`;
            this.system.activities.set(id, { id, ...activity });
          }
        };
        createdItems.push(item);
        return item;
      });
    },
    async deleteEmbeddedDocuments(type, ids) { deleted.push({ type, ids }); }
  };
  const result = await createObscuringSpellsTestItems({ actor: owner });
  assert.equal(result.ok, true);
  assert.equal(deleted.length, 0);
  assert.deepEqual(createdItems.map((item) => item.source.system.range), [
    { value: 36, units: "m" }, { value: 45, units: "m" }, { value: 27, units: "m" }
  ]);
  const activities = createdItems.map((item) => Array.from(item.system.activities.values())[0]);
  assert.deepEqual(activities.map((activity) => activity.persistentZone.geometry.radius), [6, 6, 6]);
  assert.deepEqual(activities.map((activity) => activity.target.template.size), [6, 6, 6]);
  assert.deepEqual(activities[0].persistentZone.geometry.scaling.radiusPerLevel, 6);
});

test("obscuring Debug/Test helper removes every created Item when Activity creation fails", async () => {
  const deleted = [];
  const owner = {
    async createEmbeddedDocuments() {
      return [0, 1, 2].map((index) => ({
        id: `item-${index}`,
        system: { activities: new Map() },
        async createActivity() {
          if (index === 1) throw new Error("simulated Activity failure");
          this.system.activities.set("activity", { id: "activity" });
        }
      }));
    },
    async deleteEmbeddedDocuments(type, ids) { deleted.push({ type, ids }); }
  };
  const result = await createObscuringSpellsTestItems({ actor: owner });
  assert.equal(result.ok, false);
  assert.equal(result.cause, "simulated Activity failure");
  assert.deepEqual(deleted, [{ type: "Item", ids: ["item-0", "item-1", "item-2"] }]);
});
