import { describe, expect, it } from "vitest";
import { createDraftStorage, type DraftStorageBackend } from "@/lib/farming/draft-storage";
import { draftStatusLabel } from "@/lib/farming/drafts";

/** When the phone's storage refuses a draft (#463, decision 972). */
class FakeStorage implements DraftStorageBackend {
  items = new Map<string, string>();
  failWith: string | null = null;
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWith) throw new DOMException("No room", this.failWith);
    this.items.set(key, value);
  }
}

describe("draft storage", () => {
  for (const failure of ["QuotaExceededError", "SecurityError"]) {
    it(`says a draft isn't saved on the phone when storage throws ${failure}, keeps it in memory, and saves it on retry`, () => {
      const disk = new FakeStorage();
      disk.failWith = failure;
      const storage = createDraftStorage(() => disk);
      let notified = 0;
      storage.subscribe(() => (notified += 1));
      expect(storage.write("k", "draft A")).toBe(false);
      expect(storage.stored("k")).toBe(false);
      expect(draftStatusLabel("saved", storage.stored("k"))).toBe("Unsaved");
      // The record is still there to show and send.
      expect(storage.read("k")).toBe("draft A");
      // Another tab's change doesn't throw away the only copy.
      storage.storageChanged();
      expect(storage.read("k")).toBe("draft A");
      // Still failing: retry says so.
      expect(storage.retry("k")).toBe(false);
      // Storage recovers: retry saves it, and a reload (a fresh page) finds it.
      disk.failWith = null;
      expect(storage.retry("k")).toBe(true);
      expect(storage.stored("k")).toBe(true);
      expect(draftStatusLabel("saved", storage.stored("k"))).toBe("Waiting to send");
      expect(createDraftStorage(() => disk).read("k")).toBe("draft A");
      expect(notified).toBeGreaterThanOrEqual(3);
    });
  }

  it("treats no storage at all as not saved", () => {
    const storage = createDraftStorage(() => null);
    expect(storage.write("k", "x")).toBe(false);
    expect(storage.stored("k")).toBe(false);
    expect(storage.read("k")).toBe("x");
  });

  it("says Waiting to send only when storage took it (Unsaved otherwise, #472); synced and needs attention are unchanged", () => {
    const disk = new FakeStorage();
    const storage = createDraftStorage(() => disk);
    expect(storage.write("k", "x")).toBe(true);
    expect(storage.stored("k")).toBe(true);
    expect(disk.getItem("k")).toBe("x");
    expect(draftStatusLabel("synced", false)).toBe("Synced");
    expect(draftStatusLabel("attention", false)).toBe("Needs attention");
    // A later failed write for the same key isn't hidden by the earlier success.
    disk.failWith = "QuotaExceededError";
    expect(storage.write("k", "y")).toBe(false);
    expect(storage.stored("k")).toBe(false);
    expect(storage.read("k")).toBe("y");
  });
});
