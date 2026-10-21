/** A stale choice must never silently redirect work to a different farm. */
export function resolveSelectedFarm<T extends { id: string; isActive: boolean }>(farms: T[], selectedId: string | null): T | null {
  const active = farms.filter((farm) => farm.isActive);
  if (selectedId !== null) return active.find((farm) => farm.id === selectedId) ?? null;
  return active.length === 1 ? active[0] : null;
}

type SelectionStorage = Pick<Storage, "getItem" | "setItem">;

/** Per user, organisation and tab; other tabs cannot redirect an unfinished form. */
export function createFarmSelectionStore(storage: () => SelectionStorage) {
  const memory = new Map<string, string>();
  const listeners = new Set<() => void>();
  const keyFor = (userId: string, organisationId: string) => `tohyee.farm.${encodeURIComponent(userId)}.${encodeURIComponent(organisationId)}`;
  return {
    read(userId: string, organisationId: string): string | null {
      const key = keyFor(userId, organisationId);
      if (memory.has(key)) return memory.get(key)!;
      try { return storage().getItem(key); } catch { return null; }
    },
    select(userId: string, organisationId: string, farmId: string) {
      const key = keyFor(userId, organisationId);
      memory.set(key, farmId);
      try { storage().setItem(key, farmId); } catch { /* Keep the in-memory choice if storage is blocked. */ }
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
