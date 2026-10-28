/*
 * The device's offline database (#472, decisions 990-1003): one IndexedDB
 * database, `tohyee-offline`, for everything Tohyee keeps on a phone or
 * tablet. Never localStorage: it's small, blocks the page and can't hold
 * photos.
 *
 * Stores (all made in version 1, so later changes don't fight over
 * upgrades):
 * - `meta`: small records by key (the account this device's copies belong
 *   to, and when it last signed in online).
 * - `queue`: work waiting for the server, by operation id (src/lib/offline/queue.ts).
 * - `blobs`: photos and other files for queued work, by `<operationId>/<name>`.
 * - `packs`, `packSections`: offline farm information (#472 stage 3).
 *
 * Browser-safe. Tests pass fake-indexeddb's factory.
 */

export const OFFLINE_DB_NAME = "tohyee-offline";
export const OFFLINE_DB_VERSION = 1;

export type StoreName = "meta" | "queue" | "blobs" | "packs" | "packSections";

/** The browser's IndexedDB, or null when there isn't one (old browser, blocked, server rendering). */
export function browserIndexedDB(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
  if (!db.objectStoreNames.contains("queue")) {
    const queue = db.createObjectStore("queue", { keyPath: "operationId" });
    queue.createIndex("scope", "scope");
  }
  if (!db.objectStoreNames.contains("blobs")) {
    const blobs = db.createObjectStore("blobs", { keyPath: "key" });
    blobs.createIndex("operationId", "operationId");
  }
  if (!db.objectStoreNames.contains("packs")) {
    const packs = db.createObjectStore("packs", { keyPath: "id" });
    packs.createIndex("scope", "scope");
  }
  if (!db.objectStoreNames.contains("packSections")) {
    const sections = db.createObjectStore("packSections", { keyPath: "id" });
    sections.createIndex("pack", "packId");
    sections.createIndex("scope", "scope");
  }
}

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("The device's storage refused the request."));
  });
}

/** Resolves when the transaction has committed (so the data is on the device), rejects if it aborted (full storage, for one). */
export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException("The device's storage refused the change.", "AbortError"));
    tx.onerror = () => undefined; // abort follows
  });
}

export type OfflineDb = {
  db: IDBDatabase;
  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined>;
  all<T>(store: StoreName, index?: string, value?: IDBValidKey): Promise<T[]>;
  /** Writes in one transaction; resolves only once it's committed. */
  write(stores: StoreName[], work: (tx: IDBTransaction) => void): Promise<void>;
  close(): void;
};

const opened = new Map<IDBFactory, Promise<OfflineDb>>();

/** Opens (once per factory) the offline database. Rejects when the device has no usable IndexedDB. */
export function openOfflineDb(factory: IDBFactory | null = browserIndexedDB()): Promise<OfflineDb> {
  if (!factory) return Promise.reject(new Error("This browser has no storage for offline use."));
  const existing = opened.get(factory);
  if (existing) return existing;
  const promise = new Promise<OfflineDb>((resolve, reject) => {
    const req = factory.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onerror = () => reject(req.error ?? new Error("This browser wouldn't open its storage for offline use."));
    req.onblocked = () => reject(new Error("Close Tohyee's other tabs, then try again."));
    req.onsuccess = () => {
      const db = req.result;
      // Another tab is upgrading: let it, and open again next time.
      db.onversionchange = () => {
        db.close();
        opened.delete(factory);
      };
      resolve(wrap(db, () => opened.delete(factory)));
    };
  });
  opened.set(factory, promise);
  promise.catch(() => opened.delete(factory));
  return promise;
}

function wrap(db: IDBDatabase, forget: () => void): OfflineDb {
  return {
    db,
    async get<T>(store: StoreName, key: IDBValidKey) {
      return (await request(db.transaction(store, "readonly").objectStore(store).get(key))) as T | undefined;
    },
    async all<T>(store: StoreName, index?: string, value?: IDBValidKey) {
      const objects = db.transaction(store, "readonly").objectStore(store);
      const source = index ? objects.index(index) : objects;
      return (await request(value === undefined ? source.getAll() : source.getAll(value))) as T[];
    },
    async write(stores: StoreName[], work: (tx: IDBTransaction) => void) {
      const tx = db.transaction(stores, "readwrite");
      const finished = done(tx);
      try {
        work(tx);
      } catch (error) {
        tx.abort();
        await finished.catch(() => undefined);
        throw error;
      }
      await finished;
    },
    close() {
      db.close();
      forget();
    },
  };
}

/** True for the errors a full device gives (so the screen can say "storage is full" rather than something vaguer). */
export function isQuotaError(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  return name === "QuotaExceededError" || /quota/i.test(error instanceof Error ? error.message : "");
}
