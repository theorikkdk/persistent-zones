import { createPersistentZonesApi } from "./api.mjs";
import { MODULE_API_NAMESPACE, MODULE_ID } from "./constants.mjs";
import { registerPersistentZoneProfileSettings } from "./profiles.mjs";
import { registerPersistentZonesItemConfigUi } from "./ui/item-config-app.mjs";
import {
  cleanupSceneRegions,
  registerConcentrationCleanupHooks
} from "./runtime/concentration-cleanup.mjs";
import { registerEntryRuntimeHooks } from "./runtime/entry-runtime.mjs";
import { registerRegionFactoryHooks } from "./runtime/region-factory.mjs";
import {
  primeTurnRuntimeState,
  registerTurnRuntimeHooks
} from "./runtime/turn-runtime.mjs";
import { debug, isPrimaryGM } from "./runtime/utils.mjs";

let apiInstance = null;

export function bootstrapPersistentZones() {
  Hooks.once("init", onInit);
  Hooks.once("ready", onReady);
}

function onInit() {
  registerPersistentZoneProfileSettings();
  apiInstance = createPersistentZonesApi();
  game[MODULE_API_NAMESPACE] = apiInstance;

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = apiInstance;
  }

  registerRegionFactoryHooks();
  registerConcentrationCleanupHooks();
  registerEntryRuntimeHooks();
  registerTurnRuntimeHooks();
  registerPersistentZonesItemConfigUi();

  debug("Module initialized.");
}

async function onReady() {
  debug("Module ready.");

  if (!isPrimaryGM()) {
    return;
  }

  debug("GM debug helpers available on game.persistentZones.debug.");
  primeTurnRuntimeState();
  await cleanupSceneRegions(canvas?.scene ?? null, { reason: "ready" });
}
