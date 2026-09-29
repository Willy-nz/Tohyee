import type { OrgTx } from "@/lib/db/org-transaction";
import { getCreditNote } from "@/lib/credit-notes/service";
import { getInvoice, type InvoiceLine } from "@/lib/invoices/service";
import type { AmountsMode } from "@/lib/invoices/amounts";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, toFixedString } from "@/lib/money/decimal";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { getPurchaseOrder } from "@/lib/purchase-orders/service";
import { getQuote } from "@/lib/quotes/service";
import { type PrintKind, PRINT_KINDS, type TaxLabels, taxLabels } from "@/lib/documents/tax-invoice";
import { requireOneOf } from "@/lib/validation";

/**
 * Everything a printed invoice, credit note, quote or purchase order shows
 * (examples PD1-PD8, PO8): the organisation's name, address, GST number and
 * payment details, the customer's (or, on a purchase order, the supplier's)
 * name and billing address, the lines, GST and totals, and the dates. Worked
 * out from the stored document; nothing is stored or posted.
 */
export type PrintedLine = Pick<InvoiceLine, "lineOrder" | "description" | "quantity" | "unitPrice" | "taxRate" | "lineAmount" | "taxAmount"> & {
  unitName: string | null;
};

export type PrintedDocument = {
  kind: PrintKind;
  labels: TaxLabels;
  organisation: { name: string; postalAddress: string | null; gstNumber: string | null };
  customer: { name: string; billingAddress: string | null };
  number: string | null;
  status: string;
  date: string;
  /** Invoices: the due date. Quotes: the expiry date. Credit notes: none. */
  dueDate: string | null;
  expiryDate: string | null;
  reference: string | null;
  terms: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  lines: PrintedLine[];
  subtotal: string;
  taxTotal: string;
  total: string;
  /** Invoices only: what's been paid or credited, and what's still due. */
  amountPaid: string | null;
  amountDue: string | null;
  /** Printed on approved invoices only (not credit notes or quotes). */
  paymentDetails: string | null;
  /** Purchase orders only (PO8): where and when to deliver. */
  deliveryDate: string | null;
  deliveryAddress: string | null;
  deliveryInstructions: string | null;
};

const NO_DELIVERY = { deliveryDate: null, deliveryAddress: null, deliveryInstructions: null };

function printedLines(lines: Array<Pick<InvoiceLine, "lineOrder" | "description" | "quantity" | "unitPrice" | "unitName" | "taxRate" | "lineAmount" | "taxAmount">>): PrintedLine[] {
  return lines.map((line) => ({
    lineOrder: line.lineOrder,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    unitName: line.unitName,
    taxRate: line.taxRate,
    lineAmount: line.lineAmount,
    taxAmount: line.taxAmount,
  }));
}

export async function printedDocument(tx: OrgTx, kindInput: unknown, id: unknown): Promise<PrintedDocument> {
  const kind = requireOneOf(kindInput, "kind", PRINT_KINDS);
  const settings = await getOrganisationSettings(tx);
  const loaded =
    kind === "invoice"
      ? { kind, document: await getInvoice(tx, id) }
      : kind === "credit_note"
        ? { kind, document: await getCreditNote(tx, id) }
        : kind === "quote"
          ? { kind, document: await getQuote(tx, id) }
          : { kind, document: await getPurchaseOrder(tx, id) };
  const { document } = loaded;
  const contact = await tx.query<{ name: string; postal_address: string | null }>("select name, postal_address from contacts where id = $1", [
    document.contactId,
  ]);
  const customer = { name: contact.rows[0].name, billingAddress: contact.rows[0].postal_address };
  const labels = taxLabels({
    kind,
    status: document.status,
    amountsMode: document.amountsMode,
    total: document.total,
    taxTotal: document.taxTotal,
    organisationGstNumber: settings.gstNumber,
    buyerAddress: customer.billingAddress,
  });
  const base = {
    kind,
    labels,
    organisation: { name: settings.displayName, postalAddress: settings.postalAddress, gstNumber: labels.isTaxDocument ? settings.gstNumber : null },
    customer,
    status: document.status,
    reference: document.reference,
    amountsMode: document.amountsMode,
    currencyCode: document.currencyCode,
    lines: printedLines(document.lines),
    subtotal: document.subtotal,
    taxTotal: document.taxTotal,
    total: document.total,
  };
  if (loaded.kind === "invoice") {
    const invoice = loaded.document;
    const approved = invoice.status === "approved";
    return {
      ...base,
      number: invoice.invoiceNumber,
      date: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      expiryDate: null,
      terms: null,
      amountPaid: approved ? paidAndCredited(invoice.amountPaid, invoice.amountCredited, invoice.currencyCode) : null,
      amountDue: approved ? invoice.amountDue : null,
      paymentDetails: approved ? settings.paymentDetails : null,
      ...NO_DELIVERY,
    };
  }
  if (loaded.kind === "credit_note") {
    return {
      ...base,
      number: loaded.document.creditNoteNumber,
      date: loaded.document.creditNoteDate,
      dueDate: null,
      expiryDate: null,
      terms: null,
      amountPaid: null,
      amountDue: null,
      paymentDetails: null,
      ...NO_DELIVERY,
    };
  }
  if (loaded.kind === "purchase_order") {
    const order = loaded.document;
    return {
      ...base,
      number: order.poNumber,
      date: order.orderDate,
      dueDate: null,
      expiryDate: null,
      terms: null,
      amountPaid: null,
      amountDue: null,
      paymentDetails: null,
      deliveryDate: order.deliveryDate,
      deliveryAddress: order.deliveryAddress,
      deliveryInstructions: order.deliveryInstructions,
    };
  }
  const quote = loaded.document;
  return {
    ...base,
    number: quote.quoteNumber,
    date: quote.quoteDate,
    dueDate: null,
    expiryDate: quote.expiryDate,
    terms: quote.terms,
    amountPaid: null,
    amountDue: null,
    paymentDetails: null,
    ...NO_DELIVERY,
  };
}

function paidAndCredited(paid: string, credited: string, currencyCode: string): string {
  return toFixedString(add(dec(paid), dec(credited)), currencyMinorUnits(currencyCode));
}
