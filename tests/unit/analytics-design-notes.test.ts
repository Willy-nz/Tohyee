import { describe, expect, it } from "vitest";
import type { Tile } from "@/lib/analytics/dashboards";
import { designNotes, MAX_DESIGN_NOTES } from "@/lib/analytics/design-notes";
import type { QueryResult, TileQuery } from "@/lib/analytics/query";

const query = (extra: Partial<TileQuery> = {}): TileQuery =>
  ({ table: "sales", groupBy: null, pivot: null, measures: [{ label: "Sales", aggregate: "sum", field: "amount" }], filters: [], dateField: "sold_on", sort: { by: "category", direction: "asc" }, limit: null, ...extra }) as TileQuery;
const tile = (id: string, visual: Tile["visual"], extra: Partial<Tile> = {}): Tile => ({ id, title: id, visual, width: "half", query: query(), ...extra });
const answer = (values: string[]): QueryResult => ({
  columns: [
    { key: "category", label: "region", format: "text", role: "category" },
    { key: "m0", label: "Sales", format: "money", role: "measure" },
  ],
  rows: values.map((value, index) => ({ category: `Group ${index + 1}`, m0: value })),
  truncated: false,
});
const notesOf = (tiles: Tile[], results: Record<string, QueryResult> = {}) => designNotes(tiles, undefined, new Map(Object.entries(results))).map((note) => `${note.tileId ?? "page"}: ${note.note}`);

describe("design notes for a report the AI can't see (#691)", () => {
  it("says nothing about a tidy report", () => {
    const compared = query({ measures: [{ label: "Sales", aggregate: "sum", field: "amount", compare: "previous_period" }] as TileQuery["measures"], sparkline: true });
    const tiles = [tile("total", "kpi", { width: "quarter", query: compared }), tile("by-region", "bar", { query: query({ groupBy: { field: "region" } }) })];
    expect(designNotes(tiles, undefined, new Map([["by-region", answer(["10", "12", "9", "11"])]]))).toEqual([]);
  });

  it("notices a key figure with nothing to compare, but not a balance or a target", () => {
    const balance = query({ measures: [{ label: "Cash", aggregate: "sum", field: "amount", asAt: true }] as TileQuery["measures"] });
    expect(notesOf([tile("total", "kpi")])).toEqual(["total: A key figure on its own, with nothing to compare it with."]);
    expect(notesOf([tile("cash", "kpi", { query: balance })])).toEqual([]);
    expect(notesOf([tile("total", "kpi", { format: { kpi: { target: "1000" } } })])).toEqual([]);
    expect(notesOf([tile("total", "kpi", { query: query({ dateField: null }) })])).toEqual([]);
  });

  it("notices a row of key figures that don't match, once for the page", () => {
    const compared = query({ measures: [{ label: "Sales", aggregate: "sum", field: "amount", compare: "previous_year" }] as TileQuery["measures"] });
    const notes = designNotes([tile("a", "kpi", { query: compared }), tile("b", "kpi")], undefined);
    expect(notes).toHaveLength(1);
    expect(notes[0].tileId).toBeUndefined();
    expect(notes[0].note).toContain("(b)");
  });

  it("notices too many slices or bars, a trend with no trend and one bar flattening the rest", () => {
    const grouped = query({ groupBy: { field: "region" } });
    const many = Array.from({ length: 25 }, (_value, index) => String(100 + index));
    expect(notesOf([tile("pie", "donut", { query: grouped })], { pie: answer(many.slice(0, 7)) })).toEqual(["pie: A donut with 7 slices: past about 6 the small ones can't be told apart."]);
    expect(notesOf([tile("pie", "donut", { query: grouped })], { pie: answer(many.slice(0, 6)) })).toEqual([]);
    expect(notesOf([tile("bars", "bar", { query: grouped })], { bars: answer(many) })).toEqual(["bars: 25 bars: the labels will crowd."]);
    expect(notesOf([tile("line", "line", { query: query({ groupBy: { field: "sold_on", grain: "year" } }) })], { line: answer(["5", "6"]) })).toEqual(["line: A line chart with only 2 points in these dates: there is no trend to see."]);
    expect(notesOf([tile("bars", "column", { query: grouped })], { bars: answer(["10", "12", "9", "11", "500"]) })).toEqual(["bars: One value is more than ten times the usual one, so the other bars are flattened."]);
    // Without the answer, only what the definition shows.
    expect(notesOf([tile("pie", "donut", { query: grouped })])).toEqual([]);
  });

  it("notices a cramped chart and a wall of charts, and stops at a dozen notes", () => {
    const five = answer(["1", "2", "3", "4", "5"]);
    expect(notesOf([tile("small", "line", { width: "quarter" })], { small: five })).toEqual(["small: A chart in a quarter-width tile is cramped: axis labels and legends are cut short."]);
    // A few points fit, a dial is fine small, and without the answer nothing is claimed.
    expect(notesOf([tile("small", "line", { width: "quarter" })], { small: answer(["1", "2", "3"]) })).toEqual([]);
    expect(notesOf([tile("dial", "gauge", { width: "quarter" })], { dial: five })).toEqual([]);
    expect(notesOf([tile("small", "line", { width: "quarter" })])).toEqual([]);
    const nine = Array.from({ length: 9 }, (_value, index) => tile(`t${index}`, "bar"));
    expect(notesOf(nine)).toEqual(["page: 9 tiles on one page with no heading or notes between them: it reads as a wall of charts."]);
    expect(notesOf([...nine, tile("heading", "text", { query: null, text: "Sales" })])).toEqual([]);
    const cramped = Array.from({ length: 20 }, (_value, index) => tile(`c${index}`, "line", { width: "quarter" }));
    expect(designNotes([...cramped, tile("heading", "text", { query: null })], undefined, new Map(cramped.map((entry) => [entry.id, five])))).toHaveLength(MAX_DESIGN_NOTES);
  });

  it("names the page when the report has more than one", () => {
    const pages = [{ id: "one", name: "Summary" }, { id: "two", name: "Detail" }];
    expect(designNotes([tile("total", "kpi", { page: "two" })], pages)[0]).toMatchObject({ tileId: "total", page: "Detail" });
  });
});
