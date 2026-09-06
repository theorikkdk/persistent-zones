import { MODULE_ID } from "../constants.mjs";

export function isMidiResolutionAvailable() {
  return Boolean(
    globalThis.MidiQOL?.TrapWorkflow &&
    globalThis.MidiQOL?.DamageOnlyWorkflow &&
    globalThis.CONFIG?.Item?.documentClass &&
    globalThis.Hooks?.on &&
    globalThis.Hooks?.off
  );
}

/** Build an in-memory Item only for the current PZ resolution. */
export function buildMidiResolutionItemData({
  name = "Persistent Zones MIDI Resolution",
  save = null,
  damage = null
} = {}) {
  const id = globalThis.foundry?.utils?.randomID?.() ?? crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const hasSave = Boolean(save?.enabled);
  const hasDamage = Boolean(damage?.enabled && damage?.formula);
  return {
    _id: id,
    name,
    type: "feat",
    flags: { [MODULE_ID]: { resolution: true, midiResolution: true } },
    system: { activities: {
      [id]: {
        _id: id,
        type: hasSave ? "save" : "damage",
        flags: { [MODULE_ID]: { resolution: true, midiResolution: true } },
        activation: { type: "special", value: null, condition: "" },
        consumption: { targets: [], scaling: { allowed: false } },
        duration: { concentration: false, value: null, units: "inst" },
        target: { affects: { type: "creature", count: "1", choice: false, special: "" }, template: { type: "", size: "", width: "", height: "", units: "ft", contiguous: false } },
        ...(hasSave ? { save: { ability: [save.ability ?? "dex"], dc: { calculation: "", formula: String(save.dc ?? 10) } } } : {}),
        damage: {
          onSave: String(save?.onSuccess ?? "half").toLowerCase(),
          parts: hasDamage ? [{ custom: { enabled: true, formula: damage.formula }, types: [damage.type ?? "force"] }] : []
        }
      }
    } }
  };
}

export async function resolveMidiResolution({ sourceActor, sourceToken, targetToken, save = null, damage = null } = {}) {
  if (!isMidiResolutionAvailable()) return { status: "unavailable", engine: "midi-qol", error: "midi-qol-unavailable" };
  const hasSave = Boolean(save?.enabled);
  const hasDamage = Boolean(damage?.enabled && damage?.formula);
  if (!hasSave && !hasDamage) return { status: "resolved", engine: "midi-qol", applied: false };
  if (!sourceActor || !targetToken) return { status: "error", engine: "midi-qol", error: "midi-resolution-missing-source-or-target" };
  if (!hasSave) return resolveMidiDamageOnly({ sourceActor, sourceToken, targetToken, damage });

  const item = new CONFIG.Item.documentClass(buildMidiResolutionItemData({ save, damage }), { parent: sourceActor });
  item.prepareData?.();
  item.prepareFinalAttributes?.();
  const activity = item.system.activities?.contents?.[0] ?? item.system.activities?.get?.(item.id);
  if (!activity) return { status: "error", engine: "midi-qol", error: "midi-resolution-activity-unavailable" };
  return waitForMidiWorkflow((options) => new MidiQOL.TrapWorkflow(
    sourceActor, activity, [targetToken], undefined, undefined, options
  ));
}

async function resolveMidiDamageOnly({ sourceActor, sourceToken, targetToken, damage }) {
  const roll = new Roll(damage.formula);
  await roll.evaluate();
  return waitForMidiWorkflow((options) => new MidiQOL.DamageOnlyWorkflow(
    sourceActor,
    sourceToken,
    roll.total,
    damage.type ?? "force",
    [targetToken],
    roll,
    { ...options, flavor: "Persistent Zones damage" }
  ));
}

function waitForMidiWorkflow(createWorkflow) {
  return new Promise((resolve) => {
    let instance;
    const hookId = Hooks.on("midi-qol.RollComplete", (workflow) => {
      if (workflow !== instance) return;
      Hooks.off("midi-qol.RollComplete", hookId);
      resolve({
        status: "resolved",
        engine: "midi-qol",
        applied: !workflow?.aborted,
        cancelled: Boolean(workflow?.aborted),
        workflow,
        save: workflow?.saves ?? null,
        damage: workflow?.damageTotal ?? null
      });
    });
    try {
      instance = createWorkflow({ persistentZonesResolution: true, [MODULE_ID]: { resolution: true } });
    } catch (caughtError) {
      Hooks.off("midi-qol.RollComplete", hookId);
      resolve({ status: "error", engine: "midi-qol", error: caughtError?.message ?? "midi-resolution-failed" });
    }
  });
}

export function isPersistentZonesSyntheticResolution(document) {
  return document?.flags?.[MODULE_ID]?.resolution === true || document?._source?.flags?.[MODULE_ID]?.resolution === true;
}
