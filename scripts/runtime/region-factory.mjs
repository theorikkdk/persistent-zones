import { DEFAULT_REGION_COLOR } from "../constants.mjs";
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
    rawDefinition = null,
    allowLegacyFallback = true
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

  const zoneDefinition =
    rawDefinition ??
    getZoneDefinitionFromItem(sourceContext.item, { allowLegacyFallback });

  if (zoneDefinition?.source?.type === "legacy-fallback") {
    debug("Using legacy Encounter+ Importer fallback for zone definition.", {
      templateId: templateDocument.id,
      itemUuid: sourceContext.item.uuid
    });
  }

  if (zoneDefinition === null || zoneDefinition === undefined) {
    debug("Skipped template without a persistent-zones definition on the linked item.", {
      templateId: templateDocument.id,
      itemUuid: sourceContext.item.uuid,
      allowLegacyFallback
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
      itemUuid: sourceContext.item.uuid
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
      return (
        runtime?.templateId === templateId || runtime?.templateUuid === templateUuid
      );
    })[0] ?? null
  );
}

function buildRegionCreateData({
  templateDocument,
  normalizedDefinition,
  sourceContext,
  shapes
}) {
  const runtimeFlags = {
    templateId: templateDocument.id ?? null,
    templateUuid: templateDocument.uuid ?? null,
    itemUuid: normalizedDefinition.itemUuid ?? sourceContext.item?.uuid ?? null,
    actorUuid: normalizedDefinition.actorUuid ?? sourceContext.actor?.uuid ?? null,
    casterUuid:
      normalizedDefinition.casterUuid ?? sourceContext.caster?.uuid ?? null,
    dc: normalizedDefinition.dc ?? null,
    castLevel: normalizedDefinition.castLevel ?? null,
    normalizedDefinition
  };

  return {
    name: `${normalizedDefinition.label} (${game.i18n.localize("PERSISTENT_ZONES.ZoneSuffix")})`,
    color: DEFAULT_REGION_COLOR,
    elevation: coerceNumber(templateDocument.elevation, 0),
    shapes,
    flags: buildManagedRegionFlags(runtimeFlags)
  };
}

async function buildRegionShapesFromTemplate(templateDocument) {
  // Reusing Foundry's rendered geometry keeps cone and rectangle handling aligned
  // with the active system template implementation whenever that shape is available.
  const shapeFromPlaceable = await buildShapesFromRenderedTemplate(templateDocument);
  if (shapeFromPlaceable.length) {
    return shapeFromPlaceable;
  }

  const templateType = getTemplateType(templateDocument);

  switch (templateType) {
    case "circle":
      return [buildCircleShapeFromDocument(templateDocument)];
    case "ray":
      return [buildRayShapeFromDocument(templateDocument)];
    default:
      return [];
  }
}

async function buildShapesFromRenderedTemplate(templateDocument) {
  const placeable = await resolveTemplatePlaceable(templateDocument);
  const renderedShape = placeable?.shape ?? null;

  if (!renderedShape) {
    return [];
  }

  if (hasFlatPoints(renderedShape.points)) {
    return [
      {
        type: "polygon",
        points: trimClosingPolygonPoint(
          translateFlatPoints(
            renderedShape.points,
            templateDocument.x ?? 0,
            templateDocument.y ?? 0
          )
        )
      }
    ];
  }

  if (hasPixiCircleShape(renderedShape)) {
    return [
      {
        type: "circle",
        x: (templateDocument.x ?? 0) + (renderedShape.x ?? 0),
        y: (templateDocument.y ?? 0) + (renderedShape.y ?? 0),
        radius: renderedShape.radius
      }
    ];
  }

  if (hasPixiRectangleShape(renderedShape)) {
    return [
      {
        type: "rectangle",
        x: (templateDocument.x ?? 0) + (renderedShape.x ?? 0),
        y: (templateDocument.y ?? 0) + (renderedShape.y ?? 0),
        width: renderedShape.width,
        height: renderedShape.height,
        rotation: 0
      }
    ];
  }

  return [];
}

async function resolveTemplatePlaceable(templateDocument) {
  // The MeasuredTemplate placeable may appear a tick after document creation.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const placeable =
      templateDocument?.object ??
      canvas?.templates?.get?.(templateDocument?.id) ??
      canvas?.templates?.placeables?.find(
        (candidate) => candidate.document?.id === templateDocument?.id
      ) ??
      null;

    if (placeable?.shape) {
      return placeable;
    }

    await wait(0);
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

function hasPixiCircleShape(shape) {
  return (
    shape &&
    typeof shape.radius === "number" &&
    typeof shape.x === "number" &&
    typeof shape.y === "number"
  );
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
  return (
    (Array.isArray(points) || ArrayBuffer.isView(points)) &&
    Number(points.length) >= 6
  );
}
