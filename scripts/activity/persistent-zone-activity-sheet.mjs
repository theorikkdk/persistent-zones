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
  #pendingMultipartAction = null;
  #pendingMultipartFieldPatch = null;

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
    const rawParts = Array.isArray(config?.parts) ? foundry.utils.deepClone(config.parts) : [];
    context.persistentZoneMultipartEnabled = rawParts.length > 0;
    context.persistentZonePartRows = buildMultipartPartRows(rawParts, context.persistentZone?.geometry?.type);
    return context;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.querySelectorAll?.(".persistent-zone-activity")?.forEach((root) => {
      orderPersistentZoneActivitySections(root);
      updateConditionalVisibility(root);
      root.addEventListener("change", (event) => {
        this.#persistentZoneViewportState = capturePersistentZoneViewportState(root, event);
        this.#pendingMultipartFieldPatch = captureMultipartFieldPatch(event) ?? this.#pendingMultipartFieldPatch;
        updateConditionalVisibility(root);
      });
      root.addEventListener("input", (event) => {
        this.#persistentZoneViewportState = capturePersistentZoneViewportState(root, event);
        this.#pendingMultipartFieldPatch = captureMultipartFieldPatch(event) ?? this.#pendingMultipartFieldPatch;
        updateConditionalVisibility(root);
      });
      root.querySelectorAll("[data-pz-multipart-action]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          this.#pendingMultipartAction = {
            action: button.dataset.pzMultipartAction,
            partId: button.dataset.pzPartId ?? null
          };
          requestPersistentZoneFormSubmit(root, this);
        });
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
    const pendingMultipartAction = this.#pendingMultipartAction;
    const pendingMultipartFieldPatch = this.#pendingMultipartFieldPatch;
    this.#pendingMultipartAction = null;
    this.#pendingMultipartFieldPatch = null;
    await processMultipartEditorSubmit({
      submittedDefinition: submitData[ACTIVITY_DEFINITION_FIELD_KEY],
      existingDefinition: this.activity?.[ACTIVITY_DEFINITION_FIELD_KEY],
      pendingAction: pendingMultipartAction,
      pendingFieldPatch: pendingMultipartFieldPatch
    });
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

export function preserveExistingMultipartParts(submittedDefinition, existingDefinition) {
  if (!submittedDefinition || typeof submittedDefinition !== "object") return submittedDefinition;
  if (submittedDefinition.parts !== undefined) return submittedDefinition;
  if (!Array.isArray(existingDefinition?.parts)) return submittedDefinition;
  submittedDefinition.parts = foundry.utils.deepClone(existingDefinition.parts);
  return submittedDefinition;
}

async function processMultipartEditorSubmit({
  submittedDefinition,
  existingDefinition,
  pendingAction = null,
  pendingFieldPatch = null
} = {}) {
  if (!submittedDefinition || typeof submittedDefinition !== "object") return submittedDefinition;
  if (submittedDefinition.multipartEnabled === undefined) {
    return preserveExistingMultipartParts(submittedDefinition, existingDefinition);
  }

  const multipartEnabled = submittedDefinition.multipartEnabled === true ||
    submittedDefinition.multipartEnabled === "true" ||
    submittedDefinition.multipartEnabled === "on" ||
    submittedDefinition.multipartEnabled === 1;
  delete submittedDefinition.multipartEnabled;
  const existingParts = Array.isArray(existingDefinition?.parts)
    ? foundry.utils.deepClone(existingDefinition.parts)
    : [];
  const submittedParts = Array.isArray(submittedDefinition.parts) ? submittedDefinition.parts : [];
  let parts = patchMultipartPartsById(existingParts, submittedParts);

  if (!multipartEnabled) {
    if (!existingParts.length) {
      delete submittedDefinition.parts;
      return submittedDefinition;
    }
    const confirmed = await confirmPersistentZoneAction(
      "PERSISTENT_ZONES.Activity.Parts.DisableConfirmTitle",
      "PERSISTENT_ZONES.Activity.Parts.DisableConfirm"
    );
    if (confirmed) submittedDefinition.parts = [];
    else submittedDefinition.parts = existingParts;
    return submittedDefinition;
  }

  if (!parts.length) {
    parts = [buildInitialMultipartPart()];
  }

  if (pendingFieldPatch) {
    parts = patchMultipartFieldById(parts, pendingFieldPatch);
  }

  if (pendingAction?.action === "add") {
    parts.push(buildSecondaryMultipartPart(parts));
  } else if (pendingAction?.action === "remove") {
    parts = await removeMultipartPart(parts, pendingAction.partId);
  }

  validateMultipartParts(parts, existingParts, { mode: "editing" });
  submittedDefinition.parts = parts;
  return submittedDefinition;
}

function patchMultipartFieldById(parts, { partId = null, field = null, value = null } = {}) {
  const targetId = String(partId ?? "").trim();
  const patchedParts = foundry.utils.deepClone(Array.from(parts ?? []));
  const target = patchedParts.find((part) => String(part?.id ?? "") === targetId);
  if (!target) return patchedParts;
  if (field === "label") {
    target.label = String(value ?? "").trim();
  } else if (field === "role") {
    target.role = String(value ?? "").trim();
  } else if (field === "geometry.type") {
    target.geometry = target.geometry && typeof target.geometry === "object" && !Array.isArray(target.geometry)
      ? target.geometry
      : {};
    target.geometry.type = String(value ?? "").trim().toLowerCase();
    initializeDerivedMultipartGeometry(patchedParts, target);
  } else if (field === "geometry.referencePartId") {
    target.geometry.referencePartId = String(value ?? "").trim() || null;
  } else if (field === "geometry.side") {
    target.geometry.side = String(value ?? "").trim().toLowerCase();
  } else if (field === "geometry.gap") {
    patchMultipartGeometryDistances(target.geometry, { gap: value });
  } else if (field === "geometry.width") {
    patchMultipartGeometryDistances(target.geometry, { width: value });
  }
  return patchedParts;
}

function initializeDerivedMultipartGeometry(parts, target) {
  const geometryType = String(target?.geometry?.type ?? "");
  if (!isDerivedMultipartGeometryType(geometryType)) return;
  const targetIndex = parts.findIndex((part) => String(part?.id ?? "") === String(target?.id ?? ""));
  const compatibleReferences = parts.slice(0, Math.max(0, targetIndex))
    .filter((part) => String(part?.geometry?.type ?? "template") === "template");
  const currentReferenceId = String(target.geometry.referencePartId ?? "").trim();
  if (!currentReferenceId && compatibleReferences.length === 1) {
    target.geometry.referencePartId = compatibleReferences[0].id;
  } else if (!currentReferenceId) {
    target.geometry.referencePartId = null;
  }
  const allowedSides = geometryType === "side-of-line" ? ["left", "right"] : ["inner", "outer"];
  if (!allowedSides.includes(String(target.geometry.side ?? ""))) {
    target.geometry.side = geometryType === "side-of-line" ? "left" : "outer";
  }
  if (!target.geometry.offsetReference) target.geometry.offsetReference = "body-edge";
  const distances = getMultipartGeometryDistances(target.geometry);
  patchMultipartGeometryDistances(target.geometry, {
    gap: distances.gap,
    width: distances.width > 0 ? distances.width : resolveDefaultMultipartGeometryWidth()
  });
}

function getMultipartGeometryDistances(geometry = {}) {
  const offsetStart = Number(geometry?.offsetStart);
  const gap = Number.isFinite(offsetStart) ? offsetStart : 0;
  const offsetEnd = Number(geometry?.offsetEnd);
  const width = Number.isFinite(offsetEnd) ? Math.max(0, offsetEnd - gap) : 0;
  return { gap, width };
}

function patchMultipartGeometryDistances(geometry, { gap = undefined, width = undefined } = {}) {
  const current = getMultipartGeometryDistances(geometry);
  const submittedGap = gap === undefined || gap === "" ? current.gap : Number(gap);
  const submittedWidth = width === undefined || width === "" ? current.width : Number(width);
  const nextGap = Number.isFinite(submittedGap) ? submittedGap : current.gap;
  const nextWidth = Number.isFinite(submittedWidth) ? submittedWidth : current.width;
  geometry.offsetStart = nextGap;
  geometry.offsetEnd = nextGap + nextWidth;
}

function resolveDefaultMultipartGeometryWidth() {
  const gridDistance = Number(globalThis.canvas?.scene?.grid?.distance ?? globalThis.canvas?.dimensions?.distance);
  return Number.isFinite(gridDistance) && gridDistance > 0 ? gridDistance : 1;
}

function isDerivedMultipartGeometryType(geometryType) {
  return geometryType === "side-of-line" || geometryType === "side-of-ring";
}

function patchMultipartPartsById(existingParts = [], submittedParts = []) {
  const patchedParts = foundry.utils.deepClone(Array.from(existingParts ?? []));
  const existingIndexById = new Map(patchedParts.map((part, index) => [String(part?.id ?? ""), index]));
  for (const [submittedIndexText, submittedPart] of Object.entries(submittedParts ?? {})) {
    if (!submittedPart || typeof submittedPart !== "object" || Array.isArray(submittedPart)) continue;
    const submittedIndex = Number(submittedIndexText);
    const fallbackId = Number.isInteger(submittedIndex)
      ? String(patchedParts[submittedIndex]?.id ?? "")
      : "";
    const id = String(submittedPart?.id ?? fallbackId).trim();
    const existingIndex = existingIndexById.get(id);
    const original = existingIndex === undefined ? null : patchedParts[existingIndex];
    const patched = foundry.utils.deepClone(original ?? {
      id,
      label: patchedParts.length === 0 ? localize("PERSISTENT_ZONES.Activity.Parts.PrimaryZone") : localize("PERSISTENT_ZONES.Activity.Parts.SecondaryZone"),
      role: patchedParts.length === 0 ? "primary" : "secondary",
      geometry: { type: "template" }
    });
    patched.id = id;
    if (submittedPart?.label !== undefined) patched.label = String(submittedPart.label ?? "").trim();
    if (submittedPart?.role !== undefined) patched.role = String(submittedPart.role ?? "").trim();
    patched.geometry = patched.geometry && typeof patched.geometry === "object" && !Array.isArray(patched.geometry)
      ? patched.geometry
      : {};
    if (submittedPart?.geometry?.type !== undefined) {
      patched.geometry.type = String(submittedPart.geometry.type ?? "").trim().toLowerCase();
    }
    if (submittedPart?.geometry?.referencePartId !== undefined) {
      patched.geometry.referencePartId = String(submittedPart.geometry.referencePartId ?? "").trim() || null;
    }
    if (submittedPart?.geometry?.side !== undefined) {
      patched.geometry.side = String(submittedPart.geometry.side ?? "").trim().toLowerCase();
    }
    if (submittedPart?.geometry?.gap !== undefined || submittedPart?.geometry?.width !== undefined) {
      patchMultipartGeometryDistances(patched.geometry, {
        gap: submittedPart.geometry.gap,
        width: submittedPart.geometry.width
      });
    }
    if (existingIndex === undefined) {
      existingIndexById.set(id, patchedParts.length);
      patchedParts.push(patched);
    } else {
      patchedParts[existingIndex] = patched;
    }
  }
  return patchedParts;
}

function buildInitialMultipartPart() {
  return {
    id: "primary",
    label: localize("PERSISTENT_ZONES.Activity.Parts.PrimaryZone"),
    role: "primary",
    geometry: { type: "template" }
  };
}

function buildSecondaryMultipartPart(parts = []) {
  const usedIds = new Set(Array.from(parts ?? []).map((part) => String(part?.id ?? "")));
  let id;
  do {
    id = `part-${foundry.utils.randomID(6)}`;
  } while (usedIds.has(id));
  return {
    id,
    label: localize("PERSISTENT_ZONES.Activity.Parts.SecondaryZone"),
    role: "secondary",
    geometry: { type: "template" }
  };
}

async function removeMultipartPart(parts, partId) {
  const targetId = String(partId ?? "");
  if (parts.length <= 1) {
    notifyMultipartError("PERSISTENT_ZONES.Activity.Parts.CannotRemoveLast");
    return parts;
  }
  const target = parts.find((part) => String(part?.id ?? "") === targetId);
  if (!target) return parts;
  const dependents = parts.filter((part) => String(part?.geometry?.referencePartId ?? "") === targetId);
  if (dependents.length) {
    notifyMultipartError("PERSISTENT_ZONES.Activity.Parts.CannotRemoveReferenced", {
      parts: dependents.map((part) => part?.label ?? part?.id).join(", ")
    });
    return parts;
  }
  const confirmed = await confirmPersistentZoneAction(
    "PERSISTENT_ZONES.Activity.Parts.RemoveConfirmTitle",
    "PERSISTENT_ZONES.Activity.Parts.RemoveConfirm",
    { part: target.label ?? target.id }
  );
  return confirmed ? parts.filter((part) => String(part?.id ?? "") !== targetId) : parts;
}

function validateMultipartParts(parts, existingParts = [], { mode = "strict" } = {}) {
  if (!parts.length) throw new Error(localize("PERSISTENT_ZONES.Activity.Parts.CannotRemoveLast"));
  const editingErrors = [];
  const reportEditingError = (localizationKey) => {
    const error = new Error(localize(localizationKey));
    if (mode === "strict") throw error;
    editingErrors.push(error);
  };
  const existingById = new Map(Array.from(existingParts ?? []).map((part) => [String(part?.id ?? ""), part]));
  const ids = new Set();
  const knownRoles = new Set(["primary", "secondary"]);
  const knownGeometryTypes = new Set(["template", "side-of-line", "side-of-ring"]);
  parts.forEach((part, index) => {
    const id = String(part?.id ?? "").trim();
    if (!id || ids.has(id)) throw new Error(localize("PERSISTENT_ZONES.Activity.Parts.InvalidIds"));
    ids.add(id);
    if (!String(part?.label ?? "").trim()) reportEditingError("PERSISTENT_ZONES.Activity.Parts.LabelRequired");
    const original = existingById.get(id);
    if (!knownRoles.has(part?.role) && part?.role !== original?.role) {
      throw new Error(localize("PERSISTENT_ZONES.Activity.Parts.InvalidRole"));
    }
    if (!knownGeometryTypes.has(part?.geometry?.type) && part?.geometry?.type !== original?.geometry?.type) {
      throw new Error(localize("PERSISTENT_ZONES.Activity.Parts.InvalidGeometryType"));
    }
    const referencePartId = String(part?.geometry?.referencePartId ?? "").trim();
    if (isDerivedMultipartGeometryType(part?.geometry?.type)) {
      if (!referencePartId) {
        reportEditingError("PERSISTENT_ZONES.Activity.Parts.ReferenceRequired");
        return;
      }
      const referenceIndex = parts.findIndex((candidate) => String(candidate?.id ?? "") === referencePartId);
      if (referenceIndex < 0) {
        reportEditingError("PERSISTENT_ZONES.Activity.Parts.InvalidReference");
        return;
      }
      if (referenceIndex >= index) {
        reportEditingError("PERSISTENT_ZONES.Activity.Parts.ReferenceMustPrecede");
        return;
      }
      if (String(parts[referenceIndex]?.geometry?.type ?? "template") !== "template") {
        reportEditingError("PERSISTENT_ZONES.Activity.Parts.IncompatibleReference");
      }
      const allowedSides = part.geometry.type === "side-of-line" ? ["left", "right"] : ["inner", "outer"];
      if (!allowedSides.includes(String(part.geometry.side ?? ""))) {
        reportEditingError("PERSISTENT_ZONES.Activity.Parts.InvalidSide");
      }
      const rawGap = Number(part.geometry.offsetStart);
      const { width } = getMultipartGeometryDistances(part.geometry);
      if (!Number.isFinite(rawGap) || rawGap < 0) {
        reportEditingError("PERSISTENT_ZONES.Activity.Parts.InvalidGap");
      }
      if (!(width > 0) || !(Number(part.geometry.offsetEnd) > rawGap)) {
        reportEditingError("PERSISTENT_ZONES.Activity.Parts.InvalidWidth");
      }
    }
  });
  return editingErrors;
}

function buildMultipartPartRows(parts = [], mainGeometryType = "circle") {
  const supportedDerivedGeometryType = resolveSupportedDerivedMultipartGeometryType(mainGeometryType);
  return Array.from(parts ?? []).map((part, index) => {
    const geometryType = String(part?.geometry?.type ?? "template");
    const role = String(part?.role ?? (index === 0 ? "primary" : "secondary"));
    const previousCompatibleParts = parts.slice(0, index)
      .filter((candidate) =>
        String(candidate?.geometry?.type ?? "template") === "template" &&
        geometryType === supportedDerivedGeometryType
      );
    const referencePartId = String(part?.geometry?.referencePartId ?? "");
    const referenceOptions = [
      { value: "", label: "PERSISTENT_ZONES.Activity.Parts.SelectReference", selected: !referencePartId },
      ...previousCompatibleParts.map((candidate) => ({
        value: candidate.id,
        label: candidate.label ?? candidate.id,
        selected: String(candidate.id) === referencePartId
      }))
    ];
    if (referencePartId && !referenceOptions.some((option) => String(option.value) === referencePartId)) {
      referenceOptions.push({ value: referencePartId, label: referencePartId, selected: true, invalid: true });
    }
    const distances = getMultipartGeometryDistances(part?.geometry ?? {});
    return {
      index,
      number: index + 1,
      id: part?.id ?? "",
      label: part?.label ?? part?.id ?? "",
      role,
      geometryType,
      derivedGeometry: isDerivedMultipartGeometryType(geometryType),
      geometryCompatibilityWarning: isDerivedMultipartGeometryType(geometryType) && geometryType !== supportedDerivedGeometryType,
      referenceOptions,
      sideOptions: buildMultipartSideOptions(geometryType, part?.geometry?.side),
      gap: distances.gap,
      width: distances.width,
      roleOptions: buildPreservingChoiceOptions(["primary", "secondary"], role, "PERSISTENT_ZONES.Activity.Parts.Roles"),
      geometryTypeOptions: buildMultipartGeometryTypeOptions(supportedDerivedGeometryType, geometryType)
    };
  });
}

function resolveSupportedDerivedMultipartGeometryType(mainGeometryType) {
  const geometryType = String(mainGeometryType ?? "").trim().toLowerCase();
  if (geometryType === "wall") return "side-of-line";
  if (geometryType === "ring") return "side-of-ring";
  return null;
}

function buildMultipartGeometryTypeOptions(supportedDerivedGeometryType, currentValue) {
  const values = ["template"];
  if (supportedDerivedGeometryType) values.push(supportedDerivedGeometryType);
  const options = values.map((value) => ({
    value,
    label: `PERSISTENT_ZONES.Activity.Parts.GeometryTypes.${value}`,
    selected: value === currentValue,
    invalid: false
  }));
  if (currentValue && !values.includes(currentValue)) {
    options.push({
      value: currentValue,
      label: `PERSISTENT_ZONES.Activity.Parts.GeometryTypes.${currentValue}`,
      selected: true,
      invalid: true
    });
  }
  return options;
}

function buildMultipartSideOptions(geometryType, currentSide) {
  const values = geometryType === "side-of-line" ? ["left", "right"] : ["inner", "outer"];
  const options = values.map((value) => ({
    value,
    label: `PERSISTENT_ZONES.Activity.Parts.Sides.${value}`,
    selected: value === currentSide
  }));
  if (currentSide && !values.includes(currentSide)) {
    options.push({ value: currentSide, label: currentSide, selected: true, invalid: true });
  }
  return options;
}

function buildPreservingChoiceOptions(values, currentValue, localizationRoot) {
  const options = Array.from(values);
  if (currentValue && !options.includes(currentValue)) options.push(currentValue);
  return options.map((value) => ({
    value,
    label: values.includes(value) ? `${localizationRoot}.${value}` : value,
    selected: value === currentValue
  }));
}

async function confirmPersistentZoneAction(titleKey, contentKey, data = {}) {
  const title = localize(titleKey);
  const content = game.i18n?.format?.(contentKey, data) ?? localize(contentKey);
  if (globalThis.foundry?.applications?.api?.DialogV2?.confirm) {
    return foundry.applications.api.DialogV2.confirm({ window: { title }, content });
  }
  if (globalThis.Dialog?.confirm) {
    return Dialog.confirm({ title, content });
  }
  return globalThis.confirm?.(content) ?? false;
}

function notifyMultipartError(key, data = {}) {
  const message = game.i18n?.format?.(key, data) ?? localize(key);
  ui.notifications?.error?.(message);
}

function requestPersistentZoneFormSubmit(root, sheet = null) {
  const form = root?.closest?.("form") ?? null;
  if (form?.requestSubmit) {
    form.requestSubmit();
    return;
  }
  sheet?.submit?.();
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
  config.linkedWalls.preset = String(config.linkedWalls.preset ?? "solid").trim().toLowerCase() || "solid";
  config.linkedWalls.geometry = String(config.linkedWalls.geometry ?? "centerline");
  config.linkedWalls.move = normalizeChoice(config.linkedWalls.move, ["none", "normal"], "normal");
  const linkedWallSenseChoices = ["none", "limited", "normal", "proximity", "distance"];
  config.linkedWalls.sight = normalizeChoice(config.linkedWalls.sight, linkedWallSenseChoices, "normal");
  config.linkedWalls.light = normalizeChoice(config.linkedWalls.light, linkedWallSenseChoices, "normal");
  config.linkedWalls.sound = normalizeChoice(config.linkedWalls.sound, linkedWallSenseChoices, "normal");
  config.linkedWalls.dir = normalizeChoice(config.linkedWalls.dir, ["both", "left", "right"], "both");
  config.linkedWalls.threshold ??= {};
  config.linkedWalls.threshold.sight = normalizePositiveNumberOrNull(config.linkedWalls.threshold.sight);
  config.linkedWalls.threshold.light = normalizePositiveNumberOrNull(config.linkedWalls.threshold.light);
  config.linkedWalls.threshold.sound = normalizePositiveNumberOrNull(config.linkedWalls.threshold.sound);
  config.linkedWalls.threshold.attenuation = false;
  config.linkedLights ??= {};
  config.linkedLights.color ||= "#ffd88a";
  config.lifecycle ??= {};
  if (Array.isArray(config.parts)) {
    config.parts = normalizeActivityParts(config.parts);
  }
  return config;
}

function normalizeActivityParts(parts) {
  const usedIds = new Set();
  return parts
    .filter((part) => part && typeof part === "object" && !Array.isArray(part))
    .map((part, index) => {
      const normalized = foundry.utils.deepClone(part);
      normalized.id = buildUniquePartId(normalized.id, index, usedIds);
      normalized.label = String(normalized.label ?? normalized.id).trim() || normalized.id;
      normalized.role = String(normalized.role ?? (index === 0 ? "primary" : "secondary")).trim();
      normalized.geometry = normalizeActivityPartObject(normalized.geometry);
      normalized.geometry.type = String(normalized.geometry.type ?? "template").trim().toLowerCase();
      return normalized;
    });
}

function buildUniquePartId(value, index, usedIds) {
  const baseId = String(value ?? "").trim() || `part-${index + 1}`;
  let candidate = baseId;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizeActivityPartGeometry(value) {
  const geometry = normalizeActivityPartObject(value);
  const type = String(geometry.type ?? "template").trim().toLowerCase();
  geometry.type = ["template", "ring", "side-of-line", "side-of-ring"].includes(type) ? type : "template";
  if (geometry.referencePartId !== undefined) {
    geometry.referencePartId = String(geometry.referencePartId ?? "").trim() || null;
  }
  if (geometry.side !== undefined) {
    geometry.side = String(geometry.side ?? "").trim().toLowerCase() || null;
  }
  if (geometry.offsetReference !== undefined) {
    geometry.offsetReference = String(geometry.offsetReference ?? "").trim().toLowerCase() || null;
  }
  for (const key of ["offsetStart", "offsetEnd"]) {
    if (geometry[key] !== undefined && geometry[key] !== null && geometry[key] !== "") {
      const numeric = Number(geometry[key]);
      if (Number.isFinite(numeric)) geometry[key] = numeric;
    }
  }
  return geometry;
}

function normalizeActivityPartTerrain(value) {
  const terrain = normalizeActivityPartObject(value);
  if (terrain.enabled !== undefined) terrain.enabled = Boolean(terrain.enabled);
  if (terrain.multiplier !== undefined && terrain.multiplier !== null && terrain.multiplier !== "") {
    const numeric = Number(terrain.multiplier);
    if (Number.isFinite(numeric)) terrain.multiplier = numeric;
  }
  return terrain;
}

function normalizeActivityPartLinkedWalls(value) {
  const linkedWalls = normalizeActivityPartObject(value);
  if (linkedWalls.enabled !== undefined) linkedWalls.enabled = Boolean(linkedWalls.enabled);
  if (linkedWalls.preset !== undefined) {
    linkedWalls.preset = String(linkedWalls.preset ?? "solid").trim().toLowerCase() || "solid";
  }
  if (linkedWalls.geometry !== undefined) {
    linkedWalls.geometry = normalizeChoice(linkedWalls.geometry, ["centerline", "perimeter"], "centerline");
  }
  if (linkedWalls.move !== undefined) {
    linkedWalls.move = normalizeChoice(linkedWalls.move, ["none", "normal"], "normal");
  }
  const senseChoices = ["none", "limited", "normal", "proximity", "distance"];
  for (const sense of ["sight", "light", "sound"]) {
    if (linkedWalls[sense] !== undefined) {
      linkedWalls[sense] = normalizeChoice(linkedWalls[sense], senseChoices, "normal");
    }
  }
  if (linkedWalls.dir !== undefined) {
    linkedWalls.dir = normalizeChoice(linkedWalls.dir, ["both", "left", "right"], "both");
  }
  return linkedWalls;
}

function normalizeActivityPartLinkedLight(value) {
  const linkedLight = normalizeActivityPartObject(value);
  if (linkedLight.enabled !== undefined) linkedLight.enabled = Boolean(linkedLight.enabled);
  if (linkedLight.preset !== undefined) {
    linkedLight.preset = String(linkedLight.preset ?? "glow").trim().toLowerCase() || "glow";
  }
  return linkedLight;
}

function normalizeActivityPartTriggers(value, part) {
  const triggers = normalizeActivityPartObject(value);
  const globalDamage = normalizeActivityPartObject(part.damage);
  const globalSave = normalizeActivityPartObject(part.save);
  const normalized = {};
  const mappings = [
    ["enter", "onEnter"],
    ["move", "onMove"],
    ["exit", "onExit"],
    ["turnStart", "onStartTurn"],
    ["turnEnd", "onEndTurn"]
  ];

  for (const [canonicalKey, legacyKey] of mappings) {
    if (triggers[canonicalKey] === undefined && triggers[legacyKey] === undefined) continue;
    normalized[canonicalKey] = normalizeActivityTrigger(
      triggers[canonicalKey] ?? triggers[legacyKey],
      canonicalKey,
      { globalDamage, globalSave }
    );
  }

  return normalized;
}

function normalizeActivityPartObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? foundry.utils.deepClone(value)
    : {};
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

function normalizeChoice(value, choices, fallback) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return choices.includes(normalized) ? normalized : fallback;
}

function normalizePositiveNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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
    linkedWallMovementTypes: [
      { value: "none", label: "PERSISTENT_ZONES.Activity.LinkedWallMovement.Allowed" },
      { value: "normal", label: "PERSISTENT_ZONES.Activity.LinkedWallMovement.Blocked" }
    ],
    linkedWallSenseTypes: [
      { value: "none", label: "PERSISTENT_ZONES.Activity.LinkedWallSense.None" },
      { value: "limited", label: "PERSISTENT_ZONES.Activity.LinkedWallSense.Limited" },
      { value: "normal", label: "PERSISTENT_ZONES.Activity.LinkedWallSense.Normal" },
      { value: "proximity", label: "PERSISTENT_ZONES.Activity.LinkedWallSense.Proximity" },
      { value: "distance", label: "PERSISTENT_ZONES.Activity.LinkedWallSense.ReverseProximity" }
    ],
    linkedWallDirections: [
      { value: "both", label: "PERSISTENT_ZONES.Activity.LinkedWallDirection.Both" },
      { value: "left", label: "PERSISTENT_ZONES.Activity.LinkedWallDirection.Left" },
      { value: "right", label: "PERSISTENT_ZONES.Activity.LinkedWallDirection.Right" }
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
  return ["solid", "terrain", "invisible", "ethereal", "custom"].map((preset) => ({
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
  root.querySelectorAll("[data-pz-linked-wall-geometry]").forEach((element) => {
    element.hidden = geometry !== "wall";
  });
  const linkedWallPreset = root.querySelector("[name='persistentZone.linkedWalls.preset']")?.value ?? "solid";
  const linkedWallGeometry = root.querySelector("[name='persistentZone.linkedWalls.geometry']")?.value ?? "centerline";
  root.querySelectorAll("[data-pz-linked-wall-custom]").forEach((element) => {
    element.hidden = linkedWallPreset !== "custom";
  });
  root.querySelectorAll("[data-pz-linked-wall-threshold]").forEach((element) => {
    const sense = element.dataset.pzLinkedWallThreshold;
    const senseType = root.querySelector(`[name='persistentZone.linkedWalls.${sense}']`)?.value ?? "normal";
    element.hidden = linkedWallPreset !== "custom" || !["proximity", "distance"].includes(senseType);
  });
  root.querySelectorAll("[data-pz-linked-wall-direction]").forEach((element) => {
    element.hidden = linkedWallPreset !== "custom" || geometry !== "wall" || linkedWallGeometry !== "centerline";
  });

  root.querySelectorAll("[data-pz-part-id]").forEach((partCard) => {
    const geometryType = partCard.querySelector("[data-pz-part-field='geometry.type']")?.value ?? "template";
    const derivedGeometryEnabled = isDerivedMultipartGeometryType(geometryType);
    partCard.querySelectorAll("[data-pz-part-derived-geometry]").forEach((element) => {
      element.hidden = !derivedGeometryEnabled;
      element.querySelectorAll("input, select, textarea, button").forEach((control) => {
        control.disabled = !derivedGeometryEnabled;
      });
    });
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

function orderPersistentZoneActivitySections(root) {
  const geometrySection = root?.querySelector?.(".persistent-zone-activity__geometry");
  const partsSection = root?.querySelector?.(".persistent-zone-activity__parts");
  if (geometrySection && partsSection && geometrySection.nextElementSibling !== partsSection) {
    geometrySection.after(partsSection);
  }
}

function captureMultipartFieldPatch(event) {
  const multipartField = event?.target?.closest?.("[data-pz-part-field]");
  const partCard = multipartField?.closest?.("[data-pz-part-id]");
  if (!multipartField || !partCard) return null;
  return {
    partId: partCard.dataset.pzPartId ?? null,
    field: multipartField.dataset.pzPartField ?? null,
    value: multipartField.value
  };
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
