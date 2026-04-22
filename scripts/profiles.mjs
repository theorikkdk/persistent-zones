import {
  MODULE_ID,
  NORMALIZED_DEFINITION_VERSION
} from "./constants.mjs";
import {
  debug,
  duplicateData,
  isPlainObject
} from "./runtime/utils.mjs";

const USER_PROFILES_SETTING_KEY = "userProfiles";
const BUILTIN_PROFILE_FACTORIES = Object.freeze([
  {
    id: "simple-damage",
    labelKey: "PERSISTENT_ZONES.UI.Profiles.SimpleDamage",
    fallbackLabel: "Simple Damage",
    baseType: "simple",
    templateType: null,
    buildDefinition: ({ id, label }) => buildSimpleDamageProfileDefinition({ id, label })
  },
  {
    id: "ring-basic",
    labelKey: "PERSISTENT_ZONES.UI.Profiles.RingBasic",
    fallbackLabel: "Ring Basic",
    baseType: "ring",
    templateType: "circle",
    buildDefinition: ({ id, label }) => buildRingBasicProfileDefinition({ id, label })
  },
  {
    id: "wall-heated-line-left",
    labelKey: "PERSISTENT_ZONES.UI.Profiles.WallHeatedLineLeft",
    fallbackLabel: "Wall Heated Line Left",
    baseType: "composite-line",
    templateType: "ray",
    selectedVariant: "line-left",
    buildDefinition: ({ id, label }) => buildWallHeatedLineProfileDefinition("left", { id, label })
  },
  {
    id: "wall-heated-line-right",
    labelKey: "PERSISTENT_ZONES.UI.Profiles.WallHeatedLineRight",
    fallbackLabel: "Wall Heated Line Right",
    baseType: "composite-line",
    templateType: "ray",
    selectedVariant: "line-right",
    buildDefinition: ({ id, label }) => buildWallHeatedLineProfileDefinition("right", { id, label })
  },
  {
    id: "wall-heated-ring-inner",
    labelKey: "PERSISTENT_ZONES.UI.Profiles.WallHeatedRingInner",
    fallbackLabel: "Wall Heated Ring Inner",
    baseType: "composite-ring",
    templateType: "circle",
    selectedVariant: "ring-inner",
    buildDefinition: ({ id, label }) => buildWallHeatedRingProfileDefinition("inner", { id, label })
  },
  {
    id: "wall-heated-ring-outer",
    labelKey: "PERSISTENT_ZONES.UI.Profiles.WallHeatedRingOuter",
    fallbackLabel: "Wall Heated Ring Outer",
    baseType: "composite-ring",
    templateType: "circle",
    selectedVariant: "ring-outer",
    buildDefinition: ({ id, label }) => buildWallHeatedRingProfileDefinition("outer", { id, label })
  }
]);

export function registerPersistentZoneProfileSettings() {
  game.settings.register(MODULE_ID, USER_PROFILES_SETTING_KEY, {
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });
}

export function getPersistentZoneProfiles({
  includeBuiltin = true,
  includeUser = true
} = {}) {
  const profiles = [];

  if (includeBuiltin) {
    profiles.push(...getBuiltinPersistentZoneProfiles());
  }

  if (includeUser) {
    profiles.push(...getUserPersistentZoneProfiles());
  }

  return profiles;
}

export function getPersistentZoneProfile(profileId) {
  const normalizedProfileId = normalizeProfileId(profileId);
  if (!normalizedProfileId) {
    return null;
  }

  return getPersistentZoneProfiles().find((profile) => profile.id === normalizedProfileId) ?? null;
}

export function evaluatePersistentZoneProfileCompatibility(profileOrId, {
  templateType = null
} = {}) {
  const profile = typeof profileOrId === "string"
    ? getPersistentZoneProfile(profileOrId)
    : normalizeZoneProfile(profileOrId, {
        fallbackScope: "builtin"
      });
  const effectiveTemplateType = normalizeTemplateType(templateType);

  if (!profile) {
    return {
      profileFound: false,
      compatible: false,
      profileId: normalizeProfileId(profileOrId),
      profileCompatibility: "missing",
      effectiveTemplateType,
      profileTemplateType: null,
      profileBaseType: null,
      profileSelectedVariant: null,
      compatibleBaseTypes: effectiveTemplateType
        ? getCompatibleBaseTypesForTemplateType(effectiveTemplateType)
        : [],
      reason: localize(
        "PERSISTENT_ZONES.UI.ProfileCompatibility.NotFound",
        "The selected profile could not be found."
      )
    };
  }

  const compatibleBaseTypes = effectiveTemplateType
    ? getCompatibleBaseTypesForTemplateType(effectiveTemplateType)
    : [];
  const templateMismatch =
    Boolean(profile.templateType) &&
    Boolean(effectiveTemplateType) &&
    profile.templateType !== effectiveTemplateType;
  const baseTypeMismatch =
    Boolean(effectiveTemplateType) &&
    compatibleBaseTypes.length > 0 &&
    !compatibleBaseTypes.includes(profile.baseType);
  const compatible = !templateMismatch && !baseTypeMismatch;

  let reason = null;
  if (templateMismatch) {
    reason = `${localize(
      "PERSISTENT_ZONES.UI.ProfileCompatibility.TemplateMismatch",
      "This profile expects a different template type."
    )} ${localizeTemplateType(profile.templateType)} -> ${localizeTemplateType(effectiveTemplateType)}.`;
  } else if (baseTypeMismatch) {
    reason = `${localize(
      "PERSISTENT_ZONES.UI.ProfileCompatibility.BaseTypeIncompatible",
      "This profile base type is incompatible with the effective template."
    )} ${localizeBaseType(profile.baseType)}.`;
  }

  return {
    profileFound: true,
    compatible,
    profileId: profile.id,
    profileCompatibility: compatible ? "compatible" : "incompatible",
    effectiveTemplateType,
    profileTemplateType: profile.templateType,
    profileBaseType: profile.baseType,
    profileSelectedVariant: profile.selectedVariant,
    compatibleBaseTypes,
    reason
  };
}

export async function saveUserPersistentZoneProfile({
  name = "",
  definition = null
} = {}) {
  if (!isPlainObject(definition)) {
    return {
      ok: false,
      error: "A valid definition object is required."
    };
  }

  const label = String(name ?? "").trim();
  if (!label) {
    return {
      ok: false,
      error: "A profile name is required."
    };
  }

  const currentProfiles = readUserProfilesSetting();
  const normalizedDefinition = duplicateData(definition);
  const profileId = `user-${slugifyProfileName(label)}`;
  const baseType = deriveProfileBaseType(normalizedDefinition);
  const templateType = deriveProfileTemplateType(normalizedDefinition);
  const selectedVariant = deriveProfileSelectedVariant(normalizedDefinition);
  const existingProfile = normalizeZoneProfile(currentProfiles[profileId] ?? null, {
    fallbackScope: "user"
  });

  normalizedDefinition.source = {
    ...duplicateData(normalizedDefinition.source ?? {}),
    type: "profile",
    module: MODULE_ID,
    profileId,
    baseType
  };
  normalizedDefinition.label = label;

  currentProfiles[profileId] = {
    id: profileId,
    label,
    scope: "user",
    baseType,
    templateType,
    selectedVariant,
    definition: normalizedDefinition,
    updatedAt: Date.now(),
    createdAt: existingProfile?.createdAt ?? Date.now()
  };

  await game.settings.set(MODULE_ID, USER_PROFILES_SETTING_KEY, currentProfiles);

  const savedProfile = normalizeZoneProfile(currentProfiles[profileId], {
    fallbackScope: "user"
  });

  debug("Saved persistent-zones profile.", {
    profileSaved: true,
    profileId,
    profileLabel: label,
    profileScope: "user",
    baseType,
    templateType,
    selectedVariant,
    overwrittenExistingProfile: Boolean(existingProfile)
  });

  return {
    ok: true,
    profile: savedProfile,
    overwritten: Boolean(existingProfile)
  };
}

export async function deleteUserPersistentZoneProfile(profileId) {
  const normalizedProfileId = normalizeProfileId(profileId);
  if (!normalizedProfileId) {
    return {
      ok: false,
      deleted: false,
      error: "A profile id is required."
    };
  }

  const profile = getPersistentZoneProfile(normalizedProfileId);
  if (!profile) {
    debug("Blocked persistent-zones profile delete because the profile was not found.", {
      profileDeleted: false,
      profileId: normalizedProfileId,
      profileType: "missing"
    });

    return {
      ok: false,
      deleted: false,
      profile: null,
      error: localize(
        "PERSISTENT_ZONES.UI.ProfileCompatibility.NotFound",
        "The selected profile could not be found."
      )
    };
  }

  if (profile.scope !== "user") {
    debug("Blocked persistent-zones profile delete for built-in profile.", {
      profileDeleted: false,
      deleteBlocked: true,
      profileId: profile.id,
      profileLabel: profile.label,
      profileType: profile.scope
    });

    return {
      ok: false,
      deleted: false,
      profile,
      error: localize(
        "PERSISTENT_ZONES.UI.Notifications.ProfileDeleteBlockedBuiltin",
        "Built-in profiles cannot be deleted."
      )
    };
  }

  const currentProfiles = readUserProfilesSetting();
  delete currentProfiles[profile.id];
  await game.settings.set(MODULE_ID, USER_PROFILES_SETTING_KEY, currentProfiles);

  debug("Deleted persistent-zones profile.", {
    profileDeleted: true,
    profileId: profile.id,
    profileLabel: profile.label,
    profileType: profile.scope
  });

  return {
    ok: true,
    deleted: true,
    profile
  };
}

function getBuiltinPersistentZoneProfiles() {
  return BUILTIN_PROFILE_FACTORIES.map((factory) => {
    const label = localize(factory.labelKey, factory.fallbackLabel);
    return normalizeZoneProfile(
      {
        id: factory.id,
        label,
        scope: "builtin",
        baseType: factory.baseType,
        templateType: factory.templateType,
        selectedVariant: factory.selectedVariant ?? null,
        definition: factory.buildDefinition({
          id: factory.id,
          label
        })
      },
      {
        fallbackScope: "builtin"
      }
    );
  });
}

function getUserPersistentZoneProfiles() {
  return Object.values(readUserProfilesSetting())
    .map((profileRecord) => normalizeZoneProfile(profileRecord, {
      fallbackScope: "user"
    }))
    .filter(Boolean)
    .sort((leftProfile, rightProfile) => {
      return String(leftProfile.label ?? "").localeCompare(String(rightProfile.label ?? ""));
    });
}

function readUserProfilesSetting() {
  const storedValue = duplicateData(game.settings.get(MODULE_ID, USER_PROFILES_SETTING_KEY) ?? {});
  return isPlainObject(storedValue) ? storedValue : {};
}

function normalizeZoneProfile(profileLike, {
  fallbackScope = "builtin"
} = {}) {
  if (!isPlainObject(profileLike) || !isPlainObject(profileLike.definition)) {
    return null;
  }

  const id = normalizeProfileId(profileLike.id);
  if (!id) {
    return null;
  }

  const label = String(profileLike.label ?? profileLike.name ?? "").trim() || id;
  const definition = duplicateData(profileLike.definition);

  return {
    id,
    label,
    scope: normalizeProfileScope(profileLike.scope, fallbackScope),
    baseType: deriveProfileBaseType(definition, profileLike.baseType),
    templateType: deriveProfileTemplateType(definition, profileLike.templateType),
    selectedVariant: deriveProfileSelectedVariant(definition, profileLike.selectedVariant),
    definition,
    createdAt: profileLike.createdAt ?? null,
    updatedAt: profileLike.updatedAt ?? null
  };
}

function buildCommonProfileDefinition({
  id,
  label,
  baseType,
  template
} = {}) {
  return {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "profile",
      module: MODULE_ID,
      profileId: id,
      baseType
    },
    enabled: true,
    label,
    shapeMode: "template",
    template: duplicateData(template ?? {}),
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    },
    triggers: buildDisabledTriggers()
  };
}

function buildSimpleDamageProfileDefinition({
  id,
  label
} = {}) {
  return {
    ...buildCommonProfileDefinition({
      id,
      label,
      baseType: "simple",
      template: {
        typeSource: "auto"
      }
    }),
    triggers: {
      ...buildDisabledTriggers(),
      onEnter: buildSimpleTriggerDefinition({
        formula: "2d6",
        damageType: "fire",
        saveAbility: "dex",
        saveDc: 13
      })
    }
  };
}

function buildRingBasicProfileDefinition({
  id,
  label
} = {}) {
  return {
    ...buildCommonProfileDefinition({
      id,
      label,
      baseType: "ring",
      template: {
        type: "circle"
      }
    }),
    parts: [
      {
        id: "wall-body",
        label: localize("PERSISTENT_ZONES.UI.Parts.WallBody", "Wall Body"),
        geometry: {
          type: "ring",
          referenceRadiusMode: "outer-edge",
          thickness: 5,
          segments: 24
        }
      }
    ]
  };
}

function buildWallHeatedLineProfileDefinition(side = "left", {
  id,
  label
} = {}) {
  const normalizedSide = normalizeDirectionalSide(side, "left");
  const heatedPartId = `heated-side-${normalizedSide}`;

  return {
    ...buildCommonProfileDefinition({
      id,
      label,
      baseType: "composite-line",
      template: {
        type: "ray",
        width: 1
      }
    }),
    selectedVariant: normalizedSide === "right" ? "line-right" : "line-left",
    defaultVariant: normalizedSide === "right" ? "line-right" : "line-left",
    parts: [
      {
        id: "wall-body",
        label: localize("PERSISTENT_ZONES.UI.Parts.WallBody", "Wall Body"),
        geometry: {
          type: "template"
        },
        triggers: buildDisabledTriggers()
      },
      {
        id: heatedPartId,
        label: localize(
          normalizedSide === "right"
            ? "PERSISTENT_ZONES.UI.Parts.HeatedSideRight"
            : "PERSISTENT_ZONES.UI.Parts.HeatedSideLeft",
          normalizedSide === "right" ? "Heated Side Right" : "Heated Side Left"
        ),
        geometry: {
          type: "side-of-line",
          side: normalizedSide,
          offsetReference: "body-edge",
          offsetStart: 0,
          offsetEnd: 3
        },
        triggers: {
          ...buildDisabledTriggers(),
          onEnter: buildSimpleTriggerDefinition({
            formula: "3d8",
            damageType: "fire",
            saveAbility: "dex",
            saveDc: 13
          })
        }
      }
    ]
  };
}

function buildWallHeatedRingProfileDefinition(side = "inner", {
  id,
  label
} = {}) {
  const normalizedSide = normalizeRingSide(side);
  const heatedPartId = `heated-side-${normalizedSide}`;

  return {
    ...buildCommonProfileDefinition({
      id,
      label,
      baseType: "composite-ring",
      template: {
        type: "circle"
      }
    }),
    selectedVariant: normalizedSide === "outer" ? "ring-outer" : "ring-inner",
    defaultVariant: normalizedSide === "outer" ? "ring-outer" : "ring-inner",
    parts: [
      {
        id: "wall-body",
        label: localize("PERSISTENT_ZONES.UI.Parts.WallBody", "Wall Body"),
        geometry: {
          type: "ring",
          referenceRadiusMode: "outer-edge",
          thickness: 1,
          segments: 24
        },
        triggers: buildDisabledTriggers()
      },
      {
        id: heatedPartId,
        label: localize(
          normalizedSide === "outer"
            ? "PERSISTENT_ZONES.UI.Parts.HeatedSideOuter"
            : "PERSISTENT_ZONES.UI.Parts.HeatedSideInner",
          normalizedSide === "outer" ? "Heated Side Outer" : "Heated Side Inner"
        ),
        geometry: {
          type: "side-of-ring",
          side: normalizedSide,
          referencePartId: "wall-body",
          offsetReference: "body-edge",
          offsetStart: 0,
          offsetEnd: 3,
          segments: 24
        },
        triggers: {
          ...buildDisabledTriggers(),
          onEnter: buildSimpleTriggerDefinition({
            formula: "3d8",
            damageType: "fire",
            saveAbility: "dex",
            saveDc: 13
          })
        }
      }
    ]
  };
}

function buildDisabledTriggers() {
  return {
    onEnter: { enabled: false, mode: "none" },
    onExit: { enabled: false, mode: "none" },
    onMove: { enabled: false, mode: "none" },
    onStartTurn: { enabled: false, mode: "none" },
    onEndTurn: { enabled: false, mode: "none" }
  };
}

function buildSimpleTriggerDefinition({
  formula = "2d6",
  damageType = "fire",
  saveAbility = "dex",
  saveDc = 13
} = {}) {
  return {
    enabled: true,
    mode: "simple",
    movementMode: "any",
    damage: {
      enabled: true,
      formula,
      type: damageType
    },
    save: {
      enabled: Boolean(saveAbility),
      ability: saveAbility || null,
      dcMode: "manual",
      dc: saveDc,
      onSuccess: "half"
    },
    activity: {
      id: null
    }
  };
}

function deriveProfileBaseType(definition = {}, fallbackValue = null) {
  const sourceBaseType = normalizeBaseType(definition?.source?.baseType ?? fallbackValue);
  if (sourceBaseType) {
    return sourceBaseType;
  }

  const parts = Array.from(definition?.parts ?? definition?.zones ?? []);
  const geometryTypes = parts.map((part) => String(part?.geometry?.type ?? "").trim().toLowerCase());

  if (geometryTypes.includes("side-of-ring")) {
    return "composite-ring";
  }

  if (geometryTypes.includes("side-of-line")) {
    return "composite-line";
  }

  if (geometryTypes.includes("ring") || geometryTypes.includes("annulus")) {
    return "ring";
  }

  return "simple";
}

function deriveProfileTemplateType(definition = {}, fallbackValue = null) {
  const explicitTemplateType = normalizeTemplateType(definition?.template?.type ?? fallbackValue);
  if (explicitTemplateType) {
    return explicitTemplateType;
  }

  return null;
}

function deriveProfileSelectedVariant(definition = {}, fallbackValue = null) {
  const selectedVariant = String(
    definition?.selectedVariant ??
    definition?.variantId ??
    definition?.variant ??
    fallbackValue ??
    ""
  ).trim().toLowerCase();

  return selectedVariant || null;
}

function getCompatibleBaseTypesForTemplateType(templateType) {
  switch (normalizeTemplateType(templateType)) {
    case "circle":
      return ["simple", "ring", "composite-ring"];
    case "ray":
      return ["simple", "composite-line"];
    case "cone":
    case "rect":
      return ["simple"];
    default:
      return ["simple", "ring", "composite-line", "composite-ring"];
  }
}

function normalizeBaseType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["simple", "ring", "composite-line", "composite-ring"].includes(normalized)
    ? normalized
    : null;
}

function normalizeTemplateType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["circle", "cone", "ray", "rect"].includes(normalized)
    ? normalized
    : null;
}

function normalizeDirectionalSide(value, fallback = "left") {
  return String(value ?? "").trim().toLowerCase() === "right" ? "right" : fallback;
}

function normalizeRingSide(value) {
  return String(value ?? "").trim().toLowerCase() === "outer" ? "outer" : "inner";
}

function normalizeProfileScope(value, fallbackValue = "builtin") {
  return String(value ?? fallbackValue).trim().toLowerCase() === "user" ? "user" : "builtin";
}

function normalizeProfileId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "";
}

function slugifyProfileName(value) {
  const normalized = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || `profile-${Date.now()}`;
}

function localizeBaseType(baseType) {
  switch (normalizeBaseType(baseType)) {
    case "ring":
      return localize("PERSISTENT_ZONES.UI.BaseTypes.Ring", "Ring");
    case "composite-line":
      return localize("PERSISTENT_ZONES.UI.BaseTypes.CompositeLine", "Composite Line");
    case "composite-ring":
      return localize("PERSISTENT_ZONES.UI.BaseTypes.CompositeRing", "Composite Ring");
    case "simple":
    default:
      return localize("PERSISTENT_ZONES.UI.BaseTypes.Simple", "Simple");
  }
}

function localizeTemplateType(templateType) {
  switch (normalizeTemplateType(templateType)) {
    case "cone":
      return localize("PERSISTENT_ZONES.UI.TemplateTypes.Cone", "Cone");
    case "ray":
      return localize("PERSISTENT_ZONES.UI.TemplateTypes.Ray", "Line / Ray");
    case "rect":
      return localize("PERSISTENT_ZONES.UI.TemplateTypes.Rect", "Rectangle");
    case "circle":
      return localize("PERSISTENT_ZONES.UI.TemplateTypes.Circle", "Circle");
    default:
      return localize(
        "PERSISTENT_ZONES.UI.ProfileCompatibility.AnyTemplate",
        "Inherited from detected template"
      );
  }
}

function localize(key, fallback) {
  const localized = game.i18n?.localize?.(key);
  return localized && localized !== key ? localized : fallback;
}
