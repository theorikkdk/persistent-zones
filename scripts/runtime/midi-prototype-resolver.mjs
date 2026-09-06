import { MODULE_ID } from "../constants.mjs";

export function isMidiPrototypeAvailable() {
  return Boolean(globalThis.MidiQOL?.TrapWorkflow && globalThis.CONFIG?.Item?.documentClass && globalThis.Hooks?.once);
}

/** Build an in-memory, non-spell Item containing one neutral save/damage Activity. */
export function buildMidiPrototypeItemData({ name = "Persistent Zones MIDI Prototype", ability = "dex", dc = 10, formula = "2d6", type = "fire" } = {}) {
  const id = globalThis.foundry?.utils?.randomID?.() ?? crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return {
    _id: id,
    name,
    type: "feat",
    flags: { [MODULE_ID]: { resolution: true, midiPrototype: true } },
    system: { activities: {
      [id]: {
        _id: id, type: "save",
        flags: { [MODULE_ID]: { resolution: true, midiPrototype: true } },
        activation: { type: "special", value: null, condition: "" },
        consumption: { targets: [], scaling: { allowed: false } },
        duration: { concentration: false, value: null, units: "inst" },
        target: { affects: { type: "creature", count: "1", choice: false, special: "" }, template: { type: "", size: "", width: "", height: "", units: "ft", contiguous: false } },
        save: { ability: [ability], dc: { calculation: "", formula: String(dc) } },
        damage: { onSave: "half", parts: [{ custom: { enabled: true, formula }, types: [type] }] }
      }
    } }
  };
}

export async function resolveMidiPrototype({ sourceActor, sourceToken, targetToken, save, damage } = {}) {
  if (!isMidiPrototypeAvailable()) return { status: "unavailable", cancelled: false, error: "midi-qol-unavailable" };
  const item = new CONFIG.Item.documentClass(buildMidiPrototypeItemData({
    ability: save?.ability ?? "dex", dc: save?.dc ?? 10, formula: damage?.formula ?? "2d6", type: damage?.type ?? "fire"
  }), { parent: sourceActor });
  item.prepareData?.();
  item.prepareFinalAttributes?.();
  const activity = item.system.activities?.contents?.[0] ?? item.system.activities?.get?.(item.id);
  if (!activity) return { status: "error", error: "midi-prototype-activity-unavailable" };
  return new Promise((resolve) => {
    const hookId = Hooks.on("midi-qol.RollComplete", (workflow) => {
      if (workflow !== instance) return;
      Hooks.off("midi-qol.RollComplete", hookId);
      resolve({ status: "resolved", workflow, cancelled: Boolean(workflow?.aborted), save: workflow.saves, damage: workflow.damageTotal });
    });
    let instance;
    try {
      instance = new MidiQOL.TrapWorkflow(sourceActor, activity, [targetToken], undefined, undefined, { persistentZonesResolution: true });
    } catch (caughtError) {
      Hooks.off("midi-qol.RollComplete", hookId);
      resolve({ status: "error", error: caughtError?.message ?? "midi-prototype-failed" });
    }
  });
}

export function isPersistentZonesSyntheticResolution(activity) {
  return activity?.flags?.[MODULE_ID]?.resolution === true || activity?._source?.flags?.[MODULE_ID]?.resolution === true;
}
