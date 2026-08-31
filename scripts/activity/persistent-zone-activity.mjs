import {
  MODULE_ID,
  PERSISTENT_ZONE_ACTIVITY_TYPE
} from "../constants.mjs";
import { PersistentZoneActivityData } from "./persistent-zone-activity-data.mjs";
import { PersistentZoneActivitySheet } from "./persistent-zone-activity-sheet.mjs";
import { registerPersistentZonePlacementContext } from "../runtime/persistent-zone-placement-context.mjs";

export class PersistentZoneActivity extends dnd5e.documents.activity.ActivityMixin(PersistentZoneActivityData) {
  static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "PERSISTENT_ZONES.Activity"];

  static metadata = Object.freeze(
    foundry.utils.mergeObject(super.metadata, {
      type: PERSISTENT_ZONE_ACTIVITY_TYPE,
      img: "icons/svg/aura.svg",
      title: "PERSISTENT_ZONES.Activity.Title",
      hint: "PERSISTENT_ZONES.Activity.Hint",
      sheetClass: PersistentZoneActivitySheet,
      usage: {
        actions: {}
      }
    }, { inplace: false })
  );

  static defineSchema() {
    return PersistentZoneActivityData.defineSchema();
  }

  async use(usage = {}, dialog = {}, message = {}) {
    const targetTemplateType = this.target?.template?.type ?? this._source?.target?.template?.type ?? null;
    registerPersistentZonePlacementContext({
      userId: game.user?.id ?? null,
      sceneId: canvas?.scene?.id ?? null,
      itemUuid: this.item?.uuid ?? null,
      activityId: this.id ?? null,
      activityUuid: this.uuid ?? null,
      activityType: this.type ?? PERSISTENT_ZONE_ACTIVITY_TYPE,
      geometryType: this.persistentZone?.geometry?.type ?? this._source?.persistentZone?.geometry?.type ?? null,
      targetTemplateType,
      nativeTemplateType: normalizeNativeTemplateType(targetTemplateType)
    });
    console.warn(
      `[${MODULE_ID}][activity] PZ ACTIVITY USE | activityId=${this.id ?? "null"} | activityUuid=${this.uuid ?? "null"} | itemUuid=${this.item?.uuid ?? "null"} | activityType=${PERSISTENT_ZONE_ACTIVITY_TYPE}`
    );
    return super.use(usage, dialog, message);
  }
}

function normalizeNativeTemplateType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "square" || normalized === "rectangle") return "rect";
  if (normalized === "wall" || normalized === "line") return "ray";
  return normalized || null;
}
