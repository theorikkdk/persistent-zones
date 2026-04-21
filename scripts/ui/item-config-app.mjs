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
  normalizeZoneDefinition,
  resolveItemTemplateTypeDetection
} from "../runtime/zone-definition.mjs";
import {
  resolveZoneTriggeredActivityCompatibility,
  ZONE_TRIGGER_SUPPORTED_ACTIVITY_TYPES
} from "../runtime/activity-compatibility.mjs";

const AUTHORING_APP_ID = `${MODULE_ID}-item-config`;
const HEADER_BUTTON_CLASS = `${MODULE_ID}-item-config-button`;
const DEFAULT_SAVE_DC = 13;
const DEFAULT_SAVE_DC_MODE = "manual";
const DEFAULT_SAVE_DC_SOURCE = "caster";
const DEFAULT_TEMPLATE_TYPE_SOURCE = "auto";
const DEFAULT_SIMPLE_TEMPLATE_TYPE = "circle";
const DEFAULT_DAMAGE_TYPE = "fire";
const DEFAULT_ON_ENTER_MODE = "none";
const DEFAULT_MOVE_DISTANCE_STEP = 5;
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
const AUTHORING_PART_IDS = Object.freeze([
  "wall-body",
  "heated-side-left",
  "heated-side-right",
  "heated-side-inner",
  "heated-side-outer"
]);
const AUTHORING_TRIGGER_TIMINGS = Object.freeze([
  "onEnter",
  "onExit",
  "onMove",
  "onStartTurn",
  "onEndTurn"
]);

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
      width: 760,
      height: 880,
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
    const rawFormState =
      duplicateData(this._draftState) ??
      deriveAuthoringStateFromDefinition(rawDefinition, this.itemDocument);
    const selectionContext = resolveAuthoringSelectionContext(rawFormState, this.itemDocument);
    const formState = selectionContext.state;
    const templateTypeContext = resolveAuthoringTemplateTypeContext(formState, this.itemDocument);
    const draftDefinition = buildDefinitionFromAuthoringState(formState, {
      item: this.itemDocument
    });
    const preview = buildDefinitionPreview(this.itemDocument, formState, draftDefinition);

    const compositeMode = isCompositeBaseType(formState.baseType);

    return {
      item: this.itemDocument,
      itemName: this.itemDocument?.name ?? DEFAULT_ZONE_LABEL,
      hasStoredDefinition: Boolean(rawDefinition),
      state: formState,
      baseTypeOptions: buildChoiceOptions(
        selectionContext.compatibleBaseTypeChoices,
        selectionContext.effectiveBaseType
      ),
      templateTypeContext,
      selectionContext,
      variantOptions: buildChoiceOptions(
        selectionContext.variantChoices,
        selectionContext.effectiveSelectedVariant
      ),
      globalTriggerSections: buildTriggerEditorSections(formState.triggerConfigs, this.itemDocument),
      partSections: buildCompositePartSections(formState, this.itemDocument),
      selectedVariantLabel: selectionContext.selectedVariantLabel,
      showVariantSelect: selectionContext.variantChoices.length > 0,
      showWallThickness: ["ring", "composite-line", "composite-ring"].includes(formState.baseType),
      showSideThickness: ["composite-line", "composite-ring"].includes(formState.baseType),
      showGlobalTriggers: !compositeMode,
      showCompositePartSections: compositeMode,
      preview
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-action='preview']").on("click", this.#onPreview.bind(this, html));
    html.find("[data-action='clear']").on("click", this.#onClear.bind(this));
    html.find("[data-rerender='true']").on("change", this.#onBaseTypeChanged.bind(this, html));
  }

  async _updateObject(_event, formData) {
    const previousDefinition = getZoneDefinitionFromItem(this.itemDocument);
    const rawFormState = readAuthoringFormState(
      this.form,
      this._draftState ?? deriveAuthoringStateFromDefinition(previousDefinition, this.itemDocument),
      this.itemDocument
    );
    const selectionContext = resolveAuthoringSelectionContext(rawFormState, this.itemDocument);
    const formState = selectionContext.state;
    const definition = buildDefinitionFromAuthoringState(formState, {
      item: this.itemDocument
    });
    const previousBaseType = deriveBaseTypeFromDefinition(previousDefinition, this.itemDocument);
    const nextBaseType = formState.baseType;
    const removedLegacyFields = collectRemovedLegacyDefinitionFields(previousDefinition, definition);

    if (previousDefinition) {
      await this.itemDocument.unsetFlag(MODULE_ID, DEFINITION_FLAG_KEY);
    }

    await this.itemDocument.setFlag(MODULE_ID, DEFINITION_FLAG_KEY, definition);

    const appliedDefinition = getZoneDefinitionFromItem(this.itemDocument) ?? definition;
    this._draftState = deriveAuthoringStateFromDefinition(appliedDefinition, this.itemDocument);
    this.itemDocument.sheet?.render(false);

    if (previousDefinition && formState.enabled === false) {
      await cleanupRegionsForItem(this.itemDocument, {
        reason: "item-config-disabled"
      });
    }

    debug("Rebuilt item zone definition for base type.", {
      itemUuid: this.itemDocument.uuid,
      itemName: this.itemDocument.name,
      previousBaseType,
      nextBaseType,
      detectedTemplateType: selectionContext.templateTypeContext.detectedTemplateType,
      effectiveTemplateType: selectionContext.templateTypeContext.effectiveTemplateType,
      compatibleBaseTypes: selectionContext.compatibleBaseTypes,
      selectedBaseType: selectionContext.selectedBaseType,
      selectedBaseTypeCompatible: selectionContext.selectedBaseTypeCompatible,
      compatibleVariants: selectionContext.compatibleVariants,
      selectedVariant: selectionContext.selectedVariant,
      selectedVariantCompatible: selectionContext.selectedVariantCompatible,
      enabled: formState.enabled,
      removedLegacyFields
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
    const rawFormState = readAuthoringFormState(
      html[0],
      this._draftState ?? deriveAuthoringStateFromDefinition(getZoneDefinitionFromItem(this.itemDocument), this.itemDocument),
      this.itemDocument
    );
    this._draftState = resolveAuthoringSelectionContext(rawFormState, this.itemDocument).state;
    await this.render(false);
  }

  async #onBaseTypeChanged(html, event) {
    const rawFormState = readAuthoringFormState(
      html[0],
      this._draftState ?? deriveAuthoringStateFromDefinition(getZoneDefinitionFromItem(this.itemDocument), this.itemDocument),
      this.itemDocument
    );
    const selectionContext = resolveAuthoringSelectionContext(rawFormState, this.itemDocument);
    this._draftState = selectionContext.state;

    if (["baseType", "selectedVariant"].includes(event?.currentTarget?.name ?? "")) {
      const templateTypeContext = resolveAuthoringTemplateTypeContext(this._draftState, this.itemDocument);
      debug("Resolved persistent-zones authoring compatibility context.", {
        itemUuid: this.itemDocument.uuid,
        itemName: this.itemDocument.name,
        templateTypeSource: templateTypeContext.templateTypeSource,
        detectedTemplateTypeRaw: templateTypeContext.detectedTemplateTypeRaw,
        detectedTemplateTypeMapped: templateTypeContext.detectedTemplateType,
        detectedTemplateSource: templateTypeContext.detectedTemplateSource,
        activityId: templateTypeContext.detectedActivityId,
        effectiveTemplateType: templateTypeContext.effectiveTemplateType,
        compatibleBaseTypes: selectionContext.compatibleBaseTypes,
        selectedBaseType: selectionContext.selectedBaseType,
        selectedBaseTypeCompatible: selectionContext.selectedBaseTypeCompatible,
        compatibleVariants: selectionContext.compatibleVariants,
        selectedVariant: selectionContext.selectedVariant,
        selectedVariantCompatible: selectionContext.selectedVariantCompatible,
        templateTypeOverrideApplied: templateTypeContext.templateTypeOverrideApplied,
        warningReason: templateTypeContext.warningReason,
        multiplePossibleSources: templateTypeContext.multipleSources,
        candidateCount: templateTypeContext.candidateCount
      });
    }

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
  const selectionContext = resolveAuthoringSelectionContext(formState, item);
  const templateTypeContext = selectionContext.templateTypeContext;
  const previewTemplateDocument = buildPreviewTemplateDocument(selectionContext.state, item);

  try {
    const normalizedDefinition = normalizeZoneDefinition(definition, {
      item,
      actor: item?.actor ?? null,
      templateDocument: previewTemplateDocument
    });
    const normalizedReasons = Array.isArray(normalizedDefinition?.validation?.reasons)
      ? normalizedDefinition.validation.reasons
      : [];
    const compatibilityIssues = collectActivityCompatibilityValidationIssues(selectionContext.state, item);
    const templateTypeWarnings = Array.from(templateTypeContext.warnings ?? []);
    const selectionWarnings = Array.from(selectionContext.warnings ?? []);

    return {
      previewTemplateType: previewTemplateDocument?.t ?? null,
      previewTemplateTypeLabel: previewTemplateDocument?.t
        ? localizeTemplateType(previewTemplateDocument.t)
        : null,
      templateTypeContext,
      rawDefinition: definition,
      rawDefinitionJson: JSON.stringify(definition, null, 2),
      normalizedDefinition,
      normalizedDefinitionJson: JSON.stringify(normalizedDefinition, null, 2),
      isValid: Boolean(normalizedDefinition?.validation?.isValid) && compatibilityIssues.length === 0,
        reasons: [
            ...normalizedReasons,
            ...compatibilityIssues
          ],
        warnings: [
          ...templateTypeWarnings,
          ...selectionWarnings
        ],
        variantResolution: normalizedDefinition?.variantResolution ?? null
      };
    } catch (caughtError) {
    return {
      previewTemplateType: previewTemplateDocument?.t ?? null,
      previewTemplateTypeLabel: previewTemplateDocument?.t
        ? localizeTemplateType(previewTemplateDocument.t)
        : null,
      templateTypeContext,
      rawDefinition: definition,
      rawDefinitionJson: JSON.stringify(definition, null, 2),
        normalizedDefinition: null,
        normalizedDefinitionJson: "",
        isValid: false,
        reasons: [caughtError?.message ?? "Unknown preview error."],
      warnings: [
        ...Array.from(templateTypeContext.warnings ?? []),
        ...Array.from(selectionContext.warnings ?? [])
      ],
        variantResolution: null
      };
    }
  }

function readAuthoringFormState(root, seedState = null, item = null) {
  const form = root?.querySelector?.("form") ?? root;
  const existingState = normalizeAuthoringFormState(
    seedState ?? getDefaultAuthoringState(item),
    {
      item,
      enforceTemplateCompatibility: true
    }
  );

  return normalizeAuthoringFormState({
    ...duplicateData(existingState),
    enabled: readCheckbox(form, "enabled"),
    baseType: readValue(form, "baseType"),
    templateTypeSource: readValue(form, "templateTypeSource"),
    simpleTemplateType: readValue(form, "simpleTemplateType"),
    selectedVariant: readValue(form, "selectedVariant"),
    triggerConfigs: readTriggerAuthoringFormState(form, existingState.triggerConfigs),
    wallThickness: readOptionalValue(form, "wallThickness", existingState.wallThickness),
    sideThickness: readOptionalValue(form, "sideThickness", existingState.sideThickness),
    partConfigs: readPartAuthoringFormState(form, existingState.partConfigs)
  }, {
    item,
    enforceTemplateCompatibility: true
  });
}

function normalizeAuthoringFormState(formData = {}, {
  item = null,
  enforceTemplateCompatibility = false
} = {}) {
  const baseType = normalizeBaseType(formData.baseType);
  const templateTypeSource = normalizeTemplateTypeSource(formData.templateTypeSource);
  const simpleTemplateType = normalizeSimpleTemplateType(formData.simpleTemplateType);
  const selectedVariant = normalizeVariantSelection(baseType, formData.selectedVariant);
  const defaultState = getDefaultAuthoringState();

  const normalizedState = {
    enabled: coerceBoolean(formData.enabled, true) ?? true,
    baseType,
    templateTypeSource,
    simpleTemplateType,
    selectedVariant,
    triggerConfigs: normalizeAuthoringTriggerConfigs(
      isPlainObject(formData.triggerConfigs)
        ? formData.triggerConfigs
        : {
            onEnter: formData,
            onStartTurn: safeGet(formData, ["onStartTurn"]),
            onEndTurn: safeGet(formData, ["onEndTurn"])
          },
      defaultState.triggerConfigs
    ),
    wallThickness: clampWallThickness(
      formData.wallThickness,
      getDefaultWallThicknessForBaseType(baseType)
    ),
    sideThickness: clampSideThickness(
      formData.sideThickness,
      getDefaultSideThicknessForBaseType(baseType)
    ),
    partConfigs: normalizeAuthoringPartConfigs(formData.partConfigs)
  };

  if (!enforceTemplateCompatibility || !item) {
    return normalizedState;
  }

  return resolveAuthoringSelectionContext(normalizedState, item).state;
}

function getDefaultAuthoringState(item = null) {
  const detectedTemplateType = inferItemTemplateType(item) ?? DEFAULT_SIMPLE_TEMPLATE_TYPE;
  return {
    enabled: true,
    baseType: "simple",
    templateTypeSource: DEFAULT_TEMPLATE_TYPE_SOURCE,
    simpleTemplateType: detectedTemplateType,
    selectedVariant: DEFAULT_VARIANT_BY_BASE_TYPE["composite-line"],
    triggerConfigs: buildDefaultAuthoringTriggerConfigs(),
    wallThickness: getDefaultWallThicknessForBaseType("simple"),
    sideThickness: getDefaultSideThicknessForBaseType("simple"),
    partConfigs: buildDefaultPartAuthoringConfigs()
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
  const rootTriggerConfigs = isCompositeBaseType(baseType)
    ? buildDefaultAuthoringTriggerConfigs()
    : buildAuthoringTriggerConfigsFromDefinition(normalizedDefinition?.triggers ?? {});
  const templateTypeContext = resolveTemplateTypeContext(
    {
      templateTypeSource: DEFAULT_TEMPLATE_TYPE_SOURCE,
      manualTemplateType: pickFirstDefined(
        safeGet(effectiveDefinition, ["template", "type"]),
        normalizedDefinition?.template?.overrideType,
        normalizedDefinition?.template?.type,
        fallbackState.simpleTemplateType
      )
    },
    item
  );

  return {
    enabled: coerceBoolean(rawDefinition.enabled, true) ?? true,
    baseType,
    templateTypeSource: DEFAULT_TEMPLATE_TYPE_SOURCE,
    simpleTemplateType: templateTypeContext.effectiveTemplateType,
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
    triggerConfigs: normalizeAuthoringTriggerConfigs(
      rootTriggerConfigs,
      fallbackState.triggerConfigs
    ),
    wallThickness: deriveAuthoringWallThickness(effectiveDefinition, normalizedDefinition, baseType),
    sideThickness: deriveCompositeSideThickness(effectiveDefinition, normalizedDefinition, baseType),
    partConfigs: buildAuthoringPartConfigsFromDefinition(rawDefinition, normalizedDefinition)
  };
}

function deriveBaseTypeFromDefinition(rawDefinition, item = null) {
  if (!isPlainObject(rawDefinition)) {
    return null;
  }

  try {
    const effectiveDefinition = resolveEffectiveAuthoringDefinition(rawDefinition);
    const previewTemplateDocument = buildPreviewTemplateDocumentFromDefinition(
      rawDefinition,
      effectiveDefinition,
      item
    );
    const normalizedDefinition = normalizeZoneDefinition(rawDefinition, {
      item,
      actor: item?.actor ?? null,
      templateDocument: previewTemplateDocument
    });

    return detectAuthoringBaseType(effectiveDefinition, normalizedDefinition);
  } catch (_caughtError) {
    return detectAuthoringBaseType(resolveEffectiveAuthoringDefinition(rawDefinition), null);
  }
}

function collectRemovedLegacyDefinitionFields(previousDefinition, nextDefinition) {
  if (!isPlainObject(previousDefinition)) {
    return [];
  }

  const trackedPaths = [
    "variants",
    "selectedVariant",
    "defaultVariant",
    "variant",
    "variantId",
    "defaultVariantId",
    "parts",
    "zones",
    "geometry",
    "template.width",
    "template.angle",
    "template.direction"
  ];

  return trackedPaths.filter((path) => {
    const previousValue = safeGet(previousDefinition, path);
    const nextValue = safeGet(nextDefinition, path);
    return previousValue !== undefined && nextValue === undefined;
  });
}

function getDefaultTriggerAuthoringConfig(overrides = {}) {
  return {
    mode: DEFAULT_ON_ENTER_MODE,
    damageFormula: "2d6",
    damageType: DEFAULT_DAMAGE_TYPE,
    saveAbility: "",
    saveDcMode: DEFAULT_SAVE_DC_MODE,
    saveDc: DEFAULT_SAVE_DC,
    stepMode: getDefaultOnMoveStepMode(),
    cellStep: 1,
    movementMode: "any",
    distanceStep: getDefaultOnMoveDistanceStep(),
    stopMovementOnTrigger: false,
    activityId: "",
    ...(duplicateData(overrides) ?? {})
  };
}

function buildDefaultAuthoringTriggerConfigs(overridesByTiming = {}) {
  return AUTHORING_TRIGGER_TIMINGS.reduce((configs, timing) => {
    configs[timing] = getDefaultTriggerAuthoringConfig(overridesByTiming?.[timing] ?? {});
    return configs;
  }, {});
}

function getDefaultPartAuthoringConfig(partId = null) {
  return {
    partId,
    triggerConfigs: buildDefaultAuthoringTriggerConfigs()
  };
}

function buildDefaultPartAuthoringConfigs() {
  return AUTHORING_PART_IDS.reduce((configs, partId) => {
    configs[partId] = getDefaultPartAuthoringConfig(partId);
    return configs;
  }, {});
}

function normalizeAuthoringTriggerConfig(triggerLike = {}, fallbackState = {}) {
  const fallback = {
    ...getDefaultTriggerAuthoringConfig(),
    ...duplicateData(fallbackState ?? {})
  };
  const definition = isPlainObject(triggerLike) ? triggerLike : {};
  const explicitEnabled = coerceBoolean(
    pickFirstDefined(definition.enabled, definition.active),
    null
  );
  const activityId = normalizeAuthoringActivityId(
    extractActivityIdFromTriggerConfig(definition) ?? fallback.activityId
  );
  const saveAbility = normalizeAbilityId(
    pickFirstDefined(
      definition.saveAbility,
      safeGet(definition, ["save", "ability"]),
      safeGet(definition, ["save", "abilityId"]),
      fallback.saveAbility
    )
  );
  const saveDcMode = normalizeSaveDcMode(
    pickFirstDefined(
      definition.saveDcMode,
      safeGet(definition, ["save", "dcMode"]),
      safeGet(definition, ["save", "dcSource"]) ? "auto" : null,
      fallback.saveDcMode
    )
  );
  const explicitStepMode = normalizeOnMoveStepMode(
    pickFirstDefined(
      definition.stepMode,
      definition.moveStepMode,
      null
    ),
    null
  );
  const hasExplicitCellStep = pickFirstDefined(
    definition.cellStep,
    definition.stepCells,
    definition.gridCellStep,
    definition.cellCount
  ) !== undefined;
  const hasExplicitDistanceStep = pickFirstDefined(
    definition.distanceStep,
    definition.stepDistance,
    definition.distanceEvery
  ) !== undefined;
  const movementMode = normalizeAuthoringMovementMode(
    pickFirstDefined(
      definition.movementMode,
      fallback.movementMode
    )
  );
  const stepMode = explicitStepMode ??
    (hasExplicitCellStep
      ? "grid-cell"
      : hasExplicitDistanceStep
        ? "distance"
        : normalizeOnMoveStepMode(fallback.stepMode, getDefaultOnMoveStepMode()));

  return {
    mode: normalizeTriggerEffectMode(
      pickFirstDefined(
        definition.onEnterMode,
        definition.mode,
        explicitEnabled === false ? "none" : null,
        activityId ? "activity" : null,
        hasSimpleTriggerConfiguration(definition) ? "simple" : null,
        fallback.mode
      ),
      fallback.mode
    ),
    damageFormula: String(
      pickFirstDefined(
        definition.damageFormula,
        safeGet(definition, ["damage", "formula"]),
        safeGet(definition, ["damage", "roll"]),
        fallback.damageFormula,
        ""
      )
    ).trim(),
    damageType: normalizeDamageType(
      pickFirstDefined(
        definition.damageType,
        safeGet(definition, ["damage", "type"]),
        fallback.damageType
      )
    ),
    saveAbility,
    saveDcMode,
    saveDc: Math.max(
      coerceNumber(
        pickFirstDefined(
          definition.saveDc,
          safeGet(definition, ["save", "dc"]),
          fallback.saveDc
        ),
        DEFAULT_SAVE_DC
      ),
      1
    ),
    stepMode,
    cellStep: clampMoveCellStep(
      pickFirstDefined(
        definition.cellStep,
        definition.stepCells,
        definition.gridCellStep,
        definition.cellCount,
        fallback.cellStep
      ),
      fallback.cellStep
    ),
    movementMode,
    distanceStep: clampTriggerDistanceStep(
      pickFirstDefined(
        definition.distanceStep,
        definition.stepDistance,
        definition.distanceEvery,
        fallback.distanceStep
      ),
      fallback.distanceStep
    ),
    stopMovementOnTrigger: coerceBoolean(
      pickFirstDefined(
        definition.stopMovementOnTrigger,
        definition.stopOnTrigger,
        fallback.stopMovementOnTrigger
      ),
      fallback.stopMovementOnTrigger
    ),
    activityId
  };
}

function normalizeAuthoringTriggerConfigs(triggerConfigs = {}, fallbackConfigs = {}) {
  const fallback = buildDefaultAuthoringTriggerConfigs(fallbackConfigs);
  const sourceConfigs = isPlainObject(triggerConfigs) ? triggerConfigs : {};

  return AUTHORING_TRIGGER_TIMINGS.reduce((configs, timing) => {
    configs[timing] = normalizeAuthoringTriggerConfig(
      sourceConfigs?.[timing] ?? {},
      fallback?.[timing] ?? getDefaultTriggerAuthoringConfig()
    );
    return configs;
  }, {});
}

function buildAuthoringTriggerConfigsFromDefinition(triggerDefinitions = {}) {
  return normalizeAuthoringTriggerConfigs(
    isPlainObject(triggerDefinitions) ? triggerDefinitions : {},
    buildDefaultAuthoringTriggerConfigs()
  );
}

function normalizeAuthoringPartConfigs(partConfigs = {}) {
  return AUTHORING_PART_IDS.reduce((configs, partId) => {
    const partLike = partConfigs?.[partId] ?? {};
    const fallbackPartConfig = getDefaultPartAuthoringConfig(partId);
    configs[partId] = {
      partId,
      triggerConfigs: normalizeAuthoringTriggerConfigs(
        isPlainObject(partLike?.triggerConfigs)
          ? partLike.triggerConfigs
          : {
              onEnter: partLike
            },
        fallbackPartConfig.triggerConfigs
      )
    };
    return configs;
  }, {});
}

function buildAuthoringPartConfigsFromDefinition(rawDefinition, normalizedDefinition) {
  const partConfigs = buildDefaultPartAuthoringConfigs();
  const applyPartConfig = (partId, triggerConfigs) => {
    if (!partId || !(partId in partConfigs)) {
      return;
    }

    partConfigs[partId] = {
      ...partConfigs[partId],
      triggerConfigs: normalizeAuthoringTriggerConfigs(
        triggerConfigs,
        partConfigs[partId]?.triggerConfigs
      )
    };
  };

  for (const part of Array.from(rawDefinition?.parts ?? rawDefinition?.zones ?? [])) {
    applyPartConfig(part?.id ?? part?.key ?? null, part?.triggers ?? {});
  }

  for (const variant of Array.from(rawDefinition?.variants ?? [])) {
    for (const part of Array.from(variant?.parts ?? variant?.zones ?? [])) {
      applyPartConfig(part?.id ?? part?.key ?? null, part?.triggers ?? {});
    }
  }

  for (const part of Array.from(normalizedDefinition?.parts ?? [])) {
    applyPartConfig(part?.id ?? null, part?.triggers ?? {});
  }

  return partConfigs;
}

function getTriggerFieldName(fieldKey, timing, {
  partId = null
} = {}) {
  const fieldBaseName = getTriggerFieldBaseName(fieldKey, timing);
  if (!partId) {
    return fieldBaseName;
  }

  return `part${capitalizeFirst(fieldBaseName)}__${partId}`;
}

function getTriggerFieldBaseName(fieldKey, timing) {
  const normalizedTiming = normalizeAuthoringTriggerTiming(timing);
  const timingPrefix = normalizedTiming === "onEnter" ? "" : normalizedTiming;

  switch (fieldKey) {
    case "mode":
      return normalizedTiming === "onEnter" ? "onEnterMode" : `${timingPrefix}Mode`;
    case "damageFormula":
      return normalizedTiming === "onEnter" ? "damageFormula" : `${timingPrefix}DamageFormula`;
    case "damageType":
      return normalizedTiming === "onEnter" ? "damageType" : `${timingPrefix}DamageType`;
    case "saveAbility":
      return normalizedTiming === "onEnter" ? "saveAbility" : `${timingPrefix}SaveAbility`;
    case "saveDcMode":
      return normalizedTiming === "onEnter" ? "saveDcMode" : `${timingPrefix}SaveDcMode`;
    case "saveDc":
      return normalizedTiming === "onEnter" ? "saveDc" : `${timingPrefix}SaveDc`;
    case "stepMode":
      return normalizedTiming === "onEnter" ? "stepMode" : `${timingPrefix}StepMode`;
    case "cellStep":
      return normalizedTiming === "onEnter" ? "cellStep" : `${timingPrefix}CellStep`;
    case "distanceStep":
      return normalizedTiming === "onEnter" ? "distanceStep" : `${timingPrefix}DistanceStep`;
    case "activityId":
      return normalizedTiming === "onEnter" ? "activityId" : `${timingPrefix}ActivityId`;
    default:
      return normalizedTiming === "onEnter" ? fieldKey : `${timingPrefix}${capitalizeFirst(fieldKey)}`;
  }
}

function getTriggerTimingLabel(timing) {
  switch (normalizeAuthoringTriggerTiming(timing)) {
    case "onExit":
      return localize("PERSISTENT_ZONES.UI.Sections.OnExit", "On Exit");
    case "onMove":
      return localize("PERSISTENT_ZONES.UI.Sections.OnMove", "On Move");
    case "onStartTurn":
      return localize("PERSISTENT_ZONES.UI.Sections.OnStartTurn", "On Start Turn");
    case "onEndTurn":
      return localize("PERSISTENT_ZONES.UI.Sections.OnEndTurn", "On End Turn");
    case "onEnter":
    default:
      return localize("PERSISTENT_ZONES.UI.Sections.OnEnter", "On Enter");
  }
}

function normalizeAuthoringTriggerTiming(value) {
  switch (String(value ?? "").trim()) {
    case "onExit":
      return "onExit";
    case "onMove":
      return "onMove";
    case "onStartTurn":
      return "onStartTurn";
    case "onEndTurn":
      return "onEndTurn";
    case "onEnter":
    default:
      return "onEnter";
  }
}

function capitalizeFirst(value) {
  const normalized = String(value ?? "");
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : normalized;
}

function readTriggerAuthoringFormState(form, existingTriggerConfigs = {}, {
  partId = null
} = {}) {
  const triggerConfigs = normalizeAuthoringTriggerConfigs(existingTriggerConfigs);

  for (const timing of AUTHORING_TRIGGER_TIMINGS) {
    const existingConfig = triggerConfigs[timing] ?? getDefaultTriggerAuthoringConfig();

    triggerConfigs[timing] = {
      mode: readOptionalValue(form, getTriggerFieldName("mode", timing, { partId }), existingConfig.mode),
      damageFormula: readOptionalValue(form, getTriggerFieldName("damageFormula", timing, { partId }), existingConfig.damageFormula),
      damageType: readOptionalValue(form, getTriggerFieldName("damageType", timing, { partId }), existingConfig.damageType),
      saveAbility: readOptionalValue(form, getTriggerFieldName("saveAbility", timing, { partId }), existingConfig.saveAbility),
      saveDcMode: readOptionalValue(form, getTriggerFieldName("saveDcMode", timing, { partId }), existingConfig.saveDcMode),
      saveDc: readOptionalValue(form, getTriggerFieldName("saveDc", timing, { partId }), existingConfig.saveDc),
      stepMode: readOptionalValue(form, getTriggerFieldName("stepMode", timing, { partId }), existingConfig.stepMode),
      cellStep: readOptionalValue(form, getTriggerFieldName("cellStep", timing, { partId }), existingConfig.cellStep),
      distanceStep: readOptionalValue(form, getTriggerFieldName("distanceStep", timing, { partId }), existingConfig.distanceStep),
      movementMode: existingConfig.movementMode,
      stopMovementOnTrigger: existingConfig.stopMovementOnTrigger,
      activityId: readOptionalValue(form, getTriggerFieldName("activityId", timing, { partId }), existingConfig.activityId)
    };
  }

  return triggerConfigs;
}

function readPartAuthoringFormState(form, existingPartConfigs = {}) {
  const partConfigs = normalizeAuthoringPartConfigs(existingPartConfigs);

  for (const partId of AUTHORING_PART_IDS) {
    const existingConfig = partConfigs[partId] ?? getDefaultPartAuthoringConfig(partId);

    partConfigs[partId] = {
      partId,
      triggerConfigs: readTriggerAuthoringFormState(
        form,
        existingConfig.triggerConfigs,
        { partId }
      )
    };
  }

  return partConfigs;
}

function buildDefinitionFromAuthoringState(formState, {
  item = null
} = {}) {
  const state = normalizeAuthoringFormState(formState, {
    item,
    enforceTemplateCompatibility: true
  });
  const templateTypeContext = resolveAuthoringTemplateTypeContext(state, item);
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
        triggers: buildConfiguredRootTriggers(state.triggerConfigs),
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
            typeSource: templateTypeContext.templateTypeSource,
            ...(templateTypeContext.templateTypeSource === "manual"
              ? {
                  type: templateTypeContext.manualTemplateType
                }
              : {})
          },
          triggers: buildConfiguredRootTriggers(state.triggerConfigs)
        };
    }
  }

function buildConfiguredRootTriggers(triggerConfigs = {}) {
  const configuredTriggers = buildDisabledTriggers();

  for (const timing of AUTHORING_TRIGGER_TIMINGS) {
    configuredTriggers[timing] = buildConfiguredTriggerDefinition(
      triggerConfigs?.[timing] ?? {},
      timing
    );
  }

  return configuredTriggers;
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

function buildConfiguredTriggerDefinition(triggerConfig = {}, timing = "onEnter") {
  const config = normalizeAuthoringTriggerConfig(triggerConfig);
  const normalizedTiming = normalizeAuthoringTriggerTiming(timing);
  const mode = normalizeTriggerEffectMode(config.mode, DEFAULT_ON_ENTER_MODE);
  const damageFormula = String(config.damageFormula ?? "").trim();
  const saveAbility = normalizeAbilityId(config.saveAbility);
  const saveDcMode = normalizeSaveDcMode(config.saveDcMode);
  const activityId = normalizeAuthoringActivityId(config.activityId);
  const movementMode = normalizeAuthoringMovementMode(config.movementMode);
  const stepMode = normalizedTiming === "onMove"
    ? normalizeOnMoveStepMode(config.stepMode, getDefaultOnMoveStepMode())
    : null;
  const cellStep = normalizedTiming === "onMove" && mode !== "none" && stepMode === "grid-cell"
    ? clampMoveCellStep(config.cellStep, 1)
    : null;
  const distanceStep = normalizedTiming === "onMove" && mode !== "none" && stepMode === "distance"
    ? clampTriggerDistanceStep(config.distanceStep, getDefaultOnMoveDistanceStep())
    : null;
  const saveDc = saveAbility && saveDcMode === "manual"
    ? Math.max(coerceNumber(config.saveDc, DEFAULT_SAVE_DC), 1)
    : null;

  return {
    enabled: mode !== "none",
    mode,
    stepMode,
    cellStep,
    movementMode,
    distanceStep,
    stopMovementOnTrigger: normalizedTiming === "onMove"
      ? false
      : coerceBoolean(config.stopMovementOnTrigger, false),
    damage: {
      enabled: mode === "simple" && Boolean(damageFormula),
      formula: damageFormula || null,
      type: normalizeDamageType(config.damageType)
    },
    save: {
      enabled: mode === "simple" && Boolean(saveAbility),
      ability: saveAbility || null,
      dcMode: saveDcMode,
      dcSource: saveAbility && saveDcMode === "auto" ? DEFAULT_SAVE_DC_SOURCE : null,
      dc: saveDc,
      onSuccess: "half"
    },
    activity: {
      id: mode === "activity" ? activityId || null : null
    }
  };
}

function buildCompositeLineVariantDefinition(side, state) {
  const normalizedSide = normalizeLineVariantSide(side);
  const wallBodyConfig = state.partConfigs?.["wall-body"] ?? getDefaultPartAuthoringConfig("wall-body");
  const heatedSideConfig =
    state.partConfigs?.[`heated-side-${normalizedSide}`] ??
    getDefaultPartAuthoringConfig(`heated-side-${normalizedSide}`);

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
        },
        triggers: buildConfiguredRootTriggers(wallBodyConfig.triggerConfigs)
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
        triggers: buildConfiguredRootTriggers(heatedSideConfig.triggerConfigs)
      }
    ]
  };
}

function buildCompositeRingVariantDefinition(side, state) {
  const normalizedSide = normalizeRingVariantSide(side);
  const wallBodyConfig = state.partConfigs?.["wall-body"] ?? getDefaultPartAuthoringConfig("wall-body");
  const heatedSideConfig =
    state.partConfigs?.[`heated-side-${normalizedSide}`] ??
    getDefaultPartAuthoringConfig(`heated-side-${normalizedSide}`);

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
        },
        triggers: buildConfiguredRootTriggers(wallBodyConfig.triggerConfigs)
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
        triggers: buildConfiguredRootTriggers(heatedSideConfig.triggerConfigs)
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

function buildPreviewTemplateDocument(formState, item = null) {
  const normalizedState = normalizeAuthoringFormState(formState, {
    item,
    enforceTemplateCompatibility: true
  });
  switch (normalizedState.baseType) {
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
          width: normalizedState.wallThickness,
          direction: 0,
          elevation: 0
        };

    case "simple":
    default: {
      const templateType = resolveAuthoringTemplateTypeContext(normalizedState, item).effectiveTemplateType;
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

  const templateTypeSource = normalizeTemplateTypeSource(
    pickFirstDefined(
      safeGet(effectiveDefinition, ["template", "typeSource"]),
      safeGet(rawDefinition, ["template", "typeSource"]),
      safeGet(effectiveDefinition, ["template", "type"]) !== undefined ? "manual" : null,
      DEFAULT_TEMPLATE_TYPE_SOURCE
    )
  );
  const inferredTemplateType = resolveTemplateTypeContext(
    {
      templateTypeSource,
      manualTemplateType: pickFirstDefined(
        safeGet(effectiveDefinition, ["template", "type"]),
        DEFAULT_SIMPLE_TEMPLATE_TYPE
      )
    },
    item
  ).effectiveTemplateType;

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
  const detectedTemplateType = resolveItemTemplateTypeDetection(item).templateType;
  return detectedTemplateType
    ? normalizeSimpleTemplateType(detectedTemplateType)
    : null;
}

function buildChoiceOptions(choices, selectedValue) {
  return Array.from(choices ?? []).map((choice) => ({
    ...choice,
    value: choice.value,
    label: choice.label,
    disabled: Boolean(choice.disabled),
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

function getCompatibleBaseTypeChoices(templateType) {
  const normalizedTemplateType = normalizeTemplateTypeValueForAuthoring(templateType);
  const allowedBaseTypes = getCompatibleBaseTypesForTemplateType(normalizedTemplateType);
  const choices = getBaseTypeChoices();

  if (!allowedBaseTypes.length) {
    return choices;
  }

  return choices.filter((choice) => allowedBaseTypes.includes(choice.value));
}

function getCompatibleBaseTypesForTemplateType(templateType) {
  switch (normalizeTemplateTypeValueForAuthoring(templateType)) {
    case "circle":
      return ["simple", "ring", "composite-ring"];
    case "ray":
      return ["simple", "composite-line"];
    case "cone":
    case "rect":
      return ["simple"];
    default:
      return getBaseTypeChoices().map((choice) => choice.value);
  }
}

function getTemplateTypeSourceChoices() {
  return [
    {
      value: "auto",
      label: localize("PERSISTENT_ZONES.UI.TemplateTypeSources.Auto", "Auto")
    },
    {
      value: "manual",
      label: localize("PERSISTENT_ZONES.UI.TemplateTypeSources.Manual", "Manual")
    }
  ];
}

function getSimpleTemplateChoices() {
  return SUPPORTED_TEMPLATE_TYPES.map((templateType) => ({
    value: templateType,
    label: localizeTemplateType(templateType)
  }));
}

function resolveTemplateTypeContext(
  {
    templateTypeSource = DEFAULT_TEMPLATE_TYPE_SOURCE,
    manualTemplateType = DEFAULT_SIMPLE_TEMPLATE_TYPE
  } = {},
  item = null
) {
  const normalizedSource = normalizeTemplateTypeSource(templateTypeSource);
  const normalizedManualTemplateType = normalizeSimpleTemplateType(manualTemplateType);
  const detectedTemplateInfo = resolveItemTemplateTypeDetection(item);
  const detectedTemplateType = normalizeTemplateTypeValueForAuthoring(detectedTemplateInfo.templateType);
  const effectiveTemplateType = normalizeSimpleTemplateType(
    normalizedSource === "manual"
      ? normalizedManualTemplateType
      : detectedTemplateType ?? DEFAULT_SIMPLE_TEMPLATE_TYPE
  );
  const warnings = [];

  if (normalizedSource === "auto" && !detectedTemplateType) {
    warnings.push(
      `${localize(
        "PERSISTENT_ZONES.UI.TemplateTypeWarnings.AutoNotDetected",
        "No dnd5e template type could be detected automatically for this Item."
      )} ${localize(
        "PERSISTENT_ZONES.UI.TemplateTypeWarnings.AutoFallback",
        "Preview is using a safe fallback."
      )}`
    );
  }

  if (normalizedSource === "auto" && detectedTemplateInfo.ambiguous) {
    warnings.push(
      `${localize(
        "PERSISTENT_ZONES.UI.TemplateTypeWarnings.AutoAmbiguous",
        "Multiple dnd5e template types were detected on this Item."
      )} ${localize(
        "PERSISTENT_ZONES.UI.TemplateTypeWarnings.AutoUsingDetected",
        "Auto mode is using the first detected type."
      )}`
    );
  }

  if (
    normalizedSource === "manual" &&
    detectedTemplateType &&
    normalizedManualTemplateType !== detectedTemplateType
  ) {
    warnings.push(
      `${localize(
        "PERSISTENT_ZONES.UI.TemplateTypeWarnings.ManualMismatch",
        "The manual template type override differs from the detected dnd5e template type."
      )}`
    );
  }

  return {
    templateTypeSource: normalizedSource,
    templateTypeSourceLabel: getTemplateTypeSourceLabel(normalizedSource),
    detectedTemplateTypeRaw: detectedTemplateInfo.templateTypeRaw ?? null,
    detectedTemplateType,
    detectedTemplateTypeLabel: detectedTemplateType ? localizeTemplateType(detectedTemplateType) : null,
    detectedTemplateSource: detectedTemplateInfo.sourcePath ?? null,
    detectedTemplateSourceLabel: getDetectedTemplateSourceLabel(detectedTemplateInfo),
    detectedActivityId: detectedTemplateInfo.activityId ?? null,
    effectiveTemplateType,
    effectiveTemplateTypeLabel: localizeTemplateType(effectiveTemplateType),
    manualTemplateType: normalizedManualTemplateType,
    manualTemplateTypeLabel: localizeTemplateType(normalizedManualTemplateType),
    detectionFound: Boolean(detectedTemplateType),
    templateTypeOverrideApplied: normalizedSource === "manual",
    warningReason: warnings[0] ?? null,
    warnings,
    multipleSources: Boolean(detectedTemplateInfo.multipleSources),
    candidateCount: detectedTemplateInfo.candidateCount ?? 0
  };
}

function resolveAuthoringTemplateTypeContext(formState, item = null) {
  const normalizedState = normalizeAuthoringFormState(formState);
  return resolveTemplateTypeContext(
    {
      templateTypeSource: DEFAULT_TEMPLATE_TYPE_SOURCE,
      manualTemplateType: normalizedState.simpleTemplateType
    },
    item
  );
}

function resolveAuthoringSelectionContext(formState, item = null) {
  const normalizedState = normalizeAuthoringFormState(formState);
  const templateTypeContext = resolveTemplateTypeContext(
    {
      templateTypeSource: DEFAULT_TEMPLATE_TYPE_SOURCE,
      manualTemplateType: normalizedState.simpleTemplateType
    },
    item
  );
  const compatibleBaseTypeChoices = getCompatibleBaseTypeChoices(
    templateTypeContext.effectiveTemplateType
  );
  const compatibleBaseTypes = compatibleBaseTypeChoices.map((choice) => choice.value);
  const selectedBaseType = normalizeBaseType(normalizedState.baseType);
  const selectedBaseTypeCompatible = compatibleBaseTypes.includes(selectedBaseType);
  const effectiveBaseType = selectedBaseTypeCompatible
    ? selectedBaseType
    : (compatibleBaseTypes[0] ?? "simple");
  const variantChoices = getVariantChoicesForBaseType(effectiveBaseType);
  const compatibleVariants = variantChoices.map((choice) => choice.value);
  const selectedVariant = String(normalizedState.selectedVariant ?? "").trim().toLowerCase();
  const selectedVariantCompatible = !variantChoices.length || compatibleVariants.includes(selectedVariant);
  const effectiveSelectedVariant = normalizeVariantSelection(
    effectiveBaseType,
    selectedVariant
  );
  const warnings = [];

  if (!selectedBaseTypeCompatible) {
    warnings.push(
      localize(
        "PERSISTENT_ZONES.UI.Compatibility.BaseTypeFiltered",
        "The currently stored base type is incompatible with the effective template type, so the UI is using a compatible fallback."
      )
    );
  }

  if (!selectedVariantCompatible && variantChoices.length) {
    warnings.push(
      localize(
        "PERSISTENT_ZONES.UI.Compatibility.VariantFiltered",
        "The currently stored variant is incompatible with the effective base type, so the UI is using a compatible fallback."
      )
    );
  }

  return {
    state: {
      ...normalizedState,
      templateTypeSource: DEFAULT_TEMPLATE_TYPE_SOURCE,
      simpleTemplateType: templateTypeContext.effectiveTemplateType,
      baseType: effectiveBaseType,
      selectedVariant: effectiveSelectedVariant
    },
    templateTypeContext,
    compatibleBaseTypeChoices,
    compatibleBaseTypes,
    compatibleBaseTypeLabels: compatibleBaseTypeChoices.map((choice) => choice.label).join(", "),
    selectedBaseType,
    selectedBaseTypeCompatible,
    effectiveBaseType,
    variantChoices,
    compatibleVariants,
    compatibleVariantLabels: variantChoices.map((choice) => choice.label).join(", "),
    selectedVariant,
    selectedVariantCompatible,
    effectiveSelectedVariant,
    selectedVariantLabel: getSelectedChoiceLabel(variantChoices, effectiveSelectedVariant),
    baseTypeWarningReason: !selectedBaseTypeCompatible ? warnings[0] ?? null : null,
    variantWarningReason:
      !selectedVariantCompatible && variantChoices.length
        ? warnings[warnings.length - 1] ?? null
        : null,
    warningReason: warnings[0] ?? null,
    warnings
  };
}

function getTemplateTypeSourceLabel(source) {
  return normalizeTemplateTypeSource(source) === "manual"
    ? localize("PERSISTENT_ZONES.UI.TemplateTypeSources.Manual", "Manual")
    : localize("PERSISTENT_ZONES.UI.TemplateTypeSources.Auto", "Auto");
}

function getDetectedTemplateSourceLabel(detectedTemplateInfo = {}) {
  if (!detectedTemplateInfo?.templateType) {
    return localize(
      "PERSISTENT_ZONES.UI.TemplateTypeWarnings.NoDetectedSource",
      "No dnd5e template source detected."
    );
  }

  if (detectedTemplateInfo.sourceKind === "activity") {
    return `${localize(
      "PERSISTENT_ZONES.UI.TemplateTypeSources.DetectedFromActivity",
      "Detected from activity"
    )}: ${detectedTemplateInfo.sourceLabel ?? detectedTemplateInfo.activityId ?? "?"}`;
  }

  if (detectedTemplateInfo.sourceKind === "item-target") {
    return localize(
      "PERSISTENT_ZONES.UI.TemplateTypeSources.DetectedFromItemTarget",
      "Detected from Item target template"
    );
  }

  if (detectedTemplateInfo.sourceKind === "item-template") {
    return localize(
      "PERSISTENT_ZONES.UI.TemplateTypeSources.DetectedFromItemTemplate",
      "Detected from Item template"
    );
  }

  return detectedTemplateInfo.sourceLabel ?? detectedTemplateInfo.sourcePath ?? "";
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

function buildTriggerEditorSections(triggerConfigs, item, {
  partId = null
} = {}) {
  const normalizedConfigs = normalizeAuthoringTriggerConfigs(triggerConfigs);

  return AUTHORING_TRIGGER_TIMINGS.map((timing) => {
    const triggerState = normalizedConfigs[timing] ?? getDefaultTriggerAuthoringConfig();
    const activityField = buildZoneTriggerActivityFieldContext(item, triggerState.activityId);

    return {
      timing,
      label: getTriggerTimingLabel(timing),
      state: triggerState,
      modeFieldName: getTriggerFieldName("mode", timing, { partId }),
      damageFormulaFieldName: getTriggerFieldName("damageFormula", timing, { partId }),
      damageTypeFieldName: getTriggerFieldName("damageType", timing, { partId }),
      saveAbilityFieldName: getTriggerFieldName("saveAbility", timing, { partId }),
      saveDcModeFieldName: getTriggerFieldName("saveDcMode", timing, { partId }),
      saveDcFieldName: getTriggerFieldName("saveDc", timing, { partId }),
      stepModeFieldName: getTriggerFieldName("stepMode", timing, { partId }),
      cellStepFieldName: getTriggerFieldName("cellStep", timing, { partId }),
      distanceStepFieldName: getTriggerFieldName("distanceStep", timing, { partId }),
      activityFieldName: getTriggerFieldName("activityId", timing, { partId }),
      modeOptions: buildChoiceOptions(getTriggerModeChoices(), triggerState.mode),
      stepModeOptions: buildChoiceOptions(getOnMoveStepModeChoices(), triggerState.stepMode),
      damageTypeOptions: buildChoiceOptions(getDamageTypeChoices(), triggerState.damageType),
      saveDcModeOptions: buildChoiceOptions(getSaveDcModeChoices(), triggerState.saveDcMode),
      abilityOptions: buildChoiceOptions(
        [
          {
            value: "",
            label: localize("PERSISTENT_ZONES.UI.NoneOption", "None")
          },
          ...getAbilityChoices()
        ],
        triggerState.saveAbility
      ),
      activityField,
      showSimpleFields: triggerState.mode === "simple",
      showActivityField: triggerState.mode === "activity",
      showStepMode: timing === "onMove" && triggerState.mode !== "none",
      showCellStep:
        timing === "onMove" &&
        triggerState.mode !== "none" &&
        triggerState.stepMode === "grid-cell",
      showDistanceStep:
        timing === "onMove" &&
        triggerState.mode !== "none" &&
        triggerState.stepMode === "distance",
      showSaveDcMode: triggerState.mode === "simple" && Boolean(triggerState.saveAbility),
      showManualSaveDc:
        triggerState.mode === "simple" &&
        Boolean(triggerState.saveAbility) &&
        triggerState.saveDcMode === "manual"
    };
  });
}

function buildCompositePartSections(formState, item) {
  const normalizedPartConfigs = normalizeAuthoringPartConfigs(formState.partConfigs);
  const effectivePartIds = getEffectivePartIdsForBaseType(
    formState.baseType,
    formState.selectedVariant
  );

  return effectivePartIds.map((partId) => {
    const partConfig = normalizedPartConfigs?.[partId] ??
      getDefaultPartAuthoringConfig(partId);

    return {
      id: partId,
      label: getEffectiveAuthoringPartLabel(partId, formState.baseType, formState.selectedVariant),
      triggerSections: buildTriggerEditorSections(partConfig.triggerConfigs, item, {
        partId
      })
    };
  });
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

function getOnMoveStepModeChoices() {
  return [
    {
      value: "grid-cell",
      label: localize("PERSISTENT_ZONES.UI.OnMoveStepModes.GridCell", "By Cell")
    },
    {
      value: "distance",
      label: localize("PERSISTENT_ZONES.UI.OnMoveStepModes.Distance", "By Distance")
    }
  ];
}

function getTriggerModeChoices() {
  return [
    {
      value: "none",
      label: localize("PERSISTENT_ZONES.UI.OnEnterModes.None", "None")
    },
    {
      value: "simple",
      label: localize("PERSISTENT_ZONES.UI.OnEnterModes.Simple", "Simple")
    },
    {
      value: "activity",
      label: localize("PERSISTENT_ZONES.UI.OnEnterModes.Activity", "Activity")
    }
  ];
}

function getItemZoneTriggerActivities(item) {
  return Array.from(item?.system?.activities ?? [])
    .map((entry) => Array.isArray(entry) ? entry[1] : entry)
    .filter(Boolean)
    .map((activity) => {
      const value = String(activity?.id ?? "").trim();
      const label = String(activity?.name ?? activity?.id ?? "").trim();
      const compatibility = resolveZoneTriggeredActivityCompatibility(activity);

      return {
        value,
        label,
        compatibility,
        compatibilityReasonLabel: localizeActivityCompatibilityReason(compatibility)
      };
    })
    .filter((choice) => choice.value && choice.label)
    .sort((left, right) => left.label.localeCompare(right.label, game.i18n?.lang ?? "en"));
}

function buildZoneTriggerActivityFieldContext(item, selectedActivityId = "") {
  const normalizedSelectedActivityId = normalizeAuthoringActivityId(selectedActivityId);
  const allActivities = getItemZoneTriggerActivities(item);
  const compatibleActivities = allActivities.filter((activity) => activity.compatibility?.supported);
  const selectedActivity = allActivities.find((activity) => activity.value === normalizedSelectedActivityId) ?? null;
  const options = [
    {
      value: "",
      label: localize("PERSISTENT_ZONES.UI.NoneOption", "None")
    }
  ];

  if (selectedActivity && !selectedActivity.compatibility?.supported) {
    options.push({
      value: selectedActivity.value,
      label: `${selectedActivity.label} - ${localize(
        "PERSISTENT_ZONES.UI.ActivityCompatibility.CurrentIncompatibleSelection",
        "Current incompatible selection"
      )}`
    });
  }

  options.push(...compatibleActivities.map((activity) => ({
    value: activity.value,
    label: activity.label
  })));

  return {
    options: buildChoiceOptions(options, normalizedSelectedActivityId),
    selectedActivityCompatible:
      normalizedSelectedActivityId
        ? Boolean(selectedActivity?.compatibility?.supported)
        : null,
    selectedActivityLabel: selectedActivity?.label ?? null,
    selectedActivityMessage: resolveSelectedZoneTriggerActivityMessage(
      normalizedSelectedActivityId,
      selectedActivity
    ),
    selectedActivityStatusLabel: resolveSelectedZoneTriggerActivityStatusLabel(
      normalizedSelectedActivityId,
      selectedActivity
    ),
    hasCompatibleActivities: compatibleActivities.length > 0,
    noCompatibleActivitiesMessage:
      compatibleActivities.length > 0
        ? null
        : localize(
          "PERSISTENT_ZONES.UI.ActivityCompatibility.NoCompatibleActivities",
          "No compatible zone-trigger activities were found on this Item."
        ),
    helpText: [
      localize(
        "PERSISTENT_ZONES.UI.ActivityCompatibility.OnlyCompatibleListed",
        "Only zone-trigger compatible activities are listed in this selector."
      ),
      buildSupportedZoneTriggerActivityTypesText()
    ].filter(Boolean).join(" "),
    activityCompatibility: selectedActivity?.compatibility ?? null,
    allActivities,
    compatibleActivities
  };
}

function collectActivityCompatibilityValidationIssues(formState, item) {
  const issues = [];
  const normalizedState = normalizeAuthoringFormState(formState);

  if (!isCompositeBaseType(normalizedState.baseType)) {
    for (const timing of AUTHORING_TRIGGER_TIMINGS) {
      const triggerConfig = normalizedState.triggerConfigs?.[timing] ?? {};
      if (triggerConfig.mode !== "activity") {
        continue;
      }

      const issue = buildZoneTriggerActivityValidationIssue(
        item,
        triggerConfig.activityId,
        getTriggerTimingLabel(timing)
      );
      if (issue) {
        issues.push(issue);
      }
    }

    return issues;
  }

  for (const partId of getEffectivePartIdsForBaseType(
    normalizedState.baseType,
    normalizedState.selectedVariant
  )) {
    const partState = normalizeAuthoringPartConfigs(normalizedState.partConfigs)?.[partId] ??
      getDefaultPartAuthoringConfig(partId)

    for (const timing of AUTHORING_TRIGGER_TIMINGS) {
      const triggerConfig = partState.triggerConfigs?.[timing] ?? {};
      if (triggerConfig.mode !== "activity") {
        continue;
      }

      const issue = buildZoneTriggerActivityValidationIssue(
        item,
        triggerConfig.activityId,
        `${getEffectiveAuthoringPartLabel(partId, normalizedState.baseType, normalizedState.selectedVariant)} - ${getTriggerTimingLabel(timing)}`
      );
      if (issue) {
        issues.push(issue);
      }
    }
  }

  return issues;
}

function buildZoneTriggerActivityValidationIssue(item, activityId, contextLabel) {
  const normalizedActivityId = normalizeAuthoringActivityId(activityId);
  if (!normalizedActivityId) {
    return null;
  }

  const selectedActivity = getItemZoneTriggerActivities(item)
    .find((activity) => activity.value === normalizedActivityId) ?? null;

  if (!selectedActivity) {
    return `${contextLabel}: ${localize(
      "PERSISTENT_ZONES.UI.ActivityCompatibility.SelectedMissing",
      "The selected activity could not be found on this Item."
    )}`;
  }

  if (selectedActivity.compatibility?.supported) {
    return null;
  }

  return `${contextLabel}: ${localize(
    "PERSISTENT_ZONES.UI.ActivityCompatibility.SelectedIncompatible",
    "The selected activity is incompatible with zone-trigger mode."
  )} ${selectedActivity.label} (${selectedActivity.compatibilityReasonLabel})`;
}

function resolveSelectedZoneTriggerActivityMessage(selectedActivityId, selectedActivity) {
  if (!selectedActivityId) {
    return null;
  }

  if (!selectedActivity) {
    return localize(
      "PERSISTENT_ZONES.UI.ActivityCompatibility.SelectedMissing",
      "The selected activity could not be found on this Item."
    );
  }

  if (selectedActivity.compatibility?.supported) {
    return null;
  }

  return [
    localize(
      "PERSISTENT_ZONES.UI.ActivityCompatibility.SelectedIncompatible",
      "The selected activity is incompatible with zone-trigger mode."
    ),
    selectedActivity.compatibilityReasonLabel
  ].filter(Boolean).join(" ");
}

function resolveSelectedZoneTriggerActivityStatusLabel(selectedActivityId, selectedActivity) {
  if (!selectedActivityId) {
    return null;
  }

  if (!selectedActivity || !selectedActivity.compatibility?.supported) {
    return localize(
      "PERSISTENT_ZONES.UI.ActivityCompatibility.Incompatible",
      "Incompatible"
    );
  }

  return localize(
    "PERSISTENT_ZONES.UI.ActivityCompatibility.Compatible",
    "Compatible zone-trigger"
  );
}

function localizeActivityCompatibilityReason(compatibility = {}) {
  const primaryReason = Array.isArray(compatibility?.reasonCodes)
    ? compatibility.reasonCodes[0]
    : null;

  switch (primaryReason?.code) {
    case "unsupported-type":
      return `${localize(
        "PERSISTENT_ZONES.UI.ActivityCompatibility.UnsupportedType",
        "Unsupported activity type"
      )}: ${formatActivityTypeLabel(primaryReason?.activityType)}`;

    case "missing-damage-parts":
      return localize(
        "PERSISTENT_ZONES.UI.ActivityCompatibility.MissingDamageParts",
        "The activity has no damage parts."
      );

    case "missing-save-ability":
      return localize(
        "PERSISTENT_ZONES.UI.ActivityCompatibility.MissingSaveAbility",
        "The activity has no target save ability."
      );

    case "missing-save-dc":
      return localize(
        "PERSISTENT_ZONES.UI.ActivityCompatibility.MissingSaveDc",
        "The activity has no resolved save DC."
      );

    default:
      return compatibility?.reasonsText || localize(
        "PERSISTENT_ZONES.UI.ActivityCompatibility.Incompatible",
        "Incompatible"
      );
  }
}

function buildSupportedZoneTriggerActivityTypesText() {
  const typeLabels = ZONE_TRIGGER_SUPPORTED_ACTIVITY_TYPES.map((type) => formatActivityTypeLabel(type));
  const supportedTypesLabel = localize(
    "PERSISTENT_ZONES.UI.ActivityCompatibility.SupportedTypes",
    "Supported types"
  );

  return `${supportedTypesLabel}: ${typeLabels.join(", ")}.`;
}

function formatActivityTypeLabel(activityType) {
  switch (String(activityType ?? "").trim().toLowerCase()) {
    case "damage":
      return localize(
        "PERSISTENT_ZONES.UI.ActivityTypes.Damage",
        "Damage"
      );

    case "save":
      return localize(
        "PERSISTENT_ZONES.UI.ActivityTypes.Save",
        "Save"
      );

    default:
      return String(activityType ?? "unknown").trim() || localize(
        "PERSISTENT_ZONES.UI.ActivityTypes.Unknown",
        "Unknown"
      );
  }
}

function getPartIdsForBaseType(baseType) {
  switch (normalizeBaseType(baseType)) {
    case "composite-line":
      return ["wall-body", "heated-side-left", "heated-side-right"];
    case "composite-ring":
      return ["wall-body", "heated-side-inner", "heated-side-outer"];
    default:
      return [];
  }
}

function getEffectivePartIdsForBaseType(baseType, selectedVariant) {
  const normalizedBaseType = normalizeBaseType(baseType);
  const normalizedVariant = normalizeVariantSelection(normalizedBaseType, selectedVariant);

  switch (normalizedBaseType) {
    case "composite-line":
      return normalizedVariant === "line-right"
        ? ["wall-body", "heated-side-right"]
        : ["wall-body", "heated-side-left"];
    case "composite-ring":
      return normalizedVariant === "ring-outer"
        ? ["wall-body", "heated-side-outer"]
        : ["wall-body", "heated-side-inner"];
    default:
      return getPartIdsForBaseType(normalizedBaseType);
  }
}

function getAuthoringPartLabel(partId) {
  switch (String(partId ?? "").toLowerCase()) {
    case "heated-side-left":
      return localize("PERSISTENT_ZONES.UI.Parts.HeatedSideLeft", "Heated Side Left");
    case "heated-side-right":
      return localize("PERSISTENT_ZONES.UI.Parts.HeatedSideRight", "Heated Side Right");
    case "heated-side-inner":
      return localize("PERSISTENT_ZONES.UI.Parts.HeatedSideInner", "Heated Side Inner");
    case "heated-side-outer":
      return localize("PERSISTENT_ZONES.UI.Parts.HeatedSideOuter", "Heated Side Outer");
    case "wall-body":
    default:
      return localize("PERSISTENT_ZONES.UI.Parts.WallBody", "Wall Body");
  }
}

function getEffectiveAuthoringPartLabel(partId, baseType, selectedVariant) {
  const normalizedPartId = String(partId ?? "").toLowerCase();

  if (normalizedPartId === "wall-body") {
    return getAuthoringPartLabel(partId);
  }

  if (normalizeBaseType(baseType) === "composite-line") {
    return String(selectedVariant ?? "").toLowerCase() === "line-right"
      ? localize("PERSISTENT_ZONES.UI.Parts.HeatedZoneRight", "Heated Zone (Right)")
      : localize("PERSISTENT_ZONES.UI.Parts.HeatedZoneLeft", "Heated Zone (Left)");
  }

  if (normalizeBaseType(baseType) === "composite-ring") {
    return String(selectedVariant ?? "").toLowerCase() === "ring-outer"
      ? localize("PERSISTENT_ZONES.UI.Parts.HeatedZoneOuter", "Heated Zone (Outer)")
      : localize("PERSISTENT_ZONES.UI.Parts.HeatedZoneInner", "Heated Zone (Inner)");
  }

  return getAuthoringPartLabel(partId);
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

function getSelectedChoiceLabel(choices, selectedValue) {
  const choice = Array.from(choices ?? [])
    .find((candidate) => String(candidate?.value ?? "") === String(selectedValue ?? ""));
  return choice?.label ?? null;
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

function isCompositeBaseType(baseType) {
  return ["composite-line", "composite-ring"].includes(normalizeBaseType(baseType));
}

function normalizeBaseType(value) {
  const normalized = String(value ?? "simple").trim().toLowerCase();
  return ["simple", "ring", "composite-line", "composite-ring"].includes(normalized)
    ? normalized
    : "simple";
}

function normalizeTemplateTypeSource(value) {
  return String(value ?? DEFAULT_TEMPLATE_TYPE_SOURCE).trim().toLowerCase() === "manual"
    ? "manual"
    : "auto";
}

function normalizeTemplateTypeValueForAuthoring(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SUPPORTED_TEMPLATE_TYPES.includes(normalized) ? normalized : null;
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

function normalizeTriggerEffectMode(value, fallback = DEFAULT_ON_ENTER_MODE) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["none", "simple", "activity"].includes(normalized)) {
    return normalized;
  }

  return fallback;
}

function normalizeOnMoveStepMode(value, fallback = "distance") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["grid-cell", "distance"].includes(normalized)) {
    return normalized;
  }

  return fallback;
}

function normalizeAuthoringMovementMode(value) {
  const normalized = String(value ?? "any").trim().toLowerCase();
  return ["any", "voluntary", "forced"].includes(normalized) ? normalized : "any";
}

function normalizeAuthoringActivityId(value) {
  return String(value ?? "").trim();
}

function clampMoveCellStep(value, fallback = 1) {
  return Math.max(Math.round(coerceLocalizedNumber(value, fallback)), 1);
}

function clampTriggerDistanceStep(value, fallback = DEFAULT_MOVE_DISTANCE_STEP) {
  return Math.max(coerceLocalizedNumber(value, fallback), MIN_THICKNESS);
}

function extractActivityIdFromTriggerConfig(triggerLike = {}) {
  return normalizeAuthoringActivityId(
    pickFirstDefined(
      triggerLike.activityId,
      safeGet(triggerLike, ["activity", "id"]),
      typeof triggerLike.activity === "string" ? triggerLike.activity : null
    )
  ) || "";
}

function hasSimpleTriggerConfiguration(triggerLike = {}) {
  return Boolean(
    String(
      pickFirstDefined(
        triggerLike.damageFormula,
        safeGet(triggerLike, ["damage", "formula"]),
        safeGet(triggerLike, ["damage", "roll"]),
        ""
      )
    ).trim()
  ) ||
    coerceNumber(
      pickFirstDefined(
        safeGet(triggerLike, ["damage", "amount"]),
        null
      ),
      null
    ) !== null ||
    Boolean(
      normalizeAbilityId(
        pickFirstDefined(
          triggerLike.saveAbility,
          safeGet(triggerLike, ["save", "ability"]),
          safeGet(triggerLike, ["save", "abilityId"]),
          ""
        )
      )
    ) ||
    coerceBoolean(pickFirstDefined(triggerLike.enabled, triggerLike.active), false);
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

function isGridMoveStepModeAvailable(scene = canvas?.scene ?? null) {
  const grid = canvas?.grid ?? null;
  return Boolean(
    grid &&
    !grid.isGridless &&
    grid.isSquare &&
    coerceNumber(scene?.grid?.size, coerceNumber(grid?.size, 0)) > 0
  );
}

function getDefaultOnMoveStepMode(scene = canvas?.scene ?? null) {
  return isGridMoveStepModeAvailable(scene) ? "grid-cell" : "distance";
}

function getDefaultOnMoveDistanceStep(scene = canvas?.scene ?? null) {
  const normalizedUnits = String(scene?.grid?.units ?? canvas?.scene?.grid?.units ?? "")
    .trim()
    .toLowerCase();

  if (normalizedUnits === "ft" || normalizedUnits.includes("foot") || normalizedUnits.includes("feet") || normalizedUnits.includes("pied")) {
    return 5;
  }

  if (normalizedUnits === "m" || normalizedUnits.includes("meter") || normalizedUnits.includes("metre") || normalizedUnits.includes("mètre")) {
    return 1.5;
  }

  const sceneDistance = coerceLocalizedNumber(scene?.grid?.distance, null);
  return sceneDistance && sceneDistance > 0 ? sceneDistance : DEFAULT_MOVE_DISTANCE_STEP;
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
  const fields = Array.from(form?.querySelectorAll?.(`[name="${name}"]`) ?? []);
  if (!fields.length) {
    return "";
  }

  if (fields.some((field) => field?.type === "radio")) {
    return fields.find((field) => field?.checked)?.value ?? "";
  }

  return fields[0]?.value ?? "";
}

function readOptionalValue(form, name, fallback = "") {
  const fields = Array.from(form?.querySelectorAll?.(`[name="${name}"]`) ?? []);
  if (!fields.length) {
    return fallback;
  }

  if (fields.some((field) => field?.type === "radio")) {
    return fields.find((field) => field?.checked)?.value ?? fallback;
  }

  return fields[0]?.value ?? fallback;
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
