/*
 * Offline farm packs on the device (#472 stage 3, decisions 999-1007).
 * After an online sign-in, and whenever Tohyee is open with a connection,
 * every farm the person can see is kept on the device, a section at a
 * time, in IndexedDB. A section is replaced only once its new copy has
 * fully arrived, so the last good copy stays readable while an update runs
 * or after one fails. Screens read from it through `api()` when Tohyee
 * can't be reached (`answerOffline`), labelled "last known".
 *
 * Browser-safe; tests use fake-indexeddb and a pretend server.
 */

import { expectedAccountHeaders, isAccountChanged } from "./account";
import { offlineSession, readDeviceAccount } from "./device";
import { openOfflineDb } from "./idb";
import { answerFromEntries, EXTRA_PACK_MONTHS, PACK_MONTHS, PACK_REFRESH_MINUTES, PACK_SECTIONS, type PackEntry, type SectionInfo, type SectionKey } from "./pack-inventory";
import { scopeKey, type QueueScope } from "./queue";

/** The organisation-wide sections are kept under this in place of a farm id. */
export const ORGANISATION_KEY = "_organisation";

export type PackFile = { id: string; name: string; contentType: string; bytes: number; blob: Blob; copy: "small" | "original" };

export type SectionRecord = {
  id: string;
  scope: string;
  packId: string;
  farmId: string | null;
  section: SectionKey;
  /** When the server built it, and when this device kept it. Null until the first copy arrives. */
  builtAt: string | null;
  savedAt: string | null;
  months: number;
  entries: PackEntry[];
  /** Reads left out (not for this person's role, or refused), in words. */
  skipped: Array<{ path: string; reason: string }>;
  files: PackFile[];
  /** Files left out (too big, or failed), by name. */
  filesLeftOut: Array<{ name: string; reason: string }>;
  bytes: number;
  /** The last update's problem, if it failed; the previous copy is kept. */
  error: string | null;
  errorAt: string | null;
  /** Extras changed: fetch again at the next refresh (the copy stays readable meanwhile). */
  due?: boolean;
};

export type PackRecord = {
  id: string;
  scope: string;
  farmId: string;
  farmName: string;
  /** Extras the person chose on the Offline page (decision 1004). */
  months: number;
  originals: boolean;
  lastCompleteAt: string | null;
};

export type FarmReadiness = {
  farmId: string;
  farmName: string;
  /** "ready": every section kept; "partial": some kept, some failed or missing; "preparing": none yet. */
  state: "ready" | "partial" | "preparing";
  sections: Array<{ key: SectionKey; label: string; savedAt: string | null; error: string | null; bytes: number; skipped: number }>;
  oldestSavedAt: string | null;
  bytes: number;
  months: number;
  originals: boolean;
};

function packId(scope: string, farmKey: string) {
  return `${scope}|${farmKey}`;
}

function sectionId(scope: string, farmKey: string, section: SectionKey) {
  return `${scope}|${farmKey}|${section}`;
}

function sizeOf(entries: PackEntry[], files: PackFile[]): number {
  let bytes = 0;
  for (const entry of entries) bytes += JSON.stringify(entry).length;
  for (const file of files) bytes += file.bytes;
  return bytes;
}

export type PackFetcher = (path: string, query: Record<string, string>) => Promise<{ status: number; body: unknown; blob?: Blob; headers?: Headers }>;

/**
 * Reads with fetch on this server (same origin, the session cookie), naming
 * the account the pack is for: Tohyee refuses them if someone else is
 * signed in now (decision 1050). Status 0: Tohyee couldn't be reached.
 */
export function fetchPackFetcher(fetcher: typeof fetch = fetch, userId?: string): PackFetcher {
  return async (path, query) => {
    const url = new URL(path, typeof window === "undefined" ? "http://localhost" : window.location.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetcher(url, { cache: "no-store", credentials: "same-origin", headers: userId ? expectedAccountHeaders(userId) : {} });
    } catch {
      return { status: 0, body: null };
    }
    if (path.endsWith("/offline-pack/file") && response.ok) return { status: response.status, body: null, blob: await response.blob(), headers: response.headers };
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, headers: response.headers };
  };
}

export type RefreshProgress = { done: number; total: number; farmName: string | null; section: string | null };

export type RefreshResult = {
  outcome: "done" | "unreachable" | "sign_in" | "account_changed" | "stopped" | "not_farming" | "busy" | "locked";
  updated: number;
  failed: number;
};

type RefreshOptions = {
  fetcher?: PackFetcher;
  factory?: IDBFactory | null;
  now?: () => Date;
  /** Fetch every section, however recently it was kept. */
  force?: boolean;
  /** Only this farm (the Offline page's Refresh now). */
  farmId?: string;
  onProgress?: (progress: RefreshProgress) => void;
  locks?: LockManager | null;
  /** Checked before each read and before keeping it: true stops (the account changed, decision 1051). */
  shouldStop?: () => boolean;
};

function errorText(body: unknown, status: number): string {
  return body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string" ? (body as { error: string }).error : `Tohyee refused it (${status}).`;
}

const listeners = new Set<() => void>();
let version = 0;
function changed() {
  version += 1;
  memory.clear();
  listeners.forEach((listener) => listener());
}

/** Something on the device changed (a section kept, a farm removed): screens re-read. */
export function subscribePacks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function packsVersion(): number {
  return version;
}

/**
 * Keeps the person's farms on the device, a section at a time. Stops at the
 * first section Tohyee can't be reached for (the rest are tried next time);
 * a refused section keeps its previous copy and records why.
 */
export async function refreshPacks(scope: QueueScope, options: RefreshOptions = {}): Promise<RefreshResult> {
  const locks = options.locks === undefined ? (typeof navigator !== "undefined" ? navigator.locks : null) : options.locks;
  if (!locks) return runRefresh(scope, options);
  const result = await locks.request(`tohyee-offline-packs`, { ifAvailable: true }, async (lock) => (lock ? runRefresh(scope, options) : null));
  return result ?? { outcome: "busy", updated: 0, failed: 0 };
}

async function runRefresh(scope: QueueScope, options: RefreshOptions): Promise<RefreshResult> {
  const fetcher = options.fetcher ?? fetchPackFetcher(fetch, scope.userId);
  const stop = options.shouldStop ?? (() => false);
  /** What a refused read means: sign in again, or someone else is signed in now. */
  const signInOutcome = (body: unknown): RefreshResult["outcome"] => (isAccountChanged(401, body) ? "account_changed" : "sign_in");
  const now = options.now ?? (() => new Date());
  const db = await openOfflineDb(options.factory === undefined ? undefined : options.factory);
  const key = scopeKey(scope);
  const result: RefreshResult = { outcome: "done", updated: 0, failed: 0 };

  // Only for the account that last signed in online here, within its offline session (decision 994).
  const account = await readDeviceAccount(options.factory);
  if (!account || account.server !== scope.server || account.userId !== scope.userId) return { ...result, outcome: "locked" };

  const index = await fetcher("/api/farming/offline-pack", { organisationId: scope.organisationId });
  if (index.status === 0 || index.status >= 500) return { ...result, outcome: "unreachable" };
  if (index.status === 401) return { ...result, outcome: signInOutcome(index.body) };
  if (stop()) return { ...result, outcome: "stopped" };
  if (index.status >= 400) return { ...result, outcome: "not_farming" };
  const { farms, sections } = index.body as { farms: Array<{ id: string; name: string }>; sections: SectionInfo[] };

  // Farms no longer listed (access removed, archived) go from the device.
  const packs = await db.all<PackRecord>("packs", "scope", key);
  const listed = new Set(farms.map((farm) => farm.id));
  const gone = packs.filter((pack) => pack.farmId !== ORGANISATION_KEY && !listed.has(pack.farmId));
  if (gone.length) {
    const goneSections = (await db.all<SectionRecord>("packSections", "scope", key)).filter((section) => gone.some((pack) => pack.id === section.packId));
    await db.write(["packs", "packSections"], (tx) => {
      for (const pack of gone) tx.objectStore("packs").delete(pack.id);
      for (const section of goneSections) tx.objectStore("packSections").delete(section.id);
    });
    changed();
  }

  const settings = new Map(packs.map((pack) => [pack.farmId, pack]));
  const work: Array<{ farm: { id: string; name: string } | null; section: SectionInfo }> = [];
  for (const section of sections.filter((entry) => !entry.perFarm)) if (!options.farmId) work.push({ farm: null, section });
  for (const farm of farms) {
    if (options.farmId && farm.id !== options.farmId) continue;
    for (const section of sections.filter((entry) => entry.perFarm)) work.push({ farm, section });
  }
  const fresh = now().getTime() - PACK_REFRESH_MINUTES * 60_000;
  let done = 0;
  for (const { farm, section } of work) {
    const farmKey = farm?.id ?? ORGANISATION_KEY;
    const id = sectionId(key, farmKey, section.key);
    const existing = await db.get<SectionRecord>("packSections", id);
    options.onProgress?.({ done, total: work.length, farmName: farm?.name ?? null, section: section.label });
    done += 1;
    if (stop()) return { ...result, outcome: "stopped" };
    if (!options.force && existing?.savedAt && Date.parse(existing.savedAt) > fresh && !existing.error && !existing.due) continue;
    const pack = settings.get(farmKey);
    const months = pack?.months ?? PACK_MONTHS;
    const answer = await fetcher("/api/farming/offline-pack", { organisationId: scope.organisationId, section: section.key, ...(farm ? { farmId: farm.id } : {}), ...(months !== PACK_MONTHS ? { months: String(months) } : {}) });
    if (answer.status === 0 || answer.status >= 500) return { ...result, outcome: "unreachable" };
    if (answer.status === 401) return { ...result, outcome: signInOutcome(answer.body) };
    const time = now().toISOString();
    if (answer.status >= 400) {
      result.failed += 1;
      await saveSection(db, existing ? { ...existing, error: errorText(answer.body, answer.status), errorAt: time } : emptySection(key, farmKey, farm?.id ?? null, section.key, months, errorText(answer.body, answer.status), time));
      continue;
    }
    const built = answer.body as { builtAt: string; months: number; entries: PackEntry[]; skipped: SectionRecord["skipped"]; files?: Array<{ id: string; name: string; contentType: string | null; sizeBytes: number | null }> };
    let files: PackFile[] = [];
    const leftOut: SectionRecord["filesLeftOut"] = [];
    if (section.key === "photos") {
      // Files never change once kept (decision 945): only new ones are fetched.
      const kept = new Map((existing?.files ?? []).map((file) => [file.id, file]));
      for (const ref of built.files ?? []) {
        const have = kept.get(ref.id);
        if (have && (!pack?.originals || have.copy === "original")) {
          files.push(have);
          continue;
        }
        const file = await fetcher("/api/farming/offline-pack/file", { organisationId: scope.organisationId, fileId: ref.id, ...(pack?.originals ? { original: "1" } : {}) });
        if (file.status === 0 || file.status >= 500) return { ...result, outcome: "unreachable" };
        if (file.status !== 200 || !file.blob) {
          if (have) files.push(have);
          else leftOut.push({ name: ref.name, reason: file.status === 413 ? "Too big for the default copy" : errorText(file.body, file.status) });
          continue;
        }
        files.push({ id: ref.id, name: ref.name, contentType: file.blob.type || ref.contentType || "application/octet-stream", bytes: file.blob.size, blob: file.blob, copy: file.headers?.get("x-tohyee-copy") === "small" ? "small" : "original" });
      }
    }
    if (stop()) return { ...result, outcome: "stopped" };
    try {
      await saveSection(db, {
        id,
        scope: key,
        packId: packId(key, farmKey),
        farmId: farm?.id ?? null,
        section: section.key,
        builtAt: built.builtAt,
        savedAt: time,
        months: built.months,
        entries: built.entries,
        skipped: built.skipped ?? [],
        files,
        filesLeftOut: leftOut,
        bytes: sizeOf(built.entries, files),
        error: null,
        errorAt: null,
      });
      result.updated += 1;
    } catch (error) {
      // Full storage: the previous copy stays; say so.
      result.failed += 1;
      files = [];
      if (existing) await saveSection(db, { ...existing, error: storageMessage(error), errorAt: time }).catch(() => undefined);
    }
    if (!pack) {
      const record: PackRecord = { id: packId(key, farmKey), scope: key, farmId: farmKey, farmName: farm?.name ?? "Organisation", months: PACK_MONTHS, originals: false, lastCompleteAt: null };
      settings.set(farmKey, record);
      await db.write(["packs"], (tx) => tx.objectStore("packs").put(record)).catch(() => undefined);
    }
  }
  options.onProgress?.({ done, total: work.length, farmName: null, section: null });
  // Mark farms whose every section is kept and current.
  const all = await db.all<SectionRecord>("packSections", "scope", key);
  const completed = now().toISOString();
  const updates: PackRecord[] = [];
  for (const [farmKey, pack] of settings) {
    const own = all.filter((section) => section.packId === pack.id);
    const expected = PACK_SECTIONS.filter((section) => (farmKey === ORGANISATION_KEY ? !section.perFarm : section.perFarm)).length;
    if (own.length >= expected && own.every((section) => section.savedAt && !section.error)) updates.push({ ...pack, lastCompleteAt: completed });
  }
  if (updates.length) await db.write(["packs"], (tx) => updates.forEach((pack) => tx.objectStore("packs").put(pack))).catch(() => undefined);
  changed();
  return result;
}

function storageMessage(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  return name === "QuotaExceededError" ? "This device's storage is full, so this part wasn't updated. The previous copy is kept." : "This device wouldn't keep this part. The previous copy is kept.";
}

function emptySection(scope: string, farmKey: string, farmId: string | null, section: SectionKey, months: number, error: string, at: string): SectionRecord {
  return { id: sectionId(scope, farmKey, section), scope, packId: packId(scope, farmKey), farmId, section, builtAt: null, savedAt: null, months, entries: [], skipped: [], files: [], filesLeftOut: [], bytes: 0, error, errorAt: at };
}

async function saveSection(db: Awaited<ReturnType<typeof openOfflineDb>>, record: SectionRecord) {
  await db.write(["packSections"], (tx) => tx.objectStore("packSections").put(record));
}

// Reading -------------------------------------------------------------------------------------

/** Sections kept for a scope, without files (cached in memory until something changes). */
const memory = new Map<string, Promise<SectionRecord[]>>();

async function sectionsFor(key: string, factory?: IDBFactory | null): Promise<SectionRecord[]> {
  let found = memory.get(key);
  if (!found) {
    found = openOfflineDb(factory === undefined ? undefined : factory).then((db) => db.all<SectionRecord>("packSections", "scope", key));
    memory.set(key, found);
    found.catch(() => memory.delete(key));
  }
  return found;
}

export type OfflineAnswer = { found: true; body: unknown; savedAt: string; section: SectionKey; farmId: string | null } | { found: false; locked: boolean };

/**
 * A screen's read answered from what's kept on the device, if anything is,
 * for this scope only, within the 14-day offline session (decision 994).
 */
export async function answerOffline(scope: QueueScope, path: string, query: Record<string, string | number | boolean | null | undefined>, options: { factory?: IDBFactory | null; now?: Date } = {}): Promise<OfflineAnswer> {
  const account = await readDeviceAccount(options.factory);
  if (!account || account.server !== scope.server || account.userId !== scope.userId) return { found: false, locked: false };
  if (!offlineSession(account, options.now ?? new Date()).open) return { found: false, locked: true };
  const sections = await sectionsFor(scopeKey(scope), options.factory);
  for (const section of sections) {
    if (!section.savedAt) continue;
    const body = answerFromEntries(section.entries, path, query);
    if (body !== undefined) return { found: true, body, savedAt: section.savedAt, section: section.section, farmId: section.farmId };
  }
  return { found: false, locked: false };
}

/** A kept photo or document, by file id (for the service worker and screens). */
export async function offlineFile(scope: QueueScope, fileId: string, factory?: IDBFactory | null): Promise<PackFile | null> {
  const db = await openOfflineDb(factory === undefined ? undefined : factory);
  const sections = await db.all<SectionRecord>("packSections", "scope", scopeKey(scope));
  for (const section of sections) for (const file of section.files ?? []) if (file.id === fileId) return file;
  return null;
}

/** Each farm's readiness, for the farm bar and the Offline page. */
export async function readiness(scope: QueueScope, factory?: IDBFactory | null): Promise<FarmReadiness[]> {
  const db = await openOfflineDb(factory === undefined ? undefined : factory);
  const key = scopeKey(scope);
  const packs = await db.all<PackRecord>("packs", "scope", key);
  const sections = await db.all<SectionRecord>("packSections", "scope", key);
  return packs
    .map((pack) => {
      const expected = PACK_SECTIONS.filter((section) => (pack.farmId === ORGANISATION_KEY ? !section.perFarm : section.perFarm));
      const rows = expected.map((info) => {
        const record = sections.find((section) => section.packId === pack.id && section.section === info.key);
        return { key: info.key, label: info.label, savedAt: record?.savedAt ?? null, error: record?.error ?? null, bytes: record?.bytes ?? 0, skipped: (record?.skipped.length ?? 0) + (record?.filesLeftOut?.length ?? 0) };
      });
      const kept = rows.filter((row) => row.savedAt);
      const state: FarmReadiness["state"] = kept.length === 0 ? "preparing" : kept.length === rows.length && rows.every((row) => !row.error) ? "ready" : "partial";
      const oldest = kept.map((row) => row.savedAt!).sort()[0] ?? null;
      return { farmId: pack.farmId, farmName: pack.farmName, state, sections: rows, oldestSavedAt: oldest, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), months: pack.months, originals: pack.originals };
    })
    .sort((a, b) => (a.farmId === ORGANISATION_KEY ? -1 : b.farmId === ORGANISATION_KEY ? 1 : a.farmName.localeCompare(b.farmName, "en-NZ", { numeric: true })));
}

/** Extras for one farm: more history, original photos (decision 1004). The next refresh fetches (or lets go of) them. */
export async function setExtras(scope: QueueScope, farmId: string, extras: { months?: number; originals?: boolean }, factory?: IDBFactory | null): Promise<void> {
  const db = await openOfflineDb(factory === undefined ? undefined : factory);
  const key = scopeKey(scope);
  const pack = await db.get<PackRecord>("packs", packId(key, farmId));
  if (!pack) return;
  const months = extras.months === EXTRA_PACK_MONTHS ? EXTRA_PACK_MONTHS : extras.months === undefined ? pack.months : PACK_MONTHS;
  const originals = extras.originals ?? pack.originals;
  const sections = (await db.all<SectionRecord>("packSections", "scope", key)).filter((section) => section.packId === pack.id);
  await db.write(["packs", "packSections"], (tx) => {
    tx.objectStore("packs").put({ ...pack, months, originals });
    // Mark the farm's sections for fetching again (their copies stay readable until then).
    for (const section of sections) tx.objectStore("packSections").put({ ...section, due: true, files: originals ? section.files : section.files.filter((file) => file.copy === "small") });
  });
  changed();
}

/** Lets go of one farm's copy (or every farm's). Never the queue: unsent work stays (decision 1005). */
export async function removePacks(scope: QueueScope, farmId: string | null, factory?: IDBFactory | null): Promise<void> {
  const db = await openOfflineDb(factory === undefined ? undefined : factory);
  const key = scopeKey(scope);
  const packs = (await db.all<PackRecord>("packs", "scope", key)).filter((pack) => farmId === null || pack.farmId === farmId);
  const sections = (await db.all<SectionRecord>("packSections", "scope", key)).filter((section) => packs.some((pack) => pack.id === section.packId));
  await db.write(["packs", "packSections"], (tx) => {
    for (const pack of packs) tx.objectStore("packs").delete(pack.id);
    for (const section of sections) tx.objectStore("packSections").delete(section.id);
  });
  changed();
}

/** For tests: forget what's cached in memory. */
export function forgetPackMemory(): void {
  memory.clear();
}
