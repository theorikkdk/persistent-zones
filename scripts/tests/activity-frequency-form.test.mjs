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
const { normalizePersistentZoneActivitySubmitData } = await import("../activity/persistent-zone-activity-sheet.mjs");

test("frequency fields belong to every trigger schema and not to statuses", () => {
  const schema = PersistentZoneActivityData.defineSchema();
  const onCreate = schema.persistentZone.fields.triggers.fields.onCreate;
  assert.deepEqual(onCreate.fields.frequency.options.choices, ["unlimited", "once-per-turn"]);
  assert.equal(onCreate.fields.frequency.options.initial, "unlimited");
  assert.equal(onCreate.fields.frequencyGroup.options.initial, "");
  assert.equal(Object.hasOwn(onCreate.fields.simpleEffect.fields.statuses.fields, "frequency"), false);
});

test("expanded mono and multipart form fields survive custom PZ processing", () => {
  const flat = {
    "persistentZone.schemaVersion": 3,
    "persistentZone.enabled": true,
    "persistentZone.geometry.type": "circle",
    "persistentZone.geometry.radius": 10,
    "persistentZone.triggers.onCreate.frequency": "once-per-turn",
    "persistentZone.triggers.onCreate.frequencyGroup": "mono-test",
    "persistentZone.triggers.enter.frequency": "once-per-turn",
    "persistentZone.triggers.enter.frequencyGroup": "mono-test",
    "persistentZone.parts.0.id": "primary",
    "persistentZone.parts.0.geometry.type": "template",
    "persistentZone.parts.0.triggers.onCreate.frequency": "once-per-turn",
    "persistentZone.parts.0.triggers.onCreate.frequencyGroup": "part-test",
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
  assert.equal(processed.triggers.enter.frequency, "once-per-turn");
  assert.equal(processed.parts[0].triggers.onCreate.frequency, "once-per-turn");
  assert.equal(processed.parts[1].triggers.onCreate.frequencyGroup, "part-test");
});

function setProperty(object, path, value) {
  const keys = path.split(".");
  let current = object;
  for (const key of keys.slice(0, -1)) current = current[key] ??= {};
  current[keys.at(-1)] = value;
  return true;
}
