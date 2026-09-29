import { describe, expect, it } from "vitest";
import { taxLabels, type TaxLabelInput } from "@/lib/documents/tax-invoice";
import { isQuoteExpired } from "@/lib/quotes/service";

const base: TaxLabelInput = {
  kind: "invoice",
  status: "approved",
  amountsMode: "exclusive",
  total: "316.25",
  taxTotal: "41.25",
  organisationGstNumber: "123456789",
  buyerAddress: "12 George St, Dunedin 9016",
};

/** Examples PD3-PD7 and QT5 in docs/ACCOUNTING-EXAMPLES.md. */
describe("printed document labels", () => {
  it("PD1: an approved exclusive invoice is a tax invoice with a GST line", () => {
    expect(taxLabels(base)).toEqual({
      title: "Tax invoice",
      isTaxDocument: true,
      gstLine: true,
      includesGstStatement: false,
      buyerAddressRequired: false,
      warnings: [],
    });
  });

  it("PD3 and PD4: over $1,000 needs the buyer's address; exactly $1,000 doesn't", () => {
    const inclusive = { ...base, amountsMode: "inclusive" as const, total: "1150.00", taxTotal: "150.00" };
    expect(taxLabels(inclusive)).toMatchObject({ title: "Tax invoice", gstLine: false, includesGstStatement: true, buyerAddressRequired: true, warnings: [] });
    const noAddress = taxLabels({ ...inclusive, buyerAddress: null });
    expect(noAddress.warnings).toHaveLength(1);
    expect(noAddress.warnings[0]).toMatch(/over \$1,000.*billing address/);
    expect(taxLabels({ ...inclusive, total: "1000.00", taxTotal: "130.43", buyerAddress: null })).toMatchObject({ buyerAddressRequired: false, warnings: [] });
  });

  it("PD5: drafts and voided invoices aren't tax invoices", () => {
    expect(taxLabels({ ...base, status: "draft" })).toMatchObject({ title: "Draft invoice", isTaxDocument: false });
    expect(taxLabels({ ...base, status: "voided" })).toMatchObject({ title: "Voided invoice", isTaxDocument: false });
  });

  it("PD6: no GST number, or no tax, prints Invoice", () => {
    const unregistered = taxLabels({ ...base, organisationGstNumber: null });
    expect(unregistered).toMatchObject({ title: "Invoice", isTaxDocument: false });
    expect(unregistered.warnings[0]).toMatch(/no GST number in Settings/);
    expect(taxLabels({ ...base, amountsMode: "no_tax", taxTotal: "0.00" })).toMatchObject({
      title: "Invoice",
      isTaxDocument: false,
      gstLine: false,
      includesGstStatement: false,
      warnings: [],
    });
  });

  it("PD7 and PD8: credit notes and quotes", () => {
    expect(taxLabels({ ...base, kind: "credit_note", total: "40.25", taxTotal: "5.25" })).toMatchObject({ title: "Credit note", isTaxDocument: true });
    expect(taxLabels({ ...base, kind: "quote", status: "finalised" })).toMatchObject({ title: "Quote", isTaxDocument: false, gstLine: true, warnings: [] });
    expect(taxLabels({ ...base, kind: "quote", status: "draft" }).title).toBe("Draft quote");
  });

  it("QT5: a finalised quote is expired only after its expiry date", () => {
    expect(isQuoteExpired({ status: "finalised", expiryDate: "2026-07-31" }, "2026-07-31")).toBe(false);
    expect(isQuoteExpired({ status: "finalised", expiryDate: "2026-07-31" }, "2026-08-01")).toBe(true);
    expect(isQuoteExpired({ status: "accepted", expiryDate: "2026-07-31" }, "2026-08-01")).toBe(false);
    expect(isQuoteExpired({ status: "draft", expiryDate: "2026-07-31" }, "2026-08-01")).toBe(false);
    expect(isQuoteExpired({ status: "finalised", expiryDate: null }, "2030-01-01")).toBe(false);
  });
});
