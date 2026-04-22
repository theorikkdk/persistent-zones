import {
  DEFINITION_FLAG_KEY,
  MODULE_ID
} from "./constants.mjs";
import { openPersistentZonesItemConfig } from "./ui/item-config-app.mjs";
import {
  cleanupRegionsForItem,
  cleanupSceneRegions,
  cleanupWorldRegions
} from "./runtime/concentration-cleanup.mjs";
import { createPersistentZonesDebugApi } from "./runtime/debug-tools.mjs";
import { createRegionFromTemplate } from "./runtime/region-factory.mjs";
import {
  getZoneDefinitionFromItem as readZoneDefinitionFromItem,
  normalizeZoneDefinition as normalizePersistentZoneDefinition,
  resolveItemTemplateTypeDetection
} from "./runtime/zone-definition.mjs";
import {
  debug,
  duplicateData,
  fromUuidSafe,
  getRegionRuntime as readRegionRuntime
} from "./runtime/utils.mjs";

export function createPersistentZonesApi() {
  const api = {
    moduleId: MODULE_ID,
    debug: createPersistentZonesDebugApi(),

    get version() {
      return game.modules.get(MODULE_ID)?.version ?? null;
    },

    normalizeZoneDefinition(rawDefinition, options = {}) {
      return normalizePersistentZoneDefinition(rawDefinition, options);
    },

    async getZoneDefinitionFromItem(itemOrUuid) {
      const item = await resolveApiItemDocument(itemOrUuid);
      if (!item) {
        debug("Could not resolve Item for public persistent-zones getZoneDefinitionFromItem call.", {
          itemOrUuid
        });
        return null;
      }

      return readZoneDefinitionFromItem(item);
    },

    async getNormalizedZoneDefinitionFromItem(itemOrUuid, options = {}) {
      const item = await resolveApiItemDocument(itemOrUuid);
      if (!item) {
        debug("Could not resolve Item for public persistent-zones getNormalizedZoneDefinitionFromItem call.", {
          itemOrUuid,
          options
        });
        return null;
      }

      const rawDefinition = readZoneDefinitionFromItem(item);
      if (!rawDefinition) {
        debug("Skipped public persistent-zones normalization because the Item has no definition.", {
          itemUuid: item.uuid,
          itemName: item.name
        });
        return null;
      }

      return normalizePersistentZoneDefinition(rawDefinition, await buildNormalizationContext(item, options));
    },

    async normalizeZoneFromItem(itemOrUuid, options = {}) {
      return api.getNormalizedZoneDefinitionFromItem(itemOrUuid, options);
    },

    async setZoneDefinitionOnItem(itemOrUuid, definition) {
      const item = await resolveApiItemDocument(itemOrUuid);
      if (!item) {
        const error = "Could not resolve Item.";
        debug("Could not resolve Item for public persistent-zones setZoneDefinitionOnItem call.", {
          itemOrUuid
        });
        return {
          ok: false,
          error
        };
      }

      if (!definition || typeof definition !== "object") {
        const error = "A definition object is required.";
        debug("Blocked public persistent-zones setZoneDefinitionOnItem call because the definition is invalid.", {
          itemUuid: item.uuid,
          itemName: item.name,
          definitionType: typeof definition
        });
        return {
          ok: false,
          itemUuid: item.uuid,
          itemName: item.name,
          error
        };
      }

      const nextDefinition = duplicateData(definition);
      await item.unsetFlag(MODULE_ID, DEFINITION_FLAG_KEY);
      await item.setFlag(MODULE_ID, DEFINITION_FLAG_KEY, nextDefinition);

      debug("Stored persistent-zones definition on Item through the public API.", {
        itemUuid: item.uuid,
        itemName: item.name
      });

      return {
        ok: true,
        itemUuid: item.uuid,
        itemName: item.name,
        definition: readZoneDefinitionFromItem(item)
      };
    },

    async clearZoneDefinitionFromItem(itemOrUuid, options = {}) {
      const item = await resolveApiItemDocument(itemOrUuid);
      if (!item) {
        const error = "Could not resolve Item.";
        debug("Could not resolve Item for public persistent-zones clearZoneDefinitionFromItem call.", {
          itemOrUuid,
          options
        });
        return {
          ok: false,
          error
        };
      }

      const previousDefinition = readZoneDefinitionFromItem(item);
      await item.unsetFlag(MODULE_ID, DEFINITION_FLAG_KEY);
      const deletedRegions = await cleanupRegionsForItem(item, {
        reason: options.reason ?? "api-clear"
      });

      debug("Cleared persistent-zones definition on Item through the public API.", {
        itemUuid: item.uuid,
        itemName: item.name,
        deletedRegionCount: deletedRegions.length
      });

      return {
        ok: true,
        itemUuid: item.uuid,
        itemName: item.name,
        hadDefinition: Boolean(previousDefinition),
        deletedRegionCount: deletedRegions.length,
        deletedRegionIds: deletedRegions.map((regionDocument) => regionDocument?.id ?? null).filter(Boolean)
      };
    },

    async validateDefinition(definition, context = {}) {
      const item = await resolveApiItemDocument(context.itemOrUuid ?? context.item ?? null);
      const normalizationContext = await buildNormalizationContext(item, context);
      const normalizedDefinition = normalizePersistentZoneDefinition(definition, normalizationContext);
      const reasons = Array.isArray(normalizedDefinition?.validation?.reasons)
        ? normalizedDefinition.validation.reasons
        : [];
      const result = {
        isValid: Boolean(normalizedDefinition?.validation?.isValid),
        reasons,
        normalizedDefinition,
        itemUuid: item?.uuid ?? null,
        itemName: item?.name ?? null,
        templateType: normalizedDefinition?.template?.type ?? normalizationContext.templateDocument?.t ?? null
      };

      debug("Validated persistent-zones definition through the public API.", {
        itemUuid: result.itemUuid,
        itemName: result.itemName,
        templateType: result.templateType,
        isValid: result.isValid,
        reasons
      });

      return result;
    },

    async getCompatibleBaseTypes(itemOrUuid, options = {}) {
      const item = await resolveApiItemDocument(itemOrUuid);
      if (!item) {
        debug("Could not resolve Item for public persistent-zones getCompatibleBaseTypes call.", {
          itemOrUuid,
          options
        });
        return {
          itemUuid: null,
          itemName: null,
          detectedTemplateType: null,
          effectiveTemplateType: null,
          compatibleBaseTypes: [],
          choices: [],
          error: "Could not resolve Item."
        };
      }

      const rawDefinition = readZoneDefinitionFromItem(item);
      const normalizedDefinition = rawDefinition
        ? normalizePersistentZoneDefinition(rawDefinition, await buildNormalizationContext(item, options))
        : null;
      const templateDetection = resolveItemTemplateTypeDetection(item);
      const effectiveTemplateType = normalizeApiTemplateType(
        options.templateType ??
          normalizedDefinition?.template?.type ??
          templateDetection.templateType
      );
      const choices = getCompatibleBaseTypeChoicesForTemplateType(effectiveTemplateType);

      return {
        itemUuid: item.uuid,
        itemName: item.name,
        detectedTemplateType: templateDetection.templateType ?? null,
        effectiveTemplateType,
        compatibleBaseTypes: choices.map((choice) => choice.value),
        choices
      };
    },

    async getCompatibleVariants(itemOrUuid, options = {}) {
      const item = await resolveApiItemDocument(itemOrUuid);
      if (!item) {
        debug("Could not resolve Item for public persistent-zones getCompatibleVariants call.", {
          itemOrUuid,
          options
        });
        return {
          itemUuid: null,
          itemName: null,
          detectedTemplateType: null,
          effectiveTemplateType: null,
          selectedBaseType: null,
          compatibleBaseTypes: [],
          compatibleVariants: [],
          selectedBaseTypeVariants: [],
          error: "Could not resolve Item."
        };
      }

      const rawDefinition = readZoneDefinitionFromItem(item);
      const normalizedDefinition = rawDefinition
        ? normalizePersistentZoneDefinition(rawDefinition, await buildNormalizationContext(item, options))
        : null;
      const templateDetection = resolveItemTemplateTypeDetection(item);
      const effectiveTemplateType = normalizeApiTemplateType(
        options.templateType ??
          normalizedDefinition?.template?.type ??
          templateDetection.templateType
      );
      const compatibleBaseTypeChoices = getCompatibleBaseTypeChoicesForTemplateType(effectiveTemplateType);
      const selectedBaseType = normalizeApiBaseType(
        options.baseType ??
          deriveApiBaseType(rawDefinition, normalizedDefinition, effectiveTemplateType)
      );
      const compatibleVariants = compatibleBaseTypeChoices.flatMap((choice) => {
        return getVariantChoicesForBaseType(choice.value).map((variantChoice) => ({
          baseType: choice.value,
          value: variantChoice.value,
          label: variantChoice.label
        }));
      });
      const selectedBaseTypeVariants = getVariantChoicesForBaseType(selectedBaseType);

      return {
        itemUuid: item.uuid,
        itemName: item.name,
        detectedTemplateType: templateDetection.templateType ?? null,
        effectiveTemplateType,
        selectedBaseType,
        compatibleBaseTypes: compatibleBaseTypeChoices.map((choice) => choice.value),
        compatibleVariants,
        selectedBaseTypeVariants
      };
    },

    async cleanupRegionsForItem(itemOrUuid, options = {}) {
      const item = await resolveApiItemDocument(itemOrUuid);
      if (!item) {
        debug("Could not resolve Item for public persistent-zones cleanupRegionsForItem call.", {
          itemOrUuid,
          options
        });
        return {
          ok: false,
          error: "Could not resolve Item.",
          deletedRegionCount: 0,
          deletedRegionIds: []
        };
      }

      const deletedRegions = await cleanupRegionsForItem(item, {
        reason: options.reason ?? "api-cleanup"
      });

      return {
        ok: true,
        itemUuid: item.uuid,
        itemName: item.name,
        deletedRegionCount: deletedRegions.length,
        deletedRegionIds: deletedRegions.map((regionDocument) => regionDocument?.id ?? null).filter(Boolean)
      };
    },

    async inspectSelectedVariant(itemOrUuid, options = {}) {
      const item = await resolveApiItemDocument(itemOrUuid);
      if (!item) {
        debug("Could not resolve Item for public persistent-zones inspectSelectedVariant call.", {
          itemOrUuid,
          options
        });
        return {
          itemUuid: null,
          itemName: null,
          hasDefinition: false,
          availableVariants: [],
          variantCount: 0,
          defaultVariant: null,
          selectedVariant: null,
          effectiveVariant: null,
          variantResolution: null,
          error: "Could not resolve Item."
        };
      }

      const rawDefinition = readZoneDefinitionFromItem(item);
      if (!rawDefinition) {
        return {
          itemUuid: item.uuid,
          itemName: item.name,
          hasDefinition: false,
          availableVariants: [],
          variantCount: 0,
          defaultVariant: null,
          selectedVariant: null,
          effectiveVariant: null,
          variantResolution: null
        };
      }

      const normalizedDefinition = normalizePersistentZoneDefinition(
        rawDefinition,
        await buildNormalizationContext(item, options)
      );

      return {
        itemUuid: item.uuid,
        itemName: item.name,
        hasDefinition: true,
        templateType: normalizedDefinition?.template?.type ?? null,
        availableVariants: normalizedDefinition.availableVariants ?? [],
        variantCount: normalizedDefinition.variantCount ?? 0,
        defaultVariant: normalizedDefinition.defaultVariantId ?? null,
        selectedVariant: normalizedDefinition.selectedVariantId ?? null,
        effectiveVariant: normalizedDefinition.selectedVariant ?? null,
        variantResolution: normalizedDefinition.variantResolution ?? null
      };
    },

    async openItemConfig(itemOrUuid, options = {}) {
      return openPersistentZonesItemConfig(itemOrUuid, options);
    },

    async createRegionFromTemplate(templateDocument, options = {}) {
      return createRegionFromTemplate(templateDocument, options);
    },

    async cleanupSceneRegions(scene, options = {}) {
      return cleanupSceneRegions(scene, options);
    },

    async cleanupWorldRegions(options = {}) {
      return cleanupWorldRegions(options);
    },

    getRegionRuntime(regionDocument) {
      return readRegionRuntime(regionDocument);
    }
  };

  return Object.freeze(api);
}

async function buildNormalizationContext(item = null, options = {}) {
  const scene = options.scene ?? canvas?.scene ?? null;
  const templateDocument = buildApiTemplateDocument({
    templateDocument: options.templateDocument ?? null,
    templateType: options.templateType ?? null,
    scene
  });

  return {
    item,
    actor: options.actor ?? item?.actor ?? null,
    caster: options.caster ?? null,
    templateDocument
  };
}

function buildApiTemplateDocument({
  templateDocument = null,
  templateType = null,
  scene = canvas?.scene ?? null
} = {}) {
  if (templateDocument) {
    return templateDocument;
  }

  const normalizedTemplateType = normalizeApiTemplateType(templateType);
  if (!normalizedTemplateType) {
    return null;
  }

  return {
    t: normalizedTemplateType,
    parent: scene
  };
}

async function resolveApiItemDocument(itemOrUuid) {
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

function deriveApiBaseType(rawDefinition, normalizedDefinition, effectiveTemplateType = null) {
  const partEntries = [
    ...Array.from(rawDefinition?.parts ?? rawDefinition?.zones ?? []),
    ...Array.from(normalizedDefinition?.parts ?? [])
  ];
  const partIds = partEntries
    .map((part) => String(part?.id ?? "").trim().toLowerCase())
    .filter(Boolean);
  const geometryTypes = partEntries
    .map((part) => String(part?.geometry?.type ?? "").trim().toLowerCase())
    .filter(Boolean);

  if (
    partIds.some((partId) => ["heated-side-left", "heated-side-right"].includes(partId)) ||
    geometryTypes.includes("side-of-line")
  ) {
    return "composite-line";
  }

  if (
    partIds.some((partId) => ["heated-side-inner", "heated-side-outer"].includes(partId)) ||
    geometryTypes.includes("side-of-ring")
  ) {
    return "composite-ring";
  }

  if (
    geometryTypes.includes("ring") ||
    String(rawDefinition?.geometry?.type ?? "").trim().toLowerCase() === "ring" ||
    String(rawDefinition?.geometry?.type ?? "").trim().toLowerCase() === "annulus"
  ) {
    return "ring";
  }

  return effectiveTemplateType === "circle" ? "simple" : "simple";
}

function getCompatibleBaseTypeChoicesForTemplateType(templateType) {
  switch (normalizeApiTemplateType(templateType)) {
    case "circle":
      return [
        { value: "simple", label: localize("PERSISTENT_ZONES.UI.BaseTypes.Simple", "Simple") },
        { value: "ring", label: localize("PERSISTENT_ZONES.UI.BaseTypes.Ring", "Ring") },
        { value: "composite-ring", label: localize("PERSISTENT_ZONES.UI.BaseTypes.CompositeRing", "Composite Ring") }
      ];
    case "ray":
      return [
        { value: "simple", label: localize("PERSISTENT_ZONES.UI.BaseTypes.Simple", "Simple") },
        { value: "composite-line", label: localize("PERSISTENT_ZONES.UI.BaseTypes.CompositeLine", "Composite Line") }
      ];
    case "cone":
    case "rect":
      return [
        { value: "simple", label: localize("PERSISTENT_ZONES.UI.BaseTypes.Simple", "Simple") }
      ];
    default:
      return [
        { value: "simple", label: localize("PERSISTENT_ZONES.UI.BaseTypes.Simple", "Simple") },
        { value: "ring", label: localize("PERSISTENT_ZONES.UI.BaseTypes.Ring", "Ring") },
        { value: "composite-line", label: localize("PERSISTENT_ZONES.UI.BaseTypes.CompositeLine", "Composite Line") },
        { value: "composite-ring", label: localize("PERSISTENT_ZONES.UI.BaseTypes.CompositeRing", "Composite Ring") }
      ];
  }
}

function getVariantChoicesForBaseType(baseType) {
  switch (normalizeApiBaseType(baseType)) {
    case "composite-line":
      return [
        { value: "line-left", label: localize("PERSISTENT_ZONES.UI.Variants.LineLeft", "Line Left") },
        { value: "line-right", label: localize("PERSISTENT_ZONES.UI.Variants.LineRight", "Line Right") }
      ];
    case "composite-ring":
      return [
        { value: "ring-inner", label: localize("PERSISTENT_ZONES.UI.Variants.RingInner", "Ring Inner") },
        { value: "ring-outer", label: localize("PERSISTENT_ZONES.UI.Variants.RingOuter", "Ring Outer") }
      ];
    default:
      return [];
  }
}

function normalizeApiBaseType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["simple", "ring", "composite-line", "composite-ring"].includes(normalized)
    ? normalized
    : "simple";
}

function normalizeApiTemplateType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["circle", "cone", "ray", "rect"].includes(normalized) ? normalized : null;
}

function localize(key, fallback) {
  const localized = game.i18n?.localize?.(key);
  return localized && localized !== key ? localized : fallback;
}
