import { describe, expect, it } from "vitest";
import { catchUpLine } from "@/components/home/farm-home";

/** Home's catch-up lines open the farm they're about, not whichever farm the tab last used. */
describe("farm Home links to the right property", () => {
  it("links stale and unmeasured pasture to that farm", () => {
    expect(catchUpLine({ kind: "pasture_stale", farmId: "9", farmName: "Property 9", latestReading: "2026-09-01", days: 40 }).href).toBe("/operations/farming/pasture?farm=9");
    expect(catchUpLine({ kind: "paddocks_unmeasured", farmId: "3", farmName: "Property 3", count: 2 }).href).toBe("/operations/farming/pasture?farm=3");
  });
  it("keeps organisation-wide items unscoped", () => {
    expect(catchUpLine({ kind: "calendar_checking", count: 1 }).href).toBe("/operations/farming/calendar");
  });
});
