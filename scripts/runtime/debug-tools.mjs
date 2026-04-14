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
    inspectTemplateSource
  });
}

export function buildTestDefinition(preset = "basic") {
  if (!assertDebugGM("buildTestDefinition")) {
    return null;
  }

  const normalizedPreset = String(preset || "basic").toLowerCase();

  switch (normalizedPreset) {
    case "basic":
      debug("Built persistent-zones debug preset.", {
        preset: normalizedPreset
      });
      return duplicateData(createBasicTestDefinition());
    default:
      debug("Unknown persistent-zones debug preset requested. Falling back to basic.", {
        preset: normalizedPreset
      });
      return duplicateData(createBasicTestDefinition());
  }
}

export async function applyTestDefinitionToItem(itemOrUuid, preset = "basic") {
  if (!assertDebugGM("applyTestDefinitionToItem")) {
    return null;
  }

  const item = await resolveItemDocument(itemOrUuid);
  if (!item) {
    debug("Could not resolve Item for persistent-zones debug definition apply.", {
      itemOrUuid
    });
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
    debug("Could not resolve Item for persistent-zones debug definition removal.", {
      itemOrUuid
    });
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
    debug("Could not resolve Item for persistent-zones debug definition inspect.", {
      itemOrUuid
    });
    return null;
  }

  const rawDefinition = getZoneDefinitionFromItem(item, {
    allowLegacyFallback: false
  });
  const normalizedDefinition = rawDefinition
    ? normalizeZoneDefinition(rawDefinition, {
        item,
        actor: item.actor ?? null
      })
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

  const context = await resolveTemplateSourceContext(templateDocument, {
    emitDebug: true
  });

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

function assertDebugGM(actionName) {
  if (game.user?.isGM) {
    return true;
  }

  debug("Blocked persistent-zones debug action for non-GM user.", {
    actionName
  });

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
    concentration: {
      required: false
    },
    triggers: {
      onEnter: {
        enabled: true
      },
      onTurnStart: {
        enabled: true
      },
      onExit: {
        enabled: true
      }
    },
    debug: {
      preset: "basic",
      notes: "Debug-only preset for manual MVP testing."
    }
  };
}
