import { describe, expect, it } from "vitest";
import type { Tile } from "@/lib/analytics/dashboards";
import { duplicateTile, moveTileTo, paragraphs } from "@/lib/analytics/layout";

const tile = (id: string): Tile => ({ id, title: id.toUpperCase(), visual: "text", width: "quarter", query: null });

describe("dashboard layout (#335)", () => {
  it("moves a tile to where it was dropped", () => {
    const tiles = ["a", "b", "c", "d"].map(tile);
    expect(moveTileTo(tiles, 0, 2).map((entry) => entry.id)).toEqual(["b", "c", "a", "d"]);
    expect(moveTileTo(tiles, 3, 0).map((entry) => entry.id)).toEqual(["d", "a", "b", "c"]);
    expect(moveTileTo(tiles, 1, 1)).toBe(tiles);
    expect(moveTileTo(tiles, 1, 9).map((entry) => entry.id)).toEqual(["a", "c", "d", "b"]);
  });

  it("duplicates a tile straight after it, as a separate copy", () => {
    const tiles: Tile[] = [tile("a"), { ...tile("b"), format: { palette: "warm" } }, tile("c")];
    const copied = duplicateTile(tiles, 1, "b2");
    expect(copied.map((entry) => [entry.id, entry.title])).toEqual([
      ["a", "A"],
      ["b", "B"],
      ["b2", "B (copy)"],
      ["c", "C"],
    ]);
    copied[2].format!.palette = "green";
    expect(tiles[1].format!.palette).toBe("warm");
  });

  it("splits a text card's notes into paragraphs", () => {
    expect(paragraphs("Sales are up.\n\n  \nCosts are\nflat.")).toEqual(["Sales are up.", "Costs are\nflat."]);
    expect(paragraphs(undefined)).toEqual([]);
  });
});
