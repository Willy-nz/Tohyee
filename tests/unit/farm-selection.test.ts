import { describe, expect, it } from "vitest";
import { createFarmSelectionStore, resolveSelectedFarm } from "../../src/lib/client/farm-selection";
const farms = Array.from({ length: 9 }, (_, index) => ({ id: `farm-${index + 1}`, isActive: true }));
describe("multiple farms within one organisation", () => {
  it("requires a choice instead of silently using the first farm", () => {
    expect(resolveSelectedFarm(farms, null)).toBeNull();
    expect(resolveSelectedFarm(farms, "farm-9")).toEqual(farms[8]);
  });
  it("never substitutes another farm for an invalid or archived choice", () => {
    expect(resolveSelectedFarm(farms, "another-org-farm")).toBeNull();
    expect(resolveSelectedFarm([{ ...farms[0], isActive: false }, farms[1]], "farm-1")).toBeNull();
    expect(resolveSelectedFarm([farms[0]], "farm-9")).toBeNull();
  });
  it("keeps single-farm setup convenient and handles no active farms", () => {
    expect(resolveSelectedFarm([farms[0]], null)).toEqual(farms[0]);
    expect(resolveSelectedFarm([], null)).toBeNull();
    expect(resolveSelectedFarm(farms.map(farm => ({ ...farm, isActive: false })), null)).toBeNull();
  });
  it("remembers each user's choice separately in each organisation", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const store = createFarmSelectionStore(() => storage);
    let updates = 0;
    const unsubscribe = store.subscribe(() => { updates++; });
    store.select("user-a", "org-a", "farm-9");
    store.select("user-a", "org-b", "other-2");
    expect(store.read("user-a", "org-a")).toBe("farm-9");
    expect(store.read("user-b", "org-a")).toBeNull();
    expect(store.read("user-a", "org-b")).toBe("other-2");
    expect(createFarmSelectionStore(() => storage).read("user-a", "org-a")).toBe("farm-9");
    expect(updates).toBe(2);
    unsubscribe();
    store.select("user-a", "org-a", "farm-8");
    expect(updates).toBe(2);
  });
  it("still allows switching when browser storage is unavailable", () => {
    const store = createFarmSelectionStore(() => { throw new Error("Storage blocked"); });
    store.select("user-a", "org-a", "farm-9");
    expect(store.read("user-a", "org-a")).toBe("farm-9");
    expect(store.read("user-a", "org-b")).toBeNull();
  });
});
