import type { OrgTx } from "@/lib/db/org-transaction";
import { formatDate, formatMoney } from "@/lib/format";
import { dec, toFixedString } from "@/lib/money/decimal";
import { currencyMinorUnits } from "@/lib/money/currency";
import { requireId } from "@/lib/validation";

/**
 * Likely duplicate bills (DU1-DU5, decisions 411-413). B5 already refuses a
 * second bill with a supplier's invoice number; these are the ones Tohyee
 * can't be sure of, so it warns and asks before approving, never blocks:
 *
 * - the same supplier and total (and currency) within 7 days either side,
 *   with a different number or none (DU2, DU4), unless both bills were made
 *   by the same repeating bill;
 * - another supplier with the same invoice number and total (DU3).
 *
 * Voided bills don't count.
 */

export const DUPLICATE_WINDOW_DAYS = 7;

export type DuplicateWarning = {
  kind: "same_supplier_amount" | "other_supplier_number";
  billId: string;
  contactName: string;
  supplierInvoiceNumber: string | null;
  billDate: string;
  total: string;
  status: "draft" | "approved";
  message: string;
};

type Row = {
  kind: DuplicateWarning["kind"];
  id: string;
  contact_name: string;
  supplier_invoice_number: string | null;
  bill_date: string;
  total: string;
  currency_code: string;
  status: "draft" | "approved";
};

const COMPARABLE = (column: string) => `lower(regexp_replace(${column}, '[[:space:]]', '', 'g'))`;

/** A bill's likely duplicates, nearest first. None for a voided bill. */
export async function billDuplicateWarnings(
  tx: OrgTx,
  billIdInput: unknown,
  options: { repeatingBillId?: string } = {},
): Promise<DuplicateWarning[]> {
  const billId = requireId(billIdInput, "billId");
  const found = await tx.query<Row>(
    `with this as (select * from bills where id = $1 and status <> 'voided')
     select 'same_supplier_amount' as kind, o.id::text, c.name as contact_name, o.supplier_invoice_number, o.bill_date::text,
            o.total::text, o.currency_code, o.status
       from this t join bills o on o.contact_id = t.contact_id and o.id <> t.id
       join contacts c on c.id = o.contact_id
      where o.status <> 'voided' and o.currency_code = t.currency_code and o.total = t.total
        and abs(o.bill_date - t.bill_date) <= ${DUPLICATE_WINDOW_DAYS}
        and not exists (select 1 from repeating_bill_runs r1 join repeating_bill_runs r2 on r2.repeating_bill_id = r1.repeating_bill_id
                         where r1.bill_id = t.id and r2.bill_id = o.id)
        -- A repeating bill being approved as it's made isn't in its runs yet.
        and not exists (select 1 from repeating_bill_runs r3 where r3.bill_id = o.id and r3.repeating_bill_id = $2::bigint)
     union all
     select 'other_supplier_number', o.id::text, c.name, o.supplier_invoice_number, o.bill_date::text, o.total::text, o.currency_code, o.status
       from this t join bills o on o.contact_id <> t.contact_id
       join contacts c on c.id = o.contact_id
      where o.status <> 'voided' and t.supplier_invoice_number is not null and o.supplier_invoice_number is not null
        and ${COMPARABLE("o.supplier_invoice_number")} = ${COMPARABLE("t.supplier_invoice_number")}
        and o.currency_code = t.currency_code and o.total = t.total
      order by 1 desc, 5, 2
      limit 20`,
    [billId, options.repeatingBillId ?? null],
  );
  return found.rows.map((row) => {
    const total = toFixedString(dec(row.total), currencyMinorUnits(row.currency_code));
    const number = row.supplier_invoice_number ?? `the draft with no number yet (#${row.id})`;
    return {
      kind: row.kind,
      billId: row.id,
      contactName: row.contact_name,
      supplierInvoiceNumber: row.supplier_invoice_number,
      billDate: row.bill_date,
      total,
      status: row.status,
      message:
        row.kind === "same_supplier_amount"
          ? `Possibly the same as ${number} (${formatMoney(total)}, ${formatDate(row.bill_date)})`
          : `Another supplier, ${row.contact_name}, has a bill ${row.supplier_invoice_number} for the same amount (${formatMoney(total)}, ${formatDate(row.bill_date)})`,
    };
  });
}
