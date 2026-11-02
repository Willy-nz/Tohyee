import { describe, expect, it } from "vitest";
import { mergeLines, type SavedLine } from "@/lib/ai/document-lines";
import { pageAfter } from "@/lib/ai/limits";

const item: SavedLine = {
  description: "Widgets",
  quantity: "1.0000",
  unitPrice: "120.0000",
  discountPercent: "10.00",
  accountCode: "4000",
  taxCode: "GST",
  tracking: { "7": "21" },
  customFields: { "3": "Kobe" },
  itemId: "5",
  unitId: "9",
  salesOrderLineId: "44",
};
const plain: SavedLine = { description: "Engraving", quantity: "1", unitPrice: "25", accountCode: "4000", taxCode: "GST", itemId: null, unitId: null, tracking: {}, customFields: {} };
const saved = [
  { lineId: "100", line: item },
  { lineId: "101", line: plain },
];

/** #537, decision 1263: what an AI line edit sends to the service. */
describe("mergeLines", () => {
  it("leaves the saved lines alone when neither lines nor removeLineIds is sent", () => {
    expect(mergeLines("invoice", saved, undefined, undefined)).toBeUndefined();
  });

  it("keeps everything on a line sent by lineId and changes only the fields sent", () => {
    const merged = mergeLines("invoice", saved, [{ lineId: "100", description: "Boxed" }, { lineId: "101" }], undefined)!;
    expect(merged[0]).toEqual({
      description: "Boxed",
      quantity: "1",
      unitPrice: "120",
      discountPercent: "10.00",
      accountCode: "4000",
      taxCode: "GST",
      tracking: { "7": "21" },
      customFields: { "3": "Kobe" },
      itemId: "5",
      unitId: "9",
      salesOrderLineId: "44",
    });
    expect(merged[1]).toMatchObject({ description: "Engraving", itemId: null });
  });

  it("clears with null: a field, one tracking category or custom field, or the item with its unit", () => {
    const [line] = mergeLines(
      "invoice",
      saved,
      [{ lineId: "100", discountPercent: null, tracking: { "7": null, "8": "30" }, customFields: { "3": null }, itemId: null }, { lineId: "101" }],
      undefined,
    )!;
    expect(line).toMatchObject({ discountPercent: null, tracking: { "8": "30" }, customFields: {}, itemId: null, unitId: null, salesOrderLineId: "44" });
  });

  it("adds lines without a lineId (only the line fields) and removes lines named in removeLineIds", () => {
    const merged = mergeLines("invoice", saved, [{ lineId: "100" }, { description: "New", quantity: "2", salesOrderLineId: "99", line: 3 }], ["101"])!;
    expect(merged[1]).toEqual({ description: "New", quantity: "2" });
    expect(mergeLines("invoice", saved, undefined, ["100"])).toEqual([expect.objectContaining({ description: "Engraving" })]);
  });

  it("refuses to drop a saved line that isn't named, saying what it carries", () => {
    expect(() => mergeLines("invoice", saved, [{ description: "Replacement", quantity: "1" }], undefined)).toThrow(
      /Nothing was changed: line 1 "Widgets" \(lineId 100\), which has an item and unit, tracking, custom fields, a sales order link; line 2 "Engraving" \(lineId 101\) aren't in lines or removeLineIds/,
    );
  });

  it("refuses stale, repeated and contradictory lineIds", () => {
    expect(() => mergeLines("bill", saved, [{ lineId: "55" }], undefined)).toThrow(/lineId 55 isn't one of this bill's lines now/);
    expect(() => mergeLines("bill", saved, [{ lineId: "100" }, { lineId: "100" }, { lineId: "101" }], undefined)).toThrow(/twice/);
    expect(() => mergeLines("bill", saved, [{ lineId: "100" }, { lineId: "101" }], ["101"])).toThrow(/both lines and removeLineIds/);
    expect(() => mergeLines("bill", saved, [{ lineId: "100" }], "101")).toThrow(/removeLineIds must be a list/);
  });
});

/** #538, decision 1267. */
describe("pageAfter", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: String(index + 1) }));
  const id = (row: { id: string }) => row.id;

  it("pages through every row once, with a null cursor at the end", () => {
    expect(pageAfter(rows, id, undefined, 2)).toEqual({ rows: [{ id: "1" }, { id: "2" }], more: true, nextCursor: "2" });
    expect(pageAfter(rows, id, "2", 2)).toEqual({ rows: [{ id: "3" }, { id: "4" }], more: true, nextCursor: "4" });
    expect(pageAfter(rows, id, "4", 2)).toEqual({ rows: [{ id: "5" }], more: false, nextCursor: null });
    expect(pageAfter(rows, id, undefined, 5)).toEqual({ rows, more: false, nextCursor: null });
    expect(pageAfter([], id, undefined, 5)).toEqual({ rows: [], more: false, nextCursor: null });
  });

  it("refuses a cursor that isn't in the list", () => {
    expect(() => pageAfter(rows, id, "9", 2)).toThrow(/Start again without a cursor/);
  });
});
