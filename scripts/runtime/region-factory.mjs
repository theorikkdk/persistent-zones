import {
  DEFAULT_REGION_COLOR,
  MODULE_ID,
  NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE,
  STANDARD_DIFFICULT_TERRAIN_MULTIPLIER
} from "../constants.mjs";
import {
  buildManagedRegionFlags,
  coerceNumber,
  debug,
  distanceToPixels,
  error,
  findManagedRegions,
  getRegionRuntimeFlags,
  getTemplateType,
  isPrimaryGM,
  translateFlatPoints,
  trimClosingPolygonPoint,
  wait
} from "./utils.mjs";
import { resolveTemplateSourceContext } from "./template-source-context.mjs";
import {
  getZoneDefinitionFromItem,
  normalizeZoneDefinition
} from "./zone-definition.mjs";

let hooksRegistered = false;

export function registerRegionFactoryHooks() {
  if (hooksRegistered) {
    return;
  }

  Hooks.on("createMeasuredTemplate", onCreateMeasuredTemplate);
  hooksRegistered = true;
}

async function onCreateMeasuredTemplate(templateDocument, options, userId) {
  if (!isPrimaryGM()) {
    return;
  }

  try {
    await createRegionFromTemplate(templateDocument, { userId });
  } catch (caughtError) {
    error("Failed to create Region from MeasuredTemplate.", caughtError, {
      templateId: templateDocument?.id ?? null
    });
  }
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

  if (!scene) {
    debug("Skipped Region creation because the template has no parent Scene.", {
      templateId: templateDocument?.id ?? null
    });
    return null;
  }

  const existingRegion = findManagedRegionForTemplate(scene, templateDocument);
  if (existingRegion && !force) {
    debug("Skipped Region creation because a managed Region already exists.", {
      templateId: templateDocument.id,
      regionId: existingRegion.id
    });
    return existingRegion;
  }

  const resolvedContext = await resolveTemplateSourceContext(templateDocument);
  const sourceContext = {
    item: item ?? resolvedContext.item ?? null,
    actor: actor ?? item?.actor ?? resolvedContext.actor ?? null,
    caster: caster ?? resolvedContext.caster ?? actor ?? item?.actor ?? null
  };

  if (!sourceContext.item) {
    debug("Skipped template without a resolvable linked item.", {
      templateId: templateDocument.id,
      userId,
      resolutionNotes: resolvedContext.report?.notes ?? [],
      matched: resolvedContext.report?.matched ?? []
    });
    return null;
  }

  const zoneDefinition = rawDefinition ?? getZoneDefinitionFromItem(sourceContext.item);
  if (!zoneDefinition) {
    debug("Skipped template without a persistent-zones definition on the linked item.", {
      templateId: templateDocument.id,
      itemUuid: sourceContext.item.uuid
    });
    return null;
  }

  const normalizedDefinition = normalizeZoneDefinition(zoneDefinition, {
    item: sourceContext.item,
    actor: sourceContext.actor,
    caster: sourceContext.caster,
    templateDocument
  });

  if (!normalizedDefinition.validation.isValid) {
    debug("Skipped template with an invalid normalized zone definition.", {
      templateId: templateDocument.id,
      reasons: normalizedDefinition.validation.reasons
    });
    return null;
  }

  const shapes = await buildRegionShapesFromTemplate(templateDocument);
  if (!shapes.length) {
    debug("Skipped template because no supported Region shape could be produced.", {
      templateId: templateDocument.id,
      templateType: getTemplateType(templateDocument)
    });
    return null;
  }

  const regionData = buildRegionCreateData({
    templateDocument,
    normalizedDefinition,
    sourceContext,
    shapes
  });

  const createdRegions = await scene.createEmbeddedDocuments("Region", [regionData]);
  const createdRegion = createdRegions?.[0] ?? null;

  if (createdRegion) {
    debug("Created managed Region from MeasuredTemplate.", {
      templateId: templateDocument.id,
      regionId: createdRegion.id,
      itemUuid: sourceContext.item.uuid,
      nativeBehaviorCount: createdRegion.behaviors?.size ?? createdRegion.behaviors?.contents?.length ?? regionData.behaviors?.length ?? 0
    });
  }

  return createdRegion;
}

export function findManagedRegionForTemplate(scene, templateDocument) {
  const templateId = templateDocument?.id ?? null;
  const templateUuid = templateDocument?.uuid ?? null;

  return (
    findManagedRegions(scene, (region) => {
      const runtime = getRegionRuntimeFlags(region);
      return runtime?.templateId === templateId || runtime?.templateUuid === templateUuid;
    })[0] ?? null
  );
}

function buildRegionCreateData({
  templateDocument,
  normalizedDefinition,
  sourceContext,
  shapes
}) {
  const behaviors = buildNativeRegionBehaviors({
    normalizedDefinition,
    sourceContext
  });
  const runtimeFlags = {
    templateId: templateDocument.id ?? null,
    templateUuid: templateDocument.uuid ?? null,
    itemUuid: normalizedDefinition.itemUuid ?? sourceContext.item?.uuid ?? null,
    actorUuid: normalizedDefinition.actorUuid ?? sourceContext.actor?.uuid ?? null,
    casterUuid: normalizedDefinition.casterUuid ?? sourceContext.caster?.uuid ?? null,
    dc: normalizedDefinition.dc ?? null,
    castLevel: normalizedDefinition.castLevel ?? null,
    normalizedDefinition
  };

  return {
    name: buildRegionName(normalizedDefinition, sourceContext),
    color: DEFAULT_REGION_COLOR,
    elevation: coerceNumber(templateDocument.elevation, 0),
    shapes,
    behaviors,
    flags: buildManagedRegionFlags(runtimeFlags)
  };
}

function buildNativeRegionBehaviors({
  normalizedDefinition,
  sourceContext
}) {
  const terrain = normalizedDefinition?.terrain ?? {};
  if (!terrain.difficult) {
    debug("No native Region movement-cost behavior requested by normalized definition.", {
      label: normalizedDefinition?.label ?? null,
      terrain
    });
    return [];
  }

  const multiplier = coerceNumber(terrain.multiplier, STANDARD_DIFFICULT_TERRAIN_MULTIPLIER);
  const behaviorType = terrain.behaviorType ?? NATIVE_DIFFICULT_TERRAIN_BEHAVIOR_TYPE;
  if (!CONFIG?.RegionBehavior?.dataModels?.[behaviorType]) {
    debug("Skipped native Region behavior because the behavior type is unavailable.", {
      label: normalizedDefinition?.label ?? null,
      behaviorType
    });
    return [];
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

  return [behaviorData];
}

async function buildRegionShapesFromTemplate(templateDocument) {
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

  const templateType = getTemplateType(templateDocument);

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
  return {
    type: "circle",
    x: templateDocument.x ?? 0,
    y: templateDocument.y ?? 0,
    radius: distanceToPixels(templateDocument.distance, templateDocument.parent)
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

  return casterName ? `${itemName}(${casterName})` : itemName;
}

function buildTerrainBehaviorName(normalizedDefinition, sourceContext) {
  const regionName = buildRegionName(normalizedDefinition, sourceContext);
  return `${regionName} Difficult Terrain`;
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
