import assert from "node:assert/strict";
import fs from "node:fs";
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
globalThis.CONFIG = {
  DND5E: {
    abilities: { dex: { abbreviation: "DEX" } },
    damageTypes: { fire: { label: "Fire" }, radiant: { label: "Radiant" } }
  },
  statusEffects: [{ id: "restrained", name: "Restrained" }]
};
globalThis.dnd5e = {
  dataModels: { activity: { BaseActivityData: class { static defineSchema() { return {}; } } } },
  applications: { activity: { ActivitySheet: class { static PARTS = {}; } } }
};

const { PersistentZoneActivityData } = await import("../activity/persistent-zone-activity-data.mjs");
const { getPersistentZonePreset } = await import("../presets/preset-library.mjs");
const {
  PersistentZoneActivitySheet,
  applyExplicitPersistentZoneCheckboxStates,
  buildMultipartTriggerSummary,
  captureTriggerOpenState,
  mergePersistentZoneActivitySubmitData,
  normalizePersistentZoneActivitySubmitData,
  restoreTriggerOpenState
} = await import("../activity/persistent-zone-activity-sheet.mjs");

test("frequency fields belong to every trigger schema and not to statuses", () => {
  const schema = PersistentZoneActivityData.defineSchema();
  const onCreate = schema.persistentZone.fields.triggers.fields.onCreate;
  assert.deepEqual(onCreate.fields.frequency.options.choices, ["unlimited", "once-per-turn"]);
  assert.equal(onCreate.fields.frequency.options.initial, "unlimited");
  assert.equal(onCreate.fields.frequencyGroup.options.initial, "");
  assert.deepEqual(onCreate.fields.targetFilter.fields.mode.options.choices, ["all", "allies", "enemies", "self", "others"]);
  assert.equal(onCreate.fields.targetFilter.fields.mode.options.initial, "all");
  assert.deepEqual(onCreate.fields.targeting.fields.mode.options.choices, ["membership", "physical-contact", "proximity"]);
  assert.equal(onCreate.fields.targeting.fields.mode.options.initial, "membership");
  const terrain = schema.persistentZone.fields.terrain.fields;
  assert.deepEqual(terrain.targetFilter.fields.mode.options.choices, ["all", "allies", "enemies", "self", "others"]);
  assert.equal(terrain.targetFilter.fields.mode.options.initial, "all");
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
  const elevation = schema.persistentZone.fields.elevation.fields;
  assert.equal(elevation.enabled.options.initial, false);
  assert.notEqual(elevation.enabled.options.nullable, true, "the UI toggle must never submit an invalid null Boolean");
  assert.deepEqual(elevation.units.options.choices, ["scene", "ft", "m"]);
});

test("mono elevation toggles round-trip between bounded and absent configuration", () => {
  const enabled = normalizePersistentZoneActivitySubmitData({
    enabled: true,
    geometry: { type: "circle", radius: 10 },
    elevation: { enabled: true, bottom: 0, top: 10, topInclusive: true, units: "ft" }
  });
  assert.deepEqual(enabled.elevation, {
    enabled: true, bottom: 0, top: 10, topInclusive: true, units: "ft"
  });
  const disabled = normalizePersistentZoneActivitySubmitData(
    mergePersistentZoneActivitySubmitData(enabled, { elevation: { enabled: false } })
  );
  assert.deepEqual(disabled.elevation, {
    enabled: false, bottom: 0, top: 10, topInclusive: true, units: "ft"
  });
});

test("mono ON to OFF preserves bounds through rerender and reactivation", () => {
  let source = {
    persistentZone: normalizePersistentZoneActivitySubmitData({
      enabled: true,
      geometry: { type: "circle", radius: 10 },
      elevation: { enabled: true, bottom: 0, top: 10, topInclusive: false, units: "ft" }
    })
  };
  source.persistentZone = normalizePersistentZoneActivitySubmitData(
    mergePersistentZoneActivitySubmitData(source.persistentZone, { elevation: { enabled: false } })
  );
  const rerendered = normalizePersistentZoneActivitySubmitData(source.persistentZone);
  assert.deepEqual(rerendered.elevation, {
    enabled: false, bottom: 0, top: 10, topInclusive: false, units: "ft"
  }, "closed and reopened Activity remains unlimited while retaining its last bounds");
  const reactivated = normalizePersistentZoneActivitySubmitData(mergePersistentZoneActivitySubmitData(rerendered, {
    elevation: { enabled: true }
  }));
  assert.deepEqual(reactivated.elevation, {
    enabled: true, bottom: 0, top: 10, topInclusive: false, units: "ft"
  });
});

test("real partial FormData patches preserve geometry and elevation across successive submits", () => {
  let state = normalizePersistentZoneActivitySubmitData({
    enabled: true,
    geometry: { type: "circle", radius: 10, units: "ft" },
    elevation: { enabled: true, bottom: 0, top: 10, topInclusive: true, units: "ft" }
  });
  const submit = (flat) => {
    const expanded = {};
    for (const [path, value] of Object.entries(flat)) setProperty(expanded, path, value);
    state = normalizePersistentZoneActivitySubmitData(
      mergePersistentZoneActivitySubmitData(state, expanded.persistentZone ?? {})
    );
  };
  submit({ "persistentZone.geometry.radius": 15 });
  assert.equal(state.geometry.radius, 15);
  assert.equal(state.elevation.top, 10);
  submit({ "persistentZone.elevation.bottom": 1 });
  assert.equal(state.geometry.radius, 15);
  assert.equal(state.elevation.bottom, 1);
  submit({ "persistentZone.elevation.top": 20 });
  assert.equal(state.geometry.radius, 15);
  assert.equal(state.elevation.top, 20);
  submit({ "persistentZone.elevation.topInclusive": false });
  assert.equal(state.geometry.radius, 15);
  assert.equal(state.elevation.topInclusive, false);
  submit({ "persistentZone.elevation.enabled": false });
  assert.equal(state.geometry.radius, 15);
  assert.equal(state.elevation.enabled, false);
  assert.equal(state.elevation.top, 20);
  submit({
    "persistentZone.elevation.enabled": true,
  });
  assert.equal(state.geometry.radius, 15);
  assert.deepEqual(state.elevation, {
    enabled: true, bottom: 1, top: 20, topInclusive: false, units: "ft"
  });
});

test("Activity template contains one static control per scalar Persistent Zone path", () => {
  const template = fs.readFileSync(new URL("../../templates/persistent-zone-activity-tab.hbs", import.meta.url), "utf8");
  const names = Array.from(template.matchAll(/name="(persistentZone\.[^"]+)"/g), match => match[1]);
  const duplicates = Array.from(new Set(names.filter((name, index) => names.indexOf(name) !== index)));
  assert.deepEqual(duplicates, [], `duplicate scalar field names: ${duplicates.join(", ")}`);
  assert.equal(names.filter((name) => name === "persistentZone.geometry.radius").length, 1);
  assert.ok(names.includes("persistentZone.triggers.{{triggerRow.timing}}.targeting.mode"));
  assert.ok(names.includes("persistentZone.triggers.{{triggerRow.timing}}.targeting.distance"));
  assert.ok(names.includes("persistentZone.controlledMovement.enabled"));
  assert.ok(names.includes("persistentZone.controlledMovement.maxDistance"));
  assert.ok(names.includes("persistentZone.controlledMovement.physicalRadius"));
  for (const binding of [
    "persistentZone.triggers.{{triggerRow.timing}}.simpleEffect.damage.enabled",
    "persistentZone.triggers.{{triggerRow.timing}}.simpleEffect.damage.formula",
    "persistentZone.triggers.{{triggerRow.timing}}.simpleEffect.save.enabled",
    "persistentZone.triggers.{{triggerRow.timing}}.simpleEffect.statuses.enabled"
  ]) assert.ok(names.includes(binding), `retains effect binding ${binding}`);
  assert.match(template, /data-pz-ensure-controlled-movement/);
  assert.match(template, /persistentZoneControlledMovement\.linkedActivityDisplay/);
  assert.doesNotMatch(template, /value="\{\{persistentZoneControlledMovement\.activationActivityId\}\}"/);
  assert.match(template, /<details class="persistent-zone-activity__trigger"/);
  assert.match(template, /persistent-zone-activity__trigger-effects/);
});

test("trigger disclosure state survives a rerender without writing Activity data", () => {
  const triggers = [
    { dataset: { pzTrigger: "enter" }, open: true },
    { dataset: { pzTrigger: "move" }, open: false },
    { dataset: { pzTrigger: "turnEnd" }, open: true }
  ];
  const root = { querySelectorAll: () => triggers };
  const open = captureTriggerOpenState(root);
  assert.deepEqual([...open], ["enter", "turnEnd"]);

  triggers.forEach((trigger) => { trigger.open = false; });
  restoreTriggerOpenState(root, open);
  assert.deepEqual(triggers.map((trigger) => [trigger.dataset.pzTrigger, trigger.open]), [
    ["enter", true], ["move", false], ["turnEnd", true]
  ]);

  // A newly enabled trigger remains open through the same purely UI-state path.
  open.add("move");
  restoreTriggerOpenState(root, open);
  assert.equal(triggers[1].open, true);
});

test("Difficult Terrain and trigger summary copy is localized in EN and FR", () => {
  const en = JSON.parse(fs.readFileSync(new URL("../../lang/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(fs.readFileSync(new URL("../../lang/fr.json", import.meta.url), "utf8"));
  assert.equal(en.PERSISTENT_ZONES.Activity.Fields.DifficultTerrain, "Difficult Terrain");
  assert.equal(fr.PERSISTENT_ZONES.Activity.Fields.DifficultTerrain, "Terrain difficile");
  assert.equal(en.PERSISTENT_ZONES.Activity.TriggerSummary.None, "None");
  assert.equal(fr.PERSISTENT_ZONES.Activity.TriggerSummary.None, "Aucun");
  assert.equal(en.PERSISTENT_ZONES.Activity.Fields.TriggerTargeting, "Creature Detection");
  assert.equal(fr.PERSISTENT_ZONES.Activity.Fields.TriggerTargeting, "Détection des créatures");
  assert.equal(en.PERSISTENT_ZONES.Activity.TriggerTargeting.PhysicalContact, "Touched by the Moving Zone");
  assert.equal(fr.PERSISTENT_ZONES.Activity.TriggerTargeting.Proximity, "À proximité de la zone");
  assert.equal(en.PERSISTENT_ZONES.Activity.Fields.ControlledMovementPhysicalRadius, "Collision Radius");
  assert.equal(fr.PERSISTENT_ZONES.Activity.Fields.ControlledMovementPhysicalRadius, "Rayon de collision");
  assert.equal(en.PERSISTENT_ZONES.Activity.Help.TriggerTargetingPhysicalContact, "Detects the first creature touched by the zone's physical body while it moves.");
  assert.equal(fr.PERSISTENT_ZONES.Activity.Help.TriggerTargetingProximity, "Détecte les créatures dont le bord se trouve à la distance indiquée du bord de la zone.");
});

test("Controlled Movement displays a linked Activity name, never its technical identifier", () => {
  const previousI18n = game.i18n;
  game.i18n = {
    localize: (key) => key === "PERSISTENT_ZONES.Activity.ControlledMovement.NoLinkedActivity"
      ? "No linked movement activity"
      : key,
    format: (key, data) => key === "PERSISTENT_ZONES.Activity.ControlledMovement.LinkedActivityDisplay"
      ? `Linked Activity: ${data.activity}`
      : key
  };
  try {
    const moveActivity = { id: "Prgef05AhjovJWc", name: "Move the Zone" };
    const sheet = new PersistentZoneActivitySheet();
    sheet.activity = {
      id: "pz-activity",
      item: { system: { activities: new Map([[moveActivity.id, moveActivity]]) } },
      _source: {
        persistentZone: {
          geometry: { type: "circle", radius: 3, units: "m" },
          controlledMovement: { enabled: true, activationActivityId: moveActivity.id, units: "m" }
        }
      }
    };
    const linked = sheet._preparePersistentZoneContext({ tabs: { persistentZone: {} } }).persistentZoneControlledMovement;
    assert.equal(linked.linkedActivityName, "Move the Zone");
    assert.equal(linked.linkedActivityDisplay, "Linked Activity: Move the Zone");

    sheet.activity._source.persistentZone.controlledMovement.activationActivityId = null;
    const unlinked = sheet._preparePersistentZoneContext({ tabs: { persistentZone: {} } }).persistentZoneControlledMovement;
    assert.equal(unlinked.linkedActivityDisplay, "No linked movement activity");
  } finally {
    game.i18n = previousI18n;
  }
});

test("trigger targeting and controlled movement round-trip without changing legacy membership", () => {
  const legacy = normalizePersistentZoneActivitySubmitData({
    enabled: true,
    geometry: { type: "circle", radius: 3, units: "m" },
    triggers: { move: { enabled: true, mode: "simple-effect" } }
  });
  assert.deepEqual(legacy.triggers.move.targeting, { mode: "membership", distance: null });
  assert.deepEqual(legacy.controlledMovement, {
    enabled: false, activationActivityId: null, utilityName: null, maxDistance: 0, physicalRadius: 0, units: "scene"
  });

  const configured = normalizePersistentZoneActivitySubmitData(mergePersistentZoneActivitySubmitData(legacy, {
    controlledMovement: { enabled: true, maxDistance: 9, physicalRadius: 0.75, units: "m", activationActivityId: "move-utility" },
    triggers: {
      move: { targeting: { mode: "physical-contact" } },
      turnEnd: { targeting: { mode: "proximity", distance: 1.5 } }
    }
  }));
  assert.deepEqual(configured.triggers.move.targeting, { mode: "physical-contact", distance: null });
  assert.deepEqual(configured.triggers.turnEnd.targeting, { mode: "proximity", distance: 1.5 });
  assert.deepEqual(configured.controlledMovement, {
    enabled: true, activationActivityId: "move-utility", utilityName: null, maxDistance: 9, physicalRadius: 0.75, units: "m"
  });
});

test("a freshly persisted controlled-movement preset exposes physical contact in the Move trigger", () => {
  const persisted = {
    enabled: true,
    geometry: { type: "circle", radius: 3, units: "m" },
    controlledMovement: { enabled: true, maxDistance: 9, physicalRadius: 0.75, units: "m" },
    triggers: { move: { enabled: true, mode: "simple-effect" } }
  };
  // This reproduces the post-preset render: the in-memory Activity proxy may
  // still contain its former definition while _source has the saved update.
  const sheet = new PersistentZoneActivitySheet();
  sheet.activity = {
    persistentZone: { enabled: true, geometry: { type: "circle", radius: 3, units: "m" }, triggers: persisted.triggers },
    _source: { persistentZone: persisted }
  };
  const context = sheet._preparePersistentZoneContext({ tabs: { persistentZone: {} } });
  const move = context.persistentZoneTriggerRows.find((row) => row.timing === "move");
  const physical = move.targetingOptions.find((option) => option.value === "physical-contact");
  assert.equal(context.persistentZoneControlledMovement.enabled, true);
  assert.ok(physical, "Move targeting includes Physical Contact when Controlled Movement is enabled");
  assert.equal(physical.unavailable, false);
});

test("Flaming Sphere survives the Activity UI normalization without losing controlled targeting", () => {
  const source = structuredClone(getPersistentZonePreset("srd-5.2.1.flaming-sphere").persistentZone);
  source.controlledMovement.activationActivityId = "move-sphere";
  const saved = normalizePersistentZoneActivitySubmitData(source);
  assert.deepEqual(saved.controlledMovement, {
    enabled: true,
    activationActivityId: "move-sphere",
    utilityName: "PERSISTENT_ZONES.Activity.Presets.Builtins.FlamingSphere.MoveActivityName",
    maxDistance: 30,
    physicalRadius: 2.5,
    units: "ft"
  });
  assert.deepEqual(saved.triggers.move.targeting, { mode: "physical-contact", distance: null });
  assert.deepEqual(saved.triggers.turnEnd.targeting, { mode: "proximity", distance: 5 });
});

test("realistic radius 3 to 6 then elevation edit never creates an array", () => {
  let state = normalizePersistentZoneActivitySubmitData({
    enabled: true,
    geometry: { type: "circle", radius: 3, units: "m" }
  });
  state = normalizePersistentZoneActivitySubmitData(mergePersistentZoneActivitySubmitData(state, {
    geometry: { radius: 6 }
  }));
  state = normalizePersistentZoneActivitySubmitData(mergePersistentZoneActivitySubmitData(state, {
    elevation: { enabled: true, bottom: 0, top: 3, topInclusive: false, units: "m" }
  }));
  assert.equal(state.geometry.radius, 6);
  assert.equal(Array.isArray(state.geometry.radius), false);
});

test("unchecked FormData checkboxes become explicit false values", () => {
  const checkboxes = [
    { name: "persistentZone.elevation.enabled", checked: false },
    { name: "persistentZone.elevation.topInclusive", checked: true }
  ];
  const submitData = { persistentZone: { geometry: { radius: 10 } } };
  applyExplicitPersistentZoneCheckboxStates(submitData, {
    querySelectorAll: () => checkboxes
  });
  assert.equal(submitData.persistentZone.elevation.enabled, false);
  assert.equal(submitData.persistentZone.elevation.topInclusive, true);
  assert.equal(submitData.persistentZone.geometry.radius, 10);
});

test("generic partial merge preserves inactive native cone and ray dimensions", () => {
  for (const geometry of [
    { type: "cone", distance: 15, angle: 53.13, direction: 45 },
    { type: "ray", distance: 30, width: 5, direction: 90 }
  ]) {
    const merged = mergePersistentZoneActivitySubmitData({ geometry, elevation: { enabled: true, top: 10 } }, {
      elevation: { topInclusive: true }
    });
    assert.deepEqual(merged.geometry, geometry);
  }
});

test("elevation submit handling preserves every supported geometry dimension", () => {
  const geometries = [
    { type: "circle", radius: 17, units: "ft" },
    { type: "emanation", radius: 12, units: "ft" },
    { type: "rectangle", width: 20, height: 15, units: "ft" },
    { type: "ring", ringReferenceRadius: 25, ringInnerWidth: 4, ringOuterWidth: 6, units: "ft" },
    { type: "wall", wallLength: 60, wallThickness: 2, units: "ft" }
  ];
  for (const geometry of geometries) {
    const placement = geometry.type === "emanation" ? { mode: "attached-source" } : { mode: "fixed" };
    const bounded = normalizePersistentZoneActivitySubmitData({
      enabled: true,
      geometry,
      placement,
      elevation: { enabled: true, bottom: 0, top: 10, units: "ft" }
    });
    assert.deepEqual(bounded.geometry, { ...geometry, placement: "center" });
    const edited = normalizePersistentZoneActivitySubmitData(
      mergePersistentZoneActivitySubmitData(bounded, { geometry: { ...geometry }, placement, elevation: { enabled: false } })
    );
    assert.deepEqual(edited.geometry, { ...geometry, placement: "center" });
  }
});

test("multipart trigger summaries list active localized rows or None", () => {
  assert.deepEqual(buildMultipartTriggerSummary([
    { label: "Entry", state: { enabled: true } },
    { label: "End of Turn", state: { enabled: true } },
    { label: "Exit", state: { enabled: false } }
  ]), ["Entry", "End of Turn"]);
  assert.deepEqual(buildMultipartTriggerSummary([]), ["PERSISTENT_ZONES.Activity.TriggerSummary.None"]);
  const translations = {
    "PERSISTENT_ZONES.Activity.TriggerSummary.Damage": "{formula} {type} damage",
    "PERSISTENT_ZONES.Activity.TriggerSummary.TemporaryHitPoints": "{formula} temporary HP",
    "PERSISTENT_ZONES.Activity.TriggerSummary.Save": "{ability} save {outcome}",
    "PERSISTENT_ZONES.Activity.TriggerSummary.Half": "half"
  };
  game.i18n = {
    localize: (key) => translations[key] ?? key,
    format: (key, data) => Object.entries(data).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      translations[key] ?? key
    )
  };
  assert.deepEqual(buildMultipartTriggerSummary([{
    label: "Entry",
    state: {
      enabled: true,
      simpleEffect: {
        damage: [
          { enabled: true, formula: "2d6", type: "fire" },
          { enabled: true, formula: "1d6", type: "radiant" }
        ],
        temporaryHitPoints: { enabled: true, formula: "1d6" },
        save: { enabled: true, ability: "dex", onSave: "half" },
        statuses: { enabled: true, statusId: "restrained" }
      }
    }
  }]), [
    "Entry • 2d6 Fire damage • 1d6 Radiant damage • 1d6 temporary HP • DEX save half • Restrained"
  ]);
  delete game.i18n;
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
  assert.deepEqual(processed.terrain, { ...existing.terrain, targetFilter: { mode: "all" } });
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
