import { ACTIVITY_DEFINITION_FIELD_KEY, MODULE_ID } from "../constants.mjs";
import { normalizeStatusRecovery } from "../runtime/status-recovery.mjs";

export class PersistentZoneActivitySheet extends dnd5e.applications.activity.ActivitySheet {
  static DEFAULT_OPTIONS = {
    classes: ["dnd5e2", "sheet", "activity-sheet", MODULE_ID, "persistent-zone-activity-sheet"],
    position: {
      width: 560,
      height: "auto"
    }
  };

  static PARTS = {
    ...super.PARTS,
    persistentZone: {
      template: `modules/${MODULE_ID}/templates/persistent-zone-activity-tab.hbs`,
      scrollable: [""]
    }
  };

  tabGroups = {
    sheet: "persistentZone",
    activation: "time"
  };

  #persistentZoneViewportState = null;

  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if (partId === "persistentZone") {
      return this._preparePersistentZoneContext(context);
    }
    return context;
  }

  _getTabs() {
    const tabs = super._getTabs();
    tabs.persistentZone = {
      id: "persistentZone",
      group: "sheet",
      icon: "fa-solid fa-location-dot",
      label: "PERSISTENT_ZONES.Activity.Tabs.PersistentZone",
      active: this.tabGroups.sheet === "persistentZone",
      cssClass: this.tabGroups.sheet === "persistentZone" ? "active" : ""
    };
    return tabs;
  }

  _preparePersistentZoneContext(context) {
    context.tab = context.tabs.persistentZone;
    const config = this.activity?.[ACTIVITY_DEFINITION_FIELD_KEY] ?? {};
    context.persistentZone = normalizePersistentZoneActivitySubmitData(duplicateData(config));
    context.persistentZoneChoices = buildActivityChoices();
    context.persistentZoneTriggerRows = buildTriggerRows(context.persistentZone?.triggers ?? {}, this.activity);
    context.persistentZoneDamageTypes = buildDamageTypeOptions(config?.damage?.type);
    context.persistentZoneAbilities = buildAbilityOptions(config?.save?.ability);
    context.persistentZoneTemplateUnits = buildTemplateUnitOptions(context.source?.target?.template?.units);
    context.persistentZoneWallPresets = buildLinkedWallPresetOptions(context.persistentZone.linkedWalls?.preset);
    context.persistentZoneLightPresets = buildLinkedLightPresetOptions(context.persistentZone.linkedLights?.preset);
    context.persistentZoneStatusOptions = buildStatusOptions();
    context.persistentZoneLinkedActivityOptions = buildLinkedActivityOptions(this.activity);
    return context;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.querySelectorAll?.(".persistent-zone-activity")?.forEach((root) => {
      updateConditionalVisibility(root);
      root.addEventListener("change", (event) => {
        this.#persistentZoneViewportState = capturePersistentZoneViewportState(root, event);
        updateConditionalVisibility(root);
      });
      root.addEventListener("input", (event) => {
        this.#persistentZoneViewportState = capturePersistentZoneViewportState(root, event);
        updateConditionalVisibility(root);
      });
    });
    restorePersistentZoneViewportState(this.element, this.#persistentZoneViewportState);
  }

  _prepareSubmitData(event, formData) {
    const root = event?.target?.closest?.(".persistent-zone-activity") ??
      this.element?.querySelector?.(".persistent-zone-activity") ??
      null;
    if (root) {
      this.#persistentZoneViewportState = capturePersistentZoneViewportState(root, event);
    }
    return super._prepareSubmitData(event, formData);
  }

  async _processSubmitData(event, submitData) {
    mergeExistingRecoveryConfiguration(
      submitData[ACTIVITY_DEFINITION_FIELD_KEY],
      this.activity?.[ACTIVITY_DEFINITION_FIELD_KEY]
    );
    const persistentZone = normalizePersistentZoneActivitySubmitData(
      submitData[ACTIVITY_DEFINITION_FIELD_KEY]
    );
    submitData[ACTIVITY_DEFINITION_FIELD_KEY] = persistentZone;

    const targetTemplate = buildTargetTemplateFromPersistentZoneConfig(persistentZone, this.activity);
    foundry.utils.setProperty(submitData, "target.override", true);
    foundry.utils.setProperty(submitData, "target.prompt", true);
    foundry.utils.setProperty(submitData, "target.template", targetTemplate);

    return super._processSubmitData(event, submitData);
  }
}

export function mergeExistingRecoveryConfiguration(submittedDefinition, existingDefinition) {
  if (!submittedDefinition || typeof submittedDefinition !== "object") return submittedDefinition;
  const triggerIds = ["enter", "move", "exit", "turnStart", "turnEnd"];
  for (const triggerId of triggerIds) {
    const submittedStatuses = submittedDefinition?.triggers?.[triggerId]?.simpleEffect?.statuses;
    if (!submittedStatuses || typeof submittedStatuses !== "object") continue;
    const existingRecovery = existingDefinition?.triggers?.[triggerId]?.simpleEffect?.statuses?.recovery ??
      existingDefinition?.triggers?.[triggerId]?.statuses?.recovery ??
      {};
    const submittedRecovery = submittedStatuses.recovery ?? {};
    submittedStatuses.recovery = {
      ...foundry.utils.deepClone(existingRecovery),
      ...submittedRecovery,
      potency: {
        ...foundry.utils.deepClone(existingRecovery?.potency ?? {}),
        ...(submittedRecovery?.potency ?? {})
      }
    };
  }
  return submittedDefinition;
}

export function normalizePersistentZoneActivitySubmitData(value) {
  const config = foundry.utils.deepClone(value ?? {});
  config.schemaVersion = Number(config.schemaVersion || 1);
  config.enabled = Boolean(config.enabled);
  config.geometry ??= {};
  config.damage ??= {};
  config.save ??= {};
  config.triggers = normalizeActivityTriggers(config.triggers ?? {}, {
    globalDamage: config.damage,
    globalSave: config.save
  });
  config.movement ??= {};
  config.terrain ??= {};
  config.terrain.enabled = Boolean(config.terrain.enabled);
  config.terrain.multiplier = config.terrain.multiplier ?? 2;
  config.linkedWalls ??= {};
  config.linkedWalls.geometry = String(config.linkedWalls.geometry ?? "centerline");
  config.linkedLights ??= {};
  config.linkedLights.color ||= "#ffd88a";
  config.lifecycle ??= {};
  return config;
}

function normalizeActivityTriggers(triggers = {}, { globalDamage = {}, globalSave = {} } = {}) {
  return {
    enter: normalizeActivityTrigger(triggers.enter ?? triggers.onEnter, "enter", { globalDamage, globalSave, enabledDefault: true }),
    move: normalizeActivityTrigger(triggers.move ?? triggers.onMove, "move", { globalDamage, globalSave }),
    exit: normalizeActivityTrigger(triggers.exit ?? triggers.onExit, "exit", { globalDamage, globalSave }),
    turnStart: normalizeActivityTrigger(triggers.turnStart ?? triggers.onStartTurn, "turnStart", { globalDamage, globalSave }),
    turnEnd: normalizeActivityTrigger(triggers.turnEnd ?? triggers.onEndTurn, "turnEnd", { globalDamage, globalSave })
  };
}

function normalizeActivityTrigger(trigger = {}, triggerId, {
  globalDamage = {},
  globalSave = {},
  enabledDefault = false
} = {}) {
  const mode = normalizeUiTriggerMode(trigger.mode, trigger.enabled ? "simple-effect" : "none");
  const simpleEffect = trigger.simpleEffect ?? {};
  const damage = simpleEffect.damage ?? trigger.damage ?? globalDamage ?? {};
  const healing = simpleEffect.healing ?? trigger.healing ?? {};
  const temporaryHitPoints = simpleEffect.temporaryHitPoints ?? trigger.temporaryHitPoints ?? {};
  const save = simpleEffect.save ?? trigger.save ?? globalSave ?? {};
  const statuses = simpleEffect.statuses ?? trigger.statuses ?? {};
  const linkedActivity = trigger.linkedActivity ?? trigger.activity ?? {};

  return {
    enabled: trigger.enabled ?? enabledDefault,
    mode,
    simpleEffect: {
      damage: {
        enabled: Boolean(damage.enabled),
        formula: String(damage.formula ?? "1d6"),
        type: String(damage.type ?? "fire")
      },
      healing: {
        enabled: Boolean(healing.enabled),
        formula: String(healing.formula ?? "1d6")
      },
      temporaryHitPoints: {
        enabled: Boolean(temporaryHitPoints.enabled),
        formula: String(temporaryHitPoints.formula ?? "1d6")
      },
      save: {
        enabled: Boolean(save.enabled),
        ability: String(save.ability ?? "dex"),
        dcMode: String(save.dcMode ?? "auto"),
        dc: save.dc ?? 13,
        onSave: String(save.onSave ?? "half")
      },
      statuses: {
        enabled: Boolean(statuses.enabled),
        statusId: String(statuses.statusId ?? ""),
        persistenceMode: triggerId === "exit"
          ? "persistent"
          : String(statuses.persistenceMode ?? "persistent"),
        recovery: normalizeUiStatusRecovery(statuses.recovery)
      }
    },
    linkedActivity: {
      id: String(linkedActivity.id ?? linkedActivity.activityId ?? ""),
      uuid: String(linkedActivity.uuid ?? linkedActivity.activityUuid ?? "")
    }
  };
}

function normalizeUiTriggerMode(value, fallback = "none") {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === "simple" || normalized === "simple-effect") {
    return "simple-effect";
  }
  if (normalized === "activity" || normalized === "linked-activity") {
    return "linked-activity";
  }
  return "none";
}

function normalizeUiStatusRecovery(value) {
  const source = foundry.utils.deepClone(value ?? {});
  const normalized = normalizeStatusRecovery(source);
  return {
    ...source,
    ...normalized,
    removeOnSuccess: normalized.mode === "save-end-turn"
      ? true
      : normalized.removeOnSuccess,
    provider: normalized.provider ?? "auto",
    potency: {
      ...(source.potency ?? {}),
      ...(normalized.potency ?? {})
    }
  };
}

function buildTargetTemplateFromPersistentZoneConfig(config, activity) {
  const geometry = config?.geometry ?? {};
  const geometryType = String(geometry.type ?? "circle").trim().toLowerCase();
  const existingTemplate = activity?._source?.target?.template ?? activity?.target?.template ?? {};
  const units = String(existingTemplate.units ?? "ft");

  if (geometryType === "wall") {
    return {
      ...existingTemplate,
      type: "wall",
      size: String(coercePositiveNumber(geometry.wallLength, 30)),
      width: String(coercePositiveNumber(geometry.wallThickness, 5)),
      units
    };
  }

  const radius = geometryType === "ring"
    ? coercePositiveNumber(geometry.ringReferenceRadius, coercePositiveNumber(geometry.radius, 10))
    : coercePositiveNumber(geometry.radius, 10);
  return {
    ...existingTemplate,
    type: "circle",
    size: String(radius),
    width: "",
    units
  };
}

function buildActivityChoices() {
  return {
    geometryTypes: [
      { value: "circle", label: "PERSISTENT_ZONES.Activity.Geometry.Circle" },
      { value: "ring", label: "PERSISTENT_ZONES.Activity.Geometry.Ring" },
      { value: "wall", label: "PERSISTENT_ZONES.Activity.Geometry.Wall" }
    ],
    triggerModes: [
      { value: "none", label: "PERSISTENT_ZONES.Activity.TriggerModes.None" },
      { value: "simple-effect", label: "PERSISTENT_ZONES.Activity.TriggerModes.Simple" },
      { value: "linked-activity", label: "PERSISTENT_ZONES.Activity.TriggerModes.LinkedActivity" }
    ],
    saveDcModes: [
      { value: "auto", label: "PERSISTENT_ZONES.UI.Fields.SaveDcModeAuto" },
      { value: "manual", label: "PERSISTENT_ZONES.UI.Fields.SaveDcModeManual" }
    ],
    saveResults: [
      { value: "half", label: "PERSISTENT_ZONES.Activity.SaveResults.Half" },
      { value: "none", label: "PERSISTENT_ZONES.Activity.SaveResults.None" }
    ],
    stopModes: [
      { value: "off", label: "PERSISTENT_ZONES.UI.MovementStopModes.Off" },
      { value: "on-enter", label: "PERSISTENT_ZONES.UI.MovementStopModes.OnEnter" },
      { value: "on-enter-and-move", label: "PERSISTENT_ZONES.UI.MovementStopModes.OnEnterAndMove" }
    ],
    movementModes: [
      { value: "any", label: "PERSISTENT_ZONES.UI.MovementModes.Any" },
      { value: "voluntary", label: "PERSISTENT_ZONES.UI.MovementModes.Voluntary" },
      { value: "forced", label: "PERSISTENT_ZONES.UI.MovementModes.Forced" }
    ],
    stepModes: [
      { value: "distance", label: "PERSISTENT_ZONES.UI.OnMoveStepModes.Distance" },
      { value: "grid-cell", label: "PERSISTENT_ZONES.UI.OnMoveStepModes.GridCell" }
    ],
    referenceRadiusModes: [
      { value: "outer-edge", label: "PERSISTENT_ZONES.Activity.ReferenceRadiusModes.OuterEdge" },
      { value: "centerline", label: "PERSISTENT_ZONES.Activity.ReferenceRadiusModes.Centerline" },
      { value: "inner-edge", label: "PERSISTENT_ZONES.Activity.ReferenceRadiusModes.InnerEdge" }
    ],
    statusRecoveryModes: [
      { value: "none", label: "PERSISTENT_ZONES.Activity.StatusRecovery.Modes.None" },
      { value: "save-end-turn", label: "PERSISTENT_ZONES.Activity.StatusRecovery.Modes.SaveEndTurn" }
    ],
    statusRecoveryDcModes: [
      { value: "inherit", label: "PERSISTENT_ZONES.Activity.StatusRecovery.DcModes.Inherit" },
      { value: "custom", label: "PERSISTENT_ZONES.Activity.StatusRecovery.DcModes.Custom" }
    ],
    linkedWallGeometries: [
      { value: "centerline", label: "PERSISTENT_ZONES.Activity.LinkedWallGeometry.Centerline" },
      { value: "perimeter", label: "PERSISTENT_ZONES.Activity.LinkedWallGeometry.Perimeter" }
    ],
    persistenceModes: [
      { value: "persistent", label: "PERSISTENT_ZONES.Activity.PersistenceModes.Persistent" },
      { value: "while-inside-region", label: "PERSISTENT_ZONES.Activity.PersistenceModes.WhileInsideRegion" }
    ],
    exitPersistenceModes: [
      { value: "persistent", label: "PERSISTENT_ZONES.Activity.PersistenceModes.Persistent" }
    ]
  };
}

function buildTriggerRows(triggers = {}, activity = null) {
  return [
    ["enter", "PERSISTENT_ZONES.Activity.Triggers.enter"],
    ["move", "PERSISTENT_ZONES.Activity.Triggers.move"],
    ["exit", "PERSISTENT_ZONES.Activity.Triggers.exit"],
    ["turnStart", "PERSISTENT_ZONES.Activity.Triggers.turnStart"],
    ["turnEnd", "PERSISTENT_ZONES.Activity.Triggers.turnEnd"]
  ].map(([timing, label]) => ({
    timing,
    label: localize(label),
    state: triggers?.[timing] ?? {},
    allowsWhileInside: timing !== "exit",
    linkedActivityOptions: buildLinkedActivityOptions(activity, triggers?.[timing]?.linkedActivity?.id)
  }));
}

function buildDamageTypeOptions(selectedType) {
  return Object.entries(CONFIG.DND5E?.damageTypes ?? {})
    .map(([value, config]) => ({
      value,
      label: game.i18n?.localize?.(config.label ?? config) ?? value,
      selected: value === selectedType
    }));
}

function buildAbilityOptions(selectedAbility) {
  return Object.entries(CONFIG.DND5E?.abilities ?? {})
    .map(([value, config]) => ({
      value,
      label: game.i18n?.localize?.(config.label ?? config) ?? value,
      selected: value === selectedAbility
    }));
}

function buildTemplateUnitOptions(selectedUnit) {
  return Object.entries(CONFIG.DND5E?.movementUnits ?? {})
    .map(([value, config]) => ({
      value,
      label: game.i18n?.localize?.(config.label ?? config) ?? value,
      selected: value === selectedUnit
    }));
}

function buildLinkedActivityOptions(activity, selectedId = null) {
  const item = activity?.item ?? activity?.parent ?? null;
  const currentId = String(activity?.id ?? "");
  const activities = item?.system?.activities?.values
    ? Array.from(item.system.activities.values())
    : Array.from(item?.system?.activities ?? [])
      .map((entry) => Array.isArray(entry) ? entry[1] : entry)
      .filter(Boolean);

  return [
    { value: "", label: "PERSISTENT_ZONES.Activity.LinkedActivity.None", selected: !selectedId },
    ...activities
      .filter((entry) => entry && String(entry.id ?? "") !== currentId)
      .map((entry) => ({
        value: entry.id,
        uuid: entry.uuid ?? "",
        label: entry.name ?? entry.id,
        selected: String(entry.id ?? "") === String(selectedId ?? "")
      }))
  ];
}

function buildLinkedWallPresetOptions(selectedPreset) {
  return ["solid", "terrain", "invisible", "ethereal"].map((preset) => ({
    value: preset,
    label: `PERSISTENT_ZONES.Activity.LinkedWallPresets.${preset}`,
    selected: preset === selectedPreset
  }));
}

function buildLinkedLightPresetOptions(selectedPreset) {
  return ["glow", "moonlight", "fire", "holy", "darkness"].map((preset) => ({
    value: preset,
    label: `PERSISTENT_ZONES.Activity.LinkedLightPresets.${preset}`,
    selected: preset === selectedPreset
  }));
}

function buildStatusOptions() {
  const statuses = CONFIG.statusEffects ?? [];
  return [
    { value: "", label: "PERSISTENT_ZONES.Activity.Statuses.None" },
    ...statuses.map((status) => ({
      value: status.id,
      label: game.i18n?.localize?.(status.name ?? status.label ?? status.id) ?? status.id
    }))
  ];
}

function updateConditionalVisibility(root) {
  const geometry = root.querySelector("[name='persistentZone.geometry.type']")?.value ?? "circle";
  root.querySelectorAll("[data-pz-geometry]").forEach((element) => {
    element.hidden = element.dataset.pzGeometry !== geometry;
  });

  root.querySelectorAll("[data-pz-trigger]").forEach((element) => {
    const triggerId = element.dataset.pzTrigger;
    const enabled = root.querySelector(`[name='persistentZone.triggers.${triggerId}.enabled']`)?.checked === true;
    const mode = root.querySelector(`[name='persistentZone.triggers.${triggerId}.mode']`)?.value ?? "none";
    element.querySelectorAll("[data-pz-trigger-details]").forEach((details) => {
      details.hidden = !enabled;
    });
    element.querySelectorAll("[data-pz-mode]").forEach((details) => {
      details.hidden = !enabled || mode === "none" || details.dataset.pzMode !== mode;
    });
  });

  root.querySelectorAll("[data-pz-toggle-source]").forEach((input) => {
    const target = root.querySelector(`[data-pz-toggle-target='${input.dataset.pzToggleSource}']`);
    if (target) {
      target.hidden = input.type === "checkbox" ? !input.checked : !input.value;
    }
  });

  root.querySelectorAll("select[name$='.linkedActivity.id']").forEach((select) => {
    const hiddenUuid = root.querySelector(`[name='${select.name.replace(/\.id$/, ".uuid")}']`);
    const selectedOption = select.selectedOptions?.[0] ?? null;
    if (hiddenUuid) {
      hiddenUuid.value = selectedOption?.dataset?.uuid ?? "";
    }
  });

  root.querySelectorAll("[data-pz-status-recovery]").forEach((section) => {
    const mode = section.querySelector("[data-pz-status-recovery-mode]")?.value ?? "none";
    const dcMode = section.querySelector("[data-pz-status-recovery-dc-mode]")?.value ?? "inherit";
    section.querySelectorAll("[data-pz-status-recovery-options]").forEach((options) => {
      options.hidden = mode !== "save-end-turn";
    });
    section.querySelectorAll("[data-pz-status-recovery-custom-dc]").forEach((customDC) => {
      customDC.hidden = mode !== "save-end-turn" || dcMode !== "custom";
    });
  });
}

function capturePersistentZoneViewportState(root, event = null) {
  if (!root) {
    return null;
  }

  const scrollContainer = findPersistentZoneScrollContainer(root);
  const activeElement = event?.target instanceof HTMLElement
    ? event.target
    : root.ownerDocument?.activeElement instanceof HTMLElement
      ? root.ownerDocument.activeElement
      : null;

  return {
    activeTab: root.closest("[data-tab]")?.dataset?.tab ?? "persistentZone",
    scrollTop: scrollContainer?.scrollTop ?? 0,
    focusedName: activeElement?.name ?? null,
    focusedValue: activeElement?.value ?? null,
    selectionStart: typeof activeElement?.selectionStart === "number" ? activeElement.selectionStart : null,
    selectionEnd: typeof activeElement?.selectionEnd === "number" ? activeElement.selectionEnd : null
  };
}

function restorePersistentZoneViewportState(element, state) {
  if (!element || !state) {
    return;
  }

  const restore = () => {
    const root = element.querySelector?.(".persistent-zone-activity");
    if (!root) {
      return;
    }

    const scrollContainer = findPersistentZoneScrollContainer(root);
    if (scrollContainer) {
      scrollContainer.scrollTop = state.scrollTop ?? 0;
    }

    if (state.focusedName) {
      const focused = root.querySelector(`[name='${CSS.escape(state.focusedName)}']`);
      if (focused instanceof HTMLElement) {
        focused.focus({ preventScroll: true });
        if (
          typeof focused.setSelectionRange === "function" &&
          state.selectionStart !== null &&
          state.selectionEnd !== null
        ) {
          focused.setSelectionRange(state.selectionStart, state.selectionEnd);
        }
      }
    }
  };

  restore();
  globalThis.requestAnimationFrame?.(restore);
}

function findPersistentZoneScrollContainer(root) {
  const candidates = [];
  let current = root;
  while (current) {
    candidates.push(current);
    if (current.classList?.contains("window-content")) {
      break;
    }
    current = current.parentElement;
  }

  return candidates.find((element) => element.scrollHeight > element.clientHeight && element.clientHeight > 0) ??
    root.closest(".window-content") ??
    root;
}

function coercePositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function localize(key) {
  return game.i18n?.localize?.(key) ?? key;
}

function duplicateData(value) {
  return foundry.utils.deepClone(value ?? {});
}
