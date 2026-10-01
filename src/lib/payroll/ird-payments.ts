import { parseAccountCodeInput } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { resolveBankAccount } from "@/lib/bills/payments";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { type ControlAccount, controlAccountCode } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { add, cmp, dec, type Decimal, isZero, parseDecimalInput, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { type IrdPaymentFrequency, type IrdPeriod, irdPeriodFromStart, irdPeriodsBetween } from "@/lib/payroll/ird-due-dates";
import { ESCT_ACCOUNT, KIWISAVER_ACCOUNT, PAYE_ACCOUNT, payRunReference, STUDENT_LOAN_ACCOUNT } from "@/lib/payroll/pay-runs";
import { asRecord, optionalSource, requireArray, requireIdempotencyKey } from "@/lib/validation";

/**
 * IRD payroll payments (examples PPAY4-PPAY9, PPAY12, payroll stage P4):
 * what's owing to IRD for an IRD period (approved pay runs by pay date),
 * per liability the pay runs credited (PAYE including the ACC earners'
 * levy, student loan, KiwiSaver employee and employer net of ESCT, ESCT),
 * and payments of it from a bank account: Dr each liability, Cr the bank.
 * Part payments are allowed; overpaying a liability is refused. Due dates
 * follow IRD's rules (see `ird-due-dates.ts`). Like NetSuite's Pay Payroll
 * Liabilities. Everything needs payroll access.
 */

export type IrdLiability = "paye" | "student_loan" | "kiwisaver" | "esct";

const LIABILITIES: ReadonlyArray<{ liability: IrdLiability; label: string; lineDescription: string; control: ControlAccount }> = [
  { liability: "paye", label: "PAYE (incl. ACC earners' levy)", lineDescription: "PAYE", control: PAYE_ACCOUNT },
  { liability: "student_loan", label: "Student loan", lineDescription: "Student loan", control: STUDENT_LOAN_ACCOUNT },
  { liability: "kiwisaver", label: "KiwiSaver (employee and employer)", lineDescription: "KiwiSaver", control: KIWISAVER_ACCOUNT },
  { liability: "esct", label: "ESCT", lineDescription: "ESCT", control: ESCT_ACCOUNT },
];

export type IrdPayment = {
  id: string;
  /** IRD-n: the journal reference. */
  reference: string;
  frequency: IrdPaymentFrequency;
  periodStart: string;
  periodEnd: string;
  paymentDate: string;
  bankAccountCode: string;
  bankAccountName: string;
  amount: string;
  lines: Array<{ liability: IrdLiability; label: string; accountCode: string; amount: string }>;
  journalId: string;
  status: "active" | "voided";
  createdByEmail: string;
  voidDate: string | null;
  voidJournalId: string | null;
  voidedByEmail: string | null;
};

export type IrdPeriodSummary = IrdPeriod & {
  liabilities: Array<{ liability: IrdLiability; label: string; accountCode: string | null; fromPayRuns: string; paid: string; owing: string }>;
  totalFromPayRuns: string;
  totalPaid: string;
  totalOwing: string;
  payRuns: Array<{ id: string; reference: string; payGroupName: string; payDate: string }>;
  /** Newest first, voided ones included. */
  payments: IrdPayment[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function irdPaymentReference(paymentNumber: string | number): string {
  return `IRD-${paymentNumber}`;
}

export async function irdPaymentFrequency(tx: OrgTx): Promise<IrdPaymentFrequency> {
  const result = await tx.query<{ payroll_ird_payment_frequency: IrdPaymentFrequency }>(
    "select payroll_ird_payment_frequency from organisation_settings where id = true",
  );
  return result.rows[0]?.payroll_ird_payment_frequency ?? "monthly";
}

type PaymentRow = {
  id: string;
  payment_number: string;
  frequency: IrdPaymentFrequency;
  period_start: string;
  period_end: string;
  payment_date: string;
  bank_code: string;
  bank_name: string;
  amount: string;
  journal_id: string;
  status: "active" | "voided";
  created_by_email: string;
  void_date: string | null;
  void_journal_id: string | null;
  voided_by_email: string | null;
};

const PAYMENT_SELECT = `select p.id, p.payment_number::text, p.frequency, p.period_start::text, p.period_end::text, p.payment_date::text,
         a.code as bank_code, a.name as bank_name, p.amount::text, p.journal_id::text, p.status, p.created_by_email,
         p.void_date::text, p.void_journal_id::text, p.voided_by_email
    from payroll_ird_payments p join accounts a on a.id = p.bank_account_id`;

async function toPayments(tx: OrgTx, rows: PaymentRow[]): Promise<IrdPayment[]> {
  if (rows.length === 0) return [];
  const lines = await tx.query<{ ird_payment_id: string; liability: IrdLiability; code: string; amount: string }>(
    `select l.ird_payment_id, l.liability, a.code, l.amount::text
       from payroll_ird_payment_lines l join accounts a on a.id = l.account_id
      where l.ird_payment_id = any($1::uuid[])`,
    [rows.map((row) => row.id)],
  );
  const order = (liability: IrdLiability) => LIABILITIES.findIndex((entry) => entry.liability === liability);
  return rows.map((row) => ({
    id: row.id,
    reference: irdPaymentReference(row.payment_number),
    frequency: row.frequency,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    paymentDate: row.payment_date,
    bankAccountCode: row.bank_code,
    bankAccountName: row.bank_name,
    amount: toFixedString(dec(row.amount), 2),
    lines: lines.rows
      .filter((line) => line.ird_payment_id === row.id)
      .sort((a, b) => order(a.liability) - order(b.liability))
      .map((line) => ({
        liability: line.liability,
        label: LIABILITIES[order(line.liability)].label,
        accountCode: line.code,
        amount: toFixedString(dec(line.amount), 2),
      })),
    journalId: row.journal_id,
    status: row.status,
    createdByEmail: row.created_by_email,
    voidDate: row.void_date,
    voidJournalId: row.void_journal_id,
    voidedByEmail: row.voided_by_email,
  }));
}

async function accountCodes(tx: OrgTx): Promise<Map<string, string>> {
  const result = await tx.query<{ system_key: string; code: string }>(
    "select system_key, code from accounts where system_key = any($1::text[])",
    [LIABILITIES.map((entry) => entry.control.systemKey)],
  );
  return new Map(result.rows.map((row) => [row.system_key, row.code]));
}

/** What's owing for one IRD period: the approved pay runs paid in it, less active IRD payments for it (PPAY4). */
async function summarise(tx: OrgTx, period: IrdPeriod): Promise<IrdPeriodSummary> {
  const runs = await tx.query<{ id: string; run_number: string; pay_group_name: string; pay_date: string }>(
    `select r.id, r.run_number::text, g.name as pay_group_name, r.pay_date::text
       from payroll_pay_runs r join payroll_pay_groups g on g.id = r.pay_group_id
      where r.status = 'approved' and r.pay_date between $1 and $2
      order by r.pay_date, r.run_number`,
    [period.start, period.end],
  );
  // The pay runs' own credits to the liability accounts (approvePayRun): their stored totals.
  const owed = await tx.query<{ paye: string; student_loan: string; kiwisaver: string; esct: string }>(
    `select coalesce(sum(pe.paye), 0)::text as paye,
            coalesce(sum(pe.student_loan_deduction), 0)::text as student_loan,
            coalesce(sum(pe.kiwisaver_employee + pe.kiwisaver_employer_net), 0)::text as kiwisaver,
            coalesce(sum(pe.esct), 0)::text as esct
       from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id
      where r.status = 'approved' and r.pay_date between $1 and $2`,
    [period.start, period.end],
  );
  const paidRows = await tx.query<{ liability: IrdLiability; amount: string }>(
    `select l.liability, sum(l.amount)::text as amount
       from payroll_ird_payment_lines l join payroll_ird_payments p on p.id = l.ird_payment_id
      where p.status = 'active' and p.period_start = $1 and p.period_end = $2
      group by l.liability`,
    [period.start, period.end],
  );
  const paid = new Map(paidRows.rows.map((row) => [row.liability, dec(row.amount)]));
  const codes = await accountCodes(tx);
  const payments = await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.period_start = $1 and p.period_end = $2 order by p.payment_number desc`, [
    period.start,
    period.end,
  ]);
  let totalFrom: Decimal = ZERO_DECIMAL;
  let totalPaid: Decimal = ZERO_DECIMAL;
  const liabilities = LIABILITIES.map((entry) => {
    const from = dec(owed.rows[0][entry.liability]);
    const paidAmount = paid.get(entry.liability) ?? ZERO_DECIMAL;
    totalFrom = add(totalFrom, from);
    totalPaid = add(totalPaid, paidAmount);
    return {
      liability: entry.liability,
      label: entry.label,
      accountCode: codes.get(entry.control.systemKey) ?? null,
      fromPayRuns: toFixedString(from, 2),
      paid: toFixedString(paidAmount, 2),
      owing: toFixedString(sub(from, paidAmount), 2),
    };
  });
  return {
    ...period,
    liabilities,
    totalFromPayRuns: toFixedString(totalFrom, 2),
    totalPaid: toFixedString(totalPaid, 2),
    totalOwing: toFixedString(sub(totalFrom, totalPaid), 2),
    payRuns: runs.rows.map((row) => ({ id: row.id, reference: payRunReference(row.run_number), payGroupName: row.pay_group_name, payDate: row.pay_date })),
    payments: await toPayments(tx, payments.rows),
  };
}

/** One IRD period, by its first day, for the organisation's current frequency (PPAY4, PPAY9). */
export async function getIrdPeriod(tx: OrgTx, periodStartInput: unknown): Promise<IrdPeriodSummary> {
  await requirePayrollAccess(tx);
  return summarise(tx, irdPeriodFromStart(periodStartInput, await irdPaymentFrequency(tx)));
}

/**
 * The IRD periods with approved pay runs or IRD payments in the last two
 * years or so, newest first (Payroll › IRD payments). Periods of payments
 * made under another frequency are shown as they were paid.
 */
export async function listIrdPeriods(tx: OrgTx): Promise<{ frequency: IrdPaymentFrequency; periods: IrdPeriodSummary[] }> {
  await requirePayrollAccess(tx);
  const frequency = await irdPaymentFrequency(tx);
  const payDates = await tx.query<{ pay_date: string }>(
    "select distinct pay_date::text from payroll_pay_runs where status = 'approved' order by pay_date desc limit 120",
  );
  const periods = new Map(irdPeriodsBetween(payDates.rows.map((row) => row.pay_date), frequency).map((period) => [`${period.start}|${period.end}`, period]));
  const paidPeriods = await tx.query<{ frequency: IrdPaymentFrequency; period_start: string }>(
    "select distinct frequency, period_start::text from payroll_ird_payments order by period_start desc limit 60",
  );
  for (const row of paidPeriods.rows) {
    const period = irdPeriodFromStart(row.period_start, row.frequency);
    periods.set(`${period.start}|${period.end}`, period);
  }
  const sorted = [...periods.values()].sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : a.end < b.end ? 1 : -1)).slice(0, 48);
  const summaries: IrdPeriodSummary[] = [];
  for (const period of sorted) summaries.push(await summarise(tx, period));
  return { frequency, periods: summaries };
}

type PaymentResult = { created: boolean; payment: IrdPayment; period: IrdPeriodSummary };

async function result(tx: OrgTx, paymentId: string, created: boolean): Promise<PaymentResult> {
  const row = await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.id = $1`, [paymentId]);
  if (!row.rows[0]) throw new NotFoundError("That IRD payment wasn't found.");
  const [payment] = await toPayments(tx, row.rows);
  return { created, payment, period: await summarise(tx, irdPeriodFromStart(payment.periodStart, payment.frequency)) };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function parseLines(input: unknown): Array<{ liability: IrdLiability; amount: Decimal }> {
  const raw = requireArray(input, "lines", LIABILITIES.length);
  if (raw.length === 0) throw new ValidationError("Choose at least one amount to pay.");
  const seen = new Set<IrdLiability>();
  const lines = raw.map((entry, index) => {
    const line = asRecord(entry, `Line ${index + 1}`);
    const known = LIABILITIES.find((candidate) => candidate.liability === line.liability);
    if (!known) throw new ValidationError(`Line ${index + 1}: liability must be "paye", "student_loan", "kiwisaver" or "esct".`);
    if (seen.has(known.liability)) throw new ValidationError(`${known.label} is listed twice. Give one amount for it.`);
    seen.add(known.liability);
    return { liability: known.liability, amount: dec(parseDecimalInput(line.amount, `${known.label} amount`, { maxScale: 2 })) };
  });
  const order = (liability: IrdLiability) => LIABILITIES.findIndex((entry) => entry.liability === liability);
  return lines.sort((a, b) => order(a.liability) - order(b.liability));
}

/**
 * Pays IRD for one IRD period (PPAY5, PPAY6): each line pays one liability,
 * up to what's owing for it. Posts Dr each liability, Cr the bank, dated
 * the payment date.
 */
export async function recordIrdPayment(
  tx: OrgTx,
  command: { source?: unknown; idempotencyKey: unknown; periodStart: unknown; paymentDate: unknown; bankAccountCode: unknown; lines: unknown },
): Promise<PaymentResult> {
  await requirePayrollAccess(tx);
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const replayHashInput = { periodStart: command.periodStart, paymentDate: command.paymentDate, bankAccountCode: command.bankAccountCode, lines: command.lines };
  const hash = requestHash("payroll_ird_payment", replayHashInput);
  const replay = async () => {
    const earlier = await tx.query<{ id: string; request_hash: string }>(
      "select id, request_hash from payroll_ird_payments where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "IRD payment");
    return result(tx, earlier.rows[0].id, false);
  };
  const earlier = await replay();
  if (earlier) return earlier;
  // IRD payments are recorded one at a time, so two can't both pay what's owing.
  await tx.query("select 1 from organisation_settings where id = true for update");
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;

  const frequency = await irdPaymentFrequency(tx);
  const period = irdPeriodFromStart(command.periodStart, frequency);
  const paymentDate = parseIsoDate(command.paymentDate, "Payment date");
  const bankAccountCode = parseAccountCodeInput(command.bankAccountCode, "bankAccountCode");
  const lines = parseLines(command.lines);
  if (paymentDate < period.start) throw new ValidationError(`The payment date can't be before the period starts (${period.start}).`);
  await assertPostingDateAllowed(tx, paymentDate);
  const overlapping = await tx.query<{ payment_number: string; period_start: string; period_end: string }>(
    `select payment_number::text, period_start::text, period_end::text from payroll_ird_payments
      where status = 'active' and period_start <= $2 and period_end >= $1 and (period_start, period_end) <> ($1::date, $2::date)
      order by payment_number limit 1`,
    [period.start, period.end],
  );
  if (overlapping.rows[0]) {
    const other = overlapping.rows[0];
    const name = irdPaymentReference(other.payment_number);
    throw new ConflictError(`${name} already pays ${other.period_start} to ${other.period_end}. Pay that period, or void ${name} first.`);
  }
  const summary = await summarise(tx, period);
  if (isZero(dec(summary.totalFromPayRuns))) throw new ValidationError(`Nothing is owing to IRD for ${period.start} to ${period.end}.`);
  for (const line of lines) {
    const entry = summary.liabilities.find((candidate) => candidate.liability === line.liability)!;
    if (cmp(line.amount, dec(entry.owing)) > 0) {
      const label = LIABILITIES.find((candidate) => candidate.liability === line.liability)!.lineDescription;
      throw new ValidationError(`That's more than the ${formatMoney(entry.owing)} of ${label} owing for ${period.start} to ${period.end}.`);
    }
  }

  const bank = await resolveBankAccount(tx, bankAccountCode);
  const debits: Array<{ liability: IrdLiability; accountCode: string; amount: string; description: string }> = [];
  let total: Decimal = ZERO_DECIMAL;
  for (const line of lines) {
    const known = LIABILITIES.find((candidate) => candidate.liability === line.liability)!;
    const accountCode = await controlAccountCode(tx, known.control, "IRD can't be paid");
    debits.push({ liability: line.liability, accountCode, amount: toFixedString(line.amount, 2), description: known.lineDescription });
    total = add(total, line.amount);
  }
  const fixedTotal = toFixedString(total, 2);
  const next = await tx.query<{ payment_number: string }>(
    "select nextval(pg_get_serial_sequence('payroll_ird_payments', 'payment_number'))::text as payment_number",
  );
  const paymentNumber = next.rows[0].payment_number;
  const reference = irdPaymentReference(paymentNumber);
  const posted = await postJournalBody(
    tx,
    "payroll:ird_payment",
    paymentNumber,
    parseJournalBody(
      tx,
      {
        postingDate: paymentDate,
        reference,
        description: `IRD payroll payment for ${period.start} to ${period.end}`,
        lines: [
          ...debits.map((line) => ({ accountCode: line.accountCode, debitAmount: line.amount, creditAmount: "0", description: line.description })),
          { accountCode: bank.code, debitAmount: "0", creditAmount: fixedTotal, description: "IRD payroll payment" },
        ],
      },
      { internal: true },
    ),
    { origin: "payroll" },
  );
  let paymentId: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into payroll_ird_payments (payment_number, command_source, idempotency_key, request_hash, frequency, period_start, period_end,
                                         payment_date, bank_account_id, amount, journal_id, created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12, $13) returning id`,
      [
        paymentNumber,
        source,
        idempotencyKey,
        hash,
        frequency,
        period.start,
        period.end,
        paymentDate,
        bank.id,
        fixedTotal,
        posted.journal.id,
        tx.actor.userId,
        tx.actor.email,
      ],
    );
    paymentId = inserted.rows[0].id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different IRD payment. Use a new key.");
    throw error;
  }
  for (const line of debits) {
    await tx.query(
      `insert into payroll_ird_payment_lines (ird_payment_id, liability, account_id, amount)
       values ($1, $2, (select id from accounts where lower(code) = lower($3)), $4::numeric)`,
      [paymentId, line.liability, line.accountCode, line.amount],
    );
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_ird_payment.recorded",
    entityType: "payroll_ird_payment",
    entityId: paymentId,
    // Never the amounts: with one employee they're one person's deductions (PPAY10).
    details: {
      reference,
      periodStart: period.start,
      periodEnd: period.end,
      paymentDate,
      bankAccountCode: bank.code,
      liabilities: debits.map((line) => line.liability),
      journalId: posted.journal.id,
    },
  });
  return result(tx, paymentId, true);
}

/** Voids an IRD payment (PPAY12): the exact reversal on the void date; the amounts are owing again. */
export async function voidIrdPayment(
  tx: OrgTx,
  paymentIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<PaymentResult> {
  await requirePayrollAccess(tx);
  if (typeof paymentIdInput !== "string" || !UUID_PATTERN.test(paymentIdInput)) throw new NotFoundError("That IRD payment wasn't found.");
  const paymentId = paymentIdInput;
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "Void date");
  const hash = requestHash("payroll_ird_payment_void", { paymentId, voidDate });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; void_request_hash: string }>(
      "select id, void_request_hash from payroll_ird_payments where void_command_source = $1 and void_idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].void_request_hash, hash, "IRD payment void");
    return result(tx, earlier.rows[0].id, false);
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const found = await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.id = $1 for update of p`, [paymentId]);
  if (!found.rows[0]) throw new NotFoundError("That IRD payment wasn't found.");
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const [payment] = await toPayments(tx, found.rows);
  if (payment.status === "voided") throw new ConflictError(`${payment.reference} has already been voided.`);
  if (voidDate < payment.paymentDate) throw new ValidationError(`The void date can't be before the payment date (${payment.paymentDate}).`);
  await assertPostingDateAllowed(tx, voidDate);
  const original = await getJournal(tx, payment.journalId);
  const posted = await postJournalBody(
    tx,
    "payroll:ird_payment_void",
    payment.id,
    parseJournalBody(
      tx,
      {
        postingDate: voidDate,
        reference: `VOID-${original.reference}`.slice(0, 100),
        description: `Void of ${original.description ?? payment.reference}`.slice(0, 500),
        lines: original.lines.map((line) => ({
          accountCode: line.accountCode,
          debitAmount: line.creditAmount,
          creditAmount: line.debitAmount,
          description: line.description,
          tracking: line.tracking,
        })),
      },
      { internal: true },
    ),
    { origin: "payroll", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  try {
    await tx.query(
      `update payroll_ird_payments
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4, void_idempotency_key = $5,
              void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8, voided_at = now()
        where id = $1`,
      [payment.id, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different IRD payment void. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_ird_payment.voided",
    entityType: "payroll_ird_payment",
    entityId: payment.id,
    details: { reference: payment.reference, periodStart: payment.periodStart, periodEnd: payment.periodEnd, voidDate, journalId: posted.journal.id },
  });
  return result(tx, payment.id, true);
}

