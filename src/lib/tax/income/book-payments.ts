import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { cmp, dec } from "@/lib/money/decimal";
import { financialYearEndMonth } from "@/lib/reports/financial";
import { money, suggestedIncomeYear } from "@/lib/tax/income/rules";
import { addPayment, listPayments, requireIncomeYear } from "@/lib/tax/income/service";
import { requireArray, requireId } from "@/lib/validation";

/*
 * IRD payments picked from the books (examples ITX36-ITX40, decision 550):
 * debits to the chosen income tax accounts, paid from a bank or credit card,
 * offered with a suggested income year; counting one links it to its journal
 * line so it can't count twice. Owners and admins only (the routes check).
 * Nothing posts.
 */

export type PaymentAccount = { accountId: string; code: string; name: string };

export type BookLine = {
  journalLineId: string;
  journalId: string;
  date: string;
  amount: string;
  reference: string;
  description: string | null;
  account: string;
  suggestedIncomeYear: number | null;
};

export type BookPayments = {
  accounts: PaymentAccount[];
  /** Money out to IRD not counted yet (ITX37). */
  payments: Array<BookLine & { typedMatch: { paymentId: string; incomeYear: number } | null }>;
  /** Money in on those accounts: possible refunds, listed but not counted (ITX40). */
  refunds: BookLine[];
};

const FIRST_DATE = "2024-04-01";

export async function listPaymentAccounts(tx: OrgTx): Promise<PaymentAccount[]> {
  const result = await tx.query<{ id: string; code: string; name: string }>(
    "select a.id::text, a.code, a.name from income_tax_payment_accounts p join accounts a on a.id = p.account_id order by a.code, a.id",
  );
  return result.rows.map((row) => ({ accountId: row.id, code: row.code, name: row.name }));
}

/** Chooses the accounts IRD income tax payments are coded to (ITX36). Replaces the list. */
export async function setPaymentAccounts(tx: OrgTx, input: { accountIds: unknown }): Promise<PaymentAccount[]> {
  const ids = [...new Set(requireArray(input.accountIds, "accountIds", 20).map((entry, index) => requireId(entry, `accountIds[${index}]`)))];
  if (ids.length > 0) {
    const found = await tx.query<{ id: string; code: string; name: string; account_class: string }>("select id::text, code, name, account_class from accounts where id = any($1::bigint[])", [ids]);
    if (found.rows.length !== ids.length) throw new NotFoundError("One of those accounts doesn't exist.");
    const wrong = found.rows.find((row) => !["asset", "liability", "equity"].includes(row.account_class));
    if (wrong) throw new ValidationError(`${wrong.code} ${wrong.name} is an income or expense account. Choose the balance sheet account income tax payments are coded to.`);
  }
  const before = await listPaymentAccounts(tx);
  await tx.query("delete from income_tax_payment_accounts where not (account_id = any($1::bigint[]))", [ids]);
  for (const id of ids) {
    await tx.query("insert into income_tax_payment_accounts (account_id, added_by_email) values ($1, $2) on conflict (account_id) do nothing", [id, tx.actor.email]);
  }
  const after = await listPaymentAccounts(tx);
  await writeAuditEvent(tx, {
    eventType: "income_tax.payment_accounts_set",
    entityType: "income_tax_settings",
    entityId: "settings",
    details: { from: before.map((account) => account.code), to: after.map((account) => account.code) },
  });
  return after;
}

type LineRow = { id: string; journal_id: string; posting_date: string; amount: string; reference: string; description: string | null; account: string };

const NOT_VOIDED = `j.origin <> 'opening_balance'
    and j.correction_kind is distinct from 'reversal'
    and not exists (select 1 from ledger_journals r where r.related_journal_id = j.id and r.correction_kind = 'reversal')`;

function bankSide(side: "credit" | "debit"): string {
  return `exists (select 1 from ledger_journal_lines b join accounts ba on ba.id = b.account_id
                   where b.journal_id = j.id and b.${side}_amount > 0 and ba.account_type in ('bank', 'credit_card'))`;
}

async function lines(tx: OrgTx, accountIds: string[], side: "debit" | "credit"): Promise<LineRow[]> {
  if (accountIds.length === 0) return [];
  const result = await tx.query<LineRow>(
    `select l.id::text, l.journal_id::text, j.posting_date::text, l.${side}_amount::text as amount, j.reference, coalesce(l.description, j.description) as description,
            a.code || ' ' || a.name as account
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id join accounts a on a.id = l.account_id
      where l.account_id = any($1::bigint[]) and l.${side}_amount > 0 and j.posting_date >= $2::date
        and ${NOT_VOIDED}
        and ${bankSide(side === "debit" ? "credit" : "debit")}
        and not exists (select 1 from income_tax_payments p where p.journal_line_id = l.id)
      order by j.posting_date, l.id`,
    [accountIds, FIRST_DATE],
  );
  return result.rows;
}

function toLine(row: LineRow, endMonth: number): BookLine {
  return {
    journalLineId: row.id,
    journalId: row.journal_id,
    date: row.posting_date,
    amount: money(dec(row.amount)),
    reference: row.reference,
    description: row.description,
    account: row.account,
    suggestedIncomeYear: suggestedIncomeYear(row.posting_date, endMonth),
  };
}

type TypedRow = { id: string; income_year: number; paid_on: string; amount: string };

async function unlinkedTyped(tx: OrgTx): Promise<TypedRow[]> {
  return (await tx.query<TypedRow>("select id::text, income_year, paid_on::text, amount::text from income_tax_payments where journal_line_id is null order by income_tax_payments.id")).rows;
}

/** What's in the books to count as IRD payments, and possible refunds (ITX37, ITX40). */
export async function bookPayments(tx: OrgTx): Promise<BookPayments> {
  const accounts = await listPaymentAccounts(tx);
  const ids = accounts.map((account) => account.accountId);
  const typed = await unlinkedTyped(tx);
  const endMonth = await financialYearEndMonth(tx);
  const payments = (await lines(tx, ids, "debit")).map((row) => {
    const line = toLine(row, endMonth);
    const match = typed.find((entry) => entry.paid_on === line.date && cmp(dec(entry.amount), dec(line.amount)) === 0);
    return { ...line, typedMatch: match ? { paymentId: match.id, incomeYear: match.income_year } : null };
  });
  return { accounts, payments, refunds: (await lines(tx, ids, "credit")).map((row) => toLine(row, endMonth)) };
}

/** Counts a payment from the books towards an income year, or links the same typed payment (ITX39). */
export async function countBookPayment(tx: OrgTx, input: { journalLineId: unknown; incomeYear: unknown }): Promise<{ paymentId: string; linkedTyped: boolean }> {
  const lineId = requireId(input.journalLineId, "journalLineId");
  const incomeYear = requireIncomeYear(input.incomeYear);
  await tx.query("select 1 from ledger_journal_lines where id = $1 for update", [lineId]);
  const counted = await tx.query<{ id: string }>("select id::text from income_tax_payments where journal_line_id = $1", [lineId]);
  if (counted.rows[0]) throw new ConflictError("That payment is already counted.");
  const accounts = (await listPaymentAccounts(tx)).map((account) => account.accountId);
  const line = (await lines(tx, accounts, "debit")).find((row) => row.id === lineId);
  if (!line) throw new NotFoundError("That line isn't a payment to IRD from the bank on a chosen income tax account.");
  const amount = money(dec(line.amount));
  const typed = (await listPayments(tx, incomeYear)).find((payment) => payment.paidOn === line.posting_date && cmp(dec(payment.amount), dec(amount)) === 0);
  const unlinked = typed ? (await unlinkedTyped(tx)).find((entry) => entry.id === typed.id) : undefined;
  let paymentId: string;
  if (unlinked) {
    await tx.query("update income_tax_payments set journal_line_id = $2 where id = $1", [unlinked.id, lineId]);
    paymentId = unlinked.id;
  } else {
    const created = await addPayment(tx, { idempotencyKey: `books-line-${lineId}-${incomeYear}`, incomeYear, paidOn: line.posting_date, amount, note: `From the books: ${line.reference}`.slice(0, 200) });
    await tx.query("update income_tax_payments set journal_line_id = $2 where id = $1", [created.payment.id, lineId]);
    paymentId = created.payment.id;
  }
  await writeAuditEvent(tx, {
    eventType: "income_tax.payment_counted_from_books",
    entityType: "income_tax_payment",
    entityId: paymentId,
    details: { journalLineId: lineId, journalId: line.journal_id, incomeYear, paidOn: line.posting_date, amount, linkedTyped: Boolean(unlinked) },
  });
  return { paymentId, linkedTyped: Boolean(unlinked) };
}
