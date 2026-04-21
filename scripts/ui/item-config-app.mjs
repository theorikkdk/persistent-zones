import {
  DEFAULT_ZONE_LABEL,
  DEFINITION_FLAG_KEY,
  MODULE_ID,
  NORMALIZED_DEFINITION_VERSION,
  SUPPORTED_TEMPLATE_TYPES
} from "../constants.mjs";
import {
  coerceBoolean,
  coerceNumber,
  debug,
  duplicateData,
  fromUuidSafe,
  isPlainObject,
  pickFirstDefined,
  safeGet
} from "../runtime/utils.mjs";
import {
  cleanupRegionsForItem
} from "../runtime/concentration-cleanup.mjs";
import {
  getZoneDefinitionFromItem,
  normalizeZoneDefinition
} from "../runtime/zone-definition.mjs";

const AUTHORING_APP_ID = `${MODULE_ID}-item-config`;
const HEADER_BUTTON_CLASS = `${MODULE_ID}-item-config-button`;
const DEFAULT_SAVE_DC = 13;
const DEFAULT_SAVE_DC_MODE = "manual";
const DEFAULT_SAVE_DC_SOURCE = "caster";
const DEFAULT_SIMPLE_TEMPLATE_TYPE = "circle";
const DEFAULT_DAMAGE_TYPE = "fire";
const DEFAULT_LINE_TEMPLATE_WIDTH = 5;
const DEFAULT_RING_WALL_THICKNESS = 5;
const DEFAULT_COMPOSITE_WALL_THICKNESS = 1;
const DEFAULT_SIDE_THICKNESS = 3;
const MIN_THICKNESS = 0.1;
const DEFAULT_VARIANT_BY_BASE_TYPE = Object.freeze({
  "composite-line": "line-left",
  "composite-ring": "ring-inner"
});
const FALLBACK_DAMAGE_TYPES = Object.freeze({
  acid: "Acid",
  bludgeoning: "Bludgeoning",
  cold: "Cold",
  fire: "Fire",
  force: "Force",
  lightning: "Lightning",
  necrotic: "Necrotic",
  piercing: "Piercing",
  poison: "Poison",
  psychic: "Psychic",
  radiant: "Radiant",
  slashing: "Slashing",
  thunder: "Thunder"
});
const FALLBACK_ABILITIES = Object.freeze({
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma"
});

export function registerPersistentZonesItemConfigUi() {
  Hooks.on("renderItemSheet5e", onRenderItemSheet5e);
}

export async function openPersistentZonesItemConfig(itemOrUuid, options = {}) {
  const item = await resolveItemDocument(itemOrUuid);
  if (!item) {
    debug("Could not resolve Item for persistent-zones authoring UI.", {
      itemOrUuid
    });
    return null;
  }

  if (!canConfigurePersistentZonesItem(item)) {
    debug("Blocked persistent-zones authoring UI for Item without update permission.", {
      itemUuid: item.uuid,
      itemName: item.name
    });
    return null;
  }

  const app = new PersistentZonesItemConfig(item, options);
  app.render(true);
  return app;
}

class PersistentZonesItemConfig extends FormApplication {
  constructor(item, options = {}) {
    super(item, options);
    this.itemDocument = item;
    this._draftState = duplicateData(options.formState) ?? null;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: AUTHORING_APP_ID,
      classes: [MODULE_ID, "persistent-zones-item-config-app"],
      template: `modules/${MODULE_ID}/templates/item-zone-config.hbs`,
      width: 860,
      height: 860,
      resizable: true,
      submitOnChange: false,
      closeOnSubmit: false
    });
  }

  get title() {
    return `${localize("PERSISTENT_ZONES.UI.ConfigTitle", "Persistent Zones")} - ${this.itemDocument?.name ?? DEFAULT_ZONE_LABEL}`;
  }

  getData() {
    const rawDefinition = getZoneDefinitionFromItem(this.itemDocument);
    const formState =
      duplicateData(this._draftState) ??
      deriveAuthoringStateFromDefinition(rawDefinition, this.itemDocument);
    const draftDefinition = buildDefinitionFromAuthoringState(formState, {
      item: this.itemDocument
    });
    const preview = buildDefinitionPreview(this.itemDocument, formState, draftDefinition);

    return {
      item: this.itemDocument,
      itemName: this.itemDocument?.name ?? DEFAULT_ZONE_LABEL,
      hasStoredDefinition: Boolean(rawDefinition),
      state: formState,
      baseTypeOptions: buildChoiceOptions(getBaseTypeChoices(), formState.baseType),
      templateTypeOptions: buildChoiceOptions(getSimpleTemplateChoices(), formState.simpleTemplateType),
      variantOptions: buildChoiceOptions(
        getVariantChoicesForBaseType(formState.baseType),
        formState.selectedVariant
      ),
      damageTypeOptions: buildChoiceOptions(getDamageTypeChoices(), formState.damageType),
      saveDcModeOptions: buildChoiceOptions(getSaveDcModeChoices(), formState.saveDcMode),
      abilityOptions: buildChoiceOptions(
        [
          {
            value: "",
            label: localize("PERSISTENT_ZONES.UI.NoneOption", "None")
          },
          ...getAbilityChoices()
        ],
        formState.saveAbility
      ),
      showSimpleTemplateType: formState.baseType === "simple",
      showVariantSelect: hasVariantChoices(formState.baseType),
      showWallThickness: ["ring", "composite-line", "composite-ring"].includes(formState.baseType),
      showSideThickness: ["composite-line", "composite-ring"].includes(formState.baseType),
      showSaveDcMode: Boolean(formState.saveAbility),
      showManualSaveDc: Boolean(formState.saveAbility) && formState.saveDcMode === "manual",
      preview
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-action='preview']").on("click", this.#onPreview.bind(this, html));
    html.find("[data-action='clear']").on("click", this.#onClear.bind(this));
    html
      .find("[name='baseType'], [name='saveAbility'], [name='saveDcMode']")
      .on("change", this.#onBaseTypeChanged.bind(this, html));
  }

  async _updateObject(_event, formData) {
    const previousDefinition = getZoneDefinitionFromItem(this.itemDocument);
    const formState = normalizeAuthoringFormState(formData);
    const definition = buildDefinitionFromAuthoringState(formState, {
      item: this.itemDocument
    });

    await this.itemDocument.update({
      [`flags.${MODULE_ID}.${DEFINITION_FLAG_KEY}`]: definition
    });

    this._draftState = duplicateData(formState);
    this.itemDocument.sheet?.render(false);

    if (previousDefinition && formState.enabled === false) {
      await cleanupRegionsForItem(this.itemDocument, {
        reason: "item-config-disabled"
      });
    }

    debug("Saved persistent-zones item authoring definition.", {
      itemUuid: this.itemDocument.uuid,
      itemName: this.itemDocument.name,
      baseType: formState.baseType,
      selectedVariant: formState.selectedVariant,
      enabled: formState.enabled
    });

    ui.notifications?.info?.(
      localize(
        "PERSISTENT_ZONES.UI.Notifications.Saved",
        "Persistent Zones definition saved."
      )
    );

    await this.render(false);
  }

  async #onPreview(html, event) {
    event.preventDefault();
    this._draftState = readAuthoringFormState(html[0]);
    await this.render(false);
  }

  async #onBaseTypeChanged(html) {
    this._draftState = readAuthoringFormState(html[0]);
    await this.render(false);
  }

  async #onClear(event) {
    event.preventDefault();

    const confirmed = await Dialog.confirm({
      title: localize("PERSISTENT_ZONES.UI.ClearTitle", "Clear Persistent Zones Definition"),
      content: `<p>${localize("PERSISTENT_ZONES.UI.ClearConfirm", "Remove the persistent-zones definition from this Item?")}</p>`
    });

    if (!confirmed) {
      return;
    }

    await this.itemDocument.unsetFlag(MODULE_ID, DEFINITION_FLAG_KEY);
    await cleanupRegionsForItem(this.itemDocument, {
      reason: "item-config-cleared"
    });
    this._draftState = getDefaultAuthoringState(this.itemDocument);
    this.itemDocument.sheet?.render(false);

    debug("Cleared persistent-zones item authoring definition.", {
      itemUuid: this.itemDocument.uuid,
      itemName: this.itemDocument.name
    });

    ui.notifications?.info?.(
      localize(
        "PERSISTENT_ZONES.UI.Notifications.Cleared",
        "Persistent Zones definition cleared."
      )
    );

    await this.render(false);
  }
}

async function onRenderItemSheet5e(app, html) {
  const item = app?.item ?? app?.document ?? app?.object;
  const root = getRootElement(app, html);
  const headerRefs = findHeaderContainer(root);

  if (!item || !headerRefs || !canConfigurePersistentZonesItem(item)) {
    return;
  }

  headerRefs.insertionParent.querySelector(`.${HEADER_BUTTON_CLASS}`)?.remove();

  const state = getItemAuthoringButtonState(item);
  const buttonTag = headerRefs.closeControl?.tagName?.toLowerCase?.() || "button";
  const button = document.createElement(buttonTag);
  button.classList.add("header-control", HEADER_BUTTON_CLASS, `is-${state.status}`);
  button.setAttribute(
    "aria-label",
    localize("PERSISTENT_ZONES.UI.HeaderButtonLabel", "Open Persistent Zones configuration")
  );
  button.title = state.tooltip;

  if (buttonTag === "button") {
    button.type = "button";
  } else {
    button.href = "#";
  }

  button.innerHTML = '<i class="fas fa-wave-square" aria-hidden="true"></i>';
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await openPersistentZonesItemConfig(item);
  });

  if (headerRefs.closeControl) {
    headerRefs.insertionParent.insertBefore(button, headerRefs.closeControl);
  } else {
    headerRefs.insertionParent.append(button);
  }
}

function getRootElement(app, html) {
  if (app?.element instanceof HTMLElement) {
    return app.element;
  }

  if (app?.element?.[0] instanceof HTMLElement) {
    return app.element[0];
  }

  if (html instanceof HTMLElement) {
    return html;
  }

  if (html?.[0] instanceof HTMLElement) {
    return html[0];
  }

  return null;
}

function findHeaderContainer(root) {
  if (!root) {
    return null;
  }

  const applicationRoot = root.matches?.(".application") ? root : root.closest?.(".application") ?? root;
  const header = applicationRoot.querySelector?.(".window-header");
  if (!header) {
    return null;
  }

  const closeControl = header.querySelector(
    '[data-action="close"], .header-control.close, .window-control.close, .close'
  );

  return {
    header,
    closeControl,
    insertionParent: closeControl?.parentElement ?? header
  };
}

function getItemAuthoringButtonState(item) {
  const rawDefinition = getZoneDefinitionFromItem(item);
  if (!rawDefinition) {
    return {
      status: "disabled",
      tooltip: localize(
        "PERSISTENT_ZONES.UI.HeaderButtonHintDisabled",
        "Persistent Zones not configured on this Item"
      )
    };
  }

  const formState = deriveAuthoringStateFromDefinition(rawDefinition, item);
  const preview = buildDefinitionPreview(item, formState, rawDefinition);

  if (rawDefinition.enabled === false) {
    return {
      status: "inactive",
      tooltip: localize(
        "PERSISTENT_ZONES.UI.HeaderButtonHintInactive",
        "Persistent Zones configured but disabled on this Item"
      )
    };
  }

  if (preview.isValid) {
    return {
      status: "valid",
      tooltip: localize(
        "PERSISTENT_ZONES.UI.HeaderButtonHintValid",
        "Persistent Zones configured and valid"
      )
    };
  }

  return {
    status: "invalid",
    tooltip: localize(
      "PERSISTENT_ZONES.UI.HeaderButtonHintInvalid",
      "Persistent Zones configured, but the current definition is invalid"
    )
  };
}

function buildDefinitionPreview(item, formState, definition) {
  const previewTemplateDocument = buildPreviewTemplateDocument(formState);

  try {
    const normalizedDefinition = normalizeZoneDefinition(definition, {
      item,
      actor: item?.actor ?? null,
      templateDocument: previewTemplateDocument
    });

    return {
      previewTemplateType: previewTemplateDocument?.t ?? null,
      previewTemplateTypeLabel: previewTemplateDocument?.t
        ? localizeTemplateType(previewTemplateDocument.t)
        : null,
      rawDefinition: definition,
      rawDefinitionJson: JSON.stringify(definition, null, 2),
      normalizedDefinition,
      normalizedDefinitionJson: JSON.stringify(normalizedDefinition, null, 2),
      isValid: normalizedDefinition?.validation?.isValid ?? false,
      reasons: Array.isArray(normalizedDefinition?.validation?.reasons)
        ? normalizedDefinition.validation.reasons
        : [],
      variantResolution: normalizedDefinition?.variantResolution ?? null
    };
  } catch (caughtError) {
    return {
      previewTemplateType: previewTemplateDocument?.t ?? null,
      previewTemplateTypeLabel: previewTemplateDocument?.t
        ? localizeTemplateType(previewTemplateDocument.t)
        : null,
      rawDefinition: definition,
      rawDefinitionJson: JSON.stringify(definition, null, 2),
      normalizedDefinition: null,
      normalizedDefinitionJson: "",
      isValid: false,
      reasons: [caughtError?.message ?? "Unknown preview error."],
      variantResolution: null
    };
  }
}

function readAuthoringFormState(root) {
  const form = root?.querySelector?.("form") ?? root;

  return normalizeAuthoringFormState({
    enabled: readCheckbox(form, "enabled"),
    baseType: readValue(form, "baseType"),
    simpleTemplateType: readValue(form, "simpleTemplateType"),
    selectedVariant: readValue(form, "selectedVariant"),
    onEnterEnabled: readCheckbox(form, "onEnterEnabled"),
    damageFormula: readValue(form, "damageFormula"),
    damageType: readValue(form, "damageType"),
    saveAbility: readValue(form, "saveAbility"),
    saveDcMode: readValue(form, "saveDcMode"),
    saveDc: readValue(form, "saveDc"),
    wallThickness: readValue(form, "wallThickness"),
    sideThickness: readValue(form, "sideThickness")
  });
}

function normalizeAuthoringFormState(formData = {}) {
  const baseType = normalizeBaseType(formData.baseType);
  const simpleTemplateType = normalizeSimpleTemplateType(formData.simpleTemplateType);
  const selectedVariant = normalizeVariantSelection(baseType, formData.selectedVariant);
  const damageFormula = String(formData.damageFormula ?? "").trim();
  const saveAbility = normalizeAbilityId(formData.saveAbility);
  const saveDcMode = normalizeSaveDcMode(formData.saveDcMode);
  const saveDc = saveAbility ? Math.max(coerceNumber(formData.saveDc, DEFAULT_SAVE_DC), 1) : DEFAULT_SAVE_DC;

  return {
    enabled: coerceBoolean(formData.enabled, true) ?? true,
    baseType,
    simpleTemplateType,
    selectedVariant,
    onEnterEnabled: coerceBoolean(formData.onEnterEnabled, false) ?? false,
    damageFormula,
    damageType: normalizeDamageType(formData.damageType),
    saveAbility,
    saveDcMode,
    saveDc,
    wallThickness: clampWallThickness(
      formData.wallThickness,
      getDefaultWallThicknessForBaseType(baseType)
    ),
    sideThickness: clampSideThickness(
      formData.sideThickness,
      getDefaultSideThicknessForBaseType(baseType)
    )
  };
}

function getDefaultAuthoringState(item = null) {
  return {
    enabled: true,
    baseType: "simple",
    simpleTemplateType: inferItemTemplateType(item) ?? DEFAULT_SIMPLE_TEMPLATE_TYPE,
    selectedVariant: DEFAULT_VARIANT_BY_BASE_TYPE["composite-line"],
    onEnterEnabled: false,
    damageFormula: "2d6",
    damageType: DEFAULT_DAMAGE_TYPE,
    saveAbility: "",
    saveDcMode: DEFAULT_SAVE_DC_MODE,
    saveDc: DEFAULT_SAVE_DC,
    wallThickness: getDefaultWallThicknessForBaseType("simple"),
    sideThickness: getDefaultSideThicknessForBaseType("simple")
  };
}

function deriveAuthoringStateFromDefinition(rawDefinition, item = null) {
  if (!isPlainObject(rawDefinition)) {
    return getDefaultAuthoringState(item);
  }

  const fallbackState = getDefaultAuthoringState(item);
  const effectiveDefinition = resolveEffectiveAuthoringDefinition(rawDefinition);
  const previewTemplateDocument = buildPreviewTemplateDocumentFromDefinition(rawDefinition, effectiveDefinition, item);
  const normalizedDefinition = normalizeZoneDefinition(rawDefinition, {
    item,
    actor: item?.actor ?? null,
    templateDocument: previewTemplateDocument
  });
  const baseType = detectAuthoringBaseType(effectiveDefinition, normalizedDefinition);
  const onEnterConfig = resolveAuthoringOnEnterTrigger(normalizedDefinition, baseType);

  return {
    enabled: coerceBoolean(rawDefinition.enabled, true) ?? true,
    baseType,
    simpleTemplateType:
      normalizeSimpleTemplateType(
        pickFirstDefined(
          safeGet(effectiveDefinition, ["template", "type"]),
          normalizedDefinition?.template?.type,
          fallbackState.simpleTemplateType
        )
      ),
    selectedVariant: normalizeVariantSelection(
      baseType,
      pickFirstDefined(
        rawDefinition.selectedVariant,
        rawDefinition.variantId,
        rawDefinition.variant,
        normalizedDefinition?.selectedVariantId,
        fallbackState.selectedVariant
      )
    ),
    onEnterEnabled: onEnterConfig.enabled ?? false,
    damageFormula: String(onEnterConfig.damage?.formula ?? "").trim(),
    damageType: normalizeDamageType(onEnterConfig.damage?.type ?? fallbackState.damageType),
    saveAbility: normalizeAbilityId(onEnterConfig.save?.ability),
    saveDcMode: normalizeSaveDcMode(
      pickFirstDefined(
        onEnterConfig.save?.dcMode,
        onEnterConfig.save?.dcSource ? "auto" : null,
        fallbackState.saveDcMode
      )
    ),
    saveDc: Math.max(
      coerceNumber(onEnterConfig.save?.dc, fallbackState.saveDc),
      1
    ),
    wallThickness: deriveAuthoringWallThickness(effectiveDefinition, normalizedDefinition, baseType),
    sideThickness: deriveCompositeSideThickness(effectiveDefinition, normalizedDefinition, baseType)
  };
}

function buildDefinitionFromAuthoringState(formState, {
  item = null
} = {}) {
  const state = normalizeAuthoringFormState(formState);
  const commonDefinition = {
    schemaVersion: NORMALIZED_DEFINITION_VERSION,
    source: {
      type: "item-flag",
      module: MODULE_ID,
      authoring: "item-config",
      baseType: state.baseType
    },
    enabled: state.enabled,
    label: item?.name ?? DEFAULT_ZONE_LABEL,
    shapeMode: "template",
    targeting: {
      mode: "all",
      includeSelf: true
    },
    concentration: {
      required: false
    }
  };

  switch (state.baseType) {
    case "ring":
      return {
        ...commonDefinition,
        template: {
          type: "circle"
        },
        triggers: buildRootOnEnterTriggers(state),
        parts: [
          {
            id: "wall-body",
            label: localize("PERSISTENT_ZONES.UI.Parts.WallBody", "Wall Body"),
            geometry: {
              type: "ring",
              referenceRadiusMode: "outer-edge",
              thickness: state.wallThickness,
              segments: 24
            }
          }
        ]
      };

    case "composite-line":
      return {
        ...commonDefinition,
        template: {
          type: "ray",
          width: state.wallThickness
        },
        triggers: buildDisabledTriggers(),
        defaultVariant: state.selectedVariant,
        selectedVariant: state.selectedVariant,
        variants: [
          buildVariantDefinitionEntry("line-left", buildCompositeLineVariantDefinition("left", state)),
          buildVariantDefinitionEntry("line-right", buildCompositeLineVariantDefinition("right", state))
        ]
      };

    case "composite-ring":
      return {
        ...commonDefinition,
        template: {
          type: "circle"
        },
        triggers: buildDisabledTriggers(),
        defaultVariant: state.selectedVariant,
        selectedVariant: state.selectedVariant,
        variants: [
          buildVariantDefinitionEntry("ring-inner", buildCompositeRingVariantDefinition("inner", state)),
          buildVariantDefinitionEntry("ring-outer", buildCompositeRingVariantDefinition("outer", state))
        ]
      };

    case "simple":
    default:
      return {
        ...commonDefinition,
        template: {
          type: state.simpleTemplateType
        },
        triggers: buildRootOnEnterTriggers(state)
      };
  }
}

function buildRootOnEnterTriggers(state) {
  return {
    ...buildDisabledTriggers(),
    onEnter: buildOnEnterTriggerConfig(state)
  };
}

function buildDisabledTriggers() {
  return {
    onEnter: { enabled: false },
    onExit: { enabled: false },
    onMove: { enabled: false },
    onStartTurn: { enabled: false },
    onEndTurn: { enabled: false }
  };
}

function buildOnEnterTriggerConfig(state) {
  const damageFormula = String(state.damageFormula ?? "").trim();
  const saveAbility = normalizeAbilityId(state.saveAbility);
  const saveDcMode = normalizeSaveDcMode(state.saveDcMode);
  const saveDc = saveAbility && saveDcMode === "manual"
    ? Math.max(coerceNumber(state.saveDc, DEFAULT_SAVE_DC), 1)
    : null;

  return {
    enabled: state.onEnterEnabled === true,
    damage: {
      enabled: Boolean(state.onEnterEnabled && damageFormula),
      formula: damageFormula || null,
      type: normalizeDamageType(state.damageType)
    },
    save: {
      enabled: Boolean(state.onEnterEnabled && saveAbility),
      ability: saveAbility || null,
      dcMode: saveDcMode,
      dcSource: saveAbility && saveDcMode === "auto" ? DEFAULT_SAVE_DC_SOURCE : null,
      dc: saveDc,
      onSuccess: "half"
    }
  };
}

function buildCompositeLineVariantDefinition(side, state) {
  const normalizedSide = normalizeLineVariantSide(side);

  return {
    label: getVariantLabel(normalizedSide === "right" ? "line-right" : "line-left"),
    template: {
      type: "ray",
      width: state.wallThickness
    },
    triggers: buildDisabledTriggers(),
    parts: [
      {
        id: "wall-body",
        label: localize("PERSISTENT_ZONES.UI.Parts.WallBody", "Wall Body"),
        geometry: {
          type: "template"
        }
      },
      {
        id: `heated-side-${normalizedSide}`,
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
          offsetEnd: state.sideThickness
        },
        triggers: {
          onEnter: buildOnEnterTriggerConfig(state)
        }
      }
    ]
  };
}

function buildCompositeRingVariantDefinition(side, state) {
  const normalizedSide = normalizeRingVariantSide(side);

  return {
    label: getVariantLabel(normalizedSide === "outer" ? "ring-outer" : "ring-inner"),
    template: {
      type: "circle"
    },
    triggers: buildDisabledTriggers(),
    parts: [
      {
        id: "wall-body",
        label: localize("PERSISTENT_ZONES.UI.Parts.WallBody", "Wall Body"),
        geometry: {
          type: "ring",
          referenceRadiusMode: "outer-edge",
          thickness: state.wallThickness,
          segments: 24
        }
      },
      {
        id: `heated-side-${normalizedSide}`,
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
          offsetEnd: state.sideThickness,
          segments: 24
        },
        triggers: {
          onEnter: buildOnEnterTriggerConfig(state)
        }
      }
    ]
  };
}

function buildVariantDefinitionEntry(variantId, definition) {
  return {
    id: variantId,
    key: variantId,
    label: definition.label ?? getVariantLabel(variantId),
    template: duplicateData(definition.template ?? {}),
    triggers: duplicateData(definition.triggers ?? {}),
    parts: duplicateData(definition.parts ?? [])
  };
}

function buildPreviewTemplateDocument(formState) {
  switch (formState.baseType) {
    case "ring":
    case "composite-ring":
      return {
        t: "circle",
        distance: 20,
        direction: 0,
        elevation: 0
      };

    case "composite-line":
      return {
        t: "ray",
        distance: 30,
        width: formState.wallThickness,
        direction: 0,
        elevation: 0
      };

    case "simple":
    default: {
      const templateType = normalizeSimpleTemplateType(formState.simpleTemplateType);
      return {
        t: templateType,
        distance: ["circle", "cone"].includes(templateType) ? 20 : 30,
        width: ["ray", "rect"].includes(templateType) ? DEFAULT_LINE_TEMPLATE_WIDTH : null,
        angle: templateType === "cone" ? 90 : null,
        direction: 0,
        elevation: 0
      };
    }
  }
}

function buildPreviewTemplateDocumentFromDefinition(rawDefinition, effectiveDefinition, item = null) {
  const baseType = detectAuthoringBaseType(effectiveDefinition, null);
  if (baseType === "ring" || baseType === "composite-ring") {
    return {
      t: "circle",
      distance: 20,
      direction: 0,
      elevation: 0
    };
  }

  if (baseType === "composite-line") {
      return {
        t: "ray",
        distance: 30,
        width: coerceLocalizedNumber(
          safeGet(effectiveDefinition, ["template", "width"]),
          getDefaultWallThicknessForBaseType("composite-line")
        ),
        direction: 0,
        elevation: 0
      };
  }

  const inferredTemplateType = normalizeSimpleTemplateType(
    pickFirstDefined(
      safeGet(effectiveDefinition, ["template", "type"]),
      inferItemTemplateType(item),
      DEFAULT_SIMPLE_TEMPLATE_TYPE
    )
  );

  return {
    t: inferredTemplateType,
    distance: ["circle", "cone"].includes(inferredTemplateType) ? 20 : 30,
    width: ["ray", "rect"].includes(inferredTemplateType) ? DEFAULT_LINE_TEMPLATE_WIDTH : null,
    angle: inferredTemplateType === "cone" ? 90 : null,
    direction: 0,
    elevation: 0
  };
}

function detectAuthoringBaseType(effectiveDefinition, normalizedDefinition = null) {
  const parts = Array.isArray(normalizedDefinition?.parts)
    ? normalizedDefinition.parts
    : Array.isArray(effectiveDefinition?.parts)
      ? effectiveDefinition.parts
      : Array.isArray(effectiveDefinition?.zones)
        ? effectiveDefinition.zones
        : [];
  const geometryTypes = parts.map((part) => String(part?.geometry?.type ?? "template").toLowerCase());

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

function resolveAuthoringOnEnterTrigger(normalizedDefinition, baseType) {
  if (!normalizedDefinition) {
    return buildOnEnterTriggerConfig(getDefaultAuthoringState());
  }

  if (["composite-line", "composite-ring"].includes(baseType)) {
    const partTrigger = normalizedDefinition.parts?.find((part) => {
      const geometryType = String(part?.geometry?.type ?? "").toLowerCase();
      return geometryType === "side-of-line" || geometryType === "side-of-ring";
    })?.triggers?.onEnter;

    if (partTrigger) {
      return partTrigger;
    }
  }

  return normalizedDefinition.triggers?.onEnter ?? { enabled: false };
}

function deriveAuthoringWallThickness(effectiveDefinition, normalizedDefinition, baseType) {
  if (baseType === "composite-line") {
    return deriveLineWallThickness(effectiveDefinition, normalizedDefinition);
  }

  return deriveRingWallThickness(effectiveDefinition, normalizedDefinition, baseType);
}

function deriveRingWallThickness(effectiveDefinition, normalizedDefinition, baseType = "ring") {
  const rawThickness = findRingThicknessInDefinition(effectiveDefinition);
  if (rawThickness !== null) {
    return rawThickness;
  }

  const ringPart = normalizedDefinition?.parts?.find((part) => {
    const geometryType = String(part?.geometry?.type ?? "").toLowerCase();
    return geometryType === "ring" || geometryType === "annulus";
  });
  const innerRadius = coerceNumber(ringPart?.geometry?.innerRadius, null);
  const outerRadius = coerceNumber(ringPart?.geometry?.outerRadius, null);
  if (innerRadius !== null && outerRadius !== null && outerRadius > innerRadius) {
    return clampWallThickness(outerRadius - innerRadius);
  }

  return getDefaultWallThicknessForBaseType(baseType);
}

function deriveLineWallThickness(effectiveDefinition, normalizedDefinition) {
  const templateWidth = coerceLocalizedNumber(
    pickFirstDefined(
      safeGet(effectiveDefinition, ["template", "width"]),
      normalizedDefinition?.template?.width
    ),
    null
  );

  return templateWidth !== null
    ? clampWallThickness(templateWidth, getDefaultWallThicknessForBaseType("composite-line"))
    : getDefaultWallThicknessForBaseType("composite-line");
}

function deriveCompositeSideThickness(effectiveDefinition, normalizedDefinition, baseType) {
  if (!["composite-line", "composite-ring"].includes(baseType)) {
    return getDefaultSideThicknessForBaseType(baseType);
  }

  const geometrySource = Array.from(effectiveDefinition?.parts ?? []).find((part) => {
    const geometryType = String(part?.geometry?.type ?? "").toLowerCase();
    return geometryType === "side-of-line" || geometryType === "side-of-ring";
  });
  const normalizedPart = Array.from(normalizedDefinition?.parts ?? []).find((part) => {
    const geometryType = String(part?.geometry?.type ?? "").toLowerCase();
    return geometryType === "side-of-line" || geometryType === "side-of-ring";
  });
  const offsetStart = coerceNumber(
    pickFirstDefined(geometrySource?.geometry?.offsetStart, normalizedPart?.geometry?.offsetStart),
    0
  );
  const offsetEnd = coerceNumber(
    pickFirstDefined(geometrySource?.geometry?.offsetEnd, normalizedPart?.geometry?.offsetEnd),
    null
  );

  if (offsetEnd !== null) {
    return clampSideThickness(
      Math.max(offsetEnd - offsetStart, MIN_THICKNESS),
      getDefaultSideThicknessForBaseType(baseType)
    );
  }

  return getDefaultSideThicknessForBaseType(baseType);
}

function findRingThicknessInDefinition(definition) {
  const geometrySources = [
    safeGet(definition, ["geometry"]),
    ...Array.from(definition?.parts ?? []),
    ...Array.from(definition?.zones ?? [])
  ];

  for (const source of geometrySources) {
    const geometry = source?.geometry ?? source;
    const type = String(geometry?.type ?? "").toLowerCase();
    if (!["ring", "annulus"].includes(type)) {
      continue;
    }

    const thickness = coerceNumber(geometry?.thickness, null);
    if (thickness !== null) {
      return clampWallThickness(thickness);
    }
  }

  return null;
}

function resolveEffectiveAuthoringDefinition(rawDefinition) {
  if (!isPlainObject(rawDefinition)) {
    return {};
  }

  const variants = Array.isArray(rawDefinition.variants)
    ? rawDefinition.variants.filter((variant) => isPlainObject(variant))
    : [];
  if (!variants.length) {
    return duplicateData(rawDefinition);
  }

  const requestedVariantId = pickFirstDefined(
    rawDefinition.selectedVariant,
    rawDefinition.variantId,
    rawDefinition.variant,
    null
  );
  const defaultVariantId = pickFirstDefined(
    rawDefinition.defaultVariant,
    rawDefinition.defaultVariantId,
    null
  );
  const selectedVariant =
    findVariantDefinitionById(variants, requestedVariantId) ??
    findVariantDefinitionById(variants, defaultVariantId) ??
    variants[0] ??
    null;

  const effectiveDefinition = mergePlainObjects(
    stripVariantKeys(rawDefinition),
    stripVariantKeys(selectedVariant ?? {})
  );

  effectiveDefinition.selectedVariant =
    selectedVariant?.id ??
    selectedVariant?.key ??
    requestedVariantId ??
    defaultVariantId ??
    null;

  return effectiveDefinition;
}

function stripVariantKeys(definition) {
  const clone = duplicateData(definition ?? {});
  delete clone.variants;
  delete clone.selectedVariant;
  delete clone.variant;
  delete clone.variantId;
  delete clone.defaultVariant;
  delete clone.defaultVariantId;
  return clone;
}

function mergePlainObjects(baseValue, overrideValue) {
  const baseObject = isPlainObject(baseValue) ? duplicateData(baseValue) : {};
  const overrideObject = isPlainObject(overrideValue) ? overrideValue : {};
  const merged = { ...baseObject };

  for (const [key, value] of Object.entries(overrideObject)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergePlainObjects(merged[key], value);
      continue;
    }

    merged[key] = duplicateData(value);
  }

  return merged;
}

function findVariantDefinitionById(variants, variantId) {
  const lookupId = String(variantId ?? "").trim().toLowerCase();
  if (!lookupId) {
    return null;
  }

  return (
    variants.find((variant) => {
      const candidateId = String(variant?.id ?? variant?.key ?? "").trim().toLowerCase();
      return candidateId === lookupId;
    }) ?? null
  );
}

function inferItemTemplateType(item) {
  const activityTemplates = Array.from(item?.system?.activities ?? []).map((entry) => {
    const activity = Array.isArray(entry) ? entry[1] : entry;
    return (
      safeGet(activity, ["target", "template", "type"]) ??
      safeGet(activity, ["template", "type"]) ??
      safeGet(activity, ["activation", "template", "type"]) ??
      null
    );
  }).filter(Boolean);

  const inferredType = pickFirstDefined(
    activityTemplates[0],
    safeGet(item, ["system", "target", "template", "type"]),
    safeGet(item, ["system", "template", "type"]),
    null
  );

  return normalizeSimpleTemplateType(inferredType);
}

function buildChoiceOptions(choices, selectedValue) {
  return Array.from(choices ?? []).map((choice) => ({
    value: choice.value,
    label: choice.label,
    selected: String(choice.value ?? "") === String(selectedValue ?? "")
  }));
}

function getBaseTypeChoices() {
  return [
    {
      value: "simple",
      label: localize("PERSISTENT_ZONES.UI.BaseTypes.Simple", "Simple")
    },
    {
      value: "ring",
      label: localize("PERSISTENT_ZONES.UI.BaseTypes.Ring", "Ring")
    },
    {
      value: "composite-line",
      label: localize("PERSISTENT_ZONES.UI.BaseTypes.CompositeLine", "Composite Line")
    },
    {
      value: "composite-ring",
      label: localize("PERSISTENT_ZONES.UI.BaseTypes.CompositeRing", "Composite Ring")
    }
  ];
}

function getSimpleTemplateChoices() {
  return SUPPORTED_TEMPLATE_TYPES.map((templateType) => ({
    value: templateType,
    label: localizeTemplateType(templateType)
  }));
}

function getVariantChoicesForBaseType(baseType) {
  switch (normalizeBaseType(baseType)) {
    case "composite-ring":
      return [
        {
          value: "ring-inner",
          label: getVariantLabel("ring-inner")
        },
        {
          value: "ring-outer",
          label: getVariantLabel("ring-outer")
        }
      ];

    case "composite-line":
      return [
        {
          value: "line-left",
          label: getVariantLabel("line-left")
        },
        {
          value: "line-right",
          label: getVariantLabel("line-right")
        }
      ];

    default:
      return [];
  }
}

function hasVariantChoices(baseType) {
  return getVariantChoicesForBaseType(baseType).length > 0;
}

function getDamageTypeChoices() {
  const source = CONFIG?.DND5E?.damageTypes ?? FALLBACK_DAMAGE_TYPES;
  return Object.entries(source).map(([value, label]) => ({
    value,
    label: resolveChoiceLabel(label, value)
  }));
}

function getAbilityChoices() {
  const source = CONFIG?.DND5E?.abilities ?? FALLBACK_ABILITIES;
  return Object.entries(source).map(([value, label]) => ({
    value,
    label: resolveChoiceLabel(label, value)
  }));
}

function getSaveDcModeChoices() {
  return [
    {
      value: "auto",
      label: localize("PERSISTENT_ZONES.UI.Fields.SaveDcModeAuto", "Automatic")
    },
    {
      value: "manual",
      label: localize("PERSISTENT_ZONES.UI.Fields.SaveDcModeManual", "Manual")
    }
  ];
}

function getVariantLabel(variantId) {
  switch (String(variantId ?? "").toLowerCase()) {
    case "line-right":
      return localize("PERSISTENT_ZONES.UI.Variants.LineRight", "Line Right");
    case "ring-inner":
      return localize("PERSISTENT_ZONES.UI.Variants.RingInner", "Ring Inner");
    case "ring-outer":
      return localize("PERSISTENT_ZONES.UI.Variants.RingOuter", "Ring Outer");
    case "line-left":
    default:
      return localize("PERSISTENT_ZONES.UI.Variants.LineLeft", "Line Left");
  }
}

function localizeTemplateType(templateType) {
  switch (String(templateType ?? "").toLowerCase()) {
    case "cone":
      return localize("PERSISTENT_ZONES.UI.TemplateTypes.Cone", "Cone");
    case "ray":
      return localize("PERSISTENT_ZONES.UI.TemplateTypes.Ray", "Line / Ray");
    case "rect":
      return localize("PERSISTENT_ZONES.UI.TemplateTypes.Rect", "Rectangle");
    case "circle":
    default:
      return localize("PERSISTENT_ZONES.UI.TemplateTypes.Circle", "Circle");
  }
}

function localizeMaybe(value) {
  const stringValue = String(value ?? "");
  if (!stringValue) {
    return stringValue;
  }

  const localized = game.i18n?.localize?.(stringValue);
  return localized && localized !== stringValue ? localized : stringValue;
}

function resolveChoiceLabel(choiceLike, fallbackValue = "") {
  if (typeof choiceLike === "string") {
    return localizeMaybe(choiceLike);
  }

  if (isPlainObject(choiceLike)) {
    const candidate = pickFirstDefined(
      choiceLike.label,
      choiceLike.name,
      choiceLike.long,
      choiceLike.abbreviation,
      choiceLike.short,
      fallbackValue
    );
    if (candidate !== choiceLike) {
      return resolveChoiceLabel(candidate, fallbackValue);
    }
  }

  return localizeMaybe(fallbackValue);
}

function localize(key, fallback) {
  const localized = game.i18n?.localize?.(key);
  return localized && localized !== key ? localized : fallback;
}

function normalizeBaseType(value) {
  const normalized = String(value ?? "simple").trim().toLowerCase();
  return ["simple", "ring", "composite-line", "composite-ring"].includes(normalized)
    ? normalized
    : "simple";
}

function normalizeSimpleTemplateType(value) {
  const normalized = String(value ?? DEFAULT_SIMPLE_TEMPLATE_TYPE).trim().toLowerCase();
  return SUPPORTED_TEMPLATE_TYPES.includes(normalized)
    ? normalized
    : DEFAULT_SIMPLE_TEMPLATE_TYPE;
}

function normalizeVariantSelection(baseType, selectedVariant) {
  const choices = getVariantChoicesForBaseType(baseType);
  if (!choices.length) {
    return "";
  }

  const normalizedSelectedVariant = String(selectedVariant ?? "").trim().toLowerCase();
  const matchingChoice = choices.find((choice) => choice.value === normalizedSelectedVariant);
  return matchingChoice?.value ?? choices[0].value;
}

function normalizeDamageType(value) {
  const normalized = String(value ?? DEFAULT_DAMAGE_TYPE).trim().toLowerCase();
  return normalized || DEFAULT_DAMAGE_TYPE;
}

function normalizeAbilityId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || "";
}

function normalizeSaveDcMode(value) {
  return String(value ?? DEFAULT_SAVE_DC_MODE).trim().toLowerCase() === "auto"
    ? "auto"
    : "manual";
}

function getDefaultWallThicknessForBaseType(baseType) {
  return ["composite-line", "composite-ring"].includes(normalizeBaseType(baseType))
    ? DEFAULT_COMPOSITE_WALL_THICKNESS
    : DEFAULT_RING_WALL_THICKNESS;
}

function getDefaultSideThicknessForBaseType(baseType) {
  return ["composite-line", "composite-ring"].includes(normalizeBaseType(baseType))
    ? DEFAULT_SIDE_THICKNESS
    : DEFAULT_SIDE_THICKNESS;
}

function normalizeLineVariantSide(value) {
  return String(value ?? "").toLowerCase() === "right" ? "right" : "left";
}

function normalizeRingVariantSide(value) {
  return String(value ?? "").toLowerCase() === "outer" ? "outer" : "inner";
}

function clampWallThickness(value, fallback = DEFAULT_RING_WALL_THICKNESS) {
  return Math.max(coerceLocalizedNumber(value, fallback), MIN_THICKNESS);
}

function clampSideThickness(value, fallback = DEFAULT_SIDE_THICKNESS) {
  return Math.max(coerceLocalizedNumber(value, fallback), MIN_THICKNESS);
}

function coerceLocalizedNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === "string") {
    const normalized = value.trim().replace(/\s+/g, "").replace(",", ".");
    if (!normalized) {
      return fallback;
    }

    const numericValue = Number(normalized);
    return Number.isFinite(numericValue) ? numericValue : fallback;
  }

  return coerceNumber(value, fallback);
}

function readCheckbox(form, name) {
  return form?.querySelector?.(`[name="${name}"]`)?.checked ?? false;
}

function readValue(form, name) {
  return form?.querySelector?.(`[name="${name}"]`)?.value ?? "";
}

function canConfigurePersistentZonesItem(item) {
  if (!item) {
    return false;
  }

  if (typeof item.canUserModify === "function") {
    return item.canUserModify(game.user, "update");
  }

  return Boolean(item.isOwner || game.user?.isGM);
}

async function resolveItemDocument(itemOrUuid) {
  if (!itemOrUuid) {
    return null;
  }

  if (itemOrUuid.documentName === "Item") {
    return itemOrUuid;
  }

  if (typeof itemOrUuid !== "string") {
    return null;
  }

  const resolved = await fromUuidSafe(itemOrUuid);
  if (resolved?.documentName === "Item") {
    return resolved;
  }

  if (resolved?.parent?.documentName === "Item") {
    return resolved.parent;
  }

  return null;
}
