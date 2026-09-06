import { MODULE_ID, RESOLUTION_ENGINE_SETTING_KEY } from "../constants.mjs";
import { RESOLUTION_ENGINES } from "../settings.mjs";
import { isMidiResolutionAvailable, resolveMidiResolution } from "./midi-resolution-resolver.mjs";

let midiFallbackWarningShown = false;

export function getResolutionEngine() {
  const selected = String(globalThis.game?.settings?.get?.(MODULE_ID, RESOLUTION_ENGINE_SETTING_KEY) ?? RESOLUTION_ENGINES.native);
  return selected === RESOLUTION_ENGINES.midiQol ? RESOLUTION_ENGINES.midiQol : RESOLUTION_ENGINES.native;
}

/** Select one resolver. Native execution remains in the existing PZ path. */
export async function resolveResolutionRequest({ request, sourceActor, sourceToken, targetToken, save, damage } = {}) {
  if (getResolutionEngine() !== RESOLUTION_ENGINES.midiQol) return { status: "native", engine: RESOLUTION_ENGINES.native, request };
  if (!isMidiResolutionAvailable()) {
    notifyMidiFallbackOnce();
    return { status: "native", engine: RESOLUTION_ENGINES.native, fallback: "midi-unavailable", request };
  }
  return resolveMidiResolution({ sourceActor, sourceToken, targetToken, save, damage });
}

function notifyMidiFallbackOnce() {
  if (midiFallbackWarningShown) return;
  midiFallbackWarningShown = true;
  globalThis.ui?.notifications?.warn?.(globalThis.game?.i18n?.localize?.("PERSISTENT_ZONES.Runtime.MidiUnavailableFallback") ?? "Midi-QOL is unavailable; Persistent Zones is using native resolution.");
}

export function resetMidiFallbackWarningForTests() { midiFallbackWarningShown = false; }
