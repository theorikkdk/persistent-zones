import { MODULE_ID } from "../constants.mjs";
import {
  debug,
  duplicateData,
  fromUuidSafe,
  isPlainObject,
  pickFirstDefined,
  safeGet
} from "./utils.mjs";

const ITEM_UUID_PATHS = [
  ["flags", MODULE_ID, "itemUuid"],
  ["flags", "dnd5e", "itemUuid"],
  ["flags", "dnd5e", "item", "uuid"],
  ["flags", "dnd5e", "origin", "item", "uuid"],
  ["flags", "dnd5e", "activity", "item", "uuid"],
  ["flags", "dnd5e", "usage", "item", "uuid"],
  ["flags", "dnd5e", "spell", "item", "uuid"],
  ["flags", "dnd5e", "activity", "itemUuid"],
  ["flags", "dnd5e", "usage", "itemUuid"],
  ["flags", "dnd5e", "spell", "itemUuid"],
  ["flags", "dnd5e", "origin", "itemUuid"],
  ["flags", "dnd5e", "source", "itemUuid"],
  ["system", "itemUuid"],
  ["system", "source", "itemUuid"]
];

const ITEM_ID_PATHS = [
  ["flags", MODULE_ID, "itemId"],
  ["flags", "dnd5e", "itemId"],
  ["flags", "dnd5e", "item", "id"],
  ["flags", "dnd5e", "origin", "item", "id"],
  ["flags", "dnd5e", "activity", "item", "id"],
  ["flags", "dnd5e", "usage", "item", "id"],
  ["flags", "dnd5e", "spell", "item", "id"],
  ["flags", "dnd5e", "activity", "itemId"],
  ["flags", "dnd5e", "usage", "itemId"],
  ["flags", "dnd5e", "spell", "itemId"],
  ["flags", "dnd5e", "origin", "itemId"],
  ["flags", "dnd5e", "source", "itemId"],
  ["system", "itemId"],
  ["system", "source", "itemId"]
];

const ACTOR_UUID_PATHS = [
  ["flags", MODULE_ID, "actorUuid"],
  ["flags", MODULE_ID, "casterUuid"],
  ["flags", "dnd5e", "actorUuid"],
  ["flags", "dnd5e", "casterUuid"],
  ["flags", "dnd5e", "origin", "actor", "uuid"],
  ["flags", "dnd5e", "activity", "actor", "uuid"],
  ["flags", "dnd5e", "usage", "actor", "uuid"],
  ["flags", "dnd5e", "activity", "actorUuid"],
  ["flags", "dnd5e", "usage", "actorUuid"],
  ["flags", "dnd5e", "origin", "actorUuid"],
  ["flags", "dnd5e", "origin", "casterUuid"],
  ["flags", "dnd5e", "source", "actorUuid"],
  ["system", "actorUuid"],
  ["system", "casterUuid"]
];

const ACTOR_ID_PATHS = [
  ["flags", MODULE_ID, "actorId"],
  ["flags", MODULE_ID, "casterId"],
  ["flags", "dnd5e", "actorId"],
  ["flags", "dnd5e", "casterId"],
  ["flags", "dnd5e", "origin", "actor", "id"],
  ["flags", "dnd5e", "activity", "actor", "id"],
  ["flags", "dnd5e", "usage", "actor", "id"],
  ["flags", "dnd5e", "activity", "actorId"],
  ["flags", "dnd5e", "usage", "actorId"],
  ["flags", "dnd5e", "origin", "actorId"],
  ["flags", "dnd5e", "origin", "casterId"],
  ["flags", "dnd5e", "source", "actorId"],
  ["system", "actorId"],
  ["system", "casterId"]
];

const REFERENCE_UUID_PATHS = [
  ["flags", "core", "sourceId"],
  ["flags", "dnd5e", "origin"],
  ["flags", "dnd5e", "origin", "uuid"],
  ["flags", "dnd5e", "source", "uuid"],
  ["flags", "dnd5e", "message", "uuid"],
  ["flags", "dnd5e", "activity", "sourceUuid"],
  ["flags", "dnd5e", "usage", "sourceUuid"],
  ["flags", "dnd5e", "spell", "sourceUuid"],
  ["flags", "dnd5e", "activityUuid"],
  ["flags", "dnd5e", "activity", "uuid"],
  ["flags", "dnd5e", "usageUuid"],
  ["flags", "dnd5e", "usage", "uuid"],
  ["flags", "dnd5e", "spell", "uuid"],
  ["system", "origin"],
  ["system", "source", "uuid"]
];

export async function resolveTemplateSourceContext(
  templateDocument,
  { emitDebug = true } = {}
) {
  const snapshot = collectTemplateSourceDebugSnapshot(templateDocument);
  const report = {
    templateId: templateDocument?.id ?? null,
    templateUuid: templateDocument?.uuid ?? null,
    templateType: templateDocument?.t ?? null,
    attempted: [],
    matched: [],
    notes: []
  };

  const directItem = normalizeResolvedItem(templateDocument?.item ?? null);
  if (directItem) {
    const actor = directItem.actor ?? null;
    const caster = actor ?? null;
    recordMatch(report, "direct-item", "template.item", directItem.uuid);
    emitResolutionLog("resolved", report, snapshot, { item: directItem, actor, caster }, emitDebug);
    return { item: directItem, actor, caster, report, snapshot };
  }

  const referenceCandidates = [
    ...collectCandidatesFromPaths(templateDocument, ITEM_UUID_PATHS, "item-uuid"),
    ...collectCandidatesFromPaths(templateDocument, ACTOR_UUID_PATHS, "actor-uuid"),
    ...collectCandidatesFromPaths(templateDocument, REFERENCE_UUID_PATHS, "reference-uuid"),
    ...collectRecursiveUuidCandidates(snapshot.flags, "flags"),
    ...collectRecursiveUuidCandidates(snapshot.system, "system")
  ];

  const referenceContext = await resolveFromReferenceCandidates(referenceCandidates, report);
  let item = referenceContext.item;
  let actor = referenceContext.actor;
  let caster = referenceContext.caster;

  actor = actor ?? resolveActorFromIds(collectCandidatesFromPaths(templateDocument, ACTOR_ID_PATHS, "actor-id"), report);
  caster = caster ?? actor ?? null;

  if (!item) {
    item = await resolveItemFromActorAndIds(
      actor,
      collectCandidatesFromPaths(templateDocument, ITEM_ID_PATHS, "item-id"),
      report
    );
  }

  if (!actor && item?.actor) {
    actor = item.actor;
    caster = caster ?? actor;
    recordMatch(report, "item-actor", "item.actor", actor.uuid);
  }

  if (!item) {
    report.notes.push("No linked Item could be resolved from template metadata.");
  }

  emitResolutionLog(item ? "resolved" : "unresolved", report, snapshot, { item, actor, caster }, emitDebug);
  return { item: item ?? null, actor: actor ?? null, caster: caster ?? actor ?? null, report, snapshot };
}

export function collectTemplateSourceDebugSnapshot(templateDocument) {
  const objectData =
    duplicateData(templateDocument?.toObject?.()) ??
    duplicateData(templateDocument) ??
    {};

  return {
    id: templateDocument?.id ?? null,
    uuid: templateDocument?.uuid ?? null,
    type: templateDocument?.t ?? null,
    flags: duplicateData(objectData.flags ?? {}),
    system: duplicateData(objectData.system ?? {}),
    raw: objectData
  };
}

async function resolveFromReferenceCandidates(candidates, report) {
  for (const candidate of dedupeCandidates(candidates)) {
    const value = candidate.value;
    if (!looksLikeUuid(value)) {
      recordAttempt(report, candidate.kind, candidate.path, value, "ignored-non-uuid");
      continue;
    }

    const resolved = await fromUuidSafe(value);
    if (!resolved) {
      recordAttempt(report, candidate.kind, candidate.path, value, "uuid-unresolved");
      continue;
    }

    const item = normalizeResolvedItemFromUnknown(resolved);
    const actor = normalizeResolvedActorFromUnknown(resolved);
    recordAttempt(report, candidate.kind, candidate.path, value, item || actor ? "resolved-related-document" : "resolved-unrelated-document");

    if (item || actor) {
      if (item) {
        recordMatch(report, candidate.kind, candidate.path, item.uuid);
      }
      if (actor) {
        recordMatch(report, candidate.kind, candidate.path, actor.uuid);
      }
      return { item, actor, caster: actor ?? null };
    }
  }

  return { item: null, actor: null, caster: null };
}

function resolveActorFromIds(candidates, report) {
  for (const candidate of dedupeCandidates(candidates)) {
    const actor = game.actors?.get?.(candidate.value) ?? null;
    recordAttempt(report, candidate.kind, candidate.path, candidate.value, actor ? "resolved-actor-id" : "actor-id-not-found");
    if (actor) {
      recordMatch(report, candidate.kind, candidate.path, actor.uuid);
      return actor;
    }
  }

  return null;
}

async function resolveItemFromActorAndIds(actor, candidates, report) {
  if (!actor) {
    return null;
  }

  for (const candidate of dedupeCandidates(candidates)) {
    const item = actor.items?.get?.(candidate.value) ?? null;
    recordAttempt(report, candidate.kind, candidate.path, candidate.value, item ? "resolved-item-id" : "item-id-not-found-on-actor");
    if (item) {
      recordMatch(report, candidate.kind, candidate.path, item.uuid);
      return item;
    }
  }

  return null;
}

function collectCandidatesFromPaths(source, paths, kind) {
  const candidates = [];

  for (const path of paths) {
    const rawValue = safeGet(source, path);
    if (rawValue === undefined || rawValue === null || rawValue === "") {
      continue;
    }

    const pathLabel = path.join(".");
    if (typeof rawValue === "string") {
      candidates.push({ kind, path: pathLabel, value: rawValue });
      continue;
    }

    if (isPlainObject(rawValue)) {
      for (const nestedString of extractNestedCandidateStrings(rawValue)) {
        candidates.push({
          kind,
          path: `${pathLabel}.${nestedString.path}`,
          value: nestedString.value
        });
      }
    }
  }

  return candidates;
}

function collectRecursiveUuidCandidates(rootValue, rootPath) {
  const leaves = [];
  walkCandidateStrings(rootValue, rootPath, leaves);

  return leaves
    .filter((entry) => looksLikeUuid(entry.value))
    .map((entry) => ({
      kind: "recursive-uuid",
      path: entry.path,
      value: entry.value
    }));
}

function walkCandidateStrings(currentValue, currentPath, collector) {
  if (typeof currentValue === "string") {
    collector.push({ path: currentPath, value: currentValue });
    return;
  }

  if (Array.isArray(currentValue)) {
    currentValue.forEach((entry, index) => walkCandidateStrings(entry, `${currentPath}[${index}]`, collector));
    return;
  }

  if (!isPlainObject(currentValue)) {
    return;
  }

  for (const [key, value] of Object.entries(currentValue)) {
    walkCandidateStrings(value, `${currentPath}.${key}`, collector);
  }
}

function extractNestedCandidateStrings(source) {
  const leaves = [];
  walkCandidateStrings(source, "", leaves);
  return leaves.map((entry) => ({
    path: entry.path.replace(/^\./, ""),
    value: entry.value
  }));
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const uniqueCandidates = [];

  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.path}:${candidate.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueCandidates.push(candidate);
  }

  return uniqueCandidates;
}

function looksLikeUuid(value) {
  return typeof value === "string" && /^[A-Za-z]+\.[A-Za-z0-9._-]+/.test(value);
}

function normalizeResolvedItemFromUnknown(resolvedDocument) {
  let current = resolvedDocument;

  for (let depth = 0; depth < 6 && current; depth += 1) {
    const directItem = normalizeResolvedItem(current);
    if (directItem) {
      return directItem;
    }

    current = current.parent ?? current.item ?? null;
  }

  return null;
}

function normalizeResolvedActorFromUnknown(resolvedDocument) {
  let current = resolvedDocument;

  for (let depth = 0; depth < 6 && current; depth += 1) {
    const directActor = normalizeResolvedActor(current);
    if (directActor) {
      return directActor;
    }

    current = current.parent ?? current.actor ?? null;
  }

  return null;
}

function normalizeResolvedItem(resolvedDocument) {
  if (!resolvedDocument) {
    return null;
  }

  if (resolvedDocument.documentName === "Item") {
    return resolvedDocument;
  }

  if (resolvedDocument.parent?.documentName === "Item") {
    return resolvedDocument.parent;
  }

  return null;
}

function normalizeResolvedActor(resolvedDocument) {
  if (!resolvedDocument) {
    return null;
  }

  if (resolvedDocument.documentName === "Actor") {
    return resolvedDocument;
  }

  if (resolvedDocument.parent?.documentName === "Actor") {
    return resolvedDocument.parent;
  }

  if (resolvedDocument.actor?.documentName === "Actor") {
    return resolvedDocument.actor;
  }

  return null;
}

function recordAttempt(report, kind, path, value, result) {
  report.attempted.push({ kind, path, value: shortenValue(value), result });
}

function recordMatch(report, kind, path, value) {
  report.matched.push({ kind, path, value: shortenValue(value) });
}

function emitResolutionLog(status, report, snapshot, context, emitDebug) {
  if (!emitDebug) {
    return;
  }

  debug(`Template source context ${status}.`, {
    templateId: report.templateId,
    templateUuid: report.templateUuid,
    templateType: report.templateType,
    found: {
      itemUuid: context.item?.uuid ?? null,
      actorUuid: context.actor?.uuid ?? null,
      casterUuid: context.caster?.uuid ?? null
    },
    attempted: report.attempted,
    matched: report.matched,
    notes: report.notes,
    snapshot: {
      flags: snapshot.flags,
      system: snapshot.system
    }
  });
}

function shortenValue(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}
