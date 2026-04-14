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
    if (["true", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no"].includes(normalized)) {
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
