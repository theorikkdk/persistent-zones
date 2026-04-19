import {
  DEFINITION_FLAG_KEY,
  MODULE_ID,
  NORMALIZED_DEFINITION_VERSION
} from "../constants.mjs";
import {
  debug,
  duplicateData,
  fromUuidSafe
} from "./utils.mjs";
import { markNextMovementMode } from "./entry-runtime.mjs";
import {
  collectTemplateSourceDebugSnapshot,
  resolveTemplateSourceContext
} from "./template-source-context.mjs";
import {
  getZoneDefinitionFromItem,
  normalizeZoneDefinition
} from "./zone-definition.mjs";

export function createPersistentZonesDebugApi() {
  return Object.freeze({
    buildTestDefinition,
    applyTestDefinitionToItem,
    clearTestDefinitionFromItem,
    inspectItemDefinition,
    inspectTemplateSource,
    markNextMovement
  });
}

export function buildTestDefinition(preset = "basic") {
  if (!assertDebugGM("buildTestDefinition")) {
    return null;
  }

  const normalizedPreset = String(preset || "basic").toLowerCase();
  switch (normalizedPreset) {
    case "linked-light-fire":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createLinkedLightTestDefinition("fire"));
    case "linked-light-moonlight":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createLinkedLightTestDefinition("moonlight"));
    case "linked-walls-solid":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createLinkedWallsTestDefinition("solid"));
    case "linked-walls-terrain":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createLinkedWallsTestDefinition("terrain"));
    case "linked-light":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createLinkedLightTestDefinition("glow"));
    case "linked-walls":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createLinkedWallsTestDefinition("solid"));
    case "exit-forced-only":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createMovementFilteredTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Exit Forced Only",
        triggerKey: "onExit",
        movementMode: "forced",
        damageType: "cold"
      }));
    case "exit-voluntary-only":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createMovementFilteredTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Exit Voluntary Only",
        triggerKey: "onExit",
        movementMode: "voluntary",
        damageType: "cold"
      }));
    case "entry-forced-only":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createMovementFilteredTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Entry Forced Only",
        triggerKey: "onEnter",
        movementMode: "forced",
        damageType: "fire"
      }));
    case "entry-voluntary-only":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createMovementFilteredTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Entry Voluntary Only",
        triggerKey: "onEnter",
        movementMode: "voluntary",
        damageType: "fire"
      }));
    case "exit-damage-save":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createExitDamageSaveTestDefinition());
    case "move-damage-forced-only":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createMoveDamageTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Move Damage Forced Only",
        movementMode: "forced"
      }));
    case "move-damage":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createMoveDamageTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Move Damage",
        movementMode: "any"
      }));
    case "difficult-terrain":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createDifficultTerrainTestDefinition());
    case "turn-damage-save":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createTurnDamageSaveTestDefinition());
    case "entry-damage-save":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createEntryDamageSaveTestDefinition());
    case "entry-stop-movement":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createEntryDamageSaveTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Entry Stop Movement",
        stopMovementOnTrigger: true
      }));
    case "move-stop-movement":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createMoveDamageTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Move Stop Movement",
        movementMode: "any",
        stopMovementOnTrigger: false
      }));
    case "basic":
    default:
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createBasicTestDefinition());
  }
}

export async function applyTestDefinitionToItem(itemOrUuid, preset = "basic") {
  if (!assertDebugGM("applyTestDefinitionToItem")) {
    return null;
  }

  const item = await resolveItemDocument(itemOrUuid);
  if (!item) {
    debug("Could not resolve Item for persistent-zones debug definition apply.", { itemOrUuid });
    return null;
  }

  const definition = buildTestDefinition(preset);
  if (!definition) {
    return null;
  }

  await item.setFlag(MODULE_ID, DEFINITION_FLAG_KEY, definition);
  debug("Applied persistent-zones debug definition to Item.", {
    itemUuid: item.uuid,
    itemName: item.name,
    preset: String(preset || "basic").toLowerCase()
  });

  return {
    itemUuid: item.uuid,
    itemName: item.name,
    definition
  };
}

export async function clearTestDefinitionFromItem(itemOrUuid) {
  if (!assertDebugGM("clearTestDefinitionFromItem")) {
    return null;
  }

  const item = await resolveItemDocument(itemOrUuid);
  if (!item) {
    debug("Could not resolve Item for persistent-zones debug definition removal.", { itemOrUuid });
    return null;
  }

  await item.unsetFlag(MODULE_ID, DEFINITION_FLAG_KEY);
  debug("Cleared persistent-zones debug definition from Item.", {
    itemUuid: item.uuid,
    itemName: item.name
  });

  return {
    itemUuid: item.uuid,
    itemName: item.name,
    cleared: true
  };
}

export async function inspectItemDefinition(itemOrUuid) {
  if (!assertDebugGM("inspectItemDefinition")) {
    return null;
  }

  const item = await resolveItemDocument(itemOrUuid);
  if (!item) {
    debug("Could not resolve Item for persistent-zones debug definition inspect.", { itemOrUuid });
    return null;
  }

  const rawDefinition = getZoneDefinitionFromItem(item);
  const normalizedDefinition = rawDefinition
    ? normalizeZoneDefinition(rawDefinition, { item, actor: item.actor ?? null })
    : null;

  const result = {
    itemUuid: item.uuid,
    itemName: item.name,
    hasDefinition: Boolean(rawDefinition),
    rawDefinition: rawDefinition ?? null,
    normalizedDefinition
  };

  debug("Inspected persistent-zones definition on Item.", {
    itemUuid: item.uuid,
    itemName: item.name,
    hasDefinition: result.hasDefinition
  });

  return result;
}

export async function inspectTemplateSource(templateOrUuid) {
  if (!assertDebugGM("inspectTemplateSource")) {
    return null;
  }

  const templateDocument = await resolveTemplateDocument(templateOrUuid);
  if (!templateDocument) {
    debug("Could not resolve MeasuredTemplate for persistent-zones template inspect.", {
      templateOrUuid
    });
    return null;
  }

  const context = await resolveTemplateSourceContext(templateDocument, { emitDebug: true });

  return {
    templateId: templateDocument.id ?? null,
    templateUuid: templateDocument.uuid ?? null,
    snapshot: collectTemplateSourceDebugSnapshot(templateDocument),
    resolved: {
      itemUuid: context.item?.uuid ?? null,
      actorUuid: context.actor?.uuid ?? null,
      casterUuid: context.caster?.uuid ?? null
    },
    report: context.report
  };
}

export async function markNextMovement(tokenOrUuid, movementMode = "forced") {
  if (!assertDebugGM("markNextMovement")) {
    return null;
  }

  const tokenDocument = await resolveTokenDocument(tokenOrUuid);
  if (!tokenDocument) {
    debug("Could not resolve Token for persistent-zones movement mark.", {
      tokenOrUuid,
      movementMode
    });
    return null;
  }

  return markNextMovementMode(tokenDocument, movementMode);
}

function assertDebugGM(actionName) {
  if (game.user?.isGM) {
    return true;
  }

  debug("Blocked persistent-zones debug action for non-GM user.", { actionName });
  return false;
}

async function resolveItemDocument(itemOrUuid) {
  if (!itemOrUuid) {
    return null;
  }

  if (itemOrUuid.documentName === "Item") {
    return itemOrUuid;
  }

  if (typeof itemOrUuid !== "string") {
    return null;
  }

  const resolved = await fromUuidSafe(itemOrUuid);
  if (resolved?.documentName === "Item") {
    return resolved;
  }

  if (resolved?.parent?.documentName === "Item") {
    return resolved.parent;
  }

  return null;
}

async function resolveTemplateDocument(templateOrUuid) {
  if (!templateOrUuid) {
    return null;
  }

  if (templateOrUuid.documentName === "MeasuredTemplate") {
    return templateOrUuid;
  }

  if (typeof templateOrUuid !== "string") {
    return null;
  }

  const resolved = await fromUuidSafe(templateOrUuid);
  if (resolved?.documentName === "MeasuredTemplate") {
    return resolved;
  }

  return canvas?.scene?.templates?.get?.(templateOrUuid) ?? null;
}

async function resolveTokenDocument(tokenOrUuid) {
  if (!tokenOrUuid) {
    return null;
  }

  if (tokenOrUuid.documentName === "Token") {
    return tokenOrUuid;
  }

  if (tokenOrUuid.document?.documentName === "Token") {
    return tokenOrUuid.document;
  }

  if (typeof tokenOrUuid !== "string") {
    return null;
  }

  const resolved = await fromUuidSafe(tokenOrUuid);
  if (resolved?.documentName === "Token") {
    return resolved;
  }

  return canvas?.scene?.tokens?.get?.(tokenOrUuid) ?? null;
}

function createBasicTestDefinition() {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: "basic"
    },
    enabled: true,
    label: "Persistent Zone Debug Basic",
    shapeMode: "template",
    template: {
      type: "circle"
    },
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    },
    triggers: {
      onEnter: {
        enabled: false
      }
    }
  };
}

function createEntryDamageSaveTestDefinition({
  preset = "entry-damage-save",
  label = "Persistent Zone Debug Entry Damage Save",
  stopMovementOnTrigger = false
} = {}) {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset
    },
    enabled: true,
    label,
    shapeMode: "template",
    template: {
      type: "circle"
    },
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    },
    triggers: {
      onEnter: {
        enabled: true,
        stopMovementOnTrigger,
        damage: {
          enabled: true,
          formula: "2d6",
          type: "fire"
        },
        save: {
          enabled: true,
          ability: "dex",
          dc: 13,
          onSuccess: "half"
        }
      }
    }
  };
}

function createTurnDamageSaveTestDefinition() {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: "turn-damage-save"
    },
    enabled: true,
    label: "Persistent Zone Debug Turn Damage Save",
    shapeMode: "template",
    template: {
      type: "circle"
    },
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    },
    triggers: {
      onEnter: {
        enabled: false
      },
      onStartTurn: {
        enabled: true,
        damage: {
          enabled: true,
          formula: "2d6",
          type: "radiant"
        },
        save: {
          enabled: true,
          ability: "con",
          dc: 13,
          onSuccess: "half"
        }
      },
      onEndTurn: {
        enabled: true,
        damage: {
          enabled: true,
          formula: "1d6",
          type: "radiant"
        },
        save: {
          enabled: true,
          ability: "con",
          dc: 13,
          onSuccess: "half"
        }
      }
    }
  };
}

function createExitDamageSaveTestDefinition() {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: "exit-damage-save"
    },
    enabled: true,
    label: "Persistent Zone Debug Exit Damage Save",
    shapeMode: "template",
    template: {
      type: "circle"
    },
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    },
    triggers: {
      onEnter: {
        enabled: false
      },
      onExit: {
        enabled: true,
        damage: {
          enabled: true,
          formula: "2d6",
          type: "cold"
        },
        save: {
          enabled: true,
          ability: "dex",
          dc: 13,
          onSuccess: "half"
        }
      }
    }
  };
}

function createMovementFilteredTestDefinition({
  preset,
  label,
  triggerKey,
  movementMode,
  damageType
}) {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset
    },
    enabled: true,
    label,
    shapeMode: "template",
    template: {
      type: "circle"
    },
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    },
    triggers: {
      onEnter: {
        enabled: false
      },
      onExit: {
        enabled: false
      },
      [triggerKey]: {
        enabled: true,
        movementMode,
        damage: {
          enabled: true,
          formula: "2d6",
          type: damageType
        },
        save: {
          enabled: true,
          ability: "dex",
          dc: 13,
          onSuccess: "half"
        }
      }
    }
  };
}

function createMoveDamageTestDefinition({
  preset,
  label,
  movementMode,
  stopMovementOnTrigger = false
}) {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset
    },
    enabled: true,
    label,
    shapeMode: "template",
    template: {
      type: "circle"
    },
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    },
    triggers: {
      onEnter: {
        enabled: false
      },
      onExit: {
        enabled: false
      },
      onMove: {
        enabled: true,
        movementMode,
        stopMovementOnTrigger,
        distanceStep: 5,
        damage: {
          enabled: true,
          formula: "1d4",
          type: "acid"
        },
        save: {
          enabled: false
        }
      }
    }
  };
}

function createDifficultTerrainTestDefinition() {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: "difficult-terrain"
    },
    enabled: true,
    label: "Persistent Zone Debug Difficult Terrain",
    shapeMode: "template",
    template: {
      type: "circle"
    },
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    },
    terrain: {
      difficult: true,
      magical: false,
      types: []
    },
    triggers: {
      onEnter: {
        enabled: false
      },
      onExit: {
        enabled: false
      },
      onMove: {
        enabled: false
      },
      onStartTurn: {
        enabled: false
      },
      onEndTurn: {
        enabled: false
      }
    }
  };
}

function createLinkedLightTestDefinition(linkedLightPreset = "glow") {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: `linked-light-${String(linkedLightPreset || "glow").toLowerCase()}`
    },
    enabled: true,
    label: `Persistent Zone Debug Linked Light ${toTitleCase(linkedLightPreset)}`,
    shapeMode: "template",
    template: {
      type: "circle"
    },
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    },
    linkedLight: {
      enabled: true,
      preset: linkedLightPreset
    },
    triggers: {
      onEnter: {
        enabled: false
      },
      onExit: {
        enabled: false
      },
      onMove: {
        enabled: false
      },
      onStartTurn: {
        enabled: false
      },
      onEndTurn: {
        enabled: false
      }
    }
  };
}

function createLinkedWallsTestDefinition(linkedWallPreset = "solid") {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: `linked-walls-${String(linkedWallPreset || "solid").toLowerCase()}`
    },
    enabled: true,
    label: `Persistent Zone Debug Linked Walls ${toTitleCase(linkedWallPreset)}`,
    shapeMode: "template",
    template: {
      type: "circle"
    },
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    },
    linkedWalls: {
      enabled: true,
      preset: linkedWallPreset
    },
    triggers: {
      onEnter: {
        enabled: false
      },
      onExit: {
        enabled: false
      },
      onMove: {
        enabled: false
      },
      onStartTurn: {
        enabled: false
      },
      onEndTurn: {
        enabled: false
      }
    }
  };
}

function toTitleCase(value) {
  return String(value ?? "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
