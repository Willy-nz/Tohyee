import { describe, expect, it } from "vitest";
import { COUNTRIES, COUNTRY_CHOICES, countryName, findCountry, HOME_COUNTRY } from "@/lib/contacts/countries";
import {
  contactSalesTaxCode,
  type ExportContact,
  exportLabel,
  exportWarning,
  isOverseas,
  retaxLines,
  usualWithContact,
} from "@/lib/tax/exports";

/**
 * docs/ACCOUNTING-EXAMPLES.md, "Exports and the tax code for overseas
 * customers" (not yet approved by Jess): the starting tax code of a new sales
 * line, the export flag and warning, and countries. The editors use exactly
 * these functions.
 */
const CODES = [
  { code: "GST", category: "standard", isActive: true },
  { code: "ZERO", category: "zero_rated", isActive: true },
  { code: "EXEMPT", category: "exempt", isActive: true },
  { code: "NONE", category: "out_of_scope", isActive: true },
  { code: "OLD", category: "standard", isActive: false },
] as const;
const ON = { foreignTrade: true, exportTaxCode: "ZERO" };
const OFF = { foreignTrade: false, exportTaxCode: "ZERO" };
const contact = (billingCountry: string, extra: Partial<ExportContact> = {}): ExportContact => ({
  billingCountry,
  deliveryCountry: null,
  defaultSalesTaxCode: null,
  ...extra,
});
const kobe = contact("NZ");
const wombat = contact("AU");
const paws = contact("US");
const kiwiGifts = contact("NZ", { deliveryCountry: "AU" });
const sydneyVisitors = contact("AU", { deliveryCountry: "NZ" });
const harbourTours = contact("AU", { defaultSalesTaxCode: "GST" });
const rataRentals = contact("NZ", { defaultSalesTaxCode: "EXEMPT" });

describe("exports", () => {
  it("EX2, EX3, EX9: a New Zealand customer, or Foreign trade off, keeps the usual default (null)", () => {
    expect(contactSalesTaxCode(kobe, ON, CODES)).toBeNull();
    expect(contactSalesTaxCode(wombat, OFF, CODES)).toBeNull();
    // Tui Traders is in New Zealand though invoiced in USD: currency doesn't come into it.
    expect(contactSalesTaxCode(contact("NZ"), ON, CODES)).toBeNull();
    expect(contactSalesTaxCode(undefined, ON, CODES)).toBeNull();
  });

  it("EX4, EX10: an overseas customer with Foreign trade on starts with the tax code for exports", () => {
    expect(contactSalesTaxCode(wombat, ON, CODES)).toBe("ZERO");
    expect(contactSalesTaxCode(paws, ON, CODES)).toBe("ZERO");
    // An inactive export code isn't used.
    expect(contactSalesTaxCode(wombat, ON, CODES.map((code) => (code.code === "ZERO" ? { ...code, isActive: false } : code)))).toBeNull();
  });

  it("EX5: the contact's own default sales tax code comes first; an inactive one is ignored", () => {
    expect(contactSalesTaxCode(harbourTours, ON, CODES)).toBe("GST");
    expect(contactSalesTaxCode(rataRentals, ON, CODES)).toBe("EXEMPT");
    expect(contactSalesTaxCode(rataRentals, OFF, CODES)).toBe("EXEMPT");
    expect(contactSalesTaxCode(contact("AU", { defaultSalesTaxCode: "OLD" }), ON, CODES)).toBe("ZERO");
  });

  it("EX6: the delivery country beats the billing country", () => {
    expect(contactSalesTaxCode(kiwiGifts, ON, CODES)).toBe("ZERO");
    expect(contactSalesTaxCode(sydneyVisitors, ON, CODES)).toBeNull();
    expect(isOverseas(kiwiGifts)).toBe(true);
    expect(isOverseas(sydneyVisitors)).toBe(false);
  });

  it("EX4: an account's or item's usual code gives way to the customer's; without one it applies as before", () => {
    expect(usualWithContact("GST", "ZERO")).toEqual({ taxCode: "ZERO", usualTaxCode: "GST", taxTyped: false });
    expect(usualWithContact("GST", null)).toEqual({ taxCode: "GST", usualTaxCode: "GST", taxTyped: false });
    expect(usualWithContact(undefined, "ZERO")).toEqual({});
  });

  it("EX7, EX8: choosing the customer re-codes only lines not chosen by hand or saved", () => {
    const lines = [
      { key: 1, taxCode: "GST", usualTaxCode: "GST" },
      { key: 2, taxCode: "GST", usualTaxCode: "GST", taxTyped: true },
      { key: 3, taxCode: "EXEMPT", taxTyped: true },
    ];
    const toWombat = retaxLines(lines, "ZERO");
    expect(toWombat.map((line) => line.taxCode)).toEqual(["ZERO", "GST", "EXEMPT"]);
    // Back to Kobe (no code of their own): the usual default again.
    expect(retaxLines(toWombat, null).map((line) => line.taxCode)).toEqual(["GST", "GST", "EXEMPT"]);
  });

  it("EX12: the export flag and the gentle warning", () => {
    expect(exportLabel(wombat)).toBe("Export (Australia)");
    expect(exportLabel(paws)).toBe("Export (United States)");
    expect(exportLabel(kiwiGifts)).toBe("Export (Australia)");
    expect(exportLabel(kobe)).toBeNull();
    expect(exportLabel(sydneyVisitors)).toBeNull();
    const warning = "This customer is overseas; exports are usually zero-rated.";
    expect(exportWarning(wombat, ON, ["ZERO", "GST"], CODES)).toBe(warning);
    expect(exportWarning(harbourTours, ON, ["GST"], CODES)).toBe(warning);
    for (const code of ["ZERO", "EXEMPT", "NONE"]) expect(exportWarning(wombat, ON, [code], CODES)).toBeNull();
    expect(exportWarning(wombat, OFF, ["GST"], CODES)).toBeNull();
    expect(exportWarning(kobe, ON, ["GST"], CODES)).toBeNull();
    expect(exportWarning(sydneyVisitors, ON, ["GST"], CODES)).toBeNull();
  });

  it("EX14: countries by code or name, New Zealand first in the list", () => {
    expect(COUNTRIES).toHaveLength(249);
    expect(new Set(COUNTRIES.map(([code]) => code)).size).toBe(249);
    expect(COUNTRIES.every(([code]) => /^[A-Z]{2}$/.test(code))).toBe(true);
    expect(HOME_COUNTRY).toBe("NZ");
    expect(COUNTRY_CHOICES[0]).toEqual(["NZ", "New Zealand"]);
    expect(COUNTRY_CHOICES).toHaveLength(249);
    expect(findCountry("Australia")).toBe("AU");
    expect(findCountry(" au ")).toBe("AU");
    expect(findCountry("united states")).toBe("US");
    expect(findCountry("XX")).toBeNull();
    expect(countryName("GB")).toBe("United Kingdom");
  });
});
