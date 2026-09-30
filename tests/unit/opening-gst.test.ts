import { describe, expect, it } from "vitest";
import { openingAmounts, openingDocumentGst, openingLineDescription } from "@/lib/import/opening-gst";

const GST = { code: "GST", category: "standard" as const, rate: "0.15" };
const ZERO = { code: "ZERO", category: "zero_rated" as const, rate: "0" };
const base = { noun: "invoice" as const, gst: null, total: null, taxCode: null, standard: GST };

/** Examples IM17-IM20: the GST in an open invoice or bill at the conversion date. */
describe("GST in opening documents", () => {
  it("IM17: a GST amount is the GST in what's still owed, on one standard-rated line", () => {
    expect(openingDocumentGst({ ...base, amount: "1150.00", gst: "150.00" })).toEqual({
      gst: "150.00",
      lines: [{ amount: "1150.00", gst: "150.00", taxCode: "GST", rate: "0.15", part: null }],
    });
  });

  it("IM20: a GST code alone is 3/23 of what's owed; zero rated has none", () => {
    expect(openingDocumentGst({ ...base, amount: "575.00", taxCode: GST }).gst).toBe("75.00");
    expect(openingDocumentGst({ ...base, amount: "575.00", taxCode: ZERO })).toEqual({
      gst: "0.00",
      lines: [{ amount: "575.00", gst: "0.00", taxCode: "ZERO", rate: "0", part: null }],
    });
  });

  it("IM20: the whole invoice's GST and total give the GST in what's owed, in proportion", () => {
    expect(openingDocumentGst({ ...base, amount: "575.00", gst: "105.00", total: "805.00" }).gst).toBe("75.00");
    expect(() => openingDocumentGst({ ...base, amount: "575.00", gst: "105.00", total: "500.00" })).toThrow("less than what's still owed");
  });

  it("IM20: less than 3/23 splits into a standard-rated part and the rest; more is refused", () => {
    expect(openingDocumentGst({ ...base, noun: "bill", amount: "460.00", gst: "30.00" }).lines).toEqual([
      { amount: "230.00", gst: "30.00", taxCode: "GST", rate: "0.15", part: "standard" },
      { amount: "230.00", gst: "0.00", taxCode: null, rate: "0", part: "rest" },
    ]);
    expect(openingDocumentGst({ ...base, amount: "460.00", gst: "60.05" }).lines).toHaveLength(1);
    expect(() => openingDocumentGst({ ...base, amount: "460.00", gst: "70.00" })).toThrow(
      "The GST (70.00) is more than GST at 15% on what's owed would be (60.00).",
    );
    expect(() => openingDocumentGst({ ...base, amount: "460.00", gst: "5.00", taxCode: ZERO })).toThrow("has no GST");
    expect(() => openingDocumentGst({ ...base, amount: "460.00", gst: "-1.00" })).toThrow("can't be negative");
  });

  it("IM11: nothing about GST leaves one line with no GST (only allowed where it never counts)", () => {
    const opening = openingDocumentGst({ ...base, amount: "1150.00" });
    expect(opening).toEqual({ gst: null, lines: [{ amount: "1150.00", gst: "0.00", taxCode: null, rate: "0", part: null }] });
    expect(openingAmounts("1150.00", opening.lines)).toEqual({ amountsMode: "no_tax", subtotal: "1150.00", taxTotal: "0.00" });
  });

  it("header amounts and line descriptions", () => {
    const split = openingDocumentGst({ ...base, amount: "460.00", gst: "30.00" }).lines;
    expect(openingAmounts("460.00", split)).toEqual({ amountsMode: "inclusive", subtotal: "430.00", taxTotal: "30.00" });
    expect(() => openingAmounts("461.00", split)).toThrow("add up to 460.00");
    expect(split.map((line) => openingLineDescription("2026-03-31", line))).toEqual([
      "Owed at 2026-03-31 (opening balance), with GST",
      "Owed at 2026-03-31 (opening balance), no GST",
    ]);
  });
});
