import { MODULE_ID } from "../constants.mjs";
import { fromUuidSafe } from "./utils.mjs";

const ABILITY_IDS = new Set(["str", "dex", "con", "int", "wis", "cha"]);
const ESCAPE_ACTION_TYPES = new Set(["action"]);
const ESCAPE_CHECK_TYPES = new Set(["ability", "skill"]);
const ESCAPE_DC_MODES = new Set(["inherit", "custom"]);
const pendingAttempts = new Set();

let hooksRegistered = false;

export function normalizeStatusEscape(value) {
  const source = isObject(value) ? value : {};
  const dcMode = normalizeChoice(source.dcMode, ESCAPE_DC_MODES, "inherit");
  const enabled = source.enabled === true;
  return {
    enabled,
    actionType: normalizeChoice(source.actionType, ESCAPE_ACTION_TYPES, "action"),
    checkType: normalizeChoice(source.checkType, ESCAPE_CHECK_TYPES, "ability"),
    ability: normalizeAbility(source.ability) ?? "str",
    skill: normalizeSkill(source.skill) ?? "ath",
    dcMode,
    customDC: dcMode === "custom" ? positiveNumber(source.customDC) : null,
    removeOnSuccess: source.removeOnSuccess !== false,
    prompt: {
      enabled: source.prompt?.enabled !== false,
      title: nullableString(source.prompt?.title),
      message: nullableString(source.prompt?.message)
    }
  };
}

export function resolveStatusEscapeDC(escapeLike, { resolvedDC = null, saveDC = null } = {}) {
  const escape = normalizeStatusEscape(escapeLike);
  return escape.dcMode === "custom"
    ? positiveNumber(escape.customDC)
    : positiveNumber(resolvedDC ?? saveDC);
}

export function buildStatusEscapeEffectFlag(escapeLike, context = {}) {
  const escape = normalizeStatusEscape(escapeLike);
  if (!escape.enabled) return null;
  return {
    ...escape,
    resolvedDC: resolveStatusEscapeDC(escape, context),
    statusId: nullableString(context.statusId),
    statusName: nullableString(context.statusName),
    sourceName: nullableString(context.sourceName),
    sourceActivityId: nullableString(context.sourceActivityId),
    promptedTurnKey: null,
    attemptedTurnKey: null
  };
}

export function registerStatusEscapeHooks() {
  if (hooksRegistered) return;
  Hooks.on("updateCombat", onUpdateCombat);
  Hooks.on("renderChatMessageHTML", onRenderChatMessageHTML);
  hooksRegistered = true;
}

export function buildStatusEscapeTurnKey(combat, effect) {
  if (!combat?.started || combat?.round == null || combat?.turn == null || !combat?.combatant) return null;
  const effectUuid = nullableString(effect?.uuid) ?? nullableString(effect?.id) ?? "effect";
  return [combat.id ?? "combat", Number(combat.round), Number(combat.turn), combat.combatant.id ?? combat.combatant.tokenId ?? "combatant", effectUuid].join("|");
}

export function getStatusEscapeEffects(actor) {
  return Array.from(actor?.effects ?? [])
    .filter((effect) => effect?.disabled !== true && effect?.flags?.[MODULE_ID]?.statusEscape?.enabled === true)
    .sort((left, right) => String(left?.uuid ?? left?.id ?? "").localeCompare(String(right?.uuid ?? right?.id ?? "")));
}

export function isStatusEscapeAuthorized({ actor, user = globalThis.game?.user ?? null } = {}) {
  if (!actor || !user) return false;
  if (user.isGM === true) return true;
  if (typeof actor.testUserPermission === "function") return actor.testUserPermission(user, "OWNER") === true;
  return actor.isOwner === true;
}

export async function processStatusEscapeTurn(combat, {
  user = globalThis.game?.user ?? null,
  showPrompt = showStatusEscapePrompt,
  createFallback = createStatusEscapeFallbackMessage
} = {}) {
  const tokenDocument = resolveCurrentCombatToken(combat);
  const actor = tokenDocument?.actor ?? null;
  if (!actor || !isDesignatedEscapeClient(actor, user)) return [];

  const results = [];
  for (const effect of getStatusEscapeEffects(actor)) {
    const config = effect.flags[MODULE_ID].statusEscape;
    const turnKey = buildStatusEscapeTurnKey(combat, effect);
    if (!turnKey || config.attemptedTurnKey === turnKey || config.promptedTurnKey === turnKey || config.prompt?.enabled === false) continue;
    const dc = positiveNumber(config.resolvedDC);
    if (!dc) {
      results.push({ effectUuid: effect.uuid ?? null, prompted: false, reason: "missing-dc" });
      continue;
    }
    await updateEscapeState(effect, { promptedTurnKey: turnKey });
    await createFallback({ combat, tokenDocument, effect, turnKey });
    const confirmed = await showPrompt({ combat, tokenDocument, effect, turnKey });
    if (confirmed === true) {
      results.push(await attemptStatusEscape({ effect, tokenDocument, combat, turnKey, user }));
    } else {
      results.push({ effectUuid: effect.uuid ?? null, prompted: true, attempted: false, reason: "declined" });
    }
  }
  return results;
}

export async function attemptStatusEscape({
  effect = null,
  effectUuid = null,
  tokenDocument = null,
  tokenUuid = null,
  combat = globalThis.game?.combat ?? null,
  turnKey = null,
  user = globalThis.game?.user ?? null,
  allowOutsideCombat = false,
  resolveUuid = fromUuidSafe,
  rollAbility = rollNativeAbilityCheck,
  rollSkill = rollNativeSkillCheck,
  postResult = postStatusEscapeResult
} = {}) {
  effect ??= effectUuid ? await resolveUuid(effectUuid) : null;
  tokenDocument ??= tokenUuid ? await resolveUuid(tokenUuid) : null;
  const actor = effect?.parent ?? tokenDocument?.actor ?? null;
  if (!effect || effect?.documentName && effect.documentName !== "ActiveEffect") return { attempted: false, reason: "effect-not-found" };
  if (!actor || !isStatusEscapeAuthorized({ actor, user })) return { attempted: false, reason: "not-authorized" };
  const config = effect.flags?.[MODULE_ID]?.statusEscape;
  if (config?.enabled !== true) return { attempted: false, reason: "escape-disabled" };

  const activeToken = resolveCurrentCombatToken(combat);
  const effectiveTurnKey = turnKey ?? buildStatusEscapeTurnKey(combat, effect);
  if (!allowOutsideCombat) {
    if (!effectiveTurnKey || !activeToken || !sameActorOrToken(activeToken, tokenDocument, actor)) return { attempted: false, reason: "not-current-turn" };
  }
  if (effectiveTurnKey && config.attemptedTurnKey === effectiveTurnKey) return { attempted: false, reason: "already-attempted-this-turn" };

  if (effect.origin && !await resolveUuid(effect.origin)) return { attempted: false, reason: "source-not-found" };
  const dc = positiveNumber(config.resolvedDC);
  const checkType = normalizeChoice(config.checkType, ESCAPE_CHECK_TYPES, "ability");
  const ability = normalizeAbility(config.ability);
  const skill = normalizeSkill(config.skill);
  if (!dc || (checkType === "ability" && !ability) || (checkType === "skill" && !skill)) {
    return { attempted: false, reason: !dc ? "missing-dc" : checkType === "skill" ? "invalid-skill" : "invalid-ability" };
  }

  const pendingKey = effectiveTurnKey ?? effect.uuid ?? effect.id;
  if (pendingAttempts.has(pendingKey)) return { attempted: false, reason: "attempt-in-progress" };
  pendingAttempts.add(pendingKey);
  try {
    const rolls = checkType === "skill"
      ? await rollSkill({ actor, tokenDocument, skill, dc, effect })
      : await rollAbility({ actor, tokenDocument, ability, dc, effect });
    const rollTotal = resolveAbilityCheckTotal(rolls);
    if (rollTotal === null) return { attempted: false, reason: "roll-cancelled" };
    if (effectiveTurnKey) await updateEscapeState(effect, { attemptedTurnKey: effectiveTurnKey });
    const success = rollTotal >= dc;
    let effectRemoved = false;
    if (success && config.removeOnSuccess !== false) {
      const currentEffect = effect.uuid ? await resolveUuid(effect.uuid) : effect;
      if (currentEffect?.id && typeof actor.deleteEmbeddedDocuments === "function") {
        await actor.deleteEmbeddedDocuments("ActiveEffect", [currentEffect.id], {
          persistentZonesStatusEscape: true,
          persistentZonesStatusEscapeTurnKey: effectiveTurnKey
        });
        effectRemoved = true;
      }
    }
    const result = { attempted: true, success, rollTotal, dc, checkType, ability, skill: checkType === "skill" ? skill : null, effectRemoved, effectUuid: effect.uuid ?? null };
    await postResult({ ...result, actor, tokenDocument, effect, config });
    return result;
  } finally {
    pendingAttempts.delete(pendingKey);
  }
}

export function resolveAbilityCheckTotal(rolls) {
  const entries = Array.isArray(rolls) ? rolls : rolls ? [rolls] : [];
  const totals = entries.map((roll) => Number(roll?.total)).filter(Number.isFinite);
  return totals.length ? totals[0] : null;
}

async function onUpdateCombat(combat, changed = {}) {
  if (!combat?.started || !("turn" in changed || "round" in changed || "combatantId" in changed)) return;
  await processStatusEscapeTurn(combat);
}

function onRenderChatMessageHTML(message, html) {
  const action = html?.querySelector?.("[data-pz-status-escape-action]");
  if (!action) return;
  action.addEventListener("click", async (event) => {
    event.preventDefault();
    action.disabled = true;
    const flags = message?.flags?.[MODULE_ID]?.statusEscapeAction ?? {};
    const result = await attemptStatusEscape({
      effectUuid: flags.effectUuid,
      tokenUuid: flags.tokenUuid,
      turnKey: flags.turnKey
    });
    if (!result.attempted && result.reason === "already-attempted-this-turn") {
      globalThis.ui?.notifications?.warn?.(localize("PERSISTENT_ZONES.Escape.AlreadyAttempted"));
    }
    action.disabled = result.attempted || ["effect-not-found", "source-not-found", "not-current-turn"].includes(result.reason);
  });
}

async function showStatusEscapePrompt({ tokenDocument, effect }) {
  const config = effect.flags[MODULE_ID].statusEscape;
  const title = config.prompt?.title || localize("PERSISTENT_ZONES.Escape.Title");
  const content = buildEscapePromptContent({ tokenDocument, effect, config });
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.confirm) return false;
  return DialogV2.confirm({
    window: { title },
    content,
    yes: { label: localize("PERSISTENT_ZONES.Escape.Yes") },
    no: { label: localize("PERSISTENT_ZONES.Escape.No") },
    rejectClose: false
  });
}

async function createStatusEscapeFallbackMessage({ combat, tokenDocument, effect, turnKey }) {
  const config = effect.flags[MODULE_ID].statusEscape;
  if (!globalThis.ChatMessage?.create) return null;
  const content = `${buildEscapePromptContent({ tokenDocument, effect, config })}<p><button type="button" data-pz-status-escape-action>${escapeHtml(localize("PERSISTENT_ZONES.Escape.ManualAction"))}</button></p>`;
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker?.({ actor: tokenDocument.actor, token: tokenDocument }) ?? {},
    whisper: getEscapeAudienceIds(tokenDocument.actor),
    content,
    flags: {
      [MODULE_ID]: {
        statusEscapeAction: {
          effectUuid: effect.uuid ?? null,
          tokenUuid: tokenDocument.uuid ?? null,
          turnKey,
          combatId: combat?.id ?? null
        }
      }
    }
  });
}

async function rollNativeAbilityCheck({ actor, tokenDocument, ability }) {
  if (typeof actor?.rollAbilityCheck !== "function") return null;
  return actor.rollAbilityCheck(
    { ability },
    {},
    { data: { speaker: globalThis.ChatMessage?.getSpeaker?.({ actor, token: tokenDocument }) ?? {} } }
  );
}

async function rollNativeSkillCheck({ actor, tokenDocument, skill }) {
  if (typeof actor?.rollSkill !== "function") return null;
  return actor.rollSkill(
    { skill },
    {},
    { data: { speaker: globalThis.ChatMessage?.getSpeaker?.({ actor, token: tokenDocument }) ?? {} } }
  );
}

async function postStatusEscapeResult({ actor, tokenDocument, effect, config, rollTotal, dc, success, effectRemoved }) {
  if (!globalThis.ChatMessage?.create) return null;
  const checkLabel = getEscapeCheckLabel(config, actor);
  const outcome = localize(success ? "PERSISTENT_ZONES.Escape.Success" : "PERSISTENT_ZONES.Escape.Failure");
  const consequence = localize(effectRemoved ? "PERSISTENT_ZONES.Escape.EffectRemoved" : "PERSISTENT_ZONES.Escape.EffectRemains");
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker?.({ actor, token: tokenDocument }) ?? {},
    content: `<h3>${escapeHtml(actor?.name ?? "")} — ${escapeHtml(localize("PERSISTENT_ZONES.Escape.Title"))}</h3><p>${escapeHtml(checkLabel)}: <strong>${rollTotal}</strong><br>${escapeHtml(localize("PERSISTENT_ZONES.Escape.DC"))}: <strong>${dc}</strong></p><p><strong>${escapeHtml(outcome)}</strong><br>${escapeHtml(config.statusName ?? effect?.name ?? "")} — ${escapeHtml(consequence)}</p>`
  });
}

function buildEscapePromptContent({ tokenDocument, effect, config }) {
  const customMessage = nullableString(config.prompt?.message);
  const statusName = config.statusName ?? effect?.name ?? localize("PERSISTENT_ZONES.Escape.EffectFallback");
  const sourceName = config.sourceName ?? localize("PERSISTENT_ZONES.Escape.SourceFallback");
  const intro = customMessage ?? format("PERSISTENT_ZONES.Escape.Message", { effect: statusName, source: sourceName });
  return `<p>${escapeHtml(intro)}</p><p>${escapeHtml(localize("PERSISTENT_ZONES.Escape.UsesAction"))}</p><p>${escapeHtml(localize("PERSISTENT_ZONES.Escape.Check"))}: <strong>${escapeHtml(getEscapeCheckLabel(config, tokenDocument?.actor))}</strong><br>${escapeHtml(localize("PERSISTENT_ZONES.Escape.DC"))}: <strong>${Number(config.resolvedDC)}</strong></p><p>${escapeHtml(format("PERSISTENT_ZONES.Escape.SuccessRemoves", { effect: statusName }))}</p>`;
}

function resolveCurrentCombatToken(combat) {
  const combatant = combat?.combatant ?? combat?.combatants?.get?.(combat?.combatantId ?? "") ?? null;
  return combatant?.token?.document ?? combatant?.token ?? globalThis.game?.scenes?.get?.(combat?.sceneId)?.tokens?.get?.(combatant?.tokenId) ?? null;
}

function sameActorOrToken(activeToken, requestedToken, actor) {
  if (requestedToken && (activeToken.uuid === requestedToken.uuid || activeToken.id === requestedToken.id)) return true;
  return activeToken.actor?.uuid && activeToken.actor.uuid === actor?.uuid;
}

function isDesignatedEscapeClient(actor, user) {
  if (!isStatusEscapeAuthorized({ actor, user })) return false;
  const activeUsers = Array.from(globalThis.game?.users ?? []).filter((candidate) => candidate?.active !== false);
  const owners = activeUsers.filter((candidate) => !candidate.isGM && isStatusEscapeAuthorized({ actor, user: candidate }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (owners.length) return owners[0].id === user.id;
  const gms = activeUsers.filter((candidate) => candidate.isGM).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return gms[0]?.id === user.id;
}

function getEscapeAudienceIds(actor) {
  return Array.from(globalThis.game?.users ?? [])
    .filter((user) => user?.isGM || isStatusEscapeAuthorized({ actor, user }))
    .map((user) => user.id)
    .filter(Boolean);
}

async function updateEscapeState(effect, changes) {
  const config = { ...(effect.flags?.[MODULE_ID]?.statusEscape ?? {}), ...changes };
  if (effect.flags?.[MODULE_ID]) effect.flags[MODULE_ID].statusEscape = config;
  if (typeof effect.update === "function") await effect.update({ [`flags.${MODULE_ID}.statusEscape`]: config }, { persistentZonesStatusEscapeState: true });
}

function getAbilityLabel(ability) {
  const configured = globalThis.CONFIG?.DND5E?.abilities?.[ability];
  return localize(configured?.label ?? ability?.toUpperCase?.() ?? "");
}

export function getEscapeCheckLabel(config, actor = null) {
  if (normalizeChoice(config?.checkType, ESCAPE_CHECK_TYPES, "ability") !== "skill") return getAbilityLabel(config?.ability);
  const skill = normalizeSkill(config?.skill);
  const skillConfig = globalThis.CONFIG?.DND5E?.skills?.[skill] ?? {};
  const ability = actor?.system?.skills?.[skill]?.ability ?? skillConfig.ability ?? config?.ability;
  const skillLabel = localize(skillConfig.label ?? skill?.toUpperCase?.() ?? "");
  return `${getAbilityLabel(ability)} (${skillLabel})`;
}

function localize(key) {
  return globalThis.game?.i18n?.localize?.(key) ?? key;
}

function format(key, data) {
  return globalThis.game?.i18n?.format?.(key, data) ?? localize(key).replace(/\{(\w+)\}/g, (_match, name) => data[name] ?? "");
}

function escapeHtml(value) {
  const text = String(value ?? "");
  if (globalThis.foundry?.utils?.escapeHTML) return foundry.utils.escapeHTML(text);
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function normalizeAbility(value) {
  const ability = String(value ?? "").trim().toLowerCase();
  return ABILITY_IDS.has(ability) ? ability : null;
}

function normalizeSkill(value) {
  const skill = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(skill)) return null;
  const configuredSkills = globalThis.CONFIG?.DND5E?.skills;
  if (configuredSkills && Object.keys(configuredSkills).length && !Object.hasOwn(configuredSkills, skill)) return null;
  return skill;
}

function normalizeChoice(value, choices, fallback) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return choices.has(normalized) ? normalized : fallback;
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nullableString(value) {
  return String(value ?? "").trim() || null;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
