import { describe, expect, it } from "vitest";
import { bookmarkName, parseBookmarks } from "@/lib/analytics/bookmarks";

const allowed = { pageIds: new Set(["main", "detail"]), tileIds: new Set(["t1", "t2"]), valueFields: new Set(["region"]), rangeFields: new Set(["amount"]) };

describe("bookmarks (#376 phase 3, decision 759)", () => {
  it("keeps a page, dates, the report's own slicer choices and hidden tiles", () => {
    expect(
      parseBookmarks(
        [{ id: "otago", name: " Otago ", state: { page: "detail", from: "2026-04-01", to: "", preset: "this_month", values: { region: ["Otago"], secret: ["x"] }, ranges: { amount: { min: "10" }, other: { min: "1" } }, hidden: ["t2", "t9", "t2"] } }],
        allowed,
      ),
    ).toEqual([
      { id: "otago", name: "Otago", state: { page: "detail", from: "2026-04-01", to: null, preset: "this_month", values: { region: ["Otago"] }, ranges: { amount: { min: "10" } }, hidden: ["t2"] } },
    ]);
  });

  it("falls back to the first page and refuses bad bookmarks", () => {
    expect(parseBookmarks([{ id: "b", name: "B", state: { page: "gone" } }], allowed)?.[0].state.page).toBe("main");
    expect(() => parseBookmarks([{ id: "b", name: "" }], allowed)).toThrow("give it a name");
    expect(() => parseBookmarks([{ id: "b", name: "B" }, { id: "b", name: "C" }], allowed)).toThrow("its own id");
    expect(() => parseBookmarks([{ id: "b", name: "B", state: { from: "1 April" } }], allowed)).toThrow("YYYY-MM-DD");
    expect(() => parseBookmarks(Array.from({ length: 21 }, (_v, i) => ({ id: `b${i}`, name: `B${i}` })), allowed)).toThrow("up to 20");
    expect(bookmarkName([{ id: "a", name: "Bookmark 2", state: { page: "main", from: null, to: null, preset: null, values: {}, ranges: {} } }])).toBe("Bookmark 3");
  });
});
