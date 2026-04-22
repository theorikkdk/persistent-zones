import {
  coerceBoolean,
  coerceNumber,
  debug,
  isPlainObject,
  pickFirstDefined
} from "./utils.mjs";

const DEFAULT_LINKED_WALL_SEGMENTS = 24;
const DEFAULT_LINKED_LIGHT_COLOR = "#fff4b0";
const DEFAULT_LINKED_LIGHT_ALPHA = 0.15;
const DEFAULT_LINKED_LIGHT_LUMINOSITY = 0.5;
const DEFAULT_LINKED_LIGHT_ANGLE = 360;

const LINKED_WALL_PRESETS = Object.freeze({
  solid: Object.freeze({
    mode: "both",
    move: "normal",
    sight: "normal",
    light: "normal",
    sound: "normal",
    segments: DEFAULT_LINKED_WALL_SEGMENTS
  }),
  terrain: Object.freeze({
    mode: "both",
    move: "normal",
    sight: "limited",
    light: "limited",
    sound: "limited",
    segments: DEFAULT_LINKED_WALL_SEGMENTS
  }),
  invisible: Object.freeze({
    mode: "move",
    move: "normal",
    sight: "none",
    light: "none",
    sound: "none",
    segments: DEFAULT_LINKED_WALL_SEGMENTS
  }),
  ethereal: Object.freeze({
    mode: "sight",
    move: "none",
    sight: "normal",
    light: "normal",
    sound: "normal",
    segments: DEFAULT_LINKED_WALL_SEGMENTS
  })
});

const LINKED_LIGHT_PRESETS = Object.freeze({
  glow: Object.freeze({
    bright: 8,
    dim: 18,
    color: "#ffd88a",
    alpha: 0.2,
    luminosity: 0.5,
    angle: 360,
    walls: false,
    vision: false,
    hidden: false,
    animation: Object.freeze({
      type: "pulse",
      speed: 2,
      intensity: 1,
      reverse: false
    })
  }),
  moonlight: Object.freeze({
    bright: 12,
    dim: 32,
    color: "#b8ccff",
    alpha: 0.24,
    luminosity: 0.28,
    angle: 360,
    walls: false,
    vision: false,
    hidden: false,
    animation: Object.freeze({
      type: "pulse",
      speed: 1,
      intensity: 2,
      reverse: false
    })
  }),
  fire: Object.freeze({
    bright: 12,
    dim: 24,
    color: "#ff9b42",
    alpha: 0.24,
    luminosity: 0.65,
    angle: 360,
    walls: false,
    vision: false,
    hidden: false,
    animation: Object.freeze({
      type: "torch",
      speed: 5,
      intensity: 6,
      reverse: false
    })
  }),
  holy: Object.freeze({
    bright: 16,
    dim: 34,
    color: "#fff4b8",
    alpha: 0.26,
    luminosity: 0.75,
    angle: 360,
    walls: false,
    vision: false,
    hidden: false,
    animation: Object.freeze({
      type: "pulse",
      speed: 3,
      intensity: 2,
      reverse: false
    })
  }),
  darkness: Object.freeze({
    bright: 0,
    dim: 18,
    color: "#24143d",
    alpha: 0.4,
    luminosity: -0.85,
    angle: 360,
    walls: false,
    vision: false,
    hidden: false,
    animation: Object.freeze({
      type: "pulse",
      speed: 1,
      intensity: 1,
      reverse: false
    })
  })
});

export function resolveLinkedWallConfig(linkedWallsDefinition) {
  const definition = isPlainObject(linkedWallsDefinition) ? linkedWallsDefinition : {};
  const requestedPreset = normalizePresetName(definition.preset);
  const presetConfig = requestedPreset ? LINKED_WALL_PRESETS[requestedPreset] ?? null : null;
  const modeFallback = getModeDerivedWallChannels(
    pickFirstDefined(definition.mode, definition.wallMode, presetConfig?.mode, "move")
  );

  const finalConfig = {
    enabled: coerceBoolean(
      pickFirstDefined(definition.enabled, definition.active, false),
      false
    ),
    preset: requestedPreset,
    resolvedPreset: presetConfig ? requestedPreset : null,
    mode: normalizeLinkedWallMode(
      pickFirstDefined(definition.mode, definition.wallMode, presetConfig?.mode, "move")
    ),
    segments: normalizeLinkedWallSegments(
      pickFirstDefined(definition.segments, presetConfig?.segments, DEFAULT_LINKED_WALL_SEGMENTS)
    ),
    move: normalizeMovementChannel(
      pickFirstDefined(definition.move, definition.movement, presetConfig?.move, modeFallback.move),
      modeFallback.move
    ),
    sight: normalizeSenseChannel(
      pickFirstDefined(definition.sight, definition.vision, presetConfig?.sight, modeFallback.sight),
      modeFallback.sight
    ),
    light: normalizeSenseChannel(
      pickFirstDefined(definition.light, presetConfig?.light, modeFallback.light),
      modeFallback.light
    ),
    sound: normalizeSenseChannel(
      pickFirstDefined(definition.sound, presetConfig?.sound, modeFallback.sound),
      modeFallback.sound
    ),
    height: coerceNumber(
      pickFirstDefined(
        definition.height,
        definition.wallHeight,
        definition.top
      ),
      null
    ),
    bottom: coerceNumber(
      pickFirstDefined(
        definition.bottom,
        0
      ),
      0
    )
  };

  if (requestedPreset) {
    debug(presetConfig ? "Resolved linked wall preset." : "Linked wall preset was not recognized; using explicit overrides only.", {
      requestedPreset,
      resolvedPreset: finalConfig.resolvedPreset,
      finalConfig
    });
  }

  return finalConfig;
}

export function resolveLinkedLightConfig(linkedLightDefinition, {
  templateDistance = null
} = {}) {
  const definition = isPlainObject(linkedLightDefinition) ? linkedLightDefinition : {};
  const requestedPreset = normalizePresetName(definition.preset);
  const presetConfig = requestedPreset ? LINKED_LIGHT_PRESETS[requestedPreset] ?? null : null;
  const presetAnimation = normalizeAnimationDefinition(presetConfig?.animation);
  const explicitAnimation = normalizeAnimationDefinition(definition.animation);
  const presetRadius = buildPresetRadius(presetConfig, templateDistance);

  const finalConfig = {
    enabled: coerceBoolean(
      pickFirstDefined(definition.enabled, definition.active, false),
      false
    ),
    preset: requestedPreset,
    resolvedPreset: presetConfig ? requestedPreset : null,
    bright: coerceNumber(
      pickFirstDefined(definition.bright, presetConfig?.bright),
      null
    ),
    dim: coerceNumber(
      pickFirstDefined(definition.dim, presetConfig?.dim),
      null
    ),
    radius: coerceNumber(
      pickFirstDefined(definition.radius, presetRadius, templateDistance),
      coerceNumber(templateDistance, null)
    ),
    color: pickFirstDefined(definition.color, presetConfig?.color, DEFAULT_LINKED_LIGHT_COLOR),
    alpha: coerceNumber(
      pickFirstDefined(definition.alpha, presetConfig?.alpha),
      DEFAULT_LINKED_LIGHT_ALPHA
    ),
    luminosity: coerceNumber(
      pickFirstDefined(definition.luminosity, presetConfig?.luminosity),
      DEFAULT_LINKED_LIGHT_LUMINOSITY
    ),
    angle: coerceNumber(
      pickFirstDefined(definition.angle, presetConfig?.angle),
      DEFAULT_LINKED_LIGHT_ANGLE
    ),
    walls: coerceBoolean(
      pickFirstDefined(definition.walls, presetConfig?.walls, false),
      false
    ) ?? false,
    vision: coerceBoolean(
      pickFirstDefined(definition.vision, presetConfig?.vision, false),
      false
    ) ?? false,
    hidden: coerceBoolean(
      pickFirstDefined(definition.hidden, presetConfig?.hidden, false),
      false
    ) ?? false,
    animation: {
      type: pickFirstDefined(
        definition.animationType,
        explicitAnimation.type,
        presetAnimation.type,
        null
      ),
      speed: coerceNumber(
        pickFirstDefined(definition.animationSpeed, explicitAnimation.speed, presetAnimation.speed),
        1
      ),
      intensity: coerceNumber(
        pickFirstDefined(definition.animationIntensity, explicitAnimation.intensity, presetAnimation.intensity),
        1
      ),
      reverse: coerceBoolean(
        pickFirstDefined(definition.animationReverse, explicitAnimation.reverse, presetAnimation.reverse, false),
        false
      ) ?? false
    }
  };

  if (requestedPreset) {
    debug(presetConfig ? "Resolved linked light preset." : "Linked light preset was not recognized; using explicit overrides only.", {
      requestedPreset,
      resolvedPreset: finalConfig.resolvedPreset,
      finalConfig
    });
  }

  return finalConfig;
}

function buildPresetRadius(presetConfig, templateDistance) {
  const multiplier = coerceNumber(presetConfig?.radiusMultiplier, null);
  const numericTemplateDistance = coerceNumber(templateDistance, null);
  if (multiplier === null || numericTemplateDistance === null) {
    return null;
  }

  return numericTemplateDistance * multiplier;
}

function normalizeAnimationDefinition(value) {
  if (typeof value === "string") {
    return {
      type: value,
      speed: undefined,
      intensity: undefined,
      reverse: undefined
    };
  }

  const definition = isPlainObject(value) ? value : {};

  return {
    type: pickFirstDefined(definition.type, null),
    speed: coerceNumber(definition.speed, undefined),
    intensity: coerceNumber(definition.intensity, undefined),
    reverse: coerceBoolean(definition.reverse, undefined)
  };
}

function getModeDerivedWallChannels(value) {
  const normalizedMode = normalizeLinkedWallMode(value);

  switch (normalizedMode) {
    case "both":
      return {
        move: "normal",
        sight: "normal",
        light: "normal",
        sound: "none"
      };
    case "sight":
      return {
        move: "none",
        sight: "normal",
        light: "normal",
        sound: "none"
      };
    case "move":
    default:
      return {
        move: "normal",
        sight: "none",
        light: "none",
        sound: "none"
      };
  }
}

function normalizePresetName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

function normalizeLinkedWallMode(value) {
  const normalized = String(value ?? "move").toLowerCase();
  return ["move", "sight", "both"].includes(normalized) ? normalized : "move";
}

function normalizeLinkedWallSegments(value) {
  const numericValue = Math.round(coerceNumber(value, DEFAULT_LINKED_WALL_SEGMENTS));
  return Math.min(Math.max(numericValue, 8), 64);
}

function normalizeMovementChannel(value, fallback = "none") {
  if (typeof value === "boolean") {
    return value ? "normal" : "none";
  }

  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === "limited") {
    debug("Normalized invalid linked wall movement channel to a Foundry v13-safe value.", {
      requestedValue: value,
      normalizedValue: "normal"
    });
    return "normal";
  }

  return ["none", "normal"].includes(normalized) ? normalized : fallback;
}

function normalizeSenseChannel(value, fallback = "none") {
  if (typeof value === "boolean") {
    return value ? "normal" : "none";
  }

  const normalized = String(value ?? fallback).trim().toLowerCase();
  return ["none", "normal", "limited", "proximity", "distance"].includes(normalized)
    ? normalized
    : fallback;
}
