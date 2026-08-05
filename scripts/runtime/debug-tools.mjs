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
import { inspectZoneTriggeredActivity } from "./activity-compatibility.mjs";
import { inspectManagedRingRegions as inspectManagedRingRegionsRuntime } from "./region-factory.mjs";
import {
  getZoneDefinitionFromItem,
  normalizeZoneDefinition
} from "./zone-definition.mjs";

const V14_DEBUG_TEST_PRESETS = Object.freeze([
  "simple-damage-circle",
  "simple-heal-circle",
  "ring-damage",
  "wall-heated-line-left",
  "wall-heated-line-right",
  "wall-heated-ring-inner",
  "wall-heated-ring-outer",
  "stop-on-enter-test",
  "stop-on-move-test",
  "linked-light-test",
  "linked-walls-test",
  "difficult-terrain-test"
]);
const BUILD_SIGNATURE = "v14-runtime-audit-2026-08-05-01";
const BUILD_GIT_BRANCH = "codex-v14-first-phase-1";
const BUILD_GIT_HASH = "91c51b3";

export function createPersistentZonesDebugApi() {
  return Object.freeze({
    buildInfo,
    listTestPresets,
    buildTestDefinition,
    applyTestDefinitionToItem,
    clearTestDefinitionFromItem,
    inspectItemDefinition,
    inspectZoneTriggerActivities,
    inspectSelectedVariant,
    inspectTemplateSource,
    inspectManagedRingRegions,
    inspectSelectedRegion,
    createNativeRingFromSelectedRegion,
    markNextMovement
  });
}

export function buildInfo() {
  return {
    moduleVersion: game.modules.get(MODULE_ID)?.version ?? null,
    buildSignature: BUILD_SIGNATURE,
    gitBranch: BUILD_GIT_BRANCH,
    gitHash: BUILD_GIT_HASH,
    foundryVersion: game.version ?? null,
    systemVersion: game.system?.version ?? null,
    loadedArchitecture: "v14-runtime-audit",
    loadedFileMarkers: [
      "scripts/module.mjs:BUILD SIGNATURE",
      "scripts/runtime/region-factory.mjs:REGION FACTORY SIGNATURE",
      "scripts/runtime/debug-tools.mjs:buildInfo",
      "scripts/runtime/debug-tools.mjs:createNativeRingFromSelectedRegion"
    ]
  };
}

export function inspectSelectedRegion() {
  if (!assertDebugGM("inspectSelectedRegion")) {
    return null;
  }

  const regionDocument = getSelectedRegionDocument();
  if (!regionDocument) {
    return {
      ok: false,
      error: "No selected Region found."
    };
  }

  const objectData = duplicateData(regionDocument.toObject?.() ?? {});
  return {
    ok: true,
    id: regionDocument.id ?? null,
    uuid: regionDocument.uuid ?? null,
    name: regionDocument.name ?? null,
    shapes: duplicateData(objectData.shapes ?? regionDocument.shapes ?? []),
    flags: duplicateData(objectData.flags ?? regionDocument.flags ?? {}),
    visibility: objectData.visibility ?? regionDocument.visibility ?? null,
    highlightMode: objectData.highlightMode ?? regionDocument.highlightMode ?? null,
    source: simplifyDocumentObject(objectData)
  };
}

export async function createNativeRingFromSelectedRegion({
  innerWidth = 80,
  outerWidth = 80,
  color = "#28cc74"
} = {}) {
  if (!assertDebugGM("createNativeRingFromSelectedRegion")) {
    return null;
  }

  const sourceRegion = getSelectedRegionDocument();
  const scene = sourceRegion?.parent ?? canvas?.scene ?? null;
  if (!sourceRegion || !scene || typeof scene.createEmbeddedDocuments !== "function") {
    return {
      ok: false,
      error: "No selected Region with a writable parent Scene found."
    };
  }

  const shape = Array.from(sourceRegion.toObject?.()?.shapes ?? sourceRegion.shapes ?? [])[0] ?? {};
  const center = resolveRegionShapeCenter(shape, sourceRegion);
  const radius = resolveRegionShapeRadius(shape);
  const payload = {
    name: "PZ DEBUG NATIVE RING",
    color,
    visibility: 4,
    highlightMode: "shapes",
    shapes: [{
      type: "ring",
      x: center.x,
      y: center.y,
      radius,
      innerWidth,
      outerWidth,
      hole: false,
      gridBased: false
    }]
  };

  console.info(`[${MODULE_ID}] DEBUG createNativeRingFromSelectedRegion payload`, payload);
  const created = await scene.createEmbeddedDocuments("Region", [payload], {
    persistentZonesDebugNativeRingFromSelectedRegion: true
  });
  const createdRegion = created?.[0] ?? null;
  const createdObject = duplicateData(createdRegion?.toObject?.() ?? {});
  return {
    ok: Boolean(createdRegion),
    sourceRegionId: sourceRegion.id ?? null,
    createdRegionId: createdRegion?.id ?? null,
    payload,
    createdShape: duplicateData(Array.from(createdObject.shapes ?? [])[0] ?? null)
  };
}

export function inspectManagedRingRegions(options = {}) {
  if (!assertDebugGM("inspectManagedRingRegions")) {
    return null;
  }
  return inspectManagedRingRegionsRuntime(options);
}

export function listTestPresets() {
  if (!assertDebugGM("listTestPresets")) {
    return [];
  }

  return Array.from(V14_DEBUG_TEST_PRESETS);
}

export function buildTestDefinition(preset = "basic") {
  if (!assertDebugGM("buildTestDefinition")) {
    return null;
  }

  const normalizedPreset = String(preset || "basic").toLowerCase();
  switch (normalizedPreset) {
    case "simple-damage-circle":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createEntryDamageSaveTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Simple Damage Circle"
      }));
    case "simple-heal-circle":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createSimpleHealCircleTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Simple Heal Circle"
      }));
    case "ring-damage":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingDamageTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Ring Damage"
      }));
    case "wall-heated-line-left":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createWallHeatedTestDefinition("left", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Wall Heated Line Left",
        heatedPartId: "heated-side-left"
      }));
    case "wall-heated-line-right":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createWallHeatedTestDefinition("right", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Wall Heated Line Right",
        heatedPartId: "heated-side-right"
      }));
    case "wall-heated-ring-inner":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("inner", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Wall Heated Ring Inner",
        heatedPartId: "heated-side-inner"
      }));
    case "wall-heated-ring-outer":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("outer", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Wall Heated Ring Outer",
        heatedPartId: "heated-side-outer"
      }));
    case "stop-on-enter-test":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createEntryDamageSaveTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Stop On Enter"
      }));
    case "stop-on-move-test":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createMoveDamageTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Stop On Move",
        movementMode: "any"
      }));
    case "linked-light-test":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createLinkedLightTestDefinition("glow", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Linked Light Test"
      }));
    case "linked-walls-test":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createLinkedWallsTestDefinition("solid", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Linked Walls Test"
      }));
    case "difficult-terrain-test":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createDifficultTerrainTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Difficult Terrain Test"
      }));
    case "fire-wall-line-left":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createWallHeatedTestDefinition("left", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Fire Wall Line Left",
        heatedPartId: "heated-side-left"
      }));
    case "fire-wall-line-right":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createWallHeatedTestDefinition("right", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Fire Wall Line Right",
        heatedPartId: "heated-side-right"
      }));
    case "fire-wall-ring-inner":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("inner", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Fire Wall Ring Inner",
        heatedPartId: "heated-side-inner"
      }));
    case "fire-wall-ring-outer":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("outer", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Fire Wall Ring Outer",
        heatedPartId: "heated-side-outer"
      }));
    case "ring-heated-inner":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("inner"));
    case "ring-heated-outer":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("outer"));
    case "ring-wall-inner-heat":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("inner", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Ring Wall Inner Heat"
      }));
    case "ring-wall-outer-heat":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("outer", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Ring Wall Outer Heat"
      }));
    case "ring-wall-outer-edge-inner-heat":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("inner", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Ring Wall Inner Heat"
      }));
    case "ring-wall-outer-edge-outer-heat":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("outer", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Ring Wall Outer Heat"
      }));
    case "ring-wall-inner-edge-inner-heat":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("inner", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Ring Wall Inner Heat"
      }));
    case "ring-wall-inner-edge-outer-heat":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("outer", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Ring Wall Outer Heat"
      }));
    case "ring-wall-centerline-inner-heat":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("inner", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Ring Wall Inner Heat"
      }));
    case "ring-wall-centerline-outer-heat":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingHeatedTestDefinition("outer", {
        preset: normalizedPreset,
        label: "Persistent Zone Debug Ring Wall Outer Heat"
      }));
    case "variant-line-left":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createVariantDemoTestDefinition("line-left"));
    case "variant-line-right":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createVariantDemoTestDefinition("line-right"));
    case "variant-ring-inner":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createVariantDemoTestDefinition("ring-inner"));
    case "variant-ring-outer":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createVariantDemoTestDefinition("ring-outer"));
    case "wall-heated-left":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createWallHeatedTestDefinition("left"));
    case "wall-heated-right":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createWallHeatedTestDefinition("right"));
    case "line-side-left":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createLineSideTestDefinition("left"));
    case "line-side-right":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createLineSideTestDefinition("right"));
    case "ring-basic":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createRingBasicTestDefinition());
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
        label: "Persistent Zone Debug Entry Stop Movement"
      }));
    case "move-stop-movement":
      debug("Built persistent-zones debug preset.", { preset: normalizedPreset });
      return duplicateData(createMoveDamageTestDefinition({
        preset: normalizedPreset,
        label: "Persistent Zone Debug Move Stop Movement",
        movementMode: "any"
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

  const previousDefinition = getZoneDefinitionFromItem(item);
  if (previousDefinition) {
    await item.update({
      [`flags.${MODULE_ID}.-=${DEFINITION_FLAG_KEY}`]: null
    });

    debug("Cleared previous persistent-zones debug definition before replacement.", {
      itemUuid: item.uuid,
      itemName: item.name,
      previousPreset: previousDefinition?.source?.preset ?? null,
      previousSummary: summarizeDebugDefinition(previousDefinition)
    });
  }

  await item.update({
    [`flags.${MODULE_ID}.${DEFINITION_FLAG_KEY}`]: definition
  });

  const appliedDefinition = getZoneDefinitionFromItem(item) ?? definition;
  debug("Replaced persistent-zones debug definition on Item.", {
    itemUuid: item.uuid,
    itemName: item.name,
    preset: String(preset || "basic").toLowerCase(),
    replacedExistingDefinition: Boolean(previousDefinition),
    previousPreset: previousDefinition?.source?.preset ?? null,
    appliedSummary: summarizeDebugDefinition(appliedDefinition)
  });

  return {
    itemUuid: item.uuid,
    itemName: item.name,
    definition: appliedDefinition
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

export async function inspectZoneTriggerActivities(itemOrUuid) {
  if (!assertDebugGM("inspectZoneTriggerActivities")) {
    return null;
  }

  const item = await resolveItemDocument(itemOrUuid);
  if (!item) {
    debug("Could not resolve Item for persistent-zones zone-trigger activity inspect.", {
      itemOrUuid
    });
    return null;
  }

  const activities = Array.from(item?.system?.activities ?? [])
    .map((entry) => Array.isArray(entry) ? entry[1] : entry)
    .filter(Boolean)
    .map((activity) => inspectZoneTriggeredActivity(activity));

  debug("Inspected persistent-zones zone-trigger activities on Item.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityCount: activities.length,
    compatibleCount: activities.filter((activity) => activity.compatible).length,
    activities
  });

  return {
    itemUuid: item.uuid,
    itemName: item.name,
    activityCount: activities.length,
    compatibleCount: activities.filter((activity) => activity.compatible).length,
    activities
  };
}

export async function inspectSelectedVariant(itemOrUuid, options = {}) {
  if (!assertDebugGM("inspectSelectedVariant")) {
    return null;
  }

  const item = await resolveItemDocument(itemOrUuid);
  if (!item) {
    debug("Could not resolve Item for persistent-zones selected variant inspect.", {
      itemOrUuid,
      options
    });
    return null;
  }

  const rawDefinition = getZoneDefinitionFromItem(item);
  if (!rawDefinition) {
    const emptyResult = {
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

    debug("Inspected persistent-zones selected variant on Item without definition.", emptyResult);
    return emptyResult;
  }

  const inspectOptions = normalizeSelectedVariantInspectOptions(options);
  const resolvedTemplateType =
    inspectOptions.templateType ?? inferVariantInspectTemplateType(rawDefinition);
  const normalizedDefinition = normalizeZoneDefinition(rawDefinition, {
    item,
    actor: item.actor ?? null,
    templateDocument: buildVariantInspectTemplateDocument(resolvedTemplateType)
  });

  const result = {
    itemUuid: item.uuid,
    itemName: item.name,
    hasDefinition: true,
    templateType: resolvedTemplateType ?? null,
    availableVariants: normalizedDefinition.availableVariants ?? [],
    variantCount: normalizedDefinition.variantCount ?? 0,
    defaultVariant: normalizedDefinition.defaultVariantId ?? null,
    selectedVariant: normalizedDefinition.selectedVariantId ?? null,
    effectiveVariant: normalizedDefinition.selectedVariant ?? null,
    variantResolution: normalizedDefinition.variantResolution ?? null
  };

  debug("Inspected persistent-zones selected variant on Item.", {
    itemUuid: item.uuid,
    itemName: item.name,
    templateType: result.templateType,
    availableVariants: result.availableVariants,
    variantCount: result.variantCount,
    defaultVariant: result.defaultVariant,
    selectedVariant: result.selectedVariant,
    variantResolutionMode: result.variantResolution?.resolutionMode ?? "none",
    variantValidation: result.variantResolution ?? null,
    reasonsText: result.variantResolution?.reasonsText ?? ""
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

function getSelectedRegionDocument() {
  const controlled = Array.from(canvas?.regions?.controlled ?? []);
  const placeableDocument = controlled[0]?.document ?? null;
  if (placeableDocument?.documentName === "Region") {
    return placeableDocument;
  }

  const controlledPlaceables = Array.from(canvas?.regions?.placeables ?? [])
    .filter((placeable) => placeable?.controlled);
  const selectedPlaceableDocument = controlledPlaceables[0]?.document ?? null;
  if (selectedPlaceableDocument?.documentName === "Region") {
    return selectedPlaceableDocument;
  }

  const selectedIds = Array.from(canvas?.regions?._controlled ?? []);
  const selectedId = selectedIds[0]?.id ?? selectedIds[0] ?? null;
  if (selectedId) {
    return canvas?.scene?.regions?.get?.(selectedId) ?? null;
  }

  return null;
}

function resolveRegionShapeCenter(shape, regionDocument) {
  if (Number.isFinite(Number(shape?.x)) && Number.isFinite(Number(shape?.y))) {
    return {
      x: Number(shape.x),
      y: Number(shape.y)
    };
  }

  const bounds = shape?.bounds ?? regionDocument?.object?.bounds ?? null;
  if (bounds && Number.isFinite(Number(bounds.x)) && Number.isFinite(Number(bounds.y))) {
    return {
      x: Number(bounds.x) + Number(bounds.width ?? 0) / 2,
      y: Number(bounds.y) + Number(bounds.height ?? 0) / 2
    };
  }

  return {
    x: Number(regionDocument?.x ?? 0),
    y: Number(regionDocument?.y ?? 0)
  };
}

function resolveRegionShapeRadius(shape) {
  if (Number.isFinite(Number(shape?.radius)) && Number(shape.radius) > 0) {
    return Number(shape.radius);
  }
  if (Number.isFinite(Number(shape?.radiusX)) && Number(shape.radiusX) > 0) {
    return Number(shape.radiusX);
  }
  if (Number.isFinite(Number(shape?.width)) && Number(shape.width) > 0) {
    return Number(shape.width) / 2;
  }
  return 300;
}

function simplifyDocumentObject(objectData) {
  return {
    id: objectData?._id ?? objectData?.id ?? null,
    name: objectData?.name ?? null,
    type: objectData?.type ?? null,
    hidden: objectData?.hidden ?? null,
    visibility: objectData?.visibility ?? null,
    highlightMode: objectData?.highlightMode ?? null,
    shapes: duplicateData(objectData?.shapes ?? []),
    flags: duplicateData(objectData?.flags ?? {})
  };
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

function normalizeSelectedVariantInspectOptions(options) {
  if (typeof options === "string") {
    return {
      templateType: normalizeTemplateTypeOption(options)
    };
  }

  return {
    templateType: normalizeTemplateTypeOption(options?.templateType)
  };
}

function normalizeTemplateTypeOption(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

function buildVariantInspectTemplateDocument(templateType) {
  const normalizedTemplateType = normalizeTemplateTypeOption(templateType);
  if (!normalizedTemplateType) {
    return null;
  }

  return {
    t: normalizedTemplateType,
    distance: normalizedTemplateType === "circle" ? 20 : 30,
    width: ["ray", "rect"].includes(normalizedTemplateType) ? 5 : null,
    direction: 0,
    angle: normalizedTemplateType === "cone" ? 90 : null,
    elevation: 0
  };
}

function inferVariantInspectTemplateType(definition) {
  const directTemplateType = normalizeTemplateTypeOption(definition?.template?.type);
  if (directTemplateType) {
    return directTemplateType;
  }

  const variants = Array.isArray(definition?.variants) ? definition.variants : [];
  if (!variants.length) {
    return null;
  }

  const requestedVariantId = normalizeVariantLookupId(
    definition?.selectedVariant ??
      definition?.variantId ??
      definition?.variant ??
      definition?.defaultVariant ??
      definition?.defaultVariantId ??
      null
  );
  const matchedVariant = requestedVariantId
    ? variants.find((variant) => normalizeVariantLookupId(variant?.id ?? variant?.key ?? null) === requestedVariantId) ?? null
    : null;
  const preferredVariant = matchedVariant ?? variants[0] ?? null;

  return normalizeTemplateTypeOption(
    preferredVariant?.template?.type ??
      preferredVariant?.templateType ??
      preferredVariant?.shape ??
      null
  );
}

function normalizeVariantLookupId(value) {
  return String(value ?? "").trim().toLowerCase();
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
  label = "Persistent Zone Debug Entry Damage Save"
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

function createSimpleHealCircleTestDefinition({
  preset = "simple-heal-circle",
  label = "Persistent Zone Debug Simple Heal Circle"
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
        simpleEffect: {
          enabled: true,
          type: "heal",
          formula: "2d6"
        },
        damage: {
          enabled: false
        },
        save: {
          enabled: false
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
  movementMode
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

function createDifficultTerrainTestDefinition({
  preset = "difficult-terrain",
  label = "Persistent Zone Debug Difficult Terrain"
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

function createRingDamageTestDefinition({
  preset = "ring-damage",
  label = "Persistent Zone Debug Ring Damage"
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
    },
    parts: [
      {
        id: "ring-damage-band",
        label: "Persistent Zone Debug Ring Damage Band",
        geometry: buildCanonicalRingWallBodyGeometry(),
        triggers: {
          onEnter: {
            enabled: true,
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
      }
    ]
  };
}

function createRingBasicTestDefinition() {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: "ring-basic"
    },
    enabled: true,
    label: "Persistent Zone Debug Ring Basic",
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
        enabled: false
      },
      onStartTurn: {
        enabled: false
      },
      onEndTurn: {
        enabled: false
      }
    },
    parts: [
      {
        id: "ring",
        label: "Persistent Zone Debug Ring",
        geometry: {
          type: "ring",
          innerRadiusRatio: 0.5,
          segments: 24
        }
      }
    ]
  };
}

function createLineSideTestDefinition(side = "left") {
  const normalizedSide = String(side ?? "left").toLowerCase() === "right" ? "right" : "left";
  const titleSide = normalizedSide === "right" ? "Right" : "Left";
  const wallThickness = 5;
  const sideBandDepth = 10;

  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: `line-side-${normalizedSide}`
    },
    enabled: true,
    label: `Persistent Zone Debug Line Side ${titleSide}`,
    shapeMode: "template",
    template: {
      type: "ray",
      width: wallThickness
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
        enabled: false
      },
      onStartTurn: {
        enabled: false
      },
      onEndTurn: {
        enabled: false
      }
    },
    parts: [
      {
        id: "wall-body",
        label: "Persistent Zone Debug Wall Body",
        geometry: {
          type: "template"
        }
      },
      {
        id: `side-${normalizedSide}`,
        label: `Persistent Zone Debug Side ${titleSide}`,
        geometry: {
          type: "side-of-line",
          side: normalizedSide,
          offsetReference: "body-edge",
          offsetStart: 0,
          offsetEnd: sideBandDepth
        }
      }
    ]
  };
}

function createWallHeatedTestDefinition(side = "left", {
  preset = null,
  label = null,
  heatedPartId = "heated-side"
} = {}) {
  const normalizedSide = String(side ?? "left").toLowerCase() === "right" ? "right" : "left";
  const titleSide = normalizedSide === "right" ? "Right" : "Left";
  const wallThickness = 5;
  const heatBandDepth = 10;

  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: preset ?? `wall-heated-${normalizedSide}`
    },
    enabled: true,
    label: label ?? `Persistent Zone Debug Wall Heated ${titleSide}`,
    shapeMode: "template",
    template: {
      type: "ray",
      width: wallThickness
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
        enabled: false
      },
      onStartTurn: {
        enabled: false
      },
      onEndTurn: {
        enabled: false
      }
    },
    parts: [
      {
        id: "wall-body",
        label: "Persistent Zone Debug Wall Body",
        geometry: {
          type: "template"
        }
      },
      {
        id: heatedPartId,
        label: `Persistent Zone Debug Heated Side ${titleSide}`,
        geometry: {
          type: "side-of-line",
          side: normalizedSide,
          offsetReference: "body-edge",
          offsetStart: 0,
          offsetEnd: heatBandDepth
        },
        triggers: {
          onEnter: {
            enabled: true,
            damage: {
              enabled: true,
              formula: "3d8",
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
      }
    ]
  };
}

function createRingHeatedTestDefinition(side = "inner", {
  preset = null,
  label = null,
  heatedPartId = null
} = {}) {
  const normalizedSide = String(side ?? "inner").toLowerCase() === "outer" ? "outer" : "inner";
  const titleSide = normalizedSide === "outer" ? "Outer" : "Inner";
  const heatBandDepth = 10;
  const resolvedHeatedPartId = heatedPartId ?? `heated-side-${normalizedSide}`;

  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: preset ?? `ring-heated-${normalizedSide}`
    },
    enabled: true,
    label: label ?? `Persistent Zone Debug Ring Heated ${titleSide}`,
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
        enabled: false
      },
      onStartTurn: {
        enabled: false
      },
      onEndTurn: {
        enabled: false
      }
    },
    parts: [
      {
        id: "wall-body",
        label: "Persistent Zone Debug Ring Wall Body",
        geometry: buildCanonicalRingWallBodyGeometry()
      },
      {
        id: resolvedHeatedPartId,
        label: `Persistent Zone Debug Ring Heated Side ${titleSide}`,
        geometry: {
          type: "side-of-ring",
          side: normalizedSide,
          referencePartId: "wall-body",
          offsetReference: "body-edge",
          offsetStart: 0,
          offsetEnd: heatBandDepth,
          segments: 24
        },
        triggers: {
          onEnter: {
            enabled: true,
            damage: {
              enabled: true,
              formula: "3d8",
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
      }
    ]
  };
}

function buildCanonicalRingWallBodyGeometry({
  wallThickness = 5,
  segments = 24
} = {}) {
  return {
    type: "ring",
    referenceRadiusMode: "outer-edge",
    thickness: wallThickness,
    segments
  };
}

function createVariantDemoTestDefinition(selectedVariantId = "line-left") {
  const normalizedSelectedVariantId = normalizeVariantSelectionId(selectedVariantId);
  const lineLeftDefinition = createWallHeatedTestDefinition("left", {
    label: "Persistent Zone Debug Variant Line Left",
    heatedPartId: "heated-side-left"
  });
  const lineRightDefinition = createWallHeatedTestDefinition("right", {
    label: "Persistent Zone Debug Variant Line Right",
    heatedPartId: "heated-side-right"
  });
  const ringInnerDefinition = createRingHeatedTestDefinition("inner", {
    label: "Persistent Zone Debug Variant Ring Inner",
    heatedPartId: "heated-side-inner"
  });
  const ringOuterDefinition = createRingHeatedTestDefinition("outer", {
    label: "Persistent Zone Debug Variant Ring Outer",
    heatedPartId: "heated-side-outer"
  });

  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: `variant-${normalizedSelectedVariantId}`
    },
    enabled: true,
    label: "Persistent Zone Debug Variant Demo",
    shapeMode: "template",
    defaultVariant: "line-left",
    selectedVariant: normalizedSelectedVariantId,
    variants: [
      buildVariantDefinitionEntry("line-left", "Persistent Zone Debug Variant Line Left", lineLeftDefinition),
      buildVariantDefinitionEntry("line-right", "Persistent Zone Debug Variant Line Right", lineRightDefinition),
      buildVariantDefinitionEntry("ring-inner", "Persistent Zone Debug Variant Ring Inner", ringInnerDefinition),
      buildVariantDefinitionEntry("ring-outer", "Persistent Zone Debug Variant Ring Outer", ringOuterDefinition)
    ]
  };
}

function buildVariantDefinitionEntry(variantId, label, definition) {
  return {
    id: variantId,
    key: variantId,
    label,
    template: duplicateData(definition?.template ?? {}),
    targeting: duplicateData(definition?.targeting ?? {}),
    concentration: duplicateData(definition?.concentration ?? {}),
    terrain: duplicateData(definition?.terrain ?? {}),
    linkedWalls: duplicateData(definition?.linkedWalls ?? {}),
    linkedLight: duplicateData(definition?.linkedLight ?? {}),
    triggers: duplicateData(definition?.triggers ?? {}),
    parts: duplicateData(definition?.parts ?? [])
  };
}

function normalizeVariantSelectionId(value) {
  const normalized = String(value ?? "line-left").trim().toLowerCase();
  return ["line-left", "line-right", "ring-inner", "ring-outer"].includes(normalized)
    ? normalized
    : "line-left";
}

function createLinkedLightTestDefinition(linkedLightPreset = "glow", {
  preset = null,
  label = null
} = {}) {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: preset ?? `linked-light-${String(linkedLightPreset || "glow").toLowerCase()}`
    },
    enabled: true,
    label: label ?? `Persistent Zone Debug Linked Light ${toTitleCase(linkedLightPreset)}`,
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

function createLinkedWallsTestDefinition(linkedWallPreset = "solid", {
  preset = null,
  label = null
} = {}) {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "debug-preset",
      module: MODULE_ID,
      preset: preset ?? `linked-walls-${String(linkedWallPreset || "solid").toLowerCase()}`
    },
    enabled: true,
    label: label ?? `Persistent Zone Debug Linked Walls ${toTitleCase(linkedWallPreset)}`,
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

function summarizeDebugDefinition(definition) {
  if (!definition || typeof definition !== "object") {
    return {
      hasDefinition: false
    };
  }

  return {
    preset: definition?.source?.preset ?? null,
    defaultVariant: definition?.defaultVariant ?? definition?.defaultVariantId ?? null,
    selectedVariant: definition?.selectedVariant ?? definition?.variant ?? definition?.variantId ?? null,
    availableVariants: Array.isArray(definition.variants)
      ? definition.variants.map((variant) => variant?.id ?? variant?.key ?? null).filter(Boolean)
      : [],
    geometryType: definition?.geometry?.type ?? null,
    partCount: Array.isArray(definition.parts) ? definition.parts.length : 0,
    zoneCount: Array.isArray(definition.zones) ? definition.zones.length : 0,
    variantCount: Array.isArray(definition.variants) ? definition.variants.length : 0,
    hasSideOfLineGeometry:
      definition?.geometry?.type === "side-of-line" ||
      Array.isArray(definition.parts) &&
        definition.parts.some((part) => part?.geometry?.type === "side-of-line") ||
      Array.isArray(definition.zones) &&
        definition.zones.some((part) => part?.geometry?.type === "side-of-line"),
    hasSideOfRingGeometry:
      definition?.geometry?.type === "side-of-ring" ||
      Array.isArray(definition.parts) &&
        definition.parts.some((part) => part?.geometry?.type === "side-of-ring") ||
      Array.isArray(definition.zones) &&
        definition.zones.some((part) => part?.geometry?.type === "side-of-ring"),
    hasRingGeometry:
      definition?.geometry?.type === "ring" ||
      Array.isArray(definition.parts) &&
        definition.parts.some((part) => part?.geometry?.type === "ring") ||
      Array.isArray(definition.zones) &&
        definition.zones.some((part) => part?.geometry?.type === "ring")
  };
}
