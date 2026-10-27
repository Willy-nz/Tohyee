/*
 * Where the phone's drafts are kept (#447, #463, decision 972). The
 * browser's storage first; a copy in memory too, so the page keeps working
 * when storage is blocked or full. A write that storage refused is
 * remembered, so the page never says "Saved on this phone" for a record
 * that would be lost on reload: it says so, keeps the record in memory,
 * sends it now, and saves it to storage as soon as storage takes it again.
 *
 * Pure apart from the storage it's given, so it can be tested without a
 * browser.
 */

export type DraftStorageBackend = Pick<Storage, "getItem" | "setItem">;

export type DraftStorage = {
  read(key: string): string | null;
  /** Saves the value; false when only the copy in memory has it. */
  write(key: string, value: string): boolean;
  /** Whether the last write for this key reached the phone's storage. */
  stored(key: string): boolean;
  /** Tries again to put the copy in memory into storage. */
  retry(key: string): boolean;
  /** Another tab changed storage: forget memory copies that storage already has. */
  storageChanged(): void;
  subscribe(listener: () => void): () => void;
};

export function createDraftStorage(backend: () => DraftStorageBackend | null): DraftStorage {
  const memory = new Map<string, string>();
  const unsaved = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const put = (key: string, value: string): boolean => {
    try {
      const storage = backend();
      if (!storage) return false;
      storage.setItem(key, value);
      return true;
    } catch {
      // QuotaExceededError (full), SecurityError (blocked) and the like.
      return false;
    }
  };

  return {
    read(key) {
      if (memory.has(key)) return memory.get(key)!;
      try {
        return backend()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write(key, value) {
      memory.set(key, value);
      const ok = put(key, value);
      if (ok) unsaved.delete(key);
      else unsaved.add(key);
      notify();
      return ok;
    },
    stored(key) {
      return !unsaved.has(key);
    },
    retry(key) {
      const value = memory.get(key);
      if (value === undefined) return !unsaved.has(key);
      const ok = put(key, value);
      if (ok) unsaved.delete(key);
      notify();
      return ok;
    },
    storageChanged() {
      // Never drop a copy storage doesn't have: it's the only one.
      for (const key of [...memory.keys()]) if (!unsaved.has(key)) memory.delete(key);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
