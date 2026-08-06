import {
  MODULE_ID,
  PERSISTENT_ZONE_ACTIVITY_TYPE
} from "../constants.mjs";
import { PersistentZoneActivityData } from "./persistent-zone-activity-data.mjs";
import { PersistentZoneActivitySheet } from "./persistent-zone-activity-sheet.mjs";

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
    console.warn(
      `[${MODULE_ID}][activity] PZ ACTIVITY USE | activityId=${this.id ?? "null"} | activityUuid=${this.uuid ?? "null"} | itemUuid=${this.item?.uuid ?? "null"} | activityType=${PERSISTENT_ZONE_ACTIVITY_TYPE}`
    );
    return super.use(usage, dialog, message);
  }
}
