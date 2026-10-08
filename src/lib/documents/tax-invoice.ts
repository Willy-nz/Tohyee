import { cmp, dec, isZero } from "@/lib/money/decimal";
import type { AmountsMode } from "@/lib/invoices/amounts";

/**
 * What a printed invoice, credit note or quote says about tax (examples
 * PD2-PD7), browser-safe so the page and the tests share it. Following the
 * GST Act's taxable supply information rules (from 1 April 2023) as Xero
 * prints them:
 *
 * - An approved invoice from a GST-registered organisation (a GST number in
 *   Settings) is headed "Tax invoice" and shows the GST number, the date, a
 *   description of each line, and either the GST as its own line (tax
 *   exclusive) or "Total includes GST of $x" (tax inclusive).
 * - Over $1,000 including GST, the buyer's name and an identifier must be
 *   shown. IRD's identifiers are an address (physical or postal), phone
 *   number, email address, trading name, NZBN or website (decision 270);
 *   Tohyee prints the billing address, else the contact's email, else their
 *   phone, so a customer with none of them gets a warning on screen (not
 *   on the paper), rather than a tax invoice missing it being printed
 *   silently.
 * - A draft is headed "Draft invoice" with no number (it isn't a tax invoice
 *   until it's approved); a voided invoice is headed "Voided invoice".
 * - "No tax" amounts, or an organisation with no GST number, print "Invoice"
 *   with no GST lines; if the invoice has GST but the organisation has no GST
 *   number, the screen warns to add it.
 * - Credit notes follow the same rules headed "Credit note" (the Act's
 *   "credit note" wording); quotes are headed "Quote" and are never tax
 *   documents, but show GST the same way so the customer sees the total.
 * - Purchase orders (PO8) go to a supplier: headed "Purchase order" ("Draft
 *   purchase order", "Cancelled purchase order"), never a tax document, and
 *   with no warnings (the supplier's tax invoice is theirs to issue).
 */
export const PRINT_KINDS = ["invoice", "credit_note", "quote", "purchase_order"] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];

export const TAX_INVOICE_BUYER_THRESHOLD = "1000.00";

export type TaxLabelInput = {
  kind: PrintKind;
  status: string;
  amountsMode: AmountsMode;
  total: string;
  taxTotal: string;
  organisationGstNumber: string | null;
  /** Registered for GST on the document's date (issue #180); true when not given. */
  gstRegisteredOnDate?: boolean;
  /** The buyer's identifier (decision 270): their billing address, email or phone, whichever is first. */
  buyerIdentifier: string | null;
};

export type TaxLabels = {
  title: string;
  /** Whether the paper is a tax invoice or tax credit note (GST number shown). */
  isTaxDocument: boolean;
  /** Show the GST as its own line under the subtotal (tax exclusive). */
  gstLine: boolean;
  /** "Total includes GST of $x" (tax inclusive). */
  includesGstStatement: boolean;
  /** Over $1,000: the buyer's name and an identifier must be on it. */
  buyerIdentifierRequired: boolean;
  /** Shown on screen only, never on the paper. */
  warnings: string[];
};

export function taxLabels(input: TaxLabelInput): TaxLabels {
  const hasTax = input.amountsMode !== "no_tax";
  const registeredOnDate = input.gstRegisteredOnDate ?? true;
  const registered = input.organisationGstNumber !== null && registeredOnDate;
  const draft = input.status === "draft";
  const voided = input.status === "voided";
  const warnings: string[] = [];
  if (input.kind === "purchase_order") {
    return {
      title: draft ? "Draft purchase order" : input.status === "cancelled" ? "Cancelled purchase order" : "Purchase order",
      isTaxDocument: false,
      gstLine: input.amountsMode === "exclusive",
      includesGstStatement: input.amountsMode === "inclusive",
      buyerIdentifierRequired: false,
      warnings: [],
    };
  }
  const isTaxDocument = input.kind !== "quote" && hasTax && registered && !draft && !voided;
  const noun = input.kind === "invoice" ? "invoice" : input.kind === "credit_note" ? "credit note" : "quote";
  let title: string;
  if (input.kind === "quote") title = draft ? "Draft quote" : "Quote";
  else if (draft) title = `Draft ${noun}`;
  else if (voided) title = `Voided ${noun}`;
  else if (input.kind === "invoice") title = isTaxDocument ? "Tax invoice" : "Invoice";
  else title = "Credit note";
  const buyerIdentifierRequired = isTaxDocument && cmp(dec(input.total), dec(TAX_INVOICE_BUYER_THRESHOLD)) > 0;
  if (buyerIdentifierRequired && !input.buyerIdentifier) {
    warnings.push(
      `This ${noun} is over $1,000, so a tax ${noun} must identify the customer by more than their name. Tohyee prints their billing address, email or phone, and this customer has none: add one to the contact, then print it again.`,
    );
  }
  if (input.kind !== "quote" && hasTax && !registered && !isZero(dec(input.taxTotal))) {
    warnings.push(
      registeredOnDate
        ? `This ${noun} charges GST, but there's no GST number in Settings, so it isn't printed as a tax ${noun}. An admin can add it in Settings.`
        : `This ${noun} charges GST, but the organisation wasn't registered for GST on its date, so it isn't printed as a tax ${noun}.`,
    );
  }
  return {
    title,
    isTaxDocument,
    gstLine: input.amountsMode === "exclusive",
    includesGstStatement: input.amountsMode === "inclusive",
    buyerIdentifierRequired,
    warnings,
  };
}
