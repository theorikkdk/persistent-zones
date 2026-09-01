import { ATTACHED_EMANATION_BEHAVIOR_TYPE, MODULE_ID, RUNTIME_FLAG_KEY } from "../constants.mjs";
import { applyConfiguredTriggerEffect, cleanupWhileInsideStatusesForRegionToken } from "./entry-effects.mjs";
import {
  consumeNativeRegionEventMovementMode,
  managedMovementModeMatches
} from "./entry-runtime.mjs";
import {
  getRegionRuntimeFlags,
  isPrimaryGM,
  testTokenInsideManagedRegion
} from "./utils.mjs";

const attachedTransitionStates = new WeakMap();
const attachedTransitionStateUpdates = new WeakMap();

export function registerAttachedEmanationRegionBehavior() {
  const Base = globalThis.foundry?.data?.regionBehaviors?.RegionBehaviorType;
  if (!Base || !globalThis.CONFIG?.RegionBehavior?.dataModels) return false;

  class PersistentZoneAttachedEmanationBehavior extends Base {
    static defineSchema() { return {}; }

    static events = {
      [globalThis.CONST.REGION_EVENTS.TOKEN_ENTER]: async function(event) {
        await handleAttachedRegionTransition(this.region, event, "onEnter");
      },
      [globalThis.CONST.REGION_EVENTS.TOKEN_EXIT]: async function(event) {
        await handleAttachedRegionTransition(this.region, event, "onExit");
      }
    };
  }

  CONFIG.RegionBehavior.dataModels[ATTACHED_EMANATION_BEHAVIOR_TYPE] = PersistentZoneAttachedEmanationBehavior;
  CONFIG.RegionBehavior.typeIcons ??= {};
  CONFIG.RegionBehavior.typeIcons[ATTACHED_EMANATION_BEHAVIOR_TYPE] = "fa-solid fa-podcast";
  const registration = getAttachedEmanationBehaviorRegistration();
  return registration.valid;
}

export function getAttachedEmanationBehaviorRegistration() {
  const dataModel = globalThis.CONFIG?.RegionBehavior?.dataModels?.[ATTACHED_EMANATION_BEHAVIOR_TYPE] ?? null;
  let documentTypes = [];
  try {
    documentTypes = globalThis.CONFIG?.RegionBehavior?.documentClass?.TYPES
      ?? Object.keys(globalThis.game?.model?.RegionBehavior ?? {});
  } catch (_error) {
    documentTypes = Object.keys(globalThis.game?.model?.RegionBehavior ?? {});
  }
  const documentTypeRegistered = Array.from(documentTypes ?? []).includes(ATTACHED_EMANATION_BEHAVIOR_TYPE);
  return {
    type: ATTACHED_EMANATION_BEHAVIOR_TYPE,
    configRegistered: Boolean(dataModel),
    documentTypeRegistered,
    dataModelName: dataModel?.name ?? null,
    valid: Boolean(dataModel) && documentTypeRegistered
  };
}

export function buildAttachedEmanationBehaviorData() {
  return {
    name: "Persistent Zones — Attached Emanation",
    type: ATTACHED_EMANATION_BEHAVIOR_TYPE,
    system: {},
    flags: { [MODULE_ID]: { nativeBehavior: { kind: "attached-emanation-events" } } }
  };
}

export function initializeAttachedEmanationTransitionState(runtimeFlags) {
  runtimeFlags.attachedTransitionState = {
    creationPhase: true,
    observedInitialEnterTokenIds: [],
    pendingInitialEnterTokenIds: []
  };
  return runtimeFlags;
}

export async function finalizeAttachedEmanationCreation(regionDocument) {
  const runtime = getRegionRuntimeFlags(regionDocument);
  if (!runtime) return null;
  const state = getAttachedTransitionState(regionDocument, runtime);
  const candidates = Array.from(regionDocument?.parent?.tokens?.contents ?? regionDocument?.parent?.tokens ?? []);
  const initialTokenIds = candidates
    .filter((tokenDocument) => tokenDocument?.id && tokenDocument?.actor && testTokenInsideManagedRegion(tokenDocument, regionDocument))
    .map((tokenDocument) => tokenDocument.id);
  const observed = new Set(state.observedInitialEnterTokenIds);
  const finalized = {
    creationPhase: false,
    observedInitialEnterTokenIds: Array.from(observed),
    pendingInitialEnterTokenIds: initialTokenIds
  };
  runtime.attachedTransitionState = finalized;
  attachedTransitionStates.set(regionDocument, finalized);
  await persistAttachedTransitionState(regionDocument, finalized);
  return finalized;
}

export async function handleAttachedRegionTransition(regionDocument, event, timing, {
  applyEffect = applyConfiguredTriggerEffect,
  cleanupStatuses = cleanupWhileInsideStatusesForRegionToken,
  consumeMovementMode = consumeNativeRegionEventMovementMode
} = {}) {
  if (!isPrimaryGM()) return { applied: false, reason: "not-primary-gm" };
  const runtime = getRegionRuntimeFlags(regionDocument);
  if (!runtime || runtime?.normalizedDefinition?.placement?.mode !== "attached-source") {
    return { applied: false, reason: "not-attached-persistent-zone" };
  }
  if (regionDocument?._destroyed || regionDocument?.parent?.regions?.has?.(regionDocument.id) === false) {
    return { applied: false, reason: "region-deleting" };
  }

  const tokenDocument = event?.data?.token ?? null;
  if (!tokenDocument?.actor) return { applied: false, reason: "missing-token-actor" };
  const transition = classifyAttachedRegionTransition(event, {
    runtime,
    tokenId: tokenDocument.id,
    timing
  });
  if (transition.cause === "regionCreation") {
    await recordSuppressedInitialEnter(regionDocument, runtime, tokenDocument.id);
    return { applied: false, reason: transition.reason };
  }
  if (timing === "onExit" || transition.cause === "targetMovement") {
    await releaseInitialOccupantSuppression(regionDocument, runtime, tokenDocument.id);
  }

  const triggerConfig = runtime.normalizedDefinition?.triggers?.[timing] ?? {};
  const movementResolution = transition.cause === "targetMovement"
    ? consumeMovementMode(tokenDocument)
    : null;
  if (movementResolution && !managedMovementModeMatches(
    movementResolution.resolvedMovementMode,
    triggerConfig.movementMode ?? "any"
  )) {
    return { applied: false, reason: "movement-mode-mismatch" };
  }
  const result = triggerConfig.enabled
    ? await applyEffect({
      regionDocument,
      tokenDocument,
      triggerConfig,
      timing,
      context: {
        triggerType: timing,
        triggerCause: transition.cause,
        moveSource: "native-attached-region",
        ...(movementResolution ? {
          movementMode: movementResolution.resolvedMovementMode,
          movementModeRaw: movementResolution.rawMovementMode,
          movementMarkConsumed: movementResolution.consumed
        } : {}),
        previousInside: timing === "onEnter" ? false : true,
        currentInside: timing === "onEnter"
      }
    })
    : { applied: false, reason: `${timing}-disabled` };

  if (timing === "onExit") {
    await cleanupStatuses({
      regionDocument,
      tokenDocument,
      cleanupReason: "attached-region-zone-movement-exit"
    });
  }
  return result;
}

export function classifyAttachedRegionTransition(event, {
  runtime = null,
  tokenId = event?.data?.token?.id ?? null,
  timing = null
} = {}) {
  if (event?.data?.movement) return { cause: "targetMovement", reason: null };
  const state = getAttachedTransitionState(event?.region ?? null, runtime);
  if (timing === "onEnter" && state.creationPhase) {
    return { cause: "regionCreation", reason: "initial-region-creation-enter" };
  }
  if (timing === "onEnter" && tokenId && state.pendingInitialEnterTokenIds.includes(tokenId)) {
    return { cause: "regionCreation", reason: "delayed-initial-region-creation-enter" };
  }
  return { cause: "zoneMovement", reason: null };
}

function normalizeAttachedTransitionState(value) {
  return {
    creationPhase: value?.creationPhase === true,
    observedInitialEnterTokenIds: Array.from(new Set(value?.observedInitialEnterTokenIds ?? [])),
    pendingInitialEnterTokenIds: Array.from(new Set(value?.pendingInitialEnterTokenIds ?? []))
  };
}

async function recordSuppressedInitialEnter(regionDocument, runtime, tokenId) {
  const state = getAttachedTransitionState(regionDocument, runtime);
  if (state.creationPhase) state.observedInitialEnterTokenIds.push(tokenId);
  state.observedInitialEnterTokenIds = Array.from(new Set(state.observedInitialEnterTokenIds));
  runtime.attachedTransitionState = state;
  attachedTransitionStates.set(regionDocument, state);
  await persistAttachedTransitionState(regionDocument, state);
}

async function releaseInitialOccupantSuppression(regionDocument, runtime, tokenId) {
  const state = getAttachedTransitionState(regionDocument, runtime);
  if (!state.pendingInitialEnterTokenIds.includes(tokenId)) return;
  state.pendingInitialEnterTokenIds = state.pendingInitialEnterTokenIds.filter((candidate) => candidate !== tokenId);
  runtime.attachedTransitionState = state;
  attachedTransitionStates.set(regionDocument, state);
  await persistAttachedTransitionState(regionDocument, state);
}

async function persistAttachedTransitionState(regionDocument, state) {
  const previous = attachedTransitionStateUpdates.get(regionDocument) ?? Promise.resolve();
  const update = previous.then(() => regionDocument.update({
    [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.attachedTransitionState`]: state
  }, { persistentZonesAttachedTransitionState: true }));
  attachedTransitionStateUpdates.set(regionDocument, update.catch(() => {}));
  await update;
}

function getAttachedTransitionState(regionDocument, runtime = null) {
  return attachedTransitionStates.get(regionDocument)
    ?? normalizeAttachedTransitionState(runtime?.attachedTransitionState);
}

export { ATTACHED_EMANATION_BEHAVIOR_TYPE };
