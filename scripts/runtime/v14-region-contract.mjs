import { MODULE_ID, RUNTIME_FLAG_KEY } from "../constants.mjs";

export const REGION_ARCHITECTURE_PATHS = Object.freeze({
  LEGACY_TEMPLATE: "legacy-template",
  V14_REGION_NATIVE: "v14-region-native"
});

export const MANAGED_REGION_CONTRACT_VERSION = 1;
export const MANAGED_REGION_DEFINITION_VERSION = 1;

export function buildManagedRegionRuntimeContract(runtimeFlags = {}, {
  architecturePath = REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
  regionDocument = null,
  sourceDocumentType = null
} = {}) {
  const normalizedArchitecturePath = normalizeArchitecturePath(architecturePath);
  const normalizedDefinition = duplicate(runtimeFlags.normalizedDefinition ?? null);
  const itemUuid = runtimeFlags.itemUuid ?? normalizedDefinition?.itemUuid ?? null;
  const actorUuid = runtimeFlags.actorUuid ?? normalizedDefinition?.actorUuid ?? null;
  const groupId = runtimeFlags.groupId ?? buildFallbackGroupId({
    architecturePath: normalizedArchitecturePath,
    itemUuid,
    templateUuid: runtimeFlags.templateUuid,
    regionDocument
  });
  const partId = runtimeFlags.partId ?? normalizedDefinition?.part?.id ?? "primary";

  return {
    ...duplicate(runtimeFlags),
    contractVersion: MANAGED_REGION_CONTRACT_VERSION,
    definitionVersion: runtimeFlags.definitionVersion ?? MANAGED_REGION_DEFINITION_VERSION,
    architecturePath: normalizedArchitecturePath,
    sourceDocumentType: sourceDocumentType ?? runtimeFlags.sourceDocumentType ?? null,
    regionDocumentId: regionDocument?.id ?? runtimeFlags.regionDocumentId ?? null,
    regionDocumentUuid: regionDocument?.uuid ?? runtimeFlags.regionDocumentUuid ?? null,
    itemUuid,
    actorUuid,
    casterUuid: runtimeFlags.casterUuid ?? normalizedDefinition?.casterUuid ?? actorUuid ?? null,
    groupId,
    partId,
    partIndex: runtimeFlags.partIndex ?? 0,
    partCount: runtimeFlags.partCount ?? 1,
    rebuild: {
      itemUuid,
      groupId,
      partId,
      architecturePath: normalizedArchitecturePath,
      templateUuid: runtimeFlags.templateUuid ?? null,
      regionDocumentUuid: regionDocument?.uuid ?? runtimeFlags.regionDocumentUuid ?? null
    },
    normalizedDefinition
  };
}

export function readManagedRegionContract(regionDocument) {
  const runtime = readRuntimeFlags(regionDocument);
  if (!runtime) {
    return null;
  }

  return buildManagedRegionRuntimeContract(runtime, {
    architecturePath: runtime.architecturePath ?? REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE,
    regionDocument,
    sourceDocumentType: runtime.sourceDocumentType ?? regionDocument?.documentName ?? null
  });
}

export function buildManagedRegionContractFlags(runtimeFlags) {
  return {
    [MODULE_ID]: {
      [RUNTIME_FLAG_KEY]: runtimeFlags
    }
  };
}

export function findManagedRegionContractsByItem(scene, itemUuid) {
  if (!scene || !itemUuid) {
    return [];
  }

  const regionDocuments =
    scene?.regions?.contents ??
    Array.from(scene?.regions?.values?.() ?? []);

  return regionDocuments
    .map((regionDocument) => ({
      regionDocument,
      contract: readManagedRegionContract(regionDocument)
    }))
    .filter(({ contract }) => contract?.itemUuid === itemUuid);
}

export function isV14RegionNativeContract(runtimeOrContract) {
  return runtimeOrContract?.architecturePath === REGION_ARCHITECTURE_PATHS.V14_REGION_NATIVE;
}

export function normalizeArchitecturePath(value) {
  return Object.values(REGION_ARCHITECTURE_PATHS).includes(value)
    ? value
    : REGION_ARCHITECTURE_PATHS.LEGACY_TEMPLATE;
}

function readRuntimeFlags(regionDocument) {
  const objectData = regionDocument?.toObject?.() ?? null;
  return (
    regionDocument?.getFlag?.(MODULE_ID, RUNTIME_FLAG_KEY) ??
    regionDocument?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY] ??
    regionDocument?._source?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY] ??
    objectData?.flags?.[MODULE_ID]?.[RUNTIME_FLAG_KEY] ??
    objectData?.[`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`] ??
    regionDocument?._source?.[`flags.${MODULE_ID}.${RUNTIME_FLAG_KEY}`] ??
    null
  );
}

function buildFallbackGroupId({
  architecturePath,
  itemUuid,
  templateUuid,
  regionDocument
} = {}) {
  return [
    MODULE_ID,
    architecturePath,
    itemUuid ?? templateUuid ?? regionDocument?.uuid ?? regionDocument?.id ?? "region",
    "group"
  ].join(":");
}

function duplicate(value) {
  if (value === null || value === undefined) {
    return value;
  }

  try {
    return structuredClone(value);
  } catch (_caughtError) {
    return JSON.parse(JSON.stringify(value));
  }
}
