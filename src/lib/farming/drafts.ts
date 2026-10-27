/*
 * Records kept on the phone until they reach Tohyee (#447, decisions 911-913;
 * William's comment: "save a farm walk progressively"). Pure and
 * browser-safe: the page keeps the store in the browser's storage and sends
 * drafts with `syncDrafts`.
 *
 * - Every draft has its own operation id (a UUID) from the moment it's made.
 *   The server keeps it with the record, so sending it again (a sync replayed
 *   after the signal dropped) finds the first record instead of making a
 *   second (decision 912).
 * - Each draft belongs to the farm it was made on. Switching farms never
 *   moves a draft; it's sent to its own farm's address, which the server
 *   checks (decision 902).
 * - A draft is "Saved on this phone" until the server has it ("Synced"). If
 *   the server refuses it (another person's change, a retired paddock), it
 *   "Needs attention" and is never sent again by itself or written over.
 * - No signal (or the server down) leaves drafts saved, to try again later.
 */

export type DraftKind = "reading" | "grazing_in" | "grazing_out" | "feed";
export type DraftStatus = "saved" | "synced" | "attention";

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  saved: "Saved on this phone",
  synced: "Synced",
  attention: "Needs attention",
};

export type Draft = {
  operationId: string;
  farmId: string;
  farmName: string;
  kind: DraftKind;
  /** What it is, in words, for the list ("Paddock 16: 2,450 kg DM/ha"). */
  label: string;
  /** The body sent to the server, without organisationId. */
  payload: Record<string, unknown>;
  status: DraftStatus;
  error: string | null;
  /** Times a send was tried: once tried, the draft isn't changed in place (its first send may have arrived). */
  attempts: number;
  createdAt: string;
  /** The farm walk it's part of, and its paddock. */
  walkId: string | null;
  paddockId: string | null;
};

export type Walk = {
  walkId: string;
  farmId: string;
  farmName: string;
  measuredOn: string;
  method: string;
  /** The paddocks in walking order. */
  order: Array<{ paddockId: string; name: string }>;
  position: number;
  startedAt: string;
  finishedAt: string | null;
};

export type DraftStore = { version: 1; drafts: Draft[]; walks: Walk[] };

export const EMPTY_STORE: DraftStore = { version: 1, drafts: [], walks: [] };

/** A version 4 UUID from random bytes (crypto.getRandomValues works on plain http too, unlike randomUUID). */
export function newOperationId(randomBytes: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = randomBytes(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Reads a stored value, dropping anything that isn't a draft store (an old or damaged copy). */
export function parseStore(text: string | null): DraftStore {
  if (!text) return EMPTY_STORE;
  try {
    const value = JSON.parse(text) as Partial<DraftStore>;
    if (value?.version !== 1 || !Array.isArray(value.drafts) || !Array.isArray(value.walks)) return EMPTY_STORE;
    return { version: 1, drafts: value.drafts, walks: value.walks };
  } catch {
    return EMPTY_STORE;
  }
}

export function storeKey(userId: string, organisationId: string): string {
  return `tohyee.farmDrafts.v1.${encodeURIComponent(userId)}.${encodeURIComponent(organisationId)}`;
}

export function addDraft(store: DraftStore, draft: Omit<Draft, "status" | "error" | "attempts">): DraftStore {
  if (store.drafts.some((entry) => entry.operationId === draft.operationId)) return store;
  return { ...store, drafts: [...store.drafts, { ...draft, status: "saved", error: null, attempts: 0 }] };
}

function update(store: DraftStore, operationId: string, change: (draft: Draft) => Draft): DraftStore {
  return { ...store, drafts: store.drafts.map((draft) => (draft.operationId === operationId ? change(draft) : draft)) };
}

/**
 * A farm walk's reading for a paddock, as typed: a new draft, or the same
 * draft changed while it's still only on the phone and never sent. Once a
 * send was tried (or it's synced), a change is a new draft with a new id,
 * and the earlier one stays as it was.
 */
export function saveWalkReading(store: DraftStore, walk: Walk, paddock: { paddockId: string; name: string }, cover: number, operationId: () => string, now: string): DraftStore {
  const payload = { paddockId: paddock.paddockId, measuredOn: walk.measuredOn, cover, method: walk.method };
  const label = `Paddock ${paddock.name}: ${cover.toLocaleString("en-NZ")} kg DM/ha`;
  const existing = [...store.drafts].reverse().find((draft) => draft.walkId === walk.walkId && draft.paddockId === paddock.paddockId);
  if (existing && existing.status === "saved" && existing.attempts === 0) {
    return update(store, existing.operationId, (draft) => ({ ...draft, payload, label }));
  }
  if (existing && existing.payload.cover === cover) return store;
  return addDraft(store, { operationId: operationId(), farmId: walk.farmId, farmName: walk.farmName, kind: "reading", label, payload, createdAt: now, walkId: walk.walkId, paddockId: paddock.paddockId });
}

export function walkReading(store: DraftStore, walkId: string, paddockId: string): Draft | null {
  return [...store.drafts].reverse().find((draft) => draft.walkId === walkId && draft.paddockId === paddockId) ?? null;
}

export function startWalk(store: DraftStore, walk: Walk): DraftStore {
  return { ...store, walks: [...store.walks.filter((entry) => !(entry.farmId === walk.farmId && entry.finishedAt === null)), walk] };
}

export function moveWalk(store: DraftStore, walkId: string, position: number, finishedAt: string | null = null): DraftStore {
  return { ...store, walks: store.walks.map((walk) => (walk.walkId === walkId ? { ...walk, position: Math.max(0, Math.min(position, walk.order.length)), finishedAt } : walk)) };
}

/** The farm's walk in progress, if any: walks belong to the farm they were started on. */
export function openWalk(store: DraftStore, farmId: string): Walk | null {
  return store.walks.find((walk) => walk.farmId === farmId && walk.finishedAt === null) ?? null;
}

export function draftsFor(store: DraftStore, farmId: string): Draft[] {
  return store.drafts.filter((draft) => draft.farmId === farmId);
}

/** Drafts not synced yet, on farms other than this one: they wait for their own farm, and are shown so they aren't forgotten. */
export function waitingElsewhere(store: DraftStore, farmId: string): Array<{ farmId: string; farmName: string; count: number }> {
  const counts = new Map<string, { farmId: string; farmName: string; count: number }>();
  for (const draft of store.drafts) {
    if (draft.farmId === farmId || draft.status === "synced") continue;
    const entry = counts.get(draft.farmId) ?? { farmId: draft.farmId, farmName: draft.farmName, count: 0 };
    entry.count += 1;
    counts.set(draft.farmId, entry);
  }
  return [...counts.values()];
}

/** Synced drafts older than a week are let go, so the phone's copy doesn't grow forever. Unsynced ones are kept. */
export function prune(store: DraftStore, now: string): DraftStore {
  const cutoff = Date.parse(now) - 7 * 86_400_000;
  const drafts = store.drafts.filter((draft) => draft.status !== "synced" || Date.parse(draft.createdAt) >= cutoff);
  const walks = store.walks.filter((walk) => walk.finishedAt === null || drafts.some((draft) => draft.walkId === walk.walkId));
  return { ...store, drafts, walks };
}

/** Where a draft goes: its own farm's address, always (decision 902). */
export function draftRequest(draft: Draft): { method: "POST" | "PATCH"; path: string; body: Record<string, unknown> } {
  const body = { ...draft.payload, operationId: draft.operationId };
  switch (draft.kind) {
    case "reading":
      return { method: "POST", path: `/api/farming/farms/${draft.farmId}/pasture/readings`, body };
    case "grazing_in":
      return { method: "POST", path: `/api/farming/farms/${draft.farmId}/grazings`, body };
    case "feed":
      return { method: "POST", path: `/api/farming/farms/${draft.farmId}/supplements`, body };
    case "grazing_out": {
      const { grazingId, ...rest } = draft.payload;
      return { method: "PATCH", path: `/api/farming/grazings/${String(grazingId)}`, body: rest };
    }
  }
}

/** What happened to one send: done, refused (needs a person), or not reached (try later). */
export type SendResult = { outcome: "done" } | { outcome: "refused"; message: string } | { outcome: "unreachable" };

/** A failed send's outcome from its HTTP status: 4xx (bar sign-in, timeouts and limits) is a refusal; anything else is tried again. */
export function sendOutcome(status: number | null, message: string): SendResult {
  if (status !== null && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) return { outcome: "refused", message };
  return { outcome: "unreachable" };
}

/**
 * Sends the drafts still on the phone, oldest first, for one farm (or all
 * with null), one at a time. Stops at the first that can't reach the
 * server, so they're tried again in order later. `onChange` gets the store
 * after each draft, so the page can save it as it goes.
 */
export async function syncDrafts(store: DraftStore, farmId: string | null, send: (draft: Draft) => Promise<SendResult>, onChange: (store: DraftStore) => void = () => undefined): Promise<DraftStore> {
  let current = store;
  const queue = store.drafts.filter((draft) => draft.status === "saved" && (farmId === null || draft.farmId === farmId));
  for (const draft of queue) {
    current = update(current, draft.operationId, (entry) => ({ ...entry, attempts: entry.attempts + 1 }));
    onChange(current);
    const result = await send(draft);
    if (result.outcome === "unreachable") return current;
    current = update(current, draft.operationId, (entry) => (result.outcome === "done" ? { ...entry, status: "synced", error: null } : { ...entry, status: "attention", error: result.message }));
    onChange(current);
  }
  return current;
}

/** A refused draft, checked by a person, can be let go. */
export function dismissDraft(store: DraftStore, operationId: string): DraftStore {
  return { ...store, drafts: store.drafts.filter((draft) => draft.operationId !== operationId || draft.status !== "attention") };
}
