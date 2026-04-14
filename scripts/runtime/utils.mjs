import {
  DEBUG_PREFIX,
  MODULE_ID,
  RUNTIME_FLAG_KEY
} from "../constants.mjs";

export function debug(message, data = undefined) {
  if (data === undefined) {
    console.debug(`${DEBUG_PREFIX} ${message}`);
    return;
  }

  console.debug(`${DEBUG_PREFIX} ${message}`, data);
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
  return (
    duplicateData(
      regionDocument?.getFlag?.(MODULE_ID, RUNTIME_FLAG_KEY) ??
        regionDocument?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY]
    ) ?? null
  );
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
  return Boolean(runtime?.templateId || runtime?.templateUuid);
}

export function findManagedRegions(scene, predicate = null) {
  const regionDocuments =
    scene?.regions?.contents ??
    Array.from(scene?.regions?.values?.() ?? []);
  const regions = regionDocuments.filter(isManagedRegion);
  return predicate ? regions.filter(predicate) : regions;
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

  if (typeof tokenDocument.testInsideRegion === "function") {
    try {
      return !!tokenDocument.testInsideRegion(regionDocument, membership);
    } catch (caughtError) {
      debug("Native token Region inside test failed, using sampled fallback.", {
        tokenId: tokenDocument?.id ?? null,
        regionId: regionDocument?.id ?? null,
        error: caughtError?.message ?? "unknown"
      });
    }
  }

  return sampleTokenRegionPoints(membership).some((point) => pointInManagedRegion(regionDocument, point));
}

export function pointInManagedRegion(regionDocument, point) {
  const shapes = getRegionShapeData(regionDocument);
  if (!shapes.length) {
    return false;
  }

  return shapes.some((shape) => pointInShape(shape, point));
}

export function getRegionShapeData(regionDocument) {
  const raw =
    duplicateData(regionDocument?.toObject?.()?.shapes) ??
    duplicateData(regionDocument?.shapes?.contents?.map((shape) => shape.toObject?.() ?? shape)) ??
    duplicateData(regionDocument?.shapes) ??
    [];

  return Array.isArray(raw) ? raw : [];
}

function pointInShape(shape, point) {
  switch (shape?.type) {
    case "circle":
      return pointInCircle(shape, point);
    case "rectangle":
      return pointInRectangle(shape, point);
    case "polygon":
      return pointInPolygon(shape.points, point);
    default:
      return false;
  }
}

function pointInCircle(shape, point) {
  const radius = coerceNumber(shape.radius, 0);
  const dx = point.x - coerceNumber(shape.x, 0);
  const dy = point.y - coerceNumber(shape.y, 0);
  return (dx * dx) + (dy * dy) <= radius * radius;
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
  if (!Array.isArray(points) || points.length < 6) {
    return false;
  }

  let inside = false;

  for (let i = 0, j = points.length - 2; i < points.length; i += 2) {
    const xi = points[i];
    const yi = points[i + 1];
    const xj = points[j];
    const yj = points[j + 1];

    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || Number.EPSILON) + xi;

    if (intersects) {
      inside = !inside;
    }

    j = i;
  }

  return inside;
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
