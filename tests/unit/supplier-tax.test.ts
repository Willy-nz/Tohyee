import { describe, expect, it } from "vitest";
import { contactSalesTaxCode, exportWarning, retaxLines, usualWithContact } from "@/lib/tax/exports";
import { contactPurchaseTaxCode } from "@/lib/tax/purchase-defaults";

/**
 * docs/ACCOUNTING-EXAMPLES.md, "A supplier's default purchase tax code" (not
 * yet approved by Jess): the starting tax code of a new purchase line, and
 * where the export warning shows. The purchase editors (bills, supplier
 * credit notes, purchase orders, repeating bills, spend money) use exactly
 * these functions.
 */
const CODES = [
  { code: "GST", category: "standard", isActive: true },
  { code: "ZERO", category: "zero_rated", isActive: true },
  { code: "EXEMPT", category: "exempt", isActive: true },
  { code: "NONE", category: "out_of_scope", isActive: true },
  { code: "OLD", category: "standard", isActive: false },
] as const;
const cloudApps = { billingCountry: "US", deliveryCountry: null, defaultSalesTaxCode: null, defaultPurchaseTaxCode: "NONE" };
const kauri = { billingCountry: "NZ", deliveryCountry: null, defaultSalesTaxCode: null, defaultPurchaseTaxCode: null };
const rata = { billingCountry: "NZ", deliveryCountry: null, defaultSalesTaxCode: "EXEMPT", defaultPurchaseTaxCode: "GST" };

describe("a supplier's default purchase tax code", () => {
  it("EX17, EX18: a supplier with a default starts with it; one without keeps the usual default (null)", () => {
    expect(contactPurchaseTaxCode(cloudApps, CODES)).toBe("NONE");
    expect(contactPurchaseTaxCode(kauri, CODES)).toBeNull();
    expect(contactPurchaseTaxCode(undefined, CODES)).toBeNull();
  });

  it("EX19: the contact's default beats an account's or item's usual code; without one the usual code applies as before", () => {
    // Account 6010's usual code is GST; the item SERVER's purchase tax code is GST.
    expect(usualWithContact("GST", contactPurchaseTaxCode(cloudApps, CODES))).toEqual({ taxCode: "NONE", usualTaxCode: "GST", taxTyped: false });
    expect(usualWithContact("GST", contactPurchaseTaxCode(kauri, CODES))).toEqual({ taxCode: "GST", usualTaxCode: "GST", taxTyped: false });
  });

  it("EX20, EX21: choosing the supplier re-codes only lines not chosen by hand or saved", () => {
    const lines = [
      { key: 1, taxCode: "GST", usualTaxCode: "GST" },
      { key: 2, taxCode: "GST", usualTaxCode: "GST", taxTyped: true },
      { key: 3, taxCode: "ZERO", taxTyped: true },
    ];
    const toCloud = retaxLines(lines, contactPurchaseTaxCode(cloudApps, CODES));
    expect(toCloud.map((line) => line.taxCode)).toEqual(["NONE", "GST", "ZERO"]);
    expect(retaxLines(toCloud, contactPurchaseTaxCode(kauri, CODES)).map((line) => line.taxCode)).toEqual(["GST", "GST", "ZERO"]);
  });

  it("EX22: an inactive default isn't used; the sales and purchase defaults are separate", () => {
    expect(contactPurchaseTaxCode({ defaultPurchaseTaxCode: "OLD" }, CODES)).toBeNull();
    expect(contactPurchaseTaxCode(rata, CODES)).toBe("GST");
    expect(contactSalesTaxCode(rata, { foreignTrade: false, exportTaxCode: "ZERO" }, CODES)).toBe("EXEMPT");
    // Cloud Apps' purchase default doesn't touch its sales lines.
    expect(contactSalesTaxCode(cloudApps, { foreignTrade: false, exportTaxCode: "ZERO" }, CODES)).toBeNull();
  });

  it("EX23: spend money takes the default only if the line can use it (a foreign-currency line has no standard-rated codes)", () => {
    const foreignLineCodes = CODES.filter((code) => code.category !== "standard");
    expect(contactPurchaseTaxCode(cloudApps, foreignLineCodes)).toBe("NONE");
    expect(contactPurchaseTaxCode(rata, foreignLineCodes)).toBeNull();
  });

  it("EX25: the export warning shows where lines can change (an editor or a draft), not on an approved document", () => {
    const wombat = { billingCountry: "AU", deliveryCountry: null, defaultSalesTaxCode: null };
    const on = { foreignTrade: true, exportTaxCode: "ZERO" };
    const warning = "This customer is overseas; exports are usually zero-rated.";
    expect(exportWarning(wombat, on, ["GST"], CODES)).toBe(warning);
    expect(exportWarning(wombat, on, ["GST"], CODES, { editable: true })).toBe(warning);
    expect(exportWarning(wombat, on, ["GST"], CODES, { editable: false })).toBeNull();
  });
});
