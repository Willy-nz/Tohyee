import { describe, expect, it } from "vitest";
import { fitVegetationPictures, OFFLINE_VEGETATION_BYTES } from "@/lib/offline/pack-server";
import type { PackEntry } from "@/lib/offline/pack-inventory";

const PATH = "/api/farming/farms/7/vegetation";
const bytes = (entry: PackEntry) => JSON.stringify(entry.body).length;

/** A made-up map answer whose inline picture is about `size` characters. */
function answer(sceneId: string, size: number): PackEntry {
  return {
    path: PATH,
    query: sceneId === "latest" ? {} : { sceneId },
    body: {
      vegetation: { state: "ready", attribution: "Made-up demo pictures, not satellite data.", scene: { id: sceneId, acquiredAt: "2026-10-30T22:10:00Z" } },
      pictures: { overlay: `data:image/png;base64,${"A".repeat(size)}`, change: null },
    },
  };
}

/** Issue #619 finding 5: the 2 MB device cap counts the latest date too. */
describe("offline satellite pictures cap", () => {
  it("leaves out the latest date's pictures when they alone are over the cap, keeping its facts", () => {
    const latest = answer("latest", OFFLINE_VEGETATION_BYTES + 10);
    const fitted = fitVegetationPictures(latest, [{ sceneId: "s2", entry: answer("s2", 1000) }]);
    expect(fitted.entries).toHaveLength(1);
    const kept = fitted.entries[0].body as { vegetation: { scene: { acquiredAt: string }; attribution: string }; pictures: { overlay: string | null; leftOut?: boolean } };
    expect(kept.pictures).toEqual({ overlay: null, change: null, leftOut: true });
    expect(kept.vegetation.scene.acquiredAt).toBe("2026-10-30T22:10:00Z");
    expect(kept.vegetation.attribution).toBe("Made-up demo pictures, not satellite data.");
    expect(bytes(fitted.entries[0])).toBeLessThanOrEqual(OFFLINE_VEGETATION_BYTES);
    // Both the latest pictures and the earlier date are named as left out.
    expect(fitted.skipped.map((entry) => entry.path)).toEqual([`${PATH} (latest pictures)`, `${PATH}?sceneId=s2`]);
  });

  it("keeps dates that fit together and leaves out the rest, never going over", () => {
    const third = Math.floor(OFFLINE_VEGETATION_BYTES / 3);
    const fitted = fitVegetationPictures(answer("latest", third), [
      { sceneId: "s2", entry: answer("s2", third) },
      { sceneId: "s3", entry: answer("s3", third) },
      { sceneId: "s4", entry: answer("s4", 10) },
    ]);
    expect(fitted.entries.map((entry) => entry.query.sceneId ?? "latest")).toEqual(["latest", "s2"]);
    expect(fitted.entries.reduce((sum, entry) => sum + bytes(entry), 0)).toBeLessThanOrEqual(OFFLINE_VEGETATION_BYTES);
    expect(fitted.skipped.map((entry) => entry.path)).toEqual([`${PATH}?sceneId=s3`, `${PATH}?sceneId=s4`]);
  });

  it("keeps everything when it all fits", () => {
    const fitted = fitVegetationPictures(answer("latest", 1000), [{ sceneId: "s2", entry: answer("s2", 1000) }]);
    expect(fitted.entries).toHaveLength(2);
    expect(fitted.skipped).toEqual([]);
    expect((fitted.entries[0].body as { pictures: { leftOut?: boolean } }).pictures.leftOut).toBeUndefined();
  });
});
