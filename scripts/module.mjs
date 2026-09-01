import { createPersistentZonesApi } from "./api.mjs";
import { MODULE_API_NAMESPACE, MODULE_ID } from "./constants.mjs";
import { registerPersistentZoneProfileSettings } from "./profiles.mjs";
import { registerPersistentZoneActivityType } from "./activity/register-persistent-zone-activity.mjs";
import {
  migrateLegacyMovementStopGlobalSetting,
  registerPersistentZoneModuleSettings
} from "./settings.mjs";
import {
  cleanupSceneRegions,
  registerConcentrationCleanupHooks
} from "./runtime/concentration-cleanup.mjs";
import { registerEntryRuntimeHooks } from "./runtime/entry-runtime.mjs";
import { registerAttachedEmanationRegionBehavior } from "./runtime/attached-emanation-runtime.mjs";
import { registerStatusStateHooks } from "./runtime/status-state.mjs";
import { registerStatusRecoveryArbitrationHooks } from "./runtime/status-recovery-arbitration.mjs";
import { registerStatusEscapeHooks } from "./runtime/status-escape.mjs";
import { registerRegionFactoryHooks } from "./runtime/region-factory.mjs";
import {
  primeTurnRuntimeState,
  registerTurnRuntimeHooks
} from "./runtime/turn-runtime.mjs";
import { debug, isPrimaryGM } from "./runtime/utils.mjs";

let apiInstance = null;
const BUILD_SIGNATURE = "v14-runtime-audit-2026-08-05-01";
const BUILD_GIT_BRANCH = "codex-v14-first-phase-1";
const BUILD_GIT_HASH = "91c51b3";
const BUILD_LOGICAL_FILE = "scripts/module.mjs";

export function bootstrapPersistentZones() {
  Hooks.once("init", onInit);
  Hooks.once("setup", onSetup);
  Hooks.once("ready", onReady);
}

function onSetup() {
  console.warn(`[${MODULE_ID}] moduleSetupSuccess`);
}

function onInit() {
  console.warn(`[${MODULE_ID}] moduleInitStart`);
  const moduleVersion = game.modules.get(MODULE_ID)?.version ?? null;
  console.info(
    `[${MODULE_ID}] BUILD SIGNATURE ${BUILD_SIGNATURE} | moduleVersion=${moduleVersion ?? "null"} | file=${BUILD_LOGICAL_FILE} | branch=${BUILD_GIT_BRANCH} | hash=${BUILD_GIT_HASH}`
  );
  registerPersistentZoneProfileSettings();
  registerPersistentZoneModuleSettings();
  registerAttachedEmanationRegionBehavior();
  registerPersistentZoneActivityType();
  console.warn(`[${MODULE_ID}] settingsRegistered`);
  apiInstance = createPersistentZonesApi();
  game[MODULE_API_NAMESPACE] = apiInstance;

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = apiInstance;
  }

  registerRegionFactoryHooks();
  registerConcentrationCleanupHooks();
  registerEntryRuntimeHooks();
  registerStatusStateHooks();
  registerStatusRecoveryArbitrationHooks();
  registerStatusEscapeHooks();
  registerTurnRuntimeHooks();

  debug("Module initialized.");
  console.warn(`[${MODULE_ID}] moduleInitSuccess`);
}

async function onReady() {
  debug("Module ready.");
  console.warn(`[${MODULE_ID}] moduleReadySuccess`);

  if (!isPrimaryGM()) {
    return;
  }

  const movementStopMigration = await migrateLegacyMovementStopGlobalSetting();
  if (movementStopMigration?.migrated) {
    debug("Resolved persistent-zones movement interruption module setting.", movementStopMigration);
  }

  debug("GM debug helpers available on game.persistentZones.debug.");
  primeTurnRuntimeState();
  await cleanupSceneRegions(canvas?.scene ?? null, { reason: "ready" });
}
