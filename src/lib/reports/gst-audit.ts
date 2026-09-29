import type { OrgTx } from "@/lib/db/org-transaction";
import { add, dec, type Decimal, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import type { GstAdjustment, GstBoxes, GstReturnFigures } from "@/lib/reports/gst-boxes";
import { calculateGstReturn, type GstDocumentType, type GstEventType, type GstReturnLine, getGstReturn } from "@/lib/reports/gst-return";
import type { GstBasis } from "@/lib/tax/categories";
import { optionalId } from "@/lib/validation";

/**
 * The GST audit report (examples GA1-GA4; step 5 of the NetSuite plan): for
 * a GST period on the organisation's basis, every document and amount that
 * makes up Boxes 5, 6 and 11, the Box 9 and Box 13 adjustments, and the
 * boxes worked out from them, so each list adds up to its box to the cent.
 * It doesn't count anything itself: it groups the GST return's own counted
 * lines (`calculateGstReturn`, or a filed return's stored lines), so it can
 * never disagree with the return. Lines left out of every box are listed too.
 */

export type GstAuditEntry = {
  eventType: GstEventType;
  eventDate: string;
  documentType: GstDocumentType;
  documentId: string;
  documentNumber: string;
  contactName: string;
  /** The screen that shows the document. */
  href: string;
  /** Including GST, what this document puts in the box in this event (negative for credit notes and voids). */
  amount: string;
  /** The counted lines' own GST, for information (Box 8 and 12 are worked out from the box). */
  gst: string;
  lineCount: number;
  /** For a settlement (payments and hybrid bases): what was settled, of the document's total. */
  settledAmount: string | null;
  documentTotal: string | null;
};

export type GstAuditBox = { box: "5" | "6" | "11"; total: string; gst: string; entries: GstAuditEntry[] };

export type GstAuditReport = {
  periodStart: string;
  periodEnd: string;
  basis: GstBasis;
  currencyCode: string;
  /** The filed return this audits, or null for the return worked out now. */
  gstReturnId: string | null;
  boxes: GstBoxes;
  gstOnTransactions: GstReturnFigures["gstOnTransactions"];
  box5: GstAuditBox;
  box6: GstAuditBox;
  box11: GstAuditBox;
  adjustments: GstAdjustment[];
  leftOut: { total: string; entries: GstAuditEntry[] };
};

function hrefFor(type: GstDocumentType, id: string, bankAccounts: Map<string, string>): string {
  switch (type) {
    case "sales_invoice":
      return `/operations/invoices/${id}`;
    case "sales_credit_note":
      return `/operations/credit-notes/${id}`;
    case "bill":
      return `/operations/bills/${id}`;
    case "supplier_credit_note":
      return `/operations/supplier-credit-notes/${id}`;
    case "bank_transaction":
      return bankAccounts.has(id) ? `/operations/bank-accounts/${bankAccounts.get(id)}` : "/operations/bank-accounts";
  }
}

/**
 * Groups counted lines into one entry per document per event (same type,
 * date and settlement amount), in the return's order.
 */
function group(lines: readonly GstReturnLine[], bankAccounts: Map<string, string>): GstAuditEntry[] {
  const entries: GstAuditEntry[] = [];
  const index = new Map<string, { entry: GstAuditEntry; amount: Decimal; gst: Decimal }>();
  for (const line of lines) {
    const key = [line.eventType, line.eventDate, line.documentType, line.documentId, line.settledAmount ?? ""].join("|");
    let found = index.get(key);
    if (!found) {
      const entry: GstAuditEntry = {
        eventType: line.eventType,
        eventDate: line.eventDate,
        documentType: line.documentType,
        documentId: line.documentId,
        documentNumber: line.documentNumber,
        contactName: line.contactName,
        href: hrefFor(line.documentType, line.documentId, bankAccounts),
        amount: "0.00",
        gst: "0.00",
        lineCount: 0,
        settledAmount: line.settledAmount,
        documentTotal: line.documentTotal,
      };
      found = { entry, amount: ZERO_DECIMAL, gst: ZERO_DECIMAL };
      index.set(key, found);
      entries.push(entry);
    }
    found.amount = add(found.amount, dec(line.amount));
    found.gst = add(found.gst, dec(line.gst));
    found.entry.amount = toFixedString(found.amount, 2);
    found.entry.gst = toFixedString(found.gst, 2);
    found.entry.lineCount += 1;
  }
  return entries;
}

function box(which: "5" | "6" | "11", lines: readonly GstReturnLine[], bankAccounts: Map<string, string>): GstAuditBox {
  const counted = lines.filter((line) => line.boxes.includes(which));
  const total = counted.reduce((acc, line) => add(acc, dec(line.amount)), ZERO_DECIMAL);
  const gst = counted.reduce((acc, line) => add(acc, dec(line.gst)), ZERO_DECIMAL);
  return { box: which, total: toFixedString(total, 2), gst: toFixedString(gst, 2), entries: group(counted, bankAccounts) };
}

/**
 * The audit report for a period worked out now (with any adjustments typed
 * in), or for a filed return (`gstReturnId`) exactly as it was filed.
 */
export async function gstAuditReport(
  tx: OrgTx,
  input: { periodStart?: unknown; periodEnd?: unknown; adjustments?: unknown; gstReturnId?: unknown },
): Promise<GstAuditReport> {
  const gstReturnId = optionalId(input.gstReturnId, "gstReturnId");
  let source: {
    periodStart: string;
    periodEnd: string;
    basis: GstBasis;
    currencyCode: string;
    boxes: GstBoxes;
    gstOnTransactions: GstReturnFigures["gstOnTransactions"];
    adjustments: GstAdjustment[];
    lines: GstReturnLine[];
  };
  if (gstReturnId) {
    source = await getGstReturn(tx, gstReturnId);
  } else {
    source = await calculateGstReturn(tx, { periodStart: input.periodStart, periodEnd: input.periodEnd, adjustments: input.adjustments });
  }
  const bankIds = [...new Set(source.lines.filter((line) => line.documentType === "bank_transaction").map((line) => line.documentId))];
  const bankAccounts = new Map<string, string>();
  if (bankIds.length > 0) {
    const found = await tx.query<{ id: string; account_id: string }>(
      "select id::text, account_id::text from bank_transactions where id = any($1::bigint[])",
      [bankIds],
    );
    for (const row of found.rows) bankAccounts.set(row.id, row.account_id);
  }
  const leftOutLines = source.lines.filter((line) => line.boxes.length === 0);
  const leftOutTotal = leftOutLines.reduce((acc, line) => add(acc, dec(line.amount)), ZERO_DECIMAL);
  return {
    periodStart: source.periodStart,
    periodEnd: source.periodEnd,
    basis: source.basis,
    currencyCode: source.currencyCode,
    gstReturnId,
    boxes: source.boxes,
    gstOnTransactions: source.gstOnTransactions,
    box5: box("5", source.lines, bankAccounts),
    box6: box("6", source.lines, bankAccounts),
    box11: box("11", source.lines, bankAccounts),
    adjustments: source.adjustments,
    leftOut: { total: toFixedString(leftOutTotal, 2), entries: group(leftOutLines, bankAccounts) },
  };
}

/** The sum of a box's entries (each box's list adds up to the box). */
export function entriesTotal(entries: readonly GstAuditEntry[]): string {
  return toFixedString(entries.reduce((acc, entry) => add(acc, dec(entry.amount)), ZERO_DECIMAL), 2);
}
