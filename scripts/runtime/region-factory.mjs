import {
  DEFAULT_REGION_COLOR,
  MODULE_ID,
  NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE,
  REGION_HIGHLIGHT_MODE_SETTING_KEY,
  REGION_VISIBILITY_SETTING_KEY,
  RUNTIME_FLAG_KEY,
  STANDARD_DIFFICULT_TERRAIN_MULTIPLIER
} from "../constants.mjs";
import {
  buildManagedRegionFlags,
  coerceNumber,
  debug,
  distanceToPixels,
  duplicateData,
  error,
  findManagedRegions,
  fromUuidSafe,
  getRegionRuntimeFlags,
  getTemplateType,
  isPlainObject,
  isPrimaryGM,
  translateFlatPoints,
  trimClosingPolygonPoint,
  wait
} from "./utils.mjs";
import { isManagedOwnerEffect, resolveActiveEffectExpiration } from "./active-effect-compat.mjs";
import { isStatusSourceEffect, qualifyLifecycleOwnerCandidate } from "./owner-effect-qualification.mjs";
import {
  cleanupLinkedDocumentsForRegion,
  syncLinkedDocumentsForRegion
} from "./linked-documents.mjs";
import { cleanupWhileInsideStatusesForRegion } from "./entry-effects.mjs";
import { applyRegionGroupOnCreateTriggers, applyRegionOnCreateTrigger } from "./on-create-runtime.mjs";
import {
  buildAttachedEmanationBehaviorData,
  finalizeAttachedEmanationCreation,
  initializeAttachedEmanationTransitionState
} from "./attached-emanation-runtime.mjs";
import { resolveTemplateSourceContext } from "./template-source-context.mjs";
import {
  findPersistentZoneActivityOnItem,
  resolvePersistentZoneConfiguration
} from "./configuration-resolver.mjs";
import {
  consumePersistentZonePlacementContext,
  findPersistentZonePlacementContext
} from "./persistent-zone-placement-context.mjs";
import {
  REGION_ARCHITECTURE_PATHS,
  buildManagedRegionRuntimeContract,
  readManagedRegionContract
} from "./v14-region-contract.mjs";
import { normalizeZoneDefinition } from "./zone-definition.mjs";
import { getPersistentZoneActivityDefinition } from "../activity/persistent-zone-activity-utils.mjs";
import { convertCanonicalDistanceToSceneUnits } from "../activity/activity-distance.mjs";

let hooksRegistered = false;
const pendingTemplateSync = new Set();
const pendingV14RingSegmentGroups = new Set();
const pendingV14RingCleanupKeys = new Set();
const activeGenericOwnerDeleteContexts = new Map();
const activeNonConcentrationCastRegistry = new Map();
const activeDedicatedOwnerExpirationCleanups = new Set();
const DEFAULT_RING_SEGMENTS = 24;
const STARTUP_EXTERNAL_DELETE_PROTECTION_MS = 8000;
const NON_CONCENTRATION_CAST_REGISTRY_TTL_MS = 15000;
const GENERIC_OWNER_DELETE_CONTEXT_TTL_MS = 8000;
let startupDeleteProtectionActive = false;
const REGION_FACTORY_BUILD_SIGNATURE = "v14-runtime-audit-2026-08-05-01";
const REGION_FACTORY_BUILD_GIT_BRANCH = "codex-v14-first-phase-1";
const REGION_FACTORY_BUILD_GIT_HASH = "91c51b3";
const REGION_FACTORY_LOGICAL_FILE = "scripts/runtime/region-factory.mjs";
const REGION_HIGHLIGHT_FIELD_PATTERN = /(highlight|display|render|mode|grid|cell|cover|shape)/i;
const REGION_HIGHLIGHT_MODE_FIELD_PATTERN = /(highlight|display|render|mode)/i;
const REGION_AUTHENTIC_HIGHLIGHT_VALUE_PATTERN = /\b(authentic|true[-_\s]?shape|shape|geometry|template|exact|precise)\b/i;
const REGION_GRID_HIGHLIGHT_VALUE_PATTERN = /\b(grid|cell|cells|covered|coverage|square)\b/i;
const REGION_DEFAULT_HIGHLIGHT_MODE_FIELD = "highlightMode";
const rejectedRegionHighlightModeValues = new Set();
const REGION_HIGHLIGHT_SETTING_VALUES = Object.freeze({
  authentic: "authentic",
  grid: "grid"
});
const REGION_VISIBILITY_SETTING_VALUES = Object.freeze({
  layer: "layer",
  gamemaster: "gamemaster",
  always: "always"
});
const TRANSIENT_TEMPLATE_FLAG_NAMESPACES = Object.freeze(["dnd5e", "pf2e"]);

export function registerRegionFactoryHooks() {
  console.info(
    `[${MODULE_ID}] REGION FACTORY SIGNATURE ${REGION_FACTORY_BUILD_SIGNATURE} | file=${REGION_FACTORY_LOGICAL_FILE} | branch=${REGION_FACTORY_BUILD_GIT_BRANCH} | hash=${REGION_FACTORY_BUILD_GIT_HASH}`
  );
  if (hooksRegistered) {
    logV14RegionEntry("enteredRegionFactory", {
      selectedCompatibilityPath: "hooks-already-registered"
    });
    return;
  }

  startupDeleteProtectionActive = true;
  Hooks.on("createMeasuredTemplate", onCreateMeasuredTemplate);
  Hooks.on("updateMeasuredTemplate", onUpdateMeasuredTemplate);
  Hooks.on("preUpdateRegion", onPreUpdateRegion);
  Hooks.on("createRegion", (...args) => {
    Promise.resolve(onCreateRegion(...args))
      .then(() => reconcileMissingOwnerEffectLinksForWorld({ reason: "createRegion-post-create" }))
      .catch((caughtError) => {
      logV14RegionDiagnostic("createRegionHookFailed", {
        hook: "createRegion",
        reason: caughtError?.message ?? "unknown",
        stack: caughtError?.stack ?? null
      });
    });
  });
  Hooks.on("updateRegion", (...args) => {
    Promise.resolve(onUpdateRegion(...args)).catch((caughtError) => {
      logV14RegionDiagnostic("updateRegionHookFailed", {
        hook: "updateRegion",
        reason: caughtError?.message ?? "unknown",
        stack: caughtError?.stack ?? null
      });
    });
  });
  Hooks.on("createActiveEffect", (activeEffect, options = {}, userId = null) => {
    logOwnerEffectEvent("createActiveEffect", activeEffect);
    Promise.resolve(onOwnerActiveEffectChanged("createActiveEffect", activeEffect, {}, options, userId)).catch((caughtError) => {
      logV14RegionDiagnostic("ownerEffectLinkReconciliationFailed", {
        hook: "createActiveEffect",
        reason: caughtError?.message ?? "unknown",
        stack: caughtError?.stack ?? null
      });
    });
  });
  Hooks.on("updateActiveEffect", (activeEffect, changed = {}, options = {}, userId = null) => {
    logOwnerEffectEvent("updateActiveEffect", activeEffect);
    Promise.resolve(onOwnerActiveEffectChanged("updateActiveEffect", activeEffect, changed, options, userId)).catch((caughtError) => {
      logV14RegionDiagnostic("ownerEffectLinkReconciliationFailed", {
        hook: "updateActiveEffect",
        reason: caughtError?.message ?? "unknown",
        stack: caughtError?.stack ?? null
      });
    });
  });
  Hooks.on("updateCombat", (combat, changed = {}, options = {}, userId = null) => {
    Promise.resolve(onDedicatedOwnerExpirationTick("updateCombat", { combat, changed, options, userId })).catch((caughtError) => {
      logV14RegionDiagnostic("ownerEffectExpirationTickFailed", {
        hook: "updateCombat",
        reason: caughtError?.message ?? "unknown",
        stack: caughtError?.stack ?? null
      });
    });
  });
  Hooks.on("updateWorldTime", (worldTime, options = {}, userId = null) => {
    Promise.resolve(onDedicatedOwnerExpirationTick("updateWorldTime", { worldTime, options, userId })).catch((caughtError) => {
      logV14RegionDiagnostic("ownerEffectExpirationTickFailed", {
        hook: "updateWorldTime",
        reason: caughtError?.message ?? "unknown",
        stack: caughtError?.stack ?? null
      });
    });
  });
  Hooks.on("preCreateActiveEffect", onPreCreateActiveEffect);
  Hooks.on("preDeleteActiveEffect", onPreDeleteActiveEffect);
  Hooks.on("deleteActiveEffect", (activeEffect, options = {}) => {
    Promise.resolve(onDeleteActiveEffectGenericOwnerContextCleanup(activeEffect, options)).catch((caughtError) => {
      logV14RegionDiagnostic("ownerEffectDeleteReconciliationFailed", {
        hook: "deleteActiveEffect",
        effectUuid: activeEffect?.uuid ?? null,
        reason: caughtError?.message ?? "unknown"
      });
      });
  });
  Hooks.on("preDeleteRegion", onPreDeleteRegion);
  Hooks.on("deleteRegion", (...args) => {
    Promise.resolve(onDeleteRegion(...args)).catch((caughtError) => {
      logV14RegionDiagnostic("deleteRegionHookFailed", {
        hook: "deleteRegion",
        reason: caughtError?.message ?? "unknown",
        stack: caughtError?.stack ?? null
      });
    });
  });
  Hooks.once("ready", () => {
    scheduleStartupDeleteProtectionExpiration("ready");
    Promise.resolve(reconcileMissingOwnerEffectLinksForWorld({ reason: "ready" })).catch((caughtError) => {
      logV14RegionDiagnostic("ownerEffectLinkReconciliationFailed", {
        hook: "ready",
        reason: caughtError?.message ?? "unknown",
        stack: caughtError?.stack ?? null
      });
    });
    Promise.resolve(cleanupExpiredDedicatedOwnerEffectsForWorld({ hookName: "ready" }))
      .then(() => cleanupOrphanedDedicatedOwnerEffectsForWorld({ reason: "ready" }))
      .catch((caughtError) => {
        logV14RegionDiagnostic("ownerEffectExpirationStartupCleanupFailed", {
          hook: "ready",
          reason: caughtError?.message ?? "unknown",
          stack: caughtError?.stack ?? null
        });
      });
  });
  hooksRegistered = true;
  logV14RegionEntry("enteredRegionFactory", {
    selectedCompatibilityPath: "hooks-registered",
    registeredHooks: ["createMeasuredTemplate", "updateMeasuredTemplate", "preUpdateRegion", "createRegion", "updateRegion", "preCreateActiveEffect", "createActiveEffect", "updateActiveEffect", "updateCombat", "updateWorldTime", "preDeleteActiveEffect", "deleteActiveEffect", "preDeleteRegion", "deleteRegion"]
  });
}

export async function createAttachedEmanationFromActivity(activity, sourceToken) {
  const scene = sourceToken?.parent ?? null;
  const item = activity?.item ?? activity?.parent ?? null;
  if (!scene || !sourceToken?.id || !sourceToken?.persisted || !item) {
    globalThis.ui?.notifications?.warn?.("Persistent Zones: attached emanation requires a persisted source token on the current Scene.");
    return null;
  }
  if (scene !== globalThis.canvas?.scene) {
    globalThis.ui?.notifications?.warn?.("Persistent Zones: the source token is not on the active Scene.");
    return null;
  }

  const rawDefinition = getPersistentZoneActivityDefinition(activity);
  const normalizedDefinition = normalizeZoneDefinition(rawDefinition, {
    item,
    actor: activity?.actor ?? item?.actor ?? null,
    caster: activity?.actor ?? item?.actor ?? null
  });
  if (normalizedDefinition?.placement?.mode !== "attached-source" ||
      normalizedDefinition?.geometry?.type !== "emanation" ||
      (Array.isArray(normalizedDefinition?.parts) && normalizedDefinition.parts.length > 1)) {
    globalThis.ui?.notifications?.warn?.("Persistent Zones: this definition is not a supported mono-part attached emanation.");
    return null;
  }
  const attachedWallRestricted = normalizedDefinition?.obstacles?.mode === "wall-restricted";
  const restrictedLevelId = attachedWallRestricted
    ? resolveRestrictedRegionLevelId({ sourceToken, scene })
    : null;
  if (attachedWallRestricted && !restrictedLevelId) {
    globalThis.ui?.notifications?.error?.("Persistent Zones: a wall-restricted attached emanation requires the source token to belong to exactly one Level.");
    return null;
  }
  if (restrictedLevelId) normalizedDefinition.obstacles.levelId = restrictedLevelId;

  const sourceContext = {
    item,
    actor: activity?.actor ?? item?.actor ?? null,
    caster: activity?.actor ?? item?.actor ?? null,
    activity,
    sourceTokenUuid: sourceToken.uuid ?? null,
    sourceDisposition: sourceToken.disposition ?? null
  };
  const radius = Math.max(0, convertCanonicalDistanceToSceneUnits(
    normalizedDefinition.geometry.radius,
    normalizedDefinition.geometry.units,
    scene
  ) ?? 0);
  const groupId = `attached:${activity?.uuid ?? item.uuid}:${foundry.utils.randomID()}`;
  const runtimeFlags = buildManagedRegionRuntimeFlags({
    templateDocument: null,
    normalizedDefinition,
    sourceContext,
    groupId,
    partId: "primary",
    partIndex: 0,
    partCount: 1,
    geometryType: "emanation",
    runtimeGeometry: { type: "emanation", radius, units: scene.grid?.units ?? null },
    regionSourceStrategy: "v14-native-token-emanation",
    architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE
  });
  initializeAttachedEmanationTransitionState(runtimeFlags);
  const behaviorData = normalizedDefinition?.obstacles?.mode === "wall-restricted"
    ? buildNativeRegionBehaviors({ normalizedDefinition, sourceContext })
    : [buildAttachedEmanationBehaviorData(), ...(
      normalizedDefinition.terrain?.difficult
        ? buildNativeRegionBehaviors({ normalizedDefinition, sourceContext })
        : []
    )];
  const RegionClass = globalThis.CONFIG?.Region?.documentClass;
  if (typeof RegionClass?.createTokenEmanation !== "function") {
    globalThis.ui?.notifications?.warn?.("Persistent Zones: Foundry V14 token emanations are unavailable.");
    return null;
  }

  const createdRegion = await RegionClass.createTokenEmanation(sourceToken, radius, {
    name: buildRegionName(normalizedDefinition, sourceContext),
    color: DEFAULT_REGION_COLOR,
    elevation: resolveRegionElevation(normalizedDefinition, sourceToken.elevation ?? 0),
    ...(attachedWallRestricted ? {
      restriction: {
        enabled: true,
        type: normalizedDefinition.obstacles.restrictionType,
        priority: normalizedDefinition.obstacles.priority
      },
      levels: [restrictedLevelId]
    } : {}),
    behaviors: behaviorData,
    flags: buildManagedRegionFlags(runtimeFlags),
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]: runtimeFlags
  }, { gridBased: false, excludeToken: false });
  if (!createdRegion) return null;
  const dedicatedOwnerEffect = await ensureDedicatedOwnerEffectForNonConcentrationRegion(createdRegion, runtimeFlags, {
    sourceContext,
    operationId: groupId
  });
  if (dedicatedOwnerEffect) {
    runtimeFlags.ownerEffectUuid = dedicatedOwnerEffect.uuid;
    runtimeFlags.activeEffectUuid = dedicatedOwnerEffect.uuid;
    runtimeFlags.concentrationEffectUuid = null;
  }
  await applyAuthenticRegionHighlightMode(createdRegion, {
    entryPoint: "createAttachedEmanationFromActivity",
    operation: "create-attached-emanation",
    scene,
    partId: "primary",
    partIndex: 1,
    runtimeFlags
  });
  await applyRegionGroupOnCreateTriggers([createdRegion]);
  await finalizeAttachedEmanationCreation(createdRegion);
  return createdRegion;
}

export function inspectManagedRingRegions({ scene = canvas?.scene ?? null, groupId = null, log = true } = {}) {
  const sceneRegions = listSceneRegions(scene);
  const ringRegions = sceneRegions.filter((regionDocument) => {
    const runtimeFlags = getRegionRuntimeFlags(regionDocument);
    if (!isV14RingRuntimeFlags(runtimeFlags)) {
      return false;
    }
    return !groupId || runtimeFlags?.groupId === groupId;
  });
  const visibility = summarizeV14RingSegmentVisibility(ringRegions);
  const regionSummaries = Array.from(visibility.ringSegmentSummaries ?? []).map((segment) => {
    const regionDocument = findSceneRegionById(scene, segment.regionId);
    const runtimeFlags = getRegionRuntimeFlags(regionDocument) ?? {};
    return {
      id: segment.regionId,
      groupId: runtimeFlags.groupId ?? null,
      partId: runtimeFlags.partId ?? null,
      segmentIndex: runtimeFlags.regionSegmentIndex ?? runtimeFlags.partIndex ?? null,
      segmentCount: runtimeFlags.regionSegmentCount ?? null,
      hidden: segment.hidden,
      shapesCount: Array.isArray(segment.shapes) ? segment.shapes.length : 0,
      canvasObjectFound: segment.canvasObjectFound,
      canvasRenderable: segment.canvasRenderable,
      canvasVisible: segment.canvasVisible,
      visible: segment.visible,
      bounds: segment.bounds
    };
  });
  const groups = Array.from(regionSummaries.reduce((map, region) => {
    const key = region.groupId ?? "(no-group)";
    const previous = map.get(key) ?? {
      groupId: region.groupId,
      segmentCount: 0,
      canvasFound: 0,
      canvasVisible: 0,
      hidden: 0
    };
    previous.segmentCount += 1;
    previous.canvasFound += region.canvasObjectFound ? 1 : 0;
    previous.canvasVisible += region.canvasVisible ? 1 : 0;
    previous.hidden += region.hidden ? 1 : 0;
    map.set(key, previous);
    return map;
  }, new Map()).values());
  const summary = {
    sceneId: scene?.id ?? null,
    groupId,
    regionCount: regionSummaries.length,
    groups,
    regions: regionSummaries
  };

  if (log) {
    logRingVisibilityLine(`inspectManagedRingRegions: sceneId=${summary.sceneId ?? "null"} groupId=${groupId ?? "all"} regionCount=${summary.regionCount} groups=${groups.length}`);
    for (const region of regionSummaries) {
      logRingVisibilityLine(`ringSegmentVisibility: id=${region.id ?? "null"} groupId=${region.groupId ?? "null"} partId=${region.partId ?? "null"} segmentIndex=${region.segmentIndex ?? "null"} existsInScene=true existsAfterDelay=true canvasObjectFound=${region.canvasObjectFound} canvasRenderable=${region.canvasRenderable} canvasVisible=${region.canvasVisible} hidden=${region.hidden}`);
    }
    logRingVisibilityLine(`ringFinalDocumentRegionIds: ${regionSummaries.map((region) => region.id).filter(Boolean).join(",") || "(none)"}`);
    logRingVisibilityLine(`ringFinalCanvasFoundRegionIds: ${regionSummaries.filter((region) => region.canvasObjectFound).map((region) => region.id).filter(Boolean).join(",") || "(none)"}`);
    logRingVisibilityLine(`ringFinalActuallyVisibleRegionIds: ${regionSummaries.filter((region) => region.canvasVisible).map((region) => region.id).filter(Boolean).join(",") || "(none)"}`);
    logRingVisibilityLine(`ringFinalVisibleRegionIds: ${regionSummaries.filter((region) => region.canvasVisible).map((region) => region.id).filter(Boolean).join(",") || "(none)"}`);
  }

  return summary;
}

async function onCreateMeasuredTemplate(templateDocument, options, userId) {
  const templateDiagnostics = buildTemplateDiagnostics(templateDocument);
  logV14RegionBranch("legacyPathSelected", {
    hook: "createMeasuredTemplate",
    templateId: templateDocument?.id ?? null,
    selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
    selectedCompatibilityPath: "legacy-template-create-hook",
    ...templateDiagnostics
  });
  logV14RegionEntry("enteredManagedRegionCreation", {
    hook: "createMeasuredTemplate",
    templateId: templateDocument?.id ?? null,
    userId,
    isPrimaryGM: isPrimaryGM(),
    optionsKeys: Object.keys(options ?? {}),
    ...templateDiagnostics,
    selectedCompatibilityPath: "measured-template-create-hook"
  });
  logRingCastDiagnostic("ringCastStart", {
    hook: "createMeasuredTemplate",
    templateId: templateDocument?.id ?? null,
    userId,
    ...templateDiagnostics
  });

  if (!isPrimaryGM()) {
    logRingCastDiagnostic("ringCastSkipReason", {
      hook: "createMeasuredTemplate",
      templateId: templateDocument?.id ?? null,
      ringCastSkipReason: "not-primary-gm"
    });
    logV14RegionBranch("skippedV14PathBecause", {
      hook: "createMeasuredTemplate",
      templateId: templateDocument?.id ?? null,
      reason: "not-primary-gm",
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return;
  }

  try {
    await createRegionFromTemplate(templateDocument, { userId });
  } catch (caughtError) {
    logRingCastDiagnostic("ringCastRegionCreateFailed", {
      hook: "createMeasuredTemplate",
      templateId: templateDocument?.id ?? null,
      ringCastRegionCreateFailedReason: caughtError?.message ?? "unknown"
    });
    error("Failed to create Region from MeasuredTemplate.", caughtError, {
      templateId: templateDocument?.id ?? null
    });
  }
}

async function onUpdateMeasuredTemplate(templateDocument, changed, options, userId) {
  const templateDiagnostics = buildTemplateDiagnostics(templateDocument);
  logV14RegionEntry("enteredManagedRegionCreation", {
    hook: "updateMeasuredTemplate",
    templateId: templateDocument?.id ?? null,
    userId,
    isPrimaryGM: isPrimaryGM(),
    changedKeys: Object.keys(changed ?? {}),
    optionsKeys: Object.keys(options ?? {}),
    ...templateDiagnostics,
    selectedCompatibilityPath: "measured-template-update-hook"
  });

  if (!isPrimaryGM()) {
    logV14RegionBranch("skippedV14PathBecause", {
      hook: "updateMeasuredTemplate",
      templateId: templateDocument?.id ?? null,
      reason: "not-primary-gm",
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return;
  }

  const updateKeys = collectRelevantTemplateUpdateKeys(changed);
  if (!updateKeys.length) {
    logV14RegionBranch("skippedV14PathBecause", {
      hook: "updateMeasuredTemplate",
      templateId: templateDocument?.id ?? null,
      reason: "no-relevant-template-update-keys",
      changedKeys: Object.keys(changed ?? {}),
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return;
  }

  const syncKey = buildTemplateSyncKey(templateDocument);
  if (pendingTemplateSync.has(syncKey)) {
    debug("Skipped template sync because a sync is already pending.", {
      templateId: templateDocument?.id ?? null,
      updateKeys
    });
    logV14RegionBranch("skippedV14PathBecause", {
      hook: "updateMeasuredTemplate",
      templateId: templateDocument?.id ?? null,
      reason: "sync-already-pending",
      updateKeys,
      syncKey,
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return;
  }

  pendingTemplateSync.add(syncKey);

  try {
    await syncRegionToTemplate(templateDocument, {
      changed,
      options,
      updateKeys,
      userId
    });
  } catch (caughtError) {
    error("Failed to sync Region from updated MeasuredTemplate.", caughtError, {
      templateId: templateDocument?.id ?? null,
      updateKeys
    });
  } finally {
    pendingTemplateSync.delete(syncKey);
  }
}

async function onCreateRegion(regionDocument, options = {}, userId = null) {
  const operationId = buildCastOperationId(regionDocument);
  const internalNativeSuppression = detectInternalV14NativeRegionHook(regionDocument, options);
  if (internalNativeSuppression.suppressed) {
    logV14RegionDiagnostic("v14NativeRegionCreateHookSuppressed", {
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      sceneId: regionDocument?.parent?.id ?? null,
      userId,
      groupId: internalNativeSuppression.groupId,
      partId: internalNativeSuppression.partId,
      reason: internalNativeSuppression.reason
    });
    return;
  }

  const internalRingSuppression = detectInternalV14RingSegmentHook(regionDocument, options);
  if (internalRingSuppression.suppressed) {
    logV14RegionDiagnostic("ringInternalSegmentIgnoredByHook", {
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      sceneId: regionDocument?.parent?.id ?? null,
      userId,
      ringInternalSegmentIgnoredByHook: true,
      ringCreateRegionHookSuppressed: true,
      ringCreateRegionHookSuppressedReason: internalRingSuppression.reason,
      ringOperationId: internalRingSuppression.operationId,
      groupId: internalRingSuppression.groupId,
      partId: internalRingSuppression.partId,
      regionSegmentIndex: internalRingSuppression.regionSegmentIndex,
      regionSegmentCount: internalRingSuppression.regionSegmentCount
    });
    logV14RegionDiagnostic("ringCreateRegionHookSuppressed", {
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      ringCreateRegionHookSuppressed: true,
      ringCreateRegionHookSuppressedReason: internalRingSuppression.reason,
      ringOperationId: internalRingSuppression.operationId,
      groupId: internalRingSuppression.groupId
    });
    return;
  }

  logV14RegionBranch("v14PathSelected", {
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    selectedCompatibilityPath: "v14-region-native-create-hook",
    sourceDocumentType: regionDocument?.documentName ?? null
  });
  logRingCastDiagnostic("ringCastStart", {
    operationId,
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    sceneId: regionDocument?.parent?.id ?? null,
    userId,
    sourceDocumentType: regionDocument?.documentName ?? null,
    optionsKeys: Object.keys(options ?? {})
  });
  logCastAuditLine("CAST START", {
    operationId,
    sourceRegionId: regionDocument?.id ?? null,
    sourceShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null
  });
  logCastAuditLine("SOURCE REGION CREATED", {
    operationId,
    sourceRegionId: regionDocument?.id ?? null,
    sourceShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null
  });
  logV14PipelineStep("01", "Activity detected", {
    hook: "createRegion",
    entryPoint: "onCreateRegion",
    regionDocumentId: regionDocument?.id ?? null,
    sourceDocumentType: regionDocument?.documentName ?? null,
    templateType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
    payloadShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
    regionDocumentFinal: summarizeRegionDocumentForPipeline(regionDocument),
    optionsKeys: Object.keys(options ?? {})
  });
  logV14PipelineStep("02", "Template detected", {
    hook: "createRegion",
    entryPoint: "onCreateRegion",
    regionDocumentId: regionDocument?.id ?? null,
    sourceDocumentType: regionDocument?.documentName ?? null,
    templateType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
    payloadShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
    regionDocumentFinal: summarizeRegionDocumentForPipeline(regionDocument)
  });
  logV14RegionEntry("enteredManagedRegionCreation", {
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    sceneId: regionDocument?.parent?.id ?? null,
    userId,
    isPrimaryGM: isPrimaryGM(),
    selectedCompatibilityPath: "v14-region-create-hook",
    regionDocumentFlagsAfterCreate: duplicateData(regionDocument?.flags ?? null),
    regionDocumentSourceFlagsAfterCreate: duplicateData(regionDocument?._source?.flags ?? null)
  });

  if (!isPrimaryGM()) {
    logRingCastDiagnostic("ringCastSkipReason", {
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      ringCastSkipReason: "not-primary-gm"
    });
    logV14RegionBranch("skippedV14PathBecause", {
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      reason: "not-primary-gm",
      fallbackPathSelected: "none"
    });
    return;
  }

  const existingRuntime = getRegionRuntimeFlags(regionDocument);
  if (existingRuntime) {
    const ringDisposition = await handleAlreadyManagedV14RingRegionCreate(regionDocument, existingRuntime, {
      options,
      userId
    });
    if (ringDisposition?.handled) {
      return;
    }

    logRingCastDiagnostic("ringCastSkipReason", {
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      ringCastSkipReason: "region-already-managed"
    });
    logV14RegionDiagnostic("regionManagedFlagsRead", {
      regionDocumentId: regionDocument?.id ?? null,
      sceneId: regionDocument?.parent?.id ?? null,
      regionManagedFlagsRead: true,
      regionManagedFlagsSource: "createRegion-hook-existing-flags",
      managedRegionDetected: true,
      regionDocumentFlagsAfterCreate: duplicateData(regionDocument?.flags ?? null),
      regionDocumentSourceFlagsAfterCreate: duplicateData(regionDocument?._source?.flags ?? null)
    });
    return;
  }

  const v14NativeResult = await createManagedRegionFromRegion(regionDocument, {
    options,
    userId,
    source: "createRegion-hook",
    operationId
  });
  if (v14NativeResult?.handled) {
    return;
  }

  const fallback = await buildRuntimeFlagsForUnmanagedCreatedRegion(regionDocument, { userId });
  if (!fallback?.runtimeFlags) {
    logRingCastDiagnostic("ringCastSkipReason", {
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      ringCastSkipReason: fallback?.reason ?? "no-template-source-candidate",
      candidateCount: fallback?.candidateCount ?? 0
    });
    logV14RegionDiagnostic("regionManagedFlagsWriteFailed", {
      regionDocumentId: regionDocument?.id ?? null,
      sceneId: regionDocument?.parent?.id ?? null,
      reason: fallback?.reason ?? "no-template-source-candidate",
      regionManagedFlagsWriteFailedReason: fallback?.reason ?? "no-template-source-candidate",
      regionManagedFlagsWriteTargetId: regionDocument?.id ?? null,
      regionManagedFlagsWritePayloadSummary: null,
      regionManagedFlagsNamespace: `${MODULE_ID}.${RUNTIME_FLAG_KEY}`,
      regionDocumentFlagsAfterCreate: duplicateData(regionDocument?.flags ?? null),
      regionDocumentSourceFlagsAfterCreate: duplicateData(regionDocument?._source?.flags ?? null),
      candidateCount: fallback?.candidateCount ?? 0,
      candidates: fallback?.candidates ?? []
    });
    return;
  }

  logV14RegionDiagnostic("regionManagedFlagsWriteAttempt", {
    regionDocumentId: regionDocument?.id ?? null,
    sceneId: regionDocument?.parent?.id ?? null,
    templateId: fallback.templateDocument?.id ?? null,
    templateUuid: fallback.templateDocument?.uuid ?? null,
    itemUuid: fallback.runtimeFlags.itemUuid ?? null,
    regionManagedFlagsNamespace: `${MODULE_ID}.${RUNTIME_FLAG_KEY}`,
    regionManagedFlagsPayload: duplicateData(fallback.runtimeFlags),
    candidateCount: fallback.candidateCount,
    selectedCandidate: fallback.selectedCandidate
  });
  logRingCastDiagnostic("ringCastSourceResolved", {
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    templateId: fallback.templateDocument?.id ?? null,
    templateUuid: fallback.templateDocument?.uuid ?? null,
    itemUuid: fallback.runtimeFlags.itemUuid ?? null,
    geometryType: fallback.runtimeFlags.geometryType,
    candidateCount: fallback.candidateCount,
    selectedCandidate: fallback.selectedCandidate
  });
  logRingCastDiagnostic("ringCastTemplateDetected", {
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    templateId: fallback.templateDocument?.id ?? null,
    templateDetected: Boolean(fallback.templateDocument),
    sourceDocumentType: fallback.templateDocument?.documentName ?? null,
    templateType: getTemplateType(fallback.templateDocument)
  });
  logRingCastDiagnostic("ringCastDefinitionResolved", {
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    templateId: fallback.templateDocument?.id ?? null,
    geometryType: fallback.runtimeFlags.geometryType,
    regionSourceStrategy: fallback.runtimeFlags.regionSourceStrategy ?? null,
    regionSegmentCount: fallback.runtimeFlags.regionSegmentCount ?? null
  });
  logRingCastDiagnostic("ringCastCreationEntry", {
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    templateId: fallback.templateDocument?.id ?? null,
    geometryType: fallback.runtimeFlags.geometryType,
    regionSourceStrategy: fallback.runtimeFlags.regionSourceStrategy ?? null
  });

  if (Array.isArray(fallback.regionShapes) && fallback.regionShapes.length) {
    const serializedShapes = buildFoundryRegionShapes(fallback.regionShapes);
    const payloadShapeSummary = summarizeFoundryRegionShapes(serializedShapes);
    const isNativeSegmentGroup = fallback.runtimeFlags.regionSourceStrategy === "v14-region-native-segment-group";
    const shapeBatch = isNativeSegmentGroup ? [serializedShapes[0]] : serializedShapes;
    logV14RegionDiagnostic("regionCreateAttempt", {
      entryPoint: "createRegion-hook-adopt-native-region",
      regionDocumentId: regionDocument?.id ?? null,
      templateId: fallback.templateDocument?.id ?? null,
      itemUuid: fallback.runtimeFlags.itemUuid ?? null,
      geometryType: fallback.runtimeFlags.geometryType,
      regionSourceStrategy: fallback.runtimeFlags.regionSourceStrategy ?? null,
      regionSegmentIndex: fallback.runtimeFlags.regionSegmentIndex ?? null,
      regionSegmentCount: fallback.runtimeFlags.regionSegmentCount ?? null,
      ringSourceBounds: isNativeSegmentGroup ? calculateRegionBoundsFromShapes(serializedShapes) : null,
      regionSegmentCountExpected: isNativeSegmentGroup ? serializedShapes.length : null,
      regionSegmentBounds: isNativeSegmentGroup
        ? serializedShapes.map((shape) => calculateShapeBounds(shape))
        : null,
      selectedCompatibilityPath: "v14-adopt-native-region-create-hook",
      regionCreatePayload: {
        shapes: summarizeFoundryRegionShapes(shapeBatch),
        [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]: duplicateData(fallback.runtimeFlags)
      },
      regionCreatePayloadJson: stringifyShapeSummary({
        shapes: shapeBatch,
        [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]: fallback.runtimeFlags
      })
    });
    logRingCastDiagnostic("ringCastRegionCreateAttempt", {
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      templateId: fallback.templateDocument?.id ?? null,
      geometryType: fallback.runtimeFlags.geometryType,
      regionSourceStrategy: fallback.runtimeFlags.regionSourceStrategy ?? null,
      regionSegmentCount: fallback.runtimeFlags.regionSegmentCount ?? null
    });

    await regionDocument.update({
      shapes: shapeBatch,
      flags: buildManagedRegionFlags(fallback.runtimeFlags),
      [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]: fallback.runtimeFlags
    });
    await applyAuthenticRegionHighlightMode(regionDocument, {
      entryPoint: "createRegion-hook-adopt-native-region",
      templateDocument: fallback.templateDocument,
      scene: regionDocument?.parent ?? null,
      templateDiagnostics: buildTemplateDiagnostics(fallback.templateDocument),
      runtimeFlags: fallback.runtimeFlags
    });

    const createdShapeSummary = summarizeRegionDocumentShapes(regionDocument);
    const createdRegionBounds = calculateRegionBoundsFromShapes(regionDocument?.toObject?.()?.shapes ?? []);
    logV14RegionDiagnostic("regionCreateSuccess", {
      entryPoint: "createRegion-hook-adopt-native-region",
      regionDocumentId: regionDocument?.id ?? null,
      templateId: fallback.templateDocument?.id ?? null,
      geometryType: fallback.runtimeFlags.geometryType,
      regionSourceStrategy: fallback.runtimeFlags.regionSourceStrategy ?? null,
      regionSegmentIndex: fallback.runtimeFlags.regionSegmentIndex ?? null,
      regionSegmentCount: fallback.runtimeFlags.regionSegmentCount ?? null,
      createdRegionShapes: createdShapeSummary,
      createdRegionShapeCount: createdShapeSummary.length,
      createdRegionBounds,
      regionSegmentHidden: Boolean(regionDocument?.hidden),
      regionSegmentDestroyed: Boolean(regionDocument?._destroyed ?? regionDocument?.destroyed)
    });
    logRingCastDiagnostic("ringCastRegionCreateSuccess", {
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      templateId: fallback.templateDocument?.id ?? null,
      geometryType: fallback.runtimeFlags.geometryType,
      regionSourceStrategy: fallback.runtimeFlags.regionSourceStrategy ?? null,
      regionSegmentCount: fallback.runtimeFlags.regionSegmentCount ?? null
    });

    if (String(fallback.runtimeFlags.geometryType ?? "").toLowerCase() === "template") {
      const sourceCircleGeometry = buildCircleSourceGeometry(fallback.templateDocument);
      const boundsComparison = compareBounds(sourceCircleGeometry.bounds, createdRegionBounds);
      const createdShapes = regionDocument?.toObject?.()?.shapes ?? [];
      logCircleGeometryDiagnostic("circleCreatedShapeSummary", {
        templateDocument: fallback.templateDocument,
        sourceShape: createdShapes?.[0] ?? buildCircleShapeFromDocument(fallback.templateDocument),
        createdShapes,
        strategy: createdShapes?.[0]?.type === "circle"
          ? "adopted-native-circle-shape"
          : "adopted-native-non-circle-shape"
      });
      logV14RegionDiagnostic("circleCreatedShapeSummary", {
        regionDocumentId: regionDocument?.id ?? null,
        templateId: fallback.templateDocument?.id ?? null,
        circleGeometryStrategy: "native-ellipse-bounds-from-document-circle",
        sourceShapeBounds: sourceCircleGeometry.bounds,
        sourceRadius: sourceCircleGeometry.radius,
        sourceWidth: sourceCircleGeometry.width,
        sourceHeight: sourceCircleGeometry.height,
        createdRegionBounds,
        circleSourceCenter: sourceCircleGeometry.center,
        circleSourceRadius: sourceCircleGeometry.radius,
        circleSourceBounds: sourceCircleGeometry.bounds,
        circleCreatedCenter: createdRegionBounds
          ? { x: createdRegionBounds.centerX, y: createdRegionBounds.centerY }
          : null,
        circleCreatedRadius: createdRegionBounds
          ? Math.max(createdRegionBounds.width, createdRegionBounds.height) / 2
          : null,
        circleCreatedBounds: createdRegionBounds,
        circleShapeType: createdShapes?.[0]?.type ?? null,
        circleGeometryMismatch: boundsComparison.mismatch,
        circleGeometryMismatchReason: boundsComparison.reason,
        circleGeometryDelta: boundsComparison.delta ?? null,
        circleCreatedShapeSummary: createdShapeSummary,
        circleSerializedShape: payloadShapeSummary?.[0] ?? null
      });
    }

    if (String(fallback.runtimeFlags.geometryType ?? "").toLowerCase().includes("ring")) {
      const shapeComparison = compareRingShapeSummaries(summarizeFoundryRegionShapes(shapeBatch), createdShapeSummary);
      logV14RegionDiagnostic("ringCreatedShapeResult", {
        regionDocumentId: regionDocument?.id ?? null,
        templateId: fallback.templateDocument?.id ?? null,
        geometryType: fallback.runtimeFlags.geometryType,
        regionSourceStrategy: fallback.runtimeFlags.regionSourceStrategy ?? null,
        regionSegmentIndex: fallback.runtimeFlags.regionSegmentIndex ?? null,
        regionSegmentCount: fallback.runtimeFlags.regionSegmentCount ?? null,
        ringSourceBounds: calculateRegionBoundsFromShapes(serializedShapes),
        ringInnerRadius: fallback.runtimeFlags.ringGeometry?.innerRadiusPixels ?? null,
        ringOuterRadius: fallback.runtimeFlags.ringGeometry?.outerRadiusPixels ?? null,
        regionSegmentCountExpected: fallback.runtimeFlags.regionSegmentCount ?? serializedShapes.length,
        regionSegmentCountCreated: 1,
        regionSegmentDocumentIds: [regionDocument?.id ?? null].filter(Boolean),
        regionSegmentBounds: [createdRegionBounds],
        regionSegmentShapes: createdShapeSummary,
        regionSegmentHidden: Boolean(regionDocument?.hidden),
        regionSegmentDestroyed: Boolean(regionDocument?._destroyed ?? regionDocument?.destroyed),
        ringCreatedShapeResult: createdShapeSummary,
        createdRegionShapes: createdShapeSummary,
        createdRegionShapeCount: createdShapeSummary.length,
        ringGeometry: duplicateData(fallback.runtimeFlags.ringGeometry ?? null),
        ...shapeComparison
      });
    }

    if (isNativeSegmentGroup && serializedShapes.length > 1) {
      const scene = regionDocument?.parent ?? null;
      const siblingPayloads = serializedShapes.slice(1).map((shape, segmentOffset) => {
        const segmentIndex = segmentOffset + 2;
        const segmentRuntimeFlags = {
          ...duplicateData(fallback.runtimeFlags),
          regionSegmentIndex: segmentIndex,
          regionSegmentCount: serializedShapes.length,
          partIndex: segmentIndex - 1,
          partCount: serializedShapes.length
        };
        return {
          name: regionDocument?.name ?? buildRegionName(segmentRuntimeFlags.normalizedDefinition, fallback.sourceContext),
          color: regionDocument?.color ?? DEFAULT_REGION_COLOR,
          elevation: coerceNumber(regionDocument?.elevation, 0),
          shapes: [shape],
          behaviors: buildNativeRegionBehaviors({
            normalizedDefinition: segmentRuntimeFlags.normalizedDefinition,
            sourceContext: fallback.sourceContext
          }),
          flags: buildManagedRegionFlags(segmentRuntimeFlags),
          [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]: segmentRuntimeFlags
        };
      });

      logV14RegionDiagnostic("regionCreateAttempt", {
        entryPoint: "createRegion-hook-create-native-ring-segment-siblings",
        templateId: fallback.templateDocument?.id ?? null,
        sourceRegionDocumentId: regionDocument?.id ?? null,
        geometryType: fallback.runtimeFlags.geometryType,
        regionSourceStrategy: fallback.runtimeFlags.regionSourceStrategy ?? null,
        partCountExpected: serializedShapes.length,
        siblingCountExpected: siblingPayloads.length,
        ringSourceBounds: calculateRegionBoundsFromShapes(serializedShapes),
        regionSegmentBounds: serializedShapes.map((shape) => calculateShapeBounds(shape)),
        regionCreatePayloadJson: stringifyShapeSummary(siblingPayloads)
      });

      try {
        const siblingRegions = siblingPayloads.length
          ? await scene.createEmbeddedDocuments("Region", siblingPayloads)
          : [];
        for (const siblingRegion of siblingRegions) {
          await applyAuthenticRegionHighlightMode(siblingRegion, {
            entryPoint: "createRegion-hook-create-native-ring-segment-siblings",
            templateDocument: fallback.templateDocument,
            scene,
            templateDiagnostics: buildTemplateDiagnostics(fallback.templateDocument),
            runtimeFlags: getRegionRuntimeFlags(siblingRegion)
          });
        }
        logV14RegionDiagnostic("regionCreateSuccess", {
          entryPoint: "createRegion-hook-create-native-ring-segment-siblings",
          templateId: fallback.templateDocument?.id ?? null,
          sourceRegionDocumentId: regionDocument?.id ?? null,
          geometryType: fallback.runtimeFlags.geometryType,
          regionSourceStrategy: fallback.runtimeFlags.regionSourceStrategy ?? null,
          partCountExpected: serializedShapes.length,
          partCountCreated: siblingRegions.length + 1,
          regionSegmentCountExpected: serializedShapes.length,
          regionSegmentCountCreated: siblingRegions.length + 1,
          regionSegmentDocumentIds: [
            regionDocument?.id ?? null,
            ...Array.from(siblingRegions ?? []).map((region) => region?.id ?? null)
          ].filter(Boolean),
          regionSegmentBounds: [
            calculateRegionBoundsFromShapes(regionDocument?.toObject?.()?.shapes ?? []),
            ...Array.from(siblingRegions ?? []).map((region) =>
              calculateRegionBoundsFromShapes(region?.toObject?.()?.shapes ?? [])
            )
          ],
          regionSegmentShapes: [
            {
              regionId: regionDocument?.id ?? null,
              shapes: summarizeRegionDocumentShapes(regionDocument)
            },
            ...Array.from(siblingRegions ?? []).map((region) => ({
              regionId: region?.id ?? null,
              shapes: summarizeRegionDocumentShapes(region)
            }))
          ],
          regionSegmentHidden: [
            {
              regionId: regionDocument?.id ?? null,
              hidden: Boolean(regionDocument?.hidden)
            },
            ...Array.from(siblingRegions ?? []).map((region) => ({
              regionId: region?.id ?? null,
              hidden: Boolean(region?.hidden)
            }))
          ],
          regionSegmentDestroyed: [
            {
              regionId: regionDocument?.id ?? null,
              destroyed: Boolean(regionDocument?._destroyed ?? regionDocument?.destroyed)
            },
            ...Array.from(siblingRegions ?? []).map((region) => ({
              regionId: region?.id ?? null,
              destroyed: Boolean(region?._destroyed ?? region?.destroyed)
            }))
          ],
          ringCreationCompleted: true,
          createdRegionIds: [
            regionDocument?.id ?? null,
            ...Array.from(siblingRegions ?? []).map((region) => region?.id ?? null)
          ].filter(Boolean)
        });
      } catch (caughtError) {
        logV14RegionDiagnostic("regionCreateFailed", {
          entryPoint: "createRegion-hook-create-native-ring-segment-siblings",
          templateId: fallback.templateDocument?.id ?? null,
          sourceRegionDocumentId: regionDocument?.id ?? null,
          geometryType: fallback.runtimeFlags.geometryType,
          regionSourceStrategy: fallback.runtimeFlags.regionSourceStrategy ?? null,
          regionCreateFailedReason: caughtError?.message ?? "unknown"
        });
      }
    }
    return;
  }

  await ensureManagedRegionRuntimeFlags(regionDocument, fallback.runtimeFlags, {
    templateDocument: fallback.templateDocument,
    scene: regionDocument?.parent ?? null,
    templateDiagnostics: buildTemplateDiagnostics(fallback.templateDocument),
    groupPlan: { groupId: fallback.runtimeFlags.groupId },
    partId: fallback.runtimeFlags.partId,
    partIndex: fallback.runtimeFlags.partIndex
  });
  await applyAuthenticRegionHighlightMode(regionDocument, {
    entryPoint: "createRegion-hook-adopt-native-region",
    templateDocument: fallback.templateDocument,
    scene: regionDocument?.parent ?? null,
    templateDiagnostics: buildTemplateDiagnostics(fallback.templateDocument),
    runtimeFlags: fallback.runtimeFlags
  });
}

export async function createManagedRegionFromRegion(regionDocument, {
  options = {},
  userId = null,
  source = "api",
  operationId = buildCastOperationId(regionDocument),
  allowComplexGeometry = false
} = {}) {
  if (!isFoundryV14OrNewer()) {
    logV14RegionBranch("legacyPathSelected", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      userId,
      regionDocumentId: regionDocument?.id ?? null,
      selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
      selectedCompatibilityPath: "legacy-template",
      reason: "not-foundry-v14"
    });
    return { handled: false, reason: "not-foundry-v14" };
  }

  if (!isPrimaryGM()) {
    logV14RegionBranch("skippedV14PathBecause", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      userId,
      regionDocumentId: regionDocument?.id ?? null,
      reason: "not-primary-gm",
      selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE
    });
    return { handled: true, reason: "not-primary-gm" };
  }

  const existingContract = readManagedRegionContract(regionDocument);
  if (existingContract) {
    logV14RegionDiagnostic("v14ManagedRegionRead", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      selectedArchitecturePath: existingContract.architecturePath,
      managedRegionContractLoaded: true,
      contractVersion: existingContract.contractVersion,
      definitionVersion: existingContract.definitionVersion,
      itemUuid: existingContract.itemUuid,
      actorUuid: existingContract.actorUuid,
      groupId: existingContract.groupId,
      partId: existingContract.partId
    });
    return { handled: true, reason: "already-managed", runtimeFlags: existingContract };
  }

  const resolved = await buildRuntimeFlagsForUnmanagedCreatedRegion(regionDocument, {
    architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    userId
  });
  logCastAuditLine("PROFILE RESOLVED", {
    operationId,
    sourceRegionId: regionDocument?.id ?? null,
    itemUuid: resolved?.runtimeFlags?.itemUuid ?? null,
    profileId: resolved?.runtimeFlags?.normalizedDefinition?.selectedVariantId ??
      resolved?.runtimeFlags?.normalizedDefinition?.selectedVariant?.id ??
      resolved?.runtimeFlags?.normalizedDefinition?.id ??
      null,
    sourceShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
    selectedGeometryType: resolved?.profileGeometryType ?? resolved?.runtimeFlags?.geometryType ?? null
  });
  logV14RegionDiagnostic("v14RegionSourceResolved", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    regionDocumentId: regionDocument?.id ?? null,
    selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    candidateCount: resolved?.candidateCount ?? 0,
    selectedCandidate: resolved?.selectedCandidate ?? null,
    reason: resolved?.reason ?? null
  });

  if (!resolved?.runtimeFlags) {
    logV14RegionDiagnostic("v14SourceResolutionFailed", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      sceneId: regionDocument?.parent?.id ?? null,
      reason: resolved?.reason ?? "v14-source-not-resolved",
      v14SourceResolutionFailed: true,
      regionManagedFlagsWriteSuppressed: true
    });
    return {
      handled: true,
      reason: resolved?.reason ?? "v14-source-not-resolved",
      runtimeFlags: null
    };
  }

  if (resolved.runtimeFlags.normalizedDefinition?.obstacles?.mode === "wall-restricted") {
    initializeAttachedEmanationTransitionState(resolved.runtimeFlags);
  }
  await applyConfiguredRegionElevation(regionDocument, resolved.runtimeFlags.normalizedDefinition);
  await applyConfiguredRegionObstacles(regionDocument, resolved.runtimeFlags.normalizedDefinition);

  if (resolved.multipartGroupPlan?.parts?.length > 1) {
    return createV14MultipartRegionGroupFromSource(regionDocument, resolved, {
      source
    });
  }

  const nativeRegionResult = await createV14NativeRegionFromResolved(regionDocument, resolved, {
    options,
    userId,
    source,
    operationId
  });
  logV14PipelineStep("05", "Factory called", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    regionDocumentId: regionDocument?.id ?? null,
    templateId: resolved.templateDocument?.id ?? null,
    templateType: getTemplateType(resolved.templateDocument),
    profileId: resolved.runtimeFlags?.normalizedDefinition?.selectedVariantId ??
      resolved.runtimeFlags?.normalizedDefinition?.selectedVariant?.id ??
      resolved.runtimeFlags?.normalizedDefinition?.id ??
      null,
    profileType: classifyNormalizedDefinitionZoneKind(resolved.runtimeFlags?.normalizedDefinition),
    requestedShapeType: resolved.runtimeFlags?.geometryType ?? null,
    serializerUsed: resolved.runtimeFlags?.geometryType === "ring" ? "serializeNativeRingShape" : null,
    payloadShapeType: Array.from(resolved.regionShapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
    selectedFactory: nativeRegionResult?.handled
      ? "createV14NativeRegionFromResolved"
      : isV14FirstRingResolved(resolved)
        ? "createV14FirstRingFromRegion"
        : "legacy-or-adopted-region-path",
    factoryHandled: Boolean(nativeRegionResult?.handled),
    factoryReason: nativeRegionResult?.reason ?? null
  });
  if (nativeRegionResult?.handled) {
    return nativeRegionResult;
  }

  if (isV14FirstRingResolved(resolved)) {
    return createV14FirstRingFromRegion(regionDocument, resolved, {
      options,
      userId,
      source
    });
  }

  if (Array.isArray(resolved.regionShapes) && resolved.regionShapes.length && !allowComplexGeometry) {
    logV14RegionBranch("legacyPathSelected", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
      selectedCompatibilityPath: "legacy-complex-geometry-path",
      reason: "complex-geometry-not-in-v14-phase-1",
      geometryType: resolved.runtimeFlags.geometryType,
      regionSourceStrategy: resolved.runtimeFlags.regionSourceStrategy ?? null
    });
    return { handled: false, reason: "complex-geometry-not-in-v14-phase-1" };
  }

  const runtimeFlags = buildManagedRegionRuntimeContract(resolved.runtimeFlags, {
    architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    regionDocument,
    sourceDocumentType: regionDocument?.documentName ?? "Region"
  });
  registerNonConcentrationCastForGenericCleanupSuppression({
    regionDocument,
    runtime: runtimeFlags,
    sourceContext: resolved.sourceContext,
    operationId,
    stage: "before-native-region-adoption-finalization"
  });
  const ensuredRuntimeFlags = await ensureManagedRegionRuntimeFlags(regionDocument, runtimeFlags, {
    templateDocument: resolved.templateDocument,
    scene: regionDocument?.parent ?? null,
    templateDiagnostics: buildTemplateDiagnostics(resolved.templateDocument),
    groupPlan: { groupId: runtimeFlags.groupId },
    partId: runtimeFlags.partId,
    partIndex: runtimeFlags.partIndex
  });
  await ensureNativeTerrainBehaviorsForAdoptedRegion(
    regionDocument,
    (ensuredRuntimeFlags ?? runtimeFlags).normalizedDefinition,
    resolved.sourceContext
  );
  const dedicatedOwnerEffect = await ensureDedicatedOwnerEffectForNonConcentrationRegion(
    regionDocument,
    ensuredRuntimeFlags ?? runtimeFlags,
    { sourceContext: resolved.sourceContext, operationId }
  );
  if (dedicatedOwnerEffect) {
    runtimeFlags.ownerEffectUuid = dedicatedOwnerEffect.uuid;
    runtimeFlags.activeEffectUuid = dedicatedOwnerEffect.uuid;
    runtimeFlags.concentrationEffectUuid = null;
    registerNonConcentrationCastForGenericCleanupSuppression({
      regionDocument,
      runtime: runtimeFlags,
      sourceContext: resolved.sourceContext,
      operationId,
      stage: "native-region-adoption-dedicated-owner-created"
    });
  }
  await applyAuthenticRegionHighlightMode(regionDocument, {
    entryPoint: "createManagedRegionFromRegion",
    templateDocument: resolved.templateDocument,
    scene: regionDocument?.parent ?? null,
    templateDiagnostics: buildTemplateDiagnostics(resolved.templateDocument),
    runtimeFlags: ensuredRuntimeFlags ?? runtimeFlags
  });

  logV14RegionDiagnostic("v14ManagedRegionCreated", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    optionsKeys: Object.keys(options ?? {}),
    userId,
    regionDocumentId: regionDocument?.id ?? null,
    selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    managedRegionContractWritten: Boolean(ensuredRuntimeFlags),
    contractVersion: runtimeFlags.contractVersion,
    definitionVersion: runtimeFlags.definitionVersion,
    itemUuid: runtimeFlags.itemUuid,
    actorUuid: runtimeFlags.actorUuid,
    groupId: runtimeFlags.groupId,
    partId: runtimeFlags.partId,
    geometryType: runtimeFlags.geometryType,
    regionSourceStrategy: runtimeFlags.regionSourceStrategy
  });

  await syncLinkedDocumentsSafely({
    templateDocument: resolved.templateDocument,
    regionDocument,
    normalizedDefinition: (ensuredRuntimeFlags ?? runtimeFlags).normalizedDefinition,
    shapes: null,
    stage: "v14-native-region-adoption"
  });
  await applyRegionOnCreateTrigger(regionDocument);
  if ((ensuredRuntimeFlags ?? runtimeFlags).normalizedDefinition?.obstacles?.mode === "wall-restricted") {
    await finalizeAttachedEmanationCreation(regionDocument);
  }

  return {
    handled: true,
    reason: "v14-managed-region-created",
    runtimeFlags: ensuredRuntimeFlags ?? runtimeFlags,
    templateDocument: resolved.templateDocument,
    sourceContext: resolved.sourceContext
  };
}

async function applyConfiguredRegionElevation(regionDocument, normalizedDefinition) {
  const configured = normalizedDefinition?.elevation;
  if (!configured || typeof configured !== "object" ||
      (configured.bottom === null && configured.top === null) ||
      typeof regionDocument?.update !== "function") return false;
  const elevation = {
    bottom: configured.bottom,
    top: configured.top,
    topInclusive: Boolean(configured.topInclusive)
  };
  await regionDocument.update({ elevation }, { [MODULE_ID]: { internalElevationSync: true } });
  const actual = regionDocument?.elevation ?? null;
  return true;
}

async function applyConfiguredRegionObstacles(regionDocument, normalizedDefinition) {
  const obstacles = normalizedDefinition?.obstacles;
  if (obstacles?.mode !== "wall-restricted") return false;
  const multipart = Array.isArray(normalizedDefinition?.parts) && normalizedDefinition.parts.length > 1;
  if (multipart || !["circle", "ring"].includes(normalizedDefinition?.geometry?.type)) {
    console.warn("[persistent-zones] Wall restriction supports only mono-part circle, ring, and attached emanation; falling back to unrestricted.");
    obstacles.mode = "unrestricted";
    obstacles.fallbackReason = "unsupported-geometry";
    return false;
  }
  const levelId = resolveRestrictedRegionLevelId({ regionDocument });
  if (!levelId) {
    console.warn("[persistent-zones] Wall-restricted Region requires a Level; falling back to unrestricted.");
    obstacles.mode = "unrestricted";
    obstacles.fallbackReason = "missing-level";
    return false;
  }
  obstacles.levelId = levelId;
  const restriction = { enabled: true, type: obstacles.restrictionType, priority: obstacles.priority };
  if (typeof regionDocument?.update !== "function") return false;
  await regionDocument.update({ restriction, levels: [levelId] }, { [MODULE_ID]: { internalObstacleSync: true } });
  return true;
}

export function resolveRestrictedRegionLevelId({ regionDocument = null, sourceToken = null, scene = null } = {}) {
  const parentScene = scene ?? regionDocument?.parent ?? sourceToken?.parent ?? null;
  const tokenLevelId = sourceToken?.level?.id ?? sourceToken?._source?.level ?? sourceToken?.level ?? null;
  const storedLevels = Array.from(regionDocument?._source?.levels ?? regionDocument?.levels ?? [])
    .map((level) => level?.id ?? level)
    .filter((level) => typeof level === "string" && level.length > 0);
  const canvasLevelId = globalThis.canvas?.scene?.id === parentScene?.id
    ? globalThis.canvas?.level?.id ?? null
    : null;
  const candidate = tokenLevelId ?? (storedLevels.length === 1 ? storedLevels[0] : null) ?? canvasLevelId;
  if (!candidate) return null;
  const sceneLevels = parentScene?.levels;
  if (sceneLevels?.has && !sceneLevels.has(candidate)) return null;
  return candidate;
}

export async function ensureNativeTerrainBehaviorsForAdoptedRegion(regionDocument, normalizedDefinition, sourceContext) {
  const requested = buildNativeRegionBehaviors({ normalizedDefinition, sourceContext });
  const existing = Array.from(regionDocument?.behaviors?.contents ?? regionDocument?.behaviors ?? []);
  const existingTypes = new Set(existing.map((behavior) => String(behavior?.type ?? "")));
  const missing = requested.filter((behavior) => !existingTypes.has(String(behavior?.type ?? "")));

  if (missing.length && typeof regionDocument?.createEmbeddedDocuments === "function") {
    await regionDocument.createEmbeddedDocuments("RegionBehavior", missing, {
      persistentZonesNativeTerrainSync: true
    });
  }

  const finalBehaviors = Array.from(regionDocument?.behaviors?.contents ?? regionDocument?.behaviors ?? []);
  const terrainBehavior = finalBehaviors.find((behavior) =>
    String(behavior?.type ?? "") === String(normalizedDefinition?.terrain?.behaviorType ?? NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE)
  ) ?? null;
  return terrainBehavior;
}

async function createV14MultipartRegionGroupFromSource(regionDocument, resolved, {
  source = "api"
} = {}) {
  const scene = regionDocument?.parent ?? null;
  const groupPlan = resolved?.multipartGroupPlan ?? null;
  if (!scene || !groupPlan?.parts?.length) {
    return { handled: true, reason: "missing-multipart-region-plan" };
  }

  const templateDocument = resolved.templateDocument;
  const templateDiagnostics = buildTemplateDiagnostics(templateDocument);
  const createdRegions = await createManagedRegionDocuments({
    scene,
    templateDocument,
    groupPlan,
    regionCreateData: groupPlan.parts.map((partPlan) => partPlan.regionData),
    templateDiagnostics,
    operation: "create"
  });

  if (createdRegions.length !== groupPlan.parts.length) {
    return { handled: true, reason: "multipart-region-group-incomplete" };
  }

  for (const [index, createdRegion] of createdRegions.entries()) {
    const partPlan = groupPlan.parts[index];
    await syncLinkedDocumentsSafely({
      templateDocument,
      regionDocument: createdRegion,
      normalizedDefinition: partPlan.runtimeDefinition,
      shapes: partPlan.shapes,
      stage: "v14-native-multipart-region-create"
    });
  }

  await removeNativeV14SourceRegion(regionDocument, {
    scene,
    groupId: groupPlan.groupId,
    partId: groupPlan.parts[0]?.partId ?? null,
    source
  });

  return {
    handled: true,
    reason: "v14-multipart-region-group-created",
    runtimeFlags: getRegionRuntimeFlags(createdRegions[0]),
    templateDocument,
    sourceContext: resolved.sourceContext,
    regions: createdRegions
  };
}

function getManagedMultipartRegionGroup(scene, regionOrRuntime) {
  const runtime = regionOrRuntime?.documentName === "Region"
    ? getRegionRuntimeFlags(regionOrRuntime) ?? {}
    : regionOrRuntime ?? {};
  const groupId = String(runtime.groupId ?? "").trim();
  const partCount = Number(runtime.partCount ?? runtime.normalizedDefinition?.group?.partCount ?? 1);
  if (!scene || !groupId || !Number.isFinite(partCount) || partCount <= 1) {
    return [];
  }
  return findManagedRegions(scene, (candidate) => {
    const candidateRuntime = getRegionRuntimeFlags(candidate) ?? {};
    return candidateRuntime.groupId === groupId && Number(candidateRuntime.partCount ?? 1) > 1;
  });
}

function detectInternalV14RingSegmentHook(regionDocument, options = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const optionMarked = Boolean(options?.persistentZonesInternalRingCreation);
  const optionOperationId = options?.persistentZonesRingOperationId ?? null;
  const optionGroupId = options?.persistentZonesRingGroupId ?? null;
  const runtimeMarked = runtime.creationSource === "persistent-zones-internal-ring-segment";
  const runtimeGroupId = runtime.groupId ?? null;
  const groupId = optionGroupId ?? runtimeGroupId;
  const pendingGroup = groupId ? pendingV14RingSegmentGroups.has(groupId) : false;
  const operationId = optionOperationId ?? runtime.ringOperationId ?? null;

  if (!optionMarked && !runtimeMarked && !pendingGroup) {
    return { suppressed: false };
  }

  return {
    suppressed: true,
    reason: optionMarked
      ? "internal-ring-operation-option"
      : runtimeMarked
        ? "internal-ring-segment-runtime-flag"
        : "pending-ring-segment-group",
    operationId,
    groupId,
    partId: runtime.partId ?? null,
    regionSegmentIndex: runtime.regionSegmentIndex ?? null,
    regionSegmentCount: runtime.regionSegmentCount ?? null
  };
}

async function handleAlreadyManagedV14RingRegionCreate(regionDocument, runtimeFlags, {
  options = {},
  userId = null
} = {}) {
  if (!isManagedV14FirstRingRuntime(runtimeFlags)) {
    return { handled: false, reason: "not-v14-first-ring" };
  }

  const scene = regionDocument?.parent ?? null;
  const groupId = runtimeFlags.groupId ?? null;
  const expectedSegmentCount = Math.max(Math.round(coerceNumber(runtimeFlags.regionSegmentCount, 0)), 0);
  const existingGroupRegions = groupId
    ? findManagedRegions(scene, (candidateRegion) => getRegionRuntimeFlags(candidateRegion)?.groupId === groupId)
    : [];

  logV14RegionDiagnostic("ringNativeRegionCreated", {
    entryPoint: "createRegion-hook-already-managed-ring",
    regionDocumentId: regionDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    groupId,
    partId: runtimeFlags.partId ?? null,
    regionSegmentIndex: runtimeFlags.regionSegmentIndex ?? null,
    regionSegmentCount: runtimeFlags.regionSegmentCount ?? null,
    existingGroupRegionCount: existingGroupRegions.length,
    optionsKeys: Object.keys(options ?? {}),
    userId
  });

  if (groupId && pendingV14RingSegmentGroups.has(groupId)) {
    logV14RegionDiagnostic("ringNativeRegionIgnored", {
      entryPoint: "createRegion-hook-already-managed-ring",
      regionDocumentId: regionDocument?.id ?? null,
      groupId,
      ringNativeRegionDisposition: "ignored-pending-segment-group",
      reason: "ring-segment-group-creation-in-progress"
    });
    return { handled: true, reason: "ring-segment-group-creation-in-progress" };
  }

  if (expectedSegmentCount > 0 && existingGroupRegions.length >= expectedSegmentCount) {
    logV14RegionDiagnostic("ringNativeRegionRetained", {
      entryPoint: "createRegion-hook-already-managed-ring",
      regionDocumentId: regionDocument?.id ?? null,
      groupId,
      ringNativeRegionDisposition: "retained-complete-segment-group",
      expectedSegmentCount,
      existingGroupRegionCount: existingGroupRegions.length
    });
    return { handled: true, reason: "ring-segment-group-complete" };
  }

  logV14RegionDiagnostic("ringNativeRegionManagedTooEarly", {
    entryPoint: "createRegion-hook-already-managed-ring",
    regionDocumentId: regionDocument?.id ?? null,
    groupId,
    partId: runtimeFlags.partId ?? null,
    ringNativeRegionManagedTooEarly: true,
    expectedSegmentCount,
    existingGroupRegionCount: existingGroupRegions.length,
    ringNativeRegionDisposition: "complete-segment-group-from-managed-native-region"
  });

  const templateDocument = runtimeFlags.templateUuid
    ? await fromUuidSafe(runtimeFlags.templateUuid)
    : null;
  if (!templateDocument) {
    logV14RegionDiagnostic("ringNativeRegionRetained", {
      entryPoint: "createRegion-hook-already-managed-ring",
      regionDocumentId: regionDocument?.id ?? null,
      groupId,
      ringNativeRegionDisposition: "retained-missing-template-source",
      reason: "missing-template-document"
    });
    return { handled: true, reason: "missing-template-document" };
  }

  const runtimePart = resolveSingleRegionRuntimePart(runtimeFlags.normalizedDefinition);
  if (!runtimePart) {
    logV14RegionDiagnostic("ringNativeRegionRetained", {
      entryPoint: "createRegion-hook-already-managed-ring",
      regionDocumentId: regionDocument?.id ?? null,
      groupId,
      ringNativeRegionDisposition: "retained-missing-runtime-part",
      reason: "missing-runtime-part"
    });
    return { handled: true, reason: "missing-runtime-part" };
  }

  const regionShapes = await buildRegionShapesForZonePart(templateDocument, runtimePart, {
    allParts: [runtimePart]
  });
  if (!Array.isArray(regionShapes) || regionShapes.length < 2) {
    logV14RegionDiagnostic("ringNativeRegionRetained", {
      entryPoint: "createRegion-hook-already-managed-ring",
      regionDocumentId: regionDocument?.id ?? null,
      groupId,
      ringNativeRegionDisposition: "retained-missing-ring-shapes",
      reason: "missing-ring-shapes",
      shapeCount: Array.from(regionShapes ?? []).length
    });
    return { handled: true, reason: "missing-ring-shapes" };
  }

  const sourceContext = await resolveRegionSourceContext(templateDocument, regionDocument);
  const runtimeGeometry = buildRuntimeGeometryForZonePart(templateDocument, runtimePart, regionShapes);
  const resolved = {
    runtimeFlags: {
      ...duplicateData(runtimeFlags),
      architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
      geometryType: "ring",
      regionSourceStrategy: "v14-region-native-segment-group",
      regionSegmentIndex: 1,
      regionSegmentCount: regionShapes.length,
      partIndex: 0,
      partCount: regionShapes.length,
      ringGeometry: duplicateData(runtimeGeometry)
    },
    templateDocument,
    sourceContext,
    regionShapes
  };

  return createV14FirstRingFromRegion(regionDocument, resolved, {
    options,
    userId,
    source: "createRegion-hook-already-managed-ring"
  });
}

async function createV14NativeRegionFromResolved(regionDocument, resolved, {
  options = {},
  userId = null,
  source = "api",
  operationId = buildCastOperationId(regionDocument)
} = {}) {
  const runtimeFlags = resolved?.runtimeFlags ?? null;
  const geometryType = resolveResolvedProfileGeometryType(resolved);
  const scene = regionDocument?.parent ?? null;
  logCastAuditLine("GEOMETRY SELECTED", {
    operationId,
    sourceRegionId: regionDocument?.id ?? null,
    itemUuid: runtimeFlags?.itemUuid ?? null,
    profileId: runtimeFlags?.normalizedDefinition?.selectedVariantId ??
      runtimeFlags?.normalizedDefinition?.selectedVariant?.id ??
      runtimeFlags?.normalizedDefinition?.id ??
      null,
    sourceShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
    selectedGeometryType: geometryType
  });
  logGeometrySource({
    entryPoint: "createV14NativeRegionFromResolved",
    source,
    regionDocumentId: regionDocument?.id ?? null,
    templateId: resolved?.templateDocument?.id ?? null,
    detectedTemplateTypeRaw: getTemplateType(resolved?.templateDocument),
    profileId: runtimeFlags?.normalizedDefinition?.selectedVariantId ??
      runtimeFlags?.normalizedDefinition?.selectedVariant?.id ??
      runtimeFlags?.normalizedDefinition?.id ??
      null,
    geometryFromProfile: resolved?.profileGeometryType ?? null,
    geometryFromTemplate: getTemplateType(resolved?.templateDocument),
    geometrySelected: geometryType,
    factorySelected: geometryType === "ring" ? "native-ring" : "not-native-ring",
    serializerSelected: geometryType === "ring" ? "serializeNativeRingShape" : null
  });
  if (!scene || !runtimeFlags || geometryType !== "ring") {
    if (geometryType === "template" && getTemplateType(resolved?.templateDocument) === "circle") {
      logV14RegionDiagnostic("v14NativeRegionFactorySelected", {
        entryPoint: "createManagedRegionFromRegion",
        source,
        regionDocumentId: regionDocument?.id ?? null,
        itemUuid: runtimeFlags?.itemUuid ?? null,
        groupId: runtimeFlags?.groupId ?? null,
        partId: runtimeFlags?.partId ?? null,
        geometryType,
        regionSourceStrategy: "v14-region-native-adopted-region",
        v14NativeShapeMapping: "foundry-native-circle-region",
        v14LegacyPathSkipped: true,
        selectedCompatibilityPath: "v14-native-circle-adopt-foundry-region"
      });
    }
    return { handled: false, reason: "not-v14-native-ring" };
  }

  const nativeShapes = buildV14NativeRingShapesFromResolved(resolved, regionDocument);
  const serializedShapes = buildFoundryRegionShapes(nativeShapes);
  logV14PipelineStep("05", "Shape serializer selected", {
    entryPoint: "createV14NativeRegionFromResolved",
    source,
    regionDocumentId: regionDocument?.id ?? null,
    templateId: resolved.templateDocument?.id ?? null,
    templateType: getTemplateType(resolved.templateDocument),
    profileId: runtimeFlags?.normalizedDefinition?.selectedVariantId ??
      runtimeFlags?.normalizedDefinition?.selectedVariant?.id ??
      runtimeFlags?.normalizedDefinition?.id ??
      null,
    profileType: classifyNormalizedDefinitionZoneKind(runtimeFlags?.normalizedDefinition),
    requestedShapeType: geometryType,
    serializerUsed: Array.from(nativeShapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null,
    payloadShapeType: Array.from(serializedShapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
    nativeShapeSummary: summarizeFoundryRegionShapes(nativeShapes),
    serializedShapeSummary: summarizeFoundryRegionShapes(serializedShapes)
  });
  const shapeValidation = validateV14NativeRingShapes(serializedShapes);
  if (!shapeValidation.valid) {
    logV14NativeRegionCreateFailure({
      stage: "local-validation",
      error: new Error(shapeValidation.reason),
      source,
      sourceRegionId: regionDocument?.id ?? null,
      groupId: runtimeFlags.groupId ?? null,
      validation: shapeValidation,
      payload: {
        shapes: serializedShapes
      }
    });
    logV14RegionDiagnostic("v14NativeRegionCreateFailed", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      itemUuid: runtimeFlags.itemUuid ?? null,
      partId: runtimeFlags.partId ?? null,
      reason: shapeValidation.reason,
      v14NativeRegionCreateFailedReason: shapeValidation.reason,
      v14NativeRingInvalidField: shapeValidation.invalidField ?? null,
      v14NativeRingInvalidValue: shapeValidation.invalidValue ?? null,
      v14NativeRingInvalidValueType: shapeValidation.invalidValueType ?? null,
      shapeCount: serializedShapes.length,
      holeShapeCount: serializedShapes.filter((shape) => shape?.hole).length,
      v14NativeSourceRegionRetainedAfterFailure: true
    });
    return { handled: true, reason: shapeValidation.reason };
  }
  const runtimeGeometry = buildNativeRingRuntimeGeometryFromShape(serializedShapes.find((shape) => {
    return String(shape?.type ?? "").toLowerCase() === "ring";
  })) ?? runtimeFlags.ringGeometry ?? null;
  const nativeGroupId = buildV14NativeRegionGroupId({
    scene,
    itemUuid: runtimeFlags.itemUuid ?? null,
    partId: runtimeFlags.partId ?? "primary",
    geometryType,
    sourceRegionId: regionDocument?.id ?? null
  });
  const sourceHints = readV14SourceResolutionHints(regionDocument);
  const concentrationDefinition = runtimeFlags.normalizedDefinition?.concentration ?? {};
  const concentrationRequired = concentrationDefinition.required === true;
  const ownerEffectUuid = concentrationRequired ? (
    runtimeFlags.ownerEffectUuid ??
    runtimeFlags.activeEffectUuid ??
    runtimeFlags.concentrationEffectUuid ??
    sourceHints.ownerEffectUuid ??
    sourceHints.activeEffectUuid ??
    sourceHints.concentrationEffectUuid ??
    concentrationDefinition.effectUuid ??
    null
  ) : null;
  const profileId =
    runtimeFlags.profileId ??
    runtimeFlags.selectedVariantId ??
    runtimeFlags.normalizedDefinition?.selectedVariantId ??
    runtimeFlags.normalizedDefinition?.selectedVariant?.id ??
    runtimeFlags.normalizedDefinition?.id ??
    runtimeFlags.normalizedDefinition?.source?.profileId ??
    runtimeFlags.normalizedDefinition?.source?.preset ??
    null;
  const nativeRuntimeFlags = buildManagedRegionRuntimeContract({
    ...duplicateData(runtimeFlags),
    architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    templateId: null,
    templateUuid: null,
    sourceTemplateId: resolved?.templateDocument?.id ?? runtimeFlags.templateId ?? null,
    sourceTemplateUuid: resolved?.templateDocument?.uuid ?? runtimeFlags.templateUuid ?? null,
    groupId: nativeGroupId,
    partId: runtimeFlags.partId ?? "primary",
    partIndex: 0,
    partCount: 1,
    geometryType: "ring",
    regionSourceStrategy: "v14-native-region-shapes",
    regionSegmentIndex: null,
    regionSegmentCount: null,
    ringOperationId: null,
    castInstanceId: runtimeFlags.castInstanceId ?? operationId,
    nativeRegionId: regionDocument?.id ?? null,
    sourceRegionId: regionDocument?.id ?? null,
    finalRegionId: regionDocument?.id ?? null,
    ownerEffectUuid,
    activeEffectUuid: ownerEffectUuid,
    concentrationEffectUuid: concentrationRequired
      ? runtimeFlags.concentrationEffectUuid ?? sourceHints.concentrationEffectUuid ?? concentrationDefinition.effectUuid ?? ownerEffectUuid ?? null
      : null,
    activityId: runtimeFlags.activityId ?? sourceHints.activityId ?? null,
    workflowId: runtimeFlags.workflowId ?? sourceHints.workflowId ?? null,
    profileId,
    selectedVariantId: runtimeFlags.selectedVariantId ?? profileId,
    ringGeometry: duplicateData(runtimeGeometry),
    cleanupPolicy: "persistent-zone",
    skipConcentrationCleanup: true,
    lifecycle: "manual",
    creationSource: "persistent-zones-v14-native-region",
    rebuild: {
      ...(runtimeFlags.rebuild ?? {}),
      itemUuid: runtimeFlags.itemUuid ?? null,
      groupId: nativeGroupId,
      partId: runtimeFlags.partId ?? "primary",
      architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
      templateUuid: null,
      regionDocumentUuid: regionDocument?.uuid ?? null
    }
  }, {
    architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    regionDocument,
    sourceDocumentType: "Region"
  });
  if (nativeRuntimeFlags.normalizedDefinition?.obstacles?.mode === "wall-restricted") {
    initializeAttachedEmanationTransitionState(nativeRuntimeFlags);
  }
  const shapeSummary = summarizeFoundryRegionShapes(serializedShapes);
  const holeShapeCount = serializedShapes.filter((shape) => shape?.hole).length;
  const regionDisplayData = buildV14RegionDisplayCreateData({
    regionDocument,
    operation: "create-v14-native-ring"
  });

  logV14RegionDiagnostic("v14NativeRegionFactorySelected", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    optionsKeys: Object.keys(options ?? {}),
    userId,
    regionDocumentId: regionDocument?.id ?? null,
    itemUuid: nativeRuntimeFlags.itemUuid ?? null,
    groupId: nativeRuntimeFlags.groupId ?? null,
    partId: nativeRuntimeFlags.partId ?? null,
    geometryType,
    regionSourceStrategy: nativeRuntimeFlags.regionSourceStrategy,
    selectedCompatibilityPath: "v14-native-ring-region-shapes",
    v14LegacyPathSkipped: true
  });
  logV14RegionDiagnostic("v14NativeShapeMapping", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    geometryType,
    v14NativeShapeMapping: "native-ring-shape",
    v14NativeRingShapeSelected: true,
    shapeCount: serializedShapes.length,
    holeShapeCount,
    shapes: shapeSummary,
    ringGeometry: duplicateData(nativeRuntimeFlags.ringGeometry ?? null)
  });
  logV14RegionDiagnostic("v14NativeRegionPayloadValidated", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    regionDocumentId: regionDocument?.id ?? null,
    groupId: nativeRuntimeFlags.groupId ?? null,
    partId: nativeRuntimeFlags.partId ?? null,
    validation: shapeValidation,
    v14NativeRingPayloadPrepared: true,
    v14NativeRingRadius: serializedShapes[0]?.radius ?? null,
    v14NativeRingInnerWidth: serializedShapes[0]?.innerWidth ?? null,
    v14NativeRingOuterWidth: serializedShapes[0]?.outerWidth ?? null,
    v14NativeRingSchemaResolved: {
      type: "ring",
      fields: ["type", "x", "y", "radius", "innerWidth", "outerWidth", "hole", "gridBased"]
    },
    v14NativeHoleOrder: "not-used-native-ring-shape"
  });

  await cleanupExistingV14RingSegments(scene, {
    itemUuid: nativeRuntimeFlags.itemUuid ?? null,
    partId: nativeRuntimeFlags.partId ?? null,
    newGroupId: nativeRuntimeFlags.groupId ?? null,
    nativeRegionId: regionDocument?.id ?? null,
    ringOperationId: null
  });

  const payload = cleanV14NativeRegionCreatePayload({
    name: regionDocument?.name ?? buildRegionName(nativeRuntimeFlags.normalizedDefinition, resolved.sourceContext),
    color: regionDocument?.color ?? DEFAULT_REGION_COLOR,
    hidden: false,
    elevation: resolveRegionElevation(nativeRuntimeFlags.normalizedDefinition, coerceNumber(regionDocument?.elevation, 0)),
    ...(nativeRuntimeFlags.normalizedDefinition?.obstacles?.mode === "wall-restricted" ? {
      restriction: {
        enabled: true,
        type: nativeRuntimeFlags.normalizedDefinition.obstacles.restrictionType,
        priority: nativeRuntimeFlags.normalizedDefinition.obstacles.priority
      },
      levels: [nativeRuntimeFlags.normalizedDefinition.obstacles.levelId]
    } : {}),
    ...regionDisplayData,
    shapes: serializedShapes,
    behaviors: buildNativeRegionBehaviors({
      normalizedDefinition: nativeRuntimeFlags.normalizedDefinition,
      sourceContext: resolved.sourceContext
    }),
    flags: buildV14NativeFinalRegionFlags(nativeRuntimeFlags, regionDocument)
  });
  const minimalRingPayload = buildKnownGoodV14NativeRingPayload(payload);
  const payloadComparison = compareV14NativeRingPayloadToKnownGood(payload, minimalRingPayload);
  const payloadValidation = validateV14NativeRingCreatePayload(payload);
  logV14PipelineStep("06", "Payload generated", {
    entryPoint: "createV14NativeRegionFromResolved",
    source,
    sourceRegionId: regionDocument?.id ?? null,
    templateId: resolved.templateDocument?.id ?? null,
    templateType: getTemplateType(resolved.templateDocument),
    profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
      nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
      nativeRuntimeFlags.normalizedDefinition?.id ??
      null,
    profileType: classifyNormalizedDefinitionZoneKind(nativeRuntimeFlags.normalizedDefinition),
    requestedShapeType: nativeRuntimeFlags.geometryType,
    serializerUsed: Array.from(serializedShapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null,
    payloadShapeType: Array.from(payload.shapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
    payloadShapeSummary: summarizeFoundryRegionShapes(payload.shapes),
    regionCreatePayload: summarizeRegionCreateData([payload])?.[0] ?? null
  });
  logV14NativeRegionPayloadJson("PIPELINE 06 Payload generated", payload);
  logV14NativeRingPayloadScalars(payload, {
    source,
    sourceRegionId: regionDocument?.id ?? null,
    groupId: nativeRuntimeFlags.groupId ?? null,
    stage: "payload-build"
  });
  logV14NativeRingPayloadComparison(payloadComparison, {
    source,
    sourceRegionId: regionDocument?.id ?? null,
    groupId: nativeRuntimeFlags.groupId ?? null
  });
  if (!payloadValidation.valid) {
    logCastAuditLine("FINAL REGION CREATE FAILED", {
      operationId,
      sourceRegionId: regionDocument?.id ?? null,
      itemUuid: nativeRuntimeFlags.itemUuid ?? null,
      profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
        nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
        nativeRuntimeFlags.normalizedDefinition?.id ??
        null,
      sourceShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
      selectedGeometryType: nativeRuntimeFlags.geometryType,
      reason: payloadValidation.reason
    });
    logCastAuditLine("SOURCE REGION RETAINED", {
      operationId,
      sourceRegionId: regionDocument?.id ?? null,
      itemUuid: nativeRuntimeFlags.itemUuid ?? null,
      selectedGeometryType: nativeRuntimeFlags.geometryType,
      reason: payloadValidation.reason
    });
    logV14NativeRegionCreateFailure({
      stage: "local-validation",
      error: new Error(payloadValidation.reason),
      source,
      sourceRegionId: regionDocument?.id ?? null,
      groupId: nativeRuntimeFlags.groupId ?? null,
      validation: payloadValidation,
      payload
    });
    logV14RegionDiagnostic("v14NativeRingPayloadValidationFailed", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      sourceRegionId: regionDocument?.id ?? null,
      groupId: nativeRuntimeFlags.groupId ?? null,
      v14NativeRingInvalidField: payloadValidation.invalidField,
      v14NativeRingInvalidValue: payloadValidation.invalidValue,
      v14NativeSourceRegionRetainedAfterFailure: true
    });
    return { handled: true, reason: payloadValidation.reason };
  }

  logV14RegionDiagnostic("v14NativeRegionCreateStart", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    sourceRegionId: regionDocument?.id ?? null,
    groupId: nativeRuntimeFlags.groupId ?? null,
    partId: nativeRuntimeFlags.partId ?? null,
    regionCreatePayload: {
      shapes: shapeSummary,
      flagsPresent: Boolean(payload.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]),
      display: duplicateData(regionDisplayData)
    },
    v14NativeVisibilitySelected: regionDisplayData.visibility ?? "foundry-region-native-default"
  });
  logV14RegionDiagnostic("regionCreateAttempt", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    sourceRegionId: regionDocument?.id ?? null,
    groupId: nativeRuntimeFlags.groupId ?? null,
    partId: nativeRuntimeFlags.partId ?? null,
    geometryType: "ring",
    regionSourceStrategy: nativeRuntimeFlags.regionSourceStrategy,
    v14RingStrategy: "single-native-ring-shape",
    regionCreatePayload: {
      shapes: shapeSummary,
      flagsPresent: Boolean(payload.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]),
      display: duplicateData(regionDisplayData)
    }
  });

  let createdRegion = null;
  registerNonConcentrationCastForGenericCleanupSuppression({
    regionDocument,
    runtime: nativeRuntimeFlags,
    sourceContext: resolved.sourceContext,
    operationId,
    stage: "before-source-region-update-in-place"
  });
  try {
    logCastAuditLine("FINAL REGION CREATE START", {
      operationId,
      sourceRegionId: regionDocument?.id ?? null,
      itemUuid: nativeRuntimeFlags.itemUuid ?? null,
      profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
        nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
        nativeRuntimeFlags.normalizedDefinition?.id ??
        null,
      sourceShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
      selectedGeometryType: nativeRuntimeFlags.geometryType
    });
    logV14PipelineStep("07", "Payload before create", {
      entryPoint: "createV14NativeRegionFromResolved",
      source,
      sourceRegionId: regionDocument?.id ?? null,
      templateId: resolved.templateDocument?.id ?? null,
      templateType: getTemplateType(resolved.templateDocument),
      profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
        nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
        nativeRuntimeFlags.normalizedDefinition?.id ??
        null,
      profileType: classifyNormalizedDefinitionZoneKind(nativeRuntimeFlags.normalizedDefinition),
      requestedShapeType: nativeRuntimeFlags.geometryType,
      serializerUsed: Array.from(payload.shapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null,
      payloadShapeType: Array.from(payload.shapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
      payloadBeforeCreate: summarizeRegionCreateData([payload])?.[0] ?? null
    });
    logV14NativeRegionPayloadJson("PIPELINE 07 Payload before create", payload);
    logV14NativeRegionPayloadJson("v14NativeRegionPayloadJson", payload);
    const updatedRegion = await regionDocument.update(payload, {
      persistentZonesV14NativeRegionUpdateInPlace: true,
      persistentZonesV14NativeGroupId: nativeRuntimeFlags.groupId,
      persistentZonesLinkedSync: true
    });
    createdRegion = scene.regions?.get?.(regionDocument.id) ?? updatedRegion ?? regionDocument;
    console.info(`[${MODULE_ID}][lifecycle] REGION SOURCE UPDATED IN PLACE`, {
      sourceRegionId: regionDocument?.id ?? null,
      finalRegionId: createdRegion?.id ?? null,
      groupId: nativeRuntimeFlags.groupId ?? null,
      partId: nativeRuntimeFlags.partId ?? null
    });
    logFinalRegionTransientState(createdRegion, {
      scene,
      sourceRegionId: regionDocument?.id ?? null
    });
  } catch (caughtError) {
    logCastAuditLine("FINAL REGION CREATE FAILED", {
      operationId,
      sourceRegionId: regionDocument?.id ?? null,
      itemUuid: nativeRuntimeFlags.itemUuid ?? null,
      profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
        nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
        nativeRuntimeFlags.normalizedDefinition?.id ??
        null,
      sourceShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
      selectedGeometryType: nativeRuntimeFlags.geometryType,
      reason: caughtError?.message ?? "unknown"
    });
    logCastAuditLine("SOURCE REGION RETAINED", {
      operationId,
      sourceRegionId: regionDocument?.id ?? null,
      itemUuid: nativeRuntimeFlags.itemUuid ?? null,
      selectedGeometryType: nativeRuntimeFlags.geometryType,
      reason: caughtError?.message ?? "unknown"
    });
    logV14NativeRegionCreateFailure({
      stage: "source-region-update-in-place",
      error: caughtError,
      source,
      sourceRegionId: regionDocument?.id ?? null,
      groupId: nativeRuntimeFlags.groupId ?? null,
      payload
    });
    return { handled: true, reason: caughtError?.message ?? "source-region-update-failed", runtimeFlags: null };
  }

  logCastAuditLine("FINAL REGION CREATE SUCCESS", {
    operationId,
    sourceRegionId: regionDocument?.id ?? null,
    finalRegionId: createdRegion?.id ?? null,
    itemUuid: nativeRuntimeFlags.itemUuid ?? null,
    profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
      nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
      nativeRuntimeFlags.normalizedDefinition?.id ??
      null,
    sourceShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
    selectedGeometryType: nativeRuntimeFlags.geometryType
  });
  const createdShapeSummary = summarizeRegionDocumentShapes(createdRegion);
  logV14PipelineStep("08", "Region created", {
    entryPoint: "createV14NativeRegionFromResolved",
    source,
    sourceRegionId: regionDocument?.id ?? null,
    regionDocumentId: createdRegion?.id ?? null,
    templateId: resolved.templateDocument?.id ?? null,
    templateType: getTemplateType(resolved.templateDocument),
    profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
      nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
      nativeRuntimeFlags.normalizedDefinition?.id ??
      null,
    profileType: classifyNormalizedDefinitionZoneKind(nativeRuntimeFlags.normalizedDefinition),
    requestedShapeType: nativeRuntimeFlags.geometryType,
    serializerUsed: Array.from(payload.shapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null,
    payloadShapeType: Array.from(payload.shapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
    createdShapeType: createdShapeSummary.map((shape) => shape?.type ?? null).join(",") || null,
    regionDocumentFinal: summarizeRegionDocumentForPipeline(createdRegion)
  });
  const creationVerification = verifyV14NativeRegionCreation({
    scene,
    createdRegion,
    expectedShapeCount: 1,
    expectedHoleShapeCount: 0,
    expectedShapeType: "ring"
  });
  if (!creationVerification.valid) {
    logCastAuditLine("FINAL REGION CREATE FAILED", {
      operationId,
      sourceRegionId: regionDocument?.id ?? null,
      finalRegionId: createdRegion?.id ?? null,
      itemUuid: nativeRuntimeFlags.itemUuid ?? null,
      selectedGeometryType: nativeRuntimeFlags.geometryType,
      reason: creationVerification.reason
    });
    logCastAuditLine("SOURCE REGION RETAINED", {
      operationId,
      sourceRegionId: regionDocument?.id ?? null,
      finalRegionId: createdRegion?.id ?? null,
      itemUuid: nativeRuntimeFlags.itemUuid ?? null,
      selectedGeometryType: nativeRuntimeFlags.geometryType,
      reason: creationVerification.reason
    });
    logV14NativeRegionCreateFailure({
      stage: "post-create-verification",
      error: new Error(creationVerification.reason),
      source,
      sourceRegionId: regionDocument?.id ?? null,
      groupId: nativeRuntimeFlags.groupId ?? null,
      validation: creationVerification,
      payload
    });
    logV14RegionDiagnostic("v14NativeRegionCreateFailed", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      sourceRegionId: regionDocument?.id ?? null,
      createdRegionId: createdRegion?.id ?? null,
      groupId: nativeRuntimeFlags.groupId ?? null,
      partId: nativeRuntimeFlags.partId ?? null,
      reason: creationVerification.reason,
      v14NativeRegionCreateFailedReason: creationVerification.reason,
      v14NativeSourceRegionRetainedAfterFailure: true,
      verification: creationVerification
    });
    return {
      handled: true,
      reason: creationVerification.reason,
      runtimeFlags: null
    };
  }

  logV14RegionDiagnostic("v14NativeRegionCreated", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    sourceRegionId: regionDocument?.id ?? null,
    regionDocumentId: createdRegion?.id ?? null,
    groupId: nativeRuntimeFlags.groupId ?? null,
    partId: nativeRuntimeFlags.partId ?? null,
    regionCount: createdRegion ? 1 : 0,
    v14NativeRegionShapeCount: createdShapeSummary.length,
    v14NativeHoleShapeCount: createdShapeSummary.filter((shape) => shape?.hole).length,
    v14NativeRingRadius: createdShapeSummary[0]?.radius ?? null,
    v14NativeRingInnerWidth: createdShapeSummary[0]?.innerWidth ?? null,
    v14NativeRingOuterWidth: createdShapeSummary[0]?.outerWidth ?? null,
    createdRegionShapes: createdShapeSummary
  });
  logV14RegionDiagnostic("regionCreateSuccess", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    sourceRegionId: regionDocument?.id ?? null,
    regionDocumentId: createdRegion?.id ?? null,
    groupId: nativeRuntimeFlags.groupId ?? null,
    partId: nativeRuntimeFlags.partId ?? null,
    geometryType: "ring",
    regionSourceStrategy: nativeRuntimeFlags.regionSourceStrategy,
    v14RingStrategy: "single-native-ring-shape",
    createdRegionShapes: createdShapeSummary,
    createdRegionShapeCount: createdShapeSummary.length
  });
  logV14RegionDiagnostic("v14NativeRegionCreationVerified", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    sourceRegionId: regionDocument?.id ?? null,
    regionDocumentId: createdRegion?.id ?? null,
    groupId: nativeRuntimeFlags.groupId ?? null,
    partId: nativeRuntimeFlags.partId ?? null,
    verification: creationVerification
  });

  await syncLinkedDocumentsSafely({
    templateDocument: resolved.templateDocument,
    regionDocument: createdRegion,
    normalizedDefinition: nativeRuntimeFlags.normalizedDefinition,
    shapes: serializedShapes,
    stage: "v14-native-ring-update-in-place"
  });
  const dedicatedOwnerEffect = await ensureDedicatedOwnerEffectForNonConcentrationRegion(createdRegion, nativeRuntimeFlags, {
    sourceContext: resolved.sourceContext,
    operationId
  });
  if (dedicatedOwnerEffect) {
    nativeRuntimeFlags.ownerEffectUuid = dedicatedOwnerEffect.uuid;
    nativeRuntimeFlags.activeEffectUuid = dedicatedOwnerEffect.uuid;
    nativeRuntimeFlags.concentrationEffectUuid = null;
    registerNonConcentrationCastForGenericCleanupSuppression({
      regionDocument: createdRegion,
      runtime: nativeRuntimeFlags,
      sourceContext: resolved.sourceContext,
      operationId,
      stage: "dedicated-owner-effect-created"
    });
  }
  console.info(`[${MODULE_ID}][lifecycle] REGION LIFECYCLE LINK WRITTEN`, {
    regionId: createdRegion?.id ?? null,
    sourceRegionId: nativeRuntimeFlags.sourceRegionId ?? null,
    finalRegionId: nativeRuntimeFlags.finalRegionId ?? null,
    actorUuid: nativeRuntimeFlags.actorUuid ?? null,
    itemUuid: nativeRuntimeFlags.itemUuid ?? null,
    activityId: nativeRuntimeFlags.activityId ?? null,
    activeEffectUuid: nativeRuntimeFlags.activeEffectUuid ?? null,
    concentrationEffectUuid: nativeRuntimeFlags.concentrationEffectUuid ?? null,
    linkedDocuments: duplicateData(getRegionRuntimeFlags(createdRegion)?.linkedDocuments ?? nativeRuntimeFlags.linkedDocuments ?? null)
  });
  logCastAuditLine("SOURCE REGION UPDATED IN PLACE", {
    operationId,
    sourceRegionId: regionDocument?.id ?? null,
    finalRegionId: createdRegion?.id ?? null,
    itemUuid: nativeRuntimeFlags.itemUuid ?? null,
    profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
      nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
      nativeRuntimeFlags.normalizedDefinition?.id ??
      null,
    sourceShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
    selectedGeometryType: nativeRuntimeFlags.geometryType
  });
  logV14PipelineStep("09", "Region adopted", {
    entryPoint: "createV14NativeRegionFromResolved",
    source,
    sourceRegionId: regionDocument?.id ?? null,
    regionDocumentId: createdRegion?.id ?? null,
    sourceRemoved: false,
    sourceUpdatedInPlace: true,
    templateId: resolved.templateDocument?.id ?? null,
    templateType: getTemplateType(resolved.templateDocument),
    profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
      nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
      nativeRuntimeFlags.normalizedDefinition?.id ??
      null,
    profileType: classifyNormalizedDefinitionZoneKind(nativeRuntimeFlags.normalizedDefinition),
    requestedShapeType: nativeRuntimeFlags.geometryType,
    serializerUsed: Array.from(payload.shapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null,
    payloadShapeType: Array.from(payload.shapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
    regionDocumentFinal: summarizeRegionDocumentForPipeline(createdRegion)
  });

  logV14RegionDiagnostic("ringFlowCompleted", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    regionDocumentId: createdRegion?.id ?? null,
    sourceRegionId: regionDocument?.id ?? null,
    groupId: nativeRuntimeFlags.groupId ?? null,
    partId: nativeRuntimeFlags.partId ?? null,
    regionCount: createdRegion ? 1 : 0,
    shapeCount: createdShapeSummary.length,
    holeShapeCount: createdShapeSummary.filter((shape) => shape?.hole).length,
    v14RingStrategy: "single-native-ring-shape"
  });
  logCastAuditLine("CAST END", {
    operationId,
    sourceRegionId: regionDocument?.id ?? null,
    finalRegionId: createdRegion?.id ?? null,
    itemUuid: nativeRuntimeFlags.itemUuid ?? null,
    profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
      nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
      nativeRuntimeFlags.normalizedDefinition?.id ??
      null,
    sourceShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
    selectedGeometryType: nativeRuntimeFlags.geometryType
  });
  logV14PipelineStep("10", "Runtime attached", {
    entryPoint: "createV14NativeRegionFromResolved",
    source,
    sourceRegionId: regionDocument?.id ?? null,
    regionDocumentId: createdRegion?.id ?? null,
    templateId: resolved.templateDocument?.id ?? null,
    templateType: getTemplateType(resolved.templateDocument),
    profileId: nativeRuntimeFlags.normalizedDefinition?.selectedVariantId ??
      nativeRuntimeFlags.normalizedDefinition?.selectedVariant?.id ??
      nativeRuntimeFlags.normalizedDefinition?.id ??
      null,
    profileType: classifyNormalizedDefinitionZoneKind(nativeRuntimeFlags.normalizedDefinition),
    requestedShapeType: nativeRuntimeFlags.geometryType,
    serializerUsed: Array.from(payload.shapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null,
    payloadShapeType: Array.from(payload.shapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
    runtimeGeometryType: getRegionRuntimeFlags(createdRegion)?.geometryType ?? null,
    regionSourceStrategy: getRegionRuntimeFlags(createdRegion)?.regionSourceStrategy ?? null,
    regionDocumentFinal: summarizeRegionDocumentForPipeline(createdRegion)
  });

  await applyRegionOnCreateTrigger(createdRegion);
  if (nativeRuntimeFlags.normalizedDefinition?.obstacles?.mode === "wall-restricted") {
    await finalizeAttachedEmanationCreation(createdRegion);
  }

  return {
    handled: true,
    reason: "v14-native-ring-created",
    region: createdRegion,
    runtimeFlags: getRegionRuntimeFlags(createdRegion) ?? nativeRuntimeFlags
  };
}

async function createV14FirstRingFromRegion(regionDocument, resolved, {
  options = {},
  userId = null,
  source = "api"
} = {}) {
  const scene = regionDocument?.parent ?? null;
  const serializedShapes = buildFoundryRegionShapes(resolved?.regionShapes ?? []);
  const segmentCount = serializedShapes.length;
  const ringOperationId = buildV14RingOperationId({
    sceneId: scene?.id ?? null,
    itemUuid: resolved.runtimeFlags?.itemUuid ?? null,
    partId: resolved.runtimeFlags?.partId ?? null,
    sourceRegionId: regionDocument?.id ?? null
  });
  const ringGroupId = buildV14RingGroupId({
    scene,
    itemUuid: resolved.runtimeFlags?.itemUuid ?? null,
    partId: resolved.runtimeFlags?.partId ?? null,
    ringOperationId
  });
  const baseRuntimeFlags = buildManagedRegionRuntimeContract(resolved.runtimeFlags, {
    architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    regionDocument: null,
    sourceDocumentType: regionDocument?.documentName ?? "Region"
  });
  baseRuntimeFlags.templateId = null;
  baseRuntimeFlags.templateUuid = null;
  baseRuntimeFlags.groupId = ringGroupId;
  baseRuntimeFlags.nativeRegionId = regionDocument?.id ?? null;
  baseRuntimeFlags.sourceRegionId = regionDocument?.id ?? null;
  baseRuntimeFlags.sourceTemplateId = resolved?.templateDocument?.id ?? resolved.runtimeFlags?.templateId ?? null;
  baseRuntimeFlags.sourceTemplateUuid = resolved?.templateDocument?.uuid ?? resolved.runtimeFlags?.templateUuid ?? null;
  baseRuntimeFlags.ringOperationId = ringOperationId;
  baseRuntimeFlags.rebuild = {
    ...(baseRuntimeFlags.rebuild ?? {}),
    itemUuid: baseRuntimeFlags.itemUuid ?? null,
    groupId: ringGroupId,
    partId: baseRuntimeFlags.partId ?? null,
    architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    templateUuid: null,
    regionDocumentUuid: null
  };

  logV14RegionDiagnostic("v14RingPathSelected", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    userId,
    optionsKeys: Object.keys(options ?? {}),
    regionDocumentId: regionDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    templateId: resolved?.templateDocument?.id ?? null,
    itemUuid: baseRuntimeFlags.itemUuid ?? null,
    groupId: baseRuntimeFlags.groupId ?? null,
    partId: baseRuntimeFlags.partId ?? null,
    selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    geometryType: baseRuntimeFlags.geometryType,
    regionSourceStrategy: "v14-region-native-segment-group"
  });

  if (!scene || segmentCount < 2) {
    logV14RegionDiagnostic("v14RingGroupCreateFailed", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      reason: !scene ? "missing-parent-scene" : "missing-ring-segments",
      segmentCount
    });
    return { handled: false, reason: !scene ? "missing-parent-scene" : "missing-ring-segments" };
  }

  logV14RegionDiagnostic("v14RingStrategy", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    regionDocumentId: regionDocument?.id ?? null,
    templateId: resolved?.templateDocument?.id ?? null,
    itemUuid: baseRuntimeFlags.itemUuid ?? null,
    groupId: baseRuntimeFlags.groupId ?? null,
    partId: baseRuntimeFlags.partId ?? null,
    v14RingStrategy: "native-region-segment-group",
    ringGeometryStrategy: "multi-polygon-segments",
    ringSegmentCount: segmentCount,
    ringInnerRadius: baseRuntimeFlags.ringGeometry?.innerRadiusPixels ?? null,
    ringOuterRadius: baseRuntimeFlags.ringGeometry?.outerRadiusPixels ?? null,
    ringSegmentShapeSummary: summarizeFoundryRegionShapes(serializedShapes)
  });
  logV14RegionDiagnostic("ringSegmentGroupCreationStart", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    regionDocumentId: regionDocument?.id ?? null,
    templateId: resolved?.templateDocument?.id ?? null,
    itemUuid: baseRuntimeFlags.itemUuid ?? null,
    groupId: baseRuntimeFlags.groupId ?? null,
    partId: baseRuntimeFlags.partId ?? null,
    ringSegmentGroupCreationStart: true,
    expectedSegmentCount: segmentCount,
    ringNativeRegionDisposition: "source-only-create-segment-group"
  });
  logV14RegionDiagnostic("ringGroupCreationStart", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    regionDocumentId: regionDocument?.id ?? null,
    templateId: resolved?.templateDocument?.id ?? null,
    itemUuid: baseRuntimeFlags.itemUuid ?? null,
    groupId: baseRuntimeFlags.groupId ?? null,
    partId: baseRuntimeFlags.partId ?? null,
    ringOperationId,
    expectedSegmentCount: segmentCount
  });

  await cleanupExistingV14RingSegments(scene, {
    itemUuid: baseRuntimeFlags.itemUuid ?? null,
    partId: baseRuntimeFlags.partId ?? null,
    newGroupId: ringGroupId,
    nativeRegionId: regionDocument?.id ?? null,
    ringOperationId
  });

  const buildSegmentRuntimeFlags = (segmentIndex, segmentRegion = null) =>
    buildManagedRegionRuntimeContract({
      ...duplicateData(baseRuntimeFlags),
      architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
      templateId: null,
      templateUuid: null,
      sourceTemplateId: baseRuntimeFlags.sourceTemplateId ?? null,
      sourceTemplateUuid: baseRuntimeFlags.sourceTemplateUuid ?? null,
      groupId: ringGroupId,
      creationSource: "persistent-zones-internal-ring-segment",
      cleanupPolicy: "persistent-zone",
      skipConcentrationCleanup: true,
      lifecycle: "manual",
      ringOperationId,
      regionSourceStrategy: "v14-region-native-segment-group",
      regionSegmentIndex: segmentIndex,
      regionSegmentCount: segmentCount,
      partIndex: segmentIndex - 1,
      partCount: segmentCount
    }, {
      architecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
      regionDocument: segmentRegion,
      sourceDocumentType: segmentRegion?.documentName ?? "Region"
    });

  const firstRuntimeFlags = buildSegmentRuntimeFlags(1);
  let segmentRegions = [];
  let firstCreatedRuntimeFlags = firstRuntimeFlags;
  pendingV14RingSegmentGroups.add(firstRuntimeFlags.groupId);
  try {
    logV14RegionDiagnostic("ringNativeRegionCaptured", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      groupId: firstRuntimeFlags.groupId ?? null,
      partId: firstRuntimeFlags.partId ?? null,
      ringNativeRegionDisposition: "source-only-create-segment-group",
      ringNativeRegionRetained: false,
      ringNativeRegionIgnored: true
    });

    const segmentPayloads = serializedShapes.map((shape, segmentOffset) => {
      const segmentIndex = segmentOffset + 1;
      const runtimeFlags = buildSegmentRuntimeFlags(segmentIndex);
      return {
        name: regionDocument?.name ?? buildRegionName(runtimeFlags.normalizedDefinition, resolved.sourceContext),
        color: regionDocument?.color ?? DEFAULT_REGION_COLOR,
        hidden: false,
        elevation: coerceNumber(regionDocument?.elevation, 0),
        shapes: [shape],
        behaviors: buildNativeRegionBehaviors({
          normalizedDefinition: runtimeFlags.normalizedDefinition,
          sourceContext: resolved.sourceContext
        }),
        flags: buildManagedRegionFlags(runtimeFlags),
        [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]: runtimeFlags
      };
    });
    logV14RegionDiagnostic("ringSegmentCreatePayloadPrepared", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      groupId: firstRuntimeFlags.groupId ?? null,
      partId: firstRuntimeFlags.partId ?? null,
      ringOperationId,
      segmentCount: segmentPayloads.length,
      ringSegmentFlagsPresentAtCreation: segmentPayloads.every((payload) =>
        Boolean(payload?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY])
      ),
      payloadRegionIds: segmentPayloads.map((payload) => payload?._id ?? null)
    });

    logV14RegionDiagnostic("ringSegmentsBatchCreateStart", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      groupId: firstRuntimeFlags.groupId ?? null,
      partId: firstRuntimeFlags.partId ?? null,
      ringOperationId,
      segmentCount: segmentPayloads.length
    });
    try {
      segmentRegions = segmentPayloads.length
        ? await scene.createEmbeddedDocuments("Region", segmentPayloads, {
          persistentZonesInternalRingCreation: true,
          persistentZonesRingOperationId: ringOperationId,
          persistentZonesRingGroupId: firstRuntimeFlags.groupId
        })
        : [];
    } catch (caughtError) {
      logV14RegionDiagnostic("ringSegmentBatchCreateFailed", {
        entryPoint: "createManagedRegionFromRegion",
        source,
        regionDocumentId: regionDocument?.id ?? null,
        groupId: firstRuntimeFlags.groupId ?? null,
        partId: firstRuntimeFlags.partId ?? null,
        ringOperationId,
        segmentCount: segmentPayloads.length,
        ringSegmentBatchCreateFailedReason: caughtError?.message ?? "unknown"
      });
      throw caughtError;
    }
    logV14RegionDiagnostic("ringSegmentsBatchCreateCompleted", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      groupId: firstRuntimeFlags.groupId ?? null,
      partId: firstRuntimeFlags.partId ?? null,
      ringOperationId,
      segmentCountExpected: segmentPayloads.length,
      segmentCountCreated: Array.from(segmentRegions ?? []).length,
      regionIds: Array.from(segmentRegions ?? []).map((region) => region?.id ?? null).filter(Boolean)
    });
    for (const segmentRegion of Array.from(segmentRegions ?? [])) {
      const segmentRuntime = getRegionRuntimeFlags(segmentRegion) ?? {};
      if (!firstCreatedRuntimeFlags && segmentRuntime?.regionSegmentIndex === 1) {
        firstCreatedRuntimeFlags = segmentRuntime;
      }
      logV14RegionDiagnostic("ringSegmentFlagsPresentAtCreation", {
        entryPoint: "createManagedRegionFromRegion",
        source,
        regionDocumentId: segmentRegion?.id ?? null,
        groupId: segmentRuntime.groupId ?? firstRuntimeFlags.groupId ?? null,
        partId: segmentRuntime.partId ?? firstRuntimeFlags.partId ?? null,
        ringOperationId,
        regionSegmentIndex: segmentRuntime.regionSegmentIndex ?? null,
        regionSegmentCount: segmentRuntime.regionSegmentCount ?? segmentCount,
        ringSegmentFlagsPresentAtCreation: Boolean(segmentRuntime?.groupId && segmentRuntime?.itemUuid)
      });
      logV14RegionDiagnostic("ringInternalSegmentCreated", {
        entryPoint: "createManagedRegionFromRegion",
        source,
        regionDocumentId: segmentRegion?.id ?? null,
        groupId: segmentRuntime.groupId ?? firstRuntimeFlags.groupId ?? null,
        partId: segmentRuntime.partId ?? firstRuntimeFlags.partId ?? null,
        ringOperationId,
        regionSegmentIndex: segmentRuntime.regionSegmentIndex ?? null,
        regionSegmentCount: segmentRuntime.regionSegmentCount ?? segmentCount,
        ringInternalSegmentCreated: true
      });
    }
    logV14RegionDiagnostic("ringManagedPostWriteSkipped", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      groupId: firstRuntimeFlags.groupId ?? null,
      partId: firstRuntimeFlags.partId ?? null,
      ringOperationId,
      reason: "managed-flags-created-in-region-payload",
      segmentCount: Array.from(segmentRegions ?? []).length
    });
    await removeNativeV14RingSourceRegion(regionDocument, {
      scene,
      groupId: firstRuntimeFlags.groupId,
      partId: firstRuntimeFlags.partId,
      ringOperationId,
      source
    });
  } catch (caughtError) {
    logV14RegionDiagnostic("ringGroupCreationAborted", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      groupId: firstRuntimeFlags.groupId ?? null,
      partId: firstRuntimeFlags.partId ?? null,
      ringOperationId,
      ringGroupCreationAborted: true,
      ringGroupCreationAbortedReason: caughtError?.message ?? "unknown",
      createdSiblingCount: Array.from(segmentRegions ?? []).length
    });
    throw caughtError;
  } finally {
    pendingV14RingSegmentGroups.delete(firstRuntimeFlags.groupId);
  }

  const allRegions = Array.from(segmentRegions ?? []);
  const allRegionIds = allRegions.map((region) => region?.id ?? null).filter(Boolean);
  await wait(50);
  const ringSegmentVisibility = summarizeV14RingSegmentVisibility(allRegions);
  await refreshV14RingCanvasLayerIfNeeded(allRegions, {
    entryPoint: "createManagedRegionFromRegion",
    source,
    templateDocument: resolved.templateDocument,
    groupId: firstRuntimeFlags.groupId,
    partId: firstRuntimeFlags.partId,
    ringOperationId
  });
  await wait(250);
  const ringPostCreateState = summarizeV14RingPostCreateState(allRegionIds, {
    scene,
    originalRegions: allRegions,
    nativeRegionId: regionDocument?.id ?? null
  });
  logV14RingCanvasVisibilityDiagnostics(allRegions, {
    scene,
    groupId: firstRuntimeFlags.groupId ?? null,
    partId: firstRuntimeFlags.partId ?? null,
    ringOperationId
  });
  const ringVisualOverlay = await ensureV14RingVisualOverlayIfNeeded(allRegions, ringPostCreateState, {
    scene,
    itemUuid: firstRuntimeFlags.itemUuid ?? null,
    groupId: firstRuntimeFlags.groupId ?? null,
    partId: firstRuntimeFlags.partId ?? null,
    ringOperationId
  });
  logRingVisibilityScalarState(ringPostCreateState, {
    nativeRegionId: regionDocument?.id ?? null,
    groupId: firstRuntimeFlags.groupId ?? null,
    partId: firstRuntimeFlags.partId ?? null,
    ringOperationId
  });
  if (ringPostCreateState.ringFinalDocumentRegionIds.length === segmentCount) {
    logV14RegionDiagnostic("ringSegmentsSurvivedCleanup", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      itemUuid: firstRuntimeFlags.itemUuid ?? null,
      groupId: firstRuntimeFlags.groupId ?? null,
      partId: firstRuntimeFlags.partId ?? null,
      ringOperationId,
      segmentCount,
      sceneFound: ringPostCreateState.ringFinalDocumentRegionIds.length,
      deleted: segmentCount - ringPostCreateState.ringFinalDocumentRegionIds.length
    });
  }
  logV14RegionDiagnostic("ringPostCreateSceneState", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    templateId: resolved?.templateDocument?.id ?? null,
    itemUuid: firstRuntimeFlags.itemUuid ?? null,
    groupId: firstRuntimeFlags.groupId ?? null,
    partId: firstRuntimeFlags.partId ?? null,
    ringOperationId,
    ringSegmentDocumentIds: allRegionIds,
    ringSegmentExistsInScene: ringPostCreateState.ringSegmentExistsInScene,
    ringSegmentExistsAfterDelay: ringPostCreateState.ringSegmentExistsAfterDelay,
    ringSegmentWasDeleted: ringPostCreateState.ringSegmentWasDeleted,
    ringSegmentWasReplaced: ringPostCreateState.ringSegmentWasReplaced,
    ringNativeRegionRetained: false,
    ringNativeRegionVisible: ringPostCreateState.ringNativeRegionVisible,
    ringNativeRegionBounds: ringPostCreateState.ringNativeRegionBounds,
    ringFinalDocumentRegionIds: ringPostCreateState.ringFinalDocumentRegionIds,
    ringFinalCanvasFoundRegionIds: ringPostCreateState.ringFinalCanvasFoundRegionIds,
    ringFinalActuallyVisibleRegionIds: ringPostCreateState.ringFinalActuallyVisibleRegionIds,
    ringFinalVisibleRegionIds: ringPostCreateState.ringFinalVisibleRegionIds,
    ringVisualStrategySelected: ringVisualOverlay.strategy,
    ringVisualOverlayIds: ringVisualOverlay.drawingIds,
    ringVisualOverlayVisible: ringVisualOverlay.visibleCount
  });
  logV14RegionDiagnostic("ringPostCreateCanvasState", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    templateId: resolved?.templateDocument?.id ?? null,
    itemUuid: firstRuntimeFlags.itemUuid ?? null,
    groupId: firstRuntimeFlags.groupId ?? null,
    partId: firstRuntimeFlags.partId ?? null,
    ringOperationId,
    ringSegmentDocumentIds: allRegionIds,
    ringSegmentCanvasObjectFound: ringPostCreateState.ringSegmentCanvasObjectFound,
    ringSegmentCanvasRenderable: ringPostCreateState.ringSegmentCanvasRenderable,
    ringSegmentCanvasVisible: ringPostCreateState.ringSegmentCanvasVisible,
    ringNativeRegionCanvasObjectFound: ringPostCreateState.ringNativeRegionCanvasObjectFound,
    ringNativeRegionCanvasVisible: ringPostCreateState.ringNativeRegionCanvasVisible,
    ringFinalDocumentRegionIds: ringPostCreateState.ringFinalDocumentRegionIds,
    ringFinalCanvasFoundRegionIds: ringPostCreateState.ringFinalCanvasFoundRegionIds,
    ringFinalActuallyVisibleRegionIds: ringPostCreateState.ringFinalActuallyVisibleRegionIds,
    ringFinalVisibleRegionIds: ringPostCreateState.ringFinalVisibleRegionIds,
    ringVisualStrategySelected: ringVisualOverlay.strategy,
    ringVisualOverlayIds: ringVisualOverlay.drawingIds,
    ringVisualOverlayVisible: ringVisualOverlay.visibleCount
  });
  logV14RegionDiagnostic("v14RingGroupCreated", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    templateId: resolved?.templateDocument?.id ?? null,
    itemUuid: firstRuntimeFlags.itemUuid ?? null,
    groupId: firstRuntimeFlags.groupId ?? null,
    partId: firstRuntimeFlags.partId ?? null,
    partCountExpected: segmentCount,
    partCountCreated: allRegions.length,
    regionSegmentCountExpected: segmentCount,
    regionSegmentCountCreated: allRegions.length,
    regionSegmentDocumentIds: allRegionIds,
    ringSegmentDocumentIds: allRegionIds,
    ringSegmentExistsInScene: ringPostCreateState.ringSegmentExistsInScene,
    ringSegmentExistsAfterDelay: ringPostCreateState.ringSegmentExistsAfterDelay,
    ringSegmentWasDeleted: ringPostCreateState.ringSegmentWasDeleted,
    ringSegmentWasReplaced: ringPostCreateState.ringSegmentWasReplaced,
    ...ringSegmentVisibility,
    regionSegmentShapes: allRegions.map((region) => ({
      regionId: region?.id ?? null,
      shapes: summarizeRegionDocumentShapes(region)
    }))
  });
  logV14RegionDiagnostic("ringSegmentGroupCreationCompleted", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    templateId: resolved?.templateDocument?.id ?? null,
    itemUuid: firstRuntimeFlags.itemUuid ?? null,
    groupId: firstRuntimeFlags.groupId ?? null,
    partId: firstRuntimeFlags.partId ?? null,
    ringSegmentGroupCreationCompleted: true,
    expectedSegmentCount: segmentCount,
    createdSegmentCount: allRegions.length,
    regionIds: allRegionIds
  });
  logV14RegionDiagnostic("ringGroupCreationCompleted", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    templateId: resolved?.templateDocument?.id ?? null,
    itemUuid: firstRuntimeFlags.itemUuid ?? null,
    groupId: firstRuntimeFlags.groupId ?? null,
    partId: firstRuntimeFlags.partId ?? null,
    ringOperationId,
    expectedSegmentCount: segmentCount,
    createdSegmentCount: allRegions.length,
    regionIds: allRegionIds,
    ringSegmentDocumentIds: allRegionIds,
    ringSegmentExistsInScene: ringPostCreateState.ringSegmentExistsInScene,
    ringSegmentExistsAfterDelay: ringPostCreateState.ringSegmentExistsAfterDelay,
    ringSegmentWasDeleted: ringPostCreateState.ringSegmentWasDeleted,
    ringSegmentWasReplaced: ringPostCreateState.ringSegmentWasReplaced,
    ringFinalDocumentRegionIds: ringPostCreateState.ringFinalDocumentRegionIds,
    ringFinalCanvasFoundRegionIds: ringPostCreateState.ringFinalCanvasFoundRegionIds,
    ringFinalActuallyVisibleRegionIds: ringPostCreateState.ringFinalActuallyVisibleRegionIds,
    ringFinalVisibleRegionIds: ringPostCreateState.ringFinalVisibleRegionIds,
    ...ringSegmentVisibility
  });
  logV14RegionDiagnostic("ringNativeRegionDisposition", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    regionDocumentId: regionDocument?.id ?? null,
    groupId: firstRuntimeFlags.groupId ?? null,
    ringNativeRegionDisposition: "removed-after-segment-group-created",
    ringNativeRegionRetained: false,
    ringNativeRegionRemoved: true,
    ringNativeRegionIgnored: true,
    ringNativeRegionVisible: ringPostCreateState.ringNativeRegionVisible,
    ringNativeRegionBounds: ringPostCreateState.ringNativeRegionBounds,
    ringNativeRegionCanvasObjectFound: ringPostCreateState.ringNativeRegionCanvasObjectFound,
    ringNativeRegionCanvasVisible: ringPostCreateState.ringNativeRegionCanvasVisible
  });
  logV14RegionDiagnostic("v14RingRegionCreated", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    regionDocumentId: allRegions[0]?.id ?? null,
    siblingRegionIds: allRegions.slice(1).map((region) => region?.id ?? null).filter(Boolean),
    nativeRegionId: regionDocument?.id ?? null,
    selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    regionSourceStrategy: "v14-region-native-segment-group"
  });
  logV14RegionDiagnostic("ringFlowCompleted", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    regionDocumentId: regionDocument?.id ?? null,
    groupId: firstRuntimeFlags.groupId ?? null,
    partId: firstRuntimeFlags.partId ?? null,
    ringOperationId,
    ringFlowCompleted: true,
    createdSegmentCount: allRegions.length
  });

  return {
    handled: true,
    reason: "v14-ring-managed-region-group-created",
    runtimeFlags: firstCreatedRuntimeFlags ?? firstRuntimeFlags,
    templateDocument: resolved.templateDocument,
    sourceContext: resolved.sourceContext,
    createdRegions: allRegions
  };
}

function isV14FirstRingResolved(resolved) {
  if (!isFoundryV14OrNewer() || !resolved?.runtimeFlags) {
    return false;
  }

  const geometryType = resolveResolvedProfileGeometryType(resolved);
  const regionSourceStrategy = String(resolved.runtimeFlags.regionSourceStrategy ?? "").toLowerCase();
  // Legacy segmented rings are intentionally disabled for the V14-native ring shape path.
  return false && geometryType === "ring" &&
    regionSourceStrategy === "v14-region-native-segment-group" &&
    Array.isArray(resolved.regionShapes) &&
    resolved.regionShapes.length > 1;
}

function buildV14NativeRingShapesFromResolved(resolved, sourceRegionDocument = null) {
  const templateDocument = resolved?.templateDocument ?? null;
  const runtimeFlags = resolved?.runtimeFlags ?? {};
  const runtimePart = resolved?.profilePart ?? resolveSingleRegionRuntimePart(runtimeFlags.normalizedDefinition);
  const geometry = runtimePart?.geometry ?? runtimeFlags.normalizedDefinition?.geometry ?? {};
  const radii = resolveRingBandRadiiForTemplate(templateDocument, geometry);
  const runtimeGeometry = buildRingRuntimeGeometry(templateDocument, {
    ...radii,
    sourceType: "ring",
    resolutionMode: radii.resolutionMode
  }) ?? runtimeFlags.ringGeometry ?? null;
  const sourceShape = readNativeCircleLikeSourceShape(sourceRegionDocument) ?? null;
  const centerX = coerceNumber(sourceShape?.x ?? runtimeGeometry?.centerX ?? templateDocument?.x, 0);
  const centerY = coerceNumber(sourceShape?.y ?? runtimeGeometry?.centerY ?? templateDocument?.y, 0);
  const sourceRadiusPixels = coercePositiveNumber(sourceShape?.radius, null);
  const outerRadiusPixels = sourceRadiusPixels ?? coercePositiveNumber(runtimeGeometry?.outerRadiusPixels, 0);
  const thicknessResolution = resolveNativeRingThicknessPixels({
    geometry,
    sourceRegion: sourceRegionDocument,
    sourceRadiusPixels: outerRadiusPixels,
    scene: templateDocument?.parent ?? sourceRegionDocument?.parent ?? null
  });
  const { radius, innerWidth, outerWidth, radiusMapping } = resolveV14NativeRingWidths({
    geometry,
    sourceRadiusPixels: outerRadiusPixels,
    thicknessPixels: thicknessResolution.thicknessPixels,
    scene: templateDocument?.parent ?? sourceRegionDocument?.parent ?? null
  });
  const rawShape = {
    x: centerX,
    y: centerY,
    radius,
    innerWidth,
    outerWidth,
    hole: false,
    gridBased: false
  };
  const ringShape = serializeNativeRingShape({
    type: "ring",
    ...rawShape
  });
  logV14NativeRingValues({
    templateDocument,
    geometry,
    radii,
    runtimeGeometry,
    sourceShape,
    rawShape,
    serializedShape: ringShape,
    sourceRadiusPixels,
    outerRadiusPixels,
    innerRadiusPixels: null,
    bandWidthPixels: thicknessResolution.thicknessPixels,
    thicknessResolution,
    radiusMapping
  });
  try {
    compareAutomaticRingWithDebugRing({
      sourceRegion: sourceRegionDocument,
      normalizedGeometry: geometry,
      automaticShape: ringShape
    });
  } catch (caughtError) {
    console.debug(`[${MODULE_ID}] ring debug comparison failed`, caughtError);
  }

  logV14RegionDiagnostic("v14NativeSourceShapeRead", {
    regionDocumentId: sourceRegionDocument?.id ?? null,
    v14NativeSourceShapeType: sourceShape?.type ?? null,
    v14NativeSourceRadius: sourceShape?.radius ?? null,
    v14NativeRingShapeSelected: true,
    v14NativeRingRadius: ringShape?.radius ?? null,
    v14NativeRingInnerWidth: ringShape?.innerWidth ?? null,
    v14NativeRingOuterWidth: ringShape?.outerWidth ?? null,
    v14NativeRingPayloadPrepared: true,
    ringFinalRadius: ringShape?.radius ?? null,
    ringFinalInnerWidth: ringShape?.innerWidth ?? null,
    ringFinalOuterWidth: ringShape?.outerWidth ?? null,
    ringThicknessResolution: duplicateData(thicknessResolution ?? null),
    ringOuterRadius: outerRadiusPixels,
    ringGeometry: duplicateData(runtimeGeometry ?? null)
  });

  if (!ringShape) {
    return [];
  }

  return [ringShape];
}

function readNativeCircleLikeSourceShape(regionDocument) {
  const sourceShapes = summarizeRegionDocumentRawShapes(regionDocument);
  const shape = Array.from(sourceShapes ?? []).find((candidate) => {
    const type = String(candidate?.type ?? "").toLowerCase();
    return type === "circle" || type === "ellipse" || type === "ring";
  }) ?? null;
  if (!shape) {
    return null;
  }

  const type = String(shape.type ?? "").toLowerCase();
  const radius = coerceNumber(
    shape.radius,
    Math.max(coerceNumber(shape.radiusX, 0), coerceNumber(shape.radiusY, 0))
  );
  const ringOuterWidth = type === "ring" ? Math.max(0, coerceNumber(shape.outerWidth, 0)) : 0;
  const width = coerceNumber(shape.width, null);
  const height = coerceNumber(shape.height, null);
  const finalRadius = (radius ? radius + ringOuterWidth : radius) ||
    (width !== null && height !== null ? Math.max(width, height) / 2 : null);
  if (!finalRadius) {
    return null;
  }

  return {
    type,
    x: shape.cx !== undefined
      ? coerceNumber(shape.cx, 0)
      : width !== null && shape.radiusX === undefined
        ? coerceNumber(shape.x, 0) + finalRadius
        : coerceNumber(shape.x, 0),
    y: shape.cy !== undefined
      ? coerceNumber(shape.cy, 0)
      : height !== null && shape.radiusY === undefined
        ? coerceNumber(shape.y, 0) + finalRadius
        : coerceNumber(shape.y, 0),
    radius: finalRadius,
    rotation: coerceNumber(shape.rotation, 0),
    bounds: calculateShapeBounds({
      type: "circle",
      x: shape.cx !== undefined ? coerceNumber(shape.cx, 0) : coerceNumber(shape.x, 0),
      y: shape.cy !== undefined ? coerceNumber(shape.cy, 0) : coerceNumber(shape.y, 0),
      radius: finalRadius,
      rotation: coerceNumber(shape.rotation, 0)
    })
  };
}

export function resolveV14NativeRingWidths({
  geometry = {},
  sourceRadiusPixels = 0,
  thicknessPixels = null,
  scene = null
} = {}) {
  const referenceRadiusMode = String(geometry?.referenceRadiusMode ?? geometry?.radiusReference ?? "outer-edge").toLowerCase();
  const resolvedRadius = Math.max(0, coerceNumber(sourceRadiusPixels, 0));
  if (String(geometry?.widthSemantics ?? "").toLowerCase() === "independent") {
    const independentRadius = distanceToPixels(
      Math.max(0, coerceNumber(geometry?.referenceRadius, 0)),
      scene
    ) || resolvedRadius;
    return {
      radius: independentRadius,
      innerWidth: distanceToPixels(Math.max(0, coerceNumber(geometry?.innerWidth, 0)), scene),
      outerWidth: distanceToPixels(Math.max(0, coerceNumber(geometry?.outerWidth, 0)), scene),
      radiusMapping: "independent-widths"
    };
  }
  const resolvedThickness = Math.max(0, coerceNumber(thicknessPixels, 0));
  if (referenceRadiusMode === "centerline" || referenceRadiusMode === "center-line") {
    const halfWidth = resolvedThickness / 2;
    return {
      radius: resolvedRadius,
      innerWidth: halfWidth,
      outerWidth: halfWidth,
      radiusMapping: "centerline"
    };
  }
  if (referenceRadiusMode === "inner-edge" || referenceRadiusMode === "inner") {
    return {
      radius: resolvedRadius,
      innerWidth: 0,
      outerWidth: resolvedThickness,
      radiusMapping: "inner-edge"
    };
  }

  return {
    radius: resolvedRadius,
    innerWidth: resolvedThickness,
    outerWidth: 0,
    radiusMapping: "outer-edge"
  };
}

function validateV14NativeRingShapes(shapes = []) {
  if (Array.from(shapes ?? []).length !== 1) {
    return { valid: false, reason: "ring-native-shape-count-not-one" };
  }

  const [shape] = shapes;
  if (shape?.type !== "ring") {
    return { valid: false, reason: "ring-native-shape-not-ring" };
  }

  for (const field of ["x", "y", "radius", "innerWidth", "outerWidth"]) {
    if (!Number.isFinite(Number(shape?.[field]))) {
      return {
        valid: false,
        reason: `ring-native-${field}-invalid`,
        invalidField: field,
        invalidValue: shape?.[field] ?? null,
        invalidValueType: typeof shape?.[field]
      };
    }
  }

  if (Number(shape.radius) <= 0) {
    return {
      valid: false,
      reason: "ring-native-radius-invalid",
      invalidField: "radius",
      invalidValue: shape.radius,
      invalidValueType: typeof shape.radius
    };
  }
  if (Number(shape.innerWidth) < 0) {
    return {
      valid: false,
      reason: "ring-native-inner-width-invalid",
      invalidField: "innerWidth",
      invalidValue: shape.innerWidth,
      invalidValueType: typeof shape.innerWidth
    };
  }
  if (Number(shape.outerWidth) < 0) {
    return {
      valid: false,
      reason: "ring-native-outer-width-invalid",
      invalidField: "outerWidth",
      invalidValue: shape.outerWidth,
      invalidValueType: typeof shape.outerWidth
    };
  }
  if (Number(shape.innerWidth) + Number(shape.outerWidth) <= 0) {
    return {
      valid: false,
      reason: "ring-native-total-width-zero",
      invalidField: "innerWidth+outerWidth",
      invalidValue: Number(shape.innerWidth) + Number(shape.outerWidth),
      invalidValueType: "number"
    };
  }

  return { valid: true, reason: null };
}

function validateV14NativeRingCreatePayload(payload) {
  const shape = Array.from(payload?.shapes ?? [])[0] ?? null;
  if (!shape) {
    return { valid: false, reason: "ring-native-payload-shape-missing", invalidField: "shapes[0]", invalidValue: null };
  }
  if (shape.type !== "ring") {
    return { valid: false, reason: "ring-native-payload-shape-not-ring", invalidField: "shapes[0].type", invalidValue: shape.type ?? null };
  }

  for (const field of ["x", "y", "radius", "innerWidth", "outerWidth"]) {
    const value = Number(shape[field]);
    if (!Number.isFinite(value)) {
      return {
        valid: false,
        reason: `ring-native-payload-${field}-not-finite`,
        invalidField: `shapes[0].${field}`,
        invalidValue: shape[field] ?? null
      };
    }
  }

  const radius = Number(shape.radius);
  const innerWidth = Number(shape.innerWidth);
  const outerWidth = Number(shape.outerWidth);
  if (radius <= 0) {
    return { valid: false, reason: "ring-native-payload-radius-not-positive", invalidField: "shapes[0].radius", invalidValue: shape.radius };
  }
  if (innerWidth < 0) {
    return { valid: false, reason: "ring-native-payload-innerWidth-negative", invalidField: "shapes[0].innerWidth", invalidValue: shape.innerWidth };
  }
  if (outerWidth < 0) {
    return { valid: false, reason: "ring-native-payload-outerWidth-negative", invalidField: "shapes[0].outerWidth", invalidValue: shape.outerWidth };
  }
  if (innerWidth + outerWidth <= 0) {
    return { valid: false, reason: "ring-native-payload-band-width-empty", invalidField: "shapes[0].innerWidth+outerWidth", invalidValue: innerWidth + outerWidth };
  }

  return { valid: true, reason: null, invalidField: null, invalidValue: null };
}

function resolveNativeRingThicknessPixels({
  geometry = {},
  sourceRegion = null,
  sourceRadiusPixels = null,
  scene = null
} = {}) {
  const rawWallThickness = geometry?.wallThickness ?? geometry?.thickness ?? geometry?.bandThickness ?? null;
  const explicitUnit = geometry?.wallThicknessUnit ?? geometry?.thicknessUnit ?? geometry?.unit ?? null;
  const sourceScene = scene ?? sourceRegion?.parent ?? canvas?.scene ?? null;
  const gridDistance = coercePositiveNumber(sourceScene?.grid?.distance, coercePositiveNumber(canvas?.dimensions?.distance, null));
  const gridSize = coercePositiveNumber(sourceScene?.grid?.size, coercePositiveNumber(canvas?.dimensions?.size, null));
  const inferredUnit = explicitUnit ?? inferNativeRingThicknessUnit({ geometry, rawWallThickness });
  const thicknessFromRatio = coerceNumber(geometry?.thicknessRatio ?? geometry?.wallThicknessRatio ?? geometry?.bandThicknessRatio, null);
  const innerRadiusRatio = coerceNumber(geometry?.innerRadiusRatio ?? geometry?.innerRatio, null);
  let thicknessSceneUnits = null;
  let thicknessPixels = null;
  let reason = null;

  if (coerceNumber(rawWallThickness, null) !== null) {
    const rawNumeric = coerceNumber(rawWallThickness, null);
    if (inferredUnit === "scene-units") {
      thicknessSceneUnits = rawNumeric;
      thicknessPixels = gridDistance && gridSize ? rawNumeric * (gridSize / gridDistance) : null;
    } else if (inferredUnit === "pixels") {
      thicknessPixels = rawNumeric;
      thicknessSceneUnits = gridDistance && gridSize ? rawNumeric / gridSize * gridDistance : null;
    } else if (inferredUnit === "dnd5e-feet") {
      thicknessSceneUnits = gridDistance ? rawNumeric / 5 * gridDistance : null;
      thicknessPixels = gridSize ? rawNumeric / 5 * gridSize : null;
    } else {
      reason = "ring-native-thickness-unit-unresolved";
    }
  } else if (thicknessFromRatio !== null && coercePositiveNumber(sourceRadiusPixels, null) !== null) {
    thicknessPixels = Math.max(0, sourceRadiusPixels * thicknessFromRatio);
    thicknessSceneUnits = gridDistance && gridSize ? thicknessPixels / gridSize * gridDistance : null;
    reason = "thickness-ratio";
  } else if (innerRadiusRatio !== null && coercePositiveNumber(sourceRadiusPixels, null) !== null) {
    thicknessPixels = Math.max(0, sourceRadiusPixels * (1 - innerRadiusRatio));
    thicknessSceneUnits = gridDistance && gridSize ? thicknessPixels / gridSize * gridDistance : null;
    reason = "inner-radius-ratio";
  } else {
    reason = "ring-native-thickness-unit-unresolved";
  }

  return {
    wallThicknessRaw: rawWallThickness,
    wallThicknessUnit: inferredUnit,
    wallThicknessSceneUnits: thicknessSceneUnits,
    wallThicknessPixels: thicknessPixels,
    sourceRadiusPixels,
    sourceRadiusSceneUnits: gridDistance && gridSize && sourceRadiusPixels !== null
      ? sourceRadiusPixels / gridSize * gridDistance
      : null,
    gridDistance,
    gridSize,
    reason,
    thicknessPixels: coercePositiveNumber(thicknessPixels, null)
  };
}

function inferNativeRingThicknessUnit({ geometry = {}, rawWallThickness = null } = {}) {
  if (rawWallThickness === null || rawWallThickness === undefined || rawWallThickness === "") {
    return null;
  }
  if (geometry?.sourceUnit) {
    return geometry.sourceUnit;
  }
  if (globalThis.game?.system?.id === "dnd5e") {
    return "dnd5e-feet";
  }
  return null;
}

function coercePositiveNumber(value, fallback = null) {
  const numericValue = coerceNumber(value, null);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback;
}

function logV14NativeRingValues({
  templateDocument = null,
  geometry = {},
  radii = {},
  runtimeGeometry = null,
  sourceShape = null,
  rawShape = null,
  serializedShape = null,
  sourceRadiusPixels = null,
  outerRadiusPixels = null,
  innerRadiusPixels = null,
  bandWidthPixels = null,
  thicknessResolution = null,
  radiusMapping = null
} = {}) {
  const scene = templateDocument?.parent ?? canvas?.scene ?? null;
  const gridDistance = scene?.grid?.distance ?? canvas?.dimensions?.distance ?? null;
  const gridSize = scene?.grid?.size ?? canvas?.dimensions?.size ?? null;
  const values = [
    ["sourceTemplateRadius", templateDocument?.distance, "scene-units"],
    ["normalizedTemplateRadius", radii?.templateRadius ?? geometry?.templateRadius ?? geometry?.referenceRadius ?? null, "scene-units"],
    ["referenceRadiusMode", geometry?.referenceRadiusMode ?? geometry?.radiusReference ?? "outer-edge", "enum"],
    ["referenceRadius", geometry?.referenceRadius ?? geometry?.templateRadius ?? radii?.templateRadius ?? null, "scene-units"],
    ["wallThickness", geometry?.wallThickness ?? geometry?.thickness ?? geometry?.bandThickness ?? null, "scene-units"],
    ["rawShapeRadius", rawShape?.radius ?? null, "pixels"],
    ["rawShapeInnerWidth", rawShape?.innerWidth ?? null, "pixels"],
    ["rawShapeOuterWidth", rawShape?.outerWidth ?? null, "pixels"],
    ["serializedRadius", serializedShape?.radius ?? null, "pixels"],
    ["serializedInnerWidth", serializedShape?.innerWidth ?? null, "pixels"],
    ["serializedOuterWidth", serializedShape?.outerWidth ?? null, "pixels"],
    ["sourceGridDistance", gridDistance, "scene-units-per-grid"],
    ["sourceGridSize", gridSize, "pixels-per-grid"],
    ["sourceShapeRadius", sourceShape?.radius ?? null, "pixels"],
    ["sourceRadiusPixelsSelected", sourceRadiusPixels, "pixels"],
    ["runtimeOuterRadiusPixels", runtimeGeometry?.outerRadiusPixels ?? null, "pixels"],
    ["runtimeInnerRadiusPixels", runtimeGeometry?.innerRadiusPixels ?? null, "pixels"],
    ["selectedOuterRadiusPixels", outerRadiusPixels, "pixels"],
    ["selectedInnerRadiusPixels", innerRadiusPixels, "pixels"],
    ["selectedBandWidthPixels", bandWidthPixels, "pixels"],
    ["wallThicknessRaw", thicknessResolution?.wallThicknessRaw ?? geometry?.wallThickness ?? geometry?.thickness ?? geometry?.bandThickness ?? null, "profile-units"],
    ["wallThicknessUnit", thicknessResolution?.wallThicknessUnit ?? null, "unit"],
    ["wallThicknessSceneUnits", thicknessResolution?.wallThicknessSceneUnits ?? null, "scene-units"],
    ["wallThicknessPixels", thicknessResolution?.wallThicknessPixels ?? null, "pixels"],
    ["sourceRadiusPixels", thicknessResolution?.sourceRadiusPixels ?? sourceRadiusPixels, "pixels"],
    ["sourceRadiusSceneUnits", thicknessResolution?.sourceRadiusSceneUnits ?? null, "scene-units"],
    ["widthMappingMode", radiusMapping, "strategy"],
    ["finalRadius", serializedShape?.radius ?? null, "pixels"],
    ["finalInnerWidth", serializedShape?.innerWidth ?? null, "pixels"],
    ["finalOuterWidth", serializedShape?.outerWidth ?? null, "pixels"],
    ["radiusMapping", radiusMapping, "strategy"]
  ];

  for (const [label, value, unit] of values) {
    const numericValue = Number(value);
    console.info(
      `[${MODULE_ID}][ring-values] ${label}=${value ?? "null"} | type=${typeof value} | finite=${Number.isFinite(numericValue)} | unit=${unit}`
    );
  }
  if (thicknessResolution?.reason === "ring-native-thickness-unit-unresolved") {
    console.warn(
      `[${MODULE_ID}][ring-values] ring-native-thickness-unit-unresolved | wallThicknessRaw=${thicknessResolution.wallThicknessRaw ?? "null"} | wallThicknessUnit=${thicknessResolution.wallThicknessUnit ?? "null"} | sourceRadiusPixels=${thicknessResolution.sourceRadiusPixels ?? "null"}`
    );
  }
}

function compareAutomaticRingWithDebugRing({
  sourceRegion = null,
  normalizedGeometry = null,
  automaticShape = null
} = {}) {
  const sourceShape = readNativeCircleLikeSourceShape(sourceRegion);
  const debugShape = serializeNativeRingShape({
    type: "ring",
    x: coerceNumber(sourceShape?.x ?? automaticShape?.x, 0),
    y: coerceNumber(sourceShape?.y ?? automaticShape?.y, 0),
    radius: coercePositiveNumber(sourceShape?.radius, automaticShape?.radius ?? 300),
    innerWidth: 80,
    outerWidth: 80,
    hole: false,
    gridBased: false
  });
  const fields = ["type", "x", "y", "radius", "innerWidth", "outerWidth", "hole", "gridBased"];
  const differences = fields
    .map((field) => ({
      field,
      debugValue: debugShape?.[field],
      automaticValue: automaticShape?.[field],
      missingAutomatic: automaticShape?.[field] === undefined,
      automaticIsNaN: typeof automaticShape?.[field] === "number" && Number.isNaN(automaticShape[field]),
      same: debugShape?.[field] === automaticShape?.[field]
    }))
    .filter((entry) => !entry.same || entry.missingAutomatic || entry.automaticIsNaN);

  console.info(`[${MODULE_ID}][ring-values] compareAutomaticRingWithDebugRing differences=${differences.length}`, {
    debugShape,
    automaticShape,
    normalizedGeometry: duplicateData(normalizedGeometry ?? null),
    differences,
    unitNotes: {
      debugShape: "pixels from selected/source Region plus fixed debug widths",
      automaticShape: "pixels from source Region radius plus profile-derived widths"
    }
  });
  return {
    debugShape,
    automaticShape,
    differences
  };
}

function verifyV14NativeRegionCreation({
  scene = null,
  createdRegion = null,
  expectedShapeCount = null,
  expectedHoleShapeCount = null,
  expectedShapeType = null
} = {}) {
  if (!createdRegion?.id) {
    return { valid: false, reason: "created-region-missing-id" };
  }

  const sceneRegion = scene?.regions?.get?.(createdRegion.id) ??
    scene?.regions?.contents?.find((region) => region?.id === createdRegion.id) ??
    null;
  if (!sceneRegion) {
    return { valid: false, reason: "created-region-not-found-in-scene", regionId: createdRegion.id };
  }

  const shapes = summarizeRegionDocumentRawShapes(sceneRegion);
  const shapeCount = Array.from(shapes ?? []).length;
  const holeShapeCount = Array.from(shapes ?? []).filter((shape) => shape?.hole).length;
  if (expectedShapeCount !== null && shapeCount !== expectedShapeCount) {
    return { valid: false, reason: "created-region-shape-count-mismatch", regionId: createdRegion.id, shapeCount, expectedShapeCount };
  }
  if (expectedHoleShapeCount !== null && holeShapeCount !== expectedHoleShapeCount) {
    return { valid: false, reason: "created-region-hole-count-mismatch", regionId: createdRegion.id, holeShapeCount, expectedHoleShapeCount };
  }
  if (expectedShapeType !== null) {
    const createdShapeType = String(Array.from(shapes ?? [])[0]?.type ?? "").toLowerCase();
    const expectedType = String(expectedShapeType ?? "").toLowerCase();
    if (createdShapeType !== expectedType) {
      return { valid: false, reason: "created-region-shape-type-mismatch", regionId: createdRegion.id, createdShapeType, expectedShapeType };
    }
  }

  return {
    valid: true,
    reason: null,
    regionId: createdRegion.id,
    shapeCount,
    holeShapeCount,
    shapeTypes: Array.from(shapes ?? []).map((shape) => shape?.type ?? null),
    existsInScene: true
  };
}

function buildV14NativeRegionGroupId({
  scene = null,
  itemUuid = null,
  partId = null,
  geometryType = "template",
  sourceRegionId = null
} = {}) {
  return [
    MODULE_ID,
    "v14-native",
    scene?.id ?? "scene",
    itemUuid ?? "item",
    geometryType ?? "geometry",
    partId ?? "primary",
    sourceRegionId ?? "source"
  ].join(".");
}

function detectInternalV14NativeRegionHook(regionDocument, options = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? null;
  const optionsSuppressed = Boolean(options?.persistentZonesV14NativeRegionCreation);
  const debugNativeRingSuppressed = Boolean(options?.persistentZonesDebugNativeRingFromSelectedRegion);
  const runtimeSuppressed = runtime?.creationSource === "persistent-zones-v14-native-region" ||
    runtime?.regionSourceStrategy === "v14-native-region-shapes";
  if (!optionsSuppressed && !debugNativeRingSuppressed && !runtimeSuppressed) {
    return { suppressed: false };
  }

  return {
    suppressed: true,
    reason: debugNativeRingSuppressed
      ? "debug-native-ring-operation"
      : optionsSuppressed
        ? "internal-v14-native-create-option"
        : "internal-v14-native-runtime-flags",
    groupId: options?.persistentZonesV14NativeGroupId ?? runtime?.groupId ?? null,
    partId: runtime?.partId ?? null
  };
}

async function removeNativeV14SourceRegion(regionDocument, {
  scene = null,
  groupId = null,
  partId = null,
  source = "api"
} = {}) {
  if (!scene || !regionDocument?.id) {
    return false;
  }

  try {
    await scene.deleteEmbeddedDocuments("Region", [regionDocument.id], {
      persistentZonesCleanup: true,
      persistentZonesV14NativeSourceRemoval: true
    });
    logV14RegionDiagnostic("v14NativeSourceRegionRemoved", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument.id,
      groupId,
      partId,
      ringNativeRegionDisposition: "removed-after-native-region-created"
    });
    logV14RegionDiagnostic("v14NativeSourceRegionRemovedAfterSuccess", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument.id,
      groupId,
      partId,
      ringNativeRegionDisposition: "removed-after-native-region-created"
    });
    return true;
  } catch (caughtError) {
    logV14RegionDiagnostic("v14NativeSourceRegionRemoveFailed", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument.id,
      groupId,
      partId,
      reason: caughtError?.message ?? "unknown"
    });
    return false;
  }
}

function isManagedV14FirstRingRuntime(runtimeFlags) {
  if (!isFoundryV14OrNewer() || !runtimeFlags) {
    return false;
  }

  const architecturePath = String(runtimeFlags.architecturePath ?? "").toLowerCase();
  const geometryType = String(
    runtimeFlags.geometryType ??
    runtimeFlags.normalizedDefinition?.geometry?.type ??
    ""
  ).toLowerCase();
  const regionSourceStrategy = String(runtimeFlags.regionSourceStrategy ?? "").toLowerCase();
  return architecturePath === REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE &&
    geometryType === "ring" &&
    regionSourceStrategy === "v14-region-native-segment-group";
}

function buildV14RingOperationId(runtimeFlags = {}) {
  return [
    MODULE_ID,
    "v14-ring",
    runtimeFlags.sceneId ?? "scene",
    runtimeFlags.itemUuid ?? "item",
    runtimeFlags.partId ?? "part",
    runtimeFlags.sourceRegionId ?? "region",
    Date.now(),
    Math.random().toString(36).slice(2, 8)
  ].join(":");
}

function buildV14RingGroupId({
  scene = null,
  itemUuid = null,
  partId = null,
  ringOperationId = null
} = {}) {
  return [
    MODULE_ID,
    REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
    "ring",
    scene?.id ?? "scene",
    sanitizeGroupIdComponent(itemUuid ?? "item"),
    sanitizeGroupIdComponent(partId ?? "part"),
    sanitizeGroupIdComponent(ringOperationId ?? Date.now())
  ].join(":");
}

async function cleanupExistingV14RingSegments(scene, {
  itemUuid = null,
  partId = null,
  newGroupId = null,
  nativeRegionId = null,
  ringOperationId = null
} = {}) {
  if (!scene || !itemUuid || !partId || typeof scene.deleteEmbeddedDocuments !== "function") {
    return [];
  }

  const cleanupKey = [
    scene?.id ?? "scene",
    newGroupId ?? "group",
    nativeRegionId ?? "region",
    ringOperationId ?? "operation"
  ].join("|");
  if (pendingV14RingCleanupKeys.has(cleanupKey)) {
    logV14RingSegmentCleanupDecision({
      scene,
      operationId: ringOperationId,
      currentRegionId: nativeRegionId,
      currentSourceRegionId: nativeRegionId,
      currentGroupId: newGroupId,
      candidateDecisions: [],
      deletionIds: [],
      cleanupReentrant: true,
      cleanupSkippedReason: "cleanup-already-running-for-operation"
    });
    return [];
  }

  pendingV14RingCleanupKeys.add(cleanupKey);
  let regionIds = [];
  try {
    const candidateDecisions = listSceneRegions(scene)
      .map((regionDocument) => buildV14RingSegmentCleanupCandidateDecision(regionDocument, {
        itemUuid,
        partId,
        newGroupId,
        nativeRegionId
      }));
    regionIds = candidateDecisions
      .filter((decision) => decision.delete)
      .map((decision) => decision.regionId)
      .filter(Boolean);

    logV14RingSegmentCleanupDecision({
      scene,
      operationId: ringOperationId,
      currentRegionId: nativeRegionId,
      currentSourceRegionId: nativeRegionId,
      currentGroupId: newGroupId,
      candidateDecisions,
      deletionIds: regionIds,
      cleanupReentrant: false,
      cleanupSkippedReason: regionIds.length ? null : "no-exact-v14-ring-segment-match"
    });

    if (!regionIds.length) {
      logV14RegionDiagnostic("v14RingLegacyCleanupSkipped", {
        entryPoint: "createManagedRegionFromRegion",
        sceneId: scene?.id ?? null,
        itemUuid,
        partId,
        newGroupId,
        ringOperationId,
        reason: "no-exact-v14-ring-segment-match"
      });
      return [];
    }

    const deletedGroupIds = Array.from(new Set(candidateDecisions
      .filter((decision) => decision.delete)
      .map((decision) => decision.groupId)
      .filter(Boolean)));
    for (const groupId of deletedGroupIds) {
      await cleanupExistingV14RingVisualOverlays(scene, {
        groupId,
        ringOperationId,
        reason: "replace-exact-v14-ring-segments"
      });
    }

    await scene.deleteEmbeddedDocuments("Region", regionIds, {
      persistentZonesCleanup: true,
      persistentZonesV14RingCleanup: true,
      persistentZonesLegacySegmentCleanup: true,
      persistentZonesRingOperationId: ringOperationId
    });
    logV14RegionDiagnostic("v14RingLegacyCleanupSuccess", {
      entryPoint: "createManagedRegionFromRegion",
      sceneId: scene?.id ?? null,
      itemUuid,
      partId,
      deletedRegionIds: regionIds
    });
    return regionIds;
  } catch (caughtError) {
    logV14RegionDiagnostic("v14RingLegacyCleanupFailed", {
      entryPoint: "createManagedRegionFromRegion",
      sceneId: scene?.id ?? null,
      itemUuid,
      partId,
      regionIds,
      reason: caughtError?.message ?? "unknown"
    });
    return [];
  } finally {
    pendingV14RingCleanupKeys.delete(cleanupKey);
  }
}

function buildV14RingSegmentCleanupCandidateDecision(regionDocument, {
  itemUuid = null,
  partId = null,
  newGroupId = null,
  nativeRegionId = null
} = {}) {
  const runtimeFlags = getRegionRuntimeFlags(regionDocument);
  const regionId = regionDocument?.id ?? null;
  const groupId = runtimeFlags?.groupId ?? null;
  const sourceRegionId = runtimeFlags?.sourceRegionId ?? null;
  const finalRegionId = runtimeFlags?.finalRegionId ?? null;
  const ringOperationId = runtimeFlags?.ringOperationId ?? null;

  if (regionId === nativeRegionId || finalRegionId === nativeRegionId) {
    return {
      regionId,
      groupId,
      sourceRegionId,
      finalRegionId,
      ringOperationId,
      delete: false,
      matchingReason: null,
      rejectedReason: "current-source-region"
    };
  }

  if (!isV14RingRuntimeFlags(runtimeFlags)) {
    return {
      regionId,
      groupId,
      sourceRegionId,
      finalRegionId,
      ringOperationId,
      delete: false,
      matchingReason: null,
      rejectedReason: "not-v14-ring-runtime"
    };
  }

  const itemMatches = runtimeFlags?.itemUuid === itemUuid;
  const partMatches = runtimeFlags?.partId === partId;
  const exactGroupMatch = Boolean(newGroupId && groupId === newGroupId);
  const exactSourceMatch = Boolean(nativeRegionId && sourceRegionId === nativeRegionId);
  const deleteCandidate = Boolean((exactGroupMatch || exactSourceMatch) && itemMatches && partMatches);

  return {
    regionId,
    groupId,
    sourceRegionId,
    finalRegionId,
    ringOperationId,
    itemUuid: runtimeFlags?.itemUuid ?? null,
    partId: runtimeFlags?.partId ?? null,
    delete: deleteCandidate,
    matchingReason: deleteCandidate
      ? exactGroupMatch ? "exact-group-id" : "exact-source-region-id"
      : null,
    rejectedReason: deleteCandidate
      ? null
      : !itemMatches ? "different-item"
        : !partMatches ? "different-part"
          : "different-group-and-source"
  };
}

function logV14RingSegmentCleanupDecision({
  scene = null,
  operationId = null,
  currentRegionId = null,
  currentSourceRegionId = null,
  currentGroupId = null,
  candidateDecisions = [],
  deletionIds = [],
  cleanupReentrant = false,
  cleanupSkippedReason = null
} = {}) {
  const consideredCandidates = Array.from(candidateDecisions ?? [])
    .filter((decision) => decision?.regionId && decision.rejectedReason !== "not-v14-ring-runtime");
  console.warn(`[${MODULE_ID}][lifecycle] PZ V14 RING SEGMENT CLEANUP DECISION`, {
    operationId,
    currentRegionId,
    currentSourceRegionId,
    currentGroupId,
    candidateRegionIds: consideredCandidates.map((decision) => decision.regionId),
    candidateGroupIds: consideredCandidates.map((decision) => decision.groupId ?? null),
    matchingReason: consideredCandidates.map((decision) => ({
      regionId: decision.regionId,
      reason: decision.matchingReason
    })),
    rejectedReason: consideredCandidates.map((decision) => ({
      regionId: decision.regionId,
      reason: decision.rejectedReason
    })),
    deletionIds,
    cleanupReentrant,
    cleanupSkippedReason,
    sceneId: scene?.id ?? null
  });
}

async function removeNativeV14RingSourceRegion(regionDocument, {
  scene = null,
  groupId = null,
  partId = null,
  ringOperationId = null,
  source = null
} = {}) {
  if (!scene || !regionDocument?.id || typeof scene.deleteEmbeddedDocuments !== "function") {
    logV14RegionDiagnostic("ringNativeRegionRetained", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument?.id ?? null,
      groupId,
      partId,
      ringOperationId,
      ringNativeRegionDisposition: "retained-missing-delete-api",
      ringNativeRegionRetained: true
    });
    return false;
  }

  try {
    await scene.deleteEmbeddedDocuments("Region", [regionDocument.id], {
      persistentZonesCleanup: true,
      persistentZonesV14RingNativeCleanup: true,
      persistentZonesRingOperationId: ringOperationId
    });
    logV14RegionDiagnostic("ringNativeRegionRemoved", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument.id,
      groupId,
      partId,
      ringOperationId,
      ringNativeRegionDisposition: "removed-after-segment-group-created",
      ringNativeRegionRemoved: true
    });
    return true;
  } catch (caughtError) {
    logV14RegionDiagnostic("ringNativeRegionRetained", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      regionDocumentId: regionDocument.id,
      groupId,
      partId,
      ringOperationId,
      ringNativeRegionDisposition: "retained-delete-failed",
      ringNativeRegionRetained: true,
      reason: caughtError?.message ?? "unknown"
    });
    return false;
  }
}

async function cleanupExistingV14RingVisualOverlays(scene, {
  itemUuid = null,
  partId = null,
  groupId = null,
  keepGroupId = null,
  ringOperationId = null,
  reason = "manual"
} = {}) {
  if (!scene || typeof scene.deleteEmbeddedDocuments !== "function") {
    return [];
  }

  const drawingIds = listSceneDrawings(scene)
    .filter((drawingDocument) => {
      const overlay = getRingVisualOverlayFlags(drawingDocument);
      if (!overlay) {
        return false;
      }
      if (itemUuid && overlay.itemUuid !== itemUuid) {
        return false;
      }
      if (partId && overlay.partId !== partId) {
        return false;
      }
      if (groupId && overlay.groupId !== groupId) {
        return false;
      }
      if (keepGroupId && overlay.groupId === keepGroupId) {
        return false;
      }
      return true;
    })
    .map((drawingDocument) => drawingDocument?.id)
    .filter(Boolean);

  if (!drawingIds.length) {
    return [];
  }

  logV14RegionDiagnostic("ringVisualOverlayCleanup", {
    sceneId: scene?.id ?? null,
    itemUuid,
    partId,
    groupId,
    keepGroupId,
    ringOperationId,
    reason,
    drawingIds
  });

  try {
    await scene.deleteEmbeddedDocuments("Drawing", drawingIds, {
      persistentZonesV14RingVisualCleanup: true,
      persistentZonesRingOperationId: ringOperationId
    });
    return drawingIds;
  } catch (caughtError) {
    logV14RegionDiagnostic("ringVisualOverlayCleanupFailed", {
      sceneId: scene?.id ?? null,
      itemUuid,
      partId,
      groupId,
      ringOperationId,
      reason,
      drawingIds,
      failedReason: caughtError?.message ?? "unknown"
    });
    return [];
  }
}

async function ensureV14RingVisualOverlayIfNeeded(regionDocuments = [], visibilityState = {}, {
  scene = null,
  itemUuid = null,
  groupId = null,
  partId = null,
  ringOperationId = null
} = {}) {
  const canvasFound = Array.from(visibilityState.ringSegmentCanvasObjectFound ?? [])
    .filter((entry) => entry.canvasObjectFound).length;
  const canvasVisible = Array.from(visibilityState.ringSegmentCanvasVisible ?? [])
    .filter((entry) => entry.canvasVisible).length;
  const segmentCount = Array.from(regionDocuments ?? []).length;
  const regionLayerHiddenByFoundry = segmentCount > 0 && canvasFound === segmentCount && canvasVisible === 0;
  const strategy = regionLayerHiddenByFoundry
    ? "drawing-overlay"
    : "region-canvas-direct";

  logV14RegionDiagnostic("ringVisualStrategySelected", {
    sceneId: scene?.id ?? null,
    itemUuid,
    groupId,
    partId,
    ringOperationId,
    ringVisualStrategySelected: strategy,
    ringRegionLayerHiddenByFoundry: regionLayerHiddenByFoundry,
    segmentCount,
    canvasFound,
    canvasVisible
  });

  if (!regionLayerHiddenByFoundry) {
    return {
      strategy,
      drawingIds: [],
      visibleCount: canvasVisible
    };
  }

  logV14RegionDiagnostic("ringRegionLayerHiddenByFoundry", {
    sceneId: scene?.id ?? null,
    itemUuid,
    groupId,
    partId,
    ringOperationId,
    segmentCount,
    canvasFound,
    canvasVisible
  });

  await cleanupExistingV14RingVisualOverlays(scene, {
    itemUuid,
    partId,
    groupId,
    ringOperationId,
    reason: "replace-current-v14-ring-overlay"
  });

  const drawingPayloads = Array.from(regionDocuments ?? [])
    .map((regionDocument, index) => buildV14RingVisualOverlayDrawingPayload(regionDocument, {
      itemUuid,
      groupId,
      partId,
      ringOperationId,
      segmentIndex: index + 1
    }))
    .filter(Boolean);

  logV14RegionDiagnostic("ringVisualOverlayCreateStart", {
    sceneId: scene?.id ?? null,
    itemUuid,
    groupId,
    partId,
    ringOperationId,
    drawingCount: drawingPayloads.length
  });

  if (!scene || typeof scene.createEmbeddedDocuments !== "function" || !drawingPayloads.length) {
    logV14RegionDiagnostic("ringVisualOverlayCreateFailed", {
      sceneId: scene?.id ?? null,
      itemUuid,
      groupId,
      partId,
      ringOperationId,
      reason: !scene ? "missing-scene" : !drawingPayloads.length ? "missing-drawing-payloads" : "missing-drawing-create-api"
    });
    return {
      strategy: "drawing-overlay-failed",
      drawingIds: [],
      visibleCount: 0
    };
  }

  try {
    const drawings = await scene.createEmbeddedDocuments("Drawing", drawingPayloads, {
      persistentZonesV14RingVisualOverlay: true,
      persistentZonesRingOperationId: ringOperationId
    });
    await wait(50);
    const drawingState = summarizeV14RingVisualOverlayDrawings(scene, drawings);
    logV14RegionDiagnostic("ringVisualOverlayCreated", {
      sceneId: scene?.id ?? null,
      itemUuid,
      groupId,
      partId,
      ringOperationId,
      drawingIds: drawingState.drawingIds,
      drawingCount: drawingState.drawingIds.length
    });
    logV14RegionDiagnostic("ringVisualOverlayVisible", {
      sceneId: scene?.id ?? null,
      itemUuid,
      groupId,
      partId,
      ringOperationId,
      drawingIds: drawingState.drawingIds,
      visibleCount: drawingState.visibleCount,
      canvasFoundCount: drawingState.canvasFoundCount
    });
    return {
      strategy,
      drawingIds: drawingState.drawingIds,
      visibleCount: drawingState.visibleCount
    };
  } catch (caughtError) {
    logV14RegionDiagnostic("ringVisualOverlayCreateFailed", {
      sceneId: scene?.id ?? null,
      itemUuid,
      groupId,
      partId,
      ringOperationId,
      reason: caughtError?.message ?? "unknown"
    });
    return {
      strategy: "drawing-overlay-failed",
      drawingIds: [],
      visibleCount: 0
    };
  }
}

function buildV14RingVisualOverlayDrawingPayload(regionDocument, {
  itemUuid = null,
  groupId = null,
  partId = null,
  ringOperationId = null,
  segmentIndex = null
} = {}) {
  const objectData = duplicateData(regionDocument?.toObject?.()) ?? {};
  const polygon = Array.from(objectData.shapes ?? [])
    .find((shape) => shape?.type === "polygon" && Array.isArray(shape.points));
  const points = normalizeShapePointObjects(polygon?.points ?? []);
  if (points.length < 3) {
    return null;
  }

  const offsetX = coerceNumber(polygon?.x, 0);
  const offsetY = coerceNumber(polygon?.y, 0);
  const absolutePoints = points.map((point) => ({
    x: point.x + offsetX,
    y: point.y + offsetY
  }));
  const minX = Math.min(...absolutePoints.map((point) => point.x));
  const minY = Math.min(...absolutePoints.map((point) => point.y));
  const maxX = Math.max(...absolutePoints.map((point) => point.x));
  const maxY = Math.max(...absolutePoints.map((point) => point.y));
  const relativePairs = absolutePoints.map((point) => [
    point.x - minX,
    point.y - minY
  ]);

  return {
    x: minX,
    y: minY,
    rotation: 0,
    hidden: false,
    locked: true,
    author: game?.user?.id ?? null,
    shape: {
      type: globalThis.CONST?.DRAWING_TYPES?.POLYGON ?? "p",
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
      points: relativePairs
    },
    fillType: globalThis.CONST?.DRAWING_FILL_TYPES?.SOLID ?? 1,
    fillColor: DEFAULT_REGION_COLOR,
    fillAlpha: 0.22,
    strokeColor: DEFAULT_REGION_COLOR,
    strokeAlpha: 0.85,
    strokeWidth: 2,
    text: "",
    flags: {
      [MODULE_ID]: {
        ringVisualOverlay: {
          itemUuid,
          groupId,
          partId,
          ringOperationId,
          regionId: regionDocument?.id ?? null,
          segmentIndex,
          lifecycle: "ring-visual-overlay"
        }
      }
    }
  };
}

function summarizeV14RingVisualOverlayDrawings(scene, drawingDocuments = []) {
  const drawings = Array.from(drawingDocuments ?? []);
  const summaries = drawings.map((drawingDocument) => {
    const sceneDrawing = findSceneDrawingById(scene, drawingDocument?.id ?? null) ?? drawingDocument;
    const canvasObject = findCanvasDrawingObject(sceneDrawing);
    return {
      drawingId: sceneDrawing?.id ?? drawingDocument?.id ?? null,
      canvasObjectFound: Boolean(canvasObject),
      canvasVisible: canvasObject
        ? Boolean(canvasObject.visible ?? canvasObject.renderable ?? true)
        : !Boolean(sceneDrawing?.hidden ?? sceneDrawing?.toObject?.()?.hidden)
    };
  });
  return {
    drawingIds: summaries.map((summary) => summary.drawingId).filter(Boolean),
    canvasFoundCount: summaries.filter((summary) => summary.canvasObjectFound).length,
    visibleCount: summaries.filter((summary) => summary.canvasVisible).length
  };
}

function logV14RingCanvasVisibilityDiagnostics(regionDocuments = [], {
  scene = null,
  groupId = null,
  partId = null,
  ringOperationId = null
} = {}) {
  const layer = canvas?.regions ?? null;
  logV14RegionDiagnostic("ringRegionLayerState", {
    sceneId: scene?.id ?? null,
    groupId,
    partId,
    ringOperationId,
    layerVisible: layer?.visible ?? null,
    layerRenderable: layer?.renderable ?? null,
    layerActive: layer?.active ?? null,
    layerName: layer?.constructor?.name ?? null
  });
  logV14RegionDiagnostic("ringCanvasControlLayerState", {
    sceneId: scene?.id ?? null,
    groupId,
    partId,
    ringOperationId,
    currentControlLayerName: canvas?.activeLayer?.constructor?.name ?? null,
    currentControlLayerVisible: canvas?.activeLayer?.visible ?? null,
    currentControlLayerRenderable: canvas?.activeLayer?.renderable ?? null,
    currentControlLayerActive: canvas?.activeLayer?.active ?? null
  });

  for (const regionDocument of Array.from(regionDocuments ?? []).slice(0, 4)) {
    const canvasObject = findCanvasRegionObject(regionDocument);
    const parent = canvasObject?.parent ?? null;
    const objectData = duplicateData(regionDocument?.toObject?.()) ?? {};
    const bounds = calculateRegionBoundsFromShapes(objectData.shapes ?? []);
    const shapes = Array.from(objectData.shapes ?? []);
    const state = {
      regionId: regionDocument?.id ?? null,
      documentHidden: Boolean(regionDocument?.hidden ?? objectData.hidden),
      objectVisible: canvasObject?.visible ?? null,
      objectRenderable: canvasObject?.renderable ?? null,
      objectAlpha: canvasObject?.alpha ?? null,
      objectWorldAlpha: canvasObject?.worldAlpha ?? null,
      parentVisible: parent?.visible ?? null,
      parentRenderable: parent?.renderable ?? null,
      parentName: parent?.constructor?.name ?? null,
      layerVisible: layer?.visible ?? null,
      layerRenderable: layer?.renderable ?? null,
      layerActive: layer?.active ?? null,
      highlightMode: readRegionHighlightModeValues(regionDocument),
      shapesCount: shapes.length,
      bounds
    };
    logV14RegionDiagnostic("ringRegionObjectState", {
      sceneId: scene?.id ?? null,
      groupId,
      partId,
      ringOperationId,
      ...state
    });
    console.info(`[${MODULE_ID}][ring-visibility] ringCanvasVisibilityChain: regionId=${state.regionId ?? "null"} documentHidden=${state.documentHidden} objectVisible=${state.objectVisible} objectRenderable=${state.objectRenderable} objectAlpha=${state.objectAlpha} objectWorldAlpha=${state.objectWorldAlpha} parentVisible=${state.parentVisible} parentRenderable=${state.parentRenderable} parent=${state.parentName ?? "null"} layerVisible=${state.layerVisible} layerRenderable=${state.layerRenderable} layerActive=${state.layerActive} shapesCount=${state.shapesCount}`);
  }
}

function sanitizeGroupIdComponent(value) {
  return String(value ?? "none").replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function onPreUpdateRegion(regionDocument, changed = {}, options = {}, userId = null) {
  if (options?.persistentZonesGroupTranslation || (userId && game?.user?.id !== userId)) {
    return;
  }
  const translation = detectRegionShapesTranslation(
    Array.from(regionDocument?._source?.shapes ?? []),
    changed?.shapes
  );
  if (!translation) {
    return;
  }
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const siblings = getManagedMultipartRegionGroup(regionDocument?.parent, runtime)
    .filter((candidate) => candidate?.id !== regionDocument?.id);
  if (!siblings.length) {
    return;
  }
  options.persistentZonesPendingGroupTranslations ??= {};
  options.persistentZonesPendingGroupTranslations[regionDocument.id] = {
    dx: translation.dx,
    dy: translation.dy,
    groupId: runtime.groupId ?? null,
    siblingIds: siblings.map((candidate) => candidate.id)
  };
}

async function onUpdateRegion(regionDocument, changed = {}, options = {}, userId = null) {
  logV14RegionDiagnostic("regionDocumentFlagsAfterUpdate", {
    regionDocumentId: regionDocument?.id ?? null,
    sceneId: regionDocument?.parent?.id ?? null,
    changedKeys: Object.keys(changed ?? {}),
    regionManagedFlagsRead: Boolean(getRegionRuntimeFlags(regionDocument)),
    regionManagedFlagsSource: "updateRegion-hook",
    managedRegionDetected: Boolean(getRegionRuntimeFlags(regionDocument)?.templateId),
    regionDocumentFlagsAfterUpdate: duplicateData(regionDocument?.flags ?? null),
    regionDocumentSourceFlagsAfterUpdate: duplicateData(regionDocument?._source?.flags ?? null)
  });

  if (getRegionRuntimeFlags(regionDocument)) {
    const detection = detectRegionHighlightModeForDocument(regionDocument);
    logV14RegionDiagnostic("regionHighlightModeDetected", {
      entryPoint: "updateRegion-hook",
      changedKeys: Object.keys(changed ?? {}),
      regionDocumentId: regionDocument?.id ?? null,
      regionHighlightModeField: detection.fieldPath,
      regionHighlightModePersistedValue: detection.persistedValue,
      regionHighlightModeSourceValue: detection.sourceValue,
      regionHighlightModeDocumentValue: detection.documentValue,
      regionHighlightModeToObjectValue: detection.toObjectValue,
      regionHighlightModeMismatch: detection.mismatch,
      regionHighlightModeChoices: detection.runtimeChoices,
      hookErrorResolved: true
    });
  }

  await propagateMultipartRegionTranslation(regionDocument, options, userId);

  if (shouldSyncLinkedDocumentsAfterRegionUpdate(regionDocument, changed, options)) {
    const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
    await syncLinkedDocumentsSafely({
      templateDocument: null,
      regionDocument,
      normalizedDefinition: runtime.normalizedDefinition ?? null,
      shapes: null,
      stage: "update-region-hook"
    });
  }
}

function shouldSyncLinkedDocumentsAfterRegionUpdate(regionDocument, changed = {}, options = {}) {
  if (options?.persistentZonesLinkedSync) {
    const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
    console.warn(`[${MODULE_ID}][linked] PZ LINKED INITIAL SYNC DECISION`, {
      regionId: regionDocument?.id ?? null,
      entryPoint: "updateRegion-hook",
      updateWasInternal: true,
      updateHookSyncSkipped: true,
      explicitFinalSyncScheduled: true,
      groupId: runtime.groupId ?? null,
      decisionReason: "persistentZonesLinkedSync-option"
    });
    return false;
  }
  const runtime = getRegionRuntimeFlags(regionDocument);
  if (!runtime?.normalizedDefinition) {
    return false;
  }
  const linkedWallsEnabled = runtime.normalizedDefinition?.linkedWalls?.enabled === true;
  const linkedLightEnabled = runtime.normalizedDefinition?.linkedLight?.enabled === true;
  if (!linkedWallsEnabled && !linkedLightEnabled) {
    return false;
  }
  const keys = Object.keys(changed ?? {});
  if (!keys.length) {
    return false;
  }
  return keys.some((key) => {
    const normalizedKey = String(key ?? "");
    return normalizedKey === "shapes" ||
      normalizedKey.startsWith("shapes.") ||
      normalizedKey === "elevation" ||
      normalizedKey.includes(`${RUNTIME_FLAG_KEY}.linkedWalls`) ||
      normalizedKey.includes(`${RUNTIME_FLAG_KEY}.linkedLight`) ||
      normalizedKey.includes("normalizedDefinition.linkedWalls") ||
      normalizedKey.includes("normalizedDefinition.linkedLight");
  });
}

export async function createRegionFromTemplate(
  templateDocument,
  {
    force = false,
    userId = null,
    item = null,
    actor = null,
    caster = null,
    rawDefinition = null
  } = {}
) {
  const scene = templateDocument?.parent ?? null;
  const templateDiagnostics = buildTemplateDiagnostics(templateDocument);
  logV14RegionBranch("legacyPathSelected", {
    entryPoint: "createRegionFromTemplate",
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
    selectedCompatibilityPath: "legacy-template-create-region",
    ...templateDiagnostics
  });
  logRingCastDiagnostic("ringCastStart", {
    entryPoint: "createRegionFromTemplate",
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    force,
    userId,
    ...templateDiagnostics
  });
  logRingCastDiagnostic("ringCastTemplateDetected", {
    entryPoint: "createRegionFromTemplate",
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    templateDetected: templateDiagnostics.templateDetected,
    sourceDocumentType: templateDiagnostics.sourceDocumentType,
    templateType: templateDiagnostics.templateType
  });
  logV14RegionEntry("enteredManagedRegionCreation", {
    entryPoint: "createRegionFromTemplate",
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    force,
    userId,
    hasInjectedItem: Boolean(item),
    hasInjectedActor: Boolean(actor),
    hasInjectedCaster: Boolean(caster),
    hasInjectedRawDefinition: Boolean(rawDefinition),
    ...templateDiagnostics,
    selectedCompatibilityPath: selectRegionFactoryCompatibilityPath({
      templateDocument,
      scene,
      operation: "create"
    })
  });

  if (!scene) {
    logRingCastDiagnostic("ringCastSkipReason", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument?.id ?? null,
      ringCastSkipReason: "missing-parent-scene"
    });
    debug("Skipped Region creation because the template has no parent Scene.", {
      templateId: templateDocument?.id ?? null,
      ...templateDiagnostics
    });
    logV14RegionBranch("skippedV14PathBecause", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument?.id ?? null,
      reason: "missing-parent-scene",
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return null;
  }

  const existingRegions = findManagedRegionsForTemplate(scene, templateDocument);
  if (existingRegions.length && !force) {
    logV14RegionDiagnostic("Existing managed Regions detected before create; will compare against planned parts.", {
      templateId: templateDocument.id,
      ...templateDiagnostics,
      regionIds: existingRegions.map((region) => region?.id ?? null).filter(Boolean),
      existingRegionCount: existingRegions.length
    });
  }

  const resolvedContext = await resolveTemplateSourceContext(templateDocument);
  const sourceContext = {
    item: item ?? resolvedContext.item ?? null,
    actor: actor ?? item?.actor ?? resolvedContext.actor ?? null,
    caster: caster ?? resolvedContext.caster ?? actor ?? item?.actor ?? null,
    activity: resolvedContext.activity ?? null
  };
  logRingCastDiagnostic("ringCastSourceResolved", {
    entryPoint: "createRegionFromTemplate",
    templateId: templateDocument?.id ?? null,
    sceneId: scene.id,
    itemUuid: sourceContext.item?.uuid ?? null,
    actorUuid: sourceContext.actor?.uuid ?? null,
    casterUuid: sourceContext.caster?.uuid ?? null,
    resolutionNotes: resolvedContext.report?.notes ?? [],
    matched: resolvedContext.report?.matched ?? []
  });

  if (!sourceContext.item) {
    logRingCastDiagnostic("ringCastSkipReason", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      ringCastSkipReason: "no-linked-item",
      userId
    });
    debug("Skipped template without a resolvable linked item.", {
      templateId: templateDocument.id,
      userId,
      ...templateDiagnostics,
      resolutionNotes: resolvedContext.report?.notes ?? [],
      matched: resolvedContext.report?.matched ?? []
    });
    logV14RegionBranch("skippedV14PathBecause", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      reason: "no-linked-item",
      userId,
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return null;
  }

  const configuration = resolvePersistentZoneConfiguration({
    actor: sourceContext.actor,
    item: sourceContext.item,
    activity: sourceContext.activity,
    templateDocument,
    rawDefinition,
    entryPoint: "createRegionFromTemplate"
  });
  if (!configuration.hasConfiguration) {
    logRingCastDiagnostic("ringCastSkipReason", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      itemUuid: sourceContext.item.uuid,
      ringCastSkipReason: "missing-zone-definition"
    });
    debug("Skipped template without a persistent-zones definition on the linked item.", {
      templateId: templateDocument.id,
      ...templateDiagnostics,
      itemUuid: sourceContext.item.uuid
    });
    logV14RegionBranch("skippedV14PathBecause", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      reason: "missing-zone-definition",
      itemUuid: sourceContext.item.uuid,
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return null;
  }

  const normalizedDefinition = configuration.normalizedDefinition;
  const ringDefinitionSummary = summarizeRingDefinition(normalizedDefinition);
  if (ringDefinitionSummary.hasRingDefinition) {
    logRingCastDiagnostic("ringCastDefinitionResolved", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      sceneId: scene.id,
      itemUuid: sourceContext.item?.uuid ?? null,
      selectedBaseType: getTemplateType(templateDocument),
      selectedGeometryType: ringDefinitionSummary.selectedGeometryType,
      normalizedGeometryType: ringDefinitionSummary.normalizedGeometryType,
      partGeometryTypes: ringDefinitionSummary.partGeometryTypes,
      partCountExpected: ringDefinitionSummary.partCountExpected
    });
    logRingCastDiagnostic("ringCastCreationEntry", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      sceneId: scene.id,
      itemUuid: sourceContext.item?.uuid ?? null,
      selectedGeometryType: ringDefinitionSummary.selectedGeometryType
    });
    logV14RegionDiagnostic("ringDefinitionResolved", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      sceneId: scene.id,
      itemUuid: sourceContext.item?.uuid ?? null,
      selectedBaseType: getTemplateType(templateDocument),
      selectedGeometryType: ringDefinitionSummary.selectedGeometryType,
      normalizedGeometryType: ringDefinitionSummary.normalizedGeometryType,
      partGeometryTypes: ringDefinitionSummary.partGeometryTypes,
      partCountExpected: ringDefinitionSummary.partCountExpected,
      ringDefinitionResolved: true
    });
    logV14RegionDiagnostic("ringCreationEntry", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      sceneId: scene.id,
      itemUuid: sourceContext.item?.uuid ?? null,
      selectedBaseType: getTemplateType(templateDocument),
      selectedGeometryType: ringDefinitionSummary.selectedGeometryType,
      normalizedGeometryType: ringDefinitionSummary.normalizedGeometryType
    });
  }

  if (normalizedDefinition.enabled === false) {
    logRingCastDiagnostic("ringCastSkipReason", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      ringCastSkipReason: "zone-definition-disabled",
      itemUuid: sourceContext.item?.uuid ?? null
    });
    debug("Skipped template because persistent-zones definition is disabled.", {
      templateId: templateDocument.id,
      ...templateDiagnostics,
      enabled: false,
      itemUuid: sourceContext.item?.uuid ?? null,
      itemName: sourceContext.item?.name ?? null,
      selectedVariant: normalizedDefinition.selectedVariantId ?? null,
      defaultVariant: normalizedDefinition.defaultVariantId ?? null
    });
    logV14RegionBranch("skippedV14PathBecause", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      reason: "zone-definition-disabled",
      itemUuid: sourceContext.item?.uuid ?? null,
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return null;
  }

  if (!normalizedDefinition.validation.isValid) {
    const validationReasons = Array.isArray(normalizedDefinition.validation.reasons)
      ? normalizedDefinition.validation.reasons
      : [];
    debug("Skipped template with an invalid normalized zone definition.", {
      templateId: templateDocument.id,
      ...templateDiagnostics,
      selectedVariant: normalizedDefinition.selectedVariantId ?? null,
      defaultVariant: normalizedDefinition.defaultVariantId ?? null,
      availableVariants: normalizedDefinition.availableVariants ?? [],
      variantResolutionMode: normalizedDefinition.variantResolution?.resolutionMode ?? "none",
      variantValidation: normalizedDefinition.variantResolution ?? null,
      reasons: validationReasons,
      reasonsText: validationReasons.join(" | ")
    });
    logV14RegionBranch("skippedV14PathBecause", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      reason: "invalid-zone-definition",
      validationReasons,
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return null;
  }

  if (Array.isArray(normalizedDefinition.variants) && normalizedDefinition.variants.length) {
    debug("Resolved managed Region variants for template.", {
      templateId: templateDocument.id,
      ...templateDiagnostics,
      selectedVariant: normalizedDefinition.selectedVariantId ?? null,
      defaultVariant: normalizedDefinition.defaultVariantId ?? null,
      availableVariants: normalizedDefinition.availableVariants ?? [],
      variantCount: normalizedDefinition.variantCount ?? 0,
      variantResolutionMode: normalizedDefinition.variantResolution?.resolutionMode ?? "none",
      variantValidation: normalizedDefinition.variantResolution ?? null
    });
  }

  const groupPlan = await buildManagedRegionGroupPlan({
    templateDocument,
    normalizedDefinition,
    sourceContext,
    existingRegions
  });
  if (ringDefinitionSummary.hasRingDefinition) {
    logV14RegionDiagnostic(groupPlan.parts.length ? "regionPlanBuilt" : "regionPlanSkipped", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      sceneId: scene.id,
      itemUuid: sourceContext.item?.uuid ?? null,
      selectedBaseType: getTemplateType(templateDocument),
      selectedGeometryType: ringDefinitionSummary.selectedGeometryType,
      normalizedGeometryType: ringDefinitionSummary.normalizedGeometryType,
      partGeometryTypes: ringDefinitionSummary.partGeometryTypes,
      partCountExpected: ringDefinitionSummary.partCountExpected,
      partCountPrepared: groupPlan.parts.length,
      regionPlanBuilt: Boolean(groupPlan.parts.length),
      regionPlanSkipped: !groupPlan.parts.length,
      regionPlanSkipReason: groupPlan.parts.length ? null : "no-supported-region-parts"
    });
  }
  logV14RegionBranch("selectedCompatibilityPath", {
    entryPoint: "createRegionFromTemplate",
    templateId: templateDocument.id,
    sceneId: scene.id,
    ...templateDiagnostics,
    regionGroupId: groupPlan.groupId,
    regionGeometryType: Array.from(new Set(groupPlan.parts.map((partPlan) => partPlan.geometryType))),
    partCountExpected: groupPlan.parts.length,
    selectedCompatibilityPath: selectRegionFactoryCompatibilityPath({
      templateDocument,
      scene,
      groupPlan,
      operation: "create"
    })
  });

  if (!groupPlan.parts.length) {
    logRingCastDiagnostic("ringCastSkipReason", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      ringCastSkipReason: "empty-group-plan"
    });
    debug("Skipped template because no supported Region shape could be produced.", {
      templateId: templateDocument.id,
      ...templateDiagnostics,
      templateType: getTemplateType(templateDocument)
    });
    logV14RegionBranch("skippedV14PathBecause", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      reason: "empty-group-plan",
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return null;
  }

  const existingGroupCompatible = existingRegions.length && !force
    ? isExistingRegionGroupCompatibleWithPlan(existingRegions, groupPlan)
    : false;
  if (existingGroupCompatible) {
    logV14RegionDiagnostic("Skipped Region creation because existing managed Region group matches planned part count.", {
      templateId: templateDocument.id,
      ...templateDiagnostics,
      regionGroupId: groupPlan.groupId,
      existingRegionCount: existingRegions.length,
      partCountExpected: groupPlan.parts.length,
      existingGroupCompatibility: summarizeExistingGroupCompatibility(existingRegions, groupPlan)
    });
    return existingRegions[0] ?? null;
  }

  if (existingRegions.length) {
    logV14RegionDiagnostic("Recreating managed Region group because existing group does not match planned V14 Regions.", {
      templateId: templateDocument.id,
      ...templateDiagnostics,
      regionGroupId: groupPlan.groupId,
      existingRegionCount: existingRegions.length,
      partCountExpected: groupPlan.parts.length,
      existingGroupCompatibility: summarizeExistingGroupCompatibility(existingRegions, groupPlan)
    });
    await deleteManagedRegionGroup(existingRegions, {
      reason: force ? "force-recreate-group" : "v14-plan-mismatch-recreate-group"
    });
  }

  const regionCreateData = groupPlan.parts.map((partPlan) => partPlan.regionData);
  if (ringDefinitionSummary.hasRingDefinition) {
    logRingCastDiagnostic("ringCastRegionCreateAttempt", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      sceneId: scene.id,
      regionGroupId: groupPlan.groupId,
      regionCreateCount: regionCreateData.length,
      selectedGeometryType: ringDefinitionSummary.selectedGeometryType,
      partCountExpected: groupPlan.parts.length
    });
  }
  const createdRegions = await createManagedRegionDocuments({
    scene,
    templateDocument,
    groupPlan,
    regionCreateData,
    templateDiagnostics,
    operation: "create"
  });
  if (ringDefinitionSummary.hasRingDefinition) {
    logRingCastDiagnostic("ringCastRegionCreateSuccess", {
      entryPoint: "createRegionFromTemplate",
      templateId: templateDocument.id,
      sceneId: scene.id,
      regionGroupId: groupPlan.groupId,
      regionCount: Array.from(createdRegions ?? []).length,
      regionIds: Array.from(createdRegions ?? []).map((region) => region?.id ?? null).filter(Boolean)
    });
  }

  for (let index = 0; index < createdRegions.length; index += 1) {
    const createdRegion = createdRegions[index] ?? null;
    const partPlan = groupPlan.parts[index] ?? null;
    if (!createdRegion || !partPlan) {
      continue;
    }

    await syncLinkedDocumentsSafely({
      templateDocument,
      regionDocument: createdRegion,
      normalizedDefinition: partPlan.runtimeDefinition,
      shapes: partPlan.shapes,
      stage: "create-region"
    });

    debug("Created managed Region part from MeasuredTemplate.", {
      templateId: templateDocument.id,
      regionGroupId: groupPlan.groupId,
      regionId: createdRegion.id,
      partId: partPlan.partId,
      geometryType: partPlan.geometryType,
      side: partPlan.geometrySide ?? null,
      referencePartId: partPlan.geometryReferencePartId ?? null,
      referenceRadiusMode: partPlan.geometryReferenceRadiusMode ?? null,
      templateRadius: partPlan.geometryTemplateRadius ?? null,
      offsetReference: partPlan.geometryOffsetReference ?? null,
      offsetStart: partPlan.geometryOffsetStart ?? null,
      offsetEnd: partPlan.geometryOffsetEnd ?? null,
      heatBandStart: partPlan.geometryOffsetStart ?? null,
      heatBandEnd: partPlan.geometryOffsetEnd ?? null,
      wallThickness: partPlan.geometryThickness ?? null,
      computedInnerRadius: partPlan.geometryComputedInnerRadius ?? null,
      computedOuterRadius: partPlan.geometryComputedOuterRadius ?? null
    });
  }

  debug("Created managed Region group from MeasuredTemplate.", {
    templateId: templateDocument.id,
    ...templateDiagnostics,
    regionGroupId: groupPlan.groupId,
    availableVariants: groupPlan.availableVariantIds ?? [],
    selectedVariant: groupPlan.selectedVariantId ?? null,
    defaultVariant: groupPlan.defaultVariantId ?? null,
    variantResolutionMode: groupPlan.variantResolutionMode ?? "none",
    regionCount: createdRegions.length,
    geometryTypes: groupPlan.parts.map((partPlan) => partPlan.geometryType),
    partIds: groupPlan.parts.map((partPlan) => partPlan.partId)
  });

  return createdRegions?.[0] ?? null;
}

async function syncRegionToTemplate(templateDocument, {
  changed = {},
  updateKeys = [],
  userId = null
} = {}) {
  const scene = templateDocument?.parent ?? null;
  const templateDiagnostics = buildTemplateDiagnostics(templateDocument);
  logV14RegionEntry("enteredManagedRegionCreation", {
    entryPoint: "syncRegionToTemplate",
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    updateKeys,
    ...templateDiagnostics,
    selectedCompatibilityPath: selectRegionFactoryCompatibilityPath({
      templateDocument,
      scene,
      operation: "sync"
    })
  });

  if (!scene) {
    debug("Skipped template sync because the template has no parent Scene.", {
      templateId: templateDocument?.id ?? null,
      updateKeys,
      strategy: "update-region",
      syncApplied: false
    });
    logV14RegionBranch("skippedV14PathBecause", {
      entryPoint: "syncRegionToTemplate",
      templateId: templateDocument?.id ?? null,
      reason: "missing-parent-scene",
      updateKeys,
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return null;
  }

  const existingRegions = findManagedRegionsForTemplate(scene, templateDocument);
  logV14RegionBranch("selectedCompatibilityPath", {
    entryPoint: "syncRegionToTemplate",
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    updateKeys,
    existingRegionCount: existingRegions.length,
    ...templateDiagnostics,
    selectedCompatibilityPath: existingRegions.length
      ? "sync-existing-managed-region-group"
      : "create-missing-managed-region-group"
  });

  if (!existingRegions.length) {
    const createdRegion = await createRegionFromTemplate(templateDocument, { userId });
    debug("Synced managed Region group from updated MeasuredTemplate.", {
      templateId: templateDocument?.id ?? null,
      regionId: createdRegion?.id ?? null,
      regionCount: createdRegion ? 1 : 0,
      updateKeys,
      strategy: "create-region-group",
      syncApplied: Boolean(createdRegion)
    });
    return createdRegion;
  }

  const syncPayload = await buildRegionSyncPayload(templateDocument, existingRegions);
  if (!syncPayload || !syncPayload.parts.length) {
    debug("Skipped template sync because Region group sync payload could not be built.", {
      templateId: templateDocument?.id ?? null,
      regionId: existingRegions[0]?.id ?? null,
      regionCount: existingRegions.length,
      updateKeys,
      strategy: "update-region",
      syncApplied: false
    });
    return existingRegions[0] ?? null;
  }

  if (existingRegions.length > 1 || syncPayload.parts.length > 1) {
    const recreatedRegions = await recreateManagedRegionGroupFromTemplate(templateDocument, existingRegions, syncPayload);
    debug("Synced managed Region group from updated MeasuredTemplate.", {
      templateId: templateDocument?.id ?? null,
      regionGroupId: syncPayload.groupId,
      availableVariants: syncPayload.availableVariantIds ?? [],
      selectedVariant: syncPayload.selectedVariantId ?? null,
      defaultVariant: syncPayload.defaultVariantId ?? null,
      variantResolutionMode: syncPayload.variantResolutionMode ?? "none",
      regionId: recreatedRegions?.[0]?.id ?? null,
      regionCount: recreatedRegions.length,
      updateKeys,
      strategy: "recreate-group",
      syncApplied: recreatedRegions.length > 0
    });
    return recreatedRegions[0] ?? null;
  }

  const existingRegion = existingRegions[0];
  const partPlan = syncPayload.parts[0] ?? null;
  if (!partPlan) {
    return existingRegion;
  }

  try {
    await existingRegion.update(buildRegionUpdateData(partPlan.regionData));
    await syncLinkedDocumentsSafely({
      templateDocument,
      regionDocument: existingRegion,
      normalizedDefinition: partPlan.runtimeDefinition,
      shapes: partPlan.shapes,
      stage: "update-region"
    });

    debug("Synced managed Region part from updated MeasuredTemplate.", {
      templateId: templateDocument?.id ?? null,
      regionId: existingRegion.id,
      regionGroupId: syncPayload.groupId,
      partId: partPlan.partId,
      geometryType: partPlan.geometryType,
      side: partPlan.geometrySide ?? null,
      referencePartId: partPlan.geometryReferencePartId ?? null,
      referenceRadiusMode: partPlan.geometryReferenceRadiusMode ?? null,
      templateRadius: partPlan.geometryTemplateRadius ?? null,
      offsetReference: partPlan.geometryOffsetReference ?? null,
      offsetStart: partPlan.geometryOffsetStart ?? null,
      offsetEnd: partPlan.geometryOffsetEnd ?? null,
      heatBandStart: partPlan.geometryOffsetStart ?? null,
      heatBandEnd: partPlan.geometryOffsetEnd ?? null,
      wallThickness: partPlan.geometryThickness ?? null,
      computedInnerRadius: partPlan.geometryComputedInnerRadius ?? null,
      computedOuterRadius: partPlan.geometryComputedOuterRadius ?? null,
      updateKeys,
      strategy: "update-region",
      syncApplied: true
    });

    debug("Synced managed Region group from updated MeasuredTemplate.", {
      templateId: templateDocument?.id ?? null,
      regionGroupId: syncPayload.groupId,
      availableVariants: syncPayload.availableVariantIds ?? [],
      selectedVariant: syncPayload.selectedVariantId ?? null,
      defaultVariant: syncPayload.defaultVariantId ?? null,
      variantResolutionMode: syncPayload.variantResolutionMode ?? "none",
      regionId: existingRegion.id,
      regionCount: 1,
      updateKeys,
      strategy: "update-region",
      syncApplied: true
    });
    return existingRegion;
  } catch (caughtError) {
    debug("Direct Region update failed during template sync; attempting recreate group fallback.", {
      templateId: templateDocument?.id ?? null,
      regionId: existingRegion.id,
      regionGroupId: syncPayload.groupId,
      updateKeys,
      strategy: "recreate-group",
      reason: caughtError?.message ?? "unknown"
    });

    const recreatedRegions = await recreateManagedRegionGroupFromTemplate(templateDocument, existingRegions, syncPayload);
    debug("Synced managed Region group from updated MeasuredTemplate.", {
      templateId: templateDocument?.id ?? null,
      regionGroupId: syncPayload.groupId,
      availableVariants: syncPayload.availableVariantIds ?? [],
      selectedVariant: syncPayload.selectedVariantId ?? null,
      defaultVariant: syncPayload.defaultVariantId ?? null,
      variantResolutionMode: syncPayload.variantResolutionMode ?? "none",
      regionId: recreatedRegions?.[0]?.id ?? null,
      regionCount: recreatedRegions.length,
      updateKeys,
      strategy: "recreate-group",
      syncApplied: recreatedRegions.length > 0
    });
    return recreatedRegions[0] ?? null;
  }
}

export function findManagedRegionForTemplate(scene, templateDocument) {
  return findManagedRegionsForTemplate(scene, templateDocument)[0] ?? null;
}

function findManagedRegionsForTemplate(scene, templateDocument) {
  const templateId = templateDocument?.id ?? null;
  const templateUuid = templateDocument?.uuid ?? null;

  return findManagedRegions(scene, (region) => {
    const runtime = getRegionRuntimeFlags(region);
    return runtime?.templateId === templateId || runtime?.templateUuid === templateUuid;
  });
}

function isExistingRegionGroupCompatibleWithPlan(existingRegions, groupPlan) {
  const compatibility = summarizeExistingGroupCompatibility(existingRegions, groupPlan);
  return compatibility.compatible;
}

function summarizeExistingGroupCompatibility(existingRegions, groupPlan) {
  const regions = Array.from(existingRegions ?? []);
  const parts = Array.from(groupPlan?.parts ?? []);
  const partComparisons = parts.map((partPlan, index) => {
    const region = regions[index] ?? null;
    const runtime = getRegionRuntimeFlags(region) ?? {};
    const existingShapes = summarizeRegionDocumentShapes(region);
    const plannedShapes = summarizeFoundryRegionShapes(partPlan?.regionData?.shapes ?? []);
    const existingShapeTypes = existingShapes.map((shape) => shape.type);
    const plannedShapeTypes = plannedShapes.map((shape) => shape.type);

    return {
      index: index + 1,
      regionId: region?.id ?? null,
      expectedPartId: partPlan?.partId ?? null,
      existingPartId: runtime.partId ?? null,
      expectedGeometryType: partPlan?.geometryType ?? null,
      existingGeometryType: runtime.geometryType ?? null,
      expectedShapeCount: plannedShapes.length,
      existingShapeCount: existingShapes.length,
      expectedShapeTypes: plannedShapeTypes,
      existingShapeTypes,
      compatible:
        Boolean(region) &&
        (runtime.partId ?? null) === (partPlan?.partId ?? null) &&
        (runtime.geometryType ?? null) === (partPlan?.geometryType ?? null) &&
        existingShapes.length === plannedShapes.length &&
        existingShapeTypes.join("|") === plannedShapeTypes.join("|")
    };
  });
  const compatible =
    regions.length === parts.length &&
    partComparisons.length === parts.length &&
    partComparisons.every((comparison) => comparison.compatible);

  return {
    compatible,
    existingRegionCount: regions.length,
    partCountExpected: parts.length,
    comparisons: partComparisons
  };
}

function onPreDeleteRegion(regionDocument, options = {}, userId = null) {
  const genericOwnerCascadeDecision = evaluateGenericOwnerDeleteCascadeProtection(regionDocument, options, userId);
  if (genericOwnerCascadeDecision.blocked) {
    console.warn(`[${MODULE_ID}][lifecycle] PZ GENERIC OWNER DELETE CASCADE BLOCKED`, genericOwnerCascadeDecision.logData);
    return false;
  }

  const decision = evaluateStartupExternalDeleteProtection(regionDocument, options, userId);
  if (decision.blocked) {
    console.warn(`[${MODULE_ID}][lifecycle] PZ EXTERNAL STARTUP DELETE BLOCKED`, decision.logData);
    return false;
  }

  if (decision.relevant) {
    console.warn(`[${MODULE_ID}][lifecycle] PZ EXTERNAL STARTUP DELETE ALLOWED`, decision.logData);
  }

  return undefined;
}

function onPreCreateActiveEffect(activeEffect, data = {}, options = {}, userId = null) {
  const decision = evaluateGenericCleanupEffectSuppression(activeEffect, data, options, userId);
  logGenericCleanupEffectMatchDecision(decision);
  if (!decision.effectSuppressionAllowed) {
    console.warn(`[${MODULE_ID}][lifecycle] PZ GENERIC CLEANUP EFFECT NOT SUPPRESSED`, {
      candidateCastInstanceIds: duplicateData(decision.candidateCastInstanceIds),
      unresolvedSignals: duplicateData(decision.unresolvedSignals),
      effectName: decision.effectName ?? null,
      effectOrigin: decision.effectOrigin ?? null,
      changes: duplicateData(decision.changes),
      statuses: duplicateData(decision.statuses),
      decisionReason: decision.decisionReason
    });
    return undefined;
  }

  const castRecord = activeNonConcentrationCastRegistry.get(decision.selectedCastInstanceId);
  if (castRecord) {
    castRecord.genericCleanupEffectSuppressed = true;
    castRecord.genericCleanupEffectSuppressedAt = Date.now();
    activeNonConcentrationCastRegistry.set(decision.selectedCastInstanceId, castRecord);
  }
  console.warn(`[${MODULE_ID}][lifecycle] PZ GENERIC CLEANUP EFFECT SUPPRESSED`, {
    castInstanceId: decision.selectedCastInstanceId,
    operationId: castRecord?.operationId ?? null,
    actorUuid: decision.actorUuid ?? null,
    itemUuid: decision.itemUuid ?? null,
    regionId: castRecord?.finalRegionId ?? castRecord?.sourceRegionId ?? null,
    effectName: decision.effectName ?? null,
    effectOrigin: decision.effectOrigin ?? null,
    changesCount: decision.changesCount,
    statuses: duplicateData(decision.statuses),
    concentrationRequired: decision.concentrationRequired,
    suppressionReason: decision.decisionReason
  });
  return false;
}

async function propagateMultipartRegionTranslation(regionDocument, options = {}, userId = null) {
  if (options?.persistentZonesGroupTranslation || (userId && game?.user?.id !== userId)) {
    return [];
  }
  const plan = options?.persistentZonesPendingGroupTranslations?.[regionDocument?.id] ?? null;
  if (!plan || !Number.isFinite(plan.dx) || !Number.isFinite(plan.dy)) {
    return [];
  }
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  if (!plan.groupId || runtime.groupId !== plan.groupId) {
    return [];
  }
  const sourceRegionIds = Object.entries(options?.persistentZonesPendingGroupTranslations ?? {})
    .filter(([, candidatePlan]) => candidatePlan?.groupId === plan.groupId)
    .map(([regionId]) => regionId);
  if (sourceRegionIds[0] !== regionDocument.id) {
    return [];
  }
  const scene = regionDocument?.parent ?? null;
  if (!scene || typeof scene.updateEmbeddedDocuments !== "function") {
    return [];
  }
  const allowedSiblingIds = new Set(plan.siblingIds ?? []);
  const sourceRegionIdSet = new Set(sourceRegionIds);
  const siblings = getManagedMultipartRegionGroup(scene, runtime).filter((candidate) =>
    candidate?.id !== regionDocument.id &&
    !sourceRegionIdSet.has(candidate?.id) &&
    allowedSiblingIds.has(candidate?.id)
  );
  const updates = siblings.map((candidate) => ({
    _id: candidate.id,
    shapes: Array.from(candidate?._source?.shapes ?? []).map((shape) =>
      translateRegionShapeData(shape, plan.dx, plan.dy)
    )
  }));
  if (!updates.length) {
    return [];
  }
  debug("Translating managed multipart Region group.", {
    sceneId: scene.id ?? null,
    groupId: plan.groupId,
    sourceRegionId: regionDocument.id ?? null,
    siblingRegionIds: updates.map((update) => update._id),
    dx: plan.dx,
    dy: plan.dy
  });
  return scene.updateEmbeddedDocuments("Region", updates, {
    persistentZonesGroupTranslation: true,
    persistentZonesGroupTranslationSourceId: regionDocument.id ?? null,
    persistentZonesGroupId: plan.groupId
  });
}

export function detectRegionShapesTranslation(previousShapes, nextShapes) {
  if (!Array.isArray(previousShapes) || !Array.isArray(nextShapes) ||
      previousShapes.length !== nextShapes.length || !previousShapes.length) {
    return null;
  }
  const firstDelta = getRegionShapeTranslationDelta(previousShapes[0], nextShapes[0]);
  if (!firstDelta || (!firstDelta.dx && !firstDelta.dy)) {
    return null;
  }
  for (let index = 0; index < previousShapes.length; index += 1) {
    const translated = translateRegionShapeData(previousShapes[index], firstDelta.dx, firstDelta.dy);
    if (!regionShapeDataEqual(translated, nextShapes[index])) {
      return null;
    }
  }
  return firstDelta;
}

function getRegionShapeTranslationDelta(previousShape, nextShape) {
  if (!isPlainObject(previousShape) || !isPlainObject(nextShape) || previousShape.type !== nextShape.type) {
    return null;
  }
  if (previousShape.type === "polygon") {
    const previousPoints = Array.from(previousShape.points ?? []);
    const nextPoints = Array.from(nextShape.points ?? []);
    if (previousPoints.length < 2 || previousPoints.length !== nextPoints.length) {
      return null;
    }
    return {
      dx: Number(nextPoints[0]) - Number(previousPoints[0]),
      dy: Number(nextPoints[1]) - Number(previousPoints[1])
    };
  }
  if (!REGION_SHAPE_TYPES_WITH_POSITION.has(String(previousShape.type ?? "")) ||
      !Number.isFinite(Number(previousShape.x)) || !Number.isFinite(Number(previousShape.y)) ||
      !Number.isFinite(Number(nextShape.x)) || !Number.isFinite(Number(nextShape.y))) {
    return null;
  }
  return {
    dx: Number(nextShape.x) - Number(previousShape.x),
    dy: Number(nextShape.y) - Number(previousShape.y)
  };
}

const REGION_SHAPE_TYPES_WITH_POSITION = new Set([
  "circle",
  "cone",
  "ellipse",
  "line",
  "rectangle",
  "ring"
]);

export function translateRegionShapeData(shapeData, dx, dy) {
  const translated = duplicateData(shapeData ?? {});
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return translated;
  }
  if (translated.type === "polygon") {
    translated.points = Array.from(translated.points ?? []).map((coordinate, index) =>
      Number(coordinate) + (index % 2 === 0 ? dx : dy)
    );
    if (isPlainObject(translated.origin) &&
        Number.isFinite(Number(translated.origin.x)) && Number.isFinite(Number(translated.origin.y))) {
      translated.origin.x = Number(translated.origin.x) + dx;
      translated.origin.y = Number(translated.origin.y) + dy;
    }
    return translated;
  }
  if (REGION_SHAPE_TYPES_WITH_POSITION.has(String(translated.type ?? "")) &&
      Number.isFinite(Number(translated.x)) && Number.isFinite(Number(translated.y))) {
    translated.x = Number(translated.x) + dx;
    translated.y = Number(translated.y) + dy;
  }
  return translated;
}

function regionShapeDataEqual(left, right) {
  if (typeof left === "number" || typeof right === "number") {
    return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) &&
      Math.abs(Number(left) - Number(right)) <= 1e-6;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => regionShapeDataEqual(value, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && regionShapeDataEqual(left[key], right[key]));
  }
  return left === right;
}

function onPreDeleteActiveEffect(activeEffect, options = {}, userId = null) {
  const audit = buildGenericOwnerDependencyAudit(activeEffect, {
    hookName: "preDeleteActiveEffect",
    options,
    userId
  });
  logGenericOwnerDependencyAudit(audit);

  const context = buildGenericOwnerDeleteContext(activeEffect, audit, {
    options,
    userId
  });
  if (!context.protectedRegionIds.length) {
    return undefined;
  }

  activeGenericOwnerDeleteContexts.set(activeEffect.uuid, context);
  setTimeout(() => {
    cleanupGenericOwnerDeleteContext(activeEffect.uuid, "timeout");
  }, GENERIC_OWNER_DELETE_CONTEXT_TTL_MS);
  return undefined;
}

async function onDeleteActiveEffectGenericOwnerContextCleanup(activeEffect, options = {}) {
  const persistentZoneFlags = activeEffect?.flags?.[MODULE_ID] ?? {};
  const statusRecovery = persistentZoneFlags.statusRecovery ?? null;
  if (persistentZoneFlags.managedTriggeredEffect && statusRecovery?.mode) {
    const removalSource =
      options?.["expiry-reason"] ??
      options?.expiryReason ??
      (options?.persistentZonesTriggeredStatusCleanup ? "persistent-zones-cleanup" : "undetermined");
    console.warn(
      `[persistent-zones] PZ STATUS RECOVERY EFFECT REMOVED | ` +
      `effectId=${activeEffect?.id ?? "null"} | actorUuid=${activeEffect?.parent?.uuid ?? "null"} | ` +
      `statusId=${persistentZoneFlags.statusId ?? "null"} | removalSource=${removalSource} | ` +
      `recoveryMode=${statusRecovery.mode}`
    );
  }

  const context = activeEffect?.uuid ? activeGenericOwnerDeleteContexts.get(activeEffect.uuid) : null;
  if (context) {
    context.effectDeletedAt = Date.now();
    activeGenericOwnerDeleteContexts.set(activeEffect.uuid, context);
    cleanupGenericOwnerDeleteContext(activeEffect.uuid, "deleteActiveEffect");
  }
  if (isStatusSourceEffect(activeEffect, MODULE_ID)) {
    await repairInvalidOwnerEffectReferences(activeEffect?.uuid, { reason: "status-source-deleted" });
  }
}

function evaluateGenericOwnerDeleteCascadeProtection(regionDocument, options = {}, userId = null) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? null;
  const ownerEffectUuid = getOwnerEffectUuidFromRuntime(runtime ?? {});
  const dedicatedOwnerEffect = ownerEffectUuid ? resolveOwnerEffectSync(ownerEffectUuid) : null;
  const context = Array.from(activeGenericOwnerDeleteContexts.values())
    .find((candidate) => candidate.protectedRegionIds.includes(regionDocument?.id) || candidate.pendingRegionIds.includes(regionDocument?.id));
  const concentrationRequired = runtime?.normalizedDefinition?.concentration?.required === true;
  const persistentZonesCleanup = hasPersistentZonesLegitimateDeletionOption(options);
  const pendingRegionIdsBefore = Array.from(context?.pendingRegionIds ?? []);
  const blocked = Boolean(
    context &&
    runtime &&
    isNonConcentrationRuntime(runtime) &&
    ownerEffectUuid &&
    isPersistentZonesDedicatedOwnerEffect(dedicatedOwnerEffect) &&
    !persistentZonesCleanup
  );
  if (context && regionDocument?.id) {
    context.pendingRegionIds = context.pendingRegionIds.filter((regionId) => regionId !== regionDocument.id);
    if (blocked && !context.blockedRegionIds.includes(regionDocument.id)) {
      context.blockedRegionIds.push(regionDocument.id);
    }
    activeGenericOwnerDeleteContexts.set(context.genericEffectUuid, context);
    cleanupGenericOwnerDeleteContext(context.genericEffectUuid, "preDeleteRegion");
  }

  return {
    blocked,
    logData: {
      genericEffectUuid: context?.genericEffectUuid ?? null,
      regionId: regionDocument?.id ?? null,
      dedicatedOwnerEffectUuid: ownerEffectUuid ?? null,
      pendingRegionIdsBefore: duplicateData(pendingRegionIdsBefore),
      pendingRegionIdsAfter: duplicateData(context?.pendingRegionIds ?? []),
      blockedRegionIds: duplicateData(context?.blockedRegionIds ?? []),
      concentrationRequired,
      deleteOptions: duplicateData(options ?? {}),
      deletionUserId: userId ?? null,
      detectionMode: context?.detectionMode ?? null,
      deletionPrevented: blocked,
      reason: blocked ? "generic-owner-effect-delete-cascade" : "not-generic-owner-cascade"
    }
  };
}

function hasPersistentZonesLegitimateDeletionOption(options = {}) {
  return Boolean(
    options?.persistentZonesCleanup === true ||
    options?.persistentZonesOwnerCleanup === true ||
    options?.persistentZonesOrphanCleanup === true ||
    options?.persistentZonesEffectLifecycleCleanup === true ||
    options?.persistentZonesRegionLifecycleCleanup === true ||
    options?.persistentZonesV14RingCleanup === true
  );
}

function buildGenericOwnerDeleteContext(activeEffect, audit = {}, { options = {}, userId = null } = {}) {
  if (isPersistentZonesDedicatedOwnerEffect(activeEffect) || isEffectConcentrationLike(activeEffect)) {
    return {
      genericEffectUuid: activeEffect?.uuid ?? null,
      actorUuid: activeEffect?.parent?.uuid ?? null,
      protectedRegionIds: [],
      dedicatedOwnerEffectUuids: [],
      detectionMode: "not-generic-owner-effect",
      options: duplicateData(options ?? {}),
      userId: userId ?? null
    };
  }
  const protectedRegions = Array.from(audit.regions ?? [])
    .filter((row) => row.protectable)
    .filter((row) => row.referencesGenericEffect || row.genericEffectReferencesRegion);
  const protectedRegionIds = protectedRegions.map((row) => row.regionId).filter(Boolean);
  return {
    genericEffectUuid: activeEffect?.uuid ?? null,
    actorUuid: activeEffect?.parent?.uuid ?? null,
    itemUuid: resolveActiveEffectItemUuid(activeEffect, activeEffect?.toObject?.() ?? {}),
    createdAt: Date.now(),
    effectDeletedAt: null,
    expiresAt: Date.now() + GENERIC_OWNER_DELETE_CONTEXT_TTL_MS,
    protectedRegionIds,
    pendingRegionIds: Array.from(protectedRegionIds),
    blockedRegionIds: [],
    dedicatedOwnerEffectUuids: protectedRegions.map((row) => row.ownerEffectUuid).filter(Boolean),
    detectionMode: protectedRegions.some((row) => row.effectDependentDocument) ? "effect-getDependents" : "serialized-reference",
    options: duplicateData(options ?? {}),
    userId: userId ?? null
  };
}

function cleanupGenericOwnerDeleteContext(effectUuid, reason = "manual") {
  const context = effectUuid ? activeGenericOwnerDeleteContexts.get(effectUuid) : null;
  if (!context) {
    return;
  }
  context.lastPendingRegionIdsBefore = Array.from(context.pendingRegionIds ?? []);
  const expired = Date.now() >= (context.expiresAt ?? 0);
  const completed = Array.isArray(context.pendingRegionIds) && context.pendingRegionIds.length === 0;
  if (expired || completed) {
    activeGenericOwnerDeleteContexts.delete(effectUuid);
    logV14RegionDiagnostic("genericOwnerDeleteContextCleared", {
      genericEffectUuid: effectUuid,
      reason,
      expired,
      completed,
      blockedRegionIds: context.blockedRegionIds ?? []
    });
    return;
  }
  activeGenericOwnerDeleteContexts.set(effectUuid, context);
}

function registerNonConcentrationCastForGenericCleanupSuppression({
  regionDocument = null,
  runtime = {},
  sourceContext = null,
  operationId = null,
  stage = "manual"
} = {}) {
  if (!isNonConcentrationRuntime(runtime)) {
    return null;
  }
  const castInstanceId = runtime.castInstanceId ?? operationId ?? buildCastOperationId(regionDocument);
  if (!castInstanceId) {
    return null;
  }
  const actorUuid = runtime.actorUuid ?? runtime.casterUuid ?? sourceContext?.actor?.uuid ?? sourceContext?.caster?.uuid ?? null;
  const itemUuid = runtime.itemUuid ?? sourceContext?.item?.uuid ?? null;
  const now = Date.now();
  const existing = activeNonConcentrationCastRegistry.get(castInstanceId) ?? {};
  const record = {
    ...existing,
    castInstanceId,
    operationId,
    actorUuid,
    itemUuid,
    activityId: runtime.activityId ?? sourceContext?.activity?.id ?? sourceContext?.activity?.uuid?.split(".").pop() ?? null,
    workflowId: runtime.workflowId ?? null,
    messageId: runtime.messageId ?? null,
    sourceRegionId: runtime.sourceRegionId ?? regionDocument?.id ?? null,
    finalRegionId: runtime.finalRegionId ?? regionDocument?.id ?? null,
    sceneId: regionDocument?.parent?.id ?? runtime.sceneId ?? null,
    concentrationRequired: false,
    createdAt: existing.createdAt ?? now,
    expiresAt: now + NON_CONCENTRATION_CAST_REGISTRY_TTL_MS,
    dedicatedOwnerEffectUuid: runtime.ownerEffectUuid ?? runtime.activeEffectUuid ?? existing.dedicatedOwnerEffectUuid ?? null,
    genericCleanupEffectSuppressed: existing.genericCleanupEffectSuppressed === true,
    stage
  };
  activeNonConcentrationCastRegistry.set(castInstanceId, record);
  setTimeout(() => {
    const current = activeNonConcentrationCastRegistry.get(castInstanceId);
    if (current && Date.now() >= current.expiresAt) {
      activeNonConcentrationCastRegistry.delete(castInstanceId);
    }
  }, NON_CONCENTRATION_CAST_REGISTRY_TTL_MS + 250);
  return record;
}

function evaluateGenericCleanupEffectSuppression(activeEffect, data = {}, options = {}, userId = null) {
  const effectData = mergeActiveEffectPreCreateData(activeEffect, data);
  const effectName = activeEffect?.name ?? effectData.name ?? effectData.label ?? null;
  const effectOrigin = activeEffect?.origin ?? effectData.origin ?? null;
  const actorUuid = activeEffect?.parent?.uuid ?? null;
  const itemUuid = resolveActiveEffectItemUuid(activeEffect, effectData);
  const activityId = resolveActiveEffectActivityId(activeEffect, effectData);
  const workflowId = getPropertyPath(effectData, "flags.midi-qol.workflowId") ?? getPropertyPath(effectData, "flags.dnd5e.workflowId") ?? null;
  const changes = Array.from(effectData.system?.changes ?? activeEffect?.system?.changes ?? effectData.changes ?? activeEffect?.changes ?? []);
  const statuses = extractEffectStatuses(activeEffect, effectData);
  const isDedicatedPzEffect = Boolean(getPropertyPath(effectData, `flags.${MODULE_ID}.managedOwnerEffect`) === true);
  const isManagedTriggeredStatusSource = Boolean(
    getPropertyPath(effectData, `flags.${MODULE_ID}.managedTriggeredEffect`) === true
  );
  const concentrationLike = isEffectDataConcentrationLike(activeEffect, effectData);
  const detectedCleanupSignals = detectGenericCleanupEffectSignals(effectData, {
    effectName,
    effectOrigin,
    changes,
    statuses,
    isDedicatedPzEffect,
    concentrationLike
  });
  const candidateCasts = findActiveNonConcentrationCastCandidates({
    actorUuid,
    itemUuid,
    activityId,
    workflowId
  });
  const selectedCast = candidateCasts.length === 1 ? candidateCasts[0] : null;
  const unresolvedSignals = [];
  if (!actorUuid) unresolvedSignals.push("missing-actor-uuid");
  if (!itemUuid) unresolvedSignals.push("missing-item-uuid");
  if (!candidateCasts.length) unresolvedSignals.push("no-active-pz-cast-candidate");
  if (candidateCasts.length > 1) unresolvedSignals.push("ambiguous-active-pz-cast-candidates");
  if (changes.length) unresolvedSignals.push("effect-has-changes");
  if (statuses.length) unresolvedSignals.push("effect-has-statuses");
  if (isDedicatedPzEffect) unresolvedSignals.push("persistent-zones-dedicated-owner-effect");
  if (isManagedTriggeredStatusSource) unresolvedSignals.push("persistent-zones-triggered-status-source");
  if (concentrationLike) unresolvedSignals.push("effect-is-concentration-like");
  if (!detectedCleanupSignals.includes("empty-non-mechanical-template-cleanup-signature")) {
    unresolvedSignals.push("missing-template-cleanup-signature");
  }
  const originMatchesSelectedCast = Boolean(selectedCast?.itemUuid && itemUuid && selectedCast.itemUuid === itemUuid);
  if (selectedCast && !originMatchesSelectedCast) {
    unresolvedSignals.push("effect-origin-does-not-match-selected-cast-item");
  }
  const effectSuppressionAllowed = Boolean(
    selectedCast &&
    selectedCast.concentrationRequired === false &&
    originMatchesSelectedCast &&
    !isDedicatedPzEffect &&
    !isManagedTriggeredStatusSource &&
    !concentrationLike &&
    changes.length === 0 &&
    statuses.length === 0 &&
    detectedCleanupSignals.includes("empty-non-mechanical-template-cleanup-signature")
  );
  return {
    effectName,
    effectOrigin,
    actorUuid,
    itemUuid,
    activityId,
    workflowId,
    userId,
    options: duplicateData(options ?? {}),
    candidateCastInstanceIds: candidateCasts.map((candidate) => candidate.castInstanceId).filter(Boolean),
    selectedCastInstanceId: selectedCast?.castInstanceId ?? null,
    concentrationRequired: selectedCast?.concentrationRequired ?? null,
    changes,
    changesCount: changes.length,
    statuses,
    detectedCleanupSignals,
    effectSuppressionAllowed,
    decisionReason: effectSuppressionAllowed ? "exact-active-pz-non-concentration-template-cleanup-effect" : unresolvedSignals.join(",") || "not-a-pz-template-cleanup-effect",
    unresolvedSignals
  };
}

function mergeActiveEffectPreCreateData(activeEffect, data = {}) {
  const objectData = activeEffect?.toObject?.() ?? {};
  return {
    ...objectData,
    ...duplicateData(data ?? {}),
    flags: {
      ...(objectData.flags ?? {}),
      ...(data?.flags ?? {})
    }
  };
}

function findActiveNonConcentrationCastCandidates({
  actorUuid = null,
  itemUuid = null,
  activityId = null,
  workflowId = null
} = {}) {
  const now = Date.now();
  for (const [castInstanceId, record] of Array.from(activeNonConcentrationCastRegistry.entries())) {
    if (now >= (record.expiresAt ?? 0)) {
      activeNonConcentrationCastRegistry.delete(castInstanceId);
    }
  }
  return Array.from(activeNonConcentrationCastRegistry.values())
    .filter((record) => record.concentrationRequired === false)
    .filter((record) => record.genericCleanupEffectSuppressed !== true)
    .filter((record) => actorUuid && record.actorUuid === actorUuid)
    .filter((record) => itemUuid && record.itemUuid === itemUuid)
    .filter((record) => !activityId || !record.activityId || record.activityId === activityId)
    .filter((record) => !workflowId || !record.workflowId || record.workflowId === workflowId);
}

function detectGenericCleanupEffectSignals(effectData = {}, {
  effectName = null,
  effectOrigin = null,
  changes = [],
  statuses = [],
  isDedicatedPzEffect = false,
  concentrationLike = false
} = {}) {
  const signals = [];
  if (changes.length === 0) signals.push("no-changes");
  if (statuses.length === 0) signals.push("no-statuses");
  if (effectOrigin) signals.push("has-origin");
  if (!isDedicatedPzEffect) signals.push("not-persistent-zones-dedicated-owner");
  if (!concentrationLike) signals.push("not-concentration-like");
  const text = stringifyCompact({
    name: effectName,
    flags: effectData.flags ?? null,
    duration: effectData.duration ?? null,
    origin: effectOrigin
  }).toLowerCase();
  if (text.includes("template") || text.includes("cleanup") || text.includes("midi-qol") || text.includes("dnd5e")) {
    signals.push("observed-template-cleanup-text");
  }
  if (
    signals.includes("no-changes") &&
    signals.includes("no-statuses") &&
    signals.includes("has-origin") &&
    signals.includes("not-persistent-zones-dedicated-owner") &&
    signals.includes("not-concentration-like")
  ) {
    signals.push("empty-non-mechanical-template-cleanup-signature");
  }
  return signals;
}

function extractEffectStatuses(activeEffect, effectData = {}) {
  const rawStatuses = effectData.statuses ?? activeEffect?.statuses ?? [];
  if (rawStatuses instanceof Set) {
    return Array.from(rawStatuses).filter(Boolean);
  }
  if (Array.isArray(rawStatuses)) {
    return rawStatuses.filter(Boolean);
  }
  if (rawStatuses && typeof rawStatuses === "object") {
    return Object.keys(rawStatuses).filter((key) => rawStatuses[key]);
  }
  return [];
}

function isEffectDataConcentrationLike(activeEffect, effectData = {}) {
  const text = stringifyCompact({
    name: activeEffect?.name ?? effectData.name ?? effectData.label ?? null,
    statuses: extractEffectStatuses(activeEffect, effectData),
    flags: effectData.flags ?? null
  }).toLowerCase();
  return text.includes("concentrat");
}

function logGenericCleanupEffectMatchDecision(decision = {}) {
  console.warn(
    `[${MODULE_ID}][lifecycle] PZ GENERIC CLEANUP EFFECT MATCH DECISION | effectName=${decision.effectName ?? "null"} | effectOrigin=${decision.effectOrigin ?? "null"} | actorUuid=${decision.actorUuid ?? "null"} | itemUuid=${decision.itemUuid ?? "null"} | activityId=${decision.activityId ?? "null"} | workflowId=${decision.workflowId ?? "null"} | candidateCastInstanceIds=${stringifyCompact(decision.candidateCastInstanceIds ?? [])} | selectedCastInstanceId=${decision.selectedCastInstanceId ?? "null"} | concentrationRequired=${decision.concentrationRequired ?? "null"} | changesCount=${decision.changesCount ?? 0} | statuses=${stringifyCompact(decision.statuses ?? [])} | detectedCleanupSignals=${stringifyCompact(decision.detectedCleanupSignals ?? [])} | effectSuppressionAllowed=${decision.effectSuppressionAllowed === true} | decisionReason=${decision.decisionReason ?? "null"}`
  );
}

function buildGenericOwnerDependencyAudit(activeEffect, {
  hookName = "manual",
  options = {},
  userId = null
} = {}) {
  const effectSummary = summarizeDocumentDependencyState(activeEffect);
  const effectData = activeEffect?.toObject?.(false) ?? activeEffect?.toObject?.() ?? {};
  const effectText = stringifyCompact({
    flags: effectData.flags ?? null,
    dependents: effectSummary.dependents,
    dependencies: effectSummary.dependencies,
    getDependents: effectSummary.getDependents
  });
  const effectItemUuid = resolveActiveEffectItemUuid(activeEffect, effectData);
  const regions = [];
  for (const scene of game?.scenes?.contents ?? []) {
    for (const region of findManagedRegions(scene)) {
      const runtime = getRegionRuntimeFlags(region) ?? {};
      if (!isNonConcentrationRuntime(runtime)) {
        continue;
      }
      const ownerEffectUuid = getOwnerEffectUuidFromRuntime(runtime);
      const dedicatedOwnerEffect = ownerEffectUuid ? resolveOwnerEffectSync(ownerEffectUuid) : null;
      const regionSummary = summarizeDocumentDependencyState(region);
      const regionText = stringifyCompact({
        flags: regionSummary.flags,
        dependents: regionSummary.dependents,
        dependencies: regionSummary.dependencies,
        getDependents: regionSummary.getDependents
      });
      const regionRefs = [region?.uuid, region?.id].filter(Boolean);
      const ownerRefs = [activeEffect?.uuid, activeEffect?.id].filter(Boolean);
      const effectDependentDocument = Array.from(effectSummary.getDependents ?? [])
        .some((dependent) => dependent.uuid === region?.uuid || dependent.id === region?.id);
      regions.push({
        regionId: region?.id ?? null,
        regionUuid: region?.uuid ?? null,
        ownerEffectUuid,
        dedicatedOwnerEffect: isPersistentZonesDedicatedOwnerEffect(dedicatedOwnerEffect),
        protectable: Boolean(ownerEffectUuid && isPersistentZonesDedicatedOwnerEffect(dedicatedOwnerEffect)),
        flags: regionSummary.flags,
        toObject: regionSummary.toObject,
        source: regionSummary.source,
        dependents: regionSummary.dependents,
        dependencies: regionSummary.dependencies,
        getDependents: regionSummary.getDependents,
        referencesGenericEffect: ownerRefs.some((ref) => regionText.includes(ref)),
        genericEffectReferencesRegion: regionRefs.some((ref) => effectText.includes(ref)),
        effectDependentDocument,
        sameItem: Boolean(effectItemUuid && runtime.itemUuid === effectItemUuid),
        groupId: runtime.groupId ?? null,
        sourceRegionId: runtime.sourceRegionId ?? null
      });
    }
  }

  return {
    hookName,
    timestamp: Date.now(),
    options: duplicateData(options ?? {}),
    userId: userId ?? null,
    effect: effectSummary,
    regions
  };
}

function summarizeDocumentDependencyState(document) {
  const objectData = document?.toObject?.(false) ?? document?.toObject?.() ?? null;
  const sourceData = document?._source ?? null;
  const getDependents = typeof document?.getDependents === "function"
    ? Array.from(document.getDependents() ?? []).map((dependent) => ({
      id: dependent?.id ?? null,
      uuid: dependent?.uuid ?? null,
      documentName: dependent?.documentName ?? null,
      name: dependent?.name ?? null
    }))
    : [];
  return {
    documentId: document?.id ?? null,
    documentUuid: document?.uuid ?? null,
    documentName: document?.documentName ?? null,
    name: document?.name ?? objectData?.name ?? null,
    img: document?.img ?? document?.icon ?? objectData?.img ?? objectData?.icon ?? null,
    origin: document?.origin ?? objectData?.origin ?? null,
    flags: duplicateData(objectData?.flags ?? document?.flags ?? null),
    changes: duplicateData(objectData?.system?.changes ?? document?.system?.changes ?? objectData?.changes ?? document?.changes ?? null),
    statuses: duplicateData(Array.from(document?.statuses ?? objectData?.statuses ?? [])),
    duration: duplicateData(objectData?.duration ?? document?.duration ?? null),
    toObject: duplicateData(objectData),
    source: duplicateData(sourceData),
    dependents: duplicateData(objectData?.dependents ?? document?.dependents ?? null),
    dependencies: duplicateData(objectData?.dependencies ?? document?.dependencies ?? null),
    getDependents,
    hasAddDependent: typeof document?.addDependent,
    hasDeleteDependent: typeof document?.deleteDependent,
    dependentUuids: getDependents.map((dependent) => dependent.uuid).filter(Boolean)
  };
}

function logGenericOwnerDependencyAudit(audit = {}) {
  console.warn(`[${MODULE_ID}][lifecycle] PZ GENERIC OWNER DEPENDENCY AUDIT`, {
    hookName: audit.hookName ?? null,
    timestamp: audit.timestamp ?? Date.now(),
    options: duplicateData(audit.options ?? {}),
    userId: audit.userId ?? null,
    effect: duplicateData(audit.effect ?? null),
    regions: duplicateData(audit.regions ?? [])
  });
}

async function onDeleteRegion(regionDocument, options = {}) {
  if (!isPrimaryGM()) {
    return;
  }

  const runtime = getRegionRuntimeFlags(regionDocument);
  if (!runtime) {
    return;
  }

  if (!options?.persistentZonesRegionGroupPrecleaned) {
    try {
      await cleanupLinkedDocumentsForRegion(regionDocument, {
        reason: "region-deleted",
        skipRuntimeUpdate: true
      });
      await cleanupWhileInsideStatusesForRegion({
        regionDocument,
        cleanupReason: "region-deleted"
      });
    } catch (caughtError) {
      error("Failed to cleanup linked documents or triggered statuses after Region deletion.", caughtError, {
        regionId: regionDocument?.id ?? null,
        templateId: runtime?.templateId ?? null
      });
    }
  }

  if (!isPersistentZonesCleanupOption(options)) {
    const siblingRegions = getManagedMultipartRegionGroup(regionDocument?.parent, runtime)
      .filter((region) => region?.id !== regionDocument?.id);
    if (siblingRegions.length) {
      await deleteManagedRegionGroup(siblingRegions, {
        reason: "multipart-region-manual-delete",
        deletionOptions: {
          persistentZonesCleanup: true,
          persistentZonesGroupDelete: true,
          persistentZonesRegionLifecycleCleanup: true
        }
      });
    }
  }

  await removeOwnerEffectForDeletedRegion(regionDocument, runtime, options);
}

async function removeOwnerEffectForDeletedRegion(regionDocument, runtime, options = {}) {
  if (options?.persistentZonesEffectLifecycleCleanup || options?.persistentZonesRegionLifecycleCleanup) {
    return;
  }

  const ownerEffectUuid = getOwnerEffectUuidFromRuntime(runtime);
  if (!ownerEffectUuid) {
    return;
  }

  const sharedRegions = findManagedRegionsReferencingOwnerEffect(ownerEffectUuid, {
    excludeRegionId: regionDocument?.id ?? null,
    excludeRegionUuid: regionDocument?.uuid ?? null
  });
  if (sharedRegions.length) {
    console.info(`[${MODULE_ID}][lifecycle] OWNER EFFECT RETAINED SHARED BY OTHER REGION`, {
      ownerEffectUuid,
      deletedRegionId: regionDocument?.id ?? null,
      sharedRegionIds: sharedRegions.map((region) => region?.id ?? null).filter(Boolean)
    });
    return;
  }

  const ownerEffect = await fromUuidSafe(ownerEffectUuid);
  if (!ownerEffect?.delete) {
    return;
  }

  if (isPersistentZonesDedicatedOwnerEffect(ownerEffect)) {
    await deleteDedicatedOwnerEffectIfOrphaned(ownerEffect, {
      reason: "region-deleted"
    });
    return;
  }

  await ownerEffect.delete({ persistentZonesRegionLifecycleCleanup: true });
  console.info(`[${MODULE_ID}][lifecycle] OWNER EFFECT REMOVED FROM REGION`, {
    ownerEffectUuid,
    deletedRegionId: regionDocument?.id ?? null
  });
}

function findManagedRegionsReferencingOwnerEffect(ownerEffectUuid, {
  excludeRegionId = null,
  excludeRegionUuid = null
} = {}) {
  const matches = [];
  for (const scene of game?.scenes?.contents ?? []) {
    for (const region of findManagedRegions(scene)) {
      if (!region || region.id === excludeRegionId || region.uuid === excludeRegionUuid) {
        continue;
      }
      const runtime = getRegionRuntimeFlags(region) ?? {};
      if (getOwnerEffectUuidFromRuntime(runtime) === ownerEffectUuid) {
        matches.push(region);
      }
    }
  }
  return matches;
}

function getOwnerEffectUuidFromRuntime(runtime = {}) {
  return (
    runtime.ownerEffectUuid ??
    runtime.activeEffectUuid ??
    runtime.concentrationEffectUuid ??
    runtime.normalizedDefinition?.concentration?.effectUuid ??
    null
  );
}

function scheduleStartupDeleteProtectionExpiration(reason = "ready") {
  console.info(`[${MODULE_ID}][lifecycle] PZ STARTUP EXTERNAL DELETE PROTECTION ACTIVE`, {
    reason,
    protectionWindowMs: STARTUP_EXTERNAL_DELETE_PROTECTION_MS,
    startupDeleteProtectionActive
  });

  setTimeout(() => {
    startupDeleteProtectionActive = false;
    console.info(`[${MODULE_ID}][lifecycle] PZ STARTUP EXTERNAL DELETE PROTECTION EXPIRED`, {
      reason,
      protectionWindowMs: STARTUP_EXTERNAL_DELETE_PROTECTION_MS
    });
  }, STARTUP_EXTERNAL_DELETE_PROTECTION_MS);
}

function evaluateStartupExternalDeleteProtection(regionDocument, options = {}, userId = null) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? null;
  const ownerEffectUuidBeforeReconciliation = getOwnerEffectUuidFromRuntime(runtime ?? {});
  const reconciliation = ownerEffectUuidBeforeReconciliation
    ? { attempted: false, result: "owner-effect-already-linked", selectedOwnerEffectUuid: ownerEffectUuidBeforeReconciliation, ambiguous: false, backfillApplied: false }
    : reconcileOwnerEffectLinkForRegionSync(regionDocument, {
      reason: "preDeleteRegion",
      allowAsyncBackfill: true
    });
  const ownerEffectUuid = ownerEffectUuidBeforeReconciliation ?? reconciliation.selectedOwnerEffectUuid ?? null;
  const scene = regionDocument?.parent ?? null;
  const managedRegionDetected = Boolean(runtime);
  const persistentZonesCleanupOptionDetected = isPersistentZonesCleanupOption(options);
  const ownerEffect = ownerEffectUuid ? resolveOwnerEffectSync(ownerEffectUuid) : null;
  const ownerEffectResolved = Boolean(ownerEffect);
  const relevant = Boolean(managedRegionDetected) && startupDeleteProtectionActive;
  const deletionAllowed =
    !relevant ||
    (!ownerEffectUuid && !reconciliation.ambiguous) ||
    (!ownerEffectResolved && !reconciliation.ambiguous) ||
    persistentZonesCleanupOptionDetected;
  const blockingReason = deletionAllowed
    ? null
    : reconciliation.ambiguous
      ? "startup-owner-effect-ambiguous"
      : "startup-external-delete-owner-effect-still-valid";

  return {
    blocked: !deletionAllowed,
    relevant,
    logData: {
      sceneId: scene?.id ?? null,
      regionId: regionDocument?.id ?? null,
      managedRegionDetected,
      ownerEffectUuid,
      ownerEffectUuidBeforeReconciliation,
      ownerEffectUuidAfterReconciliation: ownerEffectUuid,
      reconciliationAttempted: reconciliation.attempted,
      reconciliationResult: reconciliation.result,
      ownerEffectResolved,
      startupDeleteProtectionActive,
      deletionOptions: duplicateData(options ?? {}),
      deletionUserId: userId ?? null,
      deletionReason: options?.reason ?? options?.deletionReason ?? null,
      deletionAllowed,
      blockingReason,
      persistentZonesCleanupOptionDetected
    }
  };
}

function isPersistentZonesCleanupOption(options = {}) {
  if (options?.persistentZonesCleanup === true) {
    return true;
  }

  return Object.keys(options ?? {}).some((key) => key.startsWith("persistentZones"));
}

function resolveOwnerEffectSync(ownerEffectUuid) {
  if (!ownerEffectUuid) {
    return null;
  }

  try {
    const resolved = globalThis.fromUuidSync?.(ownerEffectUuid);
    if (resolved?.documentName === "ActiveEffect") {
      return resolved;
    }
  } catch (_caughtError) {
    // Fall through to manual actor-owned effect lookup.
  }

  const parts = String(ownerEffectUuid).split(".");
  const actorIndex = parts.findIndex((part) => part === "Actor");
  const effectIndex = parts.findIndex((part) => part === "ActiveEffect");
  const actorId = actorIndex >= 0 ? parts[actorIndex + 1] ?? null : null;
  const effectId = effectIndex >= 0 ? parts[effectIndex + 1] ?? null : null;
  if (!actorId || !effectId) {
    return null;
  }

  const actor = game?.actors?.get?.(actorId);
  return Array.from(actor?.effects ?? []).find((effect) => effect?.id === effectId) ?? null;
}

async function onOwnerActiveEffectChanged(hook, activeEffect, changed = {}, options = {}) {
  if (!isPrimaryGM() || isPersistentZonesCleanupOption(options)) {
    return;
  }

  const reconciled = await reconcileOwnerEffectLinksForActiveEffect(activeEffect, {
    reason: hook,
    changedKeys: Object.keys(changed ?? {})
  });
  await reconcileMissingOwnerEffectLinksForWorld({ reason: `${hook}-post-effect` });
  logOwnerEffectOwnershipSnapshot({ reason: hook, activeEffect, reconciledCount: reconciled.length });
  await evaluateDedicatedOwnerEffectExpiration(activeEffect, {
    hookName: hook,
    changed,
    options
  });
}

async function reconcileMissingOwnerEffectLinksForWorld({ reason = "manual" } = {}) {
  if (!isPrimaryGM()) {
    return [];
  }

  const results = [];
  for (const scene of game?.scenes?.contents ?? []) {
    for (const region of findManagedRegions(scene)) {
      let runtime = getRegionRuntimeFlags(region) ?? {};
      const currentOwnerEffectUuid = getOwnerEffectUuidFromRuntime(runtime);
      if (currentOwnerEffectUuid) {
        const currentOwnerEffect = resolveOwnerEffectSync(currentOwnerEffectUuid);
        const currentMatch = currentOwnerEffect
          ? buildOwnerEffectCandidateMatch(region, runtime, currentOwnerEffect)
          : null;
        if (currentMatch?.lifecycleEligible) continue;
        if (runtime.normalizedDefinition?.concentration?.required !== true) continue;
        await clearInvalidOwnerEffectLink(region, currentOwnerEffectUuid, {
          reason,
          rejectionReason: currentMatch?.lifecycleEligibilityReason ?? "owner-effect-unresolved"
        });
        runtime = {
          ...runtime,
          ownerEffectUuid: null,
          activeEffectUuid: null,
          concentrationEffectUuid: null
        };
      }
      const reconciliation = reconcileOwnerEffectLinkForRegionSync(region, {
        reason,
        allowAsyncBackfill: false
      });
      if (reconciliation.selectedOwnerEffect) {
        await applyOwnerEffectBackfill(region, runtime, reconciliation.selectedOwnerEffect, {
          reason,
          resolutionMode: reconciliation.resolutionMode,
          matchingSignals: reconciliation.matchingSignals
        });
      }
      results.push(reconciliation);
    }
  }
  return results;
}

async function onDedicatedOwnerExpirationTick(hookName, context = {}) {
  if (!isPrimaryGM()) {
    return;
  }
  await cleanupExpiredDedicatedOwnerEffectsForWorld({ hookName, context });
}

async function cleanupExpiredDedicatedOwnerEffectsForWorld({ hookName = "manual", context = {} } = {}) {
  const results = [];
  for (const actor of game?.actors?.contents ?? []) {
    for (const effect of actor?.effects ?? []) {
      if (!isPersistentZonesDedicatedOwnerEffect(effect)) {
        continue;
      }
      const result = await evaluateDedicatedOwnerEffectExpiration(effect, {
        hookName,
        context
      });
      results.push(result);
    }
  }
  return results;
}

async function evaluateDedicatedOwnerEffectExpiration(activeEffect, {
  hookName = "manual",
  changed = {},
  options = {},
  context = {}
} = {}) {
  if (!activeEffect || !isPersistentZonesDedicatedOwnerEffect(activeEffect)) {
    return { evaluated: false, reason: "not-persistent-zones-dedicated-owner" };
  }
  const target = findRegionForDedicatedOwnerEffect(activeEffect);
  const expiration = isDedicatedOwnerEffectExpired(activeEffect, { hookName, changed, options, context });
  logOwnerEffectExpirationEvent(activeEffect, target?.region ?? null, {
    hookName,
    changed,
    context,
    expiration
  });
  const decision = buildOwnerEffectExpirationDecision(activeEffect, target?.region ?? null, expiration);
  logOwnerEffectExpirationDecision(decision);
  if (!decision.cleanupAllowed) {
    return decision;
  }
  return cleanupExpiredDedicatedOwnerRegion(activeEffect, target.region, {
    decision,
    expiration
  });
}

function findRegionForDedicatedOwnerEffect(activeEffect) {
  const effectData = activeEffect?.toObject?.() ?? {};
  const sceneId = getPropertyPath(effectData, `flags.${MODULE_ID}.sceneId`) ?? activeEffect?.flags?.[MODULE_ID]?.sceneId ?? null;
  const regionId = getPropertyPath(effectData, `flags.${MODULE_ID}.regionId`) ?? activeEffect?.flags?.[MODULE_ID]?.regionId ?? null;
  const regionUuid = getPropertyPath(effectData, `flags.${MODULE_ID}.regionUuid`) ?? activeEffect?.flags?.[MODULE_ID]?.regionUuid ?? null;
  const groupId = getPropertyPath(effectData, `flags.${MODULE_ID}.groupId`) ?? activeEffect?.flags?.[MODULE_ID]?.groupId ?? null;
  const castInstanceId = getPropertyPath(effectData, `flags.${MODULE_ID}.castInstanceId`) ?? activeEffect?.flags?.[MODULE_ID]?.castInstanceId ?? null;
  const scene = sceneId ? game?.scenes?.get?.(sceneId) : null;
  const region = scene?.regions?.get?.(regionId) ??
    Array.from(scene?.regions ?? []).find((candidate) => candidate?.uuid === regionUuid) ??
    null;
  if (!region) {
    return { region: null, reason: "region-not-found" };
  }
  const runtime = getRegionRuntimeFlags(region) ?? {};
  const valid = getOwnerEffectUuidFromRuntime(runtime) === activeEffect?.uuid &&
    (!groupId || runtime.groupId === groupId) &&
    (!castInstanceId || runtime.castInstanceId === castInstanceId);
  return {
    region: valid ? region : null,
    reason: valid ? "exact-region-owner-link" : "region-link-mismatch",
    runtime
  };
}

function isDedicatedOwnerEffectExpired(activeEffect, {
  hookName = "manual",
  changed = {},
  context = {}
} = {}) {
  const data = activeEffect?.toObject?.() ?? {};
  const duration = data.duration ?? activeEffect?.duration ?? {};
  const disabled = Boolean(activeEffect?.disabled ?? data.disabled);
  const expiration = resolveActiveEffectExpiration(activeEffect, {
    effectData: data,
    worldTime: context?.worldTime ?? globalThis.game?.time?.worldTime,
    combat: context?.combat ?? globalThis.game?.combat ?? null
  });
  const { durationExpired, remaining, remainingExpired, modernExpired, legacyExpired } = expiration;
  const expirationDetected = expiration.expired;
  const disabledOnly = disabled && !expirationDetected;
  return {
    expired: expirationDetected && !disabledOnly,
    reason: durationExpired ? "duration-expired-flag" :
      remainingExpired ? "duration-remaining-zero" :
        modernExpired ? "duration-modern-elapsed" :
          legacyExpired ? "duration-legacy-elapsed" :
            disabledOnly ? "manual-disabled-or-ambiguous-disabled" : "no-expiration-signal",
    signalSource: durationExpired ? "duration.expired" :
      remainingExpired ? "duration.remaining" :
        modernExpired ? "duration.value-units-start" :
          legacyExpired ? "duration-legacy-fields" :
            disabledOnly ? "disabled-without-duration-expiration" : "none",
    remaining,
    durationExpired,
    disabled,
    deletionExpected: false,
    duration: duplicateData(duration),
    changedKeys: Object.keys(changed ?? {}),
    hookName
  };
}

function buildOwnerEffectExpirationDecision(activeEffect, region, expiration) {
  const effectData = activeEffect?.toObject?.() ?? {};
  const pzFlags = effectData.flags?.[MODULE_ID] ?? activeEffect?.flags?.[MODULE_ID] ?? {};
  const runtime = getRegionRuntimeFlags(region) ?? {};
  const concentrationRequired = pzFlags.concentrationRequired === true || runtime.normalizedDefinition?.concentration?.required === true;
  const cleanupKey = buildOwnerEffectExpirationCleanupKey(activeEffect, region);
  const cleanupAlreadyRunning = cleanupKey ? activeDedicatedOwnerExpirationCleanups.has(cleanupKey) : false;
  const managedOwnerEffect = isPersistentZonesDedicatedOwnerEffect(activeEffect);
  const cleanupAllowed = Boolean(
    managedOwnerEffect &&
    !concentrationRequired &&
    region &&
    expiration.expired &&
    !cleanupAlreadyRunning
  );
  return {
    effectUuid: activeEffect?.uuid ?? null,
    regionUuid: region?.uuid ?? pzFlags.regionUuid ?? null,
    sceneId: region?.parent?.id ?? pzFlags.sceneId ?? null,
    groupId: runtime.groupId ?? pzFlags.groupId ?? null,
    castInstanceId: runtime.castInstanceId ?? pzFlags.castInstanceId ?? null,
    managedOwnerEffect,
    concentrationRequired,
    disabled: expiration.disabled,
    duration: duplicateData(expiration.duration ?? {}),
    remaining: expiration.remaining,
    durationExpired: expiration.durationExpired,
    expirationDetected: expiration.expired,
    decisionReason: cleanupAllowed ? expiration.reason : !managedOwnerEffect ? "not-managed-owner-effect" :
      concentrationRequired ? "concentration-effect-ignored" :
        !region ? "linked-region-not-found" :
          cleanupAlreadyRunning ? "cleanup-already-running" : expiration.reason,
    cleanupAllowed,
    cleanupAlreadyRunning
  };
}

async function cleanupExpiredDedicatedOwnerRegion(activeEffect, region, {
  decision = {},
  expiration = {}
} = {}) {
  const cleanupKey = buildOwnerEffectExpirationCleanupKey(activeEffect, region);
  if (!cleanupKey) {
    return { cleanupSucceeded: false, reason: "missing-cleanup-key" };
  }
  if (activeDedicatedOwnerExpirationCleanups.has(cleanupKey)) {
    const result = buildOwnerEffectExpirationCleanupResult(activeEffect, region, {
      alreadyCleaned: true,
      cleanupSucceeded: true,
      errors: []
    });
    logOwnerEffectExpirationCleanupResult(result);
    return result;
  }
  activeDedicatedOwnerExpirationCleanups.add(cleanupKey);
  try {
    const scene = region?.parent ?? null;
    const runtime = getRegionRuntimeFlags(region) ?? {};
    const multipartGroup = getManagedMultipartRegionGroup(scene, runtime);
    const regionsToDelete = multipartGroup.length ? multipartGroup : [region];
    const linkedWallCountBefore = regionsToDelete.reduce((count, candidate) =>
      count + Array.from(getRegionRuntimeFlags(candidate)?.linkedDocuments?.wallIds ?? []).length, 0);
    const linkedLightCountBefore = regionsToDelete.reduce((count, candidate) =>
      count + Array.from(getRegionRuntimeFlags(candidate)?.linkedDocuments?.lightIds ?? []).length, 0);
    const regionFound = Boolean(scene?.regions?.get?.(region.id));
    if (regionFound) {
      await deleteManagedRegionGroup(regionsToDelete, {
        reason: "owner-effect-expired",
        deletionOptions: {
          persistentZonesEffectLifecycleCleanup: true,
          persistentZonesOwnerEffectExpirationCleanup: true,
          persistentZonesGroupDelete: multipartGroup.length > 1
        }
      });
    }
    const orphanCleanup = await deleteDedicatedOwnerEffectIfOrphaned(activeEffect, {
      reason: "owner-effect-expired-region-cleanup"
    });
    const result = buildOwnerEffectExpirationCleanupResult(activeEffect, region, {
      linkedWallCountBefore,
      linkedLightCountBefore,
      regionFound,
      regionDeleted: regionFound,
      linkedDocumentsDeleted: regionFound,
      effectDeletedByPZ: orphanCleanup.deleted === true,
      alreadyCleaned: !regionFound,
      cleanupSucceeded: true,
      errors: []
    });
    logOwnerEffectExpirationCleanupResult(result);
    return result;
  } catch (caughtError) {
    const result = buildOwnerEffectExpirationCleanupResult(activeEffect, region, {
      cleanupSucceeded: false,
      errors: [caughtError?.message ?? "unknown"]
    });
    logOwnerEffectExpirationCleanupResult(result);
    return result;
  } finally {
    activeDedicatedOwnerExpirationCleanups.delete(cleanupKey);
  }
}

function buildOwnerEffectExpirationCleanupKey(activeEffect, region) {
  const effectUuid = activeEffect?.uuid ?? null;
  const regionUuid = region?.uuid ?? activeEffect?.flags?.[MODULE_ID]?.regionUuid ?? null;
  return effectUuid && regionUuid ? `${effectUuid}|${regionUuid}` : null;
}

function logOwnerEffectExpirationEvent(activeEffect, region, {
  hookName = "manual",
  changed = {},
  context = {},
  expiration = {}
} = {}) {
  try {
    const data = activeEffect?.toObject?.() ?? {};
    const beforeDuration = duplicateData(data.duration ?? activeEffect?.duration ?? {});
    console.warn(`[${MODULE_ID}][lifecycle] PZ OWNER EFFECT EXPIRATION EVENT`, {
      hookName,
      timestamp: Date.now(),
      effectId: activeEffect?.id ?? null,
      effectUuid: activeEffect?.uuid ?? null,
      effectName: activeEffect?.name ?? data.name ?? null,
      actorUuid: activeEffect?.parent?.uuid ?? null,
      regionId: region?.id ?? data.flags?.[MODULE_ID]?.regionId ?? null,
      regionUuid: region?.uuid ?? data.flags?.[MODULE_ID]?.regionUuid ?? null,
      managedOwnerEffect: isPersistentZonesDedicatedOwnerEffect(activeEffect),
      disabledBefore: changed?.disabled?.from ?? null,
      disabledAfter: Boolean(activeEffect?.disabled ?? data.disabled),
      durationBefore: beforeDuration,
      durationAfter: beforeDuration,
      expiredBefore: null,
      expiredAfter: expiration.durationExpired ?? false,
      remainingBefore: null,
      remainingAfter: expiration.remaining ?? null,
      combatId: context?.combat?.id ?? game?.combat?.id ?? null,
      round: context?.combat?.round ?? game?.combat?.round ?? null,
      turn: context?.combat?.turn ?? game?.combat?.turn ?? null,
      worldTime: context?.worldTime ?? game?.time?.worldTime ?? null,
      deletionObserved: false,
      expirationSignalDetected: expiration.expired ?? false,
      expirationSignalSource: expiration.signalSource ?? null
    });
  } catch (caughtError) {
    logV14RegionDiagnostic("ownerEffectExpirationEventLogFailed", {
      reason: caughtError?.message ?? "unknown"
    });
  }
}

function logOwnerEffectExpirationDecision(decision = {}) {
  try {
    console.warn(`[${MODULE_ID}][lifecycle] PZ OWNER EFFECT EXPIRATION DECISION`, duplicateData(decision));
  } catch (caughtError) {
    logV14RegionDiagnostic("ownerEffectExpirationDecisionLogFailed", {
      reason: caughtError?.message ?? "unknown"
    });
  }
}

function buildOwnerEffectExpirationCleanupResult(activeEffect, region, {
  linkedWallCountBefore = null,
  linkedLightCountBefore = null,
  regionFound = null,
  regionDeleted = false,
  linkedDocumentsDeleted = false,
  effectDeletedByPZ = false,
  alreadyCleaned = false,
  cleanupSucceeded = false,
  errors = []
} = {}) {
  const runtime = getRegionRuntimeFlags(region) ?? {};
  const pzFlags = activeEffect?.flags?.[MODULE_ID] ?? {};
  return {
    effectUuid: activeEffect?.uuid ?? null,
    regionUuid: region?.uuid ?? pzFlags.regionUuid ?? null,
    sceneId: region?.parent?.id ?? pzFlags.sceneId ?? null,
    groupId: runtime.groupId ?? pzFlags.groupId ?? null,
    castInstanceId: runtime.castInstanceId ?? pzFlags.castInstanceId ?? null,
    regionFound,
    linkedWallCountBefore: linkedWallCountBefore ?? Array.from(runtime.linkedDocuments?.wallIds ?? []).length,
    linkedLightCountBefore: linkedLightCountBefore ?? Array.from(runtime.linkedDocuments?.lightIds ?? []).length,
    regionDeleted,
    linkedDocumentsDeleted,
    effectDeletedByPZ,
    alreadyCleaned,
    cleanupSucceeded,
    errors: duplicateData(errors ?? [])
  };
}

function logOwnerEffectExpirationCleanupResult(result = {}) {
  try {
    console.warn(`[${MODULE_ID}][lifecycle] PZ OWNER EFFECT EXPIRATION CLEANUP RESULT`, duplicateData(result));
  } catch (caughtError) {
    logV14RegionDiagnostic("ownerEffectExpirationCleanupResultLogFailed", {
      reason: caughtError?.message ?? "unknown"
    });
  }
}

async function reconcileOwnerEffectLinksForActiveEffect(activeEffect, { reason = "active-effect", changedKeys = [] } = {}) {
  const effectActor = activeEffect?.parent ?? null;
  if (!effectActor) {
    return [];
  }

  const candidates = [];
  for (const scene of game?.scenes?.contents ?? []) {
    for (const region of findManagedRegions(scene)) {
      const runtime = getRegionRuntimeFlags(region) ?? {};
      if (getOwnerEffectUuidFromRuntime(runtime)) {
        continue;
      }
      const match = buildOwnerEffectCandidateMatch(region, runtime, activeEffect);
      if (match.matchesActorAndItem || match.hasExplicitSignal) {
        candidates.push({ region, runtime, match });
      }
    }
  }

  for (const candidate of candidates) {
    const sameActorItemCandidates = candidates.filter((entry) => {
      return entry.match.actorMatches && entry.match.itemMatches;
    });
    const resolution = selectOwnerEffectForRegion(candidate.region, [activeEffect], {
      sameActorItemCandidateCount: sameActorItemCandidates.length
    });
    logOwnerEffectLinkReconciliation(candidate.region, candidate.runtime, resolution, {
      reason,
      changedKeys
    });
    if (resolution.selectedOwnerEffect && !resolution.ambiguous) {
      await applyOwnerEffectBackfill(candidate.region, candidate.runtime, resolution.selectedOwnerEffect, {
        reason,
        resolutionMode: resolution.resolutionMode,
        matchingSignals: resolution.matchingSignals
      });
    }
  }

  return candidates;
}

function reconcileOwnerEffectLinkForRegionSync(regionDocument, {
  reason = "manual",
  allowAsyncBackfill = false
} = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const effects = collectPotentialOwnerEffectsForRegion(runtime);
  const resolution = selectOwnerEffectForRegion(regionDocument, effects);
  logOwnerEffectLinkReconciliation(regionDocument, runtime, resolution, { reason });

  if (resolution.selectedOwnerEffect && !resolution.ambiguous) {
    if (allowAsyncBackfill) {
      Promise.resolve(applyOwnerEffectBackfill(regionDocument, runtime, resolution.selectedOwnerEffect, {
        reason,
        resolutionMode: resolution.resolutionMode,
        matchingSignals: resolution.matchingSignals
      })).catch((caughtError) => {
        logV14RegionDiagnostic("ownerEffectLinkBackfillFailed", {
          reason: caughtError?.message ?? "unknown",
          stack: caughtError?.stack ?? null,
          regionId: regionDocument?.id ?? null,
          selectedOwnerEffectUuid: resolution.selectedOwnerEffect?.uuid ?? null
        });
      });
    }
    return {
      attempted: true,
      result: "selected",
      selectedOwnerEffectUuid: resolution.selectedOwnerEffect.uuid,
      selectedOwnerEffect: resolution.selectedOwnerEffect,
      resolutionMode: resolution.resolutionMode,
      ambiguous: false,
      backfillApplied: allowAsyncBackfill,
      matchingSignals: resolution.matchingSignals
    };
  }

  return {
    attempted: true,
    result: resolution.ambiguous ? "ambiguous" : "not-found",
    selectedOwnerEffectUuid: null,
    selectedOwnerEffect: null,
    resolutionMode: resolution.resolutionMode,
    ambiguous: resolution.ambiguous,
    backfillApplied: false,
    matchingSignals: resolution.matchingSignals
  };
}

function collectPotentialOwnerEffectsForRegion(runtime = {}) {
  const actorUuid = runtime.actorUuid ?? runtime.casterUuid ?? runtime.normalizedDefinition?.actorUuid ?? null;
  const actor = resolveActorSync(actorUuid);
  if (actor) {
    return Array.from(actor.effects ?? []);
  }

  return Array.from(game?.actors?.contents ?? [])
    .flatMap((candidateActor) => Array.from(candidateActor?.effects ?? []));
}

function selectOwnerEffectForRegion(regionDocument, effects = [], { sameActorItemCandidateCount = null } = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const nonConcentration = isNonConcentrationRuntime(runtime);
  const matches = Array.from(effects ?? [])
    .map((effect) => buildOwnerEffectCandidateMatch(regionDocument, runtime, effect))
    .filter((match) => match.hasAnySignal)
    .map((match) => ({
      ...match,
      alreadyOwnedByOtherRegionIds: findManagedRegionsReferencingOwnerEffect(match.effect?.uuid ?? null, {
        excludeRegionId: regionDocument?.id ?? null,
        excludeRegionUuid: regionDocument?.uuid ?? null
      }).filter((region) => isNonConcentrationRuntime(getRegionRuntimeFlags(region) ?? {}))
        .map((region) => region?.id ?? null)
        .filter(Boolean)
    }))
    .filter((match) => {
      if (!nonConcentration || isPersistentZonesDedicatedOwnerEffect(match.effect)) {
        return true;
      }
      return !match.alreadyOwnedByOtherRegionIds.length;
    });
  const ownerEligibleMatches = nonConcentration
    ? matches.filter((match) => isPersistentZonesDedicatedOwnerEffect(match.effect))
    : matches;
  const explicitMatches = ownerEligibleMatches.filter((match) => match.hasExplicitSignal);
  const launchMatches = ownerEligibleMatches.filter((match) => match.hasLaunchSignal);
  const actorItemMatches = nonConcentration
    ? []
    : ownerEligibleMatches.filter((match) => match.actorMatches && match.itemMatches);
  const selectedMatch =
    uniqueMatch(explicitMatches) ??
    uniqueMatch(launchMatches) ??
    (sameActorItemCandidateCount === null || sameActorItemCandidateCount === 1
      ? uniqueMatch(actorItemMatches)
      : null);
  const ambiguous =
    !selectedMatch &&
    (explicitMatches.length > 1 || launchMatches.length > 1 || actorItemMatches.length > 1 || sameActorItemCandidateCount > 1);
  const resolutionMode = selectedMatch?.resolutionMode ??
    (ambiguous ? "ambiguous" : "no-owner-effect-match");

  return {
    selectedOwnerEffect: selectedMatch?.effect ?? null,
    selectedOwnerEffectUuid: selectedMatch?.effect?.uuid ?? null,
    candidateEffectUuids: matches.map((match) => match.effect?.uuid ?? null).filter(Boolean),
    candidateCount: matches.length,
    ownerEligibleEffectUuids: ownerEligibleMatches.map((match) => match.effect?.uuid ?? null).filter(Boolean),
    matchingSignals: matches.map((match) => ({
      effectUuid: match.effect?.uuid ?? null,
      candidateCreatedAt: match.candidateCreatedAt,
      alreadyOwnedByOtherRegionIds: match.alreadyOwnedByOtherRegionIds ?? [],
      signals: match.signals,
      resolutionMode: match.resolutionMode
    })),
    resolutionMode,
    ambiguous
  };
}

function uniqueMatch(matches) {
  return matches.length === 1 ? matches[0] : null;
}

function buildOwnerEffectCandidateMatch(regionDocument, runtime = {}, activeEffect = null) {
  const effectActor = activeEffect?.parent ?? null;
  const effectData = activeEffect?.toObject?.() ?? {};
  const effectText = stringifyDiagnosticJson(effectData);
  const effectItemUuid = resolveActiveEffectItemUuid(activeEffect, effectData);
  const effectActivityId = resolveActiveEffectActivityId(activeEffect, effectData);
  const candidateCreatedAt = resolveActiveEffectCreatedAt(activeEffect, effectData);
  const actorUuid = runtime.actorUuid ?? runtime.casterUuid ?? runtime.normalizedDefinition?.actorUuid ?? null;
  const itemUuid = runtime.itemUuid ?? null;
  const regionId = regionDocument?.id ?? runtime.finalRegionId ?? runtime.sourceRegionId ?? null;
  const regionUuid = regionDocument?.uuid ?? runtime.regionDocumentUuid ?? null;
  const sourceTemplateUuid = runtime.sourceTemplateUuid ?? runtime.templateUuid ?? null;
  const sourceTemplateId = runtime.sourceTemplateId ?? runtime.templateId ?? null;
  const activityId = runtime.activityId ?? null;
  const workflowId = runtime.workflowId ?? null;
  const statusSourceEffect = isStatusSourceEffect(activeEffect, MODULE_ID);
  const concentrationEffect = hasStructuredConcentrationSignal(activeEffect, effectData);
  const signals = {
    dedicatedOwnerEffect: Boolean(isPersistentZonesDedicatedOwnerEffect(activeEffect) && (
      getPropertyPath(effectData, `flags.${MODULE_ID}.regionId`) === regionId ||
      getPropertyPath(effectData, `flags.${MODULE_ID}.regionUuid`) === regionUuid ||
      getPropertyPath(effectData, `flags.${MODULE_ID}.groupId`) === runtime.groupId ||
      getPropertyPath(effectData, `flags.${MODULE_ID}.sourceRegionId`) === runtime.sourceRegionId ||
      getPropertyPath(effectData, `flags.${MODULE_ID}.castInstanceId`) === runtime.castInstanceId
    )),
    explicitRegion: Boolean((regionUuid && effectText.includes(regionUuid)) || (regionId && effectText.includes(regionId))),
    explicitTemplate: Boolean((sourceTemplateUuid && effectText.includes(sourceTemplateUuid)) || (sourceTemplateId && effectText.includes(sourceTemplateId))),
    workflow: Boolean(workflowId && effectText.includes(workflowId)),
    activity: Boolean(activityId && (effectActivityId === activityId || effectText.includes(activityId))),
    actor: Boolean(actorUuid && effectActor?.uuid === actorUuid),
    item: Boolean(itemUuid && (effectItemUuid === itemUuid || String(activeEffect?.origin ?? "").startsWith(itemUuid)))
  };
  const qualification = qualifyLifecycleOwnerCandidate({
    dedicatedOwnerEffect: signals.dedicatedOwnerEffect,
    statusSourceEffect,
    concentrationEffect,
    actorRequired: Boolean(actorUuid),
    actorMatches: signals.actor,
    itemRequired: Boolean(itemUuid),
    itemMatches: signals.item,
    activityRequired: Boolean(activityId && effectActivityId),
    activityMatches: signals.activity,
    workflowMatches: signals.workflow
  });
  const hasExplicitSignal = qualification.eligible &&
    (signals.dedicatedOwnerEffect || signals.explicitRegion || signals.explicitTemplate);
  const hasLaunchSignal = qualification.eligible && (signals.workflow || signals.activity);
  const matchesActorAndItem = signals.actor && signals.item;
  const hasAnySignal = qualification.eligible && (hasExplicitSignal || hasLaunchSignal || matchesActorAndItem);
  const resolutionMode = signals.dedicatedOwnerEffect
    ? "persistent-zones-dedicated-owner-effect"
    : signals.explicitRegion
      ? "explicit-active-effect-region-reference"
      : signals.explicitTemplate
      ? "explicit-active-effect-template-reference"
      : signals.workflow
        ? "shared-workflow-id"
        : signals.activity
          ? "shared-activity-id"
          : matchesActorAndItem
            ? "unique-actor-item-match"
            : "no-match";

  return {
    effect: activeEffect,
    candidateCreatedAt,
    signals,
    hasExplicitSignal,
    hasLaunchSignal,
    matchesActorAndItem,
    actorMatches: signals.actor,
    itemMatches: signals.item,
    lifecycleEligible: qualification.eligible,
    lifecycleEligibilityReason: qualification.reason,
    statusSourceEffect,
    concentrationEffect,
    hasAnySignal,
    resolutionMode
  };
}

async function applyOwnerEffectBackfill(regionDocument, runtime = {}, activeEffect, {
  reason = "manual",
  resolutionMode = null,
  matchingSignals = []
} = {}) {
  if (!regionDocument?.update || !activeEffect?.uuid) {
    return false;
  }
  if (!isRegionDocumentStillPresent(regionDocument)) {
    logV14RegionDiagnostic("ownerEffectLinkBackfillSkipped", {
      regionId: regionDocument?.id ?? null,
      reason: "region-no-longer-present"
    });
    return false;
  }

  const currentRuntime = getRegionRuntimeFlags(regionDocument) ?? runtime;
  if (getOwnerEffectUuidFromRuntime(currentRuntime)) {
    return false;
  }
  if (isNonConcentrationRuntime(currentRuntime) && !isPersistentZonesDedicatedOwnerEffect(activeEffect)) {
    logOwnerEffectLinkReconciliation(regionDocument, currentRuntime, {
      selectedOwnerEffect: null,
      selectedOwnerEffectUuid: null,
      candidateEffectUuids: [activeEffect.uuid],
      candidateCount: 1,
      matchingSignals,
      resolutionMode: "non-concentration-generic-owner-rejected",
      ambiguous: false
    }, {
      reason,
      backfillApplied: false
    });
    return false;
  }

  const updateData = {
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.ownerEffectUuid`]: activeEffect.uuid,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.activeEffectUuid`]: activeEffect.uuid,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.ownerEffectLinkReconciledAt`]: Date.now(),
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.ownerEffectLinkResolutionMode`]: resolutionMode
  };
  if (!currentRuntime.concentrationEffectUuid && !isNonConcentrationRuntime(currentRuntime)) {
    updateData[`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.concentrationEffectUuid`] = activeEffect.uuid;
  }

  await regionDocument.update(updateData, {
    persistentZonesOwnerEffectLinkReconciliation: true
  });
  logOwnerEffectLinkReconciliation(regionDocument, currentRuntime, {
    selectedOwnerEffect: activeEffect,
    selectedOwnerEffectUuid: activeEffect.uuid,
    candidateEffectUuids: [activeEffect.uuid],
    candidateCount: 1,
    matchingSignals,
    resolutionMode,
    ambiguous: false
  }, {
    reason,
    backfillApplied: true
  });
  return true;
}

async function ensureDedicatedOwnerEffectForNonConcentrationRegion(regionDocument, runtime = {}, {
  sourceContext = null,
  operationId = null
} = {}) {
  if (!regionDocument || !isNonConcentrationRuntime(runtime)) {
    return null;
  }
  if (!isRegionDocumentStillPresent(regionDocument)) {
    return null;
  }

  const existingOwnerEffect = findDedicatedOwnerEffectForRegion(regionDocument, runtime);
  if (existingOwnerEffect) {
    await writeDedicatedOwnerEffectToRegion(regionDocument, runtime, existingOwnerEffect, {
      resolutionMode: "existing-persistent-zones-dedicated-owner"
    });
    await detachNonConcentrationRegionFromGenericOwnerEffects(regionDocument, runtime, existingOwnerEffect);
    return existingOwnerEffect;
  }

  const actor = resolveActorSync(runtime.actorUuid ?? runtime.casterUuid ?? null) ?? sourceContext?.actor ?? sourceContext?.caster ?? null;
  if (!actor?.createEmbeddedDocuments) {
    logNonConcentrationOwnerDetach(regionDocument, runtime, {
      detachApplied: false,
      detachReason: "missing-actor-createEmbeddedDocuments",
      concentrationRequired: false
    });
    return null;
  }

  const castInstanceId = runtime.castInstanceId ?? operationId ?? buildCastOperationId(regionDocument);
  const durationResolution = resolveDedicatedOwnerEffectDuration(runtime, sourceContext);
  const durationPayload = durationResolution.applied ? { duration: durationResolution.duration } : {};
  const presentation = resolveDedicatedOwnerEffectPresentation(regionDocument, runtime, sourceContext);
  const effectPayload = cleanDocumentCreateData({
    name: presentation.name,
    img: presentation.image,
    origin: runtime.itemUuid ?? null,
    disabled: false,
    ...durationPayload,
    system: { changes: [] },
    flags: {
      [MODULE_ID]: {
        managedOwnerEffect: true,
        sceneId: regionDocument?.parent?.id ?? null,
        regionId: regionDocument?.id ?? null,
        regionUuid: regionDocument?.uuid ?? null,
        sourceRegionId: runtime.sourceRegionId ?? regionDocument?.id ?? null,
        groupId: runtime.groupId ?? null,
        itemUuid: runtime.itemUuid ?? null,
        actorUuid: actor?.uuid ?? runtime.actorUuid ?? runtime.casterUuid ?? null,
        castInstanceId,
        concentrationRequired: false
      }
    }
  }, {
    removeTopLevelFields: new Set(["_id", "id", "parent", "documentName"])
  });

  let createdEffects = [];
  try {
    createdEffects = await actor.createEmbeddedDocuments("ActiveEffect", [effectPayload], {
      persistentZonesDedicatedOwnerEffectCreate: true
    });
  } catch (caughtError) {
    logDedicatedOwnerEffectCreateFailed(regionDocument, runtime, {
      castInstanceId,
      sourceDuration: durationResolution.sourceDuration,
      normalizedDuration: durationResolution.duration,
      acceptedDurationUnits: durationResolution.acceptedUnits,
      error: caughtError
    });
    const fallbackPayload = cleanDocumentCreateData({
      ...effectPayload,
      duration: undefined
    }, {
      removeTopLevelFields: new Set(["_id", "id", "parent", "documentName", "duration"])
    });
    createdEffects = await actor.createEmbeddedDocuments("ActiveEffect", [fallbackPayload], {
      persistentZonesDedicatedOwnerEffectCreate: true,
      persistentZonesDedicatedOwnerEffectDurationFallback: true
    });
  }
  const dedicatedOwnerEffect = Array.from(createdEffects ?? [])[0] ?? null;
  if (!dedicatedOwnerEffect) {
    return null;
  }

  console.warn(`[${MODULE_ID}][lifecycle] PZ DEDICATED OWNER EFFECT CREATED`, {
    regionId: regionDocument?.id ?? null,
    groupId: runtime.groupId ?? null,
    castInstanceId,
    effectId: dedicatedOwnerEffect?.id ?? null,
    effectUuid: dedicatedOwnerEffect?.uuid ?? null,
    durationSource: durationResolution.source,
    durationValue: duplicateData(durationResolution.duration),
    durationApplied: durationResolution.applied,
    concentrationRequired: false
  });

  await writeDedicatedOwnerEffectToRegion(regionDocument, {
    ...runtime,
    castInstanceId
  }, dedicatedOwnerEffect, {
    resolutionMode: "persistent-zones-dedicated-owner-created"
  });
  const finalRuntime = {
    ...runtime,
    castInstanceId
  };
  logDedicatedOwnerPresentationApplied(dedicatedOwnerEffect, regionDocument, presentation);
  await detachNonConcentrationRegionFromGenericOwnerEffects(regionDocument, finalRuntime, dedicatedOwnerEffect);
  logV14RegionDiagnostic("genericOwnerEffectPostCreateCleanupDisabled", {
    regionId: regionDocument?.id ?? null,
    groupId: finalRuntime.groupId ?? null,
    castInstanceId,
    reason: "preCreateActiveEffect-suppression-or-cascade-fallback-owned"
  });
  return dedicatedOwnerEffect;
}

async function writeDedicatedOwnerEffectToRegion(regionDocument, runtime = {}, ownerEffect, {
  resolutionMode = "persistent-zones-dedicated-owner"
} = {}) {
  if (!isRegionDocumentStillPresent(regionDocument) || !ownerEffect?.uuid) {
    return false;
  }

  const updateData = {
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.ownerEffectUuid`]: ownerEffect.uuid,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.activeEffectUuid`]: ownerEffect.uuid,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.concentrationEffectUuid`]: null,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.castInstanceId`]: runtime.castInstanceId ?? null,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.ownerEffectLinkReconciledAt`]: Date.now(),
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.ownerEffectLinkResolutionMode`]: resolutionMode
  };
  await regionDocument.update(updateData, {
    persistentZonesOwnerEffectLinkReconciliation: true,
    persistentZonesDedicatedOwnerEffectBackfill: true
  });
  return true;
}

function findDedicatedOwnerEffectForRegion(regionDocument, runtime = {}) {
  const actor = resolveActorSync(runtime.actorUuid ?? runtime.casterUuid ?? null);
  const effects = Array.from(actor?.effects ?? []);
  return effects.find((effect) => {
    if (!isPersistentZonesDedicatedOwnerEffect(effect)) {
      return false;
    }
    const data = effect?.toObject?.() ?? {};
    return getPropertyPath(data, `flags.${MODULE_ID}.regionId`) === regionDocument?.id ||
      getPropertyPath(data, `flags.${MODULE_ID}.regionUuid`) === regionDocument?.uuid ||
      getPropertyPath(data, `flags.${MODULE_ID}.groupId`) === runtime.groupId ||
      getPropertyPath(data, `flags.${MODULE_ID}.sourceRegionId`) === runtime.sourceRegionId ||
      getPropertyPath(data, `flags.${MODULE_ID}.castInstanceId`) === runtime.castInstanceId;
  }) ?? null;
}

async function detachNonConcentrationRegionFromGenericOwnerEffects(regionDocument, runtime = {}, dedicatedOwnerEffect = null) {
  const actor = resolveActorSync(runtime.actorUuid ?? runtime.casterUuid ?? null);
  const effects = Array.from(actor?.effects ?? []);
  const detachRows = [];
  for (const effect of effects) {
    if (!effect || effect.uuid === dedicatedOwnerEffect?.uuid || isPersistentZonesDedicatedOwnerEffect(effect)) {
      continue;
    }
    let detachResult = null;
    try {
      detachResult = await detachRegionFromEffectDependents(effect, regionDocument);
    } catch (caughtError) {
      detachResult = {
        detected: true,
        detachApplied: false,
        removedEffectDependency: false,
        method: "detach-failed",
        reason: caughtError?.message ?? "unknown"
      };
    }
    if (detachResult.detected) {
      detachRows.push({
        genericEffectUuid: effect.uuid ?? null,
        ...detachResult
      });
    }
  }

  logNonConcentrationOwnerDetach(regionDocument, runtime, {
    dedicatedOwnerEffectUuid: dedicatedOwnerEffect?.uuid ?? null,
    detectedDependencySignals: detachRows,
    removedEffectDependency: detachRows.some((row) => row.removedEffectDependency),
    detachApplied: detachRows.some((row) => row.detachApplied),
    detachReason: detachRows.length ? "generic-effect-dependency-detach-attempted" : "no-generic-effect-dependency-detected",
    concentrationRequired: false
  });
  return detachRows;
}

async function detachRegionFromEffectDependents(effect, regionDocument) {
  const data = effect?.toObject?.() ?? {};
  const regionRefs = [regionDocument?.uuid, regionDocument?.id].filter(Boolean);
  const dependents = data.dependents ?? effect?.dependents ?? null;
  const dependentText = stringifyCompact(dependents);
  const flagsText = stringifyCompact(data.flags ?? {});
  const detected = regionRefs.some((ref) => dependentText.includes(ref) || flagsText.includes(ref));
  if (!detected) {
    return { detected: false, detachApplied: false, removedEffectDependency: false };
  }

  if (typeof effect.deleteDependent === "function" && regionDocument?.uuid) {
    await effect.deleteDependent(regionDocument.uuid);
    return {
      detected: true,
      detachApplied: true,
      removedEffectDependency: true,
      method: "deleteDependent"
    };
  }

  if (Array.isArray(dependents)) {
    const filteredDependents = dependents.filter((dependent) => {
      const text = stringifyCompact(dependent);
      return !regionRefs.some((ref) => text.includes(ref));
    });
    if (filteredDependents.length !== dependents.length) {
      await effect.update({ dependents: filteredDependents }, {
        persistentZonesNonConcentrationOwnerDetach: true
      });
      return {
        detected: true,
        detachApplied: true,
        removedEffectDependency: true,
        method: "dependents-update"
      };
    }
  }

  return {
    detected: true,
    detachApplied: false,
    removedEffectDependency: false,
    method: "no-public-detach-api"
  };
}

async function cleanupGenericOwnerEffectsIfSafe(regionDocument, runtime = {}, dedicatedOwnerEffect = null, detachRows = []) {
  const actor = resolveActorSync(runtime.actorUuid ?? runtime.casterUuid ?? null);
  const genericEffectUuids = Array.from(detachRows ?? [])
    .map((row) => row.genericEffectUuid)
    .filter(Boolean);
  for (const effectUuid of genericEffectUuids) {
    const effect = Array.from(actor?.effects ?? []).find((candidate) => candidate?.uuid === effectUuid) ?? null;
    const decision = evaluateGenericOwnerEffectCleanupSafety(effect, {
      runtime,
      regionDocument,
      dedicatedOwnerEffect
    });
    if (!decision.safe) {
      logV14RegionDiagnostic("genericOwnerEffectCleanupSkipped", {
        effectUuid,
        regionId: regionDocument?.id ?? null,
        reason: decision.reason,
        details: decision
      });
      continue;
    }
    await effect.delete({
      persistentZonesGenericOwnerCleanup: true
    });
  }
}

function evaluateGenericOwnerEffectCleanupSafety(effect, {
  runtime = {},
  regionDocument = null,
  dedicatedOwnerEffect = null
} = {}) {
  if (!effect || isPersistentZonesDedicatedOwnerEffect(effect)) {
    return { safe: false, reason: "missing-or-dedicated-owner-effect" };
  }
  const data = effect?.toObject?.(false) ?? effect?.toObject?.() ?? {};
  const changes = Array.from(data.system?.changes ?? data.changes ?? []);
  if (changes.length) {
    return { safe: false, reason: "effect-has-mechanical-changes", changeCount: changes.length };
  }
  if (isEffectConcentrationLike(effect)) {
    return { safe: false, reason: "effect-is-concentration-like" };
  }
  const itemUuid = resolveActiveEffectItemUuid(effect, data);
  if (itemUuid && runtime.itemUuid && itemUuid !== runtime.itemUuid) {
    return { safe: false, reason: "different-item", itemUuid };
  }
  const dependentRegions = collectEffectDependentRegions(effect);
  if (!dependentRegions.length) {
    return { safe: false, reason: "no-dependent-regions-confirmed" };
  }
  const unsafeDependent = dependentRegions.find((region) => {
    const dependentRuntime = getRegionRuntimeFlags(region) ?? {};
    const ownerEffectUuid = getOwnerEffectUuidFromRuntime(dependentRuntime);
    const ownerEffect = ownerEffectUuid ? resolveOwnerEffectSync(ownerEffectUuid) : null;
    return !isNonConcentrationRuntime(dependentRuntime) || !isPersistentZonesDedicatedOwnerEffect(ownerEffect);
  });
  if (unsafeDependent) {
    return {
      safe: false,
      reason: "dependent-region-not-pz-non-concentration-owned",
      unsafeRegionId: unsafeDependent?.id ?? null
    };
  }
  return {
    safe: true,
    reason: "generic-template-cleanup-effect-only-depends-on-pz-owned-non-concentration-regions",
    dependentRegionIds: dependentRegions.map((region) => region?.id ?? null).filter(Boolean),
    dedicatedOwnerEffectUuid: dedicatedOwnerEffect?.uuid ?? null,
    currentRegionId: regionDocument?.id ?? null
  };
}

function collectEffectDependentRegions(effect) {
  if (typeof effect?.getDependents !== "function") {
    return [];
  }
  return Array.from(effect.getDependents() ?? [])
    .filter((dependent) => dependent?.documentName === "Region");
}

function isEffectConcentrationLike(effect) {
  const data = effect?.toObject?.() ?? {};
  const text = stringifyCompact({
    name: effect?.name ?? data.name ?? null,
    statuses: Array.from(effect?.statuses ?? data.statuses ?? []),
    flags: data.flags ?? null
  }).toLowerCase();
  return text.includes("concentrat");
}

function resolveDedicatedOwnerEffectPresentation(regionDocument, runtime = {}, sourceContext = null) {
  const item = sourceContext?.item ?? null;
  const itemName = item?.name ?? runtime.normalizedDefinition?.label ?? regionDocument?.name ?? "Zone";
  const image = item?.img ?? regionDocument?.img ?? "icons/svg/aura.svg";
  return {
    name: `Persistent Zone ${itemName}`,
    image,
    imageSource: item?.img ? "item" : regionDocument?.img ? "region" : "fallback",
    copiedFields: ["name", "img"],
    rejectedFields: ["dependents", "dependencies", "flags.dnd5e", "flags.midi-qol", "changes", "statuses", "duration", "workflow", "regionReferences"]
  };
}

function logDedicatedOwnerPresentationApplied(effect, regionDocument, presentation = {}) {
  console.warn(`[${MODULE_ID}][lifecycle] PZ DEDICATED OWNER PRESENTATION APPLIED`, {
    effectUuid: effect?.uuid ?? null,
    regionId: regionDocument?.id ?? null,
    name: presentation.name ?? null,
    image: presentation.image ?? null,
    imageSource: presentation.imageSource ?? null,
    copiedFields: duplicateData(presentation.copiedFields ?? []),
    rejectedFields: duplicateData(presentation.rejectedFields ?? [])
  });
}

function logNonConcentrationOwnerDetach(regionDocument, runtime = {}, {
  dedicatedOwnerEffectUuid = null,
  detectedDependencySignals = [],
  detectedRegionFlags = null,
  detectedEffectDependents = null,
  removedRegionFlags = [],
  removedEffectDependency = false,
  detachApplied = false,
  detachReason = null,
  concentrationRequired = false
} = {}) {
  console.warn(`[${MODULE_ID}][lifecycle] PZ NON-CONCENTRATION OWNER DETACH`, {
    regionId: regionDocument?.id ?? null,
    regionUuid: regionDocument?.uuid ?? null,
    groupId: runtime.groupId ?? null,
    sourceRegionId: runtime.sourceRegionId ?? null,
    castInstanceId: runtime.castInstanceId ?? null,
    genericEffectUuid: Array.from(detectedDependencySignals ?? []).map((row) => row.genericEffectUuid).filter(Boolean).join(",") || null,
    dedicatedOwnerEffectUuid,
    detectedDependencySignals: duplicateData(detectedDependencySignals),
    detectedRegionFlags: duplicateData(detectedRegionFlags),
    detectedEffectDependents: duplicateData(detectedEffectDependents),
    removedRegionFlags: duplicateData(removedRegionFlags),
    removedEffectDependency,
    detachApplied,
    detachReason,
    concentrationRequired
  });
}

function resolveDedicatedOwnerEffectDuration(runtime = {}, sourceContext = null) {
  const normalized = runtime.normalizedDefinition ?? {};
  const candidates = [
    { source: "normalized-definition-duration", value: normalized.duration },
    { source: "normalized-definition-effect-duration", value: normalized.effect?.duration },
    { source: "source-item-system-duration", value: sourceContext?.item?.system?.duration },
    { source: "source-activity-duration", value: sourceContext?.activity?.duration ?? sourceContext?.activity?.system?.duration }
  ];
  const match = candidates.find((candidate) => candidate.value && typeof candidate.value === "object");
  if (!match) {
    return {
      source: "none",
      sourceDuration: null,
      duration: {},
      acceptedUnits: getAcceptedActiveEffectDurationUnits(),
      applied: false
    };
  }
  const acceptedUnits = getAcceptedActiveEffectDurationUnits();
  const normalizedDuration = normalizeActiveEffectDuration(match.value, acceptedUnits);
  if (!normalizedDuration) {
    return {
      source: "unsupported",
      sourceDuration: duplicateData(match.value),
      duration: {},
      acceptedUnits,
      applied: false
    };
  }
  return {
    source: match.source,
    sourceDuration: duplicateData(match.value),
    duration: normalizedDuration,
    acceptedUnits,
    applied: true
  };
}

function normalizeActiveEffectDuration(sourceDuration = {}, acceptedUnits = []) {
  const value = coerceNumber(sourceDuration.value ?? sourceDuration.duration ?? sourceDuration.amount, NaN);
  const rawUnits = String(sourceDuration.units ?? sourceDuration.unit ?? sourceDuration.type ?? "").trim();
  if (!Number.isFinite(value) || value <= 0 || !rawUnits) {
    return null;
  }

  const canonicalUnits = resolveAcceptedDurationUnit(rawUnits, acceptedUnits);
  if (!canonicalUnits) {
    return null;
  }

  return {
    value,
    units: canonicalUnits
  };
}

function resolveAcceptedDurationUnit(rawUnits, acceptedUnits = []) {
  const normalized = String(rawUnits ?? "").trim().toLowerCase();
  const accepted = Array.from(acceptedUnits ?? [])
    .map((unit) => String(unit ?? "").trim())
    .filter(Boolean);
  const acceptedLower = new Map(accepted.map((unit) => [unit.toLowerCase(), unit]));
  const candidatesByUnit = {
    round: ["round", "rounds"],
    rounds: ["rounds", "round"],
    turn: ["turn", "turns"],
    turns: ["turns", "turn"],
    second: ["second", "seconds"],
    seconds: ["seconds", "second"],
    minute: ["minute", "minutes"],
    minutes: ["minutes", "minute"],
    hour: ["hour", "hours"],
    hours: ["hours", "hour"]
  };
  const candidates = candidatesByUnit[normalized] ?? [normalized];
  for (const candidate of candidates) {
    const acceptedValue = acceptedLower.get(candidate);
    if (acceptedValue) {
      return acceptedValue;
    }
  }
  return null;
}

function getAcceptedActiveEffectDurationUnits() {
  const choices = [];
  collectChoiceKeys(choices, globalThis.CONFIG?.ActiveEffect?.durationUnits);
  collectChoiceKeys(choices, globalThis.CONFIG?.ActiveEffect?.durationTypes);
  collectChoiceKeys(choices, globalThis.CONFIG?.ActiveEffect?.documentClass?.schema?.fields?.duration?.fields?.units?.choices);
  collectChoiceKeys(choices, globalThis.ActiveEffect?.schema?.fields?.duration?.fields?.units?.choices);
  collectChoiceKeys(choices, globalThis.ActiveEffect?.metadata?.schema?.fields?.duration?.fields?.units?.choices);
  return Array.from(new Set(choices.map((choice) => String(choice ?? "").trim()).filter(Boolean)));
}

function collectChoiceKeys(output, choices) {
  if (!choices) {
    return;
  }
  if (Array.isArray(choices)) {
    output.push(...choices);
    return;
  }
  if (choices instanceof Set) {
    output.push(...Array.from(choices));
    return;
  }
  if (choices instanceof Map) {
    output.push(...Array.from(choices.keys()));
    return;
  }
  if (typeof choices === "object") {
    output.push(...Object.keys(choices));
  }
}

function logDedicatedOwnerEffectCreateFailed(regionDocument, runtime = {}, {
  castInstanceId = null,
  sourceDuration = null,
  normalizedDuration = null,
  acceptedDurationUnits = [],
  error = null
} = {}) {
  console.warn(`[${MODULE_ID}][lifecycle] PZ DEDICATED OWNER EFFECT CREATE FAILED`, {
    regionId: regionDocument?.id ?? null,
    groupId: runtime.groupId ?? null,
    castInstanceId,
    sourceDuration: duplicateData(sourceDuration),
    normalizedDuration: duplicateData(normalizedDuration),
    acceptedDurationUnits: duplicateData(acceptedDurationUnits),
    errorName: error?.name ?? null,
    errorMessage: error?.message ?? "unknown"
  });
}

function isNonConcentrationRuntime(runtime = {}) {
  return runtime?.normalizedDefinition?.concentration?.required === false;
}

function isPersistentZonesDedicatedOwnerEffect(activeEffect) {
  return isManagedOwnerEffect(activeEffect, MODULE_ID);
}

function isRegionDocumentStillPresent(regionDocument) {
  const scene = regionDocument?.parent ?? null;
  return Boolean(regionDocument?.id && scene?.regions?.get?.(regionDocument.id));
}

function logOwnerEffectLinkReconciliation(regionDocument, runtime = {}, resolution = {}, {
  reason = "manual",
  changedKeys = [],
  backfillApplied = false
} = {}) {
  const selectedOwnerEffectUuid = resolution.selectedOwnerEffectUuid ?? resolution.selectedOwnerEffect?.uuid ?? null;
  const alreadyOwnedByOtherRegionIds = selectedOwnerEffectUuid
    ? findManagedRegionsReferencingOwnerEffect(selectedOwnerEffectUuid, {
      excludeRegionId: regionDocument?.id ?? null,
      excludeRegionUuid: regionDocument?.uuid ?? null
    }).map((region) => region?.id ?? null).filter(Boolean)
    : [];
  logOwnerEffectMatchDecisionLine(regionDocument, runtime, resolution, {
    reason,
    backfillApplied,
    alreadyOwnedByOtherRegionIds
  });
  console.warn(`[${MODULE_ID}][lifecycle] PZ OWNER EFFECT LINK RECONCILIATION`, {
    sceneId: regionDocument?.parent?.id ?? null,
    regionId: regionDocument?.id ?? null,
    actorUuid: runtime.actorUuid ?? runtime.casterUuid ?? null,
    itemUuid: runtime.itemUuid ?? null,
    previousOwnerEffectUuid: getOwnerEffectUuidFromRuntime(runtime),
    candidateEffectUuids: resolution.candidateEffectUuids ?? [],
    candidateCount: resolution.candidateCount ?? 0,
    matchingSignals: duplicateData(resolution.matchingSignals ?? []),
    selectedOwnerEffectUuid,
    resolutionMode: resolution.resolutionMode ?? null,
    ambiguous: Boolean(resolution.ambiguous),
    backfillApplied,
    alreadyOwnedByOtherRegionIds,
    reason,
    changedKeys
  });
}

function logOwnerEffectEvent(hookName, activeEffect) {
  const summary = summarizeOwnerEffect(activeEffect);
  console.warn(
    `[${MODULE_ID}][lifecycle] PZ OWNER EFFECT EVENT | hookName=${hookName} | timestamp=${Date.now()} | effectId=${summary.effectId ?? "null"} | effectUuid=${summary.effectUuid ?? "null"} | effectName=${summary.effectName ?? "null"} | actorUuid=${summary.actorUuid ?? "null"} | origin=${summary.origin ?? "null"} | itemUuid=${summary.itemUuid ?? "null"} | activityId=${summary.activityId ?? "null"} | workflowId=${summary.workflowId ?? "null"} | messageId=${summary.messageId ?? "null"} | templateId=${summary.templateId ?? "null"} | templateUuid=${summary.templateUuid ?? "null"} | regionId=${summary.regionId ?? "null"} | regionUuid=${summary.regionUuid ?? "null"} | flagsDnd5e=${summary.flagsDnd5eJson} | flagsMidiQol=${summary.flagsMidiQolJson} | dependents=${summary.dependentsJson} | disabled=${summary.disabled} | duration=${summary.durationJson} | concentrationStatus=${summary.concentrationStatus ?? "null"}`
  );
}

function logOwnerEffectMatchDecisionLine(regionDocument, runtime = {}, resolution = {}, {
  reason = "manual",
  backfillApplied = false,
  alreadyOwnedByOtherRegionIds = []
} = {}) {
  console.warn(
    `[${MODULE_ID}][lifecycle] PZ OWNER EFFECT MATCH DECISION | reason=${reason} | regionId=${regionDocument?.id ?? "null"} | sourceRegionId=${runtime.sourceRegionId ?? "null"} | groupId=${runtime.groupId ?? "null"} | actorUuid=${runtime.actorUuid ?? runtime.casterUuid ?? "null"} | itemUuid=${runtime.itemUuid ?? "null"} | currentOwnerEffectUuid=${getOwnerEffectUuidFromRuntime(runtime) ?? "null"} | candidateEffectUuids=${stringifyCompact(resolution.candidateEffectUuids ?? [])} | matchingSignals=${stringifyCompact(resolution.matchingSignals ?? [])} | selectedOwnerEffectUuid=${resolution.selectedOwnerEffectUuid ?? resolution.selectedOwnerEffect?.uuid ?? "null"} | resolutionMode=${resolution.resolutionMode ?? "null"} | backfillApplied=${backfillApplied} | alreadyOwnedByOtherRegionIds=${stringifyCompact(alreadyOwnedByOtherRegionIds)}`
  );
}

function logOwnerEffectOwnershipSnapshot({ reason = "manual", activeEffect = null, reconciledCount = null } = {}) {
  const regions = [];
  for (const scene of game?.scenes?.contents ?? []) {
    for (const region of findManagedRegions(scene)) {
      const runtime = getRegionRuntimeFlags(region) ?? {};
      const ownerEffectUuid = getOwnerEffectUuidFromRuntime(runtime);
      regions.push({
        regionId: region?.id ?? null,
        groupId: runtime.groupId ?? null,
        sourceRegionId: runtime.sourceRegionId ?? null,
        ownerEffectUuid,
        ownerEffectExists: Boolean(ownerEffectUuid && resolveOwnerEffectSync(ownerEffectUuid)),
        concentrationRequired: Boolean(runtime.normalizedDefinition?.concentration?.required)
      });
    }
  }
  const effectRows = collectOwnerEffectSnapshotCandidates(regions, activeEffect);
  console.warn(
    `[${MODULE_ID}][lifecycle] PZ OWNER EFFECT OWNERSHIP SNAPSHOT | reason=${reason} | reconciledCount=${reconciledCount ?? "null"} | regionCount=${regions.length} | regions=${stringifyCompact(regions)} | effectCount=${effectRows.length} | effects=${stringifyCompact(effectRows)}`
  );
}

function collectOwnerEffectSnapshotCandidates(regionRows = [], activeEffect = null) {
  const effects = new Map();
  for (const actor of game?.actors?.contents ?? []) {
    for (const effect of actor?.effects ?? []) {
      effects.set(effect.uuid, effect);
    }
  }
  if (activeEffect?.uuid) {
    effects.set(activeEffect.uuid, activeEffect);
  }

  return Array.from(effects.values()).map((effect) => {
    const linkedRegions = regionRows.filter((row) => row.ownerEffectUuid === effect.uuid);
    return {
      effectUuid: effect.uuid ?? null,
      origin: effect.origin ?? effect.toObject?.()?.origin ?? null,
      linkedRegionIds: linkedRegions.map((row) => row.regionId).filter(Boolean),
      linkedGroupIds: Array.from(new Set(linkedRegions.map((row) => row.groupId).filter(Boolean)))
    };
  }).filter((row) => row.linkedRegionIds.length || row.effectUuid === activeEffect?.uuid);
}

function summarizeOwnerEffect(activeEffect) {
  const data = activeEffect?.toObject?.() ?? {};
  const dnd5eFlags = data.flags?.dnd5e ?? activeEffect?.flags?.dnd5e ?? null;
  const midiFlags = data.flags?.["midi-qol"] ?? activeEffect?.flags?.["midi-qol"] ?? null;
  const regionReference = findFirstReference(data, /(?:Scene\.[^.]+\.Region\.[^.\s"',}]+|Region\.[^.\s"',}]+)/);
  const templateReference = findFirstReference(data, /(?:Scene\.[^.]+\.MeasuredTemplate\.[^.\s"',}]+|MeasuredTemplate\.[^.\s"',}]+)/);
  return {
    effectId: activeEffect?.id ?? data._id ?? null,
    effectUuid: activeEffect?.uuid ?? null,
    effectName: activeEffect?.name ?? data.name ?? data.label ?? null,
    actorUuid: activeEffect?.parent?.uuid ?? null,
    origin: activeEffect?.origin ?? data.origin ?? null,
    itemUuid: resolveActiveEffectItemUuid(activeEffect, data),
    activityId: resolveActiveEffectActivityId(activeEffect, data),
    workflowId: getPropertyPath(data, "flags.midi-qol.workflowId") ?? getPropertyPath(data, "flags.dnd5e.workflowId") ?? null,
    messageId: getPropertyPath(data, "flags.midi-qol.messageId") ?? getPropertyPath(data, "flags.dnd5e.messageId") ?? null,
    templateId: templateReference?.id ?? getPropertyPath(data, "flags.dnd5e.templateId") ?? getPropertyPath(data, "flags.midi-qol.templateId") ?? null,
    templateUuid: templateReference?.uuid ?? getPropertyPath(data, "flags.dnd5e.templateUuid") ?? getPropertyPath(data, "flags.midi-qol.templateUuid") ?? null,
    regionId: regionReference?.id ?? getPropertyPath(data, "flags.dnd5e.regionId") ?? getPropertyPath(data, "flags.midi-qol.regionId") ?? null,
    regionUuid: regionReference?.uuid ?? getPropertyPath(data, "flags.dnd5e.regionUuid") ?? getPropertyPath(data, "flags.midi-qol.regionUuid") ?? null,
    flagsDnd5eJson: stringifyCompact(dnd5eFlags),
    flagsMidiQolJson: stringifyCompact(midiFlags),
    dependentsJson: stringifyCompact(data.dependents ?? activeEffect?.dependents ?? null),
    disabled: Boolean(activeEffect?.disabled ?? data.disabled),
    durationJson: stringifyCompact(data.duration ?? activeEffect?.duration ?? null),
    concentrationStatus: getPropertyPath(data, "statuses.concentrating") ?? getPropertyPath(data, "flags.dnd5e.concentration") ?? getPropertyPath(data, "flags.midi-qol.concentration") ?? null
  };
}

function resolveActiveEffectCreatedAt(activeEffect, effectData = null) {
  const data = effectData ?? activeEffect?.toObject?.() ?? {};
  return activeEffect?._stats?.createdTime ??
    data?._stats?.createdTime ??
    activeEffect?.createdTime ??
    data.createdTime ??
    null;
}

function findFirstReference(source, pattern) {
  const text = stringifyCompact(source);
  const match = text.match(pattern);
  if (!match?.[0]) {
    return null;
  }
  const uuid = match[0];
  return {
    uuid,
    id: uuid.split(".").pop()
  };
}

function resolveActorSync(actorUuid) {
  if (!actorUuid) {
    return null;
  }

  try {
    const resolved = globalThis.fromUuidSync?.(actorUuid);
    if (resolved?.documentName === "Actor") {
      return resolved;
    }
  } catch (_caughtError) {
    // Fall through to game.actors lookup.
  }

  const parts = String(actorUuid).split(".");
  const actorIndex = parts.findIndex((part) => part === "Actor");
  const actorId = actorIndex >= 0 ? parts[actorIndex + 1] ?? null : null;
  return actorId ? game?.actors?.get?.(actorId) ?? null : null;
}

function resolveActiveEffectItemUuid(activeEffect, effectData = null) {
  const data = effectData ?? activeEffect?.toObject?.() ?? {};
  const candidates = [
    activeEffect?.origin,
    data.origin,
    getPropertyPath(data, "flags.dnd5e.itemUuid"),
    getPropertyPath(data, "flags.dnd5e.item.uuid"),
    getPropertyPath(data, "flags.dnd5e.origin.item.uuid"),
    getPropertyPath(data, "flags.dnd5e.activity.item.uuid"),
    getPropertyPath(data, "flags.dnd5e.activity.itemUuid"),
    getPropertyPath(data, "flags.dnd5e.source.itemUuid"),
    getPropertyPath(data, "flags.midi-qol.itemUuid"),
    getPropertyPath(data, "flags.midi-qol.item.uuid")
  ];
  return candidates.map(extractItemUuidFromValue).find(Boolean) ?? null;
}

function resolveActiveEffectActivityId(activeEffect, effectData = null) {
  const data = effectData ?? activeEffect?.toObject?.() ?? {};
  return [
    getPropertyPath(data, "flags.dnd5e.activityId"),
    getPropertyPath(data, "flags.dnd5e.activity.id"),
    getPropertyPath(data, "flags.dnd5e.activity.uuid"),
    getPropertyPath(data, "flags.midi-qol.activityId"),
    getPropertyPath(data, "flags.midi-qol.activityUuid")
  ].map((value) => String(value ?? "").split(".").pop()).find(Boolean) ?? null;
}

function extractItemUuidFromValue(value) {
  const text = String(value ?? "");
  if (!text) {
    return null;
  }
  const match = text.match(/Actor\.[^.]+\.Item\.[^.]+/);
  return match?.[0] ?? null;
}

function getPropertyPath(source, path) {
  if (!source || !path) {
    return null;
  }
  return String(path).split(".").reduce((value, key) => value?.[key], source);
}

function stringifyCompact(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (_caughtError) {
    return "\"[unserializable]\"";
  }
}

function buildRegionCreateData({
  templateDocument,
  normalizedDefinition,
  sourceContext,
  shapes,
  existingRuntime = null,
  groupId = null,
  partId = null,
  partIndex = 0,
  partCount = 1,
  geometryType = "template",
  runtimeGeometry = null,
  regionSourceStrategy = null,
  regionSegmentIndex = null,
  regionSegmentCount = null,
  architecturePath = REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
  sharedOwnerEffectUuid = null
}) {
  const finalElevation = resolveRegionElevation(normalizedDefinition, coerceNumber(templateDocument?.elevation, 0));
  const behaviors = buildNativeRegionBehaviors({
    normalizedDefinition,
    sourceContext
  });
  const runtimeFlags = {
    ...buildManagedRegionRuntimeFlags({
      templateDocument,
      normalizedDefinition,
      sourceContext,
      existingRuntime,
      groupId,
      partId,
      partIndex,
      partCount,
      geometryType,
      runtimeGeometry,
      regionSourceStrategy,
      regionSegmentIndex,
      regionSegmentCount,
      architecturePath,
      sharedOwnerEffectUuid
    })
  };
  logV14RegionDiagnostic("regionManagedFlagsWritten", {
    templateId: templateDocument?.id ?? null,
    templateUuid: templateDocument?.uuid ?? null,
    itemUuid: runtimeFlags.itemUuid,
    regionManagedFlagsWritten: true,
    regionManagedFlagsSource: "region-create-data.flags",
    partId: runtimeFlags.partId,
    partIndex: runtimeFlags.partIndex,
    partCount: runtimeFlags.partCount,
    geometryType: runtimeFlags.geometryType,
    regionSourceStrategy: runtimeFlags.regionSourceStrategy,
    regionSegmentIndex: runtimeFlags.regionSegmentIndex,
    regionSegmentCount: runtimeFlags.regionSegmentCount,
    runtimeFlagKeys: Object.keys(runtimeFlags),
    flagsPayload: buildManagedRegionFlags(runtimeFlags)
  });

  return {
    name: buildRegionName(normalizedDefinition, sourceContext),
    color: DEFAULT_REGION_COLOR,
    elevation: finalElevation,
    shapes: buildFoundryRegionShapes(shapes),
    behaviors,
    flags: buildManagedRegionFlags(runtimeFlags),
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]: runtimeFlags
  };
}

export function resolveRegionElevation(normalizedDefinition, fallback = 0) {
  if (normalizedDefinition?.elevationOverrideUnlimited === true) {
    return { bottom: null, top: null, topInclusive: false };
  }
  const configured = normalizedDefinition?.elevation;
  if (configured && typeof configured === "object" &&
      (configured.bottom !== null || configured.top !== null)) {
    return {
      bottom: configured.bottom,
      top: configured.top,
      topInclusive: Boolean(configured.topInclusive)
    };
  }
  return fallback;
}

function buildManagedRegionRuntimeFlags({
  templateDocument,
  normalizedDefinition,
  sourceContext,
  existingRuntime = null,
  groupId = null,
  partId = null,
  partIndex = 0,
  partCount = 1,
  geometryType = "template",
  runtimeGeometry = null,
  regionSourceStrategy = null,
  regionSegmentIndex = null,
  regionSegmentCount = null,
  architecturePath = REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
  sharedOwnerEffectUuid = null
}) {
  const runtimeFlags = {
    templateId: templateDocument?.id ?? null,
    templateUuid: templateDocument?.uuid ?? null,
    itemUuid: normalizedDefinition?.itemUuid ?? sourceContext?.item?.uuid ?? null,
    actorUuid: normalizedDefinition?.actorUuid ?? sourceContext?.actor?.uuid ?? null,
    casterUuid: normalizedDefinition?.casterUuid ?? sourceContext?.caster?.uuid ?? null,
    sourceTokenUuid: existingRuntime?.sourceTokenUuid ?? sourceContext?.sourceTokenUuid ?? null,
    sourceDisposition: existingRuntime?.sourceDisposition ?? sourceContext?.sourceDisposition ?? null,
    activityId: normalizedDefinition?.activityId ?? sourceContext?.activity?.id ?? null,
    activityUuid: normalizedDefinition?.activityUuid ?? sourceContext?.activity?.uuid ?? null,
    activityType: normalizedDefinition?.activityType ?? sourceContext?.activity?.type ?? null,
    ...(sharedOwnerEffectUuid ? {
      ownerEffectUuid: sharedOwnerEffectUuid,
      activeEffectUuid: sharedOwnerEffectUuid,
      concentrationEffectUuid: normalizedDefinition?.concentration?.required === true
        ? sharedOwnerEffectUuid
        : null
    } : {}),
    selectedVariantId: normalizedDefinition?.selectedVariant?.id ?? null,
    defaultVariantId: normalizedDefinition?.defaultVariantId ?? null,
    variantResolutionMode: normalizedDefinition?.variantResolution?.resolutionMode ?? "none",
    availableVariantIds: Array.isArray(normalizedDefinition?.variants)
      ? normalizedDefinition.variants.map((variant) => variant.id)
      : [],
    dc: normalizedDefinition?.dc ?? null,
    castLevel: normalizedDefinition?.castLevel ?? null,
    groupId,
    partId,
    partIndex,
    partCount,
    geometryType,
    regionSourceStrategy,
    regionSegmentIndex,
    regionSegmentCount,
    ringGeometry: duplicateData(runtimeGeometry),
    linkedDocuments: duplicateLinkedDocuments(existingRuntime?.linkedDocuments),
    normalizedDefinition
  };
  return buildManagedRegionRuntimeContract(runtimeFlags, {
    architecturePath,
    sourceDocumentType: templateDocument?.documentName ?? null
  });
}

async function buildRegionSyncPayload(templateDocument, regionDocuments) {
  const primaryRegion = Array.isArray(regionDocuments) ? regionDocuments[0] ?? null : regionDocuments ?? null;
  const sourceContext = await resolveRegionSourceContext(templateDocument, primaryRegion);
  const runtime = getRegionRuntimeFlags(primaryRegion) ?? {};
  let normalizedDefinition = runtime.normalizedDefinition ?? null;

  if (sourceContext.item) {
    const configuration = resolvePersistentZoneConfiguration({
      actor: sourceContext.actor,
      item: sourceContext.item,
      activity: sourceContext.activity,
      templateDocument,
      regionDocument: primaryRegion,
      entryPoint: "buildRegionSyncPayload"
    });
    if (configuration.normalizedDefinition) {
      normalizedDefinition = configuration.normalizedDefinition;
    }
  }

  if (!normalizedDefinition?.validation?.isValid) {
    const validationReasons = Array.isArray(normalizedDefinition?.validation?.reasons)
      ? normalizedDefinition.validation.reasons
      : [];
    debug("Skipped Region sync because the normalized definition is invalid.", {
      templateId: templateDocument?.id ?? null,
      regionId: primaryRegion?.id ?? null,
      selectedVariant: normalizedDefinition?.selectedVariantId ?? null,
      defaultVariant: normalizedDefinition?.defaultVariantId ?? null,
      availableVariants: normalizedDefinition?.availableVariants ?? [],
      variantResolutionMode: normalizedDefinition?.variantResolution?.resolutionMode ?? "none",
      variantValidation: normalizedDefinition?.variantResolution ?? null,
      reasons: validationReasons,
      reasonsText: validationReasons.join(" | ")
    });
    return null;
  }

  if (normalizedDefinition.enabled === false) {
    debug("Skipped Region sync because persistent-zones definition is disabled.", {
      templateId: templateDocument?.id ?? null,
      regionId: primaryRegion?.id ?? null,
      enabled: false,
      itemUuid: sourceContext.item?.uuid ?? runtime.itemUuid ?? null,
      itemName: sourceContext.item?.name ?? null,
      selectedVariant: normalizedDefinition.selectedVariantId ?? null,
      defaultVariant: normalizedDefinition.defaultVariantId ?? null
    });
    return null;
  }

  return buildManagedRegionGroupPlan({
    templateDocument,
    normalizedDefinition,
    sourceContext,
    existingRegions: Array.isArray(regionDocuments)
      ? regionDocuments
      : primaryRegion
        ? [primaryRegion]
        : []
  });
}

function buildRegionUpdateData(regionData) {
  return {
    name: regionData.name,
    elevation: regionData.elevation,
    shapes: regionData.shapes,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]: regionData.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY] ?? null
  };
}

async function recreateManagedRegionGroupFromTemplate(templateDocument, regionDocuments, groupPlan) {
  const scene = templateDocument?.parent ?? regionDocuments?.[0]?.parent ?? null;
  const templateDiagnostics = buildTemplateDiagnostics(templateDocument);
  logV14RegionEntry("enteredManagedRegionGroupCreation", {
    entryPoint: "recreateManagedRegionGroupFromTemplate",
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    previousRegionIds: Array.from(regionDocuments ?? [])
      .map((regionDocument) => regionDocument?.id ?? null)
      .filter(Boolean),
    partCountExpected: Array.from(groupPlan?.parts ?? []).length,
    regionGeometryType: Array.from(new Set(Array.from(groupPlan?.parts ?? []).map((partPlan) => partPlan.geometryType))),
    ...templateDiagnostics,
    selectedCompatibilityPath: selectRegionFactoryCompatibilityPath({
      templateDocument,
      scene,
      groupPlan,
      operation: "rebuild"
    })
  });

  if (!scene || !groupPlan?.parts?.length) {
    logV14RegionBranch("skippedV14PathBecause", {
      entryPoint: "recreateManagedRegionGroupFromTemplate",
      templateId: templateDocument?.id ?? null,
      reason: !scene ? "missing-parent-scene" : "empty-group-plan",
      ...templateDiagnostics,
      fallbackPathSelected: "none"
    });
    return [];
  }

  await deleteManagedRegionGroup(regionDocuments, {
    reason: "region-group-recreate"
  });

  const regionCreateData = groupPlan.parts.map((partPlan) => partPlan.regionData);
  const createdRegions = await createManagedRegionDocuments({
    scene,
    templateDocument,
    groupPlan,
    regionCreateData,
    templateDiagnostics,
    operation: "rebuild",
    previousRegionIds: Array.from(regionDocuments ?? [])
      .map((regionDocument) => regionDocument?.id ?? null)
      .filter(Boolean)
  });

  for (let index = 0; index < createdRegions.length; index += 1) {
    const createdRegion = createdRegions[index] ?? null;
    const partPlan = groupPlan.parts[index] ?? null;
    if (!createdRegion || !partPlan) {
      continue;
    }

    await syncLinkedDocumentsSafely({
      templateDocument,
      regionDocument: createdRegion,
      normalizedDefinition: partPlan.runtimeDefinition,
      shapes: partPlan.shapes,
      stage: "recreate-region"
    });
  }

  return createdRegions;
}

async function createManagedRegionDocuments({
  scene,
  templateDocument,
  groupPlan,
  regionCreateData,
  templateDiagnostics,
  operation = "create",
  previousRegionIds = []
} = {}) {
  const isRebuild = operation === "rebuild";
  const attemptLogKey = isRebuild ? "regionRebuildAttempt" : "regionCreateAttempt";
  const failedLogKey = isRebuild ? "regionRebuildFailed" : "regionCreateFailed";
  const successLogKey = isRebuild ? "regionRebuildSuccess" : "regionCreateSuccess";
  const partCountExpected = Array.from(groupPlan?.parts ?? []).length;
  const createdRegions = [];
  logV14RegionEntry("enteredManagedRegionGroupCreation", {
    entryPoint: "createManagedRegionDocuments",
    operation,
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    ...templateDiagnostics,
    regionGroupId: groupPlan?.groupId ?? null,
    partCountExpected,
    regionGeometryType: Array.from(new Set(Array.from(groupPlan?.parts ?? []).map((partPlan) => partPlan.geometryType))),
    selectedCompatibilityPath: selectRegionFactoryCompatibilityPath({
      templateDocument,
      scene,
      groupPlan,
      operation
    }),
    fallbackPathSelected: "per-part-region-create"
  });

  logV14RegionDiagnostic(attemptLogKey, {
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    ...templateDiagnostics,
    regionGroupId: groupPlan?.groupId ?? null,
    previousRegionIds,
    regionCount: Array.from(regionCreateData ?? []).length,
    partCountExpected,
    selectedBaseType: getTemplateType(templateDocument),
    selectedGeometryType: Array.from(new Set(Array.from(groupPlan?.parts ?? []).map((partPlan) => partPlan.geometryType))).join(",") || null,
    normalizedGeometryType: Array.from(new Set(Array.from(groupPlan?.parts ?? []).map((partPlan) => partPlan.runtimeDefinition?.geometry?.type ?? null).filter(Boolean))).join(",") || null,
    foundryVersion: globalThis.game?.version ?? null,
    v14CompositeCompatibilityPath: isFoundryV14OrNewer()
      ? "create-region-group-part-by-part"
      : "create-region-group-batch-compatible"
  });

  logV14RegionDiagnostic("regionGroupCreateAttempt", {
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    ...templateDiagnostics,
    regionGroupId: groupPlan?.groupId ?? null,
    partCountExpected,
    regionShapeCount: countRegionShapes(regionCreateData),
    shapeSummary: summarizeRegionCreateData(regionCreateData)
  });

  for (const [index, regionData] of Array.from(regionCreateData ?? []).entries()) {
    const partPlan = groupPlan?.parts?.[index] ?? null;
    const partId = partPlan?.partId ?? regionData?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]?.partId ?? `part-${index + 1}`;
    const runtimeFlagsPayload = regionData?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY] ?? null;

    const partPayload = summarizeRegionCreateData([regionData])?.[0] ?? null;
    logV14PipelineStep("06", "Payload generated", {
      entryPoint: "createManagedRegionDocuments",
      operation,
      templateId: templateDocument?.id ?? null,
      templateType: getTemplateType(templateDocument),
      detectedTemplateTypeRaw: getTemplateType(templateDocument),
      profileId: runtimeFlagsPayload?.normalizedDefinition?.selectedVariantId ??
        runtimeFlagsPayload?.normalizedDefinition?.selectedVariant?.id ??
        runtimeFlagsPayload?.normalizedDefinition?.id ??
        null,
      profileType: classifyNormalizedDefinitionZoneKind(runtimeFlagsPayload?.normalizedDefinition),
      requestedShapeType: partPlan?.geometryType ?? runtimeFlagsPayload?.geometryType ?? null,
      serializerUsed: Array.from(regionData?.shapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null,
      payloadShapeType: Array.from(regionData?.shapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
      partIndex: index + 1,
      payload: partPayload
    });
    const isRingPart = partPlan?.geometryType === "ring" || partPlan?.geometryType === "side-of-ring";
    const isCircleTemplatePart = getTemplateType(templateDocument) === "circle" && partPlan?.geometryType === "template";
    const sourceCircleGeometry = isCircleTemplatePart
      ? buildCircleSourceGeometry(templateDocument)
      : null;
    const ringPayloadShapeSummary = isRingPart
      ? summarizeFoundryRegionShapes(regionData?.shapes ?? [])
      : null;
    if (isRingPart) {
      logV14RegionDiagnostic("ringPayloadShapeSummary", {
        templateId: templateDocument?.id ?? null,
        sceneId: scene?.id ?? null,
        ...templateDiagnostics,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex: index + 1,
        geometryType: partPlan?.geometryType ?? null,
        regionSourceStrategy: partPlan?.regionSourceStrategy ?? runtimeFlagsPayload?.regionSourceStrategy ?? null,
        regionSegmentIndex: partPlan?.regionSegmentIndex ?? runtimeFlagsPayload?.regionSegmentIndex ?? null,
        regionSegmentCount: partPlan?.regionSegmentCount ?? runtimeFlagsPayload?.regionSegmentCount ?? null,
        ringGeometry: duplicateData(partPlan?.runtimeGeometry ?? runtimeFlagsPayload?.ringGeometry ?? null),
        ringSourceBounds: calculateRegionBoundsFromShapes(regionData?.shapes ?? []),
        ringInnerRadius: partPlan?.runtimeGeometry?.innerRadiusPixels ?? runtimeFlagsPayload?.ringGeometry?.innerRadiusPixels ?? null,
        ringOuterRadius: partPlan?.runtimeGeometry?.outerRadiusPixels ?? runtimeFlagsPayload?.ringGeometry?.outerRadiusPixels ?? null,
        regionSegmentCountExpected: partPlan?.regionSegmentCount ?? Array.from(regionData?.shapes ?? []).length,
        regionSegmentBounds: Array.from(regionData?.shapes ?? []).map((shape) => calculateShapeBounds(shape)),
        regionSegmentShapes: ringPayloadShapeSummary,
        ringPayloadShapeSummary,
        ringPayloadShapeSummaryJson: stringifyShapeSummary(ringPayloadShapeSummary),
        regionCreatePayloadShapesJson: stringifyShapeSummary(regionData?.shapes ?? []),
        ringGeometryStrategy: "multi-polygon-segments",
        ringSegmentCount: partPlan?.regionSegmentCount ?? Array.from(regionData?.shapes ?? []).length,
        ringSegmentShapeSummary: ringPayloadShapeSummary,
        polygonPointsFormat: "flat-number-array",
        polygonPointCount: ringPayloadShapeSummary?.[0]?.pointCount ?? null,
        regionCreatePayloadJson: stringifyShapeSummary(regionData)
      });
    }
    logV14RegionDiagnostic("regionManagedFlagsWriteAttempt", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
    partIndex: index + 1,
    regionManagedFlagsNamespace: `${MODULE_ID}.${RUNTIME_FLAG_KEY}`,
    regionManagedFlagsPayload: duplicateData(runtimeFlagsPayload),
    regionSourceStrategy: runtimeFlagsPayload?.regionSourceStrategy ?? partPlan?.regionSourceStrategy ?? null,
    regionSegmentIndex: runtimeFlagsPayload?.regionSegmentIndex ?? partPlan?.regionSegmentIndex ?? null,
    regionSegmentCount: runtimeFlagsPayload?.regionSegmentCount ?? partPlan?.regionSegmentCount ?? null,
    payloadHasNestedFlags: Boolean(regionData?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]),
      payloadHasFlatFlags: Boolean(regionData?.[`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`])
    });
    logV14RegionDiagnostic("regionManagedFlagsWritten", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
      partIndex: index + 1,
      regionManagedFlagsWritten: Boolean(runtimeFlagsPayload),
      regionManagedFlagsNamespace: `${MODULE_ID}.${RUNTIME_FLAG_KEY}`,
      regionManagedFlagsSource: "region-create-payload",
      regionManagedFlagsPayload: duplicateData(runtimeFlagsPayload)
    });
    logV14RegionDiagnostic("regionCreatePayload", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
      partIndex: index + 1,
      sourceShapeBounds: sourceCircleGeometry?.bounds ?? null,
      sourceRadius: sourceCircleGeometry?.radius ?? null,
      sourceWidth: sourceCircleGeometry?.width ?? null,
      sourceHeight: sourceCircleGeometry?.height ?? null,
      circleGeometryStrategy: isCircleTemplatePart ? "native-ellipse-bounds-from-document-circle" : null,
      payload: partPayload,
      payloadRaw: duplicateData(regionData),
      regionCreatePayloadJson: stringifyShapeSummary(regionData)
    });
    logV14RegionDiagnostic("regionPartCreatePayload", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
      partIndex: index + 1,
      partDefinition: summarizePartPlan(partPlan),
      payload: partPayload,
      payloadRaw: duplicateData(regionData)
    });

    logV14RegionDiagnostic("regionPartCreateAttempt", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
      partIndex: index + 1,
      partCountExpected,
      geometryType: partPlan?.geometryType ?? null,
      regionShapeCount: Array.from(regionData?.shapes ?? []).length,
      shapeSummary: [partPayload]
    });

    try {
      logV14PipelineStep("07", "Payload before create", {
        entryPoint: "createManagedRegionDocuments",
        operation,
        templateId: templateDocument?.id ?? null,
        templateType: getTemplateType(templateDocument),
        detectedTemplateTypeRaw: getTemplateType(templateDocument),
        profileId: runtimeFlagsPayload?.normalizedDefinition?.selectedVariantId ??
          runtimeFlagsPayload?.normalizedDefinition?.selectedVariant?.id ??
          runtimeFlagsPayload?.normalizedDefinition?.id ??
          null,
        profileType: classifyNormalizedDefinitionZoneKind(runtimeFlagsPayload?.normalizedDefinition),
        requestedShapeType: partPlan?.geometryType ?? runtimeFlagsPayload?.geometryType ?? null,
        serializerUsed: Array.from(regionData?.shapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null,
        payloadShapeType: Array.from(regionData?.shapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex: index + 1,
        payloadBeforeCreate: partPayload
      });
      const createdBatch = await scene.createEmbeddedDocuments("Region", [regionData]);
      const createdRegion = createdBatch?.[0] ?? null;
      if (!createdRegion) {
        throw new Error("Region creation returned no document.");
      }

      const ensuredRuntimeFlags = await ensureManagedRegionRuntimeFlags(createdRegion, runtimeFlagsPayload, {
        templateDocument,
        scene,
        templateDiagnostics,
        groupPlan,
        partId,
        partIndex: index + 1
      });
      await applyAuthenticRegionHighlightMode(createdRegion, {
        entryPoint: "createManagedRegionDocuments",
        operation,
        templateDocument,
        scene,
        templateDiagnostics,
        groupPlan,
        partId,
        partIndex: index + 1,
        runtimeFlags: ensuredRuntimeFlags ?? runtimeFlagsPayload
      });
      createdRegions.push(createdRegion);
      const createdRegionSummary = summarizeCreatedRegionDocument(createdRegion);
      logV14PipelineStep("08", "Region created", {
        entryPoint: "createManagedRegionDocuments",
        operation,
        templateId: templateDocument?.id ?? null,
        templateType: getTemplateType(templateDocument),
        detectedTemplateTypeRaw: getTemplateType(templateDocument),
        profileId: runtimeFlagsPayload?.normalizedDefinition?.selectedVariantId ??
          runtimeFlagsPayload?.normalizedDefinition?.selectedVariant?.id ??
          runtimeFlagsPayload?.normalizedDefinition?.id ??
          null,
        profileType: classifyNormalizedDefinitionZoneKind(runtimeFlagsPayload?.normalizedDefinition),
        requestedShapeType: partPlan?.geometryType ?? runtimeFlagsPayload?.geometryType ?? null,
        serializerUsed: Array.from(regionData?.shapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null,
        payloadShapeType: Array.from(regionData?.shapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
        createdShapeType: getRegionPipelineShapeTypes(createdRegion).join(",") || null,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex: index + 1,
        regionDocumentFinal: summarizeRegionDocumentForPipeline(createdRegion)
      });
      logV14PipelineStep("10", "Runtime attached", {
        entryPoint: "createManagedRegionDocuments",
        operation,
        templateId: templateDocument?.id ?? null,
        templateType: getTemplateType(templateDocument),
        detectedTemplateTypeRaw: getTemplateType(templateDocument),
        profileId: ensuredRuntimeFlags?.normalizedDefinition?.selectedVariantId ??
          ensuredRuntimeFlags?.normalizedDefinition?.selectedVariant?.id ??
          ensuredRuntimeFlags?.normalizedDefinition?.id ??
          null,
        profileType: classifyNormalizedDefinitionZoneKind(ensuredRuntimeFlags?.normalizedDefinition),
        requestedShapeType: ensuredRuntimeFlags?.geometryType ?? partPlan?.geometryType ?? null,
        serializerUsed: Array.from(regionData?.shapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null,
        payloadShapeType: Array.from(regionData?.shapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
        runtimeGeometryType: ensuredRuntimeFlags?.geometryType ?? null,
        regionSourceStrategy: ensuredRuntimeFlags?.regionSourceStrategy ?? null,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex: index + 1,
        regionDocumentFinal: summarizeRegionDocumentForPipeline(createdRegion)
      });
      logV14RegionDiagnostic("regionManagedFlagsRead", {
        templateId: templateDocument?.id ?? null,
        sceneId: scene?.id ?? null,
        ...templateDiagnostics,
        regionDocumentId: createdRegion?.id ?? null,
        partId,
        regionManagedFlagsRead: Boolean(ensuredRuntimeFlags),
        regionManagedFlagsSource: ensuredRuntimeFlags ? "created-document-or-post-create-write" : "none",
        managedRegionDetected: Boolean(
          ensuredRuntimeFlags?.templateId ||
          ensuredRuntimeFlags?.templateUuid
        ),
        regionDocumentFlags: duplicateData(createdRegion?.flags ?? null),
        regionDocumentSourceFlags: duplicateData(createdRegion?._source?.flags ?? null),
        regionDocumentFlagsAfterCreate: duplicateData(createdRegion?.flags ?? null),
        regionDocumentSourceFlagsAfterCreate: duplicateData(createdRegion?._source?.flags ?? null),
        createdRegion: createdRegionSummary
      });
      logV14RegionDiagnostic("regionPartCreateSuccess", {
        templateId: templateDocument?.id ?? null,
        sceneId: scene?.id ?? null,
        ...templateDiagnostics,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex: index + 1,
        regionId: createdRegion.id,
        partCountCreated: createdRegions.length,
        partCountExpected,
        sentShapes: summarizeFoundryRegionShapes(regionData?.shapes ?? []),
        createdShapes: createdRegionSummary.shapes
      });
      logV14RegionDiagnostic("regionCreatedDocument", {
        templateId: templateDocument?.id ?? null,
        sceneId: scene?.id ?? null,
        ...templateDiagnostics,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex: index + 1,
        createdRegion: createdRegionSummary,
        createdRegionRaw: duplicateData(createdRegion?.toObject?.()),
        regionCreatedDocumentJson: stringifyShapeSummary(duplicateData(createdRegion?.toObject?.()))
      });
      logV14RegionDiagnostic("createdRegionShapes", {
        templateId: templateDocument?.id ?? null,
        sceneId: scene?.id ?? null,
        ...templateDiagnostics,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex: index + 1,
        createdRegionShapeCount: createdRegionSummary.shapeCount,
        createdRegionShapes: createdRegionSummary.shapes,
        createdRegionShapesJson: stringifyShapeSummary(duplicateData(createdRegion?.toObject?.()?.shapes ?? []))
      });
      if (isRingPart) {
        const ringCreatedShapeSummary = createdRegionSummary.shapes;
        const shapeComparison = compareRingShapeSummaries(ringPayloadShapeSummary, ringCreatedShapeSummary);
        logV14RegionDiagnostic("ringCreatedShapeResult", {
          templateId: templateDocument?.id ?? null,
          sceneId: scene?.id ?? null,
          ...templateDiagnostics,
          regionGroupId: groupPlan?.groupId ?? null,
          partId,
          partIndex: index + 1,
          geometryType: partPlan?.geometryType ?? null,
          regionSourceStrategy: partPlan?.regionSourceStrategy ?? runtimeFlagsPayload?.regionSourceStrategy ?? null,
          regionSegmentIndex: partPlan?.regionSegmentIndex ?? runtimeFlagsPayload?.regionSegmentIndex ?? null,
          regionSegmentCount: partPlan?.regionSegmentCount ?? runtimeFlagsPayload?.regionSegmentCount ?? null,
          ringSourceBounds: calculateRegionBoundsFromShapes(regionData?.shapes ?? []),
          ringInnerRadius: partPlan?.runtimeGeometry?.innerRadiusPixels ?? runtimeFlagsPayload?.ringGeometry?.innerRadiusPixels ?? null,
          ringOuterRadius: partPlan?.runtimeGeometry?.outerRadiusPixels ?? runtimeFlagsPayload?.ringGeometry?.outerRadiusPixels ?? null,
          regionSegmentCountExpected: partPlan?.regionSegmentCount ?? 1,
          regionSegmentCountCreated: createdRegions.length,
          regionSegmentDocumentIds: createdRegions.map((region) => region?.id ?? null).filter(Boolean),
          regionSegmentBounds: createdRegionSummary.shapes.map((shape) => shape.bounds ?? null),
          regionSegmentShapes: ringCreatedShapeSummary,
          regionSegmentHidden: Boolean(createdRegion?.hidden),
          regionSegmentDestroyed: Boolean(createdRegion?._destroyed ?? createdRegion?.destroyed),
          sentShapes: ringPayloadShapeSummary,
          createdShapes: ringCreatedShapeSummary,
          createdRegionShapeCount: createdRegionSummary.shapeCount,
          ...shapeComparison
        });
        logV14RegionDiagnostic("ringCreatedShapeSummary", {
          templateId: templateDocument?.id ?? null,
          sceneId: scene?.id ?? null,
          ...templateDiagnostics,
          regionGroupId: groupPlan?.groupId ?? null,
          partId,
          partIndex: index + 1,
          geometryType: partPlan?.geometryType ?? null,
          regionSourceStrategy: partPlan?.regionSourceStrategy ?? runtimeFlagsPayload?.regionSourceStrategy ?? null,
          regionSegmentIndex: partPlan?.regionSegmentIndex ?? runtimeFlagsPayload?.regionSegmentIndex ?? null,
          regionSegmentCount: partPlan?.regionSegmentCount ?? runtimeFlagsPayload?.regionSegmentCount ?? null,
          ringCreatedShapeSummary,
          ringCreatedShapeSummaryJson: stringifyShapeSummary(ringCreatedShapeSummary),
          ringCreatedDocumentJson: stringifyShapeSummary(createdRegionSummary),
          regionCreatedDocumentJson: stringifyShapeSummary(duplicateData(createdRegion?.toObject?.())),
          createdRegionShapesJson: stringifyShapeSummary(duplicateData(createdRegion?.toObject?.()?.shapes ?? [])),
          ringGeometryStrategy: "multi-polygon-segments",
          ringSegmentCount: partPlan?.regionSegmentCount ?? ringCreatedShapeSummary.length,
          ...shapeComparison
        });
        logV14RegionDiagnostic(shapeComparison.ringShapeMismatch ? "ringShapeMismatch" : "ringShapePreserved", {
          templateId: templateDocument?.id ?? null,
          sceneId: scene?.id ?? null,
          ...templateDiagnostics,
          regionGroupId: groupPlan?.groupId ?? null,
          partId,
          partIndex: index + 1,
          geometryType: partPlan?.geometryType ?? null,
          regionSourceStrategy: partPlan?.regionSourceStrategy ?? runtimeFlagsPayload?.regionSourceStrategy ?? null,
          regionSegmentIndex: partPlan?.regionSegmentIndex ?? runtimeFlagsPayload?.regionSegmentIndex ?? null,
          regionSegmentCount: partPlan?.regionSegmentCount ?? runtimeFlagsPayload?.regionSegmentCount ?? null,
          ringPayloadShapeSummaryJson: stringifyShapeSummary(ringPayloadShapeSummary),
          ringCreatedShapeSummaryJson: stringifyShapeSummary(ringCreatedShapeSummary),
          regionCreatedDocumentJson: stringifyShapeSummary(duplicateData(createdRegion?.toObject?.())),
          createdRegionShapesJson: stringifyShapeSummary(duplicateData(createdRegion?.toObject?.()?.shapes ?? [])),
          ...shapeComparison
        });
      }
      if (isCircleTemplatePart) {
        const createdRegionBounds = calculateRegionBoundsFromShapes(createdRegion?.toObject?.()?.shapes ?? []);
        const boundsComparison = compareBounds(sourceCircleGeometry.bounds, createdRegionBounds);
        const createdShapes = createdRegion?.toObject?.()?.shapes ?? [];
        logCircleGeometryDiagnostic("circleCreatedShapeSummary", {
          templateDocument,
          sourceShape: buildCircleShapeFromDocument(templateDocument),
          createdShapes,
          strategy: createdShapes?.[0]?.type === "circle"
            ? "created-native-circle-shape"
            : "created-non-circle-shape"
        });
        logV14RegionDiagnostic("circleCreatedShapeSummary", {
          templateId: templateDocument?.id ?? null,
          sceneId: scene?.id ?? null,
          ...templateDiagnostics,
          regionDocumentId: createdRegion?.id ?? null,
          circleGeometryStrategy: "native-ellipse-bounds-from-document-circle",
          sourceShapeBounds: sourceCircleGeometry.bounds,
          sourceRadius: sourceCircleGeometry.radius,
          sourceWidth: sourceCircleGeometry.width,
          sourceHeight: sourceCircleGeometry.height,
          createdRegionBounds,
          circleSourceCenter: sourceCircleGeometry.center,
          circleSourceRadius: sourceCircleGeometry.radius,
          circleSourceBounds: sourceCircleGeometry.bounds,
          circleCreatedCenter: createdRegionBounds
            ? { x: createdRegionBounds.centerX, y: createdRegionBounds.centerY }
            : null,
          circleCreatedRadius: createdRegionBounds
            ? Math.max(createdRegionBounds.width, createdRegionBounds.height) / 2
            : null,
          circleCreatedBounds: createdRegionBounds,
          circleShapeType: createdShapes?.[0]?.type ?? null,
          circleGeometryMismatch: boundsComparison.mismatch,
          circleGeometryMismatchReason: boundsComparison.reason,
          circleGeometryDelta: boundsComparison.delta ?? null,
          createdShapeSummary: createdRegionSummary.shapes
        });
      }
    } catch (caughtError) {
      error(failedLogKey, caughtError, {
        templateId: templateDocument?.id ?? null,
        sceneId: scene?.id ?? null,
        ...templateDiagnostics,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex: index + 1,
        partCountCreated: createdRegions.length,
        partCountExpected,
        shapeSummary: summarizeRegionCreateData([regionData])
      });
      logV14RegionDiagnostic("regionPartCreateFailed", {
        templateId: templateDocument?.id ?? null,
        sceneId: scene?.id ?? null,
        ...templateDiagnostics,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex: index + 1,
        partCountCreated: createdRegions.length,
        partCountExpected,
        error: caughtError?.message ?? "unknown",
        regionCreateFailedReason: caughtError?.message ?? "unknown",
        polygonPointsFormat: isRingPart ? "flat-number-array" : null,
        polygonPointCount: isRingPart ? ringPayloadShapeSummary?.[0]?.pointCount ?? null : null,
        sentShapes: summarizeFoundryRegionShapes(regionData?.shapes ?? []),
        regionCreatePayloadJson: stringifyShapeSummary(regionData)
      });
      logV14RegionDiagnostic(failedLogKey, {
        templateId: templateDocument?.id ?? null,
        sceneId: scene?.id ?? null,
        ...templateDiagnostics,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex: index + 1,
        partCountCreated: createdRegions.length,
        partCountExpected,
        regionCreateFailedReason: caughtError?.message ?? "unknown",
        polygonPointsFormat: isRingPart ? "flat-number-array" : null,
        polygonPointCount: isRingPart ? ringPayloadShapeSummary?.[0]?.pointCount ?? null : null,
        sentShapes: summarizeFoundryRegionShapes(regionData?.shapes ?? []),
        regionCreatePayloadJson: stringifyShapeSummary(regionData)
      });

      if (createdRegions.length) {
        await deleteManagedRegionGroup(createdRegions, {
          reason: `${operation}-partial-failure`
        });
      }
      throw caughtError;
    }
  }

  const ringPartPlans = Array.from(groupPlan?.parts ?? [])
    .filter((partPlan) => partPlan?.geometryType === "ring" || partPlan?.geometryType === "side-of-ring");
  if (ringPartPlans.length) {
    logV14RegionDiagnostic("ringCreationCompleted", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionGroupId: groupPlan?.groupId ?? null,
      ringCreationCompleted: true,
      regionSegmentCountExpected: ringPartPlans.length,
      regionSegmentCountCreated: createdRegions.length,
      regionSegmentDocumentIds: createdRegions.map((region) => region?.id ?? null).filter(Boolean),
      regionSegmentBounds: createdRegions.map((region) =>
        calculateRegionBoundsFromShapes(region?.toObject?.()?.shapes ?? [])
      ),
      regionSegmentShapes: createdRegions.map((region) => ({
        regionId: region?.id ?? null,
        shapes: summarizeRegionDocumentShapes(region)
      })),
      regionSegmentHidden: createdRegions.map((region) => ({
        regionId: region?.id ?? null,
        hidden: Boolean(region?.hidden)
      })),
      regionSegmentDestroyed: createdRegions.map((region) => ({
        regionId: region?.id ?? null,
        destroyed: Boolean(region?._destroyed ?? region?.destroyed)
      }))
    });
  }

  logV14RegionDiagnostic("regionGroupCreateSuccess", {
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    ...templateDiagnostics,
    regionGroupId: groupPlan?.groupId ?? null,
    regionIds: createdRegions.map((region) => region?.id ?? null).filter(Boolean),
    partCountCreated: createdRegions.length,
    partCountExpected,
    regionShapeCount: countRegionShapes(regionCreateData),
    createdRegions: createdRegions.map((region) => ({
      id: region?.id ?? null,
      name: region?.name ?? null,
      partId: getRegionRuntimeFlags(region)?.partId ?? null,
      shapes: summarizeRegionDocumentShapes(region)
    }))
  });
  logV14RegionDiagnostic("partCountCreated", {
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    ...templateDiagnostics,
    regionGroupId: groupPlan?.groupId ?? null,
    partCountCreated: createdRegions.length,
    partCountExpected,
    createdPartIds: createdRegions.map((region) => getRegionRuntimeFlags(region)?.partId ?? null),
    expectedPartIds: Array.from(groupPlan?.parts ?? []).map((partPlan) => partPlan.partId ?? null)
  });

  logV14RegionDiagnostic(successLogKey, {
    templateId: templateDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    ...templateDiagnostics,
    regionGroupId: groupPlan?.groupId ?? null,
    regionIds: createdRegions.map((region) => region?.id ?? null).filter(Boolean),
    regionCount: createdRegions.length,
    partCountCreated: createdRegions.length,
    partCountExpected,
    shapeSummary: summarizeRegionCreateData(regionCreateData)
  });

  if (!isRebuild) {
    await applyRegionGroupOnCreateTriggers(createdRegions);
  }

  return createdRegions;
}

async function ensureManagedRegionRuntimeFlags(regionDocument, runtimeFlagsPayload, {
  templateDocument = null,
  scene = null,
  templateDiagnostics = {},
  groupPlan = null,
  partId = null,
  partIndex = null
} = {}) {
  if (!regionDocument || !runtimeFlagsPayload) {
    logV14RegionDiagnostic("regionManagedFlagsWriteFailed", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionDocumentId: regionDocument?.id ?? null,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
      partIndex,
      reason: !regionDocument ? "missing-region-document" : "missing-runtime-flags-payload",
      regionManagedFlagsWriteFailedReason: !regionDocument ? "missing-region-document" : "missing-runtime-flags-payload",
      regionManagedFlagsWriteTargetId: regionDocument?.id ?? null,
      regionManagedFlagsWritePayloadSummary: runtimeFlagsPayload
        ? {
          itemUuid: runtimeFlagsPayload.itemUuid ?? null,
          groupId: runtimeFlagsPayload.groupId ?? null,
          partId: runtimeFlagsPayload.partId ?? null,
          architecturePath: runtimeFlagsPayload.architecturePath ?? null,
          regionSourceStrategy: runtimeFlagsPayload.regionSourceStrategy ?? null
        }
        : null
    });
    return null;
  }

  const existingRuntime = getRegionRuntimeFlags(regionDocument);
  if (existingRuntime?.templateId || existingRuntime?.templateUuid) {
    logV14RegionDiagnostic("regionDocumentFlagsAfterCreate", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionDocumentId: regionDocument.id,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
      partIndex,
      regionManagedFlagsRead: true,
      regionManagedFlagsSource: "create-payload",
      managedRegionDetected: true,
      regionDocumentFlagsAfterCreate: duplicateData(regionDocument?.flags ?? null),
      regionDocumentSourceFlagsAfterCreate: duplicateData(regionDocument?._source?.flags ?? null)
    });
    return existingRuntime;
  }

  try {
    if (typeof regionDocument.setFlag === "function") {
      await regionDocument.setFlag(MODULE_ID, RUNTIME_FLAG_KEY, runtimeFlagsPayload);
    } else {
      await regionDocument.update({
        [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]: runtimeFlagsPayload
      });
    }

    const updatedRuntime = getRegionRuntimeFlags(regionDocument);
    logV14RegionDiagnostic("regionDocumentFlagsAfterUpdate", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionDocumentId: regionDocument.id,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
      partIndex,
      regionManagedFlagsWritten: Boolean(updatedRuntime),
      regionManagedFlagsNamespace: `${MODULE_ID}.${RUNTIME_FLAG_KEY}`,
      regionManagedFlagsSource: typeof regionDocument.setFlag === "function" ? "setFlag" : "document-update",
      managedRegionDetected: Boolean(updatedRuntime?.templateId || updatedRuntime?.templateUuid),
      regionDocumentFlagsAfterUpdate: duplicateData(regionDocument?.flags ?? null),
      regionDocumentSourceFlagsAfterUpdate: duplicateData(regionDocument?._source?.flags ?? null)
    });

    if (updatedRuntime?.templateId || updatedRuntime?.templateUuid) {
      logV14RegionDiagnostic("regionManagedFlagsWritten", {
        templateId: templateDocument?.id ?? null,
        sceneId: scene?.id ?? null,
        ...templateDiagnostics,
        regionDocumentId: regionDocument.id,
        regionGroupId: groupPlan?.groupId ?? null,
        partId,
        partIndex,
        regionManagedFlagsWritten: true,
        regionManagedFlagsNamespace: `${MODULE_ID}.${RUNTIME_FLAG_KEY}`,
        regionManagedFlagsSource: typeof regionDocument.setFlag === "function" ? "setFlag" : "document-update",
        regionManagedFlagsPayload: duplicateData(runtimeFlagsPayload)
      });
      return updatedRuntime;
    }

    logV14RegionDiagnostic("regionManagedFlagsWriteFailed", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionDocumentId: regionDocument.id,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
      partIndex,
      reason: "post-create-write-did-not-read-back",
      regionDocumentFlagsAfterUpdate: duplicateData(regionDocument?.flags ?? null),
      regionDocumentSourceFlagsAfterUpdate: duplicateData(regionDocument?._source?.flags ?? null)
    });
    return updatedRuntime;
  } catch (caughtError) {
    logV14RegionDiagnostic("regionManagedFlagsWriteFailed", {
      templateId: templateDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ...templateDiagnostics,
      regionDocumentId: regionDocument.id,
      regionGroupId: groupPlan?.groupId ?? null,
      partId,
      partIndex,
      reason: caughtError?.message ?? "unknown",
      regionManagedFlagsNamespace: `${MODULE_ID}.${RUNTIME_FLAG_KEY}`,
      regionManagedFlagsPayload: duplicateData(runtimeFlagsPayload)
    });
    return null;
  }
}

async function buildRuntimeFlagsForUnmanagedCreatedRegion(regionDocument, {
  architecturePath = REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
  userId = null
} = {}) {
  const scene = regionDocument?.parent ?? canvas?.scene ?? null;
  if (!scene) {
    return {
      runtimeFlags: null,
      reason: "missing-scene",
      candidateCount: 0,
      candidates: []
    };
  }

  const candidates = [];
  const sourceHints = readV14SourceResolutionHints(regionDocument);
  const sourceShapeKind = classifyV14SourceRegionShapeKind(regionDocument);
  const templates =
    scene?.templates?.contents ??
    Array.from(scene?.templates?.values?.() ?? []);

  logV14RegionDiagnostic("v14SourceResolutionStrategy", {
    entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion",
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    v14SourceResolutionFromRegionFlags: sourceHints,
    v14SourceShapeKind: sourceShapeKind,
    v14SourceResolutionStrategy: sourceHints.itemUuid
      ? "region-flags-item-uuid"
      : "scene-template-candidates-with-shape-compatibility"
  });

  const directPlacementContext = findPersistentZonePlacementContext({
    userId: userId ?? userIdForRegionCreation(regionDocument),
    sceneId: scene.id,
    itemUuid: sourceHints.itemUuid ?? null,
    regionShapeType: sourceShapeKind
  });
  if (directPlacementContext) {
    const contextItem = await fromUuidSafe(directPlacementContext.itemUuid);
    const contextActivity = contextItem
      ? findPersistentZoneActivityOnItem(contextItem, {
        activityId: directPlacementContext.activityId,
        activityUuid: directPlacementContext.activityUuid,
        fallbackToSinglePersistentZoneActivity: false
      })
      : null;
    const nativeTemplateType = normalizePlacementContextTemplateType(
      directPlacementContext.nativeTemplateType ?? directPlacementContext.targetTemplateType
    );
    const contextTemplateDocument = {
      id: regionDocument?.id ?? null,
      uuid: regionDocument?.uuid ?? null,
      documentName: "Region",
      parent: scene,
      t: nativeTemplateType,
      x: estimateRegionCenter(regionDocument).x,
      y: estimateRegionCenter(regionDocument).y
    };
    const sourceContext = {
      item: contextItem ?? null,
      actor: contextItem?.actor ?? null,
      caster: contextItem?.actor ?? null,
      activity: contextActivity ?? null
    };
    const configuration = resolvePersistentZoneConfiguration({
      actor: sourceContext.actor,
      item: sourceContext.item,
      activity: sourceContext.activity,
      templateDocument: contextTemplateDocument,
      regionDocument,
      entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion:placement-context-direct"
    });
    const normalizedDefinition = configuration.normalizedDefinition;
    if (configuration.hasConfiguration && normalizedDefinition?.enabled !== false && normalizedDefinition?.validation?.valid !== false) {
      const summary = buildV14SourceCandidateSummary({
        templateDocument: contextTemplateDocument,
        sourceContext,
        normalizedDefinition,
        regionDocument,
        sourceShapeKind
      });
      const rectangleLineIdentityHandoff =
        directPlacementContext.geometryType === "rectangle" &&
        directPlacementContext.nativeTemplateType === "rect" &&
        sourceShapeKind === "line";
      const accepted = summary.sourceShapeCompatible || rectangleLineIdentityHandoff;
      const finalSummary = {
        ...summary,
        score: 1_000_000,
        directPlacementContext: true,
        rectangleLineIdentityHandoff,
        v14SourceCandidateRejected: !accepted,
        v14SourceCandidateRejectedReason: accepted ? null : "source-shape-template-type-mismatch"
      };
      candidates.push({
        templateDocument: contextTemplateDocument,
        sourceContext,
        normalizedDefinition,
        identityHandoff: buildActivityIdentityHandoff({ placementContext: directPlacementContext, placementActivity: contextActivity }),
        score: accepted ? 1_000_000 : -1,
        sourceRejected: !accepted,
        summary: finalSummary
      });
      logV14RegionDiagnostic(accepted ? "v14SourceCandidateFound" : "v14SourceCandidateRejected", finalSummary);
    } else {
      logV14RegionDiagnostic("v14SourceCandidateRejected", {
        directPlacementContext: true,
        v14SourceCandidateRejected: true,
        v14SourceCandidateRejectedReason: !contextItem ? "placement-context-item-not-resolved" : !contextActivity ? "placement-context-activity-not-resolved" : "placement-context-configuration-invalid",
        itemUuid: directPlacementContext.itemUuid,
        activityId: directPlacementContext.activityId,
        sourceShapeKind,
        nativeTemplateType
      });
    }
  }

  for (const templateDocument of templates) {
    const resolvedContext = await resolveTemplateSourceContext(templateDocument, { emitDebug: false });
    const nativeActivity = resolvedContext.activity ?? findPersistentZoneActivityOnItem(resolvedContext.item, {
      activityId: sourceHints.activityId,
      activityUuid: sourceHints.activityUuid,
      fallbackToSinglePersistentZoneActivity: false
    });
    const placementContext = findPersistentZonePlacementContext({
      userId: userId ?? userIdForRegionCreation(regionDocument),
      sceneId: scene.id,
      itemUuid: resolvedContext.item?.uuid ?? null,
      regionShapeType: sourceShapeKind
    });
    const placementActivity = placementContext
      ? findPersistentZoneActivityOnItem(resolvedContext.item, {
        activityId: placementContext.activityId,
        activityUuid: placementContext.activityUuid,
        fallbackToSinglePersistentZoneActivity: false
      })
      : null;
    const sourceContext = {
      item: resolvedContext.item ?? null,
      actor: resolvedContext.actor ?? null,
      caster: resolvedContext.caster ?? resolvedContext.actor ?? null,
      activity: nativeActivity ?? placementActivity ?? null
    };
    const configuration = resolvePersistentZoneConfiguration({
      actor: sourceContext.actor,
      item: sourceContext.item,
      activity: sourceContext.activity,
      templateDocument,
      regionDocument,
      entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion"
    });
    if (!configuration.hasConfiguration) {
      continue;
    }

    const normalizedDefinition = configuration.normalizedDefinition;
    if (!normalizedDefinition || normalizedDefinition.enabled === false || normalizedDefinition.validation?.valid === false) {
      continue;
    }

    const candidateSummary = buildV14SourceCandidateSummary({
      templateDocument,
      sourceContext,
      normalizedDefinition,
      regionDocument,
      sourceShapeKind
    });
    logV14RegionDiagnostic("v14SourceCandidateFound", candidateSummary);

    if (sourceHints.itemUuid && sourceContext.item?.uuid !== sourceHints.itemUuid) {
      const rejectedSummary = {
        ...candidateSummary,
        v14SourceCandidateRejected: true,
        v14SourceCandidateRejectedReason: "item-uuid-does-not-match-region-source-flags"
      };
      logV14RegionDiagnostic("v14SourceCandidateRejected", rejectedSummary);
      candidates.push({
        templateDocument,
        sourceContext,
        normalizedDefinition,
        identityHandoff: buildActivityIdentityHandoff({ nativeActivity, placementContext, placementActivity }),
        score: -1,
        sourceRejected: true,
        summary: rejectedSummary
      });
      continue;
    }

    if (!candidateSummary.sourceShapeCompatible) {
      const rejectedSummary = {
        ...candidateSummary,
        v14SourceCandidateRejected: true,
        v14SourceCandidateRejectedReason: "source-shape-template-type-mismatch"
      };
      logV14RegionDiagnostic("v14SourceCandidateRejected", rejectedSummary);
      candidates.push({
        templateDocument,
        sourceContext,
        normalizedDefinition,
        identityHandoff: buildActivityIdentityHandoff({ nativeActivity, placementContext, placementActivity }),
        score: -1,
        sourceRejected: true,
        summary: rejectedSummary
      });
      continue;
    }

    const nativeRingClassification = classifyV14NativeRingCandidate(normalizedDefinition);
    if (nativeRingClassification.isNativeRing) {
      logV14RegionDiagnostic("v14NativeRingClassified", {
        ...candidateSummary,
        v14NativeRingClassified: true,
        v14NativeRingIsMultipart: false,
        v14NativeRingShapeCountExpected: 2,
        v14NativeRingHoleCountExpected: 1
      });
    }

    const isSupportedSourceMultipart = isSupportedV14SourceMultipartDefinition(normalizedDefinition);
    if (
      Array.isArray(normalizedDefinition.parts) &&
      normalizedDefinition.parts.length > 1 &&
      !nativeRingClassification.isNativeRing &&
      !isSupportedSourceMultipart
    ) {
      const skippedSummary = {
        ...candidateSummary,
        multipartSkipped: true,
        skippedReason: "multipart-definition-owned-by-region-factory"
      };
      candidates.push({
        templateDocument,
        sourceContext,
        normalizedDefinition,
        identityHandoff: buildActivityIdentityHandoff({ nativeActivity, placementContext, placementActivity }),
        score: -1,
        multipartSkipped: true,
        summary: skippedSummary
      });
      logV14RegionDiagnostic("v14SourceCandidateRejected", {
        ...skippedSummary,
        v14SourceCandidateRejected: true,
        v14SourceCandidateRejectedReason: "multipart-definition-owned-by-region-factory"
      });
      continue;
    }

    const score = scoreTemplateForRegionFallback(templateDocument, regionDocument);
    candidates.push({
      templateDocument,
      sourceContext,
      normalizedDefinition,
      identityHandoff: buildActivityIdentityHandoff({ nativeActivity, placementContext, placementActivity }),
      score,
      summary: {
        ...candidateSummary,
        score
      }
    });
  }

  logV14RegionDiagnostic("ringCreationEntry", {
    entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion",
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    sceneId: scene?.id ?? null,
    candidateCount: candidates.length,
    ringDefinitionResolved: candidates.some((candidate) =>
      summarizeRingDefinition(candidate.normalizedDefinition).hasRingDefinition
    ),
    candidates: candidates.map((candidate) => candidate.summary),
    selectedCompatibilityPath: "v14-native-region-source-candidate-resolution"
  });

  const eligibleCandidates = candidates.filter((candidate) => !candidate.multipartSkipped && !candidate.sourceRejected);
  eligibleCandidates.sort((left, right) => right.score - left.score);
  const selected = selectV14SourceCandidate(eligibleCandidates, {
    sourceHints,
    regionDocument,
    sourceShapeKind
  });
  if (!selected) {
    const reason = buildV14SourceResolutionFailureReason(candidates, eligibleCandidates);
    logV14RegionDiagnostic("ringCreationSkipped", {
      entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion",
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      ringCreationSkipped: true,
      ringCreationSkipReason: reason,
      candidateCount: candidates.length,
      candidates: candidates.map((candidate) => candidate.summary),
      ringSkipConditionEvaluated: "v14-source-candidate-selection",
      ringSkipConditionFailedField: reason,
      selectedCompatibilityPath: "v14-native-region-source-candidate-resolution"
    });
    logV14RegionDiagnostic(reason === "v14-source-resolution-ambiguous" ? "v14SourceResolutionAmbiguous" : "v14SourceResolutionFailed", {
      entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion",
      hook: "createRegion",
      regionDocumentId: regionDocument?.id ?? null,
      sceneId: scene?.id ?? null,
      reason,
      sourceHints,
      sourceShapeKind,
      candidateCount: candidates.length,
      eligibleCandidateCount: eligibleCandidates.length,
      candidates: candidates.map((candidate) => candidate.summary)
    });
    return {
      runtimeFlags: null,
      reason,
      candidateCount: candidates.length,
      candidates: candidates.map((candidate) => candidate.summary)
    };
  }
  const consumedPlacementContext = selected.identityHandoff?.placementContext
    ? consumePersistentZonePlacementContext(selected.identityHandoff.placementContext)
    : null;
  const sourcePlacementContext = consumedPlacementContext ?? selected.identityHandoff?.placementContext ?? null;
  selected.sourceContext = {
    ...selected.sourceContext,
    sourceTokenUuid: sourcePlacementContext?.sourceTokenUuid ?? selected.sourceContext?.sourceTokenUuid ?? null,
    sourceDisposition: sourcePlacementContext?.sourceDisposition ?? selected.sourceContext?.sourceDisposition ?? null
  };
  logActivityIdentityHandoff({
    ...selected.identityHandoff,
    contextConsumed: Boolean(consumedPlacementContext),
    regionDocument,
    regionShapeType: sourceShapeKind
  });
  logV14RegionDiagnostic("v14SourceCandidateSelected", {
    ...selected.summary,
    v14SourceCandidateSelected: true,
    v14SourceResolutionStrategy: sourceHints.itemUuid
      ? "region-flags-item-uuid"
      : "scene-template-candidates-with-shape-compatibility"
  });

  if (isSupportedV14SourceMultipartDefinition(selected.normalizedDefinition)) {
    const sourceShapes = summarizeRegionDocumentRawShapes(regionDocument);
    const rootGeometryType = String(selected.normalizedDefinition?.geometry?.type ?? "").toLowerCase();
    const multipartSourceShapes = sourceShapes.some((shape) => String(shape?.type ?? "").toLowerCase() === "ring")
      ? sourceShapes
      : ["ring", "annulus"].includes(rootGeometryType)
        ? buildV14NativeRingShapesFromResolved({
          templateDocument: selected.templateDocument,
          runtimeFlags: { normalizedDefinition: selected.normalizedDefinition },
          profilePart: { geometry: selected.normalizedDefinition.geometry }
        }, regionDocument)
        : sourceShapes;
    const existingSharedOwnerEffectUuid =
      sourceHints.ownerEffectUuid ??
      sourceHints.activeEffectUuid ??
      sourceHints.concentrationEffectUuid ??
      selected.normalizedDefinition?.concentration?.effectUuid ??
      null;
    const concentrationOwnerResolution = existingSharedOwnerEffectUuid
      ? {
        selectedOwnerEffectUuid: existingSharedOwnerEffectUuid,
        candidateEffectUuids: [existingSharedOwnerEffectUuid],
        resolutionMode: "existing-runtime-owner-effect",
        ambiguous: false
      }
      : resolveExistingConcentrationOwnerEffectForMultipart({
        normalizedDefinition: selected.normalizedDefinition,
        sourceContext: selected.sourceContext,
        sourceHints
      });
    logV14RegionDiagnostic("multipartConcentrationOwnerResolution", {
      entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion",
      regionDocumentId: regionDocument?.id ?? null,
      itemUuid: sourceHints.itemUuid ?? selected.sourceContext?.item?.uuid ?? null,
      actorUuid: sourceHints.actorUuid ?? selected.sourceContext?.actor?.uuid ?? selected.sourceContext?.caster?.uuid ?? null,
      activityId: sourceHints.activityId ?? selected.normalizedDefinition?.activityId ?? selected.sourceContext?.activity?.id ?? null,
      candidateEffectUuids: concentrationOwnerResolution.candidateEffectUuids,
      selectedOwnerEffectUuid: concentrationOwnerResolution.selectedOwnerEffectUuid,
      resolutionMode: concentrationOwnerResolution.resolutionMode,
      ambiguous: concentrationOwnerResolution.ambiguous
    });
    const multipartGroupPlan = await buildManagedRegionGroupPlan({
      templateDocument: selected.templateDocument,
      normalizedDefinition: selected.normalizedDefinition,
      sourceContext: selected.sourceContext,
      sourceRegionDocument: regionDocument,
      sourceRegionShapes: multipartSourceShapes,
      adoptedV14Source: true,
      sharedOwnerEffectUuid: concentrationOwnerResolution.selectedOwnerEffectUuid
    });
    if (multipartGroupPlan.parts?.length !== selected.normalizedDefinition.parts.length) {
      return {
        runtimeFlags: null,
        templateDocument: selected.templateDocument,
        sourceContext: selected.sourceContext,
        reason: "v14-multipart-region-group-incomplete",
        multipartGroupPlan
      };
    }
    const primaryRuntimeFlags = multipartGroupPlan.parts?.[0]?.regionData?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY] ?? null;
    return {
      runtimeFlags: primaryRuntimeFlags,
      templateDocument: selected.templateDocument,
      sourceContext: selected.sourceContext,
      profileGeometryType: "template",
      multipartGroupPlan,
      candidateCount: candidates.length,
      selectedCandidate: selected.summary,
      candidates: candidates.map((candidate) => candidate.summary)
    };
  }

  logV14PipelineStep("03", "Profile resolved", {
    entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion",
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    templateId: selected.templateDocument?.id ?? null,
    templateUuid: selected.templateDocument?.uuid ?? null,
    templateType: getTemplateType(selected.templateDocument),
    detectedTemplateTypeRaw: getTemplateType(selected.templateDocument),
    profileId: selected.normalizedDefinition?.selectedVariantId ??
      selected.normalizedDefinition?.selectedVariant?.id ??
      selected.normalizedDefinition?.id ??
      null,
    profileType: classifyNormalizedDefinitionZoneKind(selected.normalizedDefinition),
    requestedShapeType: null,
    serializerUsed: null,
    payloadShapeType: getRegionPipelineShapeTypes(regionDocument).join(",") || null,
    selectedCandidate: selected.summary
  });

  const profileGeometry = resolveProfileGeometrySelection(selected.normalizedDefinition);
  const runtimePart = profileGeometry.part ?? resolveSingleRegionRuntimePart(selected.normalizedDefinition);
  const runtimeDefinition = runtimePart
    ? buildPartRuntimeDefinition(selected.normalizedDefinition, runtimePart, {
      groupId: buildManagedRegionGroupId(selected.templateDocument, []),
      partIndex: 0,
      partCount: 1
    })
    : selected.normalizedDefinition;
  const runtimePartGeometryType = String(
    profileGeometry.geometryType ?? runtimePart?.geometry?.type ?? selected.normalizedDefinition?.geometry?.type ?? "template"
  ).toLowerCase();
  logGeometrySource({
    entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion",
    templateId: selected.templateDocument?.id ?? null,
    detectedTemplateTypeRaw: getTemplateType(selected.templateDocument),
    profileId: selected.normalizedDefinition?.selectedVariantId ??
      selected.normalizedDefinition?.selectedVariant?.id ??
      selected.normalizedDefinition?.id ??
      null,
    geometryFromProfile: profileGeometry.geometryType ?? null,
    geometryFromTemplate: getTemplateType(selected.templateDocument),
    geometrySelected: runtimePartGeometryType,
    factorySelected: runtimePartGeometryType === "ring" ? "native-ring-candidate" : "non-ring",
    serializerSelected: null
  });
  logV14PipelineStep("04", "Shape requested", {
    entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion",
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    templateId: selected.templateDocument?.id ?? null,
    templateType: getTemplateType(selected.templateDocument),
    detectedTemplateTypeRaw: getTemplateType(selected.templateDocument),
    profileId: selected.normalizedDefinition?.selectedVariantId ??
      selected.normalizedDefinition?.selectedVariant?.id ??
      selected.normalizedDefinition?.id ??
      null,
    profileType: classifyNormalizedDefinitionZoneKind(selected.normalizedDefinition),
    requestedShapeType: runtimePartGeometryType,
    serializerUsed: null,
    payloadShapeType: null,
    runtimePartId: runtimePart?.id ?? null,
    runtimePartGeometryType,
    normalizedGeometryType: selected.normalizedDefinition?.geometry?.type ?? null,
    partGeometryTypes: Array.from(selected.normalizedDefinition?.parts ?? [])
      .map((part) => part?.geometry?.type ?? null)
      .filter(Boolean)
  });
  const regionShapes = runtimePart && runtimePartGeometryType.includes("ring")
    ? await buildRegionShapesForZonePart(selected.templateDocument, runtimePart, {
      allParts: Array.isArray(selected.normalizedDefinition?.parts)
        ? selected.normalizedDefinition.parts
        : [runtimePart]
    })
    : null;
  const runtimeGeometry = runtimePart
    ? buildRuntimeGeometryForZonePart(selected.templateDocument, runtimePart, regionShapes ?? [])
    : null;
  logV14PipelineStep("04b", "Shape builder result", {
    entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion",
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    templateId: selected.templateDocument?.id ?? null,
    templateType: getTemplateType(selected.templateDocument),
    profileId: selected.normalizedDefinition?.selectedVariantId ??
      selected.normalizedDefinition?.selectedVariant?.id ??
      selected.normalizedDefinition?.id ??
      null,
    profileType: classifyNormalizedDefinitionZoneKind(selected.normalizedDefinition),
    requestedShapeType: runtimePartGeometryType,
    serializerUsed: null,
    payloadShapeType: Array.from(regionShapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
    rawRegionShapes: summarizeFoundryRegionShapes(regionShapes ?? []),
    runtimeGeometry: duplicateData(runtimeGeometry ?? null)
  });

  const useNativeSegmentGroup = isFoundryV14OrNewer() &&
    (runtimePartGeometryType === "ring" || runtimePartGeometryType === "side-of-ring") &&
    Array.isArray(regionShapes) &&
    regionShapes.length > 1;

  const runtimeFlags = buildManagedRegionRuntimeFlags({
    templateDocument: selected.templateDocument,
    normalizedDefinition: runtimeDefinition,
    sourceContext: selected.sourceContext,
    groupId: buildManagedRegionGroupId(selected.templateDocument, []),
    partId: runtimePart?.id ?? "primary",
    partIndex: 0,
    partCount: useNativeSegmentGroup ? regionShapes.length : 1,
    geometryType: runtimePartGeometryType,
    runtimeGeometry,
    regionSourceStrategy: useNativeSegmentGroup
      ? "v14-region-native-segment-group"
      : isFoundryV14OrNewer()
        ? "v14-region-native-adopted-region"
        : "legacy-template-compatible",
    regionSegmentIndex: useNativeSegmentGroup ? 1 : null,
    regionSegmentCount: useNativeSegmentGroup ? regionShapes.length : null,
    architecturePath
  });
  logGeometrySource({
    entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion:runtimeFlags",
    templateId: selected.templateDocument?.id ?? null,
    detectedTemplateTypeRaw: getTemplateType(selected.templateDocument),
    profileId: selected.normalizedDefinition?.selectedVariantId ??
      selected.normalizedDefinition?.selectedVariant?.id ??
      selected.normalizedDefinition?.id ??
      null,
    geometryFromProfile: profileGeometry.geometryType ?? null,
    geometryFromTemplate: getTemplateType(selected.templateDocument),
    geometrySelected: runtimeFlags.geometryType,
    factorySelected: runtimeFlags.geometryType === "ring" ? "native-ring-candidate" : "non-ring",
    serializerSelected: Array.from(regionShapes ?? []).map((shape) => getRegionShapeSerializerName(shape)).join(",") || null
  });
  logV14PipelineStep("04c", "Runtime shape decision", {
    entryPoint: "buildRuntimeFlagsForUnmanagedCreatedRegion",
    hook: "createRegion",
    regionDocumentId: regionDocument?.id ?? null,
    templateId: selected.templateDocument?.id ?? null,
    templateType: getTemplateType(selected.templateDocument),
    profileId: selected.normalizedDefinition?.selectedVariantId ??
      selected.normalizedDefinition?.selectedVariant?.id ??
      selected.normalizedDefinition?.id ??
      null,
    profileType: classifyNormalizedDefinitionZoneKind(selected.normalizedDefinition),
    requestedShapeType: runtimePartGeometryType,
    serializerUsed: null,
    payloadShapeType: Array.from(regionShapes ?? []).map((shape) => shape?.type ?? null).join(",") || null,
    runtimeGeometryType: runtimeFlags.geometryType,
    regionSourceStrategy: runtimeFlags.regionSourceStrategy,
    useNativeSegmentGroup,
    ringFactorySelectable: runtimeFlags.geometryType === "ring"
  });

  return {
    runtimeFlags,
    templateDocument: selected.templateDocument,
    sourceContext: selected.sourceContext,
    regionShapes,
    profileGeometryType: profileGeometry.geometryType ?? null,
    profilePart: profileGeometry.part ?? null,
    candidateCount: candidates.length,
    selectedCandidate: selected.summary,
    candidates: candidates.map((candidate) => candidate.summary)
  };
}

function resolveSingleRegionRuntimePart(normalizedDefinition) {
  if (Array.isArray(normalizedDefinition?.parts) && normalizedDefinition.parts.length === 1) {
    return normalizedDefinition.parts[0];
  }

  if (normalizedDefinition?.geometry && typeof normalizedDefinition.geometry === "object") {
    return {
      id: "primary",
      label: normalizedDefinition?.label ?? "Persistent Zone",
      geometry: duplicateData(normalizedDefinition.geometry),
      triggers: duplicateData(normalizedDefinition.triggers ?? {}),
      targeting: duplicateData(normalizedDefinition.targeting ?? {})
    };
  }

  return null;
}

function resolveProfileGeometrySelection(normalizedDefinition) {
  const parts = Array.from(normalizedDefinition?.parts ?? []);
  const ringPart = parts.find((part) => {
    const geometryType = String(part?.geometry?.type ?? "").toLowerCase();
    return geometryType === "ring" || geometryType === "annulus";
  }) ?? null;
  if (ringPart) {
    return {
      geometryType: String(ringPart.geometry?.type ?? "ring").toLowerCase(),
      part: ringPart,
      source: "profile-ring-part"
    };
  }

  const singlePart = parts.length === 1 ? parts[0] : null;
  if (singlePart?.geometry?.type) {
    return {
      geometryType: String(singlePart.geometry.type).toLowerCase(),
      part: singlePart,
      source: "profile-single-part"
    };
  }

  if (normalizedDefinition?.geometry?.type) {
    return {
      geometryType: String(normalizedDefinition.geometry.type).toLowerCase(),
      part: null,
      source: "profile-root-geometry"
    };
  }

  return {
    geometryType: "template",
    part: null,
    source: "profile-default-template"
  };
}

function resolveResolvedProfileGeometryType(resolved) {
  return String(
    resolved?.profileGeometryType ??
    resolveProfileGeometrySelection(resolved?.runtimeFlags?.normalizedDefinition).geometryType ??
    resolved?.runtimeFlags?.geometryType ??
    "template"
  ).toLowerCase();
}

function summarizeRingDefinition(normalizedDefinition) {
  const partGeometryTypes = Array.isArray(normalizedDefinition?.parts)
    ? normalizedDefinition.parts.map((part) => String(part?.geometry?.type ?? "template").toLowerCase())
    : [];
  const normalizedGeometryType = String(normalizedDefinition?.geometry?.type ?? "").toLowerCase() || null;
  const selectedGeometryType = partGeometryTypes.find((geometryType) => geometryType.includes("ring"))
    ?? (normalizedGeometryType?.includes("ring") ? normalizedGeometryType : null);

  return {
    hasRingDefinition: Boolean(selectedGeometryType),
    selectedGeometryType,
    normalizedGeometryType,
    partGeometryTypes,
    partCountExpected: partGeometryTypes.length || (normalizedGeometryType ? 1 : 0)
  };
}

function scoreTemplateForRegionFallback(templateDocument, regionDocument) {
  const templateCenter = {
    x: coerceNumber(templateDocument?.x, 0),
    y: coerceNumber(templateDocument?.y, 0)
  };
  const regionCenter = estimateRegionCenter(regionDocument);
  const distance = Math.hypot(regionCenter.x - templateCenter.x, regionCenter.y - templateCenter.y);
  return Number.isFinite(distance) ? 100000 - distance : 0;
}

function readV14SourceResolutionHints(regionDocument) {
  const objectData = duplicateData(regionDocument?.toObject?.() ?? {});
  const flags = {
    ...(objectData?.flags?.[MODULE_ID] ?? {}),
    ...(regionDocument?.flags?.[MODULE_ID] ?? {}),
    ...(regionDocument?._source?.flags?.[MODULE_ID] ?? {})
  };
  const runtime = flags?.[RUNTIME_FLAG_KEY] ?? {};
  const source = flags?.source ?? flags?.castSource ?? flags?.v14CastSource ?? {};
  return {
    itemUuid: runtime.itemUuid ?? source.itemUuid ?? objectData?.itemUuid ?? null,
    actorUuid: runtime.actorUuid ?? source.actorUuid ?? objectData?.actorUuid ?? null,
    activityId: source.activityId ?? runtime.activityId ?? null,
    activityUuid: source.activityUuid ?? runtime.activityUuid ?? null,
    workflowId: source.workflowId ?? runtime.workflowId ?? null,
    ownerEffectUuid: runtime.ownerEffectUuid ?? runtime.activeEffectUuid ?? runtime.concentrationEffectUuid ?? source.ownerEffectUuid ?? source.activeEffectUuid ?? source.concentrationEffectUuid ?? source.effectUuid ?? null,
    activeEffectUuid: runtime.activeEffectUuid ?? runtime.ownerEffectUuid ?? source.activeEffectUuid ?? source.ownerEffectUuid ?? source.effectUuid ?? null,
    concentrationEffectUuid: runtime.concentrationEffectUuid ?? source.concentrationEffectUuid ?? source.ownerEffectUuid ?? source.effectUuid ?? null
  };
}

async function cleanupOrphanedDedicatedOwnerEffectsForWorld({ reason = "manual" } = {}) {
  if (!isPrimaryGM()) {
    return [];
  }

  const results = [];
  const effects = Array.from(game?.actors?.contents ?? [])
    .flatMap((actor) => Array.from(actor?.effects ?? []))
    .filter((effect) => isPersistentZonesDedicatedOwnerEffect(effect));
  for (const activeEffect of effects) {
    results.push(await deleteDedicatedOwnerEffectIfOrphaned(activeEffect, { reason }));
  }
  return results;
}

async function repairInvalidOwnerEffectReferences(ownerEffectUuid, { reason = "manual" } = {}) {
  if (!ownerEffectUuid) return [];
  const repaired = [];
  for (const region of findManagedRegionsReferencingOwnerEffect(ownerEffectUuid)) {
    const runtime = getRegionRuntimeFlags(region) ?? {};
    if (runtime.normalizedDefinition?.concentration?.required !== true) continue;
    await clearInvalidOwnerEffectLink(region, ownerEffectUuid, {
      reason,
      rejectionReason: "status-source-effect-excluded"
    });
    repaired.push(region?.id ?? null);
  }
  await reconcileMissingOwnerEffectLinksForWorld({ reason: `${reason}-backfill` });
  return repaired.filter(Boolean);
}

async function clearInvalidOwnerEffectLink(regionDocument, ownerEffectUuid, {
  reason = "manual",
  rejectionReason = "invalid-lifecycle-owner"
} = {}) {
  if (!regionDocument?.update) return false;
  await regionDocument.update({
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.ownerEffectUuid`]: null,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.activeEffectUuid`]: null,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.concentrationEffectUuid`]: null,
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.ownerEffectLinkReconciledAt`]: Date.now(),
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.ownerEffectLinkResolutionMode`]: rejectionReason
  }, { persistentZonesOwnerEffectLinkRepair: true });
  return true;
}

async function deleteDedicatedOwnerEffectIfOrphaned(activeEffect, { reason = "manual" } = {}) {
  if (!activeEffect?.uuid || !isPersistentZonesDedicatedOwnerEffect(activeEffect)) {
    return { deleted: false, reason: "not-persistent-zones-dedicated-owner" };
  }

  const referencingRegions = findManagedRegionsReferencingOwnerEffect(activeEffect.uuid);
  const explicitlyLinkedRegion = findExplicitRegionDocumentForDedicatedOwnerEffect(activeEffect);
  if (referencingRegions.length || explicitlyLinkedRegion) {
    return {
      deleted: false,
      reason: referencingRegions.length ? "managed-region-still-references-owner" : "explicit-linked-region-still-exists",
      effectUuid: activeEffect.uuid,
      regionIds: referencingRegions.map((region) => region?.id ?? null).filter(Boolean),
      explicitRegionId: explicitlyLinkedRegion?.id ?? null
    };
  }

  await activeEffect.delete({
    persistentZonesOrphanOwnerCleanup: true
  });
  console.info(`[${MODULE_ID}][lifecycle] PZ ORPHANED DEDICATED OWNER EFFECT DELETED`, {
    effectUuid: activeEffect.uuid,
    effectName: activeEffect?.name ?? null,
    actorUuid: activeEffect?.parent?.uuid ?? null,
    reason
  });
  return {
    deleted: true,
    reason: "orphaned-persistent-zones-dedicated-owner",
    effectUuid: activeEffect.uuid
  };
}

function findExplicitRegionDocumentForDedicatedOwnerEffect(activeEffect) {
  const effectData = activeEffect?.toObject?.() ?? {};
  const pzFlags = effectData.flags?.[MODULE_ID] ?? activeEffect?.flags?.[MODULE_ID] ?? {};
  const scene = pzFlags.sceneId ? game?.scenes?.get?.(pzFlags.sceneId) ?? null : null;
  if (!scene) {
    return null;
  }
  const byId = pzFlags.regionId ? scene?.regions?.get?.(pzFlags.regionId) ?? null : null;
  if (byId && getRegionRuntimeFlags(byId)) {
    return byId;
  }
  if (!pzFlags.regionUuid) {
    return null;
  }
  return Array.from(scene?.regions ?? []).find((region) =>
    region?.uuid === pzFlags.regionUuid && Boolean(getRegionRuntimeFlags(region))
  ) ?? null;
}


function resolveExistingConcentrationOwnerEffectForMultipart({
  normalizedDefinition = {},
  sourceContext = null,
  sourceHints = {}
} = {}) {
  if (normalizedDefinition?.concentration?.required !== true) {
    return {
      selectedOwnerEffectUuid: null,
      candidateEffectUuids: [],
      resolutionMode: "concentration-not-required",
      ambiguous: false
    };
  }

  const actorUuid = sourceHints.actorUuid ?? sourceContext?.actor?.uuid ?? sourceContext?.caster?.uuid ?? null;
  const itemUuid = sourceHints.itemUuid ?? sourceContext?.item?.uuid ?? normalizedDefinition?.itemUuid ?? null;
  const activityId = String(
    sourceHints.activityId ??
    normalizedDefinition?.activityId ??
    sourceContext?.activity?.id ??
    ""
  ).trim();
  if (!actorUuid || !itemUuid || !activityId) {
    return {
      selectedOwnerEffectUuid: null,
      candidateEffectUuids: [],
      resolutionMode: "missing-structured-concentration-identity",
      ambiguous: false
    };
  }

  const actor = resolveActorSync(actorUuid);
  const matches = Array.from(actor?.effects ?? []).filter((activeEffect) => {
    if (!activeEffect || activeEffect.disabled || activeEffect.parent?.uuid !== actorUuid) {
      return false;
    }
    const effectData = activeEffect.toObject?.() ?? {};
    if (!hasStructuredConcentrationSignal(activeEffect, effectData)) {
      return false;
    }
    return resolveActiveEffectItemUuid(activeEffect, effectData) === itemUuid &&
      resolveActiveEffectActivityId(activeEffect, effectData) === activityId;
  });
  const selectedOwnerEffect = matches.length === 1 ? matches[0] : null;
  return {
    selectedOwnerEffectUuid: selectedOwnerEffect?.uuid ?? null,
    candidateEffectUuids: matches.map((activeEffect) => activeEffect?.uuid ?? null).filter(Boolean),
    resolutionMode: selectedOwnerEffect
      ? "unique-structured-concentration-owner"
      : matches.length > 1
        ? "ambiguous-structured-concentration-owner"
        : "no-structured-concentration-owner",
    ambiguous: matches.length > 1
  };
}

function hasStructuredConcentrationSignal(activeEffect, effectData = {}) {
  const statuses = extractEffectStatuses(activeEffect, effectData)
    .map((status) => String(status).toLowerCase());
  if (statuses.some((status) => status === "concentrating" || status === "concentration")) {
    return true;
  }
  return Boolean(
    getPropertyPath(effectData, "flags.dnd5e.concentration") ||
    getPropertyPath(effectData, "flags.dnd5e.isConcentration") ||
    getPropertyPath(effectData, "flags.midi-qol.concentration")
  );
}


function isSupportedV14SourceMultipartDefinition(normalizedDefinition) {
  const parts = Array.from(normalizedDefinition?.parts ?? []);
  if (parts.length < 2) return false;

  const resolvedPartTypes = new Map();
  let templatePartCount = 0;
  for (const part of parts) {
    const partId = String(part?.id ?? "").trim();
    const geometryType = String(part?.geometry?.type ?? "template").toLowerCase();
    if (!partId || !["template", "side-of-line", "side-of-ring"].includes(geometryType)) return false;
    if (geometryType === "template") {
      templatePartCount += 1;
    } else {
      const referencePartId = String(part?.geometry?.referencePartId ?? "").trim();
      if (!referencePartId || resolvedPartTypes.get(referencePartId) !== "template") return false;
    }
    resolvedPartTypes.set(partId, geometryType);
  }
  return templatePartCount > 0;
}

function userIdForRegionCreation(regionDocument) {
  return regionDocument?._stats?.createdBy ?? game.user?.id ?? null;
}

function buildActivityIdentityHandoff({ nativeActivity = null, placementContext = null, placementActivity = null } = {}) {
  const selectedActivity = nativeActivity ?? placementActivity ?? null;
  return {
    itemUuid: selectedActivity?.item?.uuid ?? selectedActivity?.parent?.uuid ?? placementContext?.itemUuid ?? null,
    nativeActivityId: nativeActivity?.id ?? null,
    nativeActivityUuid: nativeActivity?.uuid ?? null,
    placementContextFound: Boolean(placementContext),
    placementContextActivityId: placementContext?.activityId ?? null,
    placementContextActivityUuid: placementContext?.activityUuid ?? null,
    selectedActivityId: selectedActivity?.id ?? null,
    selectedActivityUuid: selectedActivity?.uuid ?? null,
    selectionSource: nativeActivity
      ? "native-dnd5e"
      : placementActivity
        ? "persistent-zone-placement-context"
        : "none",
    placementContext
  };
}

function logActivityIdentityHandoff({
  itemUuid = null,
  nativeActivityId = null,
  nativeActivityUuid = null,
  placementContextFound = false,
  placementContextActivityId = null,
  placementContextActivityUuid = null,
  selectedActivityId = null,
  selectedActivityUuid = null,
  selectionSource = "none",
  contextConsumed = false,
  regionDocument = null,
  regionShapeType = null
} = {}) {
  console.warn(`[${MODULE_ID}] PZ ACTIVITY IDENTITY HANDOFF`, {
    itemUuid,
    nativeActivityId,
    nativeActivityUuid,
    placementContextFound,
    placementContextActivityId,
    placementContextActivityUuid,
    selectedActivityId,
    selectedActivityUuid,
    selectionSource,
    contextConsumed,
    regionId: regionDocument?.id ?? null,
    regionShapeType
  });
}

function classifyV14SourceRegionShapeKind(regionDocument) {
  const shapes = summarizeRegionDocumentRawShapes(regionDocument);
  const types = Array.from(shapes ?? [])
    .map((shape) => String(shape?.type ?? "").toLowerCase())
    .filter(Boolean);
  if (types.some((type) => type === "ellipse" || type === "circle")) {
    return "ellipse";
  }
  if (types.some((type) => type === "rectangle")) {
    return "rectangle";
  }
  if (types.some((type) => type === "polygon")) {
    return "polygon";
  }
  if (types.some((type) => type === "line" || type === "ray")) {
    return "line";
  }
  return types[0] ?? "unknown";
}

function buildV14SourceCandidateSummary({
  templateDocument = null,
  sourceContext = {},
  normalizedDefinition = null,
  regionDocument = null,
  sourceShapeKind = "unknown"
} = {}) {
  const ringSummary = summarizeRingDefinition(normalizedDefinition);
  const zoneKind = classifyNormalizedDefinitionZoneKind(normalizedDefinition);
  const templateType = getTemplateType(templateDocument);
  const sourceShapeCompatible = isV14SourceShapeCompatibleWithTemplateType(sourceShapeKind, templateType);
  const expectedProfileType = zoneKind === "ring"
    ? "ring"
    : zoneKind === "simple"
      ? templateType || "simple"
      : zoneKind;
  return {
    templateId: templateDocument?.id ?? null,
    templateUuid: templateDocument?.uuid ?? null,
    v14SourceCandidateItemUuid: sourceContext.item?.uuid ?? null,
    itemUuid: sourceContext.item?.uuid ?? null,
    v14SourceCandidateItemName: sourceContext.item?.name ?? null,
    actorUuid: sourceContext.actor?.uuid ?? null,
    templateType,
    regionDocumentId: regionDocument?.id ?? null,
    v14SourceCandidateZoneKind: zoneKind,
    v14SourceCandidateShapeKind: sourceShapeKind,
    v14NativeSourceShapeType: sourceShapeKind,
    v14NativeExpectedProfileType: expectedProfileType,
    v14NativeSourceProfileMatched: sourceShapeCompatible,
    v14NativeSourceProfileMismatch: !sourceShapeCompatible,
    v14SourceCandidatePartCount: Array.from(normalizedDefinition?.parts ?? []).length,
    selectedVariantId: normalizedDefinition?.selectedVariantId ?? normalizedDefinition?.selectedVariant?.id ?? null,
    defaultVariantId: normalizedDefinition?.defaultVariantId ?? null,
    ringDefinitionResolved: ringSummary.hasRingDefinition,
    selectedGeometryType: ringSummary.selectedGeometryType,
    normalizedGeometryType: ringSummary.normalizedGeometryType,
    partGeometryTypes: ringSummary.partGeometryTypes,
    sourceShapeCompatible
  };
}

function classifyNormalizedDefinitionZoneKind(normalizedDefinition) {
  const partTypes = Array.from(normalizedDefinition?.parts ?? [])
    .map((part) => String(part?.geometry?.type ?? "template").toLowerCase());
  const geometryType = String(normalizedDefinition?.geometry?.type ?? "").toLowerCase();
  if (partTypes.includes("side-of-ring")) {
    return "composite-ring";
  }
  if (partTypes.includes("side-of-line")) {
    return "composite-line";
  }
  if (partTypes.includes("ring") || geometryType === "ring" || geometryType === "annulus") {
    return "ring";
  }
  if (partTypes.length > 1) {
    return "multipart";
  }
  return "simple";
}

function isV14SourceShapeCompatibleWithTemplateType(sourceShapeKind, templateType) {
  const sourceKind = String(sourceShapeKind ?? "").toLowerCase();
  const type = String(templateType ?? "").toLowerCase();
  if (sourceKind === "ellipse") {
    return type === "circle";
  }
  if (sourceKind === "line") {
    return type === "ray";
  }
  if (sourceKind === "rectangle") {
    return type === "rect";
  }
  if (sourceKind === "polygon") {
    return type === "cone" || type === "ray" || type === "rect" || type === "circle";
  }
  return true;
}

function normalizePlacementContextTemplateType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "square" || normalized === "rectangle") return "rect";
  if (normalized === "wall" || normalized === "line") return "ray";
  return normalized || null;
}

function classifyV14NativeRingCandidate(normalizedDefinition) {
  const parts = Array.from(normalizedDefinition?.parts ?? []);
  const ringParts = parts.filter((part) => {
    const geometryType = String(part?.geometry?.type ?? "").toLowerCase();
    return geometryType === "ring" || geometryType === "annulus";
  });
  return {
    isNativeRing: ringParts.length === 1 && parts.length === 1,
    ringPartCount: ringParts.length,
    partCount: parts.length
  };
}

function selectV14SourceCandidate(eligibleCandidates = [], {
  sourceHints = {},
  regionDocument = null,
  sourceShapeKind = "unknown"
} = {}) {
  if (!eligibleCandidates.length) {
    return null;
  }

  if (sourceHints.itemUuid) {
    const matches = eligibleCandidates.filter((candidate) => candidate.sourceContext?.item?.uuid === sourceHints.itemUuid);
    if (matches.length === 1) {
      logV14RegionDiagnostic("v14SourceResolutionFromRegionFlags", {
        regionDocumentId: regionDocument?.id ?? null,
        itemUuid: sourceHints.itemUuid,
        v14CastContextMatched: true
      });
      return matches[0];
    }
    if (matches.length > 1) {
      return null;
    }
  }

  const topScore = eligibleCandidates[0]?.score ?? null;
  const topCandidates = eligibleCandidates.filter((candidate) =>
    Math.abs((candidate.score ?? 0) - (topScore ?? 0)) < 1
  );
  if (topCandidates.length > 1) {
    logV14RegionDiagnostic("v14SourceResolutionAmbiguous", {
      regionDocumentId: regionDocument?.id ?? null,
      sourceShapeKind,
      topScore,
      candidates: topCandidates.map((candidate) => candidate.summary)
    });
    return null;
  }

  return eligibleCandidates[0] ?? null;
}

function buildV14SourceResolutionFailureReason(candidates = [], eligibleCandidates = []) {
  if (!candidates.length) {
    return "no-zone-template-candidate";
  }
  if (!eligibleCandidates.length && candidates.some((candidate) => candidate.multipartSkipped)) {
    return candidates.every((candidate) => candidate.multipartSkipped)
      ? "only-multipart-zone-template-candidates"
      : "no-compatible-zone-template-candidate";
  }
  if (!eligibleCandidates.length) {
    return "no-compatible-zone-template-candidate";
  }
  return "v14-source-resolution-ambiguous";
}

function estimateRegionCenter(regionDocument) {
  const shapes = summarizeRegionDocumentRawShapes(regionDocument);
  const circle = shapes.find((shape) => shape?.type === "circle" || shape?.type === "ellipse");
  if (circle) {
    return {
      x: coerceNumber(circle.x ?? circle.cx, 0),
      y: coerceNumber(circle.y ?? circle.cy, 0)
    };
  }

  const points = shapes
    .filter((shape) => Array.isArray(shape?.points))
    .flatMap((shape) => shape.points);
  if (points.length >= 2) {
    const xs = [];
    const ys = [];
    for (let index = 0; index < points.length - 1; index += 2) {
      xs.push(coerceNumber(points[index], 0));
      ys.push(coerceNumber(points[index + 1], 0));
    }
    return {
      x: xs.reduce((total, value) => total + value, 0) / Math.max(xs.length, 1),
      y: ys.reduce((total, value) => total + value, 0) / Math.max(ys.length, 1)
    };
  }

  return {
    x: coerceNumber(regionDocument?.x, 0),
    y: coerceNumber(regionDocument?.y, 0)
  };
}

function summarizeRegionDocumentRawShapes(regionDocument) {
  return (
    duplicateData(regionDocument?.toObject?.()?.shapes) ??
    duplicateData(regionDocument?.shapes?.contents?.map((shape) => shape.toObject?.() ?? shape)) ??
    []
  );
}

async function resolveRegionSourceContext(templateDocument, regionDocument) {
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const resolvedContext = await resolveTemplateSourceContext(templateDocument);
  const itemByRuntime = await resolveDocumentFromRuntimeUuid(runtime.itemUuid, "Item");
  const actorByRuntime = await resolveDocumentFromRuntimeUuid(runtime.actorUuid, "Actor");
  const casterByRuntime = await resolveDocumentFromRuntimeUuid(runtime.casterUuid, "Actor");
  const item = itemByRuntime ?? resolvedContext.item ?? null;
  const activity =
    resolvedContext.activity ??
    findPersistentZoneActivityOnItem(item, {
      activityId: runtime.activityId,
      activityUuid: runtime.activityUuid,
      fallbackToSinglePersistentZoneActivity: false
    });

  return {
    item,
    actor: actorByRuntime ?? resolvedContext.actor ?? item?.actor ?? null,
    caster: casterByRuntime ?? resolvedContext.caster ?? actorByRuntime ?? item?.actor ?? null,
    activity: activity ?? null
  };
}

async function buildManagedRegionGroupPlan({
  templateDocument,
  normalizedDefinition,
  sourceContext,
  existingRegions = [],
  sourceRegionDocument = null,
  sourceRegionShapes = null,
  adoptedV14Source = false,
  sharedOwnerEffectUuid = null
}) {
  const groupId = buildManagedRegionGroupId(templateDocument, existingRegions);
  const sourceParts = Array.isArray(normalizedDefinition?.parts) && normalizedDefinition.parts.length
    ? normalizedDefinition.parts
    : [{
      id: "primary",
      label: normalizedDefinition?.label ?? "primary",
      geometry: duplicateData(normalizedDefinition?.geometry ?? { type: "template" }),
      targeting: duplicateData(normalizedDefinition?.targeting ?? {}),
      terrain: duplicateData(normalizedDefinition?.terrain ?? {}),
      linkedWalls: duplicateData(normalizedDefinition?.linkedWalls ?? {}),
      linkedLight: duplicateData(normalizedDefinition?.linkedLight ?? {}),
      triggers: duplicateData(normalizedDefinition?.triggers ?? {})
    }];
  const ringDefinitionSummary = summarizeRingDefinition({
    ...normalizedDefinition,
    parts: sourceParts
  });
  if (ringDefinitionSummary.hasRingDefinition) {
    logV14RegionDiagnostic("ringCreationEntry", {
      entryPoint: "buildManagedRegionGroupPlan",
      templateId: templateDocument?.id ?? null,
      regionGroupId: groupId,
      selectedBaseType: getTemplateType(templateDocument),
      selectedGeometryType: ringDefinitionSummary.selectedGeometryType,
      normalizedGeometryType: ringDefinitionSummary.normalizedGeometryType,
      partGeometryTypes: ringDefinitionSummary.partGeometryTypes,
      partCountExpected: sourceParts.length
    });
  }

  if (sourceParts.length > 1) {
    logV14RegionDiagnostic("enteredV14CompositePath", {
      templateId: templateDocument?.id ?? null,
      regionGroupId: groupId,
      partCountExpected: sourceParts.length,
      partDefinitionsResolved: sourceParts.map((part, index) => ({
        index: index + 1,
        id: part?.id ?? null,
        label: part?.label ?? null,
        geometry: duplicateData(part?.geometry ?? null),
        hasTriggers: Boolean(part?.triggers),
        hasLinkedWalls: Boolean(part?.linkedWalls?.enabled),
        hasLinkedLight: Boolean(part?.linkedLight?.enabled)
      })),
      v14CompositeCompatibilityPath: "resolved-multipart-region-group"
    });
  }

  const preparedParts = [];
  const resolvedShapesByPartId = new Map();

  for (const [index, zonePart] of sourceParts.entries()) {
    const geometryType = String(zonePart?.geometry?.type ?? "template").toLowerCase();
    const referencePartId = String(zonePart?.geometry?.referencePartId ?? "").trim() || null;
    const referenceShapes = referencePartId
      ? resolvedShapesByPartId.get(referencePartId) ?? null
      : null;
    const shapes = geometryType === "template" && sourceRegionDocument
      ? duplicateData(sourceRegionShapes ?? summarizeRegionDocumentRawShapes(sourceRegionDocument))
      : await buildRegionShapesForZonePart(templateDocument, zonePart, {
        allParts: sourceParts,
        referenceShapes
      });
    if (!Array.isArray(shapes) || !shapes.length) {
      if (String(zonePart?.geometry?.type ?? "").toLowerCase().includes("ring")) {
        logV14RegionDiagnostic("ringCreationSkipped", {
          entryPoint: "buildManagedRegionGroupPlan",
          templateId: templateDocument?.id ?? null,
          regionGroupId: groupId,
          partId: zonePart?.id ?? `part-${index + 1}`,
          selectedBaseType: getTemplateType(templateDocument),
          selectedGeometryType: zonePart?.geometry?.type ?? null,
          normalizedGeometryType: normalizedDefinition?.geometry?.type ?? null,
          ringCreationSkipped: true,
          ringCreationSkipReason: "no-supported-ring-shapes"
        });
      }
      debug("Skipped managed Region part because no supported Region shape could be produced.", {
        templateId: templateDocument?.id ?? null,
        regionGroupId: groupId,
        partId: zonePart?.id ?? `part-${index + 1}`,
        geometryType: zonePart?.geometry?.type ?? "template"
      });
      continue;
    }

    if (zonePart?.id) {
      resolvedShapesByPartId.set(zonePart.id, duplicateData(shapes));
    }

    const isV14FirstSimpleRing = isFoundryV14OrNewer() &&
      sourceParts.length === 1 &&
      geometryType === "ring";
    const runtimeGeometry = buildRuntimeGeometryForZonePart(templateDocument, zonePart, shapes);
    const basePreparedPart = {
      zonePart,
      runtimeGeometry,
      architecturePath: isV14FirstSimpleRing
        ? REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE
        : adoptedV14Source
          ? REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE
          : REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
      existingRuntime: resolveExistingRuntimeForPart(existingRegions, zonePart?.id ?? null),
      geometrySide: zonePart?.geometry?.side ?? null,
      geometryReferencePartId: zonePart?.geometry?.referencePartId ?? null,
      geometryReferenceRadiusMode: zonePart?.geometry?.referenceRadiusMode ?? null,
      geometryTemplateRadius: zonePart?.geometry?.templateRadius ?? null,
      geometryOffsetReference: zonePart?.geometry?.offsetReference ?? null,
      geometryOffsetStart: zonePart?.geometry?.offsetStart ?? null,
      geometryOffsetEnd: zonePart?.geometry?.offsetEnd ?? null,
      geometryThickness: zonePart?.geometry?.wallThickness ?? zonePart?.geometry?.thickness ?? null,
      geometryComputedInnerRadius: zonePart?.geometry?.innerRadius ?? null,
      geometryComputedOuterRadius: zonePart?.geometry?.outerRadius ?? null
    };

    if (
      isV14FirstSimpleRing &&
      shapes.length > 1
    ) {
      logV14RegionDiagnostic("regionSourceStrategy", {
        entryPoint: "buildManagedRegionGroupPlan",
        templateId: templateDocument?.id ?? null,
        regionGroupId: groupId,
        partId: zonePart?.id ?? `part-${index + 1}`,
        regionSourceStrategy: "v14-region-native-segment-group",
        ringSegmentCount: shapes.length,
        selectedCompatibilityPath: "v14-region-first-ring-segments"
      });
      logV14RegionDiagnostic("v14RingPathSelected", {
        entryPoint: "buildManagedRegionGroupPlan",
        templateId: templateDocument?.id ?? null,
        regionGroupId: groupId,
        partId: zonePart?.id ?? `part-${index + 1}`,
        selectedArchitecturePath: REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE,
        regionSourceStrategy: "v14-region-native-segment-group",
        ringSegmentCount: shapes.length
      });
      logV14RegionDiagnostic("v14RingStrategy", {
        entryPoint: "buildManagedRegionGroupPlan",
        templateId: templateDocument?.id ?? null,
        regionGroupId: groupId,
        partId: zonePart?.id ?? `part-${index + 1}`,
        v14RingStrategy: "native-region-segment-group",
        ringGeometryStrategy: "multi-polygon-segments",
        ringSegmentCount: shapes.length,
        ringSegmentShapeSummary: summarizeFoundryRegionShapes(buildFoundryRegionShapes(shapes))
      });
      for (const [segmentIndex, segmentShape] of shapes.entries()) {
        preparedParts.push({
          ...basePreparedPart,
          shapes: [segmentShape],
          regionSourceStrategy: "v14-region-native-segment-group",
          regionSegmentIndex: segmentIndex + 1,
          regionSegmentCount: shapes.length
        });
      }
      continue;
    }

    preparedParts.push({
      ...basePreparedPart,
      shapes,
      regionSourceStrategy: isFoundryV14OrNewer()
        ? "v14-region-native-part"
        : "legacy-template-compatible"
    });
  }

  const partCount = preparedParts.length;
  const parts = preparedParts.map((preparedPart, index) => {
    const runtimeDefinition = buildPartRuntimeDefinition(normalizedDefinition, preparedPart.zonePart, {
      groupId,
      partIndex: index,
      partCount
    });

    return {
      partId: preparedPart.zonePart.id ?? `part-${index + 1}`,
      partIndex: index,
      geometryType: preparedPart.zonePart?.geometry?.type ?? "template",
      geometrySide: preparedPart.geometrySide ?? null,
      geometryReferencePartId: preparedPart.geometryReferencePartId ?? null,
      geometryReferenceRadiusMode: preparedPart.geometryReferenceRadiusMode ?? null,
      geometryTemplateRadius: preparedPart.geometryTemplateRadius ?? null,
      geometryOffsetReference: preparedPart.geometryOffsetReference ?? null,
      geometryOffsetStart: preparedPart.geometryOffsetStart ?? null,
      geometryOffsetEnd: preparedPart.geometryOffsetEnd ?? null,
      geometryThickness: preparedPart.geometryThickness ?? null,
      geometryComputedInnerRadius: preparedPart.geometryComputedInnerRadius ?? null,
      geometryComputedOuterRadius: preparedPart.geometryComputedOuterRadius ?? null,
      regionSourceStrategy: preparedPart.regionSourceStrategy ?? null,
      regionSegmentIndex: preparedPart.regionSegmentIndex ?? null,
        regionSegmentCount: preparedPart.regionSegmentCount ?? null,
        architecturePath: preparedPart.architecturePath ?? REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
        runtimeGeometry: duplicateData(preparedPart.runtimeGeometry),
      runtimeDefinition,
      shapes: preparedPart.shapes,
      regionData: buildRegionCreateData({
        templateDocument,
        normalizedDefinition: runtimeDefinition,
        sourceContext,
        shapes: preparedPart.shapes,
        existingRuntime: preparedPart.existingRuntime,
        groupId,
        partId: preparedPart.zonePart.id ?? `part-${index + 1}`,
        partIndex: index,
        partCount,
        geometryType: preparedPart.zonePart?.geometry?.type ?? "template",
        runtimeGeometry: preparedPart.runtimeGeometry,
        regionSourceStrategy: preparedPart.regionSourceStrategy ?? null,
        regionSegmentIndex: preparedPart.regionSegmentIndex ?? null,
        regionSegmentCount: preparedPart.regionSegmentCount ?? null,
        architecturePath: preparedPart.architecturePath ?? REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
        sharedOwnerEffectUuid
      })
    };
  });

  logV14RegionDiagnostic("regionGroupPlanBuilt", {
    templateId: templateDocument?.id ?? null,
    regionGroupId: groupId,
    partCountExpected: sourceParts.length,
    partCountExpectedFromDefinition: sourceParts.length,
    partCountPrepared: preparedParts.length,
    partCountCreatedPlan: parts.length,
    partDefinitionsResolved: sourceParts.map((part, index) => ({
      index: index + 1,
      id: part?.id ?? null,
      label: part?.label ?? null,
      geometry: duplicateData(part?.geometry ?? null),
      hasTriggers: Boolean(part?.triggers),
      hasLinkedWalls: Boolean(part?.linkedWalls?.enabled),
      hasLinkedLight: Boolean(part?.linkedLight?.enabled)
    })),
    sourceParts: sourceParts.map((part, index) => ({
      index: index + 1,
      id: part?.id ?? null,
      label: part?.label ?? null,
      geometryType: part?.geometry?.type ?? null,
      side: part?.geometry?.side ?? null,
      referencePartId: part?.geometry?.referencePartId ?? null
    })),
    preparedParts: parts.map((part) => ({
      partId: part.partId,
      geometryType: part.geometryType,
      regionSourceStrategy: part.regionSourceStrategy ?? null,
      regionSegmentIndex: part.regionSegmentIndex ?? null,
      regionSegmentCount: part.regionSegmentCount ?? null,
      shapeSummary: summarizeFoundryRegionShapes(part.regionData?.shapes ?? [])
    }))
  });

  return {
    groupId,
    availableVariantIds: Array.isArray(normalizedDefinition?.variants)
      ? normalizedDefinition.variants.map((variant) => variant.id)
      : [],
    selectedVariantId: normalizedDefinition?.selectedVariant?.id ?? null,
    defaultVariantId: normalizedDefinition?.defaultVariantId ?? null,
    variantResolutionMode: normalizedDefinition?.variantResolution?.resolutionMode ?? "none",
    parts
  };
}

function buildManagedRegionGroupId(templateDocument, existingRegions = []) {
  const existingGroupId = existingRegions
    .map((regionDocument) => getRegionRuntimeFlags(regionDocument)?.groupId ?? null)
    .find(Boolean);

  if (existingGroupId) {
    return existingGroupId;
  }

  return [
    MODULE_ID,
    templateDocument?.uuid ?? templateDocument?.id ?? "template",
    "group"
  ].join(":");
}

function buildPartRuntimeDefinition(normalizedDefinition, zonePart, {
  groupId,
  partIndex,
  partCount
}) {
  const targetingGlobal = duplicateData(
    zonePart?.targetingGlobal ?? normalizedDefinition?.targeting ?? {}
  );
  const targetingPart = duplicateData(zonePart?.targetingPart ?? null);
  const targetingEffective = duplicateData(
    zonePart?.targetingEffective ?? zonePart?.targeting ?? normalizedDefinition?.targeting ?? {}
  );

  return {
    ...duplicateData(normalizedDefinition),
    label: zonePart?.label ?? normalizedDefinition?.label ?? "Persistent Zone",
    geometry: duplicateData(zonePart?.geometry ?? { type: "template" }),
    elevation: duplicateData(zonePart?.elevationInherited === false
      ? zonePart?.elevation ?? null
      : normalizedDefinition?.elevation ?? null),
    elevationOverrideUnlimited: zonePart?.elevationInherited === false && !zonePart?.elevation,
    interaction: duplicateData(zonePart?.interaction ?? normalizedDefinition?.interaction ?? { mode: "area" }),
    targeting: duplicateData(targetingEffective),
    targetingGlobal,
    targetingPart,
    targetingEffective: duplicateData(targetingEffective),
    terrain: duplicateData(zonePart?.terrain ?? normalizedDefinition?.terrain ?? {}),
    linkedWalls: duplicateData(zonePart?.linkedWalls ?? normalizedDefinition?.linkedWalls ?? {}),
    linkedLight: duplicateData(zonePart?.linkedLight ?? normalizedDefinition?.linkedLight ?? {}),
    triggers: duplicateData(zonePart?.triggers ?? normalizedDefinition?.triggers ?? {}),
    parts: [duplicateData(zonePart)],
    group: {
      id: groupId,
      mode: partCount > 1 ? "parts" : "single",
      partCount,
      partIndex: partIndex + 1
    },
    part: {
      id: zonePart?.id ?? `part-${partIndex + 1}`,
      label: zonePart?.label ?? normalizedDefinition?.label ?? "Persistent Zone",
      geometryType: zonePart?.geometry?.type ?? "template",
      targetFilterMode: zonePart?.targetingInherited ? "inherit" : "part"
    }
  };
}

function resolveExistingRuntimeForPart(existingRegions, partId) {
  if (!Array.isArray(existingRegions) || !existingRegions.length) {
    return null;
  }

  if (partId) {
    const matchingRuntime = existingRegions
      .map((regionDocument) => getRegionRuntimeFlags(regionDocument))
      .find((runtime) => runtime?.partId === partId);

    if (matchingRuntime) {
      return matchingRuntime;
    }
  }

  return getRegionRuntimeFlags(existingRegions[0]) ?? null;
}

async function buildRegionShapesForZonePart(templateDocument, zonePart, {
  allParts = [],
  referenceShapes = null
} = {}) {
  const geometryType = String(zonePart?.geometry?.type ?? "template").toLowerCase();

  if (geometryType === "ring" || geometryType === "side-of-ring") {
    logV14RegionDiagnostic("enteredV14RingPath", {
      templateId: templateDocument?.id ?? null,
      partId: zonePart?.id ?? null,
      partLabel: zonePart?.label ?? null,
      geometryType,
      geometry: duplicateData(zonePart?.geometry ?? null),
      v14RingCompatibilityPath: isFoundryV14OrNewer()
        ? "native-ring-shape-builder"
        : "legacy-polygon-annulus-builder"
    });
  }

  switch (geometryType) {
    case "side-of-ring":
      return buildSideOfRingShapesFromGeometry(templateDocument, zonePart?.geometry ?? {}, {
        allParts,
        referenceShapes
      });
    case "side-of-line":
      return await buildSideOfLineShapesFromGeometry(templateDocument, zonePart?.geometry ?? {}, {
        referenceShapes
      });
    case "ring":
      if (isFoundryV14OrNewer()) {
        return buildNativeRingShapeFromGeometry(templateDocument, zonePart?.geometry ?? {});
      }
      return buildRingShapesFromGeometry(templateDocument, zonePart?.geometry ?? {});
    case "template":
    default:
      return buildRegionShapesFromTemplate(templateDocument);
  }
}

function buildNativeRingShapeFromGeometry(templateDocument, geometry) {
  const resolvedRadii = resolveRingBandRadiiForTemplate(templateDocument, geometry);
  const runtimeGeometry = buildRingRuntimeGeometry(templateDocument, {
    ...resolvedRadii,
    segments: geometry?.segments,
    sourceType: "ring",
    resolutionMode: resolvedRadii.resolutionMode
  });
  const outerRadiusPixels = coerceNumber(runtimeGeometry?.outerRadiusPixels, 0);
  const thicknessResolution = resolveNativeRingThicknessPixels({
    geometry,
    sourceRadiusPixels: outerRadiusPixels,
    scene: templateDocument?.parent ?? null
  });
  const { radius, innerWidth, outerWidth } = resolveV14NativeRingWidths({
    geometry,
    sourceRadiusPixels: outerRadiusPixels,
    thicknessPixels: thicknessResolution.thicknessPixels,
    scene: templateDocument?.parent ?? null
  });
  const ringShape = serializeNativeRingShape({
    x: coerceNumber(templateDocument?.x, 0),
    y: coerceNumber(templateDocument?.y, 0),
    radius,
    innerWidth,
    outerWidth,
    hole: false,
    gridBased: false
  });
  const validation = validateV14NativeRingShapes([ringShape]);

  if (!validation.valid) {
    logV14RegionDiagnostic("ringCreationSkipped", {
      entryPoint: "buildRegionShapesForZonePart",
      templateId: templateDocument?.id ?? null,
      geometryType: "ring",
      ringCreationSkipped: true,
      ringCreationSkipReason: validation.reason,
      v14NativeRingInvalidField: validation.invalidField ?? null,
      v14NativeRingInvalidValue: validation.invalidValue ?? null,
      v14NativeRingInvalidValueType: validation.invalidValueType ?? null,
      ringGeometry: duplicateData(runtimeGeometry ?? null),
      ringThicknessResolution: duplicateData(thicknessResolution ?? null),
      ringSerializedShape: summarizeFoundryRegionShapes([ringShape])
    });
    return [];
  }

  logV14RegionDiagnostic("ringSerializedShape", {
    entryPoint: "buildRegionShapesForZonePart",
    templateId: templateDocument?.id ?? null,
    templateType: getTemplateType(templateDocument),
    geometryType: "ring",
    ringGeometryStrategy: "native-ring-shape",
    v14NativeShapeMapping: "native-ring-shape",
    ringGeometryDetected: true,
    ringFinalRadius: radius,
    ringFinalInnerWidth: innerWidth,
    ringFinalOuterWidth: outerWidth,
    ringThicknessResolution: duplicateData(thicknessResolution ?? null),
    ringOuterRadius: outerRadiusPixels,
    ringSerializedShape: summarizeFoundryRegionShapes([ringShape]),
    ringSerializedShapeJson: stringifyShapeSummary(summarizeFoundryRegionShapes([ringShape]))
  });

  return [ringShape];
}

function buildNativeRingRuntimeGeometryFromShape(shape) {
  if (String(shape?.type ?? "").toLowerCase() !== "ring") {
    return null;
  }

  const radiusPixels = coerceNumber(shape.radius, null);
  if (radiusPixels === null || radiusPixels <= 0) {
    return null;
  }

  const innerWidthPixels = Math.max(0, coerceNumber(shape.innerWidth, 0));
  const outerWidthPixels = Math.max(0, coerceNumber(shape.outerWidth, 0));
  return {
    type: "ring",
    centerX: coerceNumber(shape.x, 0),
    centerY: coerceNumber(shape.y, 0),
    radiusPixels,
    innerWidthPixels,
    outerWidthPixels,
    innerRadiusPixels: Math.max(0, radiusPixels - innerWidthPixels),
    outerRadiusPixels: radiusPixels + outerWidthPixels,
    geometrySource: "final-native-region-shape"
  };
}

function buildRingShapesFromGeometry(templateDocument, geometry) {
  const resolvedRadii = resolveRingBandRadiiForTemplate(templateDocument, geometry);
  return buildRingBandShapesFromRadii(templateDocument, {
    innerRadius: resolvedRadii.innerRadius,
    outerRadius: resolvedRadii.outerRadius,
    segments: geometry?.segments
  }, {
    builder: resolvedRadii.resolutionMode === "template-outer-edge"
      ? "ring-template-outer-edge"
      : resolvedRadii.resolutionMode === "legacy-reference-radius-mode"
        ? "ring-legacy-reference-radius-mode"
        : resolvedRadii.resolutionMode === "outer-radius-thickness"
          ? "ring-outer-radius-thickness"
          : resolvedRadii.resolutionMode === "inner-radius-ratio"
            ? "ring-inner-radius-ratio"
          : "ring-annulus",
    rejectionMessage: "Rejected Region shape build for unsupported ring geometry.",
    detailOverrides: {
      geometryType: "ring",
      referenceRadiusMode: geometry?.referenceRadiusMode ?? null,
      templateRadius: resolvedRadii.templateRadius,
      wallThickness: geometry?.wallThickness ?? geometry?.thickness ?? null,
      innerRadiusRatio: geometry?.innerRadiusRatio ?? null,
      computedInnerRadius: resolvedRadii.innerRadius,
      computedOuterRadius: resolvedRadii.outerRadius,
      radiusResolutionMode: resolvedRadii.resolutionMode
    }
  });
}

function resolveRingBandRadiiForTemplate(templateDocument, geometry = {}) {
  const templateRadius = coerceNumber(
    geometry?.templateRadius ?? geometry?.referenceRadius ?? templateDocument?.distance,
    null
  );
  const explicitOuterRadius = coerceNumber(
    geometry?.outerRadius ?? geometry?.outer ?? geometry?.radius,
    null
  );
  const explicitInnerRadius = coerceNumber(
    geometry?.innerRadius ?? geometry?.inner ?? geometry?.holeRadius,
    null
  );
  const outerRadiusRatio = coerceNumber(geometry?.outerRadiusRatio ?? geometry?.outerRatio, null);
  const innerRadiusRatio = coerceNumber(geometry?.innerRadiusRatio ?? geometry?.innerRatio, null);
  const thickness = coerceNumber(geometry?.wallThickness ?? geometry?.thickness ?? geometry?.bandThickness, null);
  const outerRadius = explicitOuterRadius ??
    (outerRadiusRatio !== null && templateRadius !== null ? templateRadius * outerRadiusRatio : null) ??
    templateRadius ??
    coerceNumber(templateDocument?.distance, 0);

  if (thickness !== null && thickness > 0 && outerRadius > 0) {
    return {
      innerRadius: Math.max(0, outerRadius - thickness),
      outerRadius,
      templateRadius,
      resolutionMode: geometry?.radiusResolutionMode ?? "template-outer-edge"
    };
  }

  if (innerRadiusRatio !== null && outerRadius > 0) {
    return {
      innerRadius: Math.max(0, outerRadius * innerRadiusRatio),
      outerRadius,
      templateRadius,
      resolutionMode: "inner-radius-ratio"
    };
  }

  return {
    innerRadius: Math.max(0, explicitInnerRadius ?? 0),
    outerRadius,
    templateRadius,
    resolutionMode: geometry?.radiusResolutionMode ?? "explicit-radii"
  };
}

function buildRuntimeGeometryForZonePart(templateDocument, zonePart, shapes = []) {
  const geometry = zonePart?.geometry ?? {};
  const geometryType = String(geometry?.type ?? "template").toLowerCase();
  if (geometryType === "ring") {
    const resolvedRadii = resolveRingBandRadiiForTemplate(templateDocument, geometry);
    return buildRingRuntimeGeometry(templateDocument, {
      ...resolvedRadii,
      segments: geometry?.segments,
      sourceType: "ring",
      resolutionMode: resolvedRadii.resolutionMode
    });
  }

  if (geometryType === "side-of-ring") {
    return buildRingRuntimeGeometryFromShapes(templateDocument, shapes, {
      sourceType: "side-of-ring",
      segments: geometry?.segments
    });
  }

  return null;
}

function buildRingRuntimeGeometry(templateDocument, {
  innerRadius,
  outerRadius,
  templateRadius = null,
  segments = null,
  sourceType = "ring",
  resolutionMode = null
} = {}) {
  const outerRadiusPixels = distanceToPixels(
    coerceNumber(outerRadius, 0),
    templateDocument?.parent ?? null
  );
  const innerRadiusPixels = distanceToPixels(
    coerceNumber(innerRadius, 0),
    templateDocument?.parent ?? null
  );
  if (!outerRadiusPixels || outerRadiusPixels <= 0 || innerRadiusPixels < 0 || innerRadiusPixels >= outerRadiusPixels) {
    return null;
  }

  return {
    type: sourceType,
    centerX: coerceNumber(templateDocument?.x, 0),
    centerY: coerceNumber(templateDocument?.y, 0),
    innerRadius: coerceNumber(innerRadius, 0),
    outerRadius: coerceNumber(outerRadius, 0),
    templateRadius,
    innerRadiusPixels,
    outerRadiusPixels,
    segmentCount: Math.min(Math.max(Math.round(coerceNumber(segments, DEFAULT_RING_SEGMENTS)), 8), 64),
    radiusResolutionMode: resolutionMode
  };
}

function buildRingRuntimeGeometryFromShapes(templateDocument, shapes = [], {
  sourceType = "side-of-ring",
  segments = null
} = {}) {
  const points = Array.from(shapes ?? [])
    .filter((shape) => shape?.type === "polygon")
    .flatMap((shape) => Array.from(shape?.points ?? []));
  if (points.length < 8) {
    return null;
  }

  const xCoordinates = points.filter((_, index) => index % 2 === 0).map((value) => coerceNumber(value, 0));
  const yCoordinates = points.filter((_, index) => index % 2 === 1).map((value) => coerceNumber(value, 0));
  const centerX = (Math.min(...xCoordinates) + Math.max(...xCoordinates)) / 2;
  const centerY = (Math.min(...yCoordinates) + Math.max(...yCoordinates)) / 2;
  const radii = [];
  for (let index = 0; index < points.length; index += 2) {
    const pointX = coerceNumber(points[index], null);
    const pointY = coerceNumber(points[index + 1], null);
    if (pointX === null || pointY === null) {
      continue;
    }
    radii.push(Math.hypot(pointX - centerX, pointY - centerY));
  }

  if (!radii.length) {
    return null;
  }

  const innerRadiusPixels = Math.min(...radii);
  const outerRadiusPixels = Math.max(...radii);
  if (!outerRadiusPixels || outerRadiusPixels <= 0 || innerRadiusPixels < 0 || innerRadiusPixels >= outerRadiusPixels) {
    return null;
  }

  return {
    type: sourceType,
    centerX,
    centerY,
    innerRadius: null,
    outerRadius: null,
    templateRadius: coerceNumber(templateDocument?.distance, null),
    innerRadiusPixels,
    outerRadiusPixels,
    segmentCount: Math.min(Math.max(Math.round(coerceNumber(segments, shapes.length || DEFAULT_RING_SEGMENTS)), 8), 64),
    radiusResolutionMode: "shape-derived"
  };
}

function buildSideOfRingShapesFromGeometry(templateDocument, geometry, {
  allParts = [],
  referenceShapes = null
} = {}) {
  const side = String(geometry?.side ?? "outer").toLowerCase() === "inner" ? "inner" : "outer";
  const offsetReference = String(geometry?.offsetReference ?? "body-edge").toLowerCase();
  const offsetStart = Math.max(0, coerceNumber(geometry?.offsetStart, 0));
  const offsetEnd = coerceNumber(geometry?.offsetEnd, 0);
  const referenceRing = resolveSideOfRingReferenceBand(templateDocument, geometry, allParts, referenceShapes);

  if (!referenceRing || offsetReference !== "body-edge" || offsetEnd <= offsetStart) {
    debug("Rejected Region shape build for unsupported side-of-ring geometry.", {
      templateId: templateDocument?.id ?? null,
      templateType: getTemplateType(templateDocument),
      builder: "side-of-ring-body-edge",
      details: {
        side,
        offsetReference,
        offsetStart,
        offsetEnd,
        referencePartId: geometry?.referencePartId ?? null,
        referenceRingResolved: Boolean(referenceRing)
      }
    });
    return [];
  }

  const usesPixelRadii = referenceRing.radiusUnit === "pixels";
  const offsetStartResolved = usesPixelRadii
    ? distanceToPixels(offsetStart, templateDocument?.parent ?? null)
    : offsetStart;
  const offsetEndResolved = usesPixelRadii
    ? distanceToPixels(offsetEnd, templateDocument?.parent ?? null)
    : offsetEnd;
  const bodyEdge = side === "inner"
    ? coerceNumber(referenceRing.innerRadius, 0)
    : coerceNumber(referenceRing.outerRadius, 0);
  const bandInnerRadius = side === "inner"
    ? Math.max(0, bodyEdge - offsetEndResolved)
    : bodyEdge + offsetStartResolved;
  const bandOuterRadius = side === "inner"
    ? Math.max(0, bodyEdge - offsetStartResolved)
    : bodyEdge + offsetEndResolved;

  if (isFoundryV14OrNewer() && usesPixelRadii) {
    const nativeRingShape = serializeNativeRingShape({
      type: "ring",
      x: referenceRing.centerX,
      y: referenceRing.centerY,
      radius: bandOuterRadius,
      innerWidth: bandOuterRadius - bandInnerRadius,
      outerWidth: 0,
      hole: false,
      gridBased: false
    });
    const validation = validateV14NativeRingShapes([nativeRingShape]);
    if (validation.valid) {
      logV14RegionDiagnostic("ringSerializedShape", {
        entryPoint: "buildSideOfRingShapesFromGeometry",
        templateId: templateDocument?.id ?? null,
        geometryType: "side-of-ring",
        ringGeometryStrategy: "native-ring-shape",
        side,
        offsetReference,
        offsetStart,
        offsetEnd,
        referencePartId: geometry?.referencePartId ?? null,
        referenceShapeType: "ring",
        resolvedInnerRadius: referenceRing.innerRadius,
        resolvedOuterRadius: referenceRing.outerRadius,
        heatedInnerRadius: bandInnerRadius,
        heatedOuterRadius: bandOuterRadius,
        ringSerializedShape: summarizeFoundryRegionShapes([nativeRingShape])
      });
      return [nativeRingShape];
    }
  }

  return buildRingBandShapesFromRadii(templateDocument, {
    innerRadius: bandInnerRadius,
    outerRadius: bandOuterRadius,
    segments: geometry?.segments ?? referenceRing.segments ?? DEFAULT_RING_SEGMENTS
  }, {
    builder: "side-of-ring-body-edge",
    rejectionMessage: "Rejected Region shape build for unsupported side-of-ring geometry.",
    detailOverrides: {
      side,
      offsetReference,
      offsetStart,
      offsetEnd,
      heatBandStart: offsetStart,
      heatBandEnd: offsetEnd,
      bodyEdge,
      referencePartId: geometry?.referencePartId ?? null,
      referenceRadiusMode: referenceRing.referenceRadiusMode ?? null,
      templateRadius: referenceRing.templateRadius ?? coerceNumber(templateDocument?.distance, null),
      wallThickness: referenceRing.wallThickness ?? referenceRing.thickness ?? null,
      computedInnerRadius: referenceRing.innerRadius ?? null,
      computedOuterRadius: referenceRing.outerRadius ?? null,
      generatedBandBounds: {
        innerRadius: bandInnerRadius,
        outerRadius: bandOuterRadius
      }
    },
    centerX: referenceRing.centerX,
    centerY: referenceRing.centerY,
    radiiInPixels: usesPixelRadii
  });
}

async function buildSideOfLineShapesFromGeometry(templateDocument, geometry, {
  referenceShapes = null
} = {}) {
  const templateType = getTemplateType(templateDocument);
  const referenceAxis = resolveSideOfLineReferenceAxis(referenceShapes);
  const direction = referenceAxis?.direction ?? coerceNumber(templateDocument?.direction, 0);
  const axisLength = referenceAxis?.axisLength ?? distanceToPixels(
    geometry?.axisLength ?? templateDocument?.distance ?? 0,
    templateDocument?.parent ?? null
  );
  const offsetStart = distanceToPixels(
    geometry?.offsetStart ?? 0,
    templateDocument?.parent ?? null
  );
  const offsetEnd = distanceToPixels(
    geometry?.offsetEnd ?? geometry?.sideDistance ?? 0,
    templateDocument?.parent ?? null
  );
  const startX = referenceAxis?.startX ?? coerceNumber(templateDocument?.x, 0);
  const startY = referenceAxis?.startY ?? coerceNumber(templateDocument?.y, 0);
  const radians = degreesToRadians(direction);
  const unitX = Math.cos(radians);
  const unitY = Math.sin(radians);
  const side = String(geometry?.side ?? "left").toLowerCase() === "right" ? "right" : "left";
  const offsetReference = String(geometry?.offsetReference ?? "axis").toLowerCase() === "body-edge"
    ? "body-edge"
    : "axis";
  const sideMultiplier = side === "right" ? -1 : 1;
  const normalX = unitY * sideMultiplier;
  const normalY = -unitX * sideMultiplier;
  const endX = startX + unitX * axisLength;
  const endY = startY + unitY * axisLength;
  const bodyEdge = offsetReference === "body-edge"
    ? referenceAxis?.bodyHalfWidth ?? await measureTemplateBodyEdgeDistance(templateDocument, {
        originX: startX,
        originY: startY,
        normalX,
        normalY
      })
    : 0;
  const bandStart = bodyEdge + offsetStart;
  const bandEnd = bodyEdge + offsetEnd;
  const startOffsetX = normalX * bandStart;
  const startOffsetY = normalY * bandStart;
  const endOffsetX = normalX * bandEnd;
  const endOffsetY = normalY * bandEnd;

  if ((!referenceAxis && !["ray", "rect"].includes(templateType)) || axisLength <= 0 || offsetStart < 0 || offsetEnd <= offsetStart) {
    debug("Rejected Region shape build for unsupported side-of-line geometry.", {
      templateId: templateDocument?.id ?? null,
      templateType,
      builder: "side-of-line-template-axis",
      details: {
        direction,
        side,
        offsetReference,
        bodyEdge,
        axisLength,
        offsetStart,
        offsetEnd,
        bandStart,
        bandEnd,
        referenceGeometryResolved: Boolean(referenceAxis)
      }
    });
    return [];
  }

  const finalShape = {
    type: "polygon",
    points: [
      startX + startOffsetX,
      startY + startOffsetY,
      endX + startOffsetX,
      endY + startOffsetY,
      endX + endOffsetX,
      endY + endOffsetY,
      startX + endOffsetX,
      startY + endOffsetY
    ]
  };

  debug("Using Region shape builder.", {
    templateId: templateDocument?.id ?? null,
    templateType,
    builder: "side-of-line-template-axis",
    details: {
      startX,
      startY,
      endX,
      endY,
      direction,
      side,
      offsetReference,
      bodyEdge,
      axisLength,
      offsetStart,
      offsetEnd,
      generatedBandBounds: {
        bandStart,
        bandEnd
      },
      axisMode: geometry?.axisMode ?? "template",
      referenceGeometryResolved: Boolean(referenceAxis)
    }
  });

  return [finalShape];
}

function resolveSideOfLineReferenceAxis(referenceShapes) {
  const lineShape = Array.from(referenceShapes ?? []).find((shape) => {
    return String(shape?.type ?? "").toLowerCase() === "line";
  });
  if (!lineShape) return null;

  const startX = coerceNumber(lineShape.x, null);
  const startY = coerceNumber(lineShape.y, null);
  const axisLength = coerceNumber(lineShape.length, 0);
  const bodyWidth = Math.max(0, coerceNumber(lineShape.width, 0));
  if (startX === null || startY === null || axisLength <= 0) return null;

  return {
    startX,
    startY,
    axisLength,
    direction: coerceNumber(lineShape.rotation, 0),
    bodyHalfWidth: bodyWidth / 2,
    gridBased: Boolean(lineShape.gridBased)
  };
}

async function measureTemplateBodyEdgeDistance(templateDocument, {
  originX,
  originY,
  normalX,
  normalY
}) {
  const bodyShapes = await buildRegionShapesFromTemplate(templateDocument);
  if (!Array.isArray(bodyShapes) || !bodyShapes.length) {
    return 0;
  }

  let maxDistance = 0;

  for (const shape of bodyShapes) {
    maxDistance = Math.max(
      maxDistance,
      measureShapePositiveOffset(shape, {
        originX,
        originY,
        normalX,
        normalY
      })
    );
  }

  return maxDistance;
}

function measureShapePositiveOffset(shape, {
  originX,
  originY,
  normalX,
  normalY
}) {
  if (!shape || typeof shape !== "object") {
    return 0;
  }

  if (shape.type === "circle") {
    const centerOffset = projectPointOntoNormal({
      pointX: coerceNumber(shape.x, 0),
      pointY: coerceNumber(shape.y, 0),
      originX,
      originY,
      normalX,
      normalY
    });
    return Math.max(0, centerOffset + coerceNumber(shape.radius, 0));
  }

  const points = collectShapePoints(shape);
  if (!points.length) {
    return 0;
  }

  return Math.max(
    0,
    ...points.map(([pointX, pointY]) => projectPointOntoNormal({
      pointX,
      pointY,
      originX,
      originY,
      normalX,
      normalY
    }))
  );
}

function collectShapePoints(shape) {
  if (shape?.type === "polygon" && Array.isArray(shape.points)) {
    return flatPointsToPairs(shape.points);
  }

  if (shape?.type === "rectangle") {
    const x = coerceNumber(shape.x, 0);
    const y = coerceNumber(shape.y, 0);
    const width = coerceNumber(shape.width, 0);
    const height = coerceNumber(shape.height, 0);

    return [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height]
    ];
  }

  return [];
}

function flatPointsToPairs(points) {
  const pairs = [];

  for (let index = 0; index < points.length - 1; index += 2) {
    pairs.push([
      coerceNumber(points[index], 0),
      coerceNumber(points[index + 1], 0)
    ]);
  }

  return pairs;
}

function projectPointOntoNormal({
  pointX,
  pointY,
  originX,
  originY,
  normalX,
  normalY
}) {
  return ((pointX - originX) * normalX) + ((pointY - originY) * normalY);
}

async function deleteManagedRegionGroup(regionDocuments, {
  reason = "manual-group-cleanup",
  deletionOptions = {}
} = {}) {
  const documents = Array.isArray(regionDocuments)
    ? regionDocuments.filter(Boolean)
    : regionDocuments
      ? [regionDocuments]
      : [];
  if (!documents.length) {
    return [];
  }

  const scene = documents[0]?.parent ?? null;
  if (!scene) {
    return [];
  }

  const regionIds = documents
    .map((regionDocument) => regionDocument?.id ?? null)
    .filter((regionId) => regionId && scene?.regions?.get?.(regionId));

  if (!regionIds.length) {
    return [];
  }

  for (const regionDocument of documents) {
    if (!regionDocument || !scene?.regions?.get?.(regionDocument.id)) {
      continue;
    }

    await cleanupLinkedDocumentsForRegion(regionDocument, {
      reason,
      skipRuntimeUpdate: true
    });
    await cleanupWhileInsideStatusesForRegion({
      regionDocument,
      cleanupReason: reason
    });
  }

  await scene.deleteEmbeddedDocuments("Region", regionIds, {
    persistentZonesCleanup: true,
    ...deletionOptions,
    persistentZonesRegionGroupPrecleaned: true
  });

  debug("Cleaned managed Region group.", {
    sceneId: scene?.id ?? null,
    regionGroupId: getRegionRuntimeFlags(documents[0])?.groupId ?? null,
    availableVariants: getRegionRuntimeFlags(documents[0])?.availableVariantIds ?? [],
    selectedVariant: getRegionRuntimeFlags(documents[0])?.selectedVariantId ?? null,
    defaultVariant: getRegionRuntimeFlags(documents[0])?.defaultVariantId ?? null,
    variantResolutionMode: getRegionRuntimeFlags(documents[0])?.variantResolutionMode ?? "none",
    regionIds,
    reason
  });

  return regionIds;
}

async function resolveDocumentFromRuntimeUuid(uuid, documentName) {
  const resolved = await fromUuidSafe(uuid);
  return resolved?.documentName === documentName ? resolved : null;
}

function buildNativeRegionBehaviors({
  normalizedDefinition,
  sourceContext
}) {
  const behaviors = [];
  if (normalizedDefinition?.obstacles?.mode === "wall-restricted" && normalizedDefinition?.obstacles?.levelId) {
    behaviors.push(buildAttachedEmanationBehaviorData());
  }
  const terrain = normalizedDefinition?.terrain ?? {};
  if (!terrain.difficult) {
    debug("No native Region movement-cost behavior requested by normalized definition.", {
      label: normalizedDefinition?.label ?? null,
      terrain
    });
    return behaviors;
  }

  const multiplier = coerceNumber(terrain.multiplier, STANDARD_DIFFICULT_TERRAIN_MULTIPLIER);
  const behaviorType = terrain.behaviorType ?? NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE;
  if (!CONFIG?.RegionBehavior?.dataModels?.[behaviorType]) {
    debug("Skipped native Region behavior because the behavior type is unavailable.", {
      label: normalizedDefinition?.label ?? null,
      behaviorType
    });
    return behaviors;
  }

  const behaviorData = {
    name: buildTerrainBehaviorName(normalizedDefinition, sourceContext),
    type: behaviorType,
    system: {
      magical: Boolean(terrain.system?.magical),
      types: Array.from(terrain.system?.types ?? []),
      ignoredDispositions: Array.from(terrain.system?.ignoredDispositions ?? [])
    },
    flags: {
      [MODULE_ID]: {
        nativeBehavior: {
          kind: "difficult-terrain",
          multiplier
        }
      }
    }
  };

  debug("Prepared native Region behavior for movement cost.", {
    label: normalizedDefinition?.label ?? null,
    behaviorType,
    multiplier,
    system: behaviorData.system
  });

  behaviors.push(behaviorData);
  return behaviors;
}

async function buildRegionShapesFromTemplate(templateDocument) {
  const templateType = getTemplateType(templateDocument);
  const renderedResult = await buildShapesFromRenderedTemplate(templateDocument);
  if (renderedResult.shapes.length) {
    debug("Using Region shape builder.", {
      templateId: templateDocument?.id ?? null,
      templateType: getTemplateType(templateDocument),
      builder: renderedResult.builder,
      details: renderedResult.details
    });
    return renderedResult.shapes;
  }

  switch (templateType) {
    case "circle":
      return logBuiltShapes(templateDocument, "document-circle", [buildCircleShapeFromDocument(templateDocument)]);
    case "rect":
      debug("Falling back to document rect builder because rendered template geometry was unavailable.", {
        templateId: templateDocument?.id ?? null,
        templateType,
        renderedBuilder: renderedResult.builder,
        renderedReason: renderedResult.reason ?? null
      });
      return buildRectShapesFromDocument(templateDocument);
    case "ray":
      return logBuiltShapes(templateDocument, "document-ray", [buildRayShapeFromDocument(templateDocument)]);
    default:
      debug("Rejected Region shape build for unsupported template type.", {
        templateId: templateDocument?.id ?? null,
        templateType,
        renderedBuilder: renderedResult.builder,
        renderedReason: renderedResult.reason ?? null
      });
      return [];
  }
}

async function buildShapesFromRenderedTemplate(templateDocument) {
  const templateType = getTemplateType(templateDocument);
  const placeable = await resolveTemplatePlaceable(templateDocument);
  const renderedShape = placeable?.shape ?? null;

  if (!renderedShape) {
    return {
      shapes: [],
      builder: "rendered-shape",
      reason: "No rendered shape was available on the template placeable."
    };
  }

  if (templateType === "circle" && hasPixiCircleShape(renderedShape)) {
    const shape = {
      type: "circle",
      x: (templateDocument.x ?? 0) + (renderedShape.x ?? 0),
      y: (templateDocument.y ?? 0) + (renderedShape.y ?? 0),
      radius: renderedShape.radius
    };
    logCircleGeometryDiagnostic("circleSerializedShape", {
      templateDocument,
      sourceShape: shape,
      createdShape: shape,
      strategy: "rendered-native-circle-shape"
    });
    return {
      shapes: [shape],
      builder: "rendered-native-circle",
      details: {
        x: shape.x,
        y: shape.y,
        radius: shape.radius
      }
    };
  }

  if (templateType === "circle") {
    const shape = buildCircleShapeFromDocument(templateDocument);
    logCircleGeometryDiagnostic("circleSerializedShape", {
      templateDocument,
      sourceShape: shape,
      createdShape: shape,
      strategy: "document-circle-fallback-no-rendered-radius"
    });
    return {
      shapes: [shape],
      builder: "document-circle-fallback-no-rendered-radius",
      reason: "Rendered circle points were ignored to avoid grid-based polygon geometry.",
      details: {
        x: shape.x,
        y: shape.y,
        radius: shape.radius
      }
    };
  }

  if (hasFlatPoints(renderedShape.points)) {
    const points = trimClosingPolygonPoint(
      translateFlatPoints(renderedShape.points, templateDocument.x ?? 0, templateDocument.y ?? 0)
    );
    const shape = {
      type: "polygon",
      points
    };
    if (templateType === "rect") {
      logRectShapeDecision(templateDocument, {
        builder: "rendered-polygon",
        accepted: true,
        anchor: "rendered-shape-relative-origin",
        finalShape: shape
      });
    }
    return {
      shapes: [shape],
      builder: "rendered-polygon",
      details: {
        points: points.length / 2
      }
    };
  }

  if (hasPixiCircleShape(renderedShape)) {
    return {
      shapes: [{
        type: "circle",
        x: (templateDocument.x ?? 0) + (renderedShape.x ?? 0),
        y: (templateDocument.y ?? 0) + (renderedShape.y ?? 0),
        radius: renderedShape.radius
      }],
      builder: "rendered-circle",
      details: {
        x: (templateDocument.x ?? 0) + (renderedShape.x ?? 0),
        y: (templateDocument.y ?? 0) + (renderedShape.y ?? 0),
        radius: renderedShape.radius
      }
    };
  }

  if (hasPixiRectangleShape(renderedShape)) {
    const shape = {
      type: "rectangle",
      x: (templateDocument.x ?? 0) + (renderedShape.x ?? 0),
      y: (templateDocument.y ?? 0) + (renderedShape.y ?? 0),
      width: renderedShape.width,
      height: renderedShape.height,
      rotation: 0
    };
    if (templateType === "rect") {
      logRectShapeDecision(templateDocument, {
        builder: "rendered-rectangle",
        accepted: true,
        anchor: "rendered-rectangle-top-left",
        finalShape: shape
      });
    }
    return {
      shapes: [shape],
      builder: "rendered-rectangle",
      details: {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height
      }
    };
  }

  return {
    shapes: [],
    builder: "rendered-shape",
    reason: "Rendered shape existed but did not match a supported conversion path."
  };
}

async function resolveTemplatePlaceable(templateDocument) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const placeable =
      templateDocument?.object ??
      canvas?.templates?.get?.(templateDocument?.id) ??
      canvas?.templates?.placeables?.find((candidate) => candidate.document?.id === templateDocument?.id) ??
      null;

    if (placeable?.shape) {
      return placeable;
    }

    await wait(15);
  }

  return null;
}

function buildCircleShapeFromDocument(templateDocument) {
  const radius = distanceToPixels(templateDocument.distance, templateDocument.parent);
  const centerX = coerceNumber(templateDocument.x, 0);
  const centerY = coerceNumber(templateDocument.y, 0);
  return {
    type: "circle",
    x: centerX,
    y: centerY,
    radius,
    rotation: 0
  };
}

function buildRayShapeFromDocument(templateDocument) {
  const length = distanceToPixels(templateDocument.distance, templateDocument.parent);
  const width = distanceToPixels(templateDocument.width || 5, templateDocument.parent);

  return {
    type: "rectangle",
    x: templateDocument.x ?? 0,
    y: (templateDocument.y ?? 0) - width / 2,
    width: length,
    height: width,
    rotation: coerceNumber(templateDocument.direction, 0)
  };
}

function buildFoundryRegionShapes(shapes) {
  return Array.from(shapes ?? [])
    .map((shape) => buildFoundryRegionShape(shape))
    .filter(Boolean);
}

function buildFoundryRegionShape(shape) {
  if (!shape || typeof shape !== "object") {
    return null;
  }

  logV14PipelineStep("05", "Shape serializer selected", {
    entryPoint: "buildFoundryRegionShape",
    requestedShapeType: shape.type ?? null,
    serializerUsed: getRegionShapeSerializerName(shape),
    payloadShapeType: shape.type ?? null,
    rawShape: summarizeFoundryRegionShapes([shape])?.[0] ?? duplicateData(shape)
  });
  logGeometrySource({
    entryPoint: "buildFoundryRegionShape",
    geometrySelected: shape.type ?? null,
    serializerSelected: getRegionShapeSerializerName(shape),
    factorySelected: shape.type === "ring" ? "native-ring" : null
  });

  if (shape.type === "circle") {
    return serializeNativeCircleShape(shape);
  }

  if (shape.type === "polygon") {
    const serialized = {
      type: "polygon",
      x: coerceNumber(shape.x, 0),
      y: coerceNumber(shape.y, 0),
      rotation: coerceNumber(shape.rotation, 0),
      points: Array.from(shape.points ?? []),
      hole: Boolean(shape.hole)
    };
    return serialized;
  }

  if (shape.type === "rectangle") {
    return serializeNativeRectangleShape(shape);
  }

  if (shape.type === "ellipse") {
    return serializeNativeEllipseShape(shape);
  }

  if (shape.type === "cone") {
    return serializeNativeConeShape(shape);
  }

  if (shape.type === "ring") {
    return serializeNativeRingShape(shape);
  }

  if (shape.type === "line") {
    return serializeNativeLineShape(shape);
  }

  if (shape.type === "emanation") {
    return serializeNativeEmanationShape(shape);
  }

  return duplicateData(shape);
}

function serializeNativeCircleShape(shape) {
  return {
    type: "circle",
    x: coerceNumber(shape.x, 0),
    y: coerceNumber(shape.y, 0),
    radius: coerceNumber(shape.radius, 0),
    hole: Boolean(shape.hole),
    gridBased: Boolean(shape.gridBased)
  };
}

function serializeNativeEllipseShape(shape) {
  const width = coerceNumber(shape.width, null);
  const height = coerceNumber(shape.height, null);
  const radiusX = coerceNumber(shape.radiusX, width !== null ? width / 2 : 0);
  const radiusY = coerceNumber(shape.radiusY, height !== null ? height / 2 : 0);
  return {
    type: "ellipse",
    x: shape.cx !== undefined
      ? coerceNumber(shape.cx, 0)
      : width !== null && shape.radiusX === undefined
        ? coerceNumber(shape.x, 0) + radiusX
        : coerceNumber(shape.x, 0),
    y: shape.cy !== undefined
      ? coerceNumber(shape.cy, 0)
      : height !== null && shape.radiusY === undefined
        ? coerceNumber(shape.y, 0) + radiusY
        : coerceNumber(shape.y, 0),
    radiusX,
    radiusY,
    hole: Boolean(shape.hole),
    rotation: coerceNumber(shape.rotation, 0),
    gridBased: Boolean(shape.gridBased)
  };
}

function serializeNativeRectangleShape(shape) {
  return {
    type: "rectangle",
    x: coerceNumber(shape.x, 0),
    y: coerceNumber(shape.y, 0),
    width: coerceNumber(shape.width, 0),
    height: coerceNumber(shape.height, 0),
    hole: Boolean(shape.hole),
    anchorX: coerceNumber(shape.anchorX, 0),
    anchorY: coerceNumber(shape.anchorY, 0),
    rotation: coerceNumber(shape.rotation, 0),
    gridBased: Boolean(shape.gridBased)
  };
}

function serializeNativeConeShape(shape) {
  return {
    type: "cone",
    x: coerceNumber(shape.x, 0),
    y: coerceNumber(shape.y, 0),
    radius: coerceNumber(shape.radius, 0),
    angle: coerceNumber(shape.angle, 0),
    hole: Boolean(shape.hole),
    rotation: coerceNumber(shape.rotation, 0),
    curvature: shape.curvature ?? "round",
    gridBased: Boolean(shape.gridBased)
  };
}

function serializeNativeRingShape(shape) {
  return {
    type: "ring",
    x: coerceNumber(shape.x, 0),
    y: coerceNumber(shape.y, 0),
    radius: coerceNumber(shape.radius, 0),
    innerWidth: coerceNumber(shape.innerWidth, 0),
    outerWidth: coerceNumber(shape.outerWidth, 0),
    hole: Boolean(shape.hole),
    gridBased: Boolean(shape.gridBased)
  };
}

function serializeNativeLineShape(shape) {
  return {
    type: "line",
    x: coerceNumber(shape.x, 0),
    y: coerceNumber(shape.y, 0),
    length: coerceNumber(shape.length, 0),
    width: coerceNumber(shape.width, 0),
    hole: Boolean(shape.hole),
    rotation: coerceNumber(shape.rotation, 0),
    gridBased: Boolean(shape.gridBased)
  };
}

function serializeNativeEmanationShape(shape) {
  return {
    type: "emanation",
    base: duplicateData(shape.base ?? null),
    radius: coerceNumber(shape.radius, 0),
    hole: Boolean(shape.hole),
    gridBased: Boolean(shape.gridBased)
  };
}

function summarizeRegionCreateData(regionCreateData) {
  return Array.from(regionCreateData ?? []).map((regionData) => ({
    name: regionData?.name ?? null,
    shapeTypes: Array.from(regionData?.shapes ?? []).map((shape) => shape?.type ?? null),
    shapes: summarizeFoundryRegionShapes(regionData?.shapes ?? []),
    shapeCount: Array.from(regionData?.shapes ?? []).length,
    behaviorTypes: Array.from(regionData?.behaviors ?? []).map((behavior) => behavior?.type ?? null),
    behaviorCount: Array.from(regionData?.behaviors ?? []).length
  }));
}

function cleanV14NativeRegionCreatePayload(payload) {
  return cleanDocumentCreateData(payload, {
    removeTopLevelFields: new Set(["_id", "id", "parent", "scene", "sceneId", "documentName"])
  });
}

function buildV14NativeFinalRegionFlags(runtimeFlags, sourceRegionDocument = null) {
  const sourceFlags = sourceRegionDocument?.toObject?.()?.flags ??
    sourceRegionDocument?._source?.flags ??
    sourceRegionDocument?.flags ??
    {};
  const sourceNamespaces = Object.keys(sourceFlags ?? {});
  const removedNamespaces = TRANSIENT_TEMPLATE_FLAG_NAMESPACES.filter((namespace) => namespace in (sourceFlags ?? {}));
  const removedCoreSourceId = Boolean(sourceFlags?.core?.sourceId);
  const flags = {
    ...buildManagedRegionFlags(runtimeFlags),
    core: {
      "-=sourceId": null
    }
  };

  for (const namespace of TRANSIENT_TEMPLATE_FLAG_NAMESPACES) {
    flags[`-=${namespace}`] = null;
  }

  console.info(`[${MODULE_ID}][lifecycle] REGION LIFECYCLE LINK WRITTEN`, {
    regionDocumentId: sourceRegionDocument?.id ?? null,
    groupId: runtimeFlags?.groupId ?? null,
    partId: runtimeFlags?.partId ?? null,
    ownerEffectUuid: runtimeFlags?.ownerEffectUuid ?? runtimeFlags?.activeEffectUuid ?? runtimeFlags?.concentrationEffectUuid ?? null,
    itemUuid: runtimeFlags?.itemUuid ?? null,
    activityId: runtimeFlags?.activityId ?? null,
    sourceRegionId: runtimeFlags?.sourceRegionId ?? null,
    finalRegionId: runtimeFlags?.finalRegionId ?? null,
    sourceFlagNamespaces: sourceNamespaces,
    transientTemplateFlagNamespacesRemoved: removedNamespaces,
    coreSourceIdRemoved: removedCoreSourceId,
    pocketScrollFalsePositiveMitigation: removedNamespaces.length > 0 || removedCoreSourceId
  });

  return flags;
}

function logFinalRegionTransientState(regionDocument, {
  scene = null,
  sourceRegionId = null
} = {}) {
  const finalRegionId = regionDocument?.id ?? null;
  const objectFlags = regionDocument?.toObject?.()?.flags ?? {};
  const sourceFlags = regionDocument?._source?.flags ?? {};
  const directFlags = regionDocument?.flags ?? {};
  const dnd5eFlags = objectFlags?.dnd5e ?? sourceFlags?.dnd5e ?? directFlags?.dnd5e ?? null;
  const pf2eFlags = objectFlags?.pf2e ?? sourceFlags?.pf2e ?? directFlags?.pf2e ?? null;
  const coreSourceId = objectFlags?.core?.sourceId ?? sourceFlags?.core?.sourceId ?? directFlags?.core?.sourceId ?? null;
  const canvasTemplateIds = Array.from(canvas?.templates?.placeables ?? [])
    .map((placeable) => placeable?.document?.id ?? placeable?.id ?? null)
    .filter(Boolean);
  const finalRegionPresentInCanvasTemplates = Boolean(finalRegionId && canvasTemplateIds.includes(finalRegionId));
  const finalRegionPresentInSceneRegions = Boolean(finalRegionId && (
    scene?.regions?.get?.(finalRegionId) ??
    regionDocument?.parent?.regions?.get?.(finalRegionId)
  ));

  console.warn(`[${MODULE_ID}][lifecycle] PZ FINAL REGION TRANSIENT STATE`, {
    sceneId: scene?.id ?? regionDocument?.parent?.id ?? null,
    regionId: finalRegionId,
    documentName: regionDocument?.documentName ?? null,
    sourceRegionId,
    sameDocumentId: Boolean(sourceRegionId && finalRegionId && sourceRegionId === finalRegionId),
    "flags.dnd5e": duplicateData(dnd5eFlags),
    "flags.pf2e": duplicateData(pf2eFlags),
    "flags.core.sourceId": coreSourceId,
    temporaryMarkersRemoved: !dnd5eFlags && !pf2eFlags && !coreSourceId,
    canvasTemplateIds,
    finalRegionPresentInCanvasTemplates,
    finalRegionPresentInSceneRegions
  });
}

function cleanDocumentCreateData(value, {
  removeTopLevelFields = new Set(),
  depth = 0,
  seen = new WeakSet()
} = {}) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  const source = typeof value.toObject === "function" ? value.toObject() : value;
  if (Array.isArray(source)) {
    return source
      .map((entry) => cleanDocumentCreateData(entry, { removeTopLevelFields, depth: depth + 1, seen }))
      .filter((entry) => entry !== undefined);
  }

  const cleaned = {};
  for (const [key, entry] of Object.entries(source)) {
    if (depth === 0 && (removeTopLevelFields.has(key) || key.startsWith("flags."))) {
      continue;
    }
    const cleanedEntry = cleanDocumentCreateData(entry, { removeTopLevelFields, depth: depth + 1, seen });
    if (cleanedEntry !== undefined) {
      cleaned[key] = cleanedEntry;
    }
  }
  return cleaned;
}

function buildKnownGoodV14NativeRingPayload(payload) {
  const shape = Array.from(payload?.shapes ?? [])[0] ?? {};
  return cleanV14NativeRegionCreatePayload({
    name: "PZ DEBUG MINIMAL RING",
    color: payload?.color ?? DEFAULT_REGION_COLOR,
    visibility: 4,
    highlightMode: "shapes",
    shapes: [{
      type: "ring",
      x: shape.x,
      y: shape.y,
      radius: shape.radius,
      innerWidth: shape.innerWidth,
      outerWidth: shape.outerWidth,
      hole: false,
      gridBased: false
    }]
  });
}

function compareV14NativeRingPayloadToKnownGood(payload, knownGoodPayload) {
  const payloadShape = Array.from(payload?.shapes ?? [])[0] ?? {};
  const knownGoodShape = Array.from(knownGoodPayload?.shapes ?? [])[0] ?? {};
  const knownTopFields = new Set(Object.keys(knownGoodPayload ?? {}));
  const knownShapeFields = new Set(Object.keys(knownGoodShape ?? {}));
  const payloadTopFields = Object.keys(payload ?? {});
  const payloadShapeFields = Object.keys(payloadShape ?? {});
  const missingRequiredFields = [];

  for (const field of ["name", "color", "visibility", "highlightMode", "shapes"]) {
    if (!(field in (payload ?? {}))) {
      missingRequiredFields.push(field);
    }
  }
  for (const field of ["type", "x", "y", "radius", "innerWidth", "outerWidth", "hole", "gridBased"]) {
    if (!(field in payloadShape)) {
      missingRequiredFields.push(`shapes[0].${field}`);
    }
  }

  return {
    ringPayloadExtraTopLevelFields: payloadTopFields.filter((field) => !knownTopFields.has(field)),
    ringPayloadExtraShapeFields: payloadShapeFields.filter((field) => !knownShapeFields.has(field)),
    ringPayloadMissingRequiredFields: missingRequiredFields,
    ringPayloadDifferentFromKnownGood: JSON.stringify(cleanDocumentCreateData(payload)) !== JSON.stringify(cleanDocumentCreateData(knownGoodPayload))
  };
}

function stringifyDiagnosticJson(value) {
  try {
    return JSON.stringify(cleanDocumentCreateData(value), null, 2);
  } catch (caughtError) {
    return JSON.stringify({
      stringifyFailed: true,
      reason: caughtError?.message ?? "unknown"
    }, null, 2);
  }
}

function logV14NativeRegionPayloadJson(label, payload) {
  console.info(`[${MODULE_ID}][v14-native-payload] ${label}\n${stringifyDiagnosticJson(payload)}`);
}

function logV14NativeRingPayloadScalars(payload, {
  source = null,
  sourceRegionId = null,
  groupId = null,
  stage = "payload-build"
} = {}) {
  const shape = Array.from(payload?.shapes ?? [])[0] ?? {};
  console.info(
    `[${MODULE_ID}][v14-native-payload] ringPayloadX=${shape.x ?? "null"} | ringPayloadY=${shape.y ?? "null"} | ringPayloadRadius=${shape.radius ?? "null"} | ringPayloadInnerWidth=${shape.innerWidth ?? "null"} | ringPayloadOuterWidth=${shape.outerWidth ?? "null"} | ringPayloadHole=${shape.hole ?? "null"} | ringPayloadGridBased=${shape.gridBased ?? "null"} | v14NativeRegionCreateFailureStage=${stage}`,
    { source, sourceRegionId, groupId }
  );
}

function logV14NativeRingPayloadComparison(comparison, {
  source = null,
  sourceRegionId = null,
  groupId = null
} = {}) {
  console.info(
    `[${MODULE_ID}][v14-native-payload] ringPayloadExtraTopLevelFields=${comparison.ringPayloadExtraTopLevelFields.join(",") || "(none)"} | ringPayloadExtraShapeFields=${comparison.ringPayloadExtraShapeFields.join(",") || "(none)"} | ringPayloadMissingRequiredFields=${comparison.ringPayloadMissingRequiredFields.join(",") || "(none)"} | ringPayloadDifferentFromKnownGood=${comparison.ringPayloadDifferentFromKnownGood}`,
    { source, sourceRegionId, groupId, ...comparison }
  );
}

function logV14NativeRegionCreateFailure({
  stage = "unknown",
  error = null,
  source = null,
  sourceRegionId = null,
  groupId = null,
  validation = null,
  payload = null
} = {}) {
  const reason = error?.message ?? validation?.reason ?? "unknown";
  const validationJson = stringifyDiagnosticJson(validation ?? {});
  console.warn(`[${MODULE_ID}][v14-native-create] v14NativeRegionCreateFailedReason=${reason}`);
  console.warn(`[${MODULE_ID}][v14-native-create] v14NativeRegionCreateFailedName=${error?.name ?? "null"}`);
  console.warn(`[${MODULE_ID}][v14-native-create] v14NativeRegionCreateFailedMessage=${error?.message ?? "null"}`);
  console.warn(`[${MODULE_ID}][v14-native-create] v14NativeRegionCreateFailedStack=${error?.stack ?? "null"}`);
  console.warn(`[${MODULE_ID}][v14-native-create] v14NativeRegionCreateFailedValidation=${validationJson}`);
  console.warn(`[${MODULE_ID}][v14-native-create] v14NativeRegionCreateFailureStage=${stage}`);
  logV14RegionDiagnostic("v14NativeRegionCreateFailed", {
    entryPoint: "createManagedRegionFromRegion",
    source,
    sourceRegionId,
    groupId,
    reason,
    v14NativeRegionCreateFailedReason: reason,
    v14NativeRegionCreateFailedName: error?.name ?? null,
    v14NativeRegionCreateFailedMessage: error?.message ?? null,
    v14NativeRegionCreateFailedStack: error?.stack ?? null,
    v14NativeRegionCreateFailedValidation: validation ?? null,
    v14NativeRegionCreateFailureStage: stage,
    v14NativeSourceRegionRetainedAfterFailure: true,
    payloadSummary: summarizeRegionCreateData([payload])?.[0] ?? null
  });
}

async function tryCreateDebugMinimalV14RingPayload(scene, payload, {
  source = null,
  sourceRegionId = null,
  groupId = null,
  error = null
} = {}) {
  if (!scene || typeof scene.createEmbeddedDocuments !== "function") {
    logV14RegionDiagnostic("v14NativeMinimalRingFallbackFailed", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      sourceRegionId,
      groupId,
      reason: "missing-scene-createEmbeddedDocuments",
      originalFailureReason: error?.message ?? null
    });
    return null;
  }

  try {
    logV14NativeRegionPayloadJson("v14NativeMinimalRingFallbackPayloadJson", payload);
    const created = await scene.createEmbeddedDocuments("Region", [payload], {
      persistentZonesV14NativeMinimalRingFallback: true
    });
    const createdRegion = created?.[0] ?? null;
    logV14RegionDiagnostic("v14NativeMinimalRingFallbackSucceeded", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      sourceRegionId,
      groupId,
      regionDocumentId: createdRegion?.id ?? null,
      payloadSummary: summarizeRegionCreateData([payload])?.[0] ?? null,
      originalFailureReason: error?.message ?? null
    });
    return createdRegion;
  } catch (caughtError) {
    logV14NativeRegionCreateFailure({
      stage: "createEmbeddedDocuments",
      error: caughtError,
      source,
      sourceRegionId,
      groupId,
      payload
    });
    logV14RegionDiagnostic("v14NativeMinimalRingFallbackFailed", {
      entryPoint: "createManagedRegionFromRegion",
      source,
      sourceRegionId,
      groupId,
      reason: caughtError?.message ?? "unknown",
      originalFailureReason: error?.message ?? null
    });
    return null;
  }
}

function normalizeFoundryPolygonPointObjects(points) {
  const rawPoints = Array.from(points ?? []);
  if (!rawPoints.length) {
    return [];
  }

  if (rawPoints.every((point) => typeof point === "number")) {
    const pairs = [];
    for (let index = 0; index < rawPoints.length - 1; index += 2) {
      pairs.push({
        x: coerceNumber(rawPoints[index], 0),
        y: coerceNumber(rawPoints[index + 1], 0)
      });
    }
    return pairs;
  }

  return rawPoints
    .map((point) => Array.isArray(point)
      ? {
        x: coerceNumber(point[0], null),
        y: coerceNumber(point[1], null)
      }
      : {
        x: coerceNumber(point?.x, null),
        y: coerceNumber(point?.y, null)
      })
    .filter((point) => point.x !== null && point.y !== null);
}

function sanitizePolygonPoints(points) {
  return Array.from(points ?? [])
    .map((point) => coerceNumber(point, null))
    .filter((point) => Number.isFinite(point));
}

function summarizeFoundryRegionShapes(shapes) {
  return Array.from(shapes ?? []).map((shape, index) => {
    const pointSummary = summarizeShapePoints(shape?.points);
    const bounds = calculateShapeBounds(shape);
    return {
      index: index + 1,
      type: shape?.type ?? null,
      hole: Boolean(shape?.hole),
      baseType: shape?.base?.type ?? null,
      radius: shape?.radius ?? null,
      radiusX: shape?.radiusX ?? null,
      radiusY: shape?.radiusY ?? null,
      innerRadius: shape?.innerRadius ?? null,
      outerRadius: shape?.outerRadius ?? null,
      innerWidth: shape?.innerWidth ?? null,
      outerWidth: shape?.outerWidth ?? null,
      length: shape?.length ?? null,
      angle: shape?.angle ?? null,
      curvature: shape?.curvature ?? null,
      gridBased: shape?.gridBased ?? null,
      anchorX: shape?.anchorX ?? null,
      anchorY: shape?.anchorY ?? null,
      origin: duplicateData(shape?.origin ?? null),
      base: duplicateData(shape?.base ?? null),
      polygonMode: shape?.polygonMode ?? null,
      ringSegment: shape?.ringSegment ?? null,
      ringGeometry: duplicateData(shape?.ringGeometry ?? null),
      x: shape?.x ?? null,
      y: shape?.y ?? null,
      width: shape?.width ?? null,
      height: shape?.height ?? null,
      rotation: shape?.rotation ?? null,
      pointsKind: pointSummary.kind,
      pointsLength: pointSummary.length,
      pointCount: pointSummary.count,
      points: pointSummary.points,
      pointsPreview: pointSummary.preview,
      bounds,
      keys: shape && typeof shape === "object" ? Object.keys(shape).sort() : []
    };
  });
}

function buildCircleSourceGeometry(templateDocument, circleShape = null) {
  const radius = distanceToPixels(templateDocument?.distance, templateDocument?.parent);
  const center = {
    x: coerceNumber(templateDocument?.x, 0),
    y: coerceNumber(templateDocument?.y, 0)
  };
  return {
    center,
    radius,
    width: radius * 2,
    height: radius * 2,
    bounds: calculateShapeBounds(circleShape ?? {
      type: "ellipse",
      x: center.x - radius,
      y: center.y - radius,
      width: radius * 2,
      height: radius * 2
    })
  };
}

function calculateRegionBoundsFromShapes(shapes) {
  const bounds = Array.from(shapes ?? [])
    .map((shape) => calculateShapeBounds(shape))
    .filter(Boolean);
  if (!bounds.length) {
    return null;
  }
  const minX = Math.min(...bounds.map((bound) => bound.minX));
  const minY = Math.min(...bounds.map((bound) => bound.minY));
  const maxX = Math.max(...bounds.map((bound) => bound.maxX));
  const maxY = Math.max(...bounds.map((bound) => bound.maxY));
  return buildBoundsSummary(minX, minY, maxX, maxY);
}

function calculateShapeBounds(shape) {
  if (!shape || typeof shape !== "object") {
    return null;
  }

  if (shape.type === "circle") {
    const radius = coerceNumber(shape.radius, 0);
    const centerX = coerceNumber(shape.x, 0);
    const centerY = coerceNumber(shape.y, 0);
    return buildBoundsSummary(centerX - radius, centerY - radius, centerX + radius, centerY + radius);
  }

  if (shape.type === "ring") {
    const radius = coerceNumber(shape.radius, 0);
    const outerWidth = coerceNumber(shape.outerWidth, 0);
    const extent = radius + outerWidth;
    const centerX = coerceNumber(shape.x, 0);
    const centerY = coerceNumber(shape.y, 0);
    return buildBoundsSummary(centerX - extent, centerY - extent, centerX + extent, centerY + extent);
  }

  if (shape.type === "cone") {
    const radius = coerceNumber(shape.radius, 0);
    const centerX = coerceNumber(shape.x, 0);
    const centerY = coerceNumber(shape.y, 0);
    return buildBoundsSummary(centerX - radius, centerY - radius, centerX + radius, centerY + radius);
  }

  if (shape.type === "line") {
    const x = coerceNumber(shape.x, 0);
    const y = coerceNumber(shape.y, 0);
    const length = coerceNumber(shape.length, 0);
    const width = coerceNumber(shape.width, 0);
    const rotation = (coerceNumber(shape.rotation, 0) * Math.PI) / 180;
    const halfWidth = width / 2;
    const corners = [
      { x: 0, y: -halfWidth },
      { x: length, y: -halfWidth },
      { x: length, y: halfWidth },
      { x: 0, y: halfWidth }
    ].map((point) => ({
      x: x + (point.x * Math.cos(rotation)) - (point.y * Math.sin(rotation)),
      y: y + (point.x * Math.sin(rotation)) + (point.y * Math.cos(rotation))
    }));
    return buildBoundsSummary(
      Math.min(...corners.map((point) => point.x)),
      Math.min(...corners.map((point) => point.y)),
      Math.max(...corners.map((point) => point.x)),
      Math.max(...corners.map((point) => point.y))
    );
  }

  if (shape.type === "ellipse") {
    const width = coerceNumber(shape.width, null);
    const height = coerceNumber(shape.height, null);
    const radiusX = coerceNumber(shape.radiusX, width !== null ? width / 2 : 0);
    const radiusY = coerceNumber(shape.radiusY, height !== null ? height / 2 : 0);
    const centerX = shape.cx !== undefined
      ? coerceNumber(shape.cx, 0)
      : width !== null && shape.radiusX === undefined
        ? coerceNumber(shape.x, 0) + radiusX
        : coerceNumber(shape.x, 0);
    const centerY = shape.cy !== undefined
      ? coerceNumber(shape.cy, 0)
      : height !== null && shape.radiusY === undefined
        ? coerceNumber(shape.y, 0) + radiusY
        : coerceNumber(shape.y, 0);
    return buildBoundsSummary(centerX - radiusX, centerY - radiusY, centerX + radiusX, centerY + radiusY);
  }

  if (shape.type === "rectangle") {
    const width = coerceNumber(shape.width, 0);
    const height = coerceNumber(shape.height, 0);
    const x = coerceNumber(shape.x, 0);
    const y = coerceNumber(shape.y, 0);
    return buildBoundsSummary(x, y, x + width, y + height);
  }

  if (shape.type === "polygon") {
    const points = normalizeShapePointObjects(shape.points);
    if (!points.length) {
      return null;
    }
    return buildBoundsSummary(
      Math.min(...points.map((point) => point.x)),
      Math.min(...points.map((point) => point.y)),
      Math.max(...points.map((point) => point.x)),
      Math.max(...points.map((point) => point.y))
    );
  }

  return null;
}

function normalizeShapePointObjects(points) {
  const rawPoints = Array.from(points ?? []);
  if (!rawPoints.length) {
    return [];
  }

  if (rawPoints.every((point) => typeof point === "number")) {
    const normalized = [];
    for (let index = 0; index < rawPoints.length - 1; index += 2) {
      normalized.push({
        x: coerceNumber(rawPoints[index], null),
        y: coerceNumber(rawPoints[index + 1], null)
      });
    }
    return normalized.filter((point) => point.x !== null && point.y !== null);
  }

  return rawPoints
    .map((point) => Array.isArray(point)
      ? { x: coerceNumber(point[0], null), y: coerceNumber(point[1], null) }
      : { x: coerceNumber(point?.x, null), y: coerceNumber(point?.y, null) })
    .filter((point) => point.x !== null && point.y !== null);
}

function buildBoundsSummary(minX, minY, maxX, maxY) {
  const width = maxX - minX;
  const height = maxY - minY;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: minX + (width / 2),
    centerY: minY + (height / 2)
  };
}

function compareBounds(expectedBounds, createdBounds, tolerance = 1) {
  if (!expectedBounds || !createdBounds) {
    return {
      mismatch: true,
      reason: "missing-bounds"
    };
  }
  const delta = {
    minX: createdBounds.minX - expectedBounds.minX,
    minY: createdBounds.minY - expectedBounds.minY,
    maxX: createdBounds.maxX - expectedBounds.maxX,
    maxY: createdBounds.maxY - expectedBounds.maxY,
    width: createdBounds.width - expectedBounds.width,
    height: createdBounds.height - expectedBounds.height,
    centerX: createdBounds.centerX - expectedBounds.centerX,
    centerY: createdBounds.centerY - expectedBounds.centerY
  };
  const mismatch = Object.values(delta).some((value) => Math.abs(value) > tolerance);
  return {
    mismatch,
    reason: mismatch ? "bounds-delta-over-tolerance" : null,
    tolerance,
    delta
  };
}

function summarizeCircleShapeGeometry(shape) {
  const shapeType = shape?.type ?? null;
  const bounds = calculateShapeBounds(shape);
  if (shapeType === "circle") {
    return {
      circleShapeType: "circle",
      circleCenter: {
        x: coerceNumber(shape?.x, 0),
        y: coerceNumber(shape?.y, 0)
      },
      circleRadius: coerceNumber(shape?.radius, 0),
      circleWidth: coerceNumber(shape?.radius, 0) * 2,
      circleHeight: coerceNumber(shape?.radius, 0) * 2,
      circleBounds: bounds
    };
  }

  if (shapeType === "ellipse") {
    const width = coerceNumber(shape?.width, coerceNumber(shape?.radiusX, 0) * 2);
    const height = coerceNumber(shape?.height, coerceNumber(shape?.radiusY, 0) * 2);
    return {
      circleShapeType: "ellipse",
      circleCenter: {
        x: coerceNumber(shape?.x, 0) + (width / 2),
        y: coerceNumber(shape?.y, 0) + (height / 2)
      },
      circleRadius: Math.max(width, height) / 2,
      circleWidth: width,
      circleHeight: height,
      circleBounds: bounds
    };
  }

  return {
    circleShapeType: shapeType,
    circleCenter: bounds
      ? {
        x: bounds.centerX,
        y: bounds.centerY
      }
      : null,
    circleRadius: bounds ? Math.max(bounds.width, bounds.height) / 2 : null,
    circleWidth: bounds?.width ?? null,
    circleHeight: bounds?.height ?? null,
    circleBounds: bounds
  };
}

function logCircleGeometryDiagnostic(message, {
  templateDocument,
  sourceShape,
  createdShape = null,
  createdShapes = null,
  strategy
} = {}) {
  const sourceSummary = summarizeCircleShapeGeometry(sourceShape);
  const createdSummary = createdShape
    ? summarizeCircleShapeGeometry(createdShape)
    : summarizeCircleShapeGeometry(Array.from(createdShapes ?? [])[0] ?? null);
  const comparison = compareBounds(sourceSummary.circleBounds, createdSummary.circleBounds);
  const highlightContext = detectRegionHighlightModeContext();
  logV14RegionDiagnostic(message, {
    templateId: templateDocument?.id ?? null,
    templateType: getTemplateType(templateDocument),
    circleGeometryStrategy: strategy,
    circleShapeType: createdSummary.circleShapeType,
    circleSourceCenter: sourceSummary.circleCenter,
    circleSourceRadius: sourceSummary.circleRadius,
    circleSourceBounds: sourceSummary.circleBounds,
    circleCreatedCenter: createdSummary.circleCenter,
    circleCreatedRadius: createdSummary.circleRadius,
    circleCreatedBounds: createdSummary.circleBounds,
    circleGeometryMismatch: comparison.mismatch,
    circleGeometryMismatchReason: comparison.reason,
    circleGeometryDelta: comparison.delta ?? null,
    conversion: {
      sceneDistance: templateDocument?.distance ?? null,
      gridSize: templateDocument?.parent?.grid?.size ?? canvas?.dimensions?.size ?? null,
      gridDistance: templateDocument?.parent?.grid?.distance ?? canvas?.dimensions?.distance ?? null
    },
    regionHighlightModeDetected: highlightContext.regionHighlightModeDetected,
    authenticShapePreferred: highlightContext.authenticShapePreferred,
    gridCoverageHighlightDetected: highlightContext.gridCoverageHighlightDetected,
    visualMismatchLikelyFromHighlightMode: highlightContext.visualMismatchLikelyFromHighlightMode,
    highlightModeCandidates: highlightContext.highlightModeCandidates
  });
  logV14RegionDiagnostic("regionHighlightModeDetected", {
    templateId: templateDocument?.id ?? null,
    templateType: getTemplateType(templateDocument),
    circleShapeType: createdSummary.circleShapeType,
    regionHighlightModeDetected: highlightContext.regionHighlightModeDetected,
    authenticShapePreferred: highlightContext.authenticShapePreferred,
    gridCoverageHighlightDetected: highlightContext.gridCoverageHighlightDetected,
    visualMismatchLikelyFromHighlightMode: highlightContext.visualMismatchLikelyFromHighlightMode,
    highlightModeCandidates: highlightContext.highlightModeCandidates
  });
}

async function applyAuthenticRegionHighlightMode(regionDocument, {
  entryPoint = null,
  operation = null,
  templateDocument = null,
  scene = null,
  templateDiagnostics = {},
  groupPlan = null,
  partId = null,
  partIndex = null,
  runtimeFlags = null
} = {}) {
  if (!regionDocument || typeof regionDocument.update !== "function") {
    logV14RegionDiagnostic("regionHighlightModeUpdateFailed", {
      entryPoint,
      operation,
      regionHighlightModeUpdateFailed: true,
      regionHighlightModeUpdateFailedReason: "missing-region-document-or-update-api"
    });
    return null;
  }

  const detection = detectRegionHighlightModeForDocument(regionDocument);
  const highlightModeKey = (value) => `${detection.fieldPath ?? REGION_DEFAULT_HIGHLIGHT_MODE_FIELD}:${String(value)}`;
  const highlightSetting = resolveRegionHighlightModeSetting();
  const requestedValues = collectRegionHighlightModeValuesForSetting(detection, highlightSetting.value)
    .filter((value) => !rejectedRegionHighlightModeValues.has(highlightModeKey(value)));
  const requestedValue = requestedValues[0] ?? null;
  const visibilityResult = await applyV14RegionVisibilitySetting(regionDocument, {
    entryPoint,
    operation,
    runtimeFlags
  });
  const ringRuntimeFlags = runtimeFlags ?? getRegionRuntimeFlags(regionDocument);
  const isRingRegion = isV14RingRuntimeFlags(ringRuntimeFlags);
  const commonPayload = {
    entryPoint,
    operation,
    templateId: templateDocument?.id ?? runtimeFlags?.templateId ?? null,
    sceneId: scene?.id ?? regionDocument?.parent?.id ?? null,
    ...templateDiagnostics,
    regionGroupId: groupPlan?.groupId ?? runtimeFlags?.groupId ?? null,
    partId: partId ?? runtimeFlags?.partId ?? null,
    partIndex: partIndex ?? runtimeFlags?.partIndex ?? null,
    regionDocumentId: regionDocument?.id ?? null,
    regionHighlightModeDetected: detection.detectedValue,
    regionHighlightModeField: detection.fieldPath,
    regionHighlightModeRequestedValue: requestedValue,
    regionHighlightSettingResolved: highlightSetting.value,
    regionHighlightModeValue: detection.detectedValue,
    regionHighlightModePersistedValue: detection.persistedValue,
    regionHighlightModeSourceValue: detection.sourceValue,
    regionHighlightModeDocumentValue: detection.documentValue,
    regionHighlightModeToObjectValue: detection.toObjectValue,
    regionHighlightModeMismatch: detection.mismatch,
    authenticShapePreferred: detection.authenticShapePreferred,
    gridCoverageHighlightDetected: detection.gridCoverageHighlightDetected,
    visualMismatchLikelyFromHighlightMode: detection.gridCoverageHighlightDetected && !detection.authenticShapePreferred,
    highlightModeCandidates: detection.candidates,
    highlightModeSchemaCandidates: detection.schemaCandidates,
    highlightModeRuntimeChoices: detection.runtimeChoices,
    regionHighlightModeChoices: detection.runtimeChoices,
    regionVisibilityApplied: visibilityResult?.applied ?? false,
    regionVisibilityFallback: visibilityResult?.fallback ?? false
  };
  logV14RegionDiagnostic("regionHighlightSettingResolved", commonPayload);
  logV14RegionDiagnostic("regionHighlightSchemaChoices", {
    ...commonPayload,
    regionHighlightModeChoices: detection.runtimeChoices,
    regionHighlightSchemaChoices: detection.schemaCandidates
  });
  logV14RegionDiagnostic("regionHighlightModeDetected", commonPayload);

  if (!detection.fieldPath) {
    logV14RegionDiagnostic("regionHighlightModeUpdateFailed", {
      ...commonPayload,
      regionHighlightModeUpdateFailed: true,
      regionHighlightModeUpdateFailedReason: "no-region-highlight-mode-field-detected"
    });
    return null;
  }

  if (!requestedValues.length) {
    const reason = `no-${highlightSetting.value}-highlight-mode-choice-detected`;
    if (isRingRegion) {
      logRingVisibilityLine(`ringHighlightModeSkipped: id=${regionDocument?.id ?? "null"} reason=${reason} choices=${JSON.stringify(detection.runtimeChoices ?? [])}`);
      return detection;
    }
    logV14RegionDiagnostic("regionHighlightModeFallback", {
      ...commonPayload,
      regionHighlightModeApplied: false,
      regionHighlightModeFallback: true,
      regionHighlightModeFallbackReason: reason,
      regionHighlightModeChoices: detection.runtimeChoices
    });
    return detection;
  }

  if (isRegionHighlightModeAlreadySatisfied(detection, highlightSetting.value)) {
    logV14RegionDiagnostic("regionHighlightModeApplied", {
      ...commonPayload,
      regionHighlightModeApplied: true,
      regionHighlightModeAppliedReason: "already-matches-setting",
      regionHighlightModeValue: detection.detectedValue
    });
    return detection;
  }

  let lastError = null;
  for (const candidateValue of requestedValues) {
    try {
      await regionDocument.update(setDataPath({}, detection.fieldPath, candidateValue));
      const updatedDetection = detectRegionHighlightModeForDocument(regionDocument);
      logV14RegionDiagnostic("regionHighlightModeApplied", {
        ...commonPayload,
        regionHighlightModeApplied: true,
        regionHighlightModeField: detection.fieldPath,
        regionHighlightModeRequestedValue: candidateValue,
        regionHighlightModeAcceptedValue: candidateValue,
        regionHighlightModeValue: candidateValue,
        regionHighlightModePersistedValue: updatedDetection.persistedValue,
        regionHighlightModeSourceValue: updatedDetection.sourceValue,
        regionHighlightModeDocumentValue: updatedDetection.documentValue,
        regionHighlightModeToObjectValue: updatedDetection.toObjectValue,
        regionHighlightModeMismatch: updatedDetection.mismatch,
        regionHighlightModeDetectedAfterUpdate: updatedDetection.detectedValue,
        regionHighlightModeChoices: updatedDetection.runtimeChoices,
        authenticShapePreferred: updatedDetection.authenticShapePreferred,
        gridCoverageHighlightDetected: updatedDetection.gridCoverageHighlightDetected
      });
      queueRegionHighlightModeVerification(regionDocument, {
        ...commonPayload,
        regionHighlightModeRequestedValue: candidateValue,
        regionHighlightModeAcceptedValue: candidateValue
      });
      return updatedDetection;
    } catch (caughtError) {
      lastError = caughtError;
      rejectedRegionHighlightModeValues.add(highlightModeKey(candidateValue));
      logV14RegionDiagnostic("regionHighlightModeUpdateFailed", {
        ...commonPayload,
        regionHighlightModeUpdateFailed: true,
        regionHighlightModeField: detection.fieldPath,
        regionHighlightModeRequestedValue: candidateValue,
        regionHighlightModeValue: candidateValue,
        regionHighlightModeChoices: detection.runtimeChoices,
        regionHighlightModeUpdateFailedReason: caughtError?.message ?? "unknown"
      });
    }
  }

  logV14RegionDiagnostic("regionHighlightModeUpdateFailed", {
    ...commonPayload,
    regionHighlightModeUpdateFailed: true,
    regionHighlightModeUpdateFailedReason: lastError?.message ?? "all-detected-highlight-mode-values-rejected",
    regionHighlightModeChoices: detection.runtimeChoices
  });
  return detection;
}

function detectRegionHighlightModeForDocument(regionDocument) {
  const objectData = duplicateData(regionDocument?.toObject?.() ?? {});
  const flatData = flattenObject(objectData);
  const runtimeChoices = collectRegionHighlightModeRuntimeChoices(regionDocument);
  const directValues = readRegionHighlightModeValues(regionDocument);
  const dataCandidates = Object.entries(flatData)
    .map(([path, value]) => buildHighlightModeCandidate(path, value, "region-document", null))
    .filter(Boolean);
  const schemaCandidates = collectRegionHighlightSchemaCandidates(regionDocument);
  const runtimeCandidates = runtimeChoices.map((candidate) => buildHighlightModeCandidate(
    candidate.path,
    directValues.toObjectValue ?? directValues.documentValue ?? directValues.sourceValue ?? null,
    candidate.source,
    candidate.choices
  )).filter(Boolean);
  const directCandidate = buildHighlightModeCandidate(
    REGION_DEFAULT_HIGHLIGHT_MODE_FIELD,
    directValues.toObjectValue ?? directValues.documentValue ?? directValues.sourceValue ?? null,
    "region-document-direct",
    Object.fromEntries(runtimeChoices.flatMap((candidate) =>
      Object.entries(candidate.choices ?? {})
    ))
  );
  const candidates = [
    ...(directCandidate ? [directCandidate] : []),
    ...dataCandidates,
    ...runtimeCandidates,
    ...schemaCandidates
  ];
  const selectedCandidate =
    candidates.find((candidate) => candidate.path === REGION_DEFAULT_HIGHLIGHT_MODE_FIELD) ??
    candidates.find((candidate) => candidate.gridCoverageHighlightDetected) ??
    candidates.find((candidate) => candidate.authenticShapePreferred) ??
    candidates.find((candidate) => REGION_HIGHLIGHT_MODE_FIELD_PATTERN.test(candidate.path)) ??
    candidates[0] ??
    null;
  const mismatch = directValues.documentValue !== directValues.toObjectValue ||
    directValues.sourceValue !== directValues.toObjectValue;
  const authenticValue = selectAuthenticRegionHighlightValue(selectedCandidate, runtimeChoices);
  const detectedValue = directValues.toObjectValue ?? selectedCandidate?.value ?? null;
  const valueMatchesAuthentic = valuesAreEquivalent(detectedValue, authenticValue);

  return {
    fieldPath: selectedCandidate?.path ?? REGION_DEFAULT_HIGHLIGHT_MODE_FIELD,
    detectedValue,
    persistedValue: directValues.toObjectValue ?? null,
    sourceValue: directValues.sourceValue ?? null,
    documentValue: directValues.documentValue ?? null,
    toObjectValue: directValues.toObjectValue ?? null,
    mismatch,
    authenticValue,
    authenticShapePreferred: Boolean(selectedCandidate?.authenticShapePreferred || valueMatchesAuthentic),
    gridCoverageHighlightDetected: Boolean(selectedCandidate?.gridCoverageHighlightDetected),
    candidates: candidates.slice(0, 12),
    schemaCandidates: schemaCandidates.slice(0, 12),
    runtimeChoices
  };
}

function buildV14RegionDisplayCreateData({
  regionDocument = null,
  operation = "create"
} = {}) {
  const data = {};
  const highlightResolution = resolveRegionHighlightCreateData(regionDocument);
  const visibilityResolution = resolveRegionVisibilityCreateData();

  if (highlightResolution.fieldPath && highlightResolution.value !== null) {
    setDataPath(data, highlightResolution.fieldPath, highlightResolution.value);
  }
  if (visibilityResolution.fieldPath && visibilityResolution.value !== null) {
    setDataPath(data, visibilityResolution.fieldPath, visibilityResolution.value);
  }

  logV14RegionDiagnostic("regionHighlightSettingResolved", {
    operation,
    regionDocumentId: regionDocument?.id ?? null,
    regionHighlightSettingResolved: highlightResolution.settingValue,
    regionHighlightModeField: highlightResolution.fieldPath,
    regionHighlightModeRequestedValue: highlightResolution.value,
    regionHighlightModeApplied: Boolean(highlightResolution.fieldPath && highlightResolution.value !== null),
    regionHighlightModeFallback: highlightResolution.fallback,
    regionHighlightModeChoices: highlightResolution.choices
  });
  logV14RegionDiagnostic("regionVisibilitySettingResolved", {
    operation,
    regionDocumentId: regionDocument?.id ?? null,
    regionVisibilitySettingResolved: visibilityResolution.settingValue,
    regionVisibilityField: visibilityResolution.fieldPath,
    regionVisibilityValue: visibilityResolution.value,
    regionVisibilityApplied: Boolean(visibilityResolution.fieldPath && visibilityResolution.value !== null),
    regionVisibilityFallback: visibilityResolution.fallback,
    regionVisibilitySchemaChoices: visibilityResolution.choices
  });

  return data;
}

function resolveRegionHighlightCreateData(regionDocument = null) {
  const setting = resolveRegionHighlightModeSetting();
  const detection = detectRegionHighlightModeForDocument(regionDocument);
  const values = collectRegionHighlightModeValuesForSetting(detection, setting.value);
  const value = values[0] ?? null;
  return {
    settingValue: setting.value,
    fieldPath: value !== null ? detection.fieldPath : null,
    value,
    fallback: value === null,
    choices: detection.runtimeChoices
  };
}

function resolveRegionVisibilityCreateData() {
  const visibility = resolveRegionVisibilityValue();
  return {
    settingValue: visibility.settingValue,
    fieldPath: visibility.value !== null ? "visibility" : null,
    value: visibility.value,
    fallback: visibility.value === null,
    choices: visibility.choices
  };
}

function buildHighlightModeCandidate(path, value, source, choices = null) {
  const valueText = stringifyHighlightModeValue(value);
  const choiceValues = choices
    ? Object.keys(choices).concat(Object.values(choices)).map((choice) => String(choice))
    : [];
  const haystack = [path, valueText, ...choiceValues].join(" ");
  if (!REGION_HIGHLIGHT_FIELD_PATTERN.test(haystack)) {
    return null;
  }
  if (
    !REGION_HIGHLIGHT_MODE_FIELD_PATTERN.test(path) &&
    !REGION_AUTHENTIC_HIGHLIGHT_VALUE_PATTERN.test(haystack) &&
    !REGION_GRID_HIGHLIGHT_VALUE_PATTERN.test(haystack)
  ) {
    return null;
  }

  return {
    path,
    source,
    value,
    choices: choices ? duplicateData(choices) : null,
    authenticShapePreferred: REGION_AUTHENTIC_HIGHLIGHT_VALUE_PATTERN.test(haystack),
    gridCoverageHighlightDetected: REGION_GRID_HIGHLIGHT_VALUE_PATTERN.test(haystack)
  };
}

function collectRegionHighlightSchemaCandidates(regionDocument) {
  const roots = [
    regionDocument?.schema,
    regionDocument?.constructor?.schema,
    regionDocument?.constructor?.metadata,
    globalThis.CONFIG?.Region?.documentClass?.schema,
    globalThis.CONFIG?.Region?.documentClass?.metadata
  ].filter(Boolean);
  const candidates = [];
  const visited = new WeakSet();

  for (const root of roots) {
    collectSchemaCandidatesFromValue(root, "", candidates, visited, 0);
  }

  return candidates;
}

function collectSchemaCandidatesFromValue(value, path, candidates, visited, depth) {
  if (!value || typeof value !== "object" || depth > 5 || visited.has(value)) {
    return;
  }
  visited.add(value);

  const choices = value.choices ?? value.options?.choices ?? null;
  const fieldName = value.name ?? value.fieldName ?? null;
  const candidatePath = fieldName ? joinDataPath(path, fieldName) : path;
  const candidate = buildHighlightModeCandidate(
    candidatePath,
    value.default ?? value.initial ?? value.value ?? null,
    "region-schema",
    choices
  );
  if (candidate?.path) {
    candidates.push(candidate);
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "function") {
      continue;
    }
    const nextPath = key === "fields" ? path : joinDataPath(path, key);
    collectSchemaCandidatesFromValue(child, nextPath, candidates, visited, depth + 1);
  }
}

function selectAuthenticRegionHighlightValue(candidate, runtimeChoices = []) {
  return collectAuthenticRegionHighlightModeValues({
    authenticValue: null,
    runtimeChoices,
    candidates: candidate ? [candidate] : []
  })[0] ?? null;
}

function resolveAuthenticRegionHighlightModeValue() {
  return collectAuthenticRegionHighlightModeValues({
    runtimeChoices: collectRegionHighlightModeRuntimeChoices()
  })[0] ?? null;
}

function collectAuthenticRegionHighlightModeValues(detection = {}) {
  const values = [];
  const addValue = (value) => {
    if (value === null || value === undefined) {
      return;
    }
    const stringValue = String(value).toLowerCase();
    if (stringValue === "shape") {
      return;
    }
    if (values.some((candidate) => valuesAreEquivalent(candidate, value))) {
      return;
    }
    values.push(value);
  };
  const choiceGroups = [
    ...Array.from(detection.runtimeChoices ?? []),
    ...Array.from(detection.candidates ?? []).filter((candidate) => candidate?.choices)
  ];

  for (const choiceGroup of choiceGroups) {
    for (const [key, value] of Object.entries(choiceGroup.choices ?? {})) {
      const keyMatches = REGION_AUTHENTIC_HIGHLIGHT_VALUE_PATTERN.test(String(key));
      const valueMatches = REGION_AUTHENTIC_HIGHLIGHT_VALUE_PATTERN.test(String(value));
      if (!keyMatches && !valueMatches) {
        continue;
      }

      if (String(choiceGroup.source ?? "").startsWith("CONST") || String(choiceGroup.source ?? "").startsWith("CONFIG")) {
        addValue(value);
        addValue(key);
      } else {
        addValue(key);
        addValue(value);
      }
    }
  }

  return values;
}

function collectRegionHighlightModeValuesForSetting(detection = {}, settingValue = REGION_HIGHLIGHT_SETTING_VALUES.authentic) {
  if (settingValue === REGION_HIGHLIGHT_SETTING_VALUES.grid) {
    const values = [];
    for (const choiceGroup of Array.from(detection.runtimeChoices ?? [])) {
      for (const [key, value] of Object.entries(choiceGroup.choices ?? {})) {
        const keyMatches = REGION_GRID_HIGHLIGHT_VALUE_PATTERN.test(String(key));
        const valueMatches = REGION_GRID_HIGHLIGHT_VALUE_PATTERN.test(String(value));
        if (keyMatches || valueMatches) {
          values.push(String(choiceGroup.source ?? "").startsWith("CONST") || String(choiceGroup.source ?? "").startsWith("CONFIG") ? value : key);
        }
      }
    }
    return Array.from(new Set(values));
  }

  const authenticValues = collectAuthenticRegionHighlightModeValues(detection);
  return authenticValues.length ? authenticValues : ["shapes"];
}

function isRegionHighlightModeAlreadySatisfied(detection = {}, settingValue = REGION_HIGHLIGHT_SETTING_VALUES.authentic) {
  if (settingValue === REGION_HIGHLIGHT_SETTING_VALUES.grid) {
    return Boolean(detection.gridCoverageHighlightDetected);
  }

  return Boolean(detection.authenticShapePreferred && !detection.gridCoverageHighlightDetected);
}

function resolveRegionHighlightModeSetting() {
  let storedValue = REGION_HIGHLIGHT_SETTING_VALUES.authentic;
  try {
    storedValue = game.settings.get(MODULE_ID, REGION_HIGHLIGHT_MODE_SETTING_KEY) ?? storedValue;
  } catch {
    storedValue = REGION_HIGHLIGHT_SETTING_VALUES.authentic;
  }

  return {
    value: String(storedValue ?? "").toLowerCase() === REGION_HIGHLIGHT_SETTING_VALUES.grid
      ? REGION_HIGHLIGHT_SETTING_VALUES.grid
      : REGION_HIGHLIGHT_SETTING_VALUES.authentic
  };
}

async function applyV14RegionVisibilitySetting(regionDocument, {
  entryPoint = null,
  operation = null,
  runtimeFlags = null
} = {}) {
  if (!regionDocument || typeof regionDocument.update !== "function") {
    return { applied: false, fallback: true, reason: "missing-region-document-or-update-api" };
  }

  const visibility = resolveRegionVisibilityValue();
  logV14RegionDiagnostic("regionVisibilitySettingResolved", {
    entryPoint,
    operation,
    regionDocumentId: regionDocument?.id ?? null,
    groupId: runtimeFlags?.groupId ?? null,
    partId: runtimeFlags?.partId ?? null,
    regionVisibilitySettingResolved: visibility.settingValue,
    regionVisibilitySchemaChoices: visibility.choices,
    regionVisibilityValue: visibility.value
  });
  logV14RegionDiagnostic("regionVisibilitySchemaChoices", {
    entryPoint,
    operation,
    regionDocumentId: regionDocument?.id ?? null,
    regionVisibilitySchemaChoices: visibility.choices
  });

  if (visibility.value === null) {
    logV14RegionDiagnostic("regionVisibilityFallback", {
      entryPoint,
      operation,
      regionDocumentId: regionDocument?.id ?? null,
      regionVisibilityFallback: true,
      regionVisibilityFallbackReason: "no-valid-region-visibility-value"
    });
    return { applied: false, fallback: true, reason: "no-valid-region-visibility-value" };
  }

  if (regionDocument.visibility === visibility.value || regionDocument?.toObject?.()?.visibility === visibility.value) {
    logV14RegionDiagnostic("regionVisibilityApplied", {
      entryPoint,
      operation,
      regionDocumentId: regionDocument?.id ?? null,
      regionVisibilityApplied: true,
      regionVisibilityValue: visibility.value,
      regionVisibilityAppliedReason: "already-matches-setting"
    });
    return { applied: true, fallback: false, value: visibility.value };
  }

  try {
    await regionDocument.update({ visibility: visibility.value });
    logV14RegionDiagnostic("regionVisibilityApplied", {
      entryPoint,
      operation,
      regionDocumentId: regionDocument?.id ?? null,
      regionVisibilityApplied: true,
      regionVisibilityValue: visibility.value
    });
    return { applied: true, fallback: false, value: visibility.value };
  } catch (caughtError) {
    logV14RegionDiagnostic("regionVisibilityFallback", {
      entryPoint,
      operation,
      regionDocumentId: regionDocument?.id ?? null,
      regionVisibilityFallback: true,
      regionVisibilityFallbackReason: caughtError?.message ?? "unknown"
    });
    return { applied: false, fallback: true, reason: caughtError?.message ?? "unknown" };
  }
}

function resolveRegionVisibilityValue() {
  let storedValue = REGION_VISIBILITY_SETTING_VALUES.gamemaster;
  try {
    storedValue = game.settings.get(MODULE_ID, REGION_VISIBILITY_SETTING_KEY) ?? storedValue;
  } catch {
    storedValue = REGION_VISIBILITY_SETTING_VALUES.gamemaster;
  }
  const settingValue = String(storedValue ?? "").toLowerCase();
  const visibilityConst = globalThis.CONST?.REGION_VISIBILITY ?? {};
  const value = settingValue === REGION_VISIBILITY_SETTING_VALUES.always
    ? visibilityConst.ALWAYS
    : settingValue === REGION_VISIBILITY_SETTING_VALUES.layer
      ? visibilityConst.LAYER
      : visibilityConst.GAMEMASTER;

  return {
    settingValue: Object.values(REGION_VISIBILITY_SETTING_VALUES).includes(settingValue)
      ? settingValue
      : REGION_VISIBILITY_SETTING_VALUES.gamemaster,
    value: Number.isFinite(Number(value)) ? value : null,
    choices: duplicateData(visibilityConst)
  };
}

function setDataPath(target, path, value) {
  if (!target || !path) {
    return target;
  }
  const parts = String(path).split(".").filter(Boolean);
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    cursor[key] = cursor[key] && typeof cursor[key] === "object" ? cursor[key] : {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
  return target;
}

function readRegionHighlightModeValues(regionDocument) {
  const objectData = duplicateData(regionDocument?.toObject?.() ?? {});
  return {
    documentValue: regionDocument?.[REGION_DEFAULT_HIGHLIGHT_MODE_FIELD] ?? null,
    sourceValue: regionDocument?._source?.[REGION_DEFAULT_HIGHLIGHT_MODE_FIELD] ?? null,
    toObjectValue: objectData?.[REGION_DEFAULT_HIGHLIGHT_MODE_FIELD] ?? null
  };
}

function collectRegionHighlightModeRuntimeChoices(regionDocument = null) {
  const candidates = [];
  const pushChoices = (path, choices, source) => {
    if (!choices || typeof choices !== "object") {
      return;
    }
    const normalizedChoices = duplicateData(choices);
    const haystack = [path, ...Object.keys(normalizedChoices), ...Object.values(normalizedChoices)].join(" ");
    if (!REGION_HIGHLIGHT_FIELD_PATTERN.test(haystack)) {
      return;
    }
    candidates.push({
      path: REGION_DEFAULT_HIGHLIGHT_MODE_FIELD,
      source,
      choices: normalizedChoices
    });
  };

  pushChoices("CONST.REGION_HIGHLIGHT_MODES", globalThis.CONST?.REGION_HIGHLIGHT_MODES, "CONST.REGION_HIGHLIGHT_MODES");
  pushChoices("CONST.REGION_HIGHLIGHT_MODE", globalThis.CONST?.REGION_HIGHLIGHT_MODE, "CONST.REGION_HIGHLIGHT_MODE");
  pushChoices("CONFIG.Region.highlightModes", globalThis.CONFIG?.Region?.highlightModes, "CONFIG.Region.highlightModes");
  pushChoices("CONFIG.Region.highlightMode", globalThis.CONFIG?.Region?.highlightMode, "CONFIG.Region.highlightMode");

  const schemaCandidates = collectRegionHighlightSchemaCandidates(regionDocument)
    .filter((candidate) => candidate.path === REGION_DEFAULT_HIGHLIGHT_MODE_FIELD && candidate.choices);
  for (const candidate of schemaCandidates) {
    candidates.push({
      path: REGION_DEFAULT_HIGHLIGHT_MODE_FIELD,
      source: candidate.source,
      choices: duplicateData(candidate.choices)
    });
  }

  return candidates.slice(0, 12);
}

function queueRegionHighlightModeVerification(regionDocument, context = {}) {
  const verify = () => {
    const detection = detectRegionHighlightModeForDocument(regionDocument);
    logV14RegionDiagnostic("regionHighlightModeDetected", {
      ...context,
      entryPoint: `${context.entryPoint ?? "unknown"}:post-create-verification`,
      regionDocumentId: regionDocument?.id ?? null,
      regionHighlightModeField: detection.fieldPath,
      regionHighlightModeRequestedValue: context.regionHighlightModeRequestedValue ?? null,
      regionHighlightModePersistedValue: detection.persistedValue,
      regionHighlightModeSourceValue: detection.sourceValue,
      regionHighlightModeDocumentValue: detection.documentValue,
      regionHighlightModeToObjectValue: detection.toObjectValue,
      regionHighlightModeMismatch: detection.mismatch,
      regionHighlightModeDetected: detection.detectedValue,
      authenticShapePreferred: detection.authenticShapePreferred,
      gridCoverageHighlightDetected: detection.gridCoverageHighlightDetected,
      highlightModeRuntimeChoices: detection.runtimeChoices
    });
  };
  globalThis.setTimeout?.(verify, 50);
}

function stringifyHighlightModeValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (_caughtError) {
    return "";
  }
}

function valuesAreEquivalent(left, right) {
  return left === right || String(left) === String(right);
}

function joinDataPath(prefix, key) {
  if (!key) {
    return prefix;
  }
  return prefix ? `${prefix}.${key}` : String(key);
}

function detectRegionHighlightModeContext() {
  const candidates = collectHighlightModeSettingCandidates();
  const joinedValues = candidates
    .map((candidate) => String(candidate.value ?? candidate.default ?? candidate.key ?? "").toLowerCase())
    .join(" ");
  const authenticShapePreferred = /\bauthentic\b|\btrue[-_\s]?shape\b|\bshape\b|\bgeometry\b/.test(joinedValues);
  const gridCoverageHighlightDetected = /\bgrid\b|\bcell\b|\bcovered\b|\bcoverage\b|\bsquare\b/.test(joinedValues);

  return {
    regionHighlightModeDetected: candidates.length ? candidates[0]?.value ?? candidates[0]?.default ?? null : null,
    authenticShapePreferred,
    gridCoverageHighlightDetected,
    visualMismatchLikelyFromHighlightMode: gridCoverageHighlightDetected && !authenticShapePreferred,
    highlightModeCandidates: candidates
  };
}

function collectHighlightModeSettingCandidates() {
  const settings = globalThis.game?.settings?.settings;
  const entries = settings instanceof Map
    ? Array.from(settings.entries())
    : Object.entries(settings ?? {});
  const pattern = /(region|template|highlight|grid|cell|shape|coverage|covered)/i;
  const candidates = [];

  for (const [id, setting] of entries) {
    const namespace = setting?.namespace ?? String(id).split(".")[0] ?? null;
    const key = setting?.key ?? String(id).split(".").slice(1).join(".") ?? String(id);
    const haystack = [
      id,
      namespace,
      key,
      setting?.name,
      setting?.hint,
      setting?.default,
      ...Object.keys(setting?.choices ?? {}),
      ...Object.values(setting?.choices ?? {})
    ].filter(Boolean).join(" ");
    if (!pattern.test(haystack)) {
      continue;
    }

    let value = null;
    try {
      value = namespace && key ? globalThis.game?.settings?.get(namespace, key) : null;
    } catch (_caughtError) {
      value = null;
    }

    candidates.push({
      id: String(id),
      namespace,
      key,
      value,
      default: setting?.default ?? null,
      choices: duplicateData(setting?.choices ?? null)
    });
  }

  return candidates.slice(0, 12);
}

function summarizeShapePoints(points) {
  if (!Array.isArray(points)) {
    return {
      kind: points ? typeof points : "none",
      length: null,
      count: null,
      points: null,
      preview: null
    };
  }

  if (points.every((point) => typeof point === "number")) {
    return {
      kind: "flat-number-array",
      length: points.length,
      count: Math.floor(points.length / 2),
      points: points.slice(),
      preview: points.slice(0, 12)
    };
  }

  if (points.every((point) => point && typeof point === "object" && !Array.isArray(point))) {
    return {
      kind: "xy-object-array",
      length: points.length,
      count: points.length,
      points: points.map((point) => ({
        x: coerceNumber(point?.x, null),
        y: coerceNumber(point?.y, null)
      })),
      preview: points.slice(0, 6).map((point) => ({
        x: coerceNumber(point?.x, null),
        y: coerceNumber(point?.y, null)
      }))
    };
  }

  if (points.every((point) => Array.isArray(point))) {
    return {
      kind: "xy-tuple-array",
      length: points.length,
      count: points.length,
      points: points.map((point) => Array.from(point)),
      preview: points.slice(0, 6)
    };
  }

  return {
    kind: "mixed-array",
    length: points.length,
    count: points.length,
    points: duplicateData(points),
    preview: points.slice(0, 6)
  };
}

function stringifyShapeSummary(summary) {
  try {
    return JSON.stringify(summary);
  } catch (_caughtError) {
    return "<unserializable-shape-summary>";
  }
}

function compareRingShapeSummaries(payloadShapes, createdShapes) {
  const payload = Array.from(payloadShapes ?? []);
  const created = Array.from(createdShapes ?? []);
  const rejectedFields = new Set();
  const comparedCount = Math.max(payload.length, created.length);

  for (let index = 0; index < comparedCount; index += 1) {
    const payloadShape = payload[index] ?? {};
    const createdShape = created[index] ?? {};
    for (const key of Array.from(payloadShape.keys ?? [])) {
      if (!Array.from(createdShape.keys ?? []).includes(key)) {
        rejectedFields.add(key);
      }
    }
  }

  const mismatch =
    payload.length !== created.length ||
    payload.some((payloadShape, index) => {
      const createdShape = created[index] ?? {};
      return (
        payloadShape.type !== createdShape.type ||
        payloadShape.hole !== createdShape.hole ||
        payloadShape.pointCount !== createdShape.pointCount ||
        payloadShape.pointsKind !== createdShape.pointsKind
      );
    });

  return {
    ringShapePreserved: !mismatch,
    ringShapeMismatch: mismatch,
    ringShapeRejectedFields: Array.from(rejectedFields).sort()
  };
}

function summarizeRegionDocumentShapes(regionDocument) {
  const shapes =
    duplicateData(regionDocument?.toObject?.()?.shapes) ??
    duplicateData(regionDocument?.shapes?.contents?.map((shape) => shape.toObject?.() ?? shape)) ??
    [];
  return summarizeFoundryRegionShapes(shapes);
}

function summarizeCreatedRegionDocument(regionDocument) {
  const objectData = duplicateData(regionDocument?.toObject?.()) ?? {};
  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const shapes = summarizeFoundryRegionShapes(objectData.shapes ?? []);
  return {
    id: regionDocument?.id ?? objectData._id ?? null,
    uuid: regionDocument?.uuid ?? null,
    name: regionDocument?.name ?? objectData.name ?? null,
    partId: runtime.partId ?? null,
    partIndex: runtime.partIndex ?? null,
    partCount: runtime.partCount ?? null,
    groupId: runtime.groupId ?? null,
    shapeCount: shapes.length,
    shapes
  };
}

async function ensureV14RingSegmentsVisible(regionDocuments = [], {
  entryPoint = null,
  source = null,
  templateDocument = null,
  groupId = null,
  partId = null,
  ringOperationId = null
} = {}) {
  for (const regionDocument of Array.from(regionDocuments ?? [])) {
    if (!regionDocument || typeof regionDocument.update !== "function") {
      continue;
    }

    const visibilityBefore = summarizeV14RingSegmentVisibility([regionDocument]);
    const updateData = {};
    if (regionDocument.hidden === true || regionDocument.toObject?.()?.hidden === true) {
      updateData.hidden = false;
    }
    if (!regionDocument.color && !regionDocument.toObject?.()?.color) {
      updateData.color = DEFAULT_REGION_COLOR;
    }

    if (Object.keys(updateData).length) {
      try {
        await regionDocument.update(updateData);
      } catch (caughtError) {
        logV14RegionDiagnostic("ringSegmentVisibilityUpdateFailed", {
          entryPoint,
          source,
          templateId: templateDocument?.id ?? null,
          regionDocumentId: regionDocument?.id ?? null,
          groupId,
          partId,
          ringOperationId,
          updateData,
          reason: caughtError?.message ?? "unknown",
          ...visibilityBefore
        });
      }
    }
  }
}

async function refreshV14RingCanvasLayerIfNeeded(regionDocuments = [], {
  entryPoint = null,
  source = null,
  templateDocument = null,
  groupId = null,
  partId = null,
  ringOperationId = null
} = {}) {
  const visibility = summarizeV14RingSegmentVisibility(regionDocuments);
  const hasSceneDocuments = Array.from(visibility.ringSegmentExistsInScene ?? []).some((entry) => entry.existsInScene);
  const missingCanvasObjects = Array.from(visibility.ringSegmentCanvasObjectFound ?? []).some((entry) => !entry.canvasObjectFound);
  if (!hasSceneDocuments || !missingCanvasObjects) {
    return false;
  }

  const regionsLayer = canvas?.regions ?? null;
  const refreshMethod =
    typeof regionsLayer?.draw === "function"
      ? "draw"
      : typeof regionsLayer?.refresh === "function"
        ? "refresh"
        : typeof regionsLayer?.render === "function"
          ? "render"
          : null;
  if (!refreshMethod) {
    logV14RegionDiagnostic("ringCanvasLayerRefreshSkipped", {
      entryPoint,
      source,
      templateId: templateDocument?.id ?? null,
      groupId,
      partId,
      ringOperationId,
      reason: "no-refresh-method",
      ...visibility
    });
    return false;
  }

  try {
    await regionsLayer[refreshMethod]();
    logV14RegionDiagnostic("ringCanvasLayerRefreshAttempted", {
      entryPoint,
      source,
      templateId: templateDocument?.id ?? null,
      groupId,
      partId,
      ringOperationId,
      refreshMethod,
      ...visibility
    });
    return true;
  } catch (caughtError) {
    logV14RegionDiagnostic("ringCanvasLayerRefreshFailed", {
      entryPoint,
      source,
      templateId: templateDocument?.id ?? null,
      groupId,
      partId,
      ringOperationId,
      refreshMethod,
      reason: caughtError?.message ?? "unknown",
      ...visibility
    });
    return false;
  }
}

function summarizeV14RingSegmentVisibility(regionDocuments = []) {
  const segmentSummaries = Array.from(regionDocuments ?? []).map((regionDocument) => {
    const scene = regionDocument?.parent ?? canvas?.scene ?? null;
    const sceneRegion = findSceneRegionById(scene, regionDocument?.id ?? null);
    const effectiveRegion = sceneRegion ?? regionDocument;
    const objectData = duplicateData(effectiveRegion?.toObject?.()) ?? {};
    const canvasObject = findCanvasRegionObject(effectiveRegion);
    const shapes = summarizeRegionDocumentShapes(effectiveRegion);
    const bounds = calculateRegionBoundsFromShapes(objectData.shapes ?? []);
    const hidden = Boolean(effectiveRegion?.hidden ?? objectData.hidden);
    const destroyed = Boolean(effectiveRegion?._destroyed ?? effectiveRegion?.destroyed);
    const existsInScene = Boolean(sceneRegion);
    const wasDeleted = !existsInScene;
    const wasReplaced = Boolean(
      sceneRegion &&
      regionDocument?.uuid &&
      sceneRegion?.uuid &&
      sceneRegion.uuid !== regionDocument.uuid
    );
    const visible = !hidden && !destroyed;
    const canvasVisible = canvasObject
      ? Boolean(canvasObject.visible ?? canvasObject.renderable ?? true)
      : false;
    const canvasRenderable = canvasObject
      ? Boolean(canvasObject.renderable ?? canvasObject.visible ?? true)
      : false;

    return {
      regionId: effectiveRegion?.id ?? regionDocument?.id ?? objectData._id ?? null,
      uuid: effectiveRegion?.uuid ?? regionDocument?.uuid ?? null,
      existsInScene,
      wasDeleted,
      wasReplaced,
      hidden,
      destroyed,
      visible,
      bounds,
      shapes,
      highlightMode: readRegionHighlightModeValues(regionDocument),
      color: regionDocument?.color ?? objectData.color ?? null,
      alpha: regionDocument?.alpha ?? objectData.alpha ?? canvasObject?.alpha ?? null,
      layerVisible: Boolean(canvas?.regions?.visible ?? canvas?.regions?.renderable ?? true),
      canvasObjectFound: Boolean(canvasObject),
      canvasRenderable,
      canvasVisible
    };
  });

  return {
    ringSegmentSummaries: segmentSummaries,
    ringSegmentHidden: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      hidden: segment.hidden
    })),
    ringSegmentExistsInScene: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      existsInScene: segment.existsInScene
    })),
    ringSegmentExistsAfterDelay: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      existsAfterDelay: segment.existsInScene
    })),
    ringSegmentWasDeleted: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      wasDeleted: segment.wasDeleted
    })),
    ringSegmentWasReplaced: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      wasReplaced: segment.wasReplaced
    })),
    ringSegmentDestroyed: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      destroyed: segment.destroyed
    })),
    ringSegmentVisible: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      visible: segment.visible
    })),
    ringSegmentBounds: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      bounds: segment.bounds
    })),
    ringSegmentShapes: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      shapes: segment.shapes
    })),
    ringSegmentHighlightMode: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      highlightMode: segment.highlightMode
    })),
    ringSegmentColor: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      color: segment.color
    })),
    ringSegmentAlpha: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      alpha: segment.alpha
    })),
    ringSegmentLayerVisible: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      layerVisible: segment.layerVisible
    })),
    ringSegmentCanvasObjectFound: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      canvasObjectFound: segment.canvasObjectFound
    })),
    ringSegmentCanvasRenderable: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      canvasRenderable: segment.canvasRenderable
    })),
    ringSegmentCanvasVisible: segmentSummaries.map((segment) => ({
      regionId: segment.regionId,
      canvasVisible: segment.canvasVisible
    }))
  };
}

function summarizeV14RingPostCreateState(regionIds = [], {
  scene = null,
  originalRegions = [],
  nativeRegionId = null
} = {}) {
  const regions = Array.from(regionIds ?? []).map((regionId) =>
    findSceneRegionById(scene, regionId) ??
    Array.from(originalRegions ?? []).find((region) => region?.id === regionId) ??
    { id: regionId }
  );
  const visibility = summarizeV14RingSegmentVisibility(regions);
  const documentRegionIds = Array.from(visibility.ringSegmentExistsInScene ?? [])
    .filter((entry) => entry.existsInScene)
    .map((entry) => entry.regionId)
    .filter(Boolean);
  const canvasFoundRegionIds = Array.from(visibility.ringSegmentCanvasObjectFound ?? [])
    .filter((entry) => entry.canvasObjectFound)
    .map((entry) => entry.regionId)
    .filter(Boolean);
  const actuallyVisibleIds = Array.from(visibility.ringSegmentCanvasVisible ?? [])
    .filter((entry) => entry.canvasVisible)
    .map((entry) => entry.regionId)
    .filter(Boolean);
  const documentVisibleIds = Array.from(visibility.ringSegmentVisible ?? [])
    .filter((entry) => entry.visible)
    .map((entry) => entry.regionId)
    .filter(Boolean);
  const nativeRegion = nativeRegionId
    ? findSceneRegionById(scene, nativeRegionId) ??
      Array.from(originalRegions ?? []).find((region) => region?.id === nativeRegionId) ??
      null
    : null;
  const nativeCanvasObject = findCanvasRegionObject(nativeRegion);

  return {
    ...visibility,
    ringFinalDocumentRegionIds: documentRegionIds,
    ringFinalCanvasFoundRegionIds: canvasFoundRegionIds,
    ringFinalActuallyVisibleRegionIds: actuallyVisibleIds,
    ringFinalVisibleRegionIds: actuallyVisibleIds,
    ringFinalDocumentVisibleRegionIds: documentVisibleIds,
    ringNativeRegionVisible: nativeRegion
      ? !Boolean(nativeRegion?.hidden ?? nativeRegion?.toObject?.()?.hidden) &&
        !Boolean(nativeRegion?._destroyed ?? nativeRegion?.destroyed)
      : false,
    ringNativeRegionBounds: nativeRegion
      ? calculateRegionBoundsFromShapes(nativeRegion?.toObject?.()?.shapes ?? [])
      : null,
    ringNativeRegionCanvasObjectFound: Boolean(nativeCanvasObject),
    ringNativeRegionCanvasRenderable: nativeCanvasObject
      ? Boolean(nativeCanvasObject.renderable ?? nativeCanvasObject.visible ?? true)
      : false,
    ringNativeRegionCanvasVisible: nativeCanvasObject
      ? Boolean(nativeCanvasObject.visible ?? nativeCanvasObject.renderable ?? true)
      : false
  };
}

function logRingVisibilityScalarState(state = {}, {
  nativeRegionId = null,
  nativeRegionRetained = false,
  groupId = null,
  partId = null,
  ringOperationId = null
} = {}) {
  const segments = Array.from(state.ringSegmentSummaries ?? []);
  const segmentCount = segments.length;
  const count = (predicate) => segments.filter(predicate).length;
  const sceneFound = count((segment) => segment.existsInScene);
  const existsAfterDelay = count((segment) => segment.existsInScene);
  const canvasFound = count((segment) => segment.canvasObjectFound);
  const canvasVisible = count((segment) => segment.canvasVisible);
  const hidden = count((segment) => segment.hidden);
  const deleted = count((segment) => segment.wasDeleted);
  const replaced = count((segment) => segment.wasReplaced);

  logRingVisibilityLine(`ringVisibilitySummary: segmentCount=${segmentCount} sceneFound=${sceneFound} existsAfterDelay=${existsAfterDelay} canvasFound=${canvasFound} canvasVisible=${canvasVisible} hidden=${hidden} deleted=${deleted} replaced=${replaced} groupId=${groupId ?? "null"} partId=${partId ?? "null"} ringOperationId=${ringOperationId ?? "null"}`);
  for (const segment of segments) {
    logRingVisibilityLine(`ringSegmentVisibility: id=${segment.regionId ?? "null"} existsInScene=${segment.existsInScene} existsAfterDelay=${segment.existsInScene} canvasObjectFound=${segment.canvasObjectFound} canvasRenderable=${segment.canvasRenderable} canvasVisible=${segment.canvasVisible} hidden=${segment.hidden} deleted=${segment.wasDeleted} replaced=${segment.wasReplaced}`);
  }
  logRingVisibilityLine(`ringFinalVisibleRegionIds: ${Array.from(state.ringFinalVisibleRegionIds ?? []).join(",") || "(none)"}`);
  logRingVisibilityLine(`ringFinalDocumentRegionIds: ${Array.from(state.ringFinalDocumentRegionIds ?? []).join(",") || "(none)"}`);
  logRingVisibilityLine(`ringFinalCanvasFoundRegionIds: ${Array.from(state.ringFinalCanvasFoundRegionIds ?? []).join(",") || "(none)"}`);
  logRingVisibilityLine(`ringFinalActuallyVisibleRegionIds: ${Array.from(state.ringFinalActuallyVisibleRegionIds ?? []).join(",") || "(none)"}`);
  logRingVisibilityLine(`ringNativeVisibility: id=${nativeRegionId ?? "null"} retained=${Boolean(nativeRegionRetained)} canvasObjectFound=${Boolean(state.ringNativeRegionCanvasObjectFound)} canvasRenderable=${Boolean(state.ringNativeRegionCanvasRenderable)} canvasVisible=${Boolean(state.ringNativeRegionCanvasVisible)} hidden=${!Boolean(state.ringNativeRegionVisible)}`);
}

function findCanvasRegionObject(regionDocument) {
  if (!regionDocument) {
    return null;
  }

  return (
    regionDocument.object ??
    canvas?.regions?.get?.(regionDocument.id) ??
    canvas?.regions?.placeables?.find((candidate) => candidate?.document?.id === regionDocument.id) ??
    canvas?.regions?.children?.find((candidate) => candidate?.document?.id === regionDocument.id) ??
    null
  );
}

function findCanvasDrawingObject(drawingDocument) {
  if (!drawingDocument) {
    return null;
  }

  return (
    drawingDocument.object ??
    canvas?.drawings?.get?.(drawingDocument.id) ??
    canvas?.drawings?.placeables?.find((candidate) => candidate?.document?.id === drawingDocument.id) ??
    canvas?.drawings?.children?.find((candidate) => candidate?.document?.id === drawingDocument.id) ??
    null
  );
}

function findSceneRegionById(scene, regionId) {
  if (!scene || !regionId) {
    return null;
  }

  return (
    scene?.regions?.get?.(regionId) ??
    scene?.regions?.contents?.find((region) => region?.id === regionId) ??
    Array.from(scene?.regions?.values?.() ?? []).find((region) => region?.id === regionId) ??
    null
  );
}

function findSceneDrawingById(scene, drawingId) {
  if (!scene || !drawingId) {
    return null;
  }

  return (
    scene?.drawings?.get?.(drawingId) ??
    scene?.drawings?.contents?.find((drawing) => drawing?.id === drawingId) ??
    Array.from(scene?.drawings?.values?.() ?? []).find((drawing) => drawing?.id === drawingId) ??
    null
  );
}

function listSceneRegions(scene = canvas?.scene ?? null) {
  if (!scene?.regions) {
    return [];
  }
  if (Array.isArray(scene.regions.contents)) {
    return Array.from(scene.regions.contents);
  }
  if (typeof scene.regions.values === "function") {
    return Array.from(scene.regions.values());
  }
  return Array.from(scene.regions ?? []);
}

function listSceneDrawings(scene = canvas?.scene ?? null) {
  if (!scene?.drawings) {
    return [];
  }
  if (Array.isArray(scene.drawings.contents)) {
    return Array.from(scene.drawings.contents);
  }
  if (typeof scene.drawings.values === "function") {
    return Array.from(scene.drawings.values());
  }
  return Array.from(scene.drawings ?? []);
}

function getRingVisualOverlayFlags(drawingDocument) {
  const objectData = drawingDocument?.toObject?.() ?? {};
  return (
    drawingDocument?.getFlag?.(MODULE_ID, "ringVisualOverlay") ??
    drawingDocument?.flags?.[MODULE_ID]?.ringVisualOverlay ??
    drawingDocument?._source?.flags?.[MODULE_ID]?.ringVisualOverlay ??
    objectData?.flags?.[MODULE_ID]?.ringVisualOverlay ??
    null
  );
}

function isV14RingRuntimeFlags(runtimeFlags) {
  if (!runtimeFlags || typeof runtimeFlags !== "object") {
    return false;
  }
  const geometryType = String(runtimeFlags.geometryType ?? runtimeFlags.normalizedDefinition?.geometry?.type ?? "").toLowerCase();
  const strategy = String(runtimeFlags.regionSourceStrategy ?? "").toLowerCase();
  return geometryType === "ring" ||
    strategy.includes("ring") ||
    Number.isFinite(Number(runtimeFlags.regionSegmentIndex)) ||
    Number(runtimeFlags.regionSegmentCount ?? 0) > 1;
}

function summarizePartPlan(partPlan) {
  return {
    partId: partPlan?.partId ?? null,
    partIndex: partPlan?.partIndex ?? null,
    geometryType: partPlan?.geometryType ?? null,
    regionSourceStrategy: partPlan?.regionSourceStrategy ?? null,
    regionSegmentIndex: partPlan?.regionSegmentIndex ?? null,
    regionSegmentCount: partPlan?.regionSegmentCount ?? null,
    geometrySide: partPlan?.geometrySide ?? null,
    referencePartId: partPlan?.geometryReferencePartId ?? null,
    ringInnerRadius: partPlan?.geometryComputedInnerRadius ?? null,
    ringOuterRadius: partPlan?.geometryComputedOuterRadius ?? null,
    shapeCount: Array.from(partPlan?.regionData?.shapes ?? []).length
  };
}

function countRegionShapes(regionCreateData) {
  return Array.from(regionCreateData ?? []).reduce(
    (total, regionData) => total + Array.from(regionData?.shapes ?? []).length,
    0
  );
}

function logV14RegionDiagnostic(message, data = undefined) {
  const payload = {
    forcedV14Diagnostic: true,
    foundryVersion: globalThis.game?.version ?? null,
    isFoundryV14OrNewer: isFoundryV14OrNewer(),
    ...(data && typeof data === "object" ? data : { value: data })
  };

  debug(message, payload);
  const method = selectDiagnosticConsoleMethod(message, payload);
  console[method]?.(`[${MODULE_ID}][v14-forced] ${message}`, payload);
}

function logRingCastDiagnostic(message, data = undefined) {
  const payload = {
    foundryVersion: globalThis.game?.version ?? null,
    isFoundryV14OrNewer: isFoundryV14OrNewer(),
    ...(data && typeof data === "object" ? data : { value: data })
  };
  const method = selectDiagnosticConsoleMethod(message, payload);
  console[method]?.(`[${MODULE_ID}][ring-cast] ${message}`, payload);
}

function selectDiagnosticConsoleMethod(message, payload = {}) {
  const text = [
    String(message ?? ""),
    String(payload?.reason ?? ""),
    String(payload?.skippedReason ?? ""),
    String(payload?.skippedV14PathBecause ?? "")
  ].join(" ").toLowerCase();
  if (/(failed|failure|error|exception|invalid|rejected|mismatch|writefailed)/.test(text)) {
    return "warn";
  }
  if (/(success|created|completed|applied|selected|prepared|verified|detected|resolved|attempt|start)/.test(text)) {
    return "info";
  }
  return "debug";
}

function logRingVisibilityLine(message) {
  console.info(`[${MODULE_ID}][ring-visibility] ${message}`);
}

function logV14PipelineStep(step, label, data = {}) {
  if (!isFoundryV14OrNewer()) {
    return;
  }

  const payload = data && typeof data === "object" ? data : { value: data };
  const templateType = payload.detectedTemplateTypeRaw ?? payload.templateType ?? "null";
  const profileId = payload.profileId ?? "null";
  const profileType = payload.profileType ?? "null";
  const requestedShapeType = payload.requestedShapeType ?? "null";
  const serializerUsed = payload.serializerUsed ?? "null";
  const payloadShapeType = payload.payloadShapeType ?? payload.createdShapeType ?? "null";
  const entryPoint = payload.entryPoint ?? payload.hook ?? "unknown";
  console.info(
    `[${MODULE_ID}][pipeline] PIPELINE ${step} ${label} | entryPoint=${entryPoint} | templateType=${templateType} | profileId=${profileId} | profileType=${profileType} | requestedShapeType=${requestedShapeType} | serializer=${serializerUsed} | payload.shape.type=${payloadShapeType}`,
    payload
  );
}

function logGeometrySource({
  entryPoint = null,
  source = null,
  regionDocumentId = null,
  templateId = null,
  detectedTemplateTypeRaw = null,
  profileId = null,
  geometryFromProfile = null,
  geometryFromTemplate = null,
  geometrySelected = null,
  serializerSelected = null,
  factorySelected = null
} = {}) {
  if (!isFoundryV14OrNewer()) {
    return;
  }

  console.info(
    `[${MODULE_ID}][geometry-source] GEOMETRY SOURCE | entryPoint=${entryPoint ?? "unknown"} | templateId=${templateId ?? "null"} | profileId=${profileId ?? "null"} | geometryFromProfile=${geometryFromProfile ?? "null"} | geometryFromTemplate=${geometryFromTemplate ?? detectedTemplateTypeRaw ?? "null"} | geometrySelected=${geometrySelected ?? "null"} | serializerSelected=${serializerSelected ?? "null"} | factorySelected=${factorySelected ?? "null"}`,
    {
      entryPoint,
      source,
      regionDocumentId,
      templateId,
      detectedTemplateTypeRaw,
      profileId,
      geometryFromProfile,
      geometryFromTemplate,
      geometrySelected,
      serializerSelected,
      factorySelected
    }
  );
}

function buildCastOperationId(regionDocument = null) {
  return [
    "pz",
    "cast",
    regionDocument?.parent?.id ?? canvas?.scene?.id ?? "scene",
    regionDocument?.id ?? "source",
    Date.now().toString(36)
  ].join(":");
}

function logCastAuditLine(label, {
  operationId = null,
  sourceRegionId = null,
  finalRegionId = null,
  itemUuid = null,
  profileId = null,
  sourceShapeType = null,
  selectedGeometryType = null,
  reason = null
} = {}) {
  console.info(
    `[${MODULE_ID}][cast-audit] ${label} | operationId=${operationId ?? "null"} | sourceRegionId=${sourceRegionId ?? "null"} | finalRegionId=${finalRegionId ?? "null"} | itemUuid=${itemUuid ?? "null"} | profileId=${profileId ?? "null"} | sourceShapeType=${sourceShapeType ?? "null"} | selectedGeometryType=${selectedGeometryType ?? "null"}${reason ? ` | reason=${reason}` : ""}`
  );
}

function getRegionPipelineShapeTypes(regionDocument) {
  return Array.from(summarizeRegionDocumentRawShapes(regionDocument) ?? [])
    .map((shape) => shape?.type ?? null)
    .filter(Boolean);
}

function summarizeRegionDocumentForPipeline(regionDocument) {
  if (!regionDocument) {
    return null;
  }
  const runtimeFlags = getRegionRuntimeFlags(regionDocument);
  return {
    id: regionDocument?.id ?? null,
    uuid: regionDocument?.uuid ?? null,
    name: regionDocument?.name ?? null,
    documentName: regionDocument?.documentName ?? null,
    hidden: Boolean(regionDocument?.hidden ?? regionDocument?.toObject?.()?.hidden),
    shapeTypes: getRegionPipelineShapeTypes(regionDocument),
    shapes: summarizeRegionDocumentShapes(regionDocument),
    runtimeGeometryType: runtimeFlags?.geometryType ?? null,
    regionSourceStrategy: runtimeFlags?.regionSourceStrategy ?? null,
    groupId: runtimeFlags?.groupId ?? null,
    partId: runtimeFlags?.partId ?? null
  };
}

function getRegionShapeSerializerName(shape) {
  switch (shape?.type) {
    case "circle":
      return "serializeNativeCircleShape";
    case "cone":
      return "serializeNativeConeShape";
    case "ellipse":
      return "serializeNativeEllipseShape";
    case "emanation":
      return "serializeNativeEmanationShape";
    case "line":
      return "serializeNativeLineShape";
    case "polygon":
      return "serializeNativePolygonShape";
    case "rectangle":
      return "serializeNativeRectangleShape";
    case "ring":
      return "serializeNativeRingShape";
    default:
      return shape?.type ? "duplicateDataFallback" : null;
  }
}

function logV14RegionEntry(message, data = undefined) {
  const payload = buildV14BranchPayload(data);
  debug(message, payload);
  console.info(`[${MODULE_ID}][v14-entry] ${message}`, payload);
}

function logV14RegionBranch(message, data = undefined) {
  const payload = buildV14BranchPayload(data);
  debug(message, payload);
  const skippedReason = payload.skippedReason ?? payload.skippedV14PathBecause ?? payload.reason ?? "unspecified";
  const entryPoint = payload.entryPoint ?? payload.hook ?? "unknown-entry";
  const selectedCompatibilityPath = payload.selectedCompatibilityPath ?? payload.fallbackPathSelected ?? "unknown-path";
  console.warn(
    `[${MODULE_ID}][v14-branch] ${message}: ${skippedReason} | entryPoint=${entryPoint} | selectedCompatibilityPath=${selectedCompatibilityPath}`,
    payload
  );
}

function buildV14BranchPayload(data = undefined) {
  const source = data && typeof data === "object" ? data : { value: data };
  const skippedReason = source.skippedReason ?? source.skippedV14PathBecause ?? source.reason ?? null;
  return {
    foundryCoreVersion: globalThis.game?.version ?? null,
    foundryVersion: globalThis.game?.version ?? null,
    isV14: isFoundryV14OrNewer(),
    isFoundryV14OrNewer: isFoundryV14OrNewer(),
    skippedV14PathBecause: skippedReason,
    skippedReason,
    ...source
  };
}

function selectRegionFactoryCompatibilityPath({
  templateDocument = null,
  scene = null,
  groupPlan = null,
  operation = "create"
} = {}) {
  if (!isFoundryV14OrNewer()) {
    return "legacy-foundry-v13-compatible-path";
  }

  if (!templateDocument) {
    return "v14-skipped-missing-template";
  }

  if (!scene) {
    return "v14-skipped-missing-scene";
  }

  const geometryTypes = Array.from(groupPlan?.parts ?? [])
    .map((partPlan) => String(partPlan?.geometryType ?? "").toLowerCase())
    .filter(Boolean);

  if (geometryTypes.some((geometryType) => geometryType.includes("ring"))) {
    return `v14-${operation}-ring-native-region-path`;
  }

  if (Array.from(groupPlan?.parts ?? []).length > 1) {
    return `v14-${operation}-multipart-region-group-path`;
  }

  return `v14-${operation}-template-driven-region-path`;
}

function isFoundryV14OrNewer() {
  const majorVersion = Number.parseInt(String(globalThis.game?.version ?? "0").split(".")[0], 10);
  return Number.isFinite(majorVersion) && majorVersion >= 14;
}

function buildTemplateDiagnostics(templateDocument) {
  return {
    foundryCoreVersion: globalThis.game?.version ?? null,
    isV14: isFoundryV14OrNewer(),
    sourceDocumentType: templateDocument?.documentName ?? null,
    templateDetected: Boolean(templateDocument?.t ?? null) || templateDocument?.documentName === "MeasuredTemplate",
    regionGeometryType: null,
    templateType: getTemplateType(templateDocument),
    v14CompatibilityPath: isFoundryV14OrNewer()
      ? "hybrid-template-source-region-runtime"
      : "template-source-region-runtime"
  };
}

function buildRectShapesFromDocument(templateDocument) {
  const rectShape = getFoundryRectShape(templateDocument);
  if (rectShape) {
    const finalShape = normalizeRectangleShape({
      type: "rectangle",
      x: (templateDocument.x ?? 0) + rectShape.x,
      y: (templateDocument.y ?? 0) + rectShape.y,
      width: rectShape.width,
      height: rectShape.height,
      rotation: 0
    });

    logRectShapeDecision(templateDocument, {
      builder: "document-rect-foundry",
      accepted: true,
      anchor: "template-origin-corner",
      finalShape
    });

    return logBuiltShapes(templateDocument, "document-rect-foundry", [finalShape], finalShape);
  }

  const diagonalPixels = distanceToPixels(templateDocument.distance, templateDocument.parent);
  const size = diagonalPixels > 0 ? diagonalPixels / Math.SQRT2 : 0;

  if (!size || size <= 0) {
    logRectShapeDecision(templateDocument, {
      builder: "document-rect-fallback",
      accepted: false,
      anchor: "template-origin-corner",
      reason: "Template distance did not produce a positive square size.",
      finalShape: null
    });
    return [];
  }

  const finalShape = {
    type: "rectangle",
    x: coerceNumber(templateDocument.x, 0),
    y: coerceNumber(templateDocument.y, 0),
    width: size,
    height: size,
    rotation: 0
  };

  logRectShapeDecision(templateDocument, {
    builder: "document-rect-fallback",
    accepted: true,
    anchor: "template-origin-corner",
    finalShape
  });

  return logBuiltShapes(templateDocument, "document-rect-fallback", [finalShape], finalShape);
}

function hasPixiCircleShape(shape) {
  return shape && typeof shape.radius === "number" && typeof shape.x === "number" && typeof shape.y === "number";
}

function hasPixiRectangleShape(shape) {
  return (
    shape &&
    typeof shape.width === "number" &&
    typeof shape.height === "number" &&
    typeof shape.x === "number" &&
    typeof shape.y === "number" &&
    !Array.isArray(shape.points) &&
    typeof shape.radius !== "number"
  );
}

function hasFlatPoints(points) {
  return (Array.isArray(points) || ArrayBuffer.isView(points)) && Number(points.length) >= 6;
}

function logBuiltShapes(templateDocument, builder, shapes, details = undefined) {
  debug("Using Region shape builder.", {
    templateId: templateDocument?.id ?? null,
    templateType: getTemplateType(templateDocument),
    builder,
    details
  });

  return shapes;
}

function buildRegionName(normalizedDefinition, sourceContext) {
  const itemName = sourceContext.item?.name ?? normalizedDefinition.label ?? "Persistent Zone";
  const casterName = sourceContext.caster?.name ?? sourceContext.actor?.name ?? null;
  const baseName = casterName ? `${itemName}(${casterName})` : itemName;
  const partId = normalizedDefinition?.part?.id ?? null;
  const partCount = coerceNumber(normalizedDefinition?.group?.partCount, 1);

  if (partId && partCount > 1) {
    return `${baseName} [${partId}]`;
  }

  return baseName;
}

function buildTerrainBehaviorName(normalizedDefinition, sourceContext) {
  const regionName = buildRegionName(normalizedDefinition, sourceContext);
  return `${regionName} Difficult Terrain`;
}

async function syncLinkedDocumentsSafely({
  templateDocument,
  regionDocument,
  normalizedDefinition = null,
  shapes = null,
  stage = "sync-region"
} = {}) {
  try {
    return await syncLinkedDocumentsForRegion({
      templateDocument,
      regionDocument,
      normalizedDefinition,
      shapes,
      reason: stage
    });
  } catch (caughtError) {
    error("Failed to sync linked documents for managed Region.", caughtError, {
      templateId: templateDocument?.id ?? null,
      regionId: regionDocument?.id ?? null,
      stage
    });
    return {
      wallIds: [],
      lightIds: [],
      syncApplied: false
    };
  }
}

function duplicateLinkedDocuments(linkedDocuments) {
  const wallIds = Array.isArray(linkedDocuments?.wallIds)
    ? Array.from(new Set(linkedDocuments.wallIds.filter(Boolean)))
    : [];
  const lightIds = Array.isArray(linkedDocuments?.lightIds)
    ? Array.from(new Set(linkedDocuments.lightIds.filter(Boolean)))
    : [];

  return { wallIds, lightIds };
}

function collectRelevantTemplateUpdateKeys(changed) {
  const flattened = flattenObject(changed);
  const relevantPrefixes = ["x", "y", "distance", "direction", "angle", "width", "t", "elevation"];

  return Object.keys(flattened).filter((key) =>
    relevantPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))
  );
}

function buildTemplateSyncKey(templateDocument) {
  return `${templateDocument?.parent?.id ?? "scene"}::${templateDocument?.id ?? "template"}`;
}

function flattenObject(value, prefix = "", result = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) {
      result[prefix] = value;
    }
    return result;
  }

  const entries = Object.entries(value);
  if (!entries.length && prefix) {
    result[prefix] = value;
    return result;
  }

  for (const [key, nestedValue] of entries) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (nestedValue && typeof nestedValue === "object" && !Array.isArray(nestedValue)) {
      flattenObject(nestedValue, nextPrefix, result);
    } else {
      result[nextPrefix] = nestedValue;
    }
  }

  return result;
}

function getFoundryRectShape(templateDocument) {
  const objectClass =
    CONFIG?.MeasuredTemplate?.objectClass ??
    canvas?.templates?.constructor?.placeableClass ??
    null;

  if (typeof objectClass?.getRectShape !== "function") {
    return null;
  }

  try {
    return objectClass.getRectShape(
      coerceNumber(templateDocument.distance, 0),
      coerceNumber(templateDocument.direction, 0)
    );
  } catch (caughtError) {
    debug("Foundry rect shape helper failed.", {
      templateId: templateDocument?.id ?? null,
      error: caughtError?.message ?? "unknown"
    });
    return null;
  }
}

function normalizeRectangleShape(shape) {
  const x = coerceNumber(shape.x, 0);
  const y = coerceNumber(shape.y, 0);
  const width = coerceNumber(shape.width, 0);
  const height = coerceNumber(shape.height, 0);

  return {
    type: "rectangle",
    x: width >= 0 ? x : x + width,
    y: height >= 0 ? y : y + height,
    width: Math.abs(width),
    height: Math.abs(height),
    rotation: coerceNumber(shape.rotation, 0)
  };
}

function buildRingBandShapesFromRadii(templateDocument, {
  innerRadius,
  outerRadius,
  segments
}, {
  builder,
  rejectionMessage,
  detailOverrides = {},
  centerX = null,
  centerY = null,
  radiiInPixels = false
} = {}) {
  const outerRadiusPixels = radiiInPixels
    ? coerceNumber(outerRadius, 0)
    : distanceToPixels(coerceNumber(outerRadius, 0), templateDocument?.parent ?? null);
  const innerRadiusPixels = radiiInPixels
    ? coerceNumber(innerRadius, 0)
    : distanceToPixels(coerceNumber(innerRadius, 0), templateDocument?.parent ?? null);
  const segmentCount = Math.min(
    Math.max(Math.round(coerceNumber(segments, DEFAULT_RING_SEGMENTS)), 8),
    64
  );
  const resolvedCenterX = coerceNumber(centerX, coerceNumber(templateDocument?.x, 0));
  const resolvedCenterY = coerceNumber(centerY, coerceNumber(templateDocument?.y, 0));

  if (!outerRadiusPixels || outerRadiusPixels <= 0 || innerRadiusPixels < 0 || innerRadiusPixels >= outerRadiusPixels) {
    debug(rejectionMessage ?? "Rejected Region shape build for unsupported ring band geometry.", {
      templateId: templateDocument?.id ?? null,
      templateType: getTemplateType(templateDocument),
      builder,
      details: {
        innerRadius,
        outerRadius,
        innerRadiusPixels,
        outerRadiusPixels,
        segmentCount,
        ...detailOverrides
      }
    });
    return [];
  }

  const shapes = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const startAngle = (index / segmentCount) * Math.PI * 2;
    const endAngle = ((index + 1) / segmentCount) * Math.PI * 2;
    shapes.push({
      type: "polygon",
      points: sanitizePolygonPoints([
        resolvedCenterX + Math.cos(startAngle) * outerRadiusPixels,
        resolvedCenterY + Math.sin(startAngle) * outerRadiusPixels,
        resolvedCenterX + Math.cos(endAngle) * outerRadiusPixels,
        resolvedCenterY + Math.sin(endAngle) * outerRadiusPixels,
        resolvedCenterX + Math.cos(endAngle) * innerRadiusPixels,
        resolvedCenterY + Math.sin(endAngle) * innerRadiusPixels,
        resolvedCenterX + Math.cos(startAngle) * innerRadiusPixels,
        resolvedCenterY + Math.sin(startAngle) * innerRadiusPixels
      ]),
      hole: false
    });
  }
  const serializedShapes = buildFoundryRegionShapes(shapes);
  const serializedShapeSummary = summarizeFoundryRegionShapes(serializedShapes);
  const ringGeometryStrategy = "multi-polygon-segments";

  logV14RegionDiagnostic("ringSerializedShape", {
    templateId: templateDocument?.id ?? null,
    templateType: getTemplateType(templateDocument),
    builder,
    centerX: resolvedCenterX,
    centerY: resolvedCenterY,
    innerRadius,
    outerRadius,
    innerRadiusPixels,
    outerRadiusPixels,
    segmentCount,
    ringGeometryStrategy,
    ringSegmentCount: segmentCount,
    ringSegmentShapeSummary: serializedShapeSummary,
    ringSegmentShapeSummaryJson: stringifyShapeSummary(serializedShapeSummary),
    ringGeometryDetected: true,
    ringInnerRadius: innerRadiusPixels,
    ringOuterRadius: outerRadiusPixels,
    ringSerializedShape: serializedShapeSummary,
    ringSerializedShapeJson: stringifyShapeSummary(serializedShapeSummary),
    ringSerializedShapeRawJson: stringifyShapeSummary(serializedShapes),
    polygonPointsFormat: "flat-number-array",
    polygonPointCount: 4,
    regionShapeCount: serializedShapes.length,
    v14RingCompatibilityPath: isFoundryV14OrNewer()
      ? "multi-simple-polygons-ring-band"
      : "multi-simple-polygons-ring-band",
    ...detailOverrides
  });

  return shapes;
}

function resolveSideOfRingReferenceBand(templateDocument, geometry, allParts = [], referenceShapes = null) {
  const referencePartId = geometry?.referencePartId ?? null;
  if (referencePartId) {
    const nativeRingShape = Array.from(referenceShapes ?? []).find((shape) =>
      String(shape?.type ?? "").toLowerCase() === "ring"
    );
    if (nativeRingShape) {
      const radius = Math.max(0, coerceNumber(nativeRingShape.radius, 0));
      const innerWidth = Math.max(0, coerceNumber(nativeRingShape.innerWidth, 0));
      const outerWidth = Math.max(0, coerceNumber(nativeRingShape.outerWidth, 0));
      const innerRadius = Math.max(0, radius - innerWidth);
      const outerRadius = radius + outerWidth;
      if (outerRadius > innerRadius) {
        return {
          centerX: coerceNumber(nativeRingShape.x, coerceNumber(templateDocument?.x, 0)),
          centerY: coerceNumber(nativeRingShape.y, coerceNumber(templateDocument?.y, 0)),
          innerRadius,
          outerRadius,
          radiusUnit: "pixels",
          referenceRadiusMode: "native-ring-shape",
          segments: geometry?.segments ?? DEFAULT_RING_SEGMENTS
        };
      }
    }
    const referencePart = allParts.find((part) => part?.id === referencePartId);
    const referenceGeometry = referencePart?.geometry ?? null;

    if (referenceGeometry?.type === "ring") {
      const resolvedRadii = resolveRingBandRadiiForTemplate(templateDocument, referenceGeometry);
      return {
        innerRadius: resolvedRadii.innerRadius,
        outerRadius: resolvedRadii.outerRadius,
        templateRadius: resolvedRadii.templateRadius,
        referenceRadiusMode: referenceGeometry.referenceRadiusMode ?? null,
        wallThickness: coerceNumber(referenceGeometry.wallThickness, coerceNumber(referenceGeometry.thickness, null)),
        thickness: coerceNumber(referenceGeometry.thickness, null),
        segments: referenceGeometry.segments ?? DEFAULT_RING_SEGMENTS
      };
    }
  }

  const fallbackOuterRadius = coerceNumber(geometry?.referenceOuterRadius, null);
  if (fallbackOuterRadius === null) {
    return null;
  }

  return {
    innerRadius: coerceNumber(geometry?.referenceInnerRadius, 0),
    outerRadius: fallbackOuterRadius,
    templateRadius: coerceNumber(geometry?.templateRadius, null),
    referenceRadiusMode: geometry?.referenceRadiusMode ?? null,
    wallThickness: coerceNumber(geometry?.wallThickness, coerceNumber(geometry?.thickness, null)),
    thickness: coerceNumber(geometry?.thickness, null),
    segments: geometry?.segments ?? DEFAULT_RING_SEGMENTS
  };
}

function degreesToRadians(value) {
  return (coerceNumber(value, 0) * Math.PI) / 180;
}

function logRectShapeDecision(templateDocument, {
  builder,
  accepted,
  anchor,
  finalShape,
  reason = null
}) {
  debug(accepted ? "Accepted Region rect builder." : "Rejected Region rect builder.", {
    templateId: templateDocument?.id ?? null,
    templateType: getTemplateType(templateDocument),
    builder,
    template: {
      x: templateDocument?.x ?? null,
      y: templateDocument?.y ?? null,
      distance: templateDocument?.distance ?? null,
      direction: templateDocument?.direction ?? null,
      angle: templateDocument?.angle ?? null
    },
    anchor,
    finalShape,
    reason
  });
}
