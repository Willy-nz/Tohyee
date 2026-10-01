import { describe, expect, it } from "vitest";
import { usualTaxCode } from "@/lib/accounts/types";
import { codesForSide, isAvailableOn, ruleSides, sideRefusal, unavailableNote, type AvailableOn } from "@/lib/tax/available-on";
import type { TaxCategory } from "@/lib/tax/categories";
import { contactSalesTaxCode } from "@/lib/tax/exports";
import { contactPurchaseTaxCode } from "@/lib/tax/purchase-defaults";

/**
 * docs/ACCOUNTING-EXAMPLES.md, "A tax code's Available on" (not yet approved
 * by Jess): what the editors' tax code pickers list and which code a new line
 * starts with. Every sales editor (invoices, credit notes, quotes, repeating
 * invoices, project invoices, receive money) and purchase editor (bills,
 * supplier credit notes, purchase orders, repeating bills, spend money,
 * expense claims) sees its codes through `codesForSide`.
 */
const code = (name: string, category: TaxCategory, availableOn: AvailableOn, isActive = true) => ({ code: name, category, availableOn, isActive });
const CODES = [
  code("GST", "standard", "both"),
  code("ZERO", "zero_rated", "both"),
  code("EXEMPT", "exempt", "both"),
  code("NONE", "out_of_scope", "both"),
  code("PUR", "standard", "purchases"),
  code("SAL", "standard", "sales"),
  code("OLD", "standard", "both", false),
];
/** What a picker lists: active codes, plus the line's own code (shown with a note). */
const picker = (side: "sales" | "purchases", lineCode = "") =>
  codesForSide(CODES, side)
    .filter((taxCode) => taxCode.isActive || taxCode.code === lineCode)
    .map((taxCode) => `${taxCode.code}${unavailableNote(taxCode)}`);
/** The editors' usual starting code: the first active standard-rated code, else the first active one. */
const firstStandard = (codes: ReadonlyArray<{ code: string; category: string; isActive: boolean }>) =>
  (codes.find((taxCode) => taxCode.isActive && taxCode.category === "standard") ?? codes.find((taxCode) => taxCode.isActive))?.code;

describe("a tax code's Available on", () => {
  it("TAO6: sales pickers list Sales and Both codes, purchase pickers Purchases and Both; a saved line's own code shows why", () => {
    expect(picker("sales")).toEqual(["GST", "ZERO", "EXEMPT", "NONE", "SAL"]);
    expect(picker("purchases")).toEqual(["GST", "ZERO", "EXEMPT", "NONE", "PUR"]);
    expect(picker("sales", "PUR")).toEqual(["GST", "ZERO", "EXEMPT", "NONE", "PUR (purchases only)", "SAL"]);
    expect(picker("purchases", "OLD")).toEqual(["GST", "ZERO", "EXEMPT", "NONE", "PUR", "OLD (inactive)"]);
  });

  it("TAO6: starting codes come only from codes available on the editor's side", () => {
    // An organisation that keeps separate codes (GST archived): sales lines start SAL, purchase lines PUR.
    const separate = CODES.map((taxCode) => (taxCode.code === "GST" ? { ...taxCode, isActive: false } : taxCode));
    expect(firstStandard(codesForSide(separate, "sales"))).toBe("SAL");
    expect(firstStandard(codesForSide(separate, "purchases"))).toBe("PUR");
    // Account 6200 Cleaning's usual code is PUR: used on a bill line, not on an invoice line (the line keeps its code).
    const accounts = [{ code: "6200", defaultTaxCode: "PUR" }];
    expect(usualTaxCode(accounts, codesForSide(CODES, "purchases"), "6200")).toEqual({ taxCode: "PUR" });
    expect(usualTaxCode(accounts, codesForSide(CODES, "sales"), "6200")).toEqual({});
    // Contact defaults and the tax code for exports are always on their side (TAO7), so they apply as before.
    expect(contactSalesTaxCode({ billingCountry: "NZ", deliveryCountry: null, defaultSalesTaxCode: "SAL" }, null, codesForSide(CODES, "sales"))).toBe("SAL");
    expect(contactPurchaseTaxCode({ defaultPurchaseTaxCode: "PUR" }, codesForSide(CODES, "purchases"))).toBe("PUR");
  });

  it("TAO2-TAO4: the refusal names the code and the side", () => {
    expect(sideRefusal("Line 1", "PUR", "purchases", "sales")).toBe(
      "Line 1: tax code PUR is available on purchases only, so it can't be used on sales. Choose a tax code available on sales.",
    );
    expect(sideRefusal("Receipt 2", "SAL", "sales", "purchases")).toBe(
      "Receipt 2: tax code SAL is available on sales only, so it can't be used on purchases. Choose a tax code available on purchases.",
    );
    expect(sideRefusal("Line 1", "GST", "both", "sales")).toBeNull();
    expect(sideRefusal("Line 1", "SAL", "sales", "sales")).toBeNull();
    expect(isAvailableOn("both", "purchases")).toBe(true);
  });

  it("TAO8: bank rules: money in is sales, money out purchases, either way both", () => {
    expect(ruleSides("in")).toEqual(["sales"]);
    expect(ruleSides("out")).toEqual(["purchases"]);
    expect(ruleSides("any")).toEqual(["sales", "purchases"]);
  });
});
