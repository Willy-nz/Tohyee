import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { headerText, splitAddresses } from "@/lib/email/addresses";
import { checkDailyLimit, requireAccount } from "@/lib/email/documents";
import { MAX_SUBJECT_LENGTH } from "@/lib/email/templates";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, dec, isZero, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { safeFileName } from "@/lib/pdf/documents";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { maskBankAccount } from "@/lib/payroll/bank-account-number";
import { type PayFrequency, PAY_FREQUENCY_WORDS } from "@/lib/payroll/groups";
import { getLeaveSummary } from "@/lib/payroll/leave-reports";
import { getPayRun, type PayRun } from "@/lib/payroll/pay-runs";
import { addPayslipFigures, PAYSLIP_ZERO, type PayslipFigures, taxYearOf } from "@/lib/payroll/payslip-figures";
import { decryptSecret } from "@/lib/secrets";
import { optionalSource, requireIdempotencyKey } from "@/lib/validation";

/**
 * Payslips (examples PSLIP1-PSLIP6, payroll stage P5): one per employee on
 * an approved pay run, from what the pay run kept when it was approved,
 * with the year to date for the tax year. Printed, downloaded as a PDF or
 * emailed to the employee (queued here; the email job writes the PDF when
 * it sends, as the person who asked). Nothing is posted or changed, and
 * the email's text and the audit log never hold pay figures. Everything
 * needs payroll access.
 */

export type PayslipLine = {
  name: string;
  description: string | null;
  /** Hours, for items paid by the hour. */
  hours: string | null;
  rate: string | null;
  amount: string;
  /** Earnings that aren't taxed (reimbursements, non-taxable allowances). */
  notTaxed: boolean;
};

export type Payslip = {
  payRunId: string;
  payRunReference: string;
  employeeId: string;
  employer: { name: string; postalAddress: string | null };
  employee: { name: string; firstName: string; startDate: string; email: string | null };
  periodStart: string;
  periodEnd: string;
  payDate: string;
  payFrequency: PayFrequency;
  payFrequencyWords: string;
  taxCode: string;
  kiwiSaverEmployeeRate: string | null;
  kiwiSaverEmployerRate: string | null;
  earnings: PayslipLine[];
  /** After-tax deductions by name (union fees and the like). */
  deductions: PayslipLine[];
  /** Total hours on the earnings lines, or null when none are by the hour. */
  totalHours: string | null;
  pay: PayslipFigures;
  /** Employer KiwiSaver after ESCT: what goes to the employee's KiwiSaver. */
  kiwiSaverEmployerNet: string;
  taxYear: { start: string; end: string };
  yearToDate: PayslipFigures;
  /** The account net pay goes into, all but its last 3 digits hidden; null if none is on file. */
  bankAccount: string | null;
  fileName: string;
  /** The employee's last day when this is their final pay (XP12). */
  finishDate: string | null;
  /** Extra pays in this pay and the rate they were taxed at (XP8). */
  extraPay: { amount: string; taxRate: string | null } | null;
  /** The pay includes holiday pay on finishing, worked out outside Tohyee (XP12, decision 135). */
  holidayPayWorkedOutElsewhere: boolean;
  /**
   * Leave balances at the end of the pay period, when Tohyee keeps the
   * employee's leave (P8; s 81). Family violence leave isn't shown, so the
   * payslip doesn't say it exists (decision 27).
   */
  leaveBalances: PayslipLeaveBalances | null;
};

export type PayslipLeaveBalances = {
  asAt: string;
  annualWeeks: string;
  annualHours: string;
  sickDays: string;
  alternativeHolidays: number;
};

export type PayslipSummary = {
  employeeId: string;
  name: string;
  netPay: string;
  hasEmail: boolean;
  /** The latest payslip email for this pay run: its status and when. */
  lastEmail: { status: "queued" | "sending" | "sent" | "failed"; to: string[]; createdAt: string; lastError: string | null } | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuid(input: unknown, what: string): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) throw new NotFoundError(`That ${what} wasn't found.`);
  return input.toLowerCase();
}

function assertHasPayslips(run: PayRun): void {
  if (run.status === "draft") throw new ConflictError(`${run.reference} is a draft, so it has no payslips. Approve it first.`);
  if (run.status === "voided") throw new ConflictError(`${run.reference} is voided, so it has no payslips.`);
}

export function payslipFileName(name: string, payDate: string): string {
  return safeFileName(`Payslip ${name} ${payDate}`);
}

type EmployeeRow = { id: string; first_name: string; start_date: string; email: string | null; bank_account_ciphertext: string | null };

async function employeeRows(tx: OrgTx, ids: string[]): Promise<Map<string, EmployeeRow>> {
  const result = await tx.query<EmployeeRow>(
    "select id, first_name, start_date::text, email, bank_account_ciphertext from payroll_employees where id = any($1::uuid[])",
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

type YtdRow = {
  gross: string;
  paye: string;
  student_loan_deduction: string;
  kiwisaver_employee: string;
  deductions: string;
  net_pay: string;
  kiwisaver_employer: string;
  esct: string;
};

/** Approved pay runs (never voided ones) in the tax year, up to this one: same pay date counts by pay run number (PSLIP2). */
async function yearToDate(tx: OrgTx, run: PayRun, employeeId: string): Promise<{ taxYear: { start: string; end: string }; figures: PayslipFigures }> {
  const taxYear = taxYearOf(run.payDate);
  const result = await tx.query<YtdRow>(
    `select pe.gross::text, pe.paye::text, pe.student_loan_deduction::text, pe.kiwisaver_employee::text, pe.deductions::text,
            pe.net_pay::text, pe.kiwisaver_employer::text, pe.esct::text
       from payroll_pay_run_employees pe
       join payroll_pay_runs r on r.id = pe.pay_run_id
       join payroll_pay_runs me on me.id = $2
      where pe.employee_id = $1 and r.status = 'approved' and pe.gross is not null
        and r.pay_date >= $3::date
        and (r.pay_date < me.pay_date or (r.pay_date = me.pay_date and r.run_number <= me.run_number))`,
    [employeeId, run.id, taxYear.start],
  );
  let figures = PAYSLIP_ZERO;
  for (const row of result.rows) {
    figures = addPayslipFigures(figures, {
      gross: row.gross,
      paye: row.paye,
      studentLoan: row.student_loan_deduction,
      kiwiSaverEmployee: row.kiwisaver_employee,
      deductions: row.deductions,
      netPay: row.net_pay,
      kiwiSaverEmployer: row.kiwisaver_employer,
      esct: row.esct,
    });
  }
  return { taxYear, figures };
}

async function buildPayslip(tx: OrgTx, run: PayRun, employeeId: string, employees: Map<string, EmployeeRow>): Promise<Payslip> {
  const entry = run.employees.find((candidate) => candidate.employeeId === employeeId);
  if (!entry) throw new NotFoundError(`That employee isn't on ${run.reference}.`);
  if (!entry.pay) throw new ConflictError(`${entry.name}'s pay on ${run.reference} wasn't calculated, so there's no payslip.`);
  const row = employees.get(employeeId);
  if (!row) throw new NotFoundError("That employee wasn't found.");
  const settings = await getOrganisationSettings(tx);
  const taxed = await tx.query<{ id: string; subject_to_paye: boolean }>(
    "select id, subject_to_paye from payroll_pay_items where id = any($1::uuid[])",
    [[...new Set(entry.lines.map((line) => line.payItemId))]],
  );
  const extraPay = entry.pay && !isZero(dec(entry.pay.extraPay)) ? { amount: entry.pay.extraPay, taxRate: entry.pay.extraPayTaxRate } : null;
  const isTaxed = new Map(taxed.rows.map((item) => [item.id, item.subject_to_paye]));
  const earnings: PayslipLine[] = [];
  const deductions: PayslipLine[] = [];
  let hours = ZERO_DECIMAL;
  let anyHours = false;
  for (const line of entry.lines) {
    const out: PayslipLine = {
      name: line.payItemName,
      description: line.description,
      hours: line.quantity,
      rate: line.quantity === null ? null : line.rate,
      amount: line.amount,
      notTaxed: line.category === "earnings" && isTaxed.get(line.payItemId) === false,
    };
    if (line.category === "deduction") deductions.push(out);
    else if (line.category === "earnings") {
      earnings.push(out);
      if (line.quantity !== null) {
        hours = add(hours, dec(line.quantity));
        anyHours = true;
      }
    }
  }
  const pay = entry.pay;
  const ytd = await yearToDate(tx, run, employeeId);
  // The employee's account is decrypted here, inside the payroll access check, and only its mask leaves.
  const bankAccount = row.bank_account_ciphertext === null ? null : maskBankAccount(decryptSecret(row.bank_account_ciphertext));
  const enrolled = entry.kiwiSaverStatus === "enrolled";
  return {
    payRunId: run.id,
    payRunReference: run.reference,
    employeeId,
    employer: { name: settings.displayName, postalAddress: settings.postalAddress },
    employee: { name: entry.name, firstName: row.first_name, startDate: row.start_date, email: row.email },
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    payDate: run.payDate,
    payFrequency: run.payFrequency,
    payFrequencyWords: PAY_FREQUENCY_WORDS[run.payFrequency],
    taxCode: entry.taxCode,
    kiwiSaverEmployeeRate: enrolled ? entry.kiwiSaverEmployeeRate : null,
    kiwiSaverEmployerRate: enrolled ? entry.kiwiSaverEmployerRate : null,
    earnings,
    deductions,
    totalHours: anyHours ? toFixedString(hours, 2) : null,
    pay: {
      gross: pay.gross,
      paye: pay.paye,
      studentLoan: pay.studentLoan,
      kiwiSaverEmployee: pay.kiwiSaverEmployee,
      deductions: pay.deductions,
      netPay: pay.netPay,
      kiwiSaverEmployer: pay.kiwiSaverEmployer,
      esct: pay.esct,
    },
    kiwiSaverEmployerNet: pay.kiwiSaverEmployerNet,
    taxYear: ytd.taxYear,
    yearToDate: ytd.figures,
    bankAccount,
    fileName: payslipFileName(entry.name, run.payDate),
    finishDate: entry.finishDate,
    extraPay,
    holidayPayWorkedOutElsewhere: entry.lines.some((line) => line.kind === "termination_holiday_pay" && line.source !== "leave"),
    leaveBalances: await payslipLeaveBalances(tx, employeeId, run.periodEnd),
  };
}

/** Leave balances for a payslip (P5 left the gap; P8). */
async function payslipLeaveBalances(tx: OrgTx, employeeId: string, asAt: string): Promise<PayslipLeaveBalances | null> {
  const summary = await getLeaveSummary(tx, employeeId, asAt);
  if (!summary.kept || !summary.annual || !summary.sick) return null;
  return {
    asAt,
    annualWeeks: summary.annual.weeks,
    annualHours: summary.annual.hours,
    sickDays: summary.sick.days,
    alternativeHolidays: summary.alternative?.untaken ?? 0,
  };
}

/** One employee's payslip on an approved pay run (PSLIP1-PSLIP4). */
export async function getPayslip(tx: OrgTx, runIdInput: unknown, employeeIdInput: unknown): Promise<Payslip> {
  await requirePayrollAccess(tx);
  const run = await getPayRun(tx, parseUuid(runIdInput, "pay run"));
  assertHasPayslips(run);
  const employeeId = parseUuid(employeeIdInput, "employee");
  return buildPayslip(tx, run, employeeId, await employeeRows(tx, [employeeId]));
}

type EmailStatusRow = {
  employee_id: string;
  status: "queued" | "sending" | "sent" | "failed";
  to_addresses: string[];
  created_at: string;
  last_error: string | null;
};

/** Everyone on an approved pay run, with whether they have an email address and their latest payslip email (PSLIP5). */
export async function listPayslips(tx: OrgTx, runIdInput: unknown): Promise<{ payRunId: string; reference: string; payDate: string; payslips: PayslipSummary[] }> {
  await requirePayrollAccess(tx);
  const run = await getPayRun(tx, parseUuid(runIdInput, "pay run"));
  assertHasPayslips(run);
  const employees = await employeeRows(
    tx,
    run.employees.map((entry) => entry.employeeId),
  );
  const emails = await tx.query<EmailStatusRow>(
    `select distinct on (employee_id) employee_id::text, status, to_addresses, created_at::text, last_error
       from document_emails where document_kind = 'payslip' and pay_run_id = $1
      order by employee_id, id desc`,
    [run.id],
  );
  const latest = new Map(emails.rows.map((row) => [row.employee_id, row]));
  return {
    payRunId: run.id,
    reference: run.reference,
    payDate: run.payDate,
    payslips: run.employees.map((entry) => {
      const email = latest.get(entry.employeeId);
      return {
        employeeId: entry.employeeId,
        name: entry.name,
        netPay: entry.pay?.netPay ?? "0.00",
        hasEmail: Boolean(employees.get(entry.employeeId)?.email?.trim()),
        lastEmail: email ? { status: email.status, to: email.to_addresses, createdAt: email.created_at, lastError: email.last_error } : null,
      };
    }),
  };
}

/** The fixed subject and message of a payslip email: never any pay figures (PSLIP5). */
export function payslipEmailText(payslip: Pick<Payslip, "employer" | "employee" | "periodStart" | "periodEnd" | "payDate">): { subject: string; body: string } {
  return {
    subject: headerText(`Payslip for ${formatDate(payslip.payDate)} from ${payslip.employer.name}`, MAX_SUBJECT_LENGTH),
    body: `Kia ora ${payslip.employee.firstName},\n\nYour payslip for ${formatDate(payslip.periodStart)} to ${formatDate(payslip.periodEnd)}, paid on ${formatDate(payslip.payDate)}, is attached.\n\n${payslip.employer.name}`,
  };
}

export type QueuedPayslipEmail = { emailId: string; employeeId: string; name: string; to: string[]; status: string };

/**
 * Queues payslip emails to employees on an approved pay run (PSLIP5): all
 * of them, or those in `employeeIds`. Someone without an email address is
 * skipped and listed; asking only for people without one is refused.
 * Idempotent.
 */
export async function queuePayslipEmails(
  tx: OrgTx,
  runIdInput: unknown,
  input: { employeeIds?: unknown; idempotencyKey?: unknown; source?: unknown },
): Promise<{ created: boolean; emails: QueuedPayslipEmail[]; skipped: Array<{ employeeId: string; name: string; reason: string }> }> {
  await requirePayrollAccess(tx);
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const runId = parseUuid(runIdInput, "pay run");
  let chosen: string[] | null = null;
  if (input.employeeIds !== undefined && input.employeeIds !== null) {
    if (!Array.isArray(input.employeeIds) || input.employeeIds.length === 0) throw new ValidationError("Choose who to email, or leave it out to email everyone.");
    chosen = [...new Set(input.employeeIds.map((id) => parseUuid(id, "employee")))];
  }
  const hash = requestHash("payslip_emails", { runId, employeeIds: chosen === null ? null : [...chosen].sort() });
  const keyPrefix = `${idempotencyKey}:`;
  const earlier = await tx.query<{ id: string; employee_id: string; request_hash: string; to_addresses: string[]; status: string }>(
    `select id::text, employee_id::text, request_hash, to_addresses, status from document_emails
      where command_source = $1 and (idempotency_key = $2 or left(idempotency_key, length($3)) = $3) and document_kind = 'payslip'`,
    [source, idempotencyKey, keyPrefix],
  );
  const run = await getPayRun(tx, runId);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "payslip email");
    return {
      created: false,
      emails: earlier.rows.map((row) => ({
        emailId: row.id,
        employeeId: row.employee_id,
        name: run.employees.find((entry) => entry.employeeId === row.employee_id)?.name ?? "",
        to: row.to_addresses,
        status: row.status,
      })),
      skipped: [],
    };
  }
  assertHasPayslips(run);
  const onRun = new Set(run.employees.map((entry) => entry.employeeId));
  for (const id of chosen ?? []) if (!onRun.has(id)) throw new ValidationError(`That employee isn't on ${run.reference}.`);
  const ids = chosen ?? run.employees.map((entry) => entry.employeeId);
  const employees = await employeeRows(tx, ids);
  const skipped: Array<{ employeeId: string; name: string; reason: string }> = [];
  const sending: Array<{ id: string; to: string[] }> = [];
  for (const id of ids) {
    const name = run.employees.find((entry) => entry.employeeId === id)!.name;
    const to = splitAddresses([employees.get(id)?.email ?? ""]).addresses;
    if (to.length === 0) skipped.push({ employeeId: id, name, reason: `${name} has no email address. Add it under Payroll › Employees.` });
    else sending.push({ id, to });
  }
  if (sending.length === 0) throw new ValidationError(skipped.length === 1 ? skipped[0].reason : "No one chosen has an email address. Add them under Payroll › Employees.");
  await requireAccount(tx);
  await checkDailyLimit(tx, sending.length);
  const emails: QueuedPayslipEmail[] = [];
  for (const { id, to } of sending) {
    const payslip = await buildPayslip(tx, run, id, employees);
    const text = payslipEmailText(payslip);
    const inserted = await tx.query<{ id: string }>(
      `insert into document_emails (command_source, idempotency_key, request_hash, document_kind, pay_run_id, employee_id,
                                    to_addresses, cc_addresses, subject, body, attachment_name, requested_by_user_id, requested_by_email)
       values ($1, $2, $3, 'payslip', $4, $5, $6, '{}', $7, $8, $9, $10, $11) returning id::text`,
      [source, `${keyPrefix}${id}`.slice(0, 200), hash, run.id, id, to, text.subject, text.body, payslip.fileName, tx.actor.userId, tx.actor.email],
    );
    const emailId = inserted.rows[0].id;
    // Who and where, never the payslip's figures.
    await writeAuditEvent(tx, {
      eventType: "document_email.queued",
      entityType: "payroll_pay_run",
      entityId: run.id,
      details: { emailId, kind: "payslip", payRunReference: run.reference, employeeId: id, to, subject: text.subject, attachmentName: payslip.fileName },
    });
    emails.push({ emailId, employeeId: id, name: payslip.employee.name, to, status: "queued" });
  }
  return { created: true, emails, skipped };
}
