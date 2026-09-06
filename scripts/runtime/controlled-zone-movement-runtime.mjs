import { MODULE_ID } from "../constants.mjs";
import {
  distanceToPixels,
  findManagedRegions,
  fromUuidSafe,
  calculateTokenRegionGridCoverage,
  createManagedRegionMembershipCandidate,
  getRegionRuntimeFlags,
  getPersistentZoneTokenMembershipMode,
  isPrimaryGM,
  testTokenInsideManagedRegion
} from "./utils.mjs";
import {
  getRegionLogicalCenter,
  resolveMoveCollision,
  translateManagedRegionByVector
} from "./zone-translation-runtime.mjs";
import { translateRegionShapeData } from "./region-factory.mjs";
import { sweepPhysicalBodyAgainstTokens } from "./physical-targeting.mjs";
import { applyConfiguredTriggerEffect } from "./entry-effects.mjs";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SESSION_TTL_MS = 60_000;
const clientSessions = new Map();
const gmAuthorizations = new Map();
const pendingRequests = new Map();
let registered = false;
let socketRegistered = false;

/** Register the optional D&D5e utility-Activity bridge and the GM socket endpoint. */
export function registerControlledZoneMovementRuntime() {
  if (registered) return;
  registered = true;
  Hooks.on("dnd5e.preUseActivity", onPreUseActivity);
  Hooks.on("dnd5e.postUseActivity", onPostUseActivity);
  Hooks.once("ready", registerControlledZoneMovementSocket);
}

function registerControlledZoneMovementSocket() {
  if (socketRegistered || !globalThis.game?.socket?.on) return;
  socketRegistered = true;
  game.socket.on(SOCKET_CHANNEL, onSocketMessage);
}

function onPreUseActivity(activity, usage = {}) {
  const bridge = getActivityBridgeConfig(activity);
  if (!bridge) return;
  preventControlledMovementConcentration(activity, usage, bridge);
}

async function onPostUseActivity(activity, usage = {}) {
  const bridge = getActivityBridgeConfig(activity);
  if (!bridge) return;
  await startControlledZoneMovementFromActivity(activity, usage, bridge);
}

function getActivityBridgeConfig(activity) {
  const value = activity?.flags?.[MODULE_ID]?.controlledZoneMovement ??
    activity?._source?.flags?.[MODULE_ID]?.controlledZoneMovement ?? null;
  if (!value || typeof value !== "object" || value.enabled !== true) return null;
  const primaryActivityId = String(value.primaryActivityId ?? "").trim();
  return primaryActivityId ? { primaryActivityId } : null;
}

/**
 * D&D5e prepares concentration from the Activity just before finalization.
 * A flagged PZ Utility only commands an existing cast, so it must not begin
 * or replace concentration even if an imported/legacy source marked it so.
 */
export function preventControlledMovementConcentration(activity, usage = {}, bridge = getActivityBridgeConfig(activity)) {
  if (!bridge) return false;
  usage.concentration ??= {};
  usage.concentration.begin = false;
  usage.concentration.end = null;
  return true;
}

/** Start a client-only interaction session for the uniquely matching managed Region. */
export async function startControlledZoneMovementFromActivity(activity, usage = {}, bridge = getActivityBridgeConfig(activity)) {
  if (!bridge) return fail("missing-bridge-config");
  const user = globalThis.game?.user ?? null;
  const sourceToken = resolveActivitySourceToken(activity, usage);
  const regionDocument = resolveControlledRegionFromActivity(activity, usage, bridge, sourceToken);
  if (!regionDocument) {
    notify("PERSISTENT_ZONES.ControlledMovement.RegionNotFound", "No uniquely matching persistent zone is active.", "warn");
    return fail("region-not-found");
  }
  return openControlledZoneMovementSession({ regionDocument, user, sourceToken, activity, bridge });
}

/**
 * Open a temporary, non-persisted client interaction. A normal Region edit
 * never reaches this function, which keeps gameplay movement distinct.
 */
export async function openControlledZoneMovementSession({
  regionDocument,
  user = globalThis.game?.user ?? null,
  sourceToken = null,
  activity = null,
  bridge = null,
  preview = true
} = {}) {
  const runtime = getRegionRuntimeFlags(regionDocument);
  const config = runtime?.normalizedDefinition?.controlledMovement ?? null;
  if (!regionDocument || !config?.enabled) return fail("controlled-movement-disabled");
  if (!canUserControlRegion(user, regionDocument, runtime)) return fail("permission-denied");
  const scene = regionDocument.parent ?? globalThis.canvas?.scene ?? null;
  const maxPixels = distanceToPixels(config.maxDistance, scene);
  if (!(maxPixels > 0)) return fail("invalid-max-distance");
  const targeting = getControlledMovementTargeting(runtime, config, scene);

  const session = {
    id: randomId(),
    userId: user?.id ?? null,
    regionUuid: regionDocument.uuid ?? null,
    regionId: regionDocument.id ?? null,
    sceneId: scene?.id ?? null,
    sourceTokenUuid: sourceToken?.uuid ?? runtime?.sourceTokenUuid ?? null,
    openedAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    maxDistance: config.maxDistance,
    targetingMode: targeting.mode,
    moveTrigger: targeting.trigger,
    physicalBody: targeting.body,
    physicalRadius: targeting.body?.radius ?? distanceToPixels(config.physicalRadius ?? 0, scene),
    units: config.units ?? "scene",
    maxPixels,
    origin: getRegionLogicalCenter(regionDocument),
    regionDocument,
    previewState: null
  };
  clientSessions.set(session.id, session);
  await authorizeSession(session);
  if (preview) attachCanvasPreview(session);
  return { ok: true, session };
}

function resolveControlledRegionFromActivity(activity, usage, bridge, sourceToken = resolveActivitySourceToken(activity, usage)) {
  return findControlledRegionForActivity({
    scene: sourceToken?.parent ?? globalThis.canvas?.scene ?? null,
    itemUuid: activity?.item?.uuid ?? activity?.parent?.uuid ?? null,
    actorUuid: activity?.actor?.uuid ?? activity?.item?.actor?.uuid ?? null,
    primaryActivityId: bridge?.primaryActivityId ?? null,
    sourceTokenUuid: sourceToken?.uuid ?? null
  });
}

/**
 * The move trigger owns targeting semantics. Controlled movement only supplies
 * the path and optional physical body; it never keeps a competing mode field.
 */
function getControlledMovementTargeting(runtime, config, scene) {
  const trigger = runtime?.normalizedDefinition?.triggers?.onMove ?? runtime?.normalizedDefinition?.triggers?.move ?? null;
  const requestedMode = trigger?.targeting?.mode;
  const mode = requestedMode === "physical-contact" ? "physical-contact" : "membership";
  const radius = distanceToPixels(config?.physicalRadius ?? 0, scene);
  return {
    mode,
    trigger,
    body: mode === "physical-contact" ? { type: "circle", radius } : null
  };
}

/** Commit a chosen scene-space destination after enforcing the configured limit. */
export async function commitControlledZoneMovement(sessionOrId, destination) {
  const session = typeof sessionOrId === "string" ? clientSessions.get(sessionOrId) : sessionOrId;
  if (!session || !clientSessions.has(session.id)) return fail("session-closed");
  if (session.expiresAt < Date.now()) {
    if (session) closeControlledZoneMovementSession(session, "expired");
    return fail("session-expired");
  }
  const check = validateDestination(session, destination);
  if (!check.ok) return check;
  const payload = {
    kind: "controlled-zone-movement-request",
    requestId: randomId(),
    sessionId: session.id,
    userId: session.userId,
    regionUuid: session.regionUuid,
    sceneId: session.sceneId,
    destination: check.destination
  };
  const result = isPrimaryGM()
    ? await executeControlledZoneMovement(payload)
    : await requestGMControlledZoneMovement(payload);
  if (result?.ok) closeControlledZoneMovementSession(session, "success");
  return result;
}

/** Cancel a preview/session without ever updating a Region document. */
export function closeControlledZoneMovementSession(sessionOrId, reason = "cancelled") {
  const session = typeof sessionOrId === "string" ? clientSessions.get(sessionOrId) : sessionOrId;
  if (!session) return false;
  detachCanvasPreview(session);
  clientSessions.delete(session.id);
  if (isPrimaryGM()) gmAuthorizations.delete(session.id);
  return reason;
}

export function validateDestination(session, destination) {
  const point = normalizePoint(destination);
  if (!point) return fail("invalid-destination");
  const dx = point.x - session.origin.x;
  const dy = point.y - session.origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance > session.maxPixels + 1e-4) {
    return { ...fail("destination-out-of-range"), distance, maxDistance: session.maxPixels, destination: point };
  }
  return { ok: true, destination: point, dx, dy, distance };
}

/** Execute the persisted Region update. This runs only on the primary GM. */
export async function executeControlledZoneMovement(payload = {}) {
  if (!isPrimaryGM()) return fail("not-primary-gm");
  trimExpiredAuthorizations();
  const authorization = gmAuthorizations.get(payload.sessionId);
  if (!authorization || authorization.userId !== payload.userId || authorization.regionUuid !== payload.regionUuid) {
    return fail("session-not-authorized");
  }
  const regionDocument = await fromUuidSafe(payload.regionUuid);
  if (!regionDocument || regionDocument.documentName !== "Region") return fail("region-not-found");
  const runtime = getRegionRuntimeFlags(regionDocument);
  const config = runtime?.normalizedDefinition?.controlledMovement ?? null;
  if (!config?.enabled || !canUserControlRegion(game.users?.get?.(payload.userId) ?? null, regionDocument, runtime)) {
    return fail("permission-denied");
  }
  const session = {
    origin: getRegionLogicalCenter(regionDocument),
    maxPixels: distanceToPixels(config.maxDistance, regionDocument.parent ?? globalThis.canvas?.scene ?? null),
    physicalRadius: distanceToPixels(config.physicalRadius ?? 0, regionDocument.parent ?? globalThis.canvas?.scene ?? null)
  };
  const check = validateDestination(session, payload.destination);
  if (!check.ok) return check;
  const origin = session.origin;
  const scene = regionDocument.parent ?? globalThis.canvas?.scene ?? null;
  const targeting = getControlledMovementTargeting(runtime, config, scene);
  // Preserve the validated center-to-wall behavior first, then sweep the
  // configured candidate Region geometry along the still-reachable segment.
  const resolution = resolveControlledMovementDestination({
    scene,
    regionDocument,
    origin,
    destination: check.destination,
    physicalRadius: targeting.body?.radius ?? session.physicalRadius,
    targeting
  });
  const tokenCollision = resolution.tokenCollision;
  const resolvedDestination = resolution.resolvedDestination;
  const result = await translateManagedRegionByVector(regionDocument, {
    x: resolvedDestination.x - origin.x,
    y: resolvedDestination.y - origin.y
  }, {
    updateOptions: {
      persistentZonesControlledMovement: true,
      persistentZonesControlledMovementContext: { sessionId: payload.sessionId, userId: payload.userId }
    }
  });
  const contactTrigger = targeting.trigger;
  if (tokenCollision?.token && targeting.mode === "physical-contact" && contactTrigger?.enabled) {
    await applyConfiguredTriggerEffect({ regionDocument, tokenDocument: tokenCollision.token, triggerConfig: contactTrigger, timing: "onMove", context: { targetingMode: "physical-contact", physicalContact: tokenCollision } });
  }
  gmAuthorizations.delete(payload.sessionId);
  return {
    ok: Boolean(result?.moved),
    regionUuid: regionDocument.uuid ?? payload.regionUuid,
    result,
    collidedTokenUuid: tokenCollision?.tokenUuid ?? null,
    collisionPoint: tokenCollision?.collisionPoint ?? null,
    collisionDistance: tokenCollision?.collisionDistance ?? null
  };
}

export function resolveControlledMovementDestination({ scene, regionDocument, origin, destination, physicalRadius, targeting = null }) {
  const vector = { x: destination.x - origin.x, y: destination.y - origin.y };
  const wallResolved = resolveMoveCollision(origin, vector, { scene, regionDocument });
  const wallDestination = wallResolved.finalDestination ?? {
    x: origin.x + wallResolved.dx,
    y: origin.y + wallResolved.dy
  };
  const runtime = getRegionRuntimeFlags(regionDocument, { silent: true });
  const config = runtime?.normalizedDefinition?.controlledMovement ?? {};
  const effectiveTargeting = targeting ?? getControlledMovementTargeting(runtime, config, scene);
  const physicalContact = effectiveTargeting.mode === "physical-contact";
  const tokenCollection = physicalContact ? collectControlledMovementTokens(scene) : null;
  const tokenCollision = physicalContact
    ? sweepPhysicalBodyAgainstTokens({ origin, destination: wallDestination, body: effectiveTargeting.body ?? { type: "circle", radius: physicalRadius }, tokens: tokenCollection.tokens, scene })
    : analyzeControlledTokenCollision({ scene, regionDocument, origin, destination: wallDestination, physicalRadius }).collision;
  const collisionAnalysis = physicalContact
    ? { collision: tokenCollision, testMode: "physical-contact", candidateTokenCount: tokenCollection.tokens.length }
    : analyzeControlledTokenCollision({ scene, regionDocument, origin, destination: wallDestination, physicalRadius });
  const resolvedDestination = tokenCollision?.resolvedDestination ?? tokenCollision?.destination ?? wallDestination;
  const stopReason = tokenCollision
    ? "physical-contact"
    : (wallResolved.reason === "full-distance" ? "none" : "wall");
  return {
    wallResolved,
    wallDestination,
    collisionAnalysis,
    tokenCollision,
    // Physical sweep returns the first contact point as `destination`; keep
    // the legacy membership solver's `resolvedDestination` shape too.
    resolvedDestination,
    stopReason
  };
}

/**
 * Return the first outside-to-inside transition according to the central PZ
 * membership policy, evaluated against the moving candidate shapes.
 */
export function resolveControlledTokenCollision({ scene = null, regionDocument = null, origin, destination, physicalRadius = 0 } = {}) {
  return analyzeControlledTokenCollision({ scene, regionDocument, origin, destination, physicalRadius }).collision;
}

export function analyzeControlledTokenCollision({ scene = null, regionDocument = null, origin, destination, physicalRadius = 0 } = {}) {
  const radius = Math.max(0, Number(physicalRadius) || 0);
  const gridType = scene?.grid?.type ?? globalThis.canvas?.grid?.type ?? null;
  const tokenCollection = collectControlledMovementTokens(scene);
  const solver = createControlledMembershipSolver(regionDocument, radius);
  const initialCollisionGeometry = origin
    ? getControlledCollisionGeometry(regionDocument, origin, radius, solver)
    : null;
  if (!origin || !destination || !initialCollisionGeometry?.shapes?.length) {
    return {
      collision: null,
      candidateTokenCount: 0,
      gridType,
      testMode: "pZ-membership-sweep",
      tokenCollection,
      metrics: solver.metrics,
      candidateDiagnostics: tokenCollection.tokens.map((token) => ({
        tokenId: getControlledTokenId(token),
        accepted: false,
        reason: "invalid-sweep"
      }))
    };
  }
  const candidateDiagnostics = [];
  const candidates = [];
  const collisionGeometry = initialCollisionGeometry;
  const sweepBounds = getControlledMovementSweepBounds(origin, destination, collisionGeometry.radius);
  for (const entry of tokenCollection.entries) {
    const token = entry.document;
    const actor = getControlledTokenActor(entry);
    const bounds = getControlledTokenBounds(token, scene);
    const inSweepBounds = Boolean(bounds && rectanglesIntersect(bounds, sweepBounds));
    const diagnostic = {
      tokenId: getControlledTokenId(token),
      tokenUuid: getControlledTokenUuid(token),
      actorId: actor?.id ?? actor?._id ?? null,
      source: entry.sources.join(","),
      bounds,
      accepted: Boolean(actor && inSweepBounds),
      reason: !actor ? "missing-actor" : !bounds ? "invalid-bounds" : !inSweepBounds ? "outside-sweep-bounds" : "accepted"
    };
    candidateDiagnostics.push(diagnostic);
    if (diagnostic.accepted) candidates.push(token);
  }
  let first = null;
  for (const token of candidates) {
    const sweep = findControlledMembershipTransition({
      token,
      regionDocument,
      origin,
      destination,
      physicalRadius: radius,
      solver
    });
    const transition = sweep.transition;
    if (!transition) continue;
    if (first && transition.fraction >= first.fraction) continue;
    const dx = destination.x - origin.x;
    const dy = destination.y - origin.y;
    const collisionPoint = { x: origin.x + (dx * transition.fraction), y: origin.y + (dy * transition.fraction) };
    first = {
      token,
      tokenUuid: token.uuid ?? null,
      tokenId: token.id ?? null,
      fraction: transition.fraction,
      collisionPoint,
      resolvedDestination: collisionPoint,
      collisionDistance: Math.hypot(dx, dy) * transition.fraction,
      startMembership: transition.startMembership,
      previousMembership: transition.previousMembership,
      resolvedMembership: transition.resolvedMembership,
      coverageRatio: transition.coverageRatio,
      membershipMode: transition.membershipMode,
      collisionGeometry: transition.collisionGeometry,
      transition: "outside-to-inside"
    };
  }
  return {
    collision: first,
    candidateTokenCount: candidates.length,
    gridType,
    testMode: "pZ-membership-sweep",
    tokenCollection,
    candidateDiagnostics,
    metrics: solver.metrics
  };
}

function createControlledMembershipSolver(regionDocument, physicalRadius) {
  const runtime = getRegionRuntimeFlags(regionDocument, { silent: true }) ?? {};
  const definition = runtime.normalizedDefinition ?? {};
  const elevation = definition.elevation;
  const membershipMode = getPersistentZoneTokenMembershipMode();
  const requiresNativeCandidate = membershipMode === "foundry-native" ||
    definition.obstacles?.mode === "wall-restricted" ||
    (elevation && (elevation.bottom !== null || elevation.top !== null));
  return {
    runtime,
    definition,
    membershipMode,
    requiresNativeCandidate,
    physicalRadius,
    baseCenter: getRegionLogicalCenter(regionDocument),
    baseShapes: Array.from(regionDocument?._source?.shapes ?? []),
    geometryCache: new Map(),
    nativeCandidateCache: new Map(),
    tokenStateCache: new Map(),
    metrics: { samples: 0, membershipCalls: 0, regionClones: 0, geometryTranslations: 0 }
  };
}

function getControlledMovementSweepBounds(origin, destination, radius) {
  return {
    x: Math.min(origin.x, destination.x) - radius,
    y: Math.min(origin.y, destination.y) - radius,
    width: Math.abs(destination.x - origin.x) + (radius * 2),
    height: Math.abs(destination.y - origin.y) + (radius * 2)
  };
}

function rectanglesIntersect(left, right) {
  return left.x <= (right.x + right.width) &&
    (left.x + left.width) >= right.x &&
    left.y <= (right.y + right.height) &&
    (left.y + left.height) >= right.y;
}

function collectControlledMovementTokens(scene) {
  const sceneTokens = scene?.tokens ?? null;
  const sceneContents = collectionToArray(sceneTokens?.contents);
  const sceneValues = !sceneContents.length && typeof sceneTokens?.values === "function"
    ? collectionToArray(sceneTokens.values())
    : [];
  const canvasMatchesScene = globalThis.canvas?.scene === scene ||
    (scene?.id && globalThis.canvas?.scene?.id === scene.id);
  const canvasPlaceables = canvasMatchesScene
    ? collectionToArray(globalThis.canvas?.tokens?.placeables)
    : [];
  const sources = [
    { name: "scene.tokens.contents", tokens: sceneContents },
    { name: "scene.tokens.values", tokens: sceneValues },
    { name: "canvas.tokens.placeables", tokens: canvasPlaceables }
  ];
  const entries = new Map();
  for (const source of sources) {
    for (const value of source.tokens) {
      const token = normalizeControlledTokenDocument(value);
      const identity = getControlledTokenUuid(token) ?? getControlledTokenId(token);
      if (!token || !identity) continue;
      const existing = entries.get(identity);
      if (existing) {
        existing.representations.push(value);
        existing.sources.push(source.name);
        continue;
      }
      entries.set(identity, {
        document: token,
        representations: [value],
        sources: [source.name]
      });
    }
  }
  return {
    entries: Array.from(entries.values()),
    tokens: Array.from(entries.values(), (entry) => entry.document),
    sources: sources.map((source) => ({ name: source.name, count: source.tokens.length }))
  };
}

function collectionToArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    return Array.from(value);
  } catch (_caughtError) {
    return [];
  }
}

function normalizeControlledTokenDocument(token) {
  return token?.document ?? token ?? null;
}

function getControlledTokenActor(entryOrToken) {
  const entry = entryOrToken?.document && Array.isArray(entryOrToken?.representations)
    ? entryOrToken
    : { document: normalizeControlledTokenDocument(entryOrToken), representations: [entryOrToken] };
  return entry.document?.actor ?? entry.representations
    .map((representation) => representation?.actor ?? representation?.document?.actor ?? null)
    .find(Boolean) ?? null;
}

function getControlledTokenId(token) {
  const document = normalizeControlledTokenDocument(token);
  return document?.id ?? token?.id ?? null;
}

function getControlledTokenUuid(token) {
  const document = normalizeControlledTokenDocument(token);
  return document?.uuid ?? token?.uuid ?? null;
}

function getControlledTokenBounds(token, scene) {
  const document = normalizeControlledTokenDocument(token);
  const placeableBounds = token?.object?.bounds ?? token?.bounds ?? document?.object?.bounds ?? document?.bounds ?? null;
  if ([placeableBounds?.x, placeableBounds?.y, placeableBounds?.width, placeableBounds?.height].every(Number.isFinite)) {
    return { x: placeableBounds.x, y: placeableBounds.y, width: placeableBounds.width, height: placeableBounds.height };
  }
  const gridSize = Number(scene?.grid?.size ?? globalThis.canvas?.grid?.size ?? 100);
  const x = Number(document?.x);
  const y = Number(document?.y);
  const width = Number(document?.width ?? 1) * gridSize;
  const height = Number(document?.height ?? 1) * gridSize;
  return [x, y, width, height].every(Number.isFinite)
    ? { x, y, width, height }
    : null;
}

function findControlledMembershipTransition({ token, regionDocument, origin, destination, physicalRadius, solver }) {
  const startEvaluation = evaluateControlledZoneMembership(token, regionDocument, origin, physicalRadius, solver);
  const startMembership = startEvaluation.inside;
  const dx = destination.x - origin.x;
  const dy = destination.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance > 1e-6)) return { transition: null, samplesEvaluated: 1, maxCoverageRatio: startEvaluation.coverageRatio };
  const sampleCount = getMembershipSweepSampleCount(
    distance,
    getControlledCollisionGeometry(regionDocument, origin, physicalRadius, solver).radius,
    regionDocument?.parent ?? null
  );
  let previousFraction = 0;
  let previousMembership = startMembership;
  let maxCoverageRatio = startEvaluation.coverageRatio ?? 0;
  for (let index = 1; index <= sampleCount; index += 1) {
    const fraction = index / sampleCount;
    solver.metrics.samples += 1;
    const evaluation = evaluateControlledZoneMembership(token, regionDocument, {
      x: origin.x + (dx * fraction),
      y: origin.y + (dy * fraction)
    }, physicalRadius, solver);
    const membership = evaluation.inside;
    if (!previousMembership && membership) {
      const firstInsideFraction = refineMembershipTransition({
        token,
        regionDocument,
        origin,
        destination,
        physicalRadius,
        solver,
        outsideFraction: previousFraction,
        insideFraction: fraction
      });
      const resolvedEvaluation = evaluateControlledZoneMembership(token, regionDocument, {
        x: origin.x + (dx * firstInsideFraction),
        y: origin.y + (dy * firstInsideFraction)
      }, physicalRadius, solver, { includeCoverage: true });
      return {
        transition: {
          fraction: firstInsideFraction,
          startMembership,
          previousMembership: false,
          resolvedMembership: true,
          coverageRatio: resolvedEvaluation.coverageRatio,
          membershipMode: resolvedEvaluation.membershipMode,
          collisionGeometry: resolvedEvaluation.collisionGeometry
        },
        samplesEvaluated: index + 1,
        maxCoverageRatio: Math.max(maxCoverageRatio, resolvedEvaluation.coverageRatio ?? 0)
      };
    }
    previousFraction = fraction;
    previousMembership = membership;
  }
  return { transition: null, samplesEvaluated: sampleCount + 1, maxCoverageRatio };
}

function getMembershipSweepSampleCount(distancePixels, physicalRadius, scene) {
  const gridSize = Number(scene?.grid?.size ?? globalThis.canvas?.grid?.size ?? 100);
  const characteristicLength = Math.max(1, Math.min(gridSize, Math.max(physicalRadius, gridSize / 4)) / 4);
  return Math.min(512, Math.max(32, Math.ceil(distancePixels / characteristicLength)));
}

function refineMembershipTransition({ token, regionDocument, origin, destination, physicalRadius, solver, outsideFraction, insideFraction }) {
  const dx = destination.x - origin.x;
  const dy = destination.y - origin.y;
  let low = outsideFraction;
  let high = insideFraction;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (low + high) / 2;
    solver.metrics.samples += 1;
    const membership = evaluateControlledZoneMembership(token, regionDocument, {
      x: origin.x + (dx * middle),
      y: origin.y + (dy * middle)
    }, physicalRadius, solver).inside;
    if (membership) high = middle;
    else low = middle;
  }
  return high;
}

function evaluateControlledZoneMembership(token, regionDocument, center, radius, solver, { includeCoverage = false } = {}) {
  solver.metrics.membershipCalls += 1;
  const collisionGeometry = getControlledCollisionGeometry(regionDocument, center, radius, solver);
  const candidateShapes = collisionGeometry.shapes;
  const key = getControlledGeometryCacheKey(center, radius);
  let nativeRegionDocument = null;
  if (solver.requiresNativeCandidate) {
    nativeRegionDocument = solver.nativeCandidateCache.get(key) ?? null;
    if (!nativeRegionDocument) {
      nativeRegionDocument = createManagedRegionMembershipCandidate(regionDocument, candidateShapes);
      if (nativeRegionDocument) {
        solver.nativeCandidateCache.set(key, nativeRegionDocument);
        solver.metrics.regionClones += 1;
      }
    }
  }
  const tokenState = getControlledTokenMembershipState(token, solver);
  const inside = testTokenInsideManagedRegion(token, regionDocument, {
    suppressDiagnostics: true,
    candidateShapes,
    nativeRegionDocument,
    runtime: solver.runtime,
    membershipMode: solver.membershipMode,
    ...tokenState
  });
  const coverage = includeCoverage
    ? calculateTokenRegionGridCoverage(tokenState, regionDocument, candidateShapes)
    : null;
  return {
    inside,
    coverageRatio: coverage?.coverageRatio ?? null,
    membershipMode: solver.membershipMode,
    collisionGeometry
  };
}

function getControlledTokenMembershipState(token, solver) {
  const key = getControlledTokenUuid(token) ?? getControlledTokenId(token) ?? token;
  const cached = solver.tokenStateCache.get(key);
  if (cached) return cached;
  const x = Number(token?.x ?? 0);
  const y = Number(token?.y ?? 0);
  const state = {
    x,
    y,
    position: { x, y },
    elevation: Number(token?._source?.elevation ?? token?.elevation ?? 0),
    width: Number(token?._source?.width ?? token?.width ?? 1),
    height: Number(token?._source?.height ?? token?.height ?? 1),
    shape: token?._source?.shape ?? token?.shape ?? null
  };
  solver.tokenStateCache.set(key, state);
  return state;
}

/**
 * A controlled zone normally sweeps its actual Region geometry. An explicit
 * physicalRadius is an opt-in future override for effects whose collision
 * body differs from their visible/membership Region.
 */
function getControlledCollisionGeometry(regionDocument, center, physicalRadius, solver = null) {
  const key = getControlledGeometryCacheKey(center, physicalRadius);
  const cached = solver?.geometryCache.get(key);
  if (cached) return cached;
  const overrideRadius = Math.max(0, Number(physicalRadius) || 0);
  if (overrideRadius > 0) {
    const geometry = {
      source: "physical-radius",
      shapes: [{ type: "circle", x: center.x, y: center.y, radius: overrideRadius }],
      radius: overrideRadius
    };
    solver?.geometryCache.set(key, geometry);
    return geometry;
  }
  const origin = solver?.baseCenter ?? getRegionLogicalCenter(regionDocument);
  const dx = center.x - origin.x;
  const dy = center.y - origin.y;
  const baseShapes = solver?.baseShapes ?? Array.from(regionDocument?._source?.shapes ?? []);
  const shapes = baseShapes
    .map((shape) => translateRegionShapeData(shape, dx, dy));
  solver && (solver.metrics.geometryTranslations += shapes.length);
  const geometry = {
    source: "region-shapes",
    shapes,
    radius: estimateCollisionGeometryRadius(shapes, origin)
  };
  solver?.geometryCache.set(key, geometry);
  return geometry;
}

function getControlledGeometryCacheKey(center, physicalRadius) {
  return `${Number(center?.x ?? 0).toFixed(6)}:${Number(center?.y ?? 0).toFixed(6)}:${Number(physicalRadius ?? 0).toFixed(6)}`;
}

function estimateCollisionGeometryRadius(shapes, center) {
  const circle = shapes.find((shape) => String(shape?.type ?? "").toLowerCase() === "circle" && Number(shape?.radius) > 0);
  if (circle) return Number(circle.radius);
  const bounds = getShapeBounds(shapes);
  if (!bounds) return 0;
  return Math.max(bounds.width, bounds.height) / 2;
}

function findControlledRegionForActivity({ scene, itemUuid, actorUuid, primaryActivityId, sourceTokenUuid = null } = {}) {
  const candidates = findManagedRegions(scene).filter((regionDocument) => {
    const runtime = getRegionRuntimeFlags(regionDocument) ?? {};
    if (runtime.itemUuid !== itemUuid || runtime.actorUuid !== actorUuid || runtime.activityId !== primaryActivityId) return false;
    if (sourceTokenUuid && runtime.sourceTokenUuid && runtime.sourceTokenUuid !== sourceTokenUuid) return false;
    return runtime.normalizedDefinition?.controlledMovement?.enabled === true;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function canUserControlRegion(user, regionDocument, runtime = getRegionRuntimeFlags(regionDocument) ?? {}) {
  if (user?.isGM) return true;
  const actor = regionDocument?.parent?.tokens?.get?.(runtime.sourceTokenId)?.actor ??
    globalThis.fromUuidSync?.(runtime.actorUuid) ?? null;
  if (!actor || !user) return false;
  if (typeof actor.testUserPermission === "function") {
    return actor.testUserPermission(user, "OWNER");
  }
  return false;
}

function resolveActivitySourceToken(activity, usage = {}) {
  const candidates = [usage?.tokenDocument, usage?.token?.document, usage?.token, usage?.workflow?.token?.document, usage?.workflow?.token];
  const explicit = candidates.find((candidate) => candidate?.uuid) ?? null;
  if (explicit) return explicit;
  const actorUuid = activity?.actor?.uuid ?? activity?.item?.actor?.uuid ?? null;
  const controlled = Array.from(globalThis.canvas?.tokens?.controlled ?? [])
    .map((placeable) => placeable?.document ?? placeable)
    .filter((token) => token?.actor?.uuid === actorUuid);
  return controlled.length === 1 ? controlled[0] : null;
}

async function authorizeSession(session) {
  const payload = {
    kind: "controlled-zone-movement-authorize",
    sessionId: session.id,
    userId: session.userId,
    regionUuid: session.regionUuid,
    expiresAt: session.expiresAt
  };
  if (isPrimaryGM()) return registerAuthorization(payload);
  globalThis.game?.socket?.emit?.(SOCKET_CHANNEL, payload);
  return true;
}

function registerAuthorization(payload) {
  if (!isPrimaryGM()) return false;
  const expiresAt = Math.min(Number(payload.expiresAt) || 0, Date.now() + SESSION_TTL_MS);
  if (!payload.sessionId || !payload.userId || !payload.regionUuid || expiresAt <= Date.now()) return false;
  gmAuthorizations.set(payload.sessionId, { userId: payload.userId, regionUuid: payload.regionUuid, expiresAt });
  return true;
}

function requestGMControlledZoneMovement(payload) {
  if (!globalThis.game?.socket?.emit) return Promise.resolve(fail("socket-unavailable"));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(payload.requestId);
      resolve(fail("gm-timeout"));
    }, 10_000);
    pendingRequests.set(payload.requestId, { resolve, timer });
    game.socket.emit(SOCKET_CHANNEL, payload);
  });
}

async function onSocketMessage(payload = {}) {
  if (payload.kind === "controlled-zone-movement-authorize") {
    registerAuthorization(payload);
    return;
  }
  if (payload.kind === "controlled-zone-movement-request" && isPrimaryGM()) {
    const result = await executeControlledZoneMovement(payload);
    globalThis.game?.socket?.emit?.(SOCKET_CHANNEL, {
      kind: "controlled-zone-movement-result",
      requestId: payload.requestId,
      userId: payload.userId,
      result
    });
    return;
  }
  if (payload.kind === "controlled-zone-movement-result" && payload.userId === globalThis.game?.user?.id) {
    const pending = pendingRequests.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(payload.requestId);
    pending.resolve(payload.result);
  }
}

function attachCanvasPreview(session) {
  const stage = globalThis.canvas?.stage;
  if (!stage?.on) return;
  const preview = createPreview(session);
  const onMove = (event) => schedulePreviewUpdate(session, preview, pointerToScenePoint(event));
  const onTap = async (event) => {
    const destination = pointerToScenePoint(event);
    cancelScheduledPreviewUpdate(session);
    const validation = updatePreview(session, preview, destination);
    if (!validation?.ok) {
      notify("PERSISTENT_ZONES.ControlledMovement.OutOfRange", "That destination is outside the movement range.", "warn");
      return;
    }
    const result = await commitControlledZoneMovement(session, destination);
    if (!result?.ok) notify("PERSISTENT_ZONES.ControlledMovement.Failed", "The persistent zone could not move.", "warn");
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") closeControlledZoneMovementSession(session, "cancelled");
  };
  stage.on("pointermove", onMove);
  stage.on("pointertap", onTap);
  globalThis.window?.addEventListener?.("keydown", onKeyDown);
  session.previewState = {
    preview, onMove, onTap, onKeyDown, stage, controls: createPreviewControls(session),
    generation: 0, scheduled: false, frameHandle: null, pendingDestination: null
  };
  updatePreview(session, preview, session.origin);
}

function detachCanvasPreview(session) {
  const state = session?.previewState;
  if (!state) return;
  cancelScheduledPreviewUpdate(session);
  state.stage?.off?.("pointermove", state.onMove);
  state.stage?.off?.("pointertap", state.onTap);
  globalThis.window?.removeEventListener?.("keydown", state.onKeyDown);
  state.preview?.destroy?.({ children: true });
  state.preview?.parent?.removeChild?.(state.preview);
  state.controls?.remove?.();
  session.previewState = null;
}

/** Coalesce rapid pointer events so preview work runs at most once per frame. */
function schedulePreviewUpdate(session, preview, destination) {
  const state = session?.previewState;
  if (!state || !destination) return;
  state.pendingDestination = destination;
  const generation = ++state.generation;
  if (state.scheduled) return;
  state.scheduled = true;
  const callback = () => {
    state.scheduled = false;
    state.frameHandle = null;
    if (state.generation !== generation && !state.pendingDestination) return;
    const latestDestination = state.pendingDestination;
    state.pendingDestination = null;
    if (latestDestination) updatePreview(session, preview, latestDestination);
  };
  if (typeof globalThis.requestAnimationFrame === "function") {
    state.frameHandle = globalThis.requestAnimationFrame(callback);
  } else {
    state.frameHandle = globalThis.setTimeout?.(callback, 0) ?? null;
  }
}

function cancelScheduledPreviewUpdate(session) {
  const state = session?.previewState;
  if (!state) return;
  state.generation += 1;
  state.pendingDestination = null;
  if (state.frameHandle !== null) {
    if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(state.frameHandle);
    else globalThis.clearTimeout?.(state.frameHandle);
  }
  state.frameHandle = null;
  state.scheduled = false;
}

function createPreview(session) {
  const PIXI = globalThis.PIXI;
  if (!PIXI?.Container || !PIXI?.Graphics || !globalThis.canvas?.interface?.addChild) return null;
  const container = new PIXI.Container();
  container.eventMode = "none";
  container.addChild(new PIXI.Graphics());
  globalThis.canvas.interface.addChild(container);
  return container;
}

function updatePreview(session, preview, destination) {
  const validation = validateDestination(session, destination);
  if (!preview?.children?.[0] || !destination) return validation;
  const graphics = preview.children[0];
  const resolution = validation.ok
    ? resolveControlledMovementDestination({
      scene: session.regionDocument?.parent ?? globalThis.canvas?.scene ?? null,
      regionDocument: session.regionDocument,
      origin: session.origin,
      destination: validation.destination,
      physicalRadius: session.physicalRadius,
      targeting: {
        mode: session.targetingMode ?? "membership",
        trigger: session.moveTrigger ?? null,
        body: session.physicalBody ?? null
      }
    })
    : null;
  const collision = resolution?.tokenCollision ?? null;
  const resolvedDestination = resolution?.resolvedDestination ?? validation.destination ?? destination;
  const valid = validation.ok;
  const radius = getPreviewRadius(session.regionDocument);
  graphics.clear?.();
  const color = valid ? (collision ? 0xe3a74b : 0x5dcb84) : 0xe05a5a;
  if (typeof graphics.lineStyle === "function") {
    graphics.lineStyle(3, color, 0.95);
    graphics.beginFill?.(color, 0.12);
    graphics.drawCircle?.(resolvedDestination.x, resolvedDestination.y, radius);
    graphics.endFill?.();
    graphics.moveTo?.(session.origin.x, session.origin.y);
    graphics.lineTo?.(resolvedDestination.x, resolvedDestination.y);
    drawPhysicalBodyPreview(graphics, session, resolvedDestination);
  } else if (typeof graphics.circle === "function") {
    graphics.circle(resolvedDestination.x, resolvedDestination.y, radius).stroke?.({ color, width: 3, alpha: 0.95 });
    drawPhysicalBodyPreview(graphics, session, resolvedDestination);
  }
  return { ...validation, collision, resolvedDestination, stopReason: resolution?.stopReason ?? "none" };
}

/** Non-persistent overlay of the exact body used by physical-contact. */
function drawPhysicalBodyPreview(graphics, session, center) {
  const body = session?.physicalBody;
  if (session?.targetingMode !== "physical-contact" || body?.type !== "circle" || !(body.radius > 0)) return;
  if (typeof graphics.lineStyle === "function") {
    graphics.lineStyle(2, 0x6ec8ff, 1);
    graphics.drawCircle?.(center.x, center.y, body.radius);
  } else if (typeof graphics.circle === "function") {
    graphics.circle(center.x, center.y, body.radius).stroke?.({ color: 0x6ec8ff, width: 2, alpha: 1 });
  }
}

function getPreviewRadius(regionDocument) {
  const shape = Array.from(regionDocument?._source?.shapes ?? [])[0] ?? {};
  return Math.max(8, Number(shape.radius ?? 16));
}

function pointerToScenePoint(event) {
  const direct = event?.data?.getLocalPosition?.(globalThis.canvas?.stage) ?? event?.getLocalPosition?.(globalThis.canvas?.stage) ?? event?.global ?? event?.data?.global ?? null;
  return normalizePoint(direct);
}

function createPreviewControls(session) {
  const document = globalThis.document;
  const host = document?.querySelector?.("#ui-bottom") ?? document?.body;
  if (!document?.createElement || !host?.appendChild) return null;
  const controls = document.createElement("div");
  controls.className = "persistent-zones-controlled-movement-controls";
  controls.innerHTML = `<span>${localize("PERSISTENT_ZONES.ControlledMovement.Prompt", "Choose a destination within range.")}</span>`;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = localize("PERSISTENT_ZONES.ControlledMovement.Cancel", "Cancel");
  cancel.addEventListener("click", () => closeControlledZoneMovementSession(session, "cancelled"));
  controls.appendChild(cancel);
  host.appendChild(controls);
  return controls;
}

function trimExpiredAuthorizations() {
  const now = Date.now();
  for (const [id, authorization] of gmAuthorizations) {
    if (authorization.expiresAt <= now) gmAuthorizations.delete(id);
  }
}

function normalizePoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function randomId() {
  return globalThis.foundry?.utils?.randomID?.() ?? globalThis.randomID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function notify(key, fallback, level = "info") {
  const message = localize(key, fallback);
  globalThis.ui?.notifications?.[level]?.(message);
}

function localize(key, fallback) {
  const result = globalThis.game?.i18n?.localize?.(key);
  return result && result !== key ? result : fallback;
}


function getShapeBounds(shapes = []) {
  const bounds = [];
  for (const shape of shapes) {
    const type = String(shape?.type ?? "").toLowerCase();
    if (type === "circle" && Number.isFinite(Number(shape.x)) && Number.isFinite(Number(shape.y)) && Number(shape.radius) >= 0) {
      const radius = Number(shape.radius);
      bounds.push({ x: Number(shape.x) - radius, y: Number(shape.y) - radius, width: radius * 2, height: radius * 2 });
      continue;
    }
    if (Number.isFinite(Number(shape?.x)) && Number.isFinite(Number(shape?.y)) && Number.isFinite(Number(shape?.width)) && Number.isFinite(Number(shape?.height))) {
      bounds.push({ x: Number(shape.x), y: Number(shape.y), width: Number(shape.width), height: Number(shape.height) });
      continue;
    }
    if (type === "polygon" && Array.isArray(shape?.points) && shape.points.length >= 6) {
      const xs = shape.points.filter((_value, index) => index % 2 === 0).map(Number).filter(Number.isFinite);
      const ys = shape.points.filter((_value, index) => index % 2 === 1).map(Number).filter(Number.isFinite);
      if (xs.length && ys.length) {
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        bounds.push({ x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top });
      }
    }
  }
  if (!bounds.length) return null;
  const left = Math.min(...bounds.map((bound) => bound.x));
  const top = Math.min(...bounds.map((bound) => bound.y));
  const right = Math.max(...bounds.map((bound) => bound.x + bound.width));
  const bottom = Math.max(...bounds.map((bound) => bound.y + bound.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function fail(reason) {
  return { ok: false, reason };
}
