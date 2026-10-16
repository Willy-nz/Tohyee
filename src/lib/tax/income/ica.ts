import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, cmp, dec, type Decimal, divide, isNegative, mul, neg, parseDecimalInput, roundHalfUp, ZERO_DECIMAL } from "@/lib/money/decimal";
import { incomeYearDates, money, type OnTimeBy, onTimeBy } from "@/lib/tax/income/rules";
import { ICA_KIND_LABELS, ICA_KINDS, type IcaKind } from "@/lib/tax/income/ica-kinds";
import { optionalString, requireId, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

export { ICA_KIND_LABELS, ICA_KINDS, type IcaKind };

/*
 * The imputation credit account (examples ITX25-ITX29, decision 548), from
 * IRD's IR274 (April 2024), read 16 Oct 2026 and not yet reviewed. The ICA
 * year is 1 April to 31 March; entries are dated when they happen. Income
 * tax paid comes from the payments typed on the Income tax page. Companies,
 * owners and admins only (the API and the report check). Nothing posts.
 */

const DEBITS: readonly IcaKind[] = ["dividend_paid", "refund", "other_debit"];

/** Credits on a dividend can be at most 28/72 of the cash dividend (IR274). */
export const MAX_RATIO = { numerator: dec("28"), denominator: dec("72") };
export const IMPUTATION_PENALTY_RATE = dec("0.10");

export function maxCredits(cashDividend: Decimal): Decimal {
  return roundHalfUp(divide(mul(cashDividend, MAX_RATIO.numerator), MAX_RATIO.denominator, 6), 2);
}

export type IcaRow = {
  id: string | null;
  date: string;
  kind: IcaKind | "tax_paid";
  label: string;
  description: string | null;
  /** Credit positive, debit negative. */
  amount: string;
  balance: string;
  dividendAmount: string | null;
  createdByEmail: string | null;
  /** A dividend whose ratio differs from the year's first (benchmark) dividend. */
  ratioDiffers: boolean;
};

export type Ica = {
  icaYear: number;
  start: string;
  end: string;
  opening: string;
  rows: IcaRow[];
  closing: string;
  /** When the closing balance is a debit: further income tax and the 10% penalty, due 20 June. */
  debitBalance: { furtherIncomeTax: string; penalty: string; dueDate: string; onTimeBy: OnTimeBy } | null;
  notes: string[];
};

type EntryRow = { id: string; request_hash: string; entry_date: string; kind: IcaKind; amount: string; dividend_amount: string | null; description: string | null; created_by_email: string | null };
const COLUMNS = "id::text, request_hash, entry_date::text, kind, amount::text, dividend_amount::text, description, created_by_email";

type Movement = { id: string | null; date: string; kind: IcaKind | "tax_paid"; amount: Decimal; dividend: Decimal | null; description: string | null; createdByEmail: string | null };

/** The ICA for a year from its movements (ITX25-ITX28). Pure. */
export function icaLedger(movements: Movement[], icaYear: number): Ica {
  const { start, end } = incomeYearDates(icaYear);
  const sorted = [...movements].sort((a, b) => (a.kind === "opening" ? -1 : b.kind === "opening" ? 1 : a.date.localeCompare(b.date)) || (a.id ?? "").localeCompare(b.id ?? ""));
  let balance = ZERO_DECIMAL;
  for (const entry of sorted) if (entry.date < start) balance = add(balance, entry.amount);
  const opening = balance;
  const rows: IcaRow[] = [];
  let benchmark: Decimal | null = null;
  for (const entry of sorted) {
    if (entry.date < start || entry.date > end) continue;
    balance = add(balance, entry.amount);
    let ratioDiffers = false;
    if (entry.kind === "dividend_paid" && entry.dividend) {
      const ratio = divide(neg(entry.amount), entry.dividend, 6);
      if (benchmark === null) benchmark = ratio;
      else ratioDiffers = cmp(ratio, benchmark) !== 0;
    }
    rows.push({
      id: entry.id,
      date: entry.date,
      kind: entry.kind,
      label: ICA_KIND_LABELS[entry.kind],
      description: entry.description,
      amount: money(entry.amount),
      balance: money(balance),
      dividendAmount: entry.dividend ? money(entry.dividend) : null,
      createdByEmail: entry.createdByEmail,
      ratioDiffers,
    });
  }
  let debitBalance: Ica["debitBalance"] = null;
  const notes: string[] = [];
  if (isNegative(balance)) {
    const due = `${icaYear}-06-20`;
    const tax = neg(balance);
    debitBalance = { furtherIncomeTax: money(tax), penalty: money(roundHalfUp(mul(tax, IMPUTATION_PENALTY_RATE), 2)), dueDate: due, onTimeBy: onTimeBy(due) };
    notes.push("A debit balance at 31 March means further income tax to clear it, plus 10% imputation penalty tax, due 20 June (IR274). Pay it before 31 March to avoid both.");
  }
  if (rows.some((row) => row.ratioDiffers)) {
    notes.push("A dividend this year carries a different ratio of credits from the year's first dividend. IR274 says that needs an IR407 ratio change declaration before it's paid, or an allocation debit arises; Tohyee doesn't work that debit out.");
  }
  notes.push("A change of more than 34% in who owns the shares can wipe out credits (a shareholder continuity debit); Tohyee doesn't check this, so type it as an other debit.");
  return { icaYear, start, end, opening: money(opening), rows, closing: money(balance), debitBalance, notes };
}

async function movements(tx: OrgTx): Promise<Movement[]> {
  const typed = await tx.query<EntryRow>(`select ${COLUMNS} from ica_entries order by entry_date, ica_entries.id`);
  const paid = await tx.query<{ id: string; paid_on: string; amount: string; income_year: number; note: string | null; created_by_email: string | null }>(
    "select id::text, paid_on::text, amount::text, income_year, note, created_by_email from income_tax_payments order by paid_on, income_tax_payments.id",
  );
  return [
    ...typed.rows.map((row) => ({ id: row.id, date: row.entry_date, kind: row.kind, amount: dec(row.amount), dividend: row.dividend_amount ? dec(row.dividend_amount) : null, description: row.description, createdByEmail: row.created_by_email })),
    ...paid.rows.map((row) => ({
      id: null,
      date: row.paid_on,
      kind: "tax_paid" as const,
      amount: dec(row.amount),
      dividend: null,
      description: `Towards the ${row.income_year} income year${row.note ? `: ${row.note}` : ""}`,
      createdByEmail: row.created_by_email,
    })),
  ];
}

export async function buildIca(tx: OrgTx, icaYear: number): Promise<Ica> {
  return icaLedger(await movements(tx), icaYear);
}

/** Types an ICA entry (ITX26, ITX27, ITX29). `amount` is positive; whether it's a credit or debit comes from its kind. */
export async function addIcaEntry(
  tx: OrgTx,
  input: { idempotencyKey: unknown; entryDate: unknown; kind: unknown; amount?: unknown; dividendAmount?: unknown; description?: unknown },
): Promise<{ created: boolean; entryId: string }> {
  const type = await tx.query<{ taxpayer_type: string | null }>("select taxpayer_type from income_tax_settings where id");
  if (type.rows[0]?.taxpayer_type !== "company") throw new ValidationError("Only companies keep an imputation credit account. Set the taxpayer to a company first.");
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const entryDate = parseIsoDate(input.entryDate, "entryDate");
  const kind = requireOneOf(input.kind, "kind", ICA_KINDS);
  const description = optionalString(input.description, "description", { maxLength: 200 });
  let dividend: string | null = null;
  let amount: string;
  if (kind === "dividend_paid") {
    dividend = parseDecimalInput(input.dividendAmount, "dividendAmount", { maxScale: 2 });
    const max = maxCredits(dec(dividend));
    amount = input.amount == null || input.amount === "" ? money(max) : parseDecimalInput(input.amount, "amount", { maxScale: 2, allowZero: true });
    if (cmp(dec(amount), max) > 0) {
      throw new ValidationError(`A ${money(dec(dividend))} dividend can carry at most ${money(max)} of imputation credits (28/72 of the dividend).`);
    }
    if (cmp(dec(amount), ZERO_DECIMAL) === 0) throw new ValidationError("A dividend with no imputation credits doesn't change the imputation credit account.");
  } else if (kind === "opening") {
    amount = parseDecimalInput(input.amount, "amount", { maxScale: 2, allowNegative: true, allowZero: true });
  } else {
    amount = parseDecimalInput(input.amount, "amount", { maxScale: 2 });
  }
  const signed = DEBITS.includes(kind) ? money(neg(dec(amount))) : amount;
  const hash = requestHash("ica_entry", { entryDate, kind, amount: signed, dividend, description });
  const existing = await tx.query<EntryRow>(`select ${COLUMNS} from ica_entries where idempotency_key = $1`, [idempotencyKey]);
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "imputation credit account entry");
    return { created: false, entryId: existing.rows[0].id };
  }
  if (kind === "opening") {
    const opening = await tx.query("select 1 from ica_entries where kind = 'opening'");
    if (opening.rowCount) throw new ConflictError("There's already an opening balance. Remove it first to type a different one.");
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into ica_entries (idempotency_key, request_hash, entry_date, kind, amount, dividend_amount, description, created_by_email)
     values ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8) returning id::text`,
    [idempotencyKey, hash, entryDate, kind, signed, dividend, description, tx.actor.email],
  );
  const entryId = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "income_tax.ica_entry_added", entityType: "ica_entry", entityId: entryId, details: { entryDate, kind, amount: signed, dividendAmount: dividend, description } });
  return { created: true, entryId };
}

export async function removeIcaEntry(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "entryId");
  const removed = await tx.query<EntryRow>(`delete from ica_entries where id = $1 returning ${COLUMNS}`, [id]);
  const row = removed.rows[0];
  if (!row) throw new NotFoundError("Imputation credit account entry not found.");
  await writeAuditEvent(tx, { eventType: "income_tax.ica_entry_removed", entityType: "ica_entry", entityId: id, details: { entryDate: row.entry_date, kind: row.kind, amount: row.amount, dividendAmount: row.dividend_amount } });
}
