import { MODULE_ID } from "./constants.mjs";
import {
  cleanupSceneRegions,
  cleanupWorldRegions
} from "./runtime/concentration-cleanup.mjs";
import { createRegionFromTemplate } from "./runtime/region-factory.mjs";
import {
  getZoneDefinitionFromItem as readZoneDefinitionFromItem,
  normalizeZoneDefinition as normalizePersistentZoneDefinition
} from "./runtime/zone-definition.mjs";
import { createPersistentZonesDebugApi } from "./runtime/debug-tools.mjs";
import { getRegionRuntime as readRegionRuntime } from "./runtime/utils.mjs";

export function createPersistentZonesApi() {
  return Object.freeze({
    moduleId: MODULE_ID,
    debug: createPersistentZonesDebugApi(),

    get version() {
      return game.modules.get(MODULE_ID)?.version ?? null;
    },

    getZoneDefinitionFromItem(item, options = {}) {
      return readZoneDefinitionFromItem(item, options);
    },

    normalizeZoneDefinition(rawDefinition, options = {}) {
      return normalizePersistentZoneDefinition(rawDefinition, options);
    },

    normalizeZoneFromItem(item, options = {}) {
      const actor = options.actor ?? item?.actor ?? null;
      const caster = options.caster ?? null;
      const rawDefinition = readZoneDefinitionFromItem(item, options);

      return normalizePersistentZoneDefinition(rawDefinition, {
        item,
        actor,
        caster,
        templateDocument: options.templateDocument ?? null
      });
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
  });
}
