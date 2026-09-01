import assert from "node:assert/strict";
import test from "node:test";

class Field {
  constructor(options = {}) { this.options = options; }
}
class SchemaField extends Field {
  constructor(fields, options = {}) { super(options); this.fields = fields; }
}
class ArrayField extends Field {
  constructor(element, options = {}) { super(options); this.element = element; }
}

globalThis.foundry = {
  data: { fields: { SchemaField, ArrayField, ObjectField: Field, StringField: Field, NumberField: Field, BooleanField: Field } },
  utils: {
    deepClone: (value) => structuredClone(value),
    getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
    setProperty: setProperty
  }
};
globalThis.game = { settings: { settings: new Map() } };
globalThis.canvas = { scene: null };
globalThis.dnd5e = {
  dataModels: { activity: { BaseActivityData: class { static defineSchema() { return {}; } } } },
  applications: { activity: { ActivitySheet: class { static PARTS = {}; } } }
};

const { PersistentZoneActivityData } = await import("../activity/persistent-zone-activity-data.mjs");
const {
  mergePersistentZoneActivitySubmitData,
  normalizePersistentZoneActivitySubmitData
} = await import("../activity/persistent-zone-activity-sheet.mjs");

test("frequency fields belong to every trigger schema and not to statuses", () => {
  const schema = PersistentZoneActivityData.defineSchema();
  const onCreate = schema.persistentZone.fields.triggers.fields.onCreate;
  assert.deepEqual(onCreate.fields.frequency.options.choices, ["unlimited", "once-per-turn"]);
  assert.equal(onCreate.fields.frequency.options.initial, "unlimited");
  assert.equal(onCreate.fields.frequencyGroup.options.initial, "");
  assert.deepEqual(onCreate.fields.targetFilter.fields.mode.options.choices, ["all", "allies", "enemies", "self", "others"]);
  assert.equal(onCreate.fields.targetFilter.fields.mode.options.initial, "all");
  assert.equal(Object.hasOwn(onCreate.fields.simpleEffect.fields.statuses.fields, "frequency"), false);
  const escape = onCreate.fields.simpleEffect.fields.statuses.fields.escape.fields;
  assert.deepEqual(escape.checkType.options.choices, ["ability", "skill"]);
  assert.equal(escape.checkType.options.initial, "ability");
  assert.equal(escape.skill.options.initial, "ath");
  const geometry = schema.persistentZone.fields.geometry.fields;
  assert.equal(geometry.width.options.initial, 10);
  assert.equal(geometry.height.options.initial, 10);
  assert.deepEqual(geometry.units.options.choices, ["scene", "ft", "m"]);
  assert.deepEqual(geometry.placement.options.choices, ["center"]);
});

test("expanded mono and multipart form fields survive custom PZ processing", () => {
  const flat = {
    "persistentZone.schemaVersion": 3,
    "persistentZone.enabled": true,
    "persistentZone.geometry.type": "circle",
    "persistentZone.geometry.radius": 10,
    "persistentZone.triggers.onCreate.frequency": "once-per-turn",
    "persistentZone.triggers.onCreate.frequencyGroup": "mono-test",
    "persistentZone.triggers.onCreate.targetFilter.mode": "enemies",
    "persistentZone.triggers.onCreate.simpleEffect.statuses.escape.enabled": true,
    "persistentZone.triggers.onCreate.simpleEffect.statuses.escape.checkType": "skill",
    "persistentZone.triggers.onCreate.simpleEffect.statuses.escape.skill": "ath",
    "persistentZone.triggers.enter.frequency": "once-per-turn",
    "persistentZone.triggers.enter.frequencyGroup": "mono-test",
    "persistentZone.parts.0.id": "primary",
    "persistentZone.parts.0.geometry.type": "template",
    "persistentZone.parts.0.triggers.onCreate.frequency": "once-per-turn",
    "persistentZone.parts.0.triggers.onCreate.frequencyGroup": "part-test",
    "persistentZone.parts.0.triggers.onCreate.targetFilter.mode": "allies",
    "persistentZone.parts.0.triggers.onCreate.simpleEffect.statuses.escape.enabled": true,
    "persistentZone.parts.0.triggers.onCreate.simpleEffect.statuses.escape.checkType": "skill",
    "persistentZone.parts.0.triggers.onCreate.simpleEffect.statuses.escape.skill": "ste",
    "persistentZone.parts.1.id": "secondary",
    "persistentZone.parts.1.geometry.type": "template",
    "persistentZone.parts.1.triggers.onCreate.frequency": "once-per-turn",
    "persistentZone.parts.1.triggers.onCreate.frequencyGroup": "part-test"
  };
  const expanded = {};
  for (const [path, value] of Object.entries(flat)) setProperty(expanded, path, value);
  expanded.persistentZone.parts = Object.values(expanded.persistentZone.parts);
  const processed = normalizePersistentZoneActivitySubmitData(expanded.persistentZone);
  assert.equal(processed.triggers.onCreate.frequency, "once-per-turn");
  assert.equal(processed.triggers.onCreate.frequencyGroup, "mono-test");
  assert.equal(processed.triggers.onCreate.targetFilter.mode, "enemies");
  assert.equal(processed.triggers.onCreate.simpleEffect.statuses.escape.checkType, "skill");
  assert.equal(processed.triggers.onCreate.simpleEffect.statuses.escape.skill, "ath");
  assert.equal(processed.triggers.enter.frequency, "once-per-turn");
  assert.equal(processed.parts[0].triggers.onCreate.frequency, "once-per-turn");
  assert.equal(processed.parts[0].triggers.onCreate.targetFilter.mode, "allies");
  assert.equal(processed.parts[0].triggers.onCreate.simpleEffect.statuses.escape.skill, "ste");
  assert.equal(processed.parts[1].triggers.onCreate.frequencyGroup, "part-test");
});

test("an unrelated manual DC edit preserves hidden Rectangle and trigger configuration", () => {
  const existing = {
    schemaVersion: 3,
    enabled: true,
    geometry: { type: "rectangle", width: 20, height: 10, units: "ft", placement: "center" },
    triggers: {
      onCreate: {
        enabled: true,
        mode: "simple-effect",
        frequency: "once-per-turn",
        frequencyGroup: "grease-shared",
        requiredAbsentStatuses: ["prone"],
        simpleEffect: {
          save: { enabled: true, ability: "dex", dcMode: "inherit", dc: 13, onSave: "none" },
          statuses: { enabled: true, statusId: "prone", recovery: { mode: "none", hiddenProviderData: "keep" } }
        }
      },
      turnEnd: { enabled: true, mode: "simple-effect", frequencyGroup: "grease-shared", hiddenTriggerData: "keep" }
    },
    parts: [{ id: "primary", geometry: { type: "template", hiddenOffset: 2 }, hiddenPartData: "keep" }],
    terrain: { enabled: true, multiplier: 2 },
    linkedWalls: { enabled: false, hiddenWallData: "keep" },
    linkedLights: { enabled: false, hiddenLightData: "keep" },
    lifecycle: { deleteOnConcentrationEnd: true, hiddenLifecycleData: "keep" }
  };
  const submitted = {
    triggers: { onCreate: { simpleEffect: { save: { dcMode: "manual", dc: 13 } } } }
  };

  const processed = normalizePersistentZoneActivitySubmitData(
    mergePersistentZoneActivitySubmitData(existing, submitted)
  );

  assert.deepEqual(processed.geometry, existing.geometry);
  assert.deepEqual(processed.triggers.onCreate.requiredAbsentStatuses, ["prone"]);
  assert.equal(processed.triggers.onCreate.simpleEffect.save.dcMode, "manual");
  assert.equal(processed.triggers.onCreate.simpleEffect.save.dc, 13);
  assert.equal(processed.triggers.onCreate.simpleEffect.statuses.recovery.hiddenProviderData, "keep");
  assert.equal(processed.triggers.turnEnd.hiddenTriggerData, "keep");
  assert.equal(processed.parts[0].geometry.hiddenOffset, 2);
  assert.equal(processed.parts[0].hiddenPartData, "keep");
  assert.deepEqual(processed.terrain, existing.terrain);
  assert.equal(processed.linkedWalls.hiddenWallData, "keep");
  assert.equal(processed.linkedLights.hiddenLightData, "keep");
  assert.equal(processed.lifecycle.hiddenLifecycleData, "keep");
});

test("Rectangle dimensions remain editable across an unrelated second submit", () => {
  const first = normalizePersistentZoneActivitySubmitData(mergePersistentZoneActivitySubmitData({
    geometry: { type: "rectangle", width: 10, height: 10, units: "ft", placement: "center" }
  }, {
    geometry: { width: 20, height: 10, units: "ft" }
  }));
  const second = normalizePersistentZoneActivitySubmitData(mergePersistentZoneActivitySubmitData(first, {
    triggers: { onCreate: { simpleEffect: { save: { dcMode: "manual", dc: 13 } } } }
  }));
  assert.deepEqual(first.geometry, { type: "rectangle", width: 20, height: 10, units: "ft", placement: "center" });
  assert.deepEqual(second.geometry, first.geometry);
});

function setProperty(object, path, value) {
  const keys = path.split(".");
  let current = object;
  for (const key of keys.slice(0, -1)) current = current[key] ??= {};
  current[keys.at(-1)] = value;
  return true;
}
