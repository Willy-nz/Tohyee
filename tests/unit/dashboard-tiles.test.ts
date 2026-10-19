import { describe, expect, it } from "vitest";
import { moveTile, toggleTile } from "@/lib/dashboard/tiles";

/** The farm Home's Customise (FH7): turning cards on and off and moving them. */
describe("dashboard tiles", () => {
  const order = ["farm_calendar", "stock", "pasture", "fertiliser", "performance", "money", "notebook"];

  it("turns a card on at its place in the page's order, and off, keeping at least one", () => {
    expect(toggleTile(["farm_calendar", "money"], "pasture", true, order, 10)).toEqual(["farm_calendar", "pasture", "money"]);
    expect(toggleTile(["money", "farm_calendar"], "notebook", true, order, 10)).toEqual(["money", "farm_calendar", "notebook"]);
    // A pinned Analytics tile isn't in the order: it goes at the end.
    expect(toggleTile(["stock"], "analytics:4:herd", true, order, 10)).toEqual(["stock", "analytics:4:herd"]);
    expect(toggleTile(["stock", "money"], "money", true, order, 10)).toEqual(["stock", "money"]);
    expect(toggleTile(["stock", "money"], "pasture", true, order, 2)).toEqual(["stock", "money"]);
    expect(toggleTile(["stock", "money"], "stock", false, order, 10)).toEqual(["money"]);
    expect(toggleTile(["stock"], "stock", false, order, 10)).toEqual(["stock"]);
  });

  it("moves a card up or down one place, not past the ends", () => {
    expect(moveTile(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveTile(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveTile(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveTile(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
    expect(moveTile(["a", "b"], "x", 1)).toEqual(["a", "b"]);
  });
});
