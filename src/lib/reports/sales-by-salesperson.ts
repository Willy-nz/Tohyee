import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { financialYearStart } from "@/lib/financial-year";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, type Decimal, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { financialYearEndMonth } from "@/lib/reports/financial";

/**
 * Sales by salesperson (examples SR3-SR5, SR8), amounts excluding GST.
 * Invoices and sales credit notes count on their date once approved (voided
 * ones too), and the other way on their void date. Drafts never count.
 */
export type SalesDocument = {
  kind: "invoice" | "invoice_void" | "credit_note" | "credit_note_void";
  id: string;
  number: string | null;
  date: string;
  contactName: string;
  /** Excluding GST; negative for a void. */
  amount: string;
};

export type SalespersonRow = {
  /** Null for "Not set". */
  salespersonId: string | null;
  name: string;
  invoices: number;
  sales: string;
  creditNotes: string;
  netSales: string;
  documents: SalesDocument[];
};

export type SalesBySalesperson = {
  from: string;
  to: string;
  currencyCode: string;
  rows: SalespersonRow[];
  total: Omit<SalespersonRow, "salespersonId" | "name" | "documents">;
};

type Row = {
  kind: SalesDocument["kind"];
  id: string;
  number: string | null;
  date: string;
  contact_name: string;
  amount: string;
  salesperson_id: string | null;
  salesperson_name: string | null;
};

export async function salesBySalesperson(tx: OrgTx, input: { from?: unknown; to?: unknown }): Promise<SalesBySalesperson> {
  const to = parseOptionalIsoDate(input.to, "to") ?? todayIsoDate();
  const from = input.from == null || input.from === "" ? financialYearStart(to, await financialYearEndMonth(tx)) : parseIsoDate(input.from, "from");
  if (from > to) throw new ValidationError("'from' must be on or before 'to'.");
  const result = await tx.query<Row>(
    `select * from (
       select 'invoice' as kind, i.id::text, i.invoice_number as number, i.invoice_date::text as date, c.name as contact_name,
              i.subtotal::text as amount, i.salesperson_id::text, sp.name as salesperson_name
         from sales_invoices i join contacts c on c.id = i.contact_id left join salespeople sp on sp.id = i.salesperson_id
        where i.status in ('approved', 'voided') and i.invoice_date between $1 and $2 and not i.is_opening_balance
       union all
       select 'invoice_void', i.id::text, i.invoice_number, i.void_date::text, c.name, (-i.subtotal)::text, i.salesperson_id::text, sp.name
         from sales_invoices i join contacts c on c.id = i.contact_id left join salespeople sp on sp.id = i.salesperson_id
        where i.status = 'voided' and i.void_date between $1 and $2 and not i.is_opening_balance
       union all
       select 'credit_note', n.id::text, n.credit_note_number, n.credit_note_date::text, c.name, n.subtotal::text, n.salesperson_id::text, sp.name
         from sales_credit_notes n join contacts c on c.id = n.contact_id left join salespeople sp on sp.id = n.salesperson_id
        where n.status in ('approved', 'voided') and n.credit_note_date between $1 and $2
       union all
       select 'credit_note_void', n.id::text, n.credit_note_number, n.void_date::text, c.name, (-n.subtotal)::text, n.salesperson_id::text, sp.name
         from sales_credit_notes n join contacts c on c.id = n.contact_id left join salespeople sp on sp.id = n.salesperson_id
        where n.status = 'voided' and n.void_date between $1 and $2
     ) docs
     order by date, kind, id::bigint`,
    [from, to],
  );
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);
  type Acc = { salespersonId: string | null; name: string; invoices: number; sales: Decimal; credits: Decimal; documents: SalesDocument[] };
  const groups = new Map<string, Acc>();
  const total = { invoices: 0, sales: ZERO_DECIMAL, credits: ZERO_DECIMAL };
  for (const row of result.rows) {
    const key = row.salesperson_id ?? "";
    const acc = groups.get(key) ?? {
      salespersonId: row.salesperson_id,
      name: row.salesperson_name ?? "Not set",
      invoices: 0,
      sales: ZERO_DECIMAL,
      credits: ZERO_DECIMAL,
      documents: [],
    };
    const amount = dec(row.amount);
    if (row.kind === "invoice") {
      acc.invoices += 1;
      total.invoices += 1;
    }
    if (row.kind === "invoice" || row.kind === "invoice_void") {
      acc.sales = add(acc.sales, amount);
      total.sales = add(total.sales, amount);
    } else {
      acc.credits = add(acc.credits, amount);
      total.credits = add(total.credits, amount);
    }
    acc.documents.push({ kind: row.kind, id: row.id, number: row.number, date: row.date, contactName: row.contact_name, amount: money(amount) });
    groups.set(key, acc);
  }
  // Salespeople by name, with "Not set" last.
  const rows = [...groups.values()]
    .sort((a, b) => (a.salespersonId === null ? 1 : b.salespersonId === null ? -1 : a.name.localeCompare(b.name)))
    .map((acc) => ({
      salespersonId: acc.salespersonId,
      name: acc.name,
      invoices: acc.invoices,
      sales: money(acc.sales),
      creditNotes: money(acc.credits),
      netSales: money(sub(acc.sales, acc.credits)),
      documents: acc.documents,
    }));
  return {
    from,
    to,
    currencyCode: tx.baseCurrency,
    rows,
    total: { invoices: total.invoices, sales: money(total.sales), creditNotes: money(total.credits), netSales: money(sub(total.sales, total.credits)) },
  };
}
