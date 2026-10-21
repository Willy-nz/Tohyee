import { describe, expect, it } from "vitest";
import { addPage, movePage, openingPage, parsePages, removePage, reportPages, tilePage, tilesOnPage, withPage } from "@/lib/analytics/pages";

type T = { id: string; page?: string };

describe("report pages (#376 phase 3, decision 753)", () => {
  it("treats a report without pages as one page, so older reports are unchanged", () => {
    expect(reportPages(undefined)).toEqual([{ id: "page-1", name: "Page 1" }]);
    expect(tilePage({}, undefined)).toBe("page-1");
    expect(parsePages(undefined)).toBeUndefined();
    expect(parsePages([{ id: "page-1", name: "Page 1" }])).toBeUndefined();
  });

  it("checks pages: names, widths, backgrounds, hidden pages and how many", () => {
    expect(parsePages([{ id: "a", name: " Sales ", width: "narrow", background: "tinted", junk: 1 }, { id: "b", name: "Detail", hidden: true, background: "#112233" }])).toEqual([
      { id: "a", name: "Sales", width: "narrow", background: "tinted" },
      { id: "b", name: "Detail", hidden: true, background: "#112233" },
    ]);
    expect(() => parsePages([{ id: "a", name: "" }])).toThrow("give it a name");
    expect(() => parsePages([{ id: "a", name: "A" }, { id: "a", name: "B" }])).toThrow("its own id");
    expect(() => parsePages([{ id: "a", name: "A", width: "huge" }])).toThrow("width");
    expect(() => parsePages([{ id: "a", name: "A", background: "red" }])).toThrow();
    expect(() => parsePages([{ id: "a", name: "A", hidden: true }])).toThrow("At least one page");
    expect(() => parsePages(Array.from({ length: 13 }, (_v, i) => ({ id: `p${i}`, name: `P${i}` })))).toThrow("up to 12");
  });

  it("puts tiles on their page, and a tile whose page has gone on the first", () => {
    const pages = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    const tiles: T[] = [{ id: "1" }, { id: "2", page: "b" }, { id: "3", page: "gone" }];
    expect(tilesOnPage(tiles, pages, "a").map((tile) => tile.id)).toEqual(["1", "3"]);
    expect(tilesOnPage(tiles, pages, "b").map((tile) => tile.id)).toEqual(["2"]);
    // The first page's tiles are saved without a page.
    expect(withPage<T>({ id: "4", page: "b" }, "a", pages)).toEqual({ id: "4" });
    expect(withPage<T>({ id: "4" }, "b", pages)).toEqual({ id: "4", page: "b" });
  });

  it("opens the page asked for, or the first page in the tabs", () => {
    const pages = [{ id: "a", name: "A", hidden: true }, { id: "b", name: "B" }];
    expect(openingPage(pages, "a").id).toBe("a");
    expect(openingPage(pages, "nope").id).toBe("b");
    expect(openingPage(undefined, null).id).toBe("page-1");
  });

  it("adds, moves and removes pages, keeping each tile on its page", () => {
    const tiles: T[] = [{ id: "1" }, { id: "2" }];
    const added = addPage(undefined, tiles, "p2");
    expect(added.pages).toEqual([{ id: "page-1", name: "Page 1" }, { id: "p2", name: "Page 2" }]);
    const onTwo = added.tiles.map((tile) => (tile.id === "2" ? withPage(tile, "p2", added.pages) : tile));
    // Page 2 moves first: tile 1 now names page 1, tile 2 is saved without one.
    const moved = movePage(added.pages, onTwo, "p2", -1);
    expect(moved.pages!.map((page) => page.id)).toEqual(["p2", "page-1"]);
    expect(moved.tiles).toEqual([{ id: "1", page: "page-1" }, { id: "2" }]);
    expect(tilesOnPage(moved.tiles, moved.pages, "page-1").map((tile) => tile.id)).toEqual(["1"]);
    // Removing a page removes its tiles; the last page left with nothing set is no pages again.
    const removed = removePage(moved.pages, moved.tiles, "p2");
    expect(removed).toEqual({ pages: undefined, tiles: [{ id: "1" }] });
    expect(() => removePage(undefined, tiles, "page-1")).toThrow("at least one page");
  });
});
