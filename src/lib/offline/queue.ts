/*
 * The device's queue of work waiting for the server (#472, decisions
 * 995-998). One durable queue in IndexedDB for everything recorded on a
 * phone or tablet: farm Log records, safety reports, checks, sign-offs,
 * photos, and finished tractor jobs (#472 stage 5, decision 1028). It generalises #447's drafts
 * (decisions 912-913, 971-972) and keeps their rules:
 *
 * - Every item has a stable operation id (a UUID made on the device) that
 *   is sent with it, so a send repeated after a dropped connection finds
 *   the first record instead of making a second.
 * - Items belong to one server, account and organisation (the scope), and
 *   to the farm they were made on. Switching farms or organisations never
 *   moves one.
 * - Statuses are honest: Unsaved (the device's storage refused it: only
 *   this page has it), Saved on this device (kept, not ready to send, such
 *   as a run still being recorded), Waiting to send, Synced (the server
 *   said it was recorded), Needs attention (the server refused it, with
 *   its reason; never sent again by itself).
 * - The latest stored copy is read before each send, and only the item
 *   being sent changes. Once a send has been tried an item isn't changed in
 *   place (its first send may have arrived): a change is a new item.
 * - Files (photos) are kept as blobs beside the item and put into the
 *   request (base64) only when it's sent. A later item can use an earlier
 *   one's result (a report naming the photo uploaded before it) through
 *   `refs`; it waits until that one is synced.
 * - Approvals are never queued: `addToQueue` refuses kinds marked
 *   server-only (decision 998).
 *
 * The API (for screens and tractor mode):
 *
 *   const queue = await openQueue({ server: location.origin, userId, organisationId });
 *   const { item, stored } = await queue.add({ kind: "safety.report", label, farmId, farmName,
 *     request: { method: "POST", path: "/api/farming/safety/reports", body } });
 *   queue.subscribe(() => render(queue.items({ farmId })));
 *   await queue.sync();            // also run by OfflineSync when online, on resume and every 30 s
 *   queue.shownStatus(item);       // "unsaved" | "saved" | "waiting" | "synced" | "attention"
 *
 * `organisationId` and `operationId` are added to every request body when
 * it's sent. Browser-safe; tests use fake-indexeddb.
 */

import { expectedAccountHeaders, isAccountChanged } from "./account";
import { isQuotaError, openOfflineDb, request } from "./idb";

export type QueueScope = { server: string; userId: string; organisationId: string };

/** The key items are kept under: server, account and organisation (decision 993). */
export function scopeKey(scope: QueueScope): string {
  return [scope.server, scope.userId, scope.organisationId].map(encodeURIComponent).join("|");
}

export type QueueStatus = "saved" | "waiting" | "synced" | "attention";
export type ShownStatus = QueueStatus | "unsaved";

export const QUEUE_STATUS_LABELS: Record<ShownStatus, string> = {
  unsaved: "Unsaved",
  saved: "Saved on this device",
  waiting: "Waiting to send",
  synced: "Synced",
  attention: "Needs attention",
};

/** What each status means, for a screen's help text. */
export const QUEUE_STATUS_HELP: Record<ShownStatus, string> = {
  unsaved: "This device's storage wouldn't keep it. Keep this screen open until it's sent.",
  saved: "Kept on this device. It isn't ready to send yet.",
  waiting: "Kept on this device. It goes when Tohyee can be reached. Nobody has been told yet.",
  synced: "Tohyee has it.",
  attention: "Tohyee refused it. Check the reason, then fix it or let it go.",
};

/** A value in the request body taken from an earlier item's result, once that's synced. */
export type QueueRef = {
  /** Where in this item's body, e.g. ["files", "0", "id"]. */
  path: string[];
  /** The earlier item's operation id. */
  from: string;
  /** Where in that item's result, e.g. ["file", "id"]. */
  field: string[];
};

/** A file to put in the body, as base64, when the item is sent. */
export type QueueFileField = { blob: string; field: string };

export type QueueRequest = {
  method: "POST" | "PUT" | "PATCH";
  /** A same-server API path, e.g. "/api/farming/safety/reports". */
  path: string;
  /** Without organisationId and operationId: they're added when sent. */
  body: Record<string, unknown>;
  refs?: QueueRef[];
  files?: QueueFileField[];
};

export type QueueItem = {
  operationId: string;
  scope: string;
  userId: string;
  organisationId: string;
  farmId: string | null;
  farmName: string | null;
  /** What it is, e.g. "safety.report", "farm.reading", "tractor.job". */
  kind: string;
  /** In words, for lists ("Near miss: tractor on the race"). */
  label: string;
  request: QueueRequest;
  status: QueueStatus;
  /** Sends tried. Once tried, the item isn't changed in place. */
  attempts: number;
  error: string | null;
  /** The server's answer when synced (small JSON), for later items' refs. */
  result: unknown;
  /** The device's clock: when it was made, last changed, and synced. */
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
  /** Small facts for the screen that made it (the machine checked, a walk's paddock); never sent. */
  meta: Record<string, unknown>;
};

export type NewQueueItem = {
  operationId?: string;
  kind: string;
  label: string;
  farmId: string | null;
  farmName: string | null;
  request: QueueRequest;
  /** False keeps it "Saved on this device" until `markReady` (a run still being recorded). Default true. */
  ready?: boolean;
  /** Files kept with it, by name (photos as compressed copies). */
  blobs?: Record<string, Blob>;
  /** Small facts for the screen that made it; never sent. */
  meta?: Record<string, unknown>;
};

/**
 * Kinds that must never wait in the queue: approvals need the server's
 * current permission at the moment they're given (decision 998).
 */
export const SERVER_ONLY_KINDS = new Set(["safety.release", "safety.action.check", "safety.action.close", "safety.action.reopen", "permission.change"]);

export type SendResult = { outcome: "done"; result: unknown } | { outcome: "refused"; message: string } | { outcome: "unreachable"; signIn?: boolean; accountChanged?: boolean };

/** A failed send's outcome from its HTTP status: 4xx (bar sign-in, timeouts and limits) is a refusal; anything else is tried again. */
export function sendOutcome(status: number | null, message: string): SendResult {
  if (status === 401) return { outcome: "unreachable", signIn: true };
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return { outcome: "refused", message };
  return { outcome: "unreachable" };
}

export type Sender = (item: QueueItem, body: Record<string, unknown>) => Promise<SendResult>;

/**
 * Sends with fetch to the item's own server (same origin), with Origin set
 * by the browser. Each send names the account that made the item; if the
 * browser is now signed in as someone else, Tohyee refuses it and it stays
 * waiting for its own account (decision 1050).
 */
export function fetchSender(fetcher: typeof fetch = fetch): Sender {
  return async (item, body) => {
    let response: Response;
    try {
      response = await fetcher(item.request.path, {
        method: item.request.method,
        headers: { "content-type": "application/json", ...expectedAccountHeaders(item.userId) },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch {
      return { outcome: "unreachable" };
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok) return { outcome: "done", result: payload };
    if (isAccountChanged(response.status, payload)) return { outcome: "unreachable", accountChanged: true };
    const message = payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string" ? (payload as { error: string }).error : `Tohyee refused it (${response.status}).`;
    return sendOutcome(response.status, message);
  };
}

/** A version 4 UUID from random bytes (getRandomValues works on plain http too, unlike randomUUID). */
export function newOperationId(randomBytes: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = randomBytes(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = target;
  path.forEach((key, index) => {
    if (index === path.length - 1) {
      current[key] = value;
      return;
    }
    const next = current[key];
    const copy = Array.isArray(next) ? [...next] : next && typeof next === "object" ? { ...(next as object) } : /^\d+$/.test(path[index + 1]) ? [] : {};
    current[key] = copy;
    current = copy as Record<string, unknown>;
  });
}

/** Why an item can't be sent yet: an earlier item it uses isn't synced. Null when it can go. */
export function blockedBy(item: QueueItem, all: QueueItem[]): QueueItem | "missing" | null {
  for (const ref of item.request.refs ?? []) {
    const source = all.find((entry) => entry.operationId === ref.from);
    if (!source) return "missing";
    if (source.status !== "synced") return source;
  }
  return null;
}

/** The body as sent: refs filled in from earlier results, organisationId and operationId added. Files are added by the queue. */
export function bodyToSend(item: QueueItem, all: QueueItem[]): Record<string, unknown> {
  const body: Record<string, unknown> = structuredClone(item.request.body);
  for (const ref of item.request.refs ?? []) {
    const source = all.find((entry) => entry.operationId === ref.from);
    setPath(body, ref.path, getPath(source?.result, ref.field));
  }
  return { ...body, organisationId: item.organisationId, operationId: item.operationId };
}

/** Synced items are let go after a week, unless something still waiting uses them. Unsynced items are always kept. */
export function itemsToPrune(items: QueueItem[], now: string): QueueItem[] {
  const cutoff = Date.parse(now) - 7 * 86_400_000;
  const needed = new Set(items.filter((item) => item.status !== "synced").flatMap((item) => (item.request.refs ?? []).map((ref) => ref.from)));
  return items.filter((item) => item.status === "synced" && Date.parse(item.syncedAt ?? item.updatedAt) < cutoff && !needed.has(item.operationId));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

type BlobRecord = { key: string; operationId: string; name: string; blob: Blob };

export type SyncReport = { sent: number; refused: number; stoppedBecause: "done" | "unreachable" | "sign_in" | "account_changed" | "held" | "busy" };

export type OfflineQueue = {
  readonly scope: QueueScope;
  /** Every item for this scope, oldest first (optionally one farm's). */
  items(filter?: { farmId?: string | null; kind?: string }): QueueItem[];
  /** The status to show: "unsaved" when the device's storage hasn't got the latest copy. */
  shownStatus(item: QueueItem): ShownStatus;
  /** Items not yet synced (for the sign-out warning). */
  unsentCount(): number;
  /** The last storage problem in words (full, blocked), or null. */
  storageProblem(): string | null;
  add(item: NewQueueItem): Promise<{ item: QueueItem; stored: boolean }>;
  /** Changes an item never sent (label, body, ready). Refused once a send was tried: make a new item. */
  change(operationId: string, patch: { label?: string; body?: Record<string, unknown>; ready?: boolean; meta?: Record<string, unknown> }): Promise<{ item: QueueItem; stored: boolean }>;
  /** Saved on this device → Waiting to send. */
  markReady(operationId: string): Promise<{ item: QueueItem; stored: boolean }>;
  /** Keeps or replaces a file for an item before its first send. (Tractor mode keeps its track fix by fix in its own store and hands over a finished job: decision 1029.) */
  putBlob(operationId: string, name: string, blob: Blob): Promise<boolean>;
  blob(operationId: string, name: string): Promise<Blob | null>;
  /** Lets go of an item that needs attention or is synced. Never one still waiting. */
  dismiss(operationId: string): Promise<void>;
  /** Sends what's waiting, oldest first, stopping at the first that can't reach Tohyee. */
  sync(sender?: Sender): Promise<SyncReport>;
  /** Re-reads the device's copy (another tab changed it). */
  reload(): Promise<void>;
  /** Tries again to store what only this page has (storage was full or blocked). True when the device now has everything. */
  retryStorage(): Promise<boolean>;
  subscribe(listener: () => void): () => void;
};

export type QueueOptions = {
  factory?: IDBFactory | null;
  now?: () => string;
  locks?: LockManager | null;
  channel?: boolean;
  /**
   * Checked before each send: false holds everything (this tab's account
   * was signed out and someone else signed in, decision 1051).
   */
  maySend?: () => boolean;
};

let held = false;
function sendingAllowed(): boolean {
  return !held;
}

/**
 * Holds every queue in this page (true) or lets them send again. Used when
 * this tab's account was signed out and someone else signed in elsewhere
 * in the browser (decision 1051): its work waits for its own account.
 */
export function holdSending(hold: boolean): void {
  held = hold;
}

/** Opens the queue for one server, account and organisation. Rejects only when the device has no IndexedDB at all. */
export async function openQueue(scope: QueueScope, options: QueueOptions = {}): Promise<OfflineQueue> {
  const db = await openOfflineDb(options.factory === undefined ? undefined : options.factory);
  const now = options.now ?? (() => new Date().toISOString());
  const key = scopeKey(scope);
  const listeners = new Set<() => void>();
  /** Items whose latest copy only this page has (storage refused it). */
  const unstored = new Map<string, QueueItem>();
  const unstoredBlobs = new Map<string, BlobRecord>();
  let items: QueueItem[] = [];
  let problem: string | null = null;
  const channel = options.channel !== false && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("tohyee-offline-queue") : null;

  const notify = () => listeners.forEach((listener) => listener());

  async function readAll(): Promise<QueueItem[]> {
    const stored = await db.all<QueueItem>("queue", "scope", key);
    const merged = new Map(stored.map((item) => [item.operationId, item]));
    for (const [id, item] of unstored) merged.set(id, item);
    return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId));
  }

  async function put(item: QueueItem, blobs: BlobRecord[] = []): Promise<boolean> {
    for (const record of blobs) unstoredBlobs.set(record.key, record);
    unstored.set(item.operationId, item);
    items = [...items.filter((entry) => entry.operationId !== item.operationId), item].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId));
    const stored = await flush();
    notify();
    channel?.postMessage({ scope: key });
    return stored && !unstored.has(item.operationId);
  }

  /** Writes everything only this page has. True when the device now has it all. */
  async function flush(): Promise<boolean> {
    if (unstored.size === 0 && unstoredBlobs.size === 0) return true;
    const pending = [...unstored.values()];
    const blobs = [...unstoredBlobs.values()];
    try {
      await db.write(["queue", "blobs"], (tx) => {
        for (const item of pending) tx.objectStore("queue").put(item);
        for (const record of blobs) tx.objectStore("blobs").put(record);
      });
      for (const item of pending) if (unstored.get(item.operationId) === item) unstored.delete(item.operationId);
      for (const record of blobs) if (unstoredBlobs.get(record.key) === record) unstoredBlobs.delete(record.key);
      problem = null;
      return true;
    } catch (error) {
      problem = isQuotaError(error) ? "This device's storage is full. Free some space (or remove offline copies under Offline storage), then try again." : "This device's storage wouldn't keep it (private browsing or blocked storage).";
      return false;
    }
  }

  async function latest(operationId: string): Promise<QueueItem | undefined> {
    return unstored.get(operationId) ?? (await db.get<QueueItem>("queue", operationId));
  }

  async function reload() {
    items = await readAll();
    notify();
  }

  channel?.addEventListener("message", (event: MessageEvent<{ scope?: string }>) => {
    if (event.data?.scope === key) void reload();
  });

  // Let go of old synced items (and their files).
  await reload();
  const old = itemsToPrune(items, now());
  if (old.length) {
    try {
      await db.write(["queue", "blobs"], (tx) => {
        for (const item of old) {
          tx.objectStore("queue").delete(item.operationId);
          tx.objectStore("blobs").delete(IDBKeyRange.bound(`${item.operationId}/`, `${item.operationId}/￿`));
        }
      });
      await reload();
    } catch {
      // Not letting go is safe.
    }
  }

  async function sendOne(item: QueueItem, all: QueueItem[], sender: Sender): Promise<SendResult> {
    const body = bodyToSend(item, all);
    for (const file of item.request.files ?? []) {
      const blob = await getBlob(item.operationId, file.blob);
      if (!blob) return { outcome: "refused", message: "Its photo or file is no longer on this device." };
      body[file.field] = await blobToBase64(blob);
    }
    return sender(item, body);
  }

  async function getBlob(operationId: string, name: string): Promise<Blob | null> {
    const blobKey = `${operationId}/${name}`;
    const own = unstoredBlobs.get(blobKey);
    if (own) return own.blob;
    const record = await db.get<BlobRecord>("blobs", blobKey);
    return record?.blob ?? null;
  }

  async function runSync(sender: Sender): Promise<SyncReport> {
    await flush();
    const report: SyncReport = { sent: 0, refused: 0, stoppedBecause: "done" };
    const tried = new Set<string>();
    for (;;) {
      if (!(options.maySend ?? sendingAllowed)()) {
        report.stoppedBecause = "held";
        break;
      }
      const all = await readAll();
      const next = all.find((item) => item.status === "waiting" && !tried.has(item.operationId) && blockedBy(item, all) === null);
      if (!next) break;
      // Never another account's or organisation's item, whatever is signed in (decision 1050).
      if (next.scope !== key || next.userId !== scope.userId || next.organisationId !== scope.organisationId) break;
      tried.add(next.operationId);
      const attempt: QueueItem = { ...next, attempts: next.attempts + 1, updatedAt: now() };
      await put(attempt);
      const result = await sendOne(attempt, all, sender);
      if (result.outcome === "unreachable") {
        report.stoppedBecause = result.accountChanged ? "account_changed" : result.signIn ? "sign_in" : "unreachable";
        break;
      }
      // Only this item changes, from its latest stored copy.
      const current = (await latest(next.operationId)) ?? attempt;
      if (result.outcome === "done") {
        report.sent += 1;
        await put({ ...current, status: "synced", error: null, result: result.result ?? null, syncedAt: now(), updatedAt: now() });
        // Its files are on the server now.
        try {
          await db.write(["blobs"], (tx) => tx.objectStore("blobs").delete(IDBKeyRange.bound(`${next.operationId}/`, `${next.operationId}/￿`)));
        } catch {
          // Kept a little longer; pruned with the item.
        }
      } else {
        report.refused += 1;
        await put({ ...current, status: "attention", error: result.message, updatedAt: now() });
      }
    }
    await reload();
    return report;
  }

  const queue: OfflineQueue = {
    scope,
    items(filter = {}) {
      return items.filter((item) => (filter.farmId === undefined || item.farmId === filter.farmId) && (filter.kind === undefined || item.kind === filter.kind));
    },
    shownStatus(item) {
      return unstored.has(item.operationId) ? "unsaved" : item.status;
    },
    unsentCount() {
      return items.filter((item) => item.status !== "synced").length;
    },
    storageProblem() {
      return problem;
    },
    async add(input) {
      if (SERVER_ONLY_KINDS.has(input.kind)) throw new Error("This needs Tohyee to be reachable: approvals are never saved for later.");
      const operationId = input.operationId ?? newOperationId();
      const existing = items.find((item) => item.operationId === operationId);
      if (existing) return { item: existing, stored: !unstored.has(operationId) };
      const time = now();
      const item: QueueItem = {
        operationId,
        scope: key,
        userId: scope.userId,
        organisationId: scope.organisationId,
        farmId: input.farmId,
        farmName: input.farmName,
        kind: input.kind,
        label: input.label,
        request: input.request,
        status: input.ready === false ? "saved" : "waiting",
        attempts: 0,
        error: null,
        result: null,
        createdAt: time,
        updatedAt: time,
        syncedAt: null,
        meta: input.meta ?? {},
      };
      const blobs = Object.entries(input.blobs ?? {}).map(([name, blob]) => ({ key: `${operationId}/${name}`, operationId, name, blob }));
      const stored = await put(item, blobs);
      return { item, stored };
    },
    async change(operationId, patch) {
      const current = await latest(operationId);
      if (!current || current.scope !== key) throw new Error("That record isn't on this device.");
      if (current.attempts > 0 || current.status === "synced" || current.status === "attention") throw new Error("It may already have reached Tohyee, so it can't be changed here. Record the change as a new one.");
      const item: QueueItem = {
        ...current,
        label: patch.label ?? current.label,
        request: patch.body ? { ...current.request, body: patch.body } : current.request,
        status: patch.ready === undefined ? current.status : patch.ready ? "waiting" : "saved",
        meta: patch.meta ?? current.meta,
        updatedAt: now(),
      };
      return { item, stored: await put(item) };
    },
    async markReady(operationId) {
      return queue.change(operationId, { ready: true });
    },
    async putBlob(operationId, name, blob) {
      const current = await latest(operationId);
      if (!current || current.scope !== key) throw new Error("That record isn't on this device.");
      if (current.attempts > 0) throw new Error("It may already have reached Tohyee, so its files can't be changed.");
      const record = { key: `${operationId}/${name}`, operationId, name, blob };
      unstoredBlobs.set(record.key, record);
      const stored = await flush();
      notify();
      return stored;
    },
    blob: getBlob,
    async dismiss(operationId) {
      const current = await latest(operationId);
      if (!current || current.scope !== key) return;
      if (current.status !== "attention" && current.status !== "synced") throw new Error("It hasn't been sent yet, so it can't be let go.");
      unstored.delete(operationId);
      await db.write(["queue", "blobs"], (tx) => {
        tx.objectStore("queue").delete(operationId);
        tx.objectStore("blobs").delete(IDBKeyRange.bound(`${operationId}/`, `${operationId}/￿`));
      });
      channel?.postMessage({ scope: key });
      await reload();
    },
    async sync(sender = fetchSender()) {
      const locks = options.locks === undefined ? (typeof navigator !== "undefined" ? navigator.locks : null) : options.locks;
      if (!locks) return runSync(sender);
      // One tab sends at a time; the server's operation ids catch anything that slips through.
      const result = await locks.request("tohyee-offline-queue-sync", { ifAvailable: true }, async (lock) => (lock ? runSync(sender) : null));
      return result ?? { sent: 0, refused: 0, stoppedBecause: "busy" };
    },
    reload,
    async retryStorage() {
      const ok = await flush();
      notify();
      return ok;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return queue;
}

const shared = new Map<string, Promise<OfflineQueue>>();

/** One queue per scope for the whole page, so every screen sees the same items. */
export function sharedQueue(scope: QueueScope): Promise<OfflineQueue> {
  const key = scopeKey(scope);
  let found = shared.get(key);
  if (!found) {
    found = openQueue(scope);
    shared.set(key, found);
    found.catch(() => shared.delete(key));
  }
  return found;
}

/** Unsent items for an account on this server, in every organisation (the sign-out warning). */
export async function unsentForAccount(server: string, userId: string, factory?: IDBFactory | null): Promise<number> {
  const db = await openOfflineDb(factory === undefined ? undefined : factory);
  const prefix = `${encodeURIComponent(server)}|${encodeURIComponent(userId)}|`;
  const all = await request(db.db.transaction("queue", "readonly").objectStore("queue").getAll());
  return (all as QueueItem[]).filter((item) => item.scope.startsWith(prefix) && item.status !== "synced").length;
}

/**
 * Unsent items on this server made by other accounts (someone signed out
 * here with work not sent). They're held for their own account and never
 * sent as this one (decision 1051).
 */
export async function heldForOtherAccounts(server: string, userId: string, factory?: IDBFactory | null): Promise<number> {
  const db = await openOfflineDb(factory === undefined ? undefined : factory);
  const serverPrefix = `${encodeURIComponent(server)}|`;
  const own = `${serverPrefix}${encodeURIComponent(userId)}|`;
  const all = await request(db.db.transaction("queue", "readonly").objectStore("queue").getAll());
  return (all as QueueItem[]).filter((item) => item.scope.startsWith(serverPrefix) && !item.scope.startsWith(own) && item.status !== "synced").length;
}
