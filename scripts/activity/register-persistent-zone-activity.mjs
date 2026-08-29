import {
  ACTIVITY_DEFINITION_SCHEMA_VERSION,
  MODULE_ID,
  PERSISTENT_ZONE_ACTIVITY_TYPE
} from "../constants.mjs";
import { PersistentZoneActivity } from "./persistent-zone-activity.mjs";
import { PersistentZoneActivitySheet } from "./persistent-zone-activity-sheet.mjs";

export function registerPersistentZoneActivityType() {
  const activityTypes = CONFIG?.DND5E?.activityTypes;
  if (!activityTypes) {
    console.warn(`[${MODULE_ID}][activity] persistent-zone activity registration skipped | reason=dnd5e-activity-types-unavailable`);
    return false;
  }

  if (activityTypes[PERSISTENT_ZONE_ACTIVITY_TYPE]) {
    console.warn(`[${MODULE_ID}][activity] persistent-zone activity registration skipped | reason=activity-type-already-registered`);
    return false;
  }

  const config = {
    documentClass: PersistentZoneActivity,
    sheetClass: PersistentZoneActivitySheet,
    typeLabel: "PERSISTENT_ZONES.Activity.Title",
    configurable: true,
    persistentZones: {
      moduleId: MODULE_ID,
      schemaVersion: ACTIVITY_DEFINITION_SCHEMA_VERSION
    }
  };

  PersistentZoneActivity.localize?.();
  activityTypes[PERSISTENT_ZONE_ACTIVITY_TYPE] = config;
  console.warn(`[${MODULE_ID}][activity] persistent-zone activity registered | type=${PERSISTENT_ZONE_ACTIVITY_TYPE}`);
  return true;
}
