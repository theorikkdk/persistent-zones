const METERS_PER_FOOT = 0.3;

export function normalizeCanonicalDistanceUnit(value) {
  const unit = String(value ?? "scene").trim().toLowerCase();
  if (["ft", "feet", "foot"].includes(unit)) return "ft";
  if (["m", "meter", "meters", "metre", "metres"].includes(unit)) return "m";
  return "scene";
}

export function convertCanonicalDistanceToSceneUnits(value, unit = "scene", scene = globalThis.canvas?.scene ?? null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const sourceUnit = normalizeCanonicalDistanceUnit(unit);
  const sceneUnit = normalizeCanonicalDistanceUnit(scene?.grid?.units ?? scene?.grid?.unit ?? "scene");
  if (sourceUnit === "scene" || sceneUnit === "scene" || sourceUnit === sceneUnit) return numeric;
  const convertLength = globalThis.dnd5e?.utils?.convertLength;
  if (typeof convertLength === "function") {
    try {
      const converted = Number(convertLength(numeric, sourceUnit, sceneUnit, { strict: false }));
      if (Number.isFinite(converted)) return converted;
    } catch {
      // A lightweight test environment or an older system can omit the D&D5e helper.
    }
  }
  if (sourceUnit === "ft" && sceneUnit === "m") return numeric * METERS_PER_FOOT;
  if (sourceUnit === "m" && sceneUnit === "ft") return numeric / METERS_PER_FOOT;
  return numeric;
}

/** Resolve a canonical preset distance for the active scene without using UI locale. */
export function resolvePresetDistance(value, unit = "ft", scene = globalThis.canvas?.scene ?? null) {
  return convertCanonicalDistanceToSceneUnits(value, unit, scene);
}

export function distanceToScenePixels(value, unit = "scene", scene = globalThis.canvas?.scene ?? null) {
  const sceneDistance = convertCanonicalDistanceToSceneUnits(value, unit, scene);
  const gridDistance = Number(scene?.grid?.distance ?? scene?.dimensions?.distance);
  const gridSize = Number(scene?.grid?.size ?? scene?.dimensions?.size);
  if (!Number.isFinite(sceneDistance) || !Number.isFinite(gridDistance) || gridDistance <= 0 || !Number.isFinite(gridSize)) return null;
  return (sceneDistance / gridDistance) * gridSize;
}

export function centerRectanglePosition(position, document, rectangle) {
  const halfWidth = Number(rectangle?.widthPixels) / 2;
  const halfHeight = Number(rectangle?.heightPixels) / 2;
  if (document?.t === "rect") return { x: position.x - halfWidth, y: position.y - halfHeight };
  const radians = Number(document?.direction ?? 0) * Math.PI / 180;
  return {
    x: position.x - Math.cos(radians) * halfWidth,
    y: position.y - Math.sin(radians) * halfWidth
  };
}
