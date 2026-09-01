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

const buildDamageTrigger = ({ formula, type, ability = null, half = false, frequency = "unlimited", frequencyGroup = "", targetFilter = "all" }) => ({
  ...buildDisabledTrigger(),
  enabled: true,
  mode: "simple-effect",
  frequency,
  frequencyGroup,
  targetFilter: { mode: targetFilter },
  simpleEffect: {
    ...buildDisabledTrigger().simpleEffect,
    damage: { enabled: true, formula, type },
    save: { enabled: Boolean(ability), ability: ability ?? "dex", dcMode: "inherit", dc: null, onSave: half ? "half" : "none" }
  }
});

const buildEscapeStatus = ({ persistenceMode = "persistent" } = {}) => ({
  enabled: true,
  statusId: "restrained",
  persistenceMode,
  recovery: { mode: "none", ability: null, dcMode: "inherit", customDC: null, removeOnSuccess: false, provider: "auto" },
  escape: {
    enabled: true,
    actionType: "action",
    checkType: "skill",
    ability: "str",
    skill: "ath",
    dcMode: "inherit",
    customDC: null,
    removeOnSuccess: true,
    prompt: { enabled: true, title: null, message: null }
  }
});

const buildRestrainingSaveTrigger = ({ ability, damage = null, targetFilter = "all", persistenceMode = "persistent", frequency = "unlimited", frequencyGroup = "" }) => ({
  ...buildDisabledTrigger(),
  enabled: true,
  mode: "simple-effect",
  targetFilter: { mode: targetFilter },
  frequency,
  frequencyGroup,
  simpleEffect: {
    ...buildDisabledTrigger().simpleEffect,
    damage: damage ? { enabled: true, formula: damage.formula, type: damage.type } : { ...buildDisabledTrigger().simpleEffect.damage, enabled: false },
    save: { enabled: true, ability, dcMode: "inherit", dc: null, onSave: "none" },
    statuses: buildEscapeStatus({ persistenceMode })
  }
});

// SRD presets automate explicit rules; visual defaults must not invent mechanical effects absent from the SRD.
const buildSrdPreset = ({ id, name, description, geometry, parts, triggers, movement, terrain, linkedWalls, linkedLights, tags = [] }) => ({
  ...base({ id, name, description, category: "srd-5.2.1-spells", geometry, parts, triggers, movement, terrain }),
  source: "srd-5.2.1",
  rulesVersion: "2024",
  spell: true,
  tags: ["srd-5.2.1", "spell", ...tags],
  attribution: {
    title: "System Reference Document 5.2.1",
    url: "https://www.dndbeyond.com/srd",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/legalcode"
  },
  persistentZone: {
    ...base({ id, name, description, category: "srd-5.2.1-spells", geometry, parts, triggers, movement, terrain }).persistentZone,
    ...(linkedWalls ? { linkedWalls } : {}),
    ...(linkedLights ? { linkedLights } : {})
  }
});

const WALL_OF_FIRE_ENTER_FREQUENCY_GROUP = "wall-of-fire-enter";
const WALL_OF_FIRE_TURN_END_FREQUENCY_GROUP = "wall-of-fire-turn-end";
const MOONBEAM_FREQUENCY_GROUP = "moonbeam-damage";
const INSECT_PLAGUE_FREQUENCY_GROUP = "insect-plague-save";
const BLACK_TENTACLES_FREQUENCY_GROUP = "black-tentacles-save";
const WEB_FREQUENCY_GROUP = "web-restrain";

const buildWallOfFireBodyTriggers = () => ({
  ...buildDisabledTriggers(),
  onCreate: buildDamageTrigger({ formula: "5d8", type: "fire", ability: "dex", half: true }),
  enter: buildDamageTrigger({ formula: "5d8", type: "fire", frequency: "once-per-turn", frequencyGroup: WALL_OF_FIRE_ENTER_FREQUENCY_GROUP }),
  turnEnd: buildDamageTrigger({ formula: "5d8", type: "fire", frequency: "once-per-turn", frequencyGroup: WALL_OF_FIRE_TURN_END_FREQUENCY_GROUP })
});

const buildWallOfFireHotSideTriggers = () => ({
  ...buildDisabledTriggers(),
  turnEnd: buildDamageTrigger({ formula: "5d8", type: "fire", frequency: "once-per-turn", frequencyGroup: WALL_OF_FIRE_TURN_END_FREQUENCY_GROUP })
});

const wallOfFireLinkedWalls = {
  enabled: true,
  preset: "custom",
  geometry: "perimeter",
  move: "none",
  sight: "limited",
  light: "limited",
  sound: "none",
  dir: "both",
  threshold: { sight: null, light: null, sound: null, attenuation: false },
  height: 20
};

const wallOfFireLinkedLights = {
  enabled: false,
  preset: "fire",
  bright: 1,
  dim: 5,
  max: 24,
  color: "#ff9b42"
};

const base = ({ id, name, description, category, geometry, parts = [], triggers = buildDisabledTriggers(), movement = null, terrain = { enabled: false, multiplier: 2 }, placement = null }) => ({
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
    ...(placement ? { placement } : {}),
    geometry,
    parts,
    triggers,
    movement: movement ?? { stopOnTrigger: false, stopMode: "off", movementMode: "any", stepMode: "distance", distanceStep: 5, units: "scene", accumulateRemainder: false, aggregateApplications: true, cellStep: 1 },
    terrain,
    linkedWalls: { enabled: false, preset: "solid", geometry: "centerline" },
    linkedLights: { enabled: false, preset: "glow", bright: null, dim: null, max: 24, color: "#ffd88a" },
    lifecycle: { useDedicatedOwnerEffect: true }
  }
});

export const BUILTIN_PRESETS = Object.freeze([
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
  },
  buildSrdPreset({
    id: "srd-5.2.1.wall-of-fire-line",
    name: "PERSISTENT_ZONES.Activity.Presets.Builtins.WallOfFireLine.Name",
    description: "PERSISTENT_ZONES.Activity.Presets.Builtins.WallOfFireLine.Description",
    geometry: { type: "wall", wallLength: 60, wallThickness: 1, units: "ft" },
    tags: ["evocation", "fire", "multipart", "wall"],
    linkedWalls: wallOfFireLinkedWalls,
    linkedLights: wallOfFireLinkedLights,
    parts: [
      { id: "wall-body", label: "Wall Body", role: "wall", geometry: { type: "template" }, interaction: { mode: "thin-wall" }, terrain: { enabled: false }, triggers: buildWallOfFireBodyTriggers() },
      { id: "hot-side", label: "Hot Side", role: "hot-side", geometry: { type: "side-of-line", referencePartId: "wall-body", side: "left", offsetReference: "body-edge", offsetStart: 0, offsetEnd: 10 }, terrain: { enabled: false }, triggers: buildWallOfFireHotSideTriggers() }
    ]
  }),
  buildSrdPreset({
    id: "srd-5.2.1.wall-of-fire-ring",
    name: "PERSISTENT_ZONES.Activity.Presets.Builtins.WallOfFireRing.Name",
    description: "PERSISTENT_ZONES.Activity.Presets.Builtins.WallOfFireRing.Description",
    geometry: { type: "ring", ringReferenceRadius: 10, ringInnerWidth: 1, ringOuterWidth: 0, units: "ft" },
    tags: ["evocation", "fire", "multipart", "ring"],
    linkedWalls: wallOfFireLinkedWalls,
    linkedLights: wallOfFireLinkedLights,
    parts: [
      { id: "wall-body", label: "Wall Body", role: "wall", geometry: { type: "template" }, interaction: { mode: "thin-wall" }, terrain: { enabled: false }, triggers: buildWallOfFireBodyTriggers() },
      { id: "hot-side", label: "Hot Side", role: "hot-side", geometry: { type: "side-of-ring", referencePartId: "wall-body", side: "outer", offsetReference: "body-edge", offsetStart: 0, offsetEnd: 10 }, terrain: { enabled: false }, triggers: buildWallOfFireHotSideTriggers() }
    ]
  }),
  buildSrdPreset({
    id: "srd-5.2.1.moonbeam",
    name: "PERSISTENT_ZONES.Activity.Presets.Builtins.Moonbeam.Name",
    description: "PERSISTENT_ZONES.Activity.Presets.Builtins.Moonbeam.Description",
    geometry: { type: "circle", radius: 5, units: "ft" },
    tags: ["evocation", "radiant", "light"],
    linkedLights: { enabled: true, preset: "moonlight", bright: 0, dim: 5, max: 1, color: "#dbe7ff" },
    parts: [],
    triggers: {
      ...buildDisabledTriggers(),
      onCreate: buildDamageTrigger({ formula: "2d10", type: "radiant", ability: "con", half: true, frequency: "once-per-turn", frequencyGroup: MOONBEAM_FREQUENCY_GROUP }),
      enter: buildDamageTrigger({ formula: "2d10", type: "radiant", ability: "con", half: true, frequency: "once-per-turn", frequencyGroup: MOONBEAM_FREQUENCY_GROUP }),
      turnEnd: buildDamageTrigger({ formula: "2d10", type: "radiant", ability: "con", half: true, frequency: "once-per-turn", frequencyGroup: MOONBEAM_FREQUENCY_GROUP })
    }
  }),
  buildSrdPreset({
    id: "srd-5.2.1.spike-growth",
    name: "PERSISTENT_ZONES.Activity.Presets.Builtins.SpikeGrowth.Name",
    description: "PERSISTENT_ZONES.Activity.Presets.Builtins.SpikeGrowth.Description",
    geometry: { type: "circle", radius: 20, units: "ft" },
    tags: ["transmutation", "control", "terrain", "concentration"],
    terrain: { enabled: true, multiplier: 2 },
    movement: { interruptionMode: "off", stopOnTrigger: false, stopMode: "off", movementMode: "any", stepMode: "distance", distanceStep: 5, units: "ft", accumulateRemainder: true, aggregateApplications: true, cellStep: 1 },
    linkedWalls: { enabled: false, preset: "solid", geometry: "centerline" },
    linkedLights: { enabled: false, preset: "glow", bright: null, dim: null, max: 24, color: "#ffd88a" },
    triggers: {
      ...buildDisabledTriggers(),
      move: buildDamageTrigger({ formula: "2d4", type: "piercing", frequency: "unlimited" })
    }
  }),
  buildSrdPreset({
    id: "srd-5.2.1.insect-plague",
    name: "PERSISTENT_ZONES.Activity.Presets.Builtins.InsectPlague.Name",
    description: "PERSISTENT_ZONES.Activity.Presets.Builtins.InsectPlague.Description",
    geometry: { type: "circle", radius: 20, units: "ft" },
    tags: ["conjuration", "piercing", "control", "terrain", "concentration"],
    terrain: { enabled: true, multiplier: 2 },
    linkedWalls: { enabled: false, preset: "solid", geometry: "centerline" },
    linkedLights: { enabled: false, preset: "glow", bright: null, dim: null, max: 24, color: "#ffd88a" },
    parts: [],
    triggers: {
      ...buildDisabledTriggers(),
      onCreate: buildDamageTrigger({ formula: "4d10", type: "piercing", ability: "con", half: true, frequency: "once-per-turn", frequencyGroup: INSECT_PLAGUE_FREQUENCY_GROUP }),
      enter: buildDamageTrigger({ formula: "4d10", type: "piercing", ability: "con", half: true, frequency: "once-per-turn", frequencyGroup: INSECT_PLAGUE_FREQUENCY_GROUP }),
      turnEnd: buildDamageTrigger({ formula: "4d10", type: "piercing", ability: "con", half: true, frequency: "once-per-turn", frequencyGroup: INSECT_PLAGUE_FREQUENCY_GROUP })
    }
  }),
  buildSrdPreset({
    id: "srd-5.2.1.entangle",
    name: "PERSISTENT_ZONES.Activity.Presets.Builtins.Entangle.Name",
    description: "PERSISTENT_ZONES.Activity.Presets.Builtins.Entangle.Description",
    geometry: { type: "rectangle", width: 20, height: 20, units: "ft", placement: "center" },
    tags: ["conjuration", "control", "terrain", "concentration", "escape"],
    terrain: { enabled: true, multiplier: 2 },
    triggers: {
      ...buildDisabledTriggers(),
      onCreate: buildRestrainingSaveTrigger({ ability: "str", targetFilter: "others" })
    }
  }),
  buildSrdPreset({
    id: "srd-5.2.1.black-tentacles",
    name: "PERSISTENT_ZONES.Activity.Presets.Builtins.BlackTentacles.Name",
    description: "PERSISTENT_ZONES.Activity.Presets.Builtins.BlackTentacles.Description",
    geometry: { type: "rectangle", width: 20, height: 20, units: "ft", placement: "center" },
    tags: ["conjuration", "control", "damage", "terrain", "concentration", "escape"],
    terrain: { enabled: true, multiplier: 2 },
    triggers: {
      ...buildDisabledTriggers(),
      onCreate: buildRestrainingSaveTrigger({ ability: "str", damage: { formula: "3d6", type: "bludgeoning" }, frequency: "once-per-turn", frequencyGroup: BLACK_TENTACLES_FREQUENCY_GROUP }),
      enter: buildRestrainingSaveTrigger({ ability: "str", damage: { formula: "3d6", type: "bludgeoning" }, frequency: "once-per-turn", frequencyGroup: BLACK_TENTACLES_FREQUENCY_GROUP }),
      turnEnd: buildRestrainingSaveTrigger({ ability: "str", damage: { formula: "3d6", type: "bludgeoning" }, frequency: "once-per-turn", frequencyGroup: BLACK_TENTACLES_FREQUENCY_GROUP })
    }
  }),
  buildSrdPreset({
    id: "srd-5.2.1.web",
    name: "PERSISTENT_ZONES.Activity.Presets.Builtins.Web.Name",
    description: "PERSISTENT_ZONES.Activity.Presets.Builtins.Web.Description",
    geometry: { type: "rectangle", width: 20, height: 20, units: "ft", placement: "center" },
    tags: ["conjuration", "control", "terrain", "concentration", "escape", "partial-safe"],
    terrain: { enabled: true, multiplier: 2 },
    triggers: {
      ...buildDisabledTriggers(),
      enter: buildRestrainingSaveTrigger({ ability: "dex", persistenceMode: "while-inside-region", frequency: "once-per-turn", frequencyGroup: WEB_FREQUENCY_GROUP }),
      turnStart: {
        ...buildRestrainingSaveTrigger({ ability: "dex", persistenceMode: "while-inside-region", frequency: "once-per-turn", frequencyGroup: WEB_FREQUENCY_GROUP }),
        requiredAbsentSourceStatuses: ["restrained"]
      }
    }
  })
]);
