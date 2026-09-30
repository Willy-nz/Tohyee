import { countryName, HOME_COUNTRY } from "@/lib/contacts/countries";
import type { TaxCategory } from "@/lib/tax/categories";

/**
 * Exports and the tax code for overseas customers (EX1-EX15), following
 * NetSuite's per-nexus "Foreign Trade" box and "Tax Code for Exports", "the
 * default tax code for orders placed by international customers", and a
 * customer's own tax code. IRD (IR375) zero-rates exported goods and most
 * services to non-residents; the currency of the invoice doesn't decide it.
 * Shared with the browser, so no server imports here.
 */

/** The organisation's settings for it. */
export type ExportSettings = {
  /** NetSuite's "Foreign Trade": off by default. */
  foreignTrade: boolean;
  /** NetSuite's "Tax Code for Exports": a zero-rated sales code, ZERO to start with. */
  exportTaxCode: string | null;
};

/** What a contact carries for it. */
export type ExportContact = {
  billingCountry: string;
  /** Blank: the billing country applies. */
  deliveryCountry: string | null;
  /** The contact's own default sales tax code, beating everything else (EX5). */
  defaultSalesTaxCode: string | null;
};

type CodeChoice = { code: string; category: TaxCategory; isActive: boolean };

/** Where the goods or services go: the delivery country, else the billing country (EX6). */
export function contactCountry(contact: Pick<ExportContact, "billingCountry" | "deliveryCountry">): string {
  return contact.deliveryCountry ?? contact.billingCountry;
}

/** Whether the contact is outside New Zealand. */
export function isOverseas(contact: Pick<ExportContact, "billingCountry" | "deliveryCountry"> | null | undefined): boolean {
  return Boolean(contact) && contactCountry(contact!) !== HOME_COUNTRY;
}

/** "Export (Australia)" for an overseas contact (EX12), else null. */
export function exportLabel(contact: Pick<ExportContact, "billingCountry" | "deliveryCountry"> | null | undefined): string | null {
  return contact && isOverseas(contact) ? `Export (${countryName(contactCountry(contact))})` : null;
}

/**
 * The tax code a new sales line starts with when the contact decides it
 * (EX2-EX6): the contact's own default sales tax code if it has an active
 * one; else, with Foreign trade on and the contact overseas, the tax code for
 * exports. Null means Tohyee's usual default applies (the item's, the
 * account's, or the first standard-rated code), exactly as before. It's only
 * a starting value: any line can be changed (EX7).
 */
export function contactSalesTaxCode(
  contact: ExportContact | null | undefined,
  settings: ExportSettings | null | undefined,
  taxCodes: ReadonlyArray<CodeChoice>,
): string | null {
  if (!contact) return null;
  const active = (code: string | null) => code !== null && taxCodes.some((taxCode) => taxCode.code === code && taxCode.isActive);
  if (active(contact.defaultSalesTaxCode)) return contact.defaultSalesTaxCode;
  if (settings?.foreignTrade && isOverseas(contact) && active(settings.exportTaxCode)) return settings.exportTaxCode;
  return null;
}

/**
 * The gentle warning (EX12): Foreign trade is on, the customer is overseas
 * and a line has a standard-rated code. Only a warning: a service consumed in
 * New Zealand can be standard-rated.
 */
export function exportWarning(
  contact: ExportContact | null | undefined,
  settings: ExportSettings | null | undefined,
  lineTaxCodes: ReadonlyArray<string | null>,
  taxCodes: ReadonlyArray<CodeChoice>,
): string | null {
  if (!settings?.foreignTrade || !isOverseas(contact)) return null;
  const standard = lineTaxCodes.some((code) => taxCodes.some((taxCode) => taxCode.code === code && taxCode.category === "standard"));
  return standard ? "This customer is overseas; exports are usually zero-rated." : null;
}

/**
 * When the customer changes on a sales document (EX2-EX6): lines whose tax
 * code wasn't chosen by hand or saved start again from the new customer's
 * code, else the usual one. Saved lines never change (EX8).
 */
export function retaxLines<T extends { taxCode: string; usualTaxCode?: string; taxTyped?: boolean }>(lines: T[], contactTaxCode: string | null): T[] {
  return lines.map((line) => (line.taxTyped ? line : { ...line, taxCode: contactTaxCode ?? line.usualTaxCode ?? line.taxCode }));
}

/**
 * A line's tax code when an account or item brings its usual code (EX4): the
 * customer's code still comes first. Returns the change to make to the line.
 */
export function usualWithContact(
  usual: string | undefined,
  contactTaxCode: string | null,
): { taxCode?: string; usualTaxCode?: string; taxTyped?: boolean } {
  return usual === undefined ? {} : { taxCode: contactTaxCode ?? usual, usualTaxCode: usual, taxTyped: false };
}
