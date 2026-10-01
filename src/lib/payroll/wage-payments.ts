import { parseAccountCodeInput } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { resolveBankAccount } from "@/lib/bills/payments";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { controlAccountCode } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { add, cmp, dec, isZero, parseDecimalInput, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { payRunReference, WAGES_ACCOUNT } from "@/lib/payroll/pay-runs";
import { optionalSource, requireIdempotencyKey } from "@/lib/validation";

/**
 * Paying an approved pay run's net wages (examples PPAY1-PPAY3, payroll
 * stage P4): Dr wages payable, Cr the bank, dated the payment date, for the
 * whole pay run or one employee on it (so each bank line can be matched).
 * Never more than what's unpaid. Journal lines say "Net pay", never whose
 * (decision 6); who a payment was for is kept here, for people with payroll
 * access. Voiding posts the exact reversal. Everything needs payroll access.
 */

export type WagePaymentStatus = "active" | "voided";

export type WagePayment = {
  id: string;
  /** WAGES-n: the journal reference. */
  reference: string;
  payRunId: string;
  payRunReference: string;
  /** Null when the payment is for the whole pay run. */
  employeeId: string | null;
  employeeName: string | null;
  paymentDate: string;
  bankAccountCode: string;
  bankAccountName: string;
  amount: string;
  journalId: string;
  status: WagePaymentStatus;
  createdByEmail: string;
  voidDate: string | null;
  voidJournalId: string | null;
  voidedByEmail: string | null;
};

export type PayRunPayments = {
  payRunId: string;
  reference: string;
  payRunStatus: "draft" | "approved" | "voided";
  payDate: string;
  netPay: string;
  paid: string;
  unpaid: string;
  /** How the active payments pay it: as a whole, per employee, or not yet. */
  paidAs: "whole" | "per_employee" | null;
  employees: Array<{ employeeId: string; name: string; netPay: string; paid: string; unpaid: string }>;
  /** Newest first, voided ones included. */
  payments: WagePayment[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuid(input: unknown, what: string): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) throw new NotFoundError(`That ${what} wasn't found.`);
  return input;
}

export function wagePaymentReference(paymentNumber: string | number): string {
  return `WAGES-${paymentNumber}`;
}

type RunRow = {
  id: string;
  run_number: string;
  status: "draft" | "approved" | "voided";
  pay_date: string;
  period_start: string;
  period_end: string;
  pay_group_name: string;
};

async function findRun(tx: OrgTx, idInput: unknown, forUpdate = false): Promise<RunRow> {
  const id = parseUuid(idInput, "pay run");
  if (forUpdate) await tx.query("select 1 from payroll_pay_runs where id = $1 for update", [id]);
  const result = await tx.query<RunRow>(
    `select r.id, r.run_number::text, r.status, r.pay_date::text, r.period_start::text, r.period_end::text, g.name as pay_group_name
       from payroll_pay_runs r join payroll_pay_groups g on g.id = r.pay_group_id where r.id = $1`,
    [id],
  );
  if (!result.rows[0]) throw new NotFoundError("That pay run wasn't found.");
  return result.rows[0];
}

type PaymentRow = {
  id: string;
  payment_number: string;
  pay_run_id: string;
  run_number: string;
  employee_id: string | null;
  employee_name: string | null;
  payment_date: string;
  bank_code: string;
  bank_name: string;
  amount: string;
  journal_id: string;
  status: WagePaymentStatus;
  created_by_email: string;
  void_date: string | null;
  void_journal_id: string | null;
  voided_by_email: string | null;
};

const PAYMENT_SELECT = `select p.id, p.payment_number::text, p.pay_run_id, r.run_number::text, p.employee_id,
         pe.employee_name, p.payment_date::text, a.code as bank_code, a.name as bank_name, p.amount::text,
         p.journal_id::text, p.status, p.created_by_email, p.void_date::text, p.void_journal_id::text, p.voided_by_email
    from payroll_wage_payments p
    join payroll_pay_runs r on r.id = p.pay_run_id
    join accounts a on a.id = p.bank_account_id
    left join payroll_pay_run_employees pe on pe.pay_run_id = p.pay_run_id and pe.employee_id = p.employee_id`;

function toPayment(row: PaymentRow): WagePayment {
  return {
    id: row.id,
    reference: wagePaymentReference(row.payment_number),
    payRunId: row.pay_run_id,
    payRunReference: payRunReference(row.run_number),
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    paymentDate: row.payment_date,
    bankAccountCode: row.bank_code,
    bankAccountName: row.bank_name,
    amount: toFixedString(dec(row.amount), 2),
    journalId: row.journal_id,
    status: row.status,
    createdByEmail: row.created_by_email,
    voidDate: row.void_date,
    voidJournalId: row.void_journal_id,
    voidedByEmail: row.voided_by_email,
  };
}

async function paymentsOf(tx: OrgTx, run: RunRow): Promise<PayRunPayments> {
  const payments = (await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.pay_run_id = $1 order by p.payment_number desc`, [run.id])).rows.map(
    toPayment,
  );
  // Net pay is only known once the pay run is approved (its stored snapshot).
  const employees = await tx.query<{ employee_id: string; name: string; net_pay: string | null }>(
    `select pe.employee_id, coalesce(pe.employee_name, e.first_name || ' ' || e.last_name) as name, pe.net_pay::text
       from payroll_pay_run_employees pe join payroll_employees e on e.id = pe.employee_id
      where pe.pay_run_id = $1
      order by lower(e.last_name), lower(e.first_name), pe.employee_id`,
    [run.id],
  );
  const active = payments.filter((payment) => payment.status === "active");
  const paidBy = (employeeId: string | null) =>
    active.filter((payment) => employeeId === null || payment.employeeId === employeeId).reduce((total, payment) => add(total, dec(payment.amount)), ZERO_DECIMAL);
  const netPay = employees.rows.reduce((total, row) => add(total, dec(row.net_pay ?? "0")), ZERO_DECIMAL);
  const paid = paidBy(null);
  return {
    payRunId: run.id,
    reference: payRunReference(run.run_number),
    payRunStatus: run.status,
    payDate: run.pay_date,
    netPay: toFixedString(netPay, 2),
    paid: toFixedString(paid, 2),
    unpaid: toFixedString(run.status === "approved" ? sub(netPay, paid) : ZERO_DECIMAL, 2),
    paidAs: active.length === 0 ? null : active[0].employeeId === null ? "whole" : "per_employee",
    employees: employees.rows.map((row) => {
      const net = dec(row.net_pay ?? "0");
      const employeePaid = active[0]?.employeeId === null ? ZERO_DECIMAL : paidBy(row.employee_id);
      return {
        employeeId: row.employee_id,
        name: row.name,
        netPay: toFixedString(net, 2),
        paid: toFixedString(employeePaid, 2),
        unpaid: toFixedString(run.status === "approved" && active[0]?.employeeId !== null ? sub(net, employeePaid) : ZERO_DECIMAL, 2),
      };
    }),
    payments,
  };
}

/** A pay run's wage payments and what's unpaid, in total and per employee (PPAY1, PPAY2). */
export async function listWagePayments(tx: OrgTx, runIdInput: unknown): Promise<PayRunPayments> {
  await requirePayrollAccess(tx);
  return paymentsOf(tx, await findRun(tx, runIdInput));
}

type PaymentResult = { created: boolean; payment: WagePayment; payments: PayRunPayments };

async function result(tx: OrgTx, runId: string, paymentId: string, created: boolean): Promise<PaymentResult> {
  const payments = await paymentsOf(tx, await findRun(tx, runId));
  const payment = payments.payments.find((entry) => entry.id === paymentId);
  if (!payment) throw new NotFoundError("That wage payment wasn't found.");
  return { created, payment, payments };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function journalDescription(run: RunRow, oneEmployee: boolean): string {
  return `Wages paid for pay run ${payRunReference(run.run_number)}: ${run.pay_group_name}, ${run.period_start} to ${run.period_end}${oneEmployee ? " (one employee)" : ""}`;
}

/**
 * Pays an approved pay run's net wages from a bank account (PPAY1, PPAY2),
 * for the whole pay run or, with `employeeId`, one employee on it.
 */
export async function recordWagePayment(
  tx: OrgTx,
  runIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; paymentDate: unknown; amount: unknown; bankAccountCode: unknown; employeeId?: unknown },
): Promise<PaymentResult> {
  await requirePayrollAccess(tx);
  const runId = parseUuid(runIdInput, "pay run");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const paymentDate = parseIsoDate(command.paymentDate, "Payment date");
  const amount = dec(parseDecimalInput(command.amount, "Amount", { maxScale: 2 }));
  const bankAccountCode = parseAccountCodeInput(command.bankAccountCode, "bankAccountCode");
  const employeeId =
    command.employeeId === undefined || command.employeeId === null || command.employeeId === "" ? null : parseUuid(command.employeeId, "employee");
  const hash = requestHash("payroll_wage_payment", {
    runId,
    paymentDate,
    amount: toPlainString(amount),
    bankAccountCode: bankAccountCode.toLowerCase(),
    employeeId,
  });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; pay_run_id: string; request_hash: string }>(
      "select id, pay_run_id, request_hash from payroll_wage_payments where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "wage payment");
    return result(tx, earlier.rows[0].pay_run_id, earlier.rows[0].id, false);
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const run = await findRun(tx, runId, true);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const reference = payRunReference(run.run_number);
  if (run.status !== "approved") {
    throw new ConflictError(`${reference} is ${run.status === "draft" ? "a draft" : "voided"}, so its wages can't be paid.${run.status === "draft" ? " Approve it first." : ""}`);
  }
  if (paymentDate < run.pay_date) throw new ValidationError(`The payment date can't be before ${reference}'s pay date (${run.pay_date}).`);
  await assertPostingDateAllowed(tx, paymentDate);

  const current = await paymentsOf(tx, run);
  if (current.paidAs === "per_employee" && employeeId === null) {
    throw new ConflictError(`${reference} is being paid per employee. Pay the rest per employee too, or void those payments first.`);
  }
  if (current.paidAs === "whole" && employeeId !== null) {
    throw new ConflictError(`${reference} is being paid as a whole. Pay the rest as a whole too, or void those payments first.`);
  }
  let unpaid = current.unpaid;
  let whose = "";
  if (employeeId !== null) {
    const entry = current.employees.find((candidate) => candidate.employeeId === employeeId);
    if (!entry) throw new ValidationError(`That employee isn't on ${reference}.`);
    unpaid = entry.unpaid;
    whose = `${entry.name}'s `;
  }
  if (isZero(dec(unpaid))) {
    throw new ConflictError(employeeId === null ? `${reference}'s net pay is already paid in full.` : `${whose}net pay on ${reference} is already paid in full.`);
  }
  if (cmp(amount, dec(unpaid)) > 0) {
    throw new ValidationError(`That's more than the ${formatMoney(unpaid)} of ${whose}net pay left to pay on ${reference}.`);
  }

  const bank = await resolveBankAccount(tx, bankAccountCode);
  const payable = await controlAccountCode(tx, WAGES_ACCOUNT, "wages can't be paid");
  const next = await tx.query<{ payment_number: string }>(
    "select nextval(pg_get_serial_sequence('payroll_wage_payments', 'payment_number'))::text as payment_number",
  );
  const paymentNumber = next.rows[0].payment_number;
  const fixed = toFixedString(amount, 2);
  const posted = await postJournalBody(
    tx,
    "payroll:wage_payment",
    `${run.id}:${paymentNumber}`,
    parseJournalBody(
      tx,
      {
        postingDate: paymentDate,
        reference: wagePaymentReference(paymentNumber),
        description: journalDescription(run, employeeId !== null),
        lines: [
          { accountCode: payable, debitAmount: fixed, creditAmount: "0", description: "Net pay" },
          { accountCode: bank.code, debitAmount: "0", creditAmount: fixed, description: "Net pay" },
        ],
      },
      { internal: true },
    ),
    { origin: "payroll" },
  );
  let paymentId: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into payroll_wage_payments (payment_number, command_source, idempotency_key, request_hash, pay_run_id, employee_id,
                                          payment_date, bank_account_id, amount, journal_id, created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12) returning id`,
      [paymentNumber, source, idempotencyKey, hash, run.id, employeeId, paymentDate, bank.id, fixed, posted.journal.id, tx.actor.userId, tx.actor.email],
    );
    paymentId = inserted.rows[0].id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different wage payment. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_wage_payment.recorded",
    entityType: "payroll_wage_payment",
    entityId: paymentId,
    // Never the amount: it can be one person's pay (PPAY10).
    details: {
      reference: wagePaymentReference(paymentNumber),
      payRunId: run.id,
      payRunReference: reference,
      employeeId,
      paymentDate,
      bankAccountCode: bank.code,
      journalId: posted.journal.id,
    },
  });
  return result(tx, run.id, paymentId, true);
}

/** Voids a wage payment (PPAY3): the exact reversal on the void date; the amount is unpaid again. */
export async function voidWagePayment(
  tx: OrgTx,
  runIdInput: unknown,
  paymentIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<PaymentResult> {
  await requirePayrollAccess(tx);
  const runId = parseUuid(runIdInput, "pay run");
  const paymentId = parseUuid(paymentIdInput, "wage payment");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "Void date");
  const hash = requestHash("payroll_wage_payment_void", { paymentId, voidDate });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; pay_run_id: string; void_request_hash: string }>(
      "select id, pay_run_id, void_request_hash from payroll_wage_payments where void_command_source = $1 and void_idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].void_request_hash, hash, "wage payment void");
    return result(tx, earlier.rows[0].pay_run_id, earlier.rows[0].id, false);
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const run = await findRun(tx, runId, true);
  const found = await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.id = $1 and p.pay_run_id = $2 for update of p`, [paymentId, run.id]);
  if (!found.rows[0]) throw new NotFoundError("That wage payment wasn't found.");
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const payment = toPayment(found.rows[0]);
  if (payment.status === "voided") throw new ConflictError(`${payment.reference} has already been voided.`);
  if (voidDate < payment.paymentDate) throw new ValidationError(`The void date can't be before the payment date (${payment.paymentDate}).`);
  await assertPostingDateAllowed(tx, voidDate);
  const original = await getJournal(tx, payment.journalId);
  const posted = await postJournalBody(
    tx,
    "payroll:wage_payment_void",
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
      `update payroll_wage_payments
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4, void_idempotency_key = $5,
              void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8, voided_at = now()
        where id = $1`,
      [payment.id, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different wage payment void. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_wage_payment.voided",
    entityType: "payroll_wage_payment",
    entityId: payment.id,
    details: { reference: payment.reference, payRunId: run.id, voidDate, journalId: posted.journal.id },
  });
  return result(tx, run.id, payment.id, true);
}
