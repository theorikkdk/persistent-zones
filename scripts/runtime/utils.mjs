import {
  DEBUG_LOG_LEVEL_SETTING_KEY,
  DEBUG_PREFIX,
  MODULE_ID,
  RUNTIME_FLAG_KEY
} from "../constants.mjs";

const PERSISTENT_ZONES_LOG_LEVEL_PRIORITY = Object.freeze({
  minimal: 0,
  standard: 1,
  verbose: 2
});

export function debug(message, data = undefined, { level = "standard" } = {}) {
  if (!shouldEmitPersistentZonesDebug(level)) {
    return;
  }

  if (data === undefined) {
    console.debug(`${DEBUG_PREFIX} ${message}`);
    return;
  }

  console.debug(`${DEBUG_PREFIX} ${message}`, data);
}

export function debugVerbose(message, data = undefined) {
  debug(message, data, { level: "verbose" });
}

export function error(message, caughtError, data = undefined) {
  if (data === undefined) {
    console.error(`${DEBUG_PREFIX} ${message}`, caughtError);
    return;
  }

  console.error(`${DEBUG_PREFIX} ${message}`, caughtError, data);
}

export function duplicateData(value) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof foundry !== "undefined" && foundry.utils?.deepClone) {
    return foundry.utils.deepClone(value);
  }

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function safeGet(source, path, fallback = undefined) {
  if (!source) {
    return fallback;
  }

  const segments = Array.isArray(path) ? path : String(path).split(".");
  let current = source;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return fallback;
    }

    current = current[segment];
  }

  return current === undefined ? fallback : current;
}

export function pickFirstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

export function coerceNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

export function coerceBoolean(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  return fallback;
}

export function getTemplateType(templateDocument) {
  return String(templateDocument?.t ?? "").toLowerCase();
}

export function getRegionRuntime(regionDocument) {
  const objectData = regionDocument?.toObject?.() ?? null;
  const result = resolveRegionRuntimeCandidate(regionDocument, objectData);
  logRegionManagedFlagsRead(regionDocument, result, objectData);
  return duplicateData(result.runtime) ?? null;
}

export const getRegionRuntimeFlags = getRegionRuntime;

export function buildManagedRegionFlags(runtimeFlags) {
  return {
    [MODULE_ID]: {
      [RUNTIME_FLAG_KEY]: runtimeFlags
    }
  };
}

export function isManagedRegion(regionDocument) {
  const runtime = getRegionRuntime(regionDocument);
  return isPersistentZonesManagedRuntime(runtime);
}

function resolveRegionRuntimeCandidate(regionDocument, objectData = null) {
  const candidates = [
    {
      source: "getFlag",
      value: regionDocument?.getFlag?.(MODULE_ID, RUNTIME_FLAG_KEY)
    },
    {
      source: "document.flags",
      value: regionDocument?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]
    },
    {
      source: "document._source.flags",
      value: regionDocument?._source?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]
    },
    {
      source: "toObject.flags",
      value: objectData?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]
    },
    {
      source: "toObject.flags-flat",
      value: objectData?.[`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]
    },
    {
      source: "document._source.flags-flat",
      value: regionDocument?._source?.[`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`]
    }
  ];

  const match = candidates.find((candidate) => candidate.value && typeof candidate.value === "object");
  return {
    runtime: match?.value ?? null,
    source: match?.source ?? "none",
    objectData
  };
}

function logRegionManagedFlagsRead(regionDocument, result, objectData = null) {
  if (!isFoundryV14OrNewer()) {
    return;
  }

  const runtime = result?.runtime ?? null;
  console.warn(
    `[${MODULE_ID}][v14-branch] regionManagedFlagsRead: ${runtime ? "found" : "missing"} | regionDocumentId=${regionDocument?.id ?? null} | regionManagedFlagsSource=${result?.source ?? "none"}`,
    {
      regionDocumentId: regionDocument?.id ?? null,
      regionManagedFlagsRead: Boolean(runtime),
      regionManagedFlagsSource: result?.source ?? "none",
      managedRegionDetected: isPersistentZonesManagedRuntime(runtime),
      templateId: runtime?.templateId ?? null,
      templateUuid: runtime?.templateUuid ?? null,
      itemUuid: runtime?.itemUuid ?? null,
      partId: runtime?.partId ?? null,
      regionDocumentFlags: summarizeRegionFlagObject(regionDocument?.flags),
      regionDocumentSourceFlags: summarizeRegionFlagObject(regionDocument?._source?.flags),
      regionDocumentObjectFlags: summarizeRegionFlagObject(objectData?.flags)
    }
  );
}

function logRegionManagedDetection(message, data = {}) {
  if (!isFoundryV14OrNewer()) {
    return;
  }

  const reason =
    data.managedRegionRejectReason ??
    (message === "managedRegionDetected" ? "managed-region-detected" : "unspecified");
  console.warn(
    `[${MODULE_ID}][v14-branch] ${message}: ${reason} | regionDocumentId=${data.regionDocumentId ?? null}`,
    data
  );
}

function summarizeRegionFlagObject(flags) {
  if (!flags || typeof flags !== "object") {
    return {
      present: false,
      namespaces: [],
      persistentZonesKeys: []
    };
  }

  return {
    present: true,
    namespaces: Object.keys(flags),
    persistentZonesKeys: Object.keys(flags?.[MODULE_ID] ?? {}),
    hasNestedRuntime: Boolean(flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]),
    hasFlatRuntime: Boolean(flags?.[`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`])
  };
}

export function isWallHeightSupported() {
  return Boolean(game?.modules?.get?.("wall-height")?.active);
}

export function evaluateManagedRegionTargetFilter(tokenDocument, regionDocument, normalizedDefinition = null) {
  if (!tokenDocument?.actor) {
    return {
      allowed: false,
      targetMatched: false,
      targetFilter: "all",
      targetFilterGlobal: "all",
      targetFilterPart: null,
      targetFilterEffective: "all",
      partId: null,
      sourceActorUuid: null,
      targetActorUuid: null,
      sourceTokenId: null,
      sourceDisposition: null,
      targetDisposition: null,
      reason: "Token has no Actor."
    };
  }

  const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
  const definition = normalizedDefinition ?? runtime.normalizedDefinition ?? {};
  const targeting = isPlainObject(definition?.targeting) ? definition.targeting : {};
  const targetingGlobal = isPlainObject(definition?.targetingGlobal)
    ? definition.targetingGlobal
    : targeting;
  const targetingPart = isPlainObject(definition?.targetingPart)
    ? definition.targetingPart
    : null;
  const targetingEffective = isPlainObject(definition?.targetingEffective)
    ? definition.targetingEffective
    : targeting;
  const normalizedTargetingGlobal = normalizeManagedRegionTargeting(targetingGlobal);
  const normalizedTargetingPart = targetingPart
    ? normalizeManagedRegionTargeting(targetingPart)
    : null;
  const normalizedTargetingEffective = normalizeManagedRegionTargeting(targetingEffective);
  const targetFilterGlobal = normalizedTargetingGlobal.targetFilter;
  const targetFilterPart = normalizedTargetingPart?.targetFilter ?? null;
  const targetFilterEffective = normalizedTargetingEffective.targetFilter;
  const partId =
    runtime?.partId ??
    definition?.part?.id ??
    null;
  const targetFilter = targetFilterEffective;
  const sourceActorUuid =
    runtime?.casterUuid ??
    runtime?.actorUuid ??
    definition?.casterUuid ??
    definition?.actorUuid ??
    null;
  const targetActorUuid = tokenDocument.actor?.uuid ?? null;
  const sourceToken = resolveManagedRegionSourceToken(
    regionDocument,
    tokenDocument,
    sourceActorUuid,
    runtime?.sourceTokenUuid ?? runtime?.casterTokenUuid ?? null
  );
  const sourceDisposition = coerceNumber(
    pickFirstDefined(sourceToken?.disposition, sourceToken?.document?.disposition, runtime?.sourceDisposition),
    null
  );
  const targetDisposition = coerceNumber(
    pickFirstDefined(tokenDocument?.disposition, tokenDocument?.document?.disposition),
    null
  );
  const sameActor = Boolean(sourceActorUuid && targetActorUuid && sourceActorUuid === targetActorUuid);

  const baseResult = {
    partId,
    targetFilter,
    targetFilterGlobal,
    targetFilterPart,
    targetFilterEffective,
    targetSelectionsGlobal: collectManagedRegionTargetSelectionLabels(normalizedTargetingGlobal),
    targetSelectionsPart: normalizedTargetingPart
      ? collectManagedRegionTargetSelectionLabels(normalizedTargetingPart)
      : [],
    targetSelectionsEffective: collectManagedRegionTargetSelectionLabels(normalizedTargetingEffective),
    sourceActorUuid,
    targetActorUuid,
    sourceTokenId: sourceToken?.id ?? null,
    sourceDisposition,
    targetDisposition
  };

  if (!normalizedTargetingEffective.hasSelections) {
    return {
      ...baseResult,
      allowed: false,
      targetMatched: false,
      reason: "Target selection has no enabled categories."
    };
  }

  if (targetFilterEffective === "all") {
    return {
      ...baseResult,
      allowed: true,
      targetMatched: true,
      reason: "Target selection all matched."
    };
  }

  const selfMatched = sameActor;
  const alliesMatched =
    !sameActor &&
    sourceDisposition !== null &&
    targetDisposition !== null &&
    sourceDisposition !== 0 &&
    sourceDisposition === targetDisposition;
  const enemiesMatched =
    sourceDisposition !== null &&
    targetDisposition !== null &&
    sourceDisposition !== 0 &&
    targetDisposition !== 0 &&
    Math.sign(sourceDisposition) !== Math.sign(targetDisposition);
  const matched =
    (normalizedTargetingEffective.self && selfMatched) ||
    (normalizedTargetingEffective.allies && alliesMatched) ||
    (normalizedTargetingEffective.enemies && enemiesMatched) ||
    (
      targetFilterEffective === "not-self" &&
      sourceActorUuid &&
      targetActorUuid &&
      sourceActorUuid !== targetActorUuid
    ) ||
    (
      targetFilterEffective === "not-self" &&
      (!sourceActorUuid || !targetActorUuid)
    );

  return {
    ...baseResult,
    allowed: matched,
    targetMatched: matched,
    reason: matched
      ? "Target selection matched the token."
      : "Target selection did not match the token."
  };
}

export function findManagedRegions(scene, predicate = null) {
  const regionDocuments =
    scene?.regions?.contents ??
    Array.from(scene?.regions?.values?.() ?? []);
  const regions = [];

  for (const regionDocument of regionDocuments) {
    const result = resolveRegionRuntimeCandidate(regionDocument, regionDocument?.toObject?.() ?? null);
    const managedRegionDetected = isPersistentZonesManagedRuntime(result.runtime);
    if (managedRegionDetected) {
      logRegionManagedDetection("managedRegionDetected", {
        sceneId: scene?.id ?? null,
        regionDocumentId: regionDocument?.id ?? null,
        regionManagedFlagsSource: result.source,
        itemUuid: result.runtime?.itemUuid ?? null,
        templateId: result.runtime?.templateId ?? null,
        partId: result.runtime?.partId ?? null
      });
      regions.push(regionDocument);
      continue;
    }

    logRegionManagedDetection("managedRegionRejected", {
      sceneId: scene?.id ?? null,
      regionDocumentId: regionDocument?.id ?? null,
      managedRegionRejectReason: result.runtime
        ? "runtime-flags-missing-managed-contract"
        : "runtime-flags-not-found",
      regionManagedFlagsSource: result.source,
      regionDocumentFlags: summarizeRegionFlagObject(regionDocument?.flags),
      regionDocumentSourceFlags: summarizeRegionFlagObject(regionDocument?._source?.flags),
      regionDocumentObjectFlags: summarizeRegionFlagObject(result.objectData?.flags)
    });
  }

  logRegionManagedDetection("managedRegionCount", {
    sceneId: scene?.id ?? null,
    sceneRegionCount: regionDocuments.length,
    managedRegionCount: regions.length
  });

  return predicate ? regions.filter(predicate) : regions;
}

function isPersistentZonesManagedRuntime(runtime) {
  return Boolean(
    runtime?.templateId ||
    runtime?.templateUuid ||
    runtime?.itemUuid ||
    runtime?.contractVersion ||
    runtime?.architecturePath === "v14-region-native"
  );
}

export function distanceToPixels(distance, scene = null) {
  const numericDistance = coerceNumber(distance, 0);
  const activeScene = scene ?? canvas?.scene ?? null;
  const gridSize = coerceNumber(activeScene?.grid?.size, canvas?.dimensions?.size ?? 100);
  const gridDistance = coerceNumber(
    activeScene?.grid?.distance,
    canvas?.dimensions?.distance ?? 5
  );

  if (!gridDistance) {
    return numericDistance;
  }

  return numericDistance * (gridSize / gridDistance);
}

export function pixelsToDistance(pixels, scene = null) {
  const numericPixels = coerceNumber(pixels, 0);
  const activeScene = scene ?? canvas?.scene ?? null;
  const gridSize = coerceNumber(activeScene?.grid?.size, canvas?.dimensions?.size ?? 100);
  const gridDistance = coerceNumber(
    activeScene?.grid?.distance,
    canvas?.dimensions?.distance ?? 5
  );

  if (!gridSize) {
    return numericPixels;
  }

  return numericPixels * (gridDistance / gridSize);
}

export function translateFlatPoints(points, deltaX = 0, deltaY = 0) {
  const sourcePoints = Array.from(points ?? []);
  const translatedPoints = [];

  for (let index = 0; index < sourcePoints.length; index += 2) {
    translatedPoints.push((sourcePoints[index] ?? 0) + deltaX);
    translatedPoints.push((sourcePoints[index + 1] ?? 0) + deltaY);
  }

  return translatedPoints;
}

export function trimClosingPolygonPoint(points) {
  if (!Array.isArray(points) || points.length < 8) {
    return points;
  }

  const firstX = points[0];
  const firstY = points[1];
  const lastX = points[points.length - 2];
  const lastY = points[points.length - 1];

  if (firstX === lastX && firstY === lastY) {
    return points.slice(0, -2);
  }

  return points;
}

export async function fromUuidSafe(uuid) {
  if (!uuid || typeof fromUuid !== "function") {
    return null;
  }

  try {
    return await fromUuid(uuid);
  } catch (caughtError) {
    debug("UUID resolution failed.", { uuid, error: caughtError?.message ?? "unknown" });
    return null;
  }
}

export function isPrimaryGM() {
  if (!game.user?.isGM) {
    return false;
  }

  const activeGM =
    game.users?.activeGM ??
    game.users?.find((user) => user.active && user.isGM) ??
    null;

  return activeGM?.id === game.user.id;
}

export async function wait(milliseconds = 0) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function shouldEmitPersistentZonesDebug(requiredLevel = "standard") {
  const configuredLevel = getConfiguredPersistentZonesLogLevel();
  return (
    PERSISTENT_ZONES_LOG_LEVEL_PRIORITY[configuredLevel] >=
    PERSISTENT_ZONES_LOG_LEVEL_PRIORITY[normalizePersistentZonesLogLevel(requiredLevel)]
  );
}

function getConfiguredPersistentZonesLogLevel() {
  if (!hasPersistentZonesSetting(DEBUG_LOG_LEVEL_SETTING_KEY)) {
    return "standard";
  }

  try {
    return normalizePersistentZonesLogLevel(
      game.settings.get(MODULE_ID, DEBUG_LOG_LEVEL_SETTING_KEY)
    );
  } catch (_caughtError) {
    return "standard";
  }
}

function hasPersistentZonesSetting(settingKey) {
  return Boolean(game?.settings?.settings?.has?.(`${MODULE_ID}.${settingKey}`));
}

function normalizePersistentZonesLogLevel(value) {
  const normalizedValue = String(value ?? "").trim().toLowerCase();

  if (normalizedValue === "minimal") {
    return "minimal";
  }

  if (normalizedValue === "verbose") {
    return "verbose";
  }

  return "standard";
}

export function getTokenCenter(tokenLike, fallback = null) {
  const x = pickFirstDefined(tokenLike?.x, tokenLike?.document?.x, fallback?.x, 0);
  const y = pickFirstDefined(tokenLike?.y, tokenLike?.document?.y, fallback?.y, 0);
  const width = pickFirstDefined(
    tokenLike?.object?.w,
    tokenLike?.w,
    tokenLike?.width && canvas?.grid?.size ? tokenLike.width * canvas.grid.size : null,
    tokenLike?.document?.width && canvas?.grid?.size
      ? tokenLike.document.width * canvas.grid.size
      : null,
    canvas?.grid?.size ?? 100
  );
  const height = pickFirstDefined(
    tokenLike?.object?.h,
    tokenLike?.h,
    tokenLike?.height && canvas?.grid?.size ? tokenLike.height * canvas.grid.size : null,
    tokenLike?.document?.height && canvas?.grid?.size
      ? tokenLike.document.height * canvas.grid.size
      : null,
    canvas?.grid?.size ?? 100
  );

  return {
    x: x + width / 2,
    y: y + height / 2
  };
}

export function testTokenInsideManagedRegion(tokenDocument, regionDocument, state = null) {
  if (!tokenDocument || !regionDocument) {
    return false;
  }

  const membership = buildTokenRegionMembershipState(tokenDocument, state);
  const runtime = getRegionRuntimeFlags(regionDocument);
  const shapes = getRegionShapeData(regionDocument);
  const isManagedV14Region = Boolean(runtime) && isFoundryV14OrNewer() && shapes.length > 0;
  const isRegionNativeRingSegment = runtime?.regionSourceStrategy === "v14-region-native-segment-group";
  const nativeRingGeometry = resolveNativeRingGeometryFromRegion(regionDocument, runtime, shapes);
  const fallbackInside = sampleTokenRegionPoints(membership)
    .some((point) => pointInManagedRegion(regionDocument, point));
  const coverageResult = calculateTokenRegionGridCoverage(membership, regionDocument, shapes);
  const ringRuntimeResult = isRegionNativeRingSegment
    ? null
    : testTokenInsideRuntimeRing(membership, runtime, nativeRingGeometry);
  let nativeInside = null;
  let nativeError = null;

  if (typeof tokenDocument.testInsideRegion === "function") {
    try {
      nativeInside = !!tokenDocument.testInsideRegion(regionDocument, membership);
    } catch (caughtError) {
      nativeError = caughtError?.message ?? "unknown";
      debug("Native token Region inside test failed, using sampled fallback.", {
        tokenId: tokenDocument?.id ?? null,
        regionId: regionDocument?.id ?? null,
        error: nativeError
      });
    }
  }

  const legacyResult = isManagedV14Region
    ? (isRegionNativeRingSegment ? fallbackInside : (ringRuntimeResult?.tokenInsideRingBand ?? fallbackInside))
    : (nativeInside ?? fallbackInside);
  const result = coverageResult?.inside ?? legacyResult;
  const diagnostic = {
    tokenId: tokenDocument?.id ?? null,
    regionId: regionDocument?.id ?? null,
    partId: runtime?.partId ?? runtime?.part?.id ?? runtime?.normalizedDefinition?.part?.id ?? null,
    geometryType: runtime?.normalizedDefinition?.geometry?.type ?? null,
    regionSourceStrategy: runtime?.regionSourceStrategy ?? null,
    regionSegmentIndex: runtime?.regionSegmentIndex ?? null,
    regionSegmentCount: runtime?.regionSegmentCount ?? null,
    shapeCount: shapes.length,
    nativeInside,
    fallbackInside,
    gridCoverageInside: coverageResult?.inside ?? null,
    maxCoverageRatio: coverageResult?.maxCoverageRatio ?? null,
    ringRuntimeInside: ringRuntimeResult?.tokenInsideRingBand ?? null,
    tokenInsideRegion: result,
    nativeError,
    v14RuntimePath: isManagedV14Region && isRegionNativeRingSegment
      ? "managed-region-native-ring-segment"
      : isManagedV14Region && ringRuntimeResult
      ? "managed-ring-runtime-geometry"
      : isManagedV14Region
        ? coverageResult
          ? "managed-shape-grid-cell-coverage"
          : "managed-shape-sampled-fallback"
        : "native-or-fallback"
  };

  logV14RuntimeDiagnostic("regionRuntimeCheck", diagnostic);
  logV14RuntimeDiagnostic("tokenInsideRegion", diagnostic);
  if (isManagedV14Region && result) {
    logV14RuntimeDiagnostic("v14NativeRuntimeTriggered", {
      ...diagnostic,
      v14NativeRuntimeTriggered: true
    });
  }

  if (isRingLikeRuntime(runtime, shapes)) {
    const tokenInsideRingHole = ringRuntimeResult?.tokenInsideRingHole
      ?? (!fallbackInside && pointInsideRingOuterEnvelope(shapes, membership));
    logV14RuntimeDiagnostic("ringRuntimeCheck", {
      ...diagnostic,
      tokenInsideRingBand: ringRuntimeResult?.tokenInsideRingBand ?? fallbackInside,
      tokenInsideRingHole,
      ringRejectReason: ringRuntimeResult?.ringRejectReason ?? null,
      ringGeometry: duplicateData(nativeRingGeometry ?? runtime?.ringGeometry ?? null)
    });
    logV14RuntimeDiagnostic("v14RingRuntimeCheck", {
      ...diagnostic,
      tokenInsideRingBand: ringRuntimeResult?.tokenInsideRingBand ?? fallbackInside,
      tokenInsideRingHole,
      ringRejectReason: ringRuntimeResult?.ringRejectReason ?? null,
      ringGeometry: duplicateData(nativeRingGeometry ?? runtime?.ringGeometry ?? null)
    });
  }

  return result;
}

export function evaluateTriggerTargetFilter({
  regionDocument,
  runtime = null,
  triggerConfig = null,
  triggerId = null,
  tokenDocument
} = {}) {
  const resolvedRuntime = runtime ?? getRegionRuntimeFlags(regionDocument) ?? {};
  const globalResult = evaluateManagedRegionTargetFilter(
    tokenDocument,
    regionDocument,
    resolvedRuntime.normalizedDefinition
  );
  const mode = normalizeTriggerTargetFilterMode(triggerConfig?.targetFilter?.mode);
  const sourceTokenUuid = String(
    resolvedRuntime.sourceTokenUuid ??
    resolvedRuntime.casterTokenUuid ??
    resolvedRuntime.normalizedDefinition?.sourceTokenUuid ??
    ""
  ).trim() || null;
  const targetTokenUuid = String(tokenDocument?.uuid ?? "").trim() || null;
  const sourceToken = resolveManagedRegionSourceTokenByUuid(regionDocument, tokenDocument, sourceTokenUuid);
  const sourceDisposition = coerceNumber(
    pickFirstDefined(
      sourceToken?.disposition,
      sourceToken?.document?.disposition,
      resolvedRuntime.sourceDisposition,
      resolvedRuntime.normalizedDefinition?.sourceDisposition
    ),
    null
  );
  const targetDisposition = coerceNumber(
    pickFirstDefined(tokenDocument?.disposition, tokenDocument?.document?.disposition),
    null
  );
  const baseResult = {
    allowed: false,
    mode,
    sourceTokenUuid,
    targetTokenUuid,
    sourceDisposition,
    targetDisposition,
    reason: "target-filter-not-matched",
    globalResult
  };

  if (!globalResult.allowed) return { ...baseResult, reason: "global-target-filter-rejected" };
  if (mode === "all") return { ...baseResult, allowed: true, reason: "all-targets" };
  if (!sourceTokenUuid) return { ...baseResult, reason: "source-token-identity-unavailable" };

  const sameToken = Boolean(targetTokenUuid && targetTokenUuid === sourceTokenUuid);
  if (mode === "self") {
    return { ...baseResult, allowed: sameToken, reason: sameToken ? "source-token" : "different-token" };
  }
  if (mode === "others") {
    return { ...baseResult, allowed: !sameToken, reason: sameToken ? "source-token-excluded" : "different-token" };
  }
  if (sourceDisposition === null) return { ...baseResult, reason: "source-disposition-unavailable" };

  const dispositions = globalThis.CONST?.TOKEN_DISPOSITIONS ?? {};
  const friendly = Number(dispositions.FRIENDLY ?? 1);
  const hostile = Number(dispositions.HOSTILE ?? -1);
  const sourceCamp = sourceDisposition === friendly ? "friendly" : sourceDisposition === hostile ? "hostile" : null;
  const targetCamp = targetDisposition === friendly ? "friendly" : targetDisposition === hostile ? "hostile" : null;
  if (!sourceCamp || !targetCamp) {
    return { ...baseResult, reason: targetCamp ? "source-disposition-unsupported" : "neutral-not-matched" };
  }
  if (mode === "allies") {
    const allowed = sourceCamp === targetCamp;
    return { ...baseResult, allowed, reason: allowed ? "same-disposition" : "opposite-disposition" };
  }
  const allowed = sourceCamp !== targetCamp;
  return { ...baseResult, allowed, reason: allowed ? "opposite-disposition" : "same-disposition" };
}

export function normalizeTriggerTargetFilterMode(value) {
  const mode = String(value ?? "all").trim().toLowerCase();
  return ["all", "allies", "enemies", "self", "others"].includes(mode) ? mode : "all";
}

const TOKEN_CELL_COVERAGE_THRESHOLD = 0.5;
const TOKEN_CELL_COVERAGE_EPSILON = 1e-9;

export function calculateTokenRegionGridCoverage(membership, regionDocument, shapes = null) {
  const scene = regionDocument?.parent ?? globalThis.canvas?.scene ?? null;
  const gridType = scene?.grid?.type ?? globalThis.canvas?.grid?.type;
  const squareGridType = globalThis.CONST?.GRID_TYPES?.SQUARE ?? 1;
  const gridlessType = globalThis.CONST?.GRID_TYPES?.GRIDLESS ?? 0;
  if (gridType === gridlessType || (gridType !== undefined && gridType !== null && gridType !== squareGridType && String(gridType).toLowerCase() !== "square")) {
    return null;
  }
  const gridSize = coerceNumber(
    globalThis.canvas?.grid?.size,
    coerceNumber(scene?.grid?.size, coerceNumber(scene?.dimensions?.size, null))
  );
  if (!gridSize || gridSize <= 0) return null;
  const regionShapes = Array.isArray(shapes) ? shapes : getRegionShapeData(regionDocument);
  if (!regionShapes.length) return null;

  const tokenWidth = Math.max(coerceNumber(membership?.width, 1), 0.1);
  const tokenHeight = Math.max(coerceNumber(membership?.height, 1), 0.1);
  const columns = Math.max(1, Math.ceil(tokenWidth));
  const rows = Math.max(1, Math.ceil(tokenHeight));
  const left = coerceNumber(membership?.x, 0);
  const top = coerceNumber(membership?.y, 0);
  let affectedCellCount = 0;
  let maxCoverageRatio = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const cell = {
        x: left + column * gridSize,
        y: top + row * gridSize,
        width: Math.min(1, Math.max(0, tokenWidth - column)) * gridSize,
        height: Math.min(1, Math.max(0, tokenHeight - row)) * gridSize
      };
      const ratio = calculateRegionCoverageRatioForRectangle(regionShapes, cell);
      maxCoverageRatio = Math.max(maxCoverageRatio, ratio);
      if (ratio + TOKEN_CELL_COVERAGE_EPSILON >= TOKEN_CELL_COVERAGE_THRESHOLD) affectedCellCount += 1;
    }
  }

  return {
    testedCellCount: rows * columns,
    affectedCellCount,
    maxCoverageRatio,
    inside: affectedCellCount > 0
  };
}

function calculateRegionCoverageRatioForRectangle(shapes, rectangle) {
  const cellArea = rectangle.width * rectangle.height;
  if (!(cellArea > 0)) return 0;
  let coveredArea = 0;
  for (const shape of shapes) {
    for (const polygon of buildShapeAreaPolygons(shape)) {
      const clipped = clipPolygonToRectangle(polygon.points, rectangle);
      const area = polygonArea(clipped);
      coveredArea += polygon.hole ? -area : area;
    }
  }
  return Math.max(0, Math.min(1, coveredArea / cellArea));
}

function buildShapeAreaPolygons(shape) {
  const type = String(shape?.type ?? "").toLowerCase();
  if (shape?.polygonMode === "annulus") return buildAnnulusAreaPolygons(shape);
  if (type === "polygon") return [{ points: normalizePolygonPoints(shape.points), hole: shape?.hole === true }];
  if (type === "rectangle") return [{ points: buildRectanglePolygon(shape), hole: shape?.hole === true }];
  if (type === "line") return [{ points: buildLinePolygon(shape), hole: shape?.hole === true }];
  if (type === "circle") return [{ points: buildEllipsePolygon({ x: shape.x, y: shape.y, radiusX: shape.radius, radiusY: shape.radius }), hole: shape?.hole === true }];
  if (type === "ellipse") return [{ points: buildEllipsePolygon(shape), hole: shape?.hole === true }];
  if (type === "ring") {
    const radius = coerceNumber(shape.radius, 0);
    const innerRadius = Math.max(0, radius - Math.max(0, coerceNumber(shape.innerWidth, 0)));
    const outerRadius = radius + Math.max(0, coerceNumber(shape.outerWidth, 0));
    return [
      { points: buildRadialPolygon(shape.x, shape.y, outerRadius), hole: false },
      ...(innerRadius > 0 ? [{ points: buildRadialPolygon(shape.x, shape.y, innerRadius), hole: true }] : [])
    ];
  }
  if (type === "cone") return [{ points: buildConePolygon(shape), hole: shape?.hole === true }];
  if (type === "emanation") {
    const center = findEmanationCenter(shape);
    return [{ points: buildRadialPolygon(center.x, center.y, coerceNumber(shape.radius, 0)), hole: shape?.hole === true }];
  }
  return [];
}

function buildRectanglePolygon(shape) {
  const origin = { x: coerceNumber(shape.x, 0), y: coerceNumber(shape.y, 0) };
  const width = coerceNumber(shape.width, 0);
  const height = coerceNumber(shape.height, 0);
  const radians = coerceNumber(shape.rotation, 0) * Math.PI / 180;
  return [[0, 0], [width, 0], [width, height], [0, height]]
    .map(([dx, dy]) => rotatePoint({ x: origin.x + dx, y: origin.y + dy }, origin, radians));
}

function buildLinePolygon(shape) {
  const origin = { x: coerceNumber(shape.x, 0), y: coerceNumber(shape.y, 0) };
  const length = coerceNumber(shape.length ?? shape.distance, 0);
  const halfWidth = coerceNumber(shape.width, 0) / 2;
  const radians = coerceNumber(shape.rotation ?? shape.direction, 0) * Math.PI / 180;
  return [[0, -halfWidth], [length, -halfWidth], [length, halfWidth], [0, halfWidth]]
    .map(([dx, dy]) => rotatePoint({ x: origin.x + dx, y: origin.y + dy }, origin, radians));
}

function buildEllipsePolygon(shape) {
  const width = coerceNumber(shape.width, null);
  const height = coerceNumber(shape.height, null);
  const radiusX = coerceNumber(shape.radiusX, width !== null ? width / 2 : 0);
  const radiusY = coerceNumber(shape.radiusY, height !== null ? height / 2 : 0);
  const centerX = shape.cx !== undefined ? coerceNumber(shape.cx, 0) : width !== null && shape.radiusX === undefined ? coerceNumber(shape.x, 0) + radiusX : coerceNumber(shape.x, 0);
  const centerY = shape.cy !== undefined ? coerceNumber(shape.cy, 0) : height !== null && shape.radiusY === undefined ? coerceNumber(shape.y, 0) + radiusY : coerceNumber(shape.y, 0);
  return buildRadialPolygon(centerX, centerY, 1, 96).map((point) => ({ x: centerX + (point.x - centerX) * radiusX, y: centerY + (point.y - centerY) * radiusY }));
}

function buildRadialPolygon(x, y, radius, segments = 96) {
  const centerX = coerceNumber(x, 0);
  const centerY = coerceNumber(y, 0);
  const resolvedRadius = Math.max(0, coerceNumber(radius, 0));
  return Array.from({ length: segments }, (_entry, index) => {
    const angle = index * Math.PI * 2 / segments;
    return { x: centerX + Math.cos(angle) * resolvedRadius, y: centerY + Math.sin(angle) * resolvedRadius };
  });
}

function buildConePolygon(shape) {
  const x = coerceNumber(shape.x, 0);
  const y = coerceNumber(shape.y, 0);
  const radius = Math.max(0, coerceNumber(shape.radius, 0));
  const angle = Math.max(0, Math.min(360, coerceNumber(shape.angle, 0)));
  const rotation = coerceNumber(shape.rotation, 0) * Math.PI / 180;
  if (angle >= 360) return buildRadialPolygon(x, y, radius);
  const half = angle * Math.PI / 360;
  const segments = Math.max(2, Math.ceil(96 * angle / 360));
  return [{ x, y }, ...Array.from({ length: segments + 1 }, (_entry, index) => {
    const theta = rotation - half + (index / segments) * half * 2;
    return { x: x + Math.cos(theta) * radius, y: y + Math.sin(theta) * radius };
  })];
}

function buildAnnulusAreaPolygons(shape) {
  const points = normalizePolygonPoints(shape.points);
  if (points.length < 6) return [];
  const bounds = calculatePointBounds(points);
  const x = (bounds.minX + bounds.maxX) / 2;
  const y = (bounds.minY + bounds.maxY) / 2;
  const radii = points.map((point) => Math.hypot(point.x - x, point.y - y)).filter((radius) => radius > 0);
  const inner = Math.min(...radii);
  const outer = Math.max(...radii);
  return [
    { points: buildRadialPolygon(x, y, outer), hole: false },
    { points: buildRadialPolygon(x, y, inner), hole: true }
  ];
}

function clipPolygonToRectangle(points, rectangle) {
  let output = Array.from(points ?? []);
  const edges = [
    [(point) => point.x >= rectangle.x, (a, b) => intersectVertical(a, b, rectangle.x)],
    [(point) => point.x <= rectangle.x + rectangle.width, (a, b) => intersectVertical(a, b, rectangle.x + rectangle.width)],
    [(point) => point.y >= rectangle.y, (a, b) => intersectHorizontal(a, b, rectangle.y)],
    [(point) => point.y <= rectangle.y + rectangle.height, (a, b) => intersectHorizontal(a, b, rectangle.y + rectangle.height)]
  ];
  for (const [inside, intersection] of edges) {
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index];
      const previous = input[(index + input.length - 1) % input.length];
      const currentInside = inside(current);
      const previousInside = inside(previous);
      if (currentInside && !previousInside) output.push(intersection(previous, current));
      if (currentInside) output.push(current);
      else if (previousInside) output.push(intersection(previous, current));
    }
    if (!output.length) break;
  }
  return output;
}

function intersectVertical(a, b, x) {
  const factor = (x - a.x) / ((b.x - a.x) || Number.EPSILON);
  return { x, y: a.y + (b.y - a.y) * factor };
}

function intersectHorizontal(a, b, y) {
  const factor = (y - a.y) / ((b.y - a.y) || Number.EPSILON);
  return { x: a.x + (b.x - a.x) * factor, y };
}

function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

export function pointInManagedRegion(regionDocument, point) {
  const shapes = getRegionShapeData(regionDocument);
  if (!shapes.length) {
    return false;
  }

  let insideSolidShape = false;
  for (const shape of shapes) {
    const insideShape = pointInShape(shape, point);
    if (!insideShape) {
      continue;
    }

    if (shape?.hole) {
      return false;
    }

    insideSolidShape = true;
  }

  return insideSolidShape;
}

export function getRegionShapeData(regionDocument) {
  const raw =
    duplicateData(regionDocument?.toObject?.()?.shapes) ??
    duplicateData(regionDocument?.shapes?.contents?.map((shape) => shape.toObject?.() ?? shape)) ??
    duplicateData(regionDocument?.shapes) ??
    [];

  return Array.isArray(raw) ? raw : [];
}

export function resolveNativeRingGeometryFromRegion(regionDocument, runtime = null, shapes = null) {
  const runtimeFlags = runtime ?? getRegionRuntimeFlags(regionDocument);
  const regionShapes = Array.isArray(shapes) ? shapes : getRegionShapeData(regionDocument);
  const isV14NativeRing =
    isFoundryV14OrNewer() &&
    (
      runtimeFlags?.architecturePath === "v14-region-native" ||
      runtimeFlags?.regionSourceStrategy === "v14-native-region-shapes" ||
      runtimeFlags?.creationSource === "persistent-zones-v14-native-region"
    );
  if (!isV14NativeRing) {
    return null;
  }

  const shape = regionShapes.find((candidate) => String(candidate?.type ?? "").toLowerCase() === "ring") ?? null;
  if (!shape) {
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

function pointInShape(shape, point) {
  if (shape?.polygonMode === "annulus") {
    return pointInAnnulusPolygon(shape, point);
  }

  switch (shape?.type) {
    case "circle":
      return pointInCircle(shape, point);
    case "cone":
      return pointInCone(shape, point);
    case "emanation":
      return pointInEmanation(shape, point);
    case "ellipse":
      return pointInEllipse(shape, point);
    case "line":
      return pointInLine(shape, point);
    case "rectangle":
      return pointInRectangle(shape, point);
    case "ring":
      return pointInRing(shape, point);
    case "polygon":
      return pointInPolygon(shape.points, point);
    default:
      return false;
  }
}

function pointInAnnulusPolygon(shape, point) {
  const points = normalizePolygonPoints(shape.points);
  if (points.length < 6) {
    return false;
  }

  const bounds = calculatePointBounds(points);
  const center = {
    x: bounds.minX + ((bounds.maxX - bounds.minX) / 2),
    y: bounds.minY + ((bounds.maxY - bounds.minY) / 2)
  };
  const radii = points
    .map((candidate) => Math.hypot(candidate.x - center.x, candidate.y - center.y))
    .filter((radius) => Number.isFinite(radius) && radius > 0);
  const outerRadius = Math.max(...radii);
  const innerRadius = Math.min(...radii);
  const pointRadius = Math.hypot(point.x - center.x, point.y - center.y);

  return pointRadius <= outerRadius && pointRadius >= innerRadius;
}

function calculatePointBounds(points) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}

function pointInEmanation(shape, point) {
  const center = findEmanationCenter(shape);
  const radius = coerceNumber(shape?.radius, 0);
  return Math.hypot(point.x - center.x, point.y - center.y) <= radius;
}

function findEmanationCenter(shape) {
  const base = shape?.base ?? {};
  if (base.type === "token") {
    const gridSize = coerceNumber(canvas?.grid?.size, 100) || 100;
    const width = Math.max(coerceNumber(base.width, 1), 0.1) * gridSize;
    const height = Math.max(coerceNumber(base.height, 1), 0.1) * gridSize;
    return {
      x: coerceNumber(base.x, 0) + (width / 2),
      y: coerceNumber(base.y, 0) + (height / 2)
    };
  }

  return {
    x: coerceNumber(base.x ?? shape?.x, 0),
    y: coerceNumber(base.y ?? shape?.y, 0)
  };
}

function pointInCircle(shape, point) {
  const radius = coerceNumber(shape.radius, 0);
  const dx = point.x - coerceNumber(shape.x, 0);
  const dy = point.y - coerceNumber(shape.y, 0);
  return (dx * dx) + (dy * dy) <= radius * radius;
}

function pointInRing(shape, point) {
  const radius = coerceNumber(shape.radius, 0);
  const innerWidth = Math.max(0, coerceNumber(shape.innerWidth, 0));
  const outerWidth = Math.max(0, coerceNumber(shape.outerWidth, 0));
  const innerRadius = Math.max(0, radius - innerWidth);
  const outerRadius = Math.max(radius, radius + outerWidth);
  const distance = Math.hypot(point.x - coerceNumber(shape.x, 0), point.y - coerceNumber(shape.y, 0));
  return distance >= innerRadius && distance <= outerRadius;
}

function pointInCone(shape, point) {
  const radius = coerceNumber(shape.radius, 0);
  const angle = Math.max(0, Math.min(360, coerceNumber(shape.angle, 0)));
  if (!radius || !angle) {
    return false;
  }

  const origin = { x: coerceNumber(shape.x, 0), y: coerceNumber(shape.y, 0) };
  const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
  if (distance > radius) {
    return false;
  }
  if (angle >= 360) {
    return true;
  }

  const rotation = (coerceNumber(shape.rotation, 0) * Math.PI) / 180;
  const localPoint = rotation ? rotatePoint(point, origin, -rotation) : point;
  const theta = Math.atan2(localPoint.y - origin.y, localPoint.x - origin.x);
  const halfAngle = (angle * Math.PI) / 360;
  const normalized = Math.atan2(Math.sin(theta), Math.cos(theta));
  return Math.abs(normalized) <= halfAngle;
}

function pointInLine(shape, point) {
  const origin = { x: coerceNumber(shape.x, 0), y: coerceNumber(shape.y, 0) };
  const length = coerceNumber(shape.length, 0);
  const halfWidth = coerceNumber(shape.width, 0) / 2;
  if (!length || !halfWidth) {
    return false;
  }

  const rotation = (coerceNumber(shape.rotation, 0) * Math.PI) / 180;
  const localPoint = rotation ? rotatePoint(point, origin, -rotation) : point;
  const localX = localPoint.x - origin.x;
  const localY = localPoint.y - origin.y;
  return localX >= 0 && localX <= length && Math.abs(localY) <= halfWidth;
}

function pointInEllipse(shape, point) {
  const width = coerceNumber(shape.width, null);
  const height = coerceNumber(shape.height, null);
  const radiusX = coerceNumber(shape.radiusX, width !== null ? width / 2 : null);
  const radiusY = coerceNumber(shape.radiusY, height !== null ? height / 2 : null);
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

  if (!radiusX || !radiusY) {
    return false;
  }

  const rotation = (coerceNumber(shape.rotation, 0) * Math.PI) / 180;
  const localPoint = rotation
    ? rotatePoint(point, { x: centerX, y: centerY }, -rotation)
    : point;
  const dx = localPoint.x - centerX;
  const dy = localPoint.y - centerY;

  return ((dx * dx) / (radiusX * radiusX)) + ((dy * dy) / (radiusY * radiusY)) <= 1;
}

function pointInRectangle(shape, point) {
  const x = coerceNumber(shape.x, 0);
  const y = coerceNumber(shape.y, 0);
  const width = coerceNumber(shape.width, 0);
  const height = coerceNumber(shape.height, 0);
  const rotation = (coerceNumber(shape.rotation, 0) * Math.PI) / 180;

  if (!rotation) {
    return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
  }

  const localPoint = rotatePoint(point, { x, y }, -rotation);
  return (
    localPoint.x >= x &&
    localPoint.x <= x + width &&
    localPoint.y >= y &&
    localPoint.y <= y + height
  );
}

function rotatePoint(point, origin, radians) {
  const translatedX = point.x - origin.x;
  const translatedY = point.y - origin.y;

  return {
    x: origin.x + (translatedX * Math.cos(radians)) - (translatedY * Math.sin(radians)),
    y: origin.y + (translatedX * Math.sin(radians)) + (translatedY * Math.cos(radians))
  };
}

function pointInPolygon(points, point) {
  const normalizedPoints = normalizePolygonPoints(points);
  if (normalizedPoints.length < 3) {
    return false;
  }

  let inside = false;

  for (let i = 0, j = normalizedPoints.length - 1; i < normalizedPoints.length; j = i, i += 1) {
    const { x: xi, y: yi } = normalizedPoints[i];
    const { x: xj, y: yj } = normalizedPoints[j];

    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || Number.EPSILON) + xi;

    if (intersects) {
      inside = !inside;
    }

  }

  return inside;
}

function normalizePolygonPoints(points) {
  if (!Array.isArray(points)) {
    return [];
  }

  if (points.every((point) => typeof point === "number")) {
    const normalized = [];
    for (let index = 0; index < points.length - 1; index += 2) {
      normalized.push({
        x: coerceNumber(points[index], 0),
        y: coerceNumber(points[index + 1], 0)
      });
    }
    return normalized;
  }

  return points
    .map((point) => {
      if (Array.isArray(point)) {
        return {
          x: coerceNumber(point[0], null),
          y: coerceNumber(point[1], null)
        };
      }
      return {
        x: coerceNumber(point?.x, null),
        y: coerceNumber(point?.y, null)
      };
    })
    .filter((point) => point.x !== null && point.y !== null);
}

function isRingLikeRuntime(runtime, shapes) {
  if (runtime?.ringGeometry) {
    return true;
  }

  const geometryType = String(runtime?.normalizedDefinition?.geometry?.type ?? "").toLowerCase();
  if (geometryType.includes("ring")) {
    return true;
  }

  return shapes.length > 1 && shapes.every((shape) => shape?.type === "polygon");
}

function testTokenInsideRuntimeRing(membership, runtime, nativeRingGeometry = null) {
  const ringGeometry = nativeRingGeometry ?? runtime?.ringGeometry ?? null;
  if (!ringGeometry) {
    return null;
  }

  const centerX = coerceNumber(ringGeometry.centerX, null);
  const centerY = coerceNumber(ringGeometry.centerY, null);
  const innerRadius = coerceNumber(ringGeometry.innerRadiusPixels, null);
  const outerRadius = coerceNumber(ringGeometry.outerRadiusPixels, null);
  if (centerX === null || centerY === null || innerRadius === null || outerRadius === null || outerRadius <= 0 || innerRadius < 0 || innerRadius >= outerRadius) {
    return {
      tokenInsideRingBand: false,
      tokenInsideRingHole: false,
      ringRejectReason: "invalid-ring-runtime-geometry"
    };
  }

  const tokenCenter = getTokenCenter({ ...membership, object: null });
  const distance = Math.hypot(tokenCenter.x - centerX, tokenCenter.y - centerY);
  const tokenInsideRingHole = distance < innerRadius;
  const tokenInsideRingBand = distance >= innerRadius && distance <= outerRadius;

  return {
    tokenInsideRingBand,
    tokenInsideRingHole,
    ringRejectReason: tokenInsideRingBand
      ? null
      : tokenInsideRingHole
        ? "token-center-inside-ring-hole"
        : "token-center-outside-ring"
  };
}

function pointInsideRingOuterEnvelope(shapes, membership) {
  const center = getTokenCenter({ ...membership, object: null });
  const points = shapes
    .filter((shape) => shape?.type === "polygon")
    .flatMap((shape) => normalizePolygonPoints(shape.points));

  if (!points.length) {
    return false;
  }

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const envelopeCenter = {
    x: minX + ((maxX - minX) / 2),
    y: minY + ((maxY - minY) / 2)
  };
  const outerRadius = Math.max(...points.map((point) => Math.hypot(point.x - envelopeCenter.x, point.y - envelopeCenter.y)));

  return Math.hypot(center.x - envelopeCenter.x, center.y - envelopeCenter.y) <= outerRadius;
}

function isFoundryV14OrNewer() {
  const version = String(globalThis.game?.version ?? globalThis.game?.data?.version ?? "");
  const major = Number.parseInt(version.split(".")[0], 10);
  return Number.isFinite(major) && major >= 14;
}

function logV14RuntimeDiagnostic(message, data = {}) {
  if (!isFoundryV14OrNewer()) {
    return;
  }

  console.debug(`[${MODULE_ID}][v14-runtime] ${message}`, data);
}

function buildTokenRegionMembershipState(tokenDocument, state = null) {
  return {
    x: coerceNumber(state?.position?.x, coerceNumber(tokenDocument?.x, 0)),
    y: coerceNumber(state?.position?.y, coerceNumber(tokenDocument?.y, 0)),
    elevation: coerceNumber(
      state?.elevation,
      coerceNumber(tokenDocument?._source?.elevation, coerceNumber(tokenDocument?.elevation, 0))
    ),
    width: coerceNumber(
      state?.width,
      coerceNumber(tokenDocument?._source?.width, coerceNumber(tokenDocument?.width, 1))
    ),
    height: coerceNumber(
      state?.height,
      coerceNumber(tokenDocument?._source?.height, coerceNumber(tokenDocument?.height, 1))
    ),
    shape: state?.shape ?? tokenDocument?._source?.shape ?? tokenDocument?.shape ?? null
  };
}

function normalizeManagedRegionTargeting(targetingDefinition = {}) {
  const definition = isPlainObject(targetingDefinition) ? targetingDefinition : {};
  const explicitMode = String(definition?.mode ?? "").trim().toLowerCase();
  const legacyMode = ["all", "allies", "enemies", "self", "not-self"].includes(explicitMode)
    ? explicitMode
    : "";
  const includeSelf = coerceBoolean(definition?.includeSelf, legacyMode === "not-self" ? false : true);
  const hasExplicitSelections = ["self", "allies", "enemies"]
    .some((key) => definition?.[key] !== undefined);
  const fallbackSelections = buildManagedRegionTargetSelectionsFromLegacyMode(
    legacyMode || (includeSelf === false ? "not-self" : "all")
  );
  const selections = hasExplicitSelections || explicitMode === "custom"
    ? {
        self: coerceBoolean(
          pickFirstDefined(definition?.self, definition?.includeSelf),
          fallbackSelections.self
        ) ?? fallbackSelections.self,
        allies: coerceBoolean(definition?.allies, fallbackSelections.allies) ?? fallbackSelections.allies,
        enemies: coerceBoolean(definition?.enemies, fallbackSelections.enemies) ?? fallbackSelections.enemies
      }
    : fallbackSelections;
  const targetFilter = summarizeManagedRegionTargetSelections(selections);

  return {
    mode: targetFilter === "all" ? "all" : "custom",
    self: selections.self,
    allies: selections.allies,
    enemies: selections.enemies,
    includeSelf: selections.self,
    targetFilter,
    hasSelections: selections.self || selections.allies || selections.enemies
  };
}

function buildManagedRegionTargetSelectionsFromLegacyMode(mode) {
  switch (String(mode ?? "").trim().toLowerCase()) {
    case "self":
      return { self: true, allies: false, enemies: false };
    case "allies":
      return { self: false, allies: true, enemies: false };
    case "enemies":
      return { self: false, allies: false, enemies: true };
    case "not-self":
      return { self: false, allies: true, enemies: true };
    case "all":
    default:
      return { self: true, allies: true, enemies: true };
  }
}

function summarizeManagedRegionTargetSelections({
  self = false,
  allies = false,
  enemies = false
} = {}) {
  if (self && allies && enemies) {
    return "all";
  }

  if (!self && !allies && !enemies) {
    return "none";
  }

  if (self && !allies && !enemies) {
    return "self";
  }

  if (!self && allies && !enemies) {
    return "allies";
  }

  if (!self && !allies && enemies) {
    return "enemies";
  }

  if (!self && allies && enemies) {
    return "not-self";
  }

  if (self && allies && !enemies) {
    return "self+allies";
  }

  if (self && !allies && enemies) {
    return "self+enemies";
  }

  return "custom";
}

function collectManagedRegionTargetSelectionLabels(targeting = {}) {
  const normalized = normalizeManagedRegionTargeting(targeting);
  return [
    normalized.self ? "self" : null,
    normalized.allies ? "allies" : null,
    normalized.enemies ? "enemies" : null
  ].filter(Boolean);
}

function resolveManagedRegionSourceToken(regionDocument, tokenDocument, sourceActorUuid, sourceTokenUuid = null) {
  const scene =
    regionDocument?.parent ??
    tokenDocument?.parent ??
    canvas?.scene ??
    null;
  const tokenDocuments =
    scene?.tokens?.contents ??
    Array.from(scene?.tokens?.values?.() ?? []);

  if (!tokenDocuments.length) return null;
  if (sourceTokenUuid) {
    return tokenDocuments.find((candidate) => candidate?.uuid === sourceTokenUuid) ?? null;
  }
  if (!sourceActorUuid) return null;
  const actorTokens = tokenDocuments.filter((candidate) => candidate?.actor?.uuid === sourceActorUuid);
  return actorTokens.length === 1 ? actorTokens[0] : null;
}

function resolveManagedRegionSourceTokenByUuid(regionDocument, tokenDocument, sourceTokenUuid) {
  if (!sourceTokenUuid) return null;
  const scene = regionDocument?.parent ?? tokenDocument?.parent ?? globalThis.canvas?.scene ?? null;
  const tokenDocuments = scene?.tokens?.contents ?? Array.from(scene?.tokens?.values?.() ?? []);
  return tokenDocuments.find((candidate) => candidate?.uuid === sourceTokenUuid) ?? null;
}

function sampleTokenRegionPoints({ x, y, width, height }) {
  const gridSize = coerceNumber(canvas?.grid?.size, 100) || 100;
  const tokenWidth = Math.max(coerceNumber(width, 1), 0.1) * gridSize;
  const tokenHeight = Math.max(coerceNumber(height, 1), 0.1) * gridSize;
  const left = coerceNumber(x, 0);
  const top = coerceNumber(y, 0);
  const right = left + tokenWidth;
  const bottom = top + tokenHeight;
  const centerX = left + tokenWidth / 2;
  const centerY = top + tokenHeight / 2;

  return [
    { x: centerX, y: centerY },
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: centerX, y: top },
    { x: centerX, y: bottom },
    { x: left, y: centerY },
    { x: right, y: centerY }
  ];
}
