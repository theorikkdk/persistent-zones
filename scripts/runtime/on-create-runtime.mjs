import { MODULE_ID, RUNTIME_FLAG_KEY } from "../constants.mjs";
import { applyConfiguredTriggerEffect } from "./entry-effects.mjs";
import {
  evaluateManagedRegionTargetFilter,
  getRegionRuntimeFlags,
  testTokenInsideManagedRegion,
  testTokenTouchesManagedRegion,
  wait
} from "./utils.mjs";

const onCreateEvaluationsInFlight = new WeakSet();

export async function applyRegionOnCreateTrigger(regionDocument, {
  collectCandidates = collectOnCreateCandidateTokens,
  testInside = null,
  applyEffect = applyConfiguredTriggerEffect,
  settle = settleOnCreateGeometry
} = {}) {
  const initialRuntime = getRegionRuntimeFlags(regionDocument) ?? {};
  const completedBefore = initialRuntime.onCreateTriggerCompleted === true;
  if (completedBefore || onCreateEvaluationsInFlight.has(regionDocument)) {
    const reason = completedBefore ? "already-completed" : "evaluation-in-flight";
    return { applied: false, reason };
  }

  onCreateEvaluationsInFlight.add(regionDocument);
  try {
    const normalizedDefinition = initialRuntime.normalizedDefinition ?? {};
    const triggerConfig = normalizedDefinition?.triggers?.onCreate ?? normalizedDefinition?.triggers?.create ?? {};
    const interactionMode = normalizedDefinition?.interaction?.mode === "thin-wall" ? "thin-wall" : "area";
    const occupancyTest = testInside ?? (interactionMode === "thin-wall"
      ? testTokenTouchesManagedRegion
      : testTokenInsideManagedRegion);
    if (!normalizedDefinition.enabled || !triggerConfig.enabled) {
      await markOnCreateCompleted(regionDocument);
      return { applied: false, reason: "trigger-disabled" };
    }

    let candidates = collectCandidates(regionDocument);
    let insideTokens = candidates.filter((tokenDocument) => tokenDocument?.actor && occupancyTest(tokenDocument, regionDocument));
    if (!insideTokens.length) {
      await settle();
      candidates = collectCandidates(regionDocument);
      insideTokens = candidates.filter((tokenDocument) => tokenDocument?.actor && occupancyTest(tokenDocument, regionDocument));
    }

    const effectAttemptTokenIds = [];
    let appliedCount = 0;
    let blockedCount = 0;
    for (const tokenDocument of insideTokens) {
      const filterResult = evaluateManagedRegionTargetFilter(tokenDocument, regionDocument, normalizedDefinition);
      if (!filterResult.allowed) continue;
      effectAttemptTokenIds.push(tokenDocument.id);
      const result = await applyEffect({
        regionDocument,
        tokenDocument,
        triggerConfig,
        timing: "onCreate",
        context: { triggerType: "onCreate", previousInside: false, currentInside: true }
      });
      if (result?.applied && !result?.skipped) appliedCount += 1;
      else if (result?.frequencyReason === "already-applied-this-turn") blockedCount += 1;
    }

    await markOnCreateCompleted(regionDocument);
    const skipReason = appliedCount > 0 ? null
      : blockedCount > 0 ? "frequency-blocked"
        : !candidates.length ? "no-candidates"
          : !insideTokens.length ? "not-inside"
            : !effectAttemptTokenIds.length ? "target-filtered" : "no-effect";
    return { applied: appliedCount > 0, appliedCount, reason: skipReason ?? "completed" };
  } finally {
    onCreateEvaluationsInFlight.delete(regionDocument);
  }
}

export async function applyRegionGroupOnCreateTriggers(regionDocuments = []) {
  const results = [];
  for (const regionDocument of regionDocuments) results.push(await applyRegionOnCreateTrigger(regionDocument));
  return results;
}

export function collectOnCreateCandidateTokens(regionDocument) {
  const sceneTokens = Array.from(regionDocument?.parent?.tokens?.contents ?? regionDocument?.parent?.tokens ?? []);
  const canvasTokens = globalThis.canvas?.scene?.id === regionDocument?.parent?.id
    ? Array.from(globalThis.canvas?.tokens?.placeables ?? []).map((placeable) => placeable?.document).filter(Boolean)
    : [];
  return Array.from(new Map([...sceneTokens, ...canvasTokens].filter(Boolean).map((token) => [token.id, token])).values());
}

async function markOnCreateCompleted(regionDocument) {
  await regionDocument.update({ [`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}.onCreateTriggerCompleted`]: true }, { persistentZonesOnCreateMarker: true });
}

async function settleOnCreateGeometry() {
  if (typeof globalThis.requestAnimationFrame === "function") await new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve()));
  await wait(50);
}
