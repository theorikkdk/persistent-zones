import { ACTIVITY_DEFINITION_SCHEMA_VERSION } from "../constants.mjs";
import { PRESET_SCHEMA_VERSION } from "./preset-utils.mjs";

const buildDisabledTrigger = () => ({
  enabled: false,
  mode: "none",
  targetFilter: { mode: "all" },
  frequency: "unlimited",
  frequencyGroup: "",
  simpleEffect: {
    damage: { enabled: false, formula: "1d6", type: "fire" },
    healing: { enabled: false, formula: "1d6" },
    temporaryHitPoints: { enabled: false, formula: "1d6" },
    save: { enabled: false, ability: "dex", dcMode: "auto", dc: 13, onSave: "half" },
    statuses: {
      enabled: false,
      statusId: null,
      persistenceMode: "persistent",
      recovery: { mode: "none", ability: null, dcMode: "inherit", customDC: null, removeOnSuccess: true, provider: "auto" }
    }
  },
  linkedActivity: { id: null, uuid: null }
});

const buildDisabledTriggers = () => ({
  onCreate: buildDisabledTrigger(),
  enter: buildDisabledTrigger(),
  exit: buildDisabledTrigger(),
  move: buildDisabledTrigger(),
  turnStart: buildDisabledTrigger(),
  turnEnd: buildDisabledTrigger()
});

const buildGreaseTrigger = ({ standingOnly = false } = {}) => ({
  ...buildDisabledTrigger(),
  enabled: true,
  mode: "simple-effect",
  frequency: "unlimited",
  frequencyGroup: "",
  ...(standingOnly ? { requiredAbsentStatuses: ["prone"] } : {}),
  simpleEffect: {
    ...buildDisabledTrigger().simpleEffect,
    save: { enabled: true, ability: "dex", dcMode: "inherit", dc: null, onSave: "none" },
    statuses: {
      enabled: true,
      statusId: "prone",
      persistenceMode: "persistent",
      recovery: { mode: "none", ability: null, dcMode: "inherit", customDC: null, removeOnSuccess: false, provider: "auto" }
    }
  }
});

const base = ({ id, name, description, category, geometry, parts = [], triggers = buildDisabledTriggers(), terrain = { enabled: false, multiplier: 2 } }) => ({
  id,
  version: PRESET_SCHEMA_VERSION,
  source: "builtin",
  name,
  description,
  category,
  tags: [category],
  system: { id: "dnd5e", minimum: "5" },
  persistentZone: {
    schemaVersion: ACTIVITY_DEFINITION_SCHEMA_VERSION,
    enabled: true,
    geometry,
    parts,
    triggers,
    movement: { stopOnTrigger: false, stopMode: "off", movementMode: "any", stepMode: "distance", distanceStep: 5, cellStep: 1 },
    terrain,
    linkedWalls: { enabled: false, preset: "solid", geometry: "centerline" },
    linkedLights: { enabled: false, preset: "glow", bright: null, dim: null, max: 24, color: "#ffd88a" },
    lifecycle: { useDedicatedOwnerEffect: true }
  }
});

export const BUILTIN_PRESETS = Object.freeze([
  base({ id: "builtin.simple-circle", name: "PERSISTENT_ZONES.Activity.Presets.Builtins.SimpleCircle.Name", description: "PERSISTENT_ZONES.Activity.Presets.Builtins.SimpleCircle.Description", category: "basic", geometry: { type: "circle", radius: 10 } }),
  base({ id: "builtin.difficult-terrain", name: "PERSISTENT_ZONES.Activity.Presets.Builtins.DifficultTerrain.Name", description: "PERSISTENT_ZONES.Activity.Presets.Builtins.DifficultTerrain.Description", category: "terrain", geometry: { type: "circle", radius: 10 }, terrain: { enabled: true, multiplier: 2 } }),
  base({ id: "builtin.ring", name: "PERSISTENT_ZONES.Activity.Presets.Builtins.Ring.Name", description: "PERSISTENT_ZONES.Activity.Presets.Builtins.Ring.Description", category: "geometry", geometry: { type: "ring", ringReferenceRadius: 10, ringInnerWidth: 5, ringOuterWidth: 0 } }),
  base({ id: "builtin.wall-line", name: "PERSISTENT_ZONES.Activity.Presets.Builtins.WallLine.Name", description: "PERSISTENT_ZONES.Activity.Presets.Builtins.WallLine.Description", category: "geometry", geometry: { type: "wall", wallLength: 30, wallThickness: 5 } }),
  base({
    id: "builtin.multipart-simple",
    name: "PERSISTENT_ZONES.Activity.Presets.Builtins.MultipartSimple.Name",
    description: "PERSISTENT_ZONES.Activity.Presets.Builtins.MultipartSimple.Description",
    category: "multipart",
    geometry: { type: "circle", radius: 10 },
    parts: [
      { id: "primary", label: "Primary", role: "primary", geometry: { type: "template" }, terrain: { enabled: false }, triggers: buildDisabledTriggers() },
      { id: "secondary", label: "Secondary", role: "secondary", geometry: { type: "template" }, terrain: { enabled: false }, triggers: buildDisabledTriggers() }
    ]
  }),
  {
    id: "srd-5.2.1.grease",
    version: PRESET_SCHEMA_VERSION,
    source: "srd-5.2.1",
    rulesVersion: "2024",
    spell: true,
    name: "PERSISTENT_ZONES.Activity.Presets.Builtins.Grease.Name",
    description: "PERSISTENT_ZONES.Activity.Presets.Builtins.Grease.Description",
    category: "srd-5.2.1-spells",
    tags: ["srd-5.2.1", "spell", "control", "terrain"],
    system: { id: "dnd5e", minimum: "5" },
    attribution: {
      title: "System Reference Document 5.2.1",
      url: "https://www.dndbeyond.com/srd",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/legalcode"
    },
    persistentZone: {
      schemaVersion: ACTIVITY_DEFINITION_SCHEMA_VERSION,
      enabled: true,
      geometry: { type: "rectangle", width: 10, height: 10, units: "ft", placement: "center" },
      parts: [],
      triggers: {
        ...buildDisabledTriggers(),
        onCreate: buildGreaseTrigger({ standingOnly: true }),
        enter: buildGreaseTrigger({ standingOnly: true }),
        turnEnd: buildGreaseTrigger({ standingOnly: true })
      },
      movement: { stopOnTrigger: false, stopMode: "off", movementMode: "any", stepMode: "distance", distanceStep: 5, cellStep: 1 },
      terrain: { enabled: true, multiplier: 2 },
      linkedWalls: { enabled: false, preset: "solid", geometry: "centerline" },
      linkedLights: { enabled: false, preset: "glow", bright: null, dim: null, max: 24, color: "#ffd88a" },
      lifecycle: { useDedicatedOwnerEffect: true }
    }
  }
]);
