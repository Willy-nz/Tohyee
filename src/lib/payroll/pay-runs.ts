import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { controlAccountCode, type ControlAccount } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { add, dec, type Decimal, isZero, mul, parseDecimalInput, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { splitByPercentages } from "@/lib/payroll/allocation-split";
import { allocationOn } from "@/lib/payroll/allocations";
import type { PayFrequency } from "@/lib/payroll/groups";
import {
  calculateEmployeePay,
  type EmployeePayResult,
  type KiwiSaverStatus,
  lineAmount,
  ordinaryHoursForPeriod,
  payPeriodEnd,
  salaryForPeriod,
} from "@/lib/payroll/pay-calculation";
import { PAY_ITEM_COLUMNS, PAY_ITEM_FROM, type PayItemCategory, type PayItemKind, type PayItemRow } from "@/lib/payroll/pay-items";
import { payRateOn } from "@/lib/payroll/pay-rates";
import { NOT_SUPPORTED, payrollRatesOn } from "@/lib/payroll/rates";
import { loadTrackingContext, missingRequired, sortedTags, trackingKey, type TrackingTags } from "@/lib/tracking/service";
import { asRecord, optionalSource, optionalString, requireArray, requireIdempotencyKey } from "@/lib/validation";

/**
 * Pay runs (examples PRUN1-PRUN11, payroll stage P3). A pay run pays one
 * pay group for one pay period on one pay date. A draft has a line per
 * employee from their pay rate; people running pay add earnings and
 * deductions; pay is calculated with IRD's rates for the pay date
 * (decision 1). Approving posts one journal dated the pay date, with each
 * employee's costs split by their cost allocation on the pay date and the
 * journal lines totalled by pay item, account and tracking, never by
 * employee (decision 6). Approved pay runs are never changed, only voided
 * (an exact reversing journal). Everything needs payroll access.
 */

export type PayRunStatus = "draft" | "approved" | "voided";

export type PayRunLine = {
  lineNumber: number;
  payItemId: string;
  payItemName: string;
  category: PayItemCategory;
  kind: PayItemKind;
  quantity: string | null;
  rate: string | null;
  amount: string;
  description: string | null;
};

export type PayRunEmployee = {
  employeeId: string;
  name: string;
  taxCode: string;
  studentLoan: boolean;
  kiwiSaverStatus: KiwiSaverStatus;
  kiwiSaverEmployeeRate: string;
  kiwiSaverEmployerRate: string;
  esctRate: string | null;
  /** The hourly rate overtime defaults from, or null for salaried employees. */
  hourlyRate: string | null;
  lines: PayRunLine[];
  /** Null when the pay can't be calculated; `problem` says why (PRUN8). */
  pay: EmployeePayResult | null;
  problem: string | null;
};

export type PayRunTotals = {
  gross: string;
  paye: string;
  studentLoan: string;
  kiwiSaverEmployee: string;
  deductions: string;
  netPay: string;
  kiwiSaverEmployer: string;
  esct: string;
  employerCost: string;
};

export type PayRunSummary = {
  id: string;
  reference: string;
  payGroupId: string;
  payGroupName: string;
  payFrequency: PayFrequency;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: PayRunStatus;
  employeeCount: number;
  createdByEmail: string;
  approvedByEmail: string | null;
  approvedAt: string | null;
  voidDate: string | null;
  voidedByEmail: string | null;
};

export type PayRun = PayRunSummary & {
  approvalJournalId: string | null;
  voidJournalId: string | null;
  /** True if the signed-in person created or changed the draft (PRUN7). */
  preparedByMe: boolean;
  approverMustDiffer: boolean;
  employees: PayRunEmployee[];
  /** Totals of everyone whose pay could be calculated. */
  totals: PayRunTotals;
  problemCount: number;
};

type RunRow = {
  id: string;
  run_number: string;
  command_source: string;
  request_hash: string;
  pay_group_id: string;
  pay_group_name: string;
  pay_frequency: PayFrequency;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: PayRunStatus;
  employee_count: string;
  created_by_email: string;
  prepared_by_user_ids: string[];
  approval_journal_id: string | null;
  approve_request_hash: string | null;
  approved_by_email: string | null;
  approved_at: string | null;
  void_date: string | null;
  void_journal_id: string | null;
  void_request_hash: string | null;
  voided_by_email: string | null;
};

const RUN_COLUMNS = `r.id, r.run_number::text, r.command_source, r.request_hash, r.pay_group_id, g.name as pay_group_name,
  r.pay_frequency, r.period_start::text, r.period_end::text, r.pay_date::text, r.status,
  (select count(*) from payroll_pay_run_employees e where e.pay_run_id = r.id)::text as employee_count,
  r.created_by_email, r.prepared_by_user_ids::text[] as prepared_by_user_ids, r.approval_journal_id::text,
  r.approve_request_hash, r.approved_by_email, r.approved_at::text, r.void_date::text, r.void_journal_id::text,
  r.void_request_hash, r.voided_by_email`;

const RUN_FROM = "payroll_pay_runs r join payroll_pay_groups g on g.id = r.pay_group_id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The journal reference and the name people use for a pay run (PRUN1). */
export function payRunReference(runNumber: string | number): string {
  return `PAYRUN-${runNumber}`;
}

function toSummary(row: RunRow): PayRunSummary {
  return {
    id: row.id,
    reference: payRunReference(row.run_number),
    payGroupId: row.pay_group_id,
    payGroupName: row.pay_group_name,
    payFrequency: row.pay_frequency,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    payDate: row.pay_date,
    status: row.status,
    employeeCount: Number(row.employee_count),
    createdByEmail: row.created_by_email,
    approvedByEmail: row.approved_by_email,
    approvedAt: row.approved_at,
    voidDate: row.void_date,
    voidedByEmail: row.voided_by_email,
  };
}

function parseUuid(input: unknown, what: string): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) throw new NotFoundError(`That ${what} wasn't found.`);
  return input;
}

async function findRun(tx: OrgTx, idInput: unknown, forUpdate = false): Promise<RunRow> {
  const id = parseUuid(idInput, "pay run");
  if (forUpdate) await tx.query("select 1 from payroll_pay_runs where id = $1 for update", [id]);
  const result = await tx.query<RunRow>(`select ${RUN_COLUMNS} from ${RUN_FROM} where r.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("That pay run wasn't found.");
  return result.rows[0];
}

function assertDraft(run: RunRow): void {
  if (run.status !== "draft") {
    const reference = payRunReference(run.run_number);
    throw new ConflictError(
      run.status === "approved"
        ? `${reference} is approved, so it can't be changed. Void it and run the pay again.`
        : `${reference} is voided, so it can't be changed. Run the pay again.`,
    );
  }
}

async function markPrepared(tx: OrgTx, runId: string): Promise<void> {
  await tx.query(
    `update payroll_pay_runs
        set prepared_by_user_ids = case when $2::uuid is null or $2::uuid = any(prepared_by_user_ids) then prepared_by_user_ids
                                        else array_append(prepared_by_user_ids, $2::uuid) end,
            updated_at = now()
      where id = $1`,
    [runId, tx.actor.userId],
  );
}

async function approverMustDiffer(tx: OrgTx): Promise<boolean> {
  const result = await tx.query<{ payroll_approver_must_differ: boolean }>(
    "select payroll_approver_must_differ from organisation_settings where id = true",
  );
  return result.rows[0]?.payroll_approver_must_differ ?? false;
}

// Employees and their lines

type EmployeeRow = {
  employee_id: string;
  name: string;
  tax_code: string;
  student_loan: boolean;
  kiwisaver_status: KiwiSaverStatus;
  kiwisaver_employee_rate: string;
  kiwisaver_employer_rate: string;
  esct_rate: string | null;
  is_archived: boolean;
  start_date: string;
  finish_date: string | null;
  gross: string | null;
  taxable_earnings: string | null;
  non_taxable_earnings: string | null;
  kiwisaver_earnings: string | null;
  paye: string | null;
  student_loan_deduction: string | null;
  kiwisaver_employee: string | null;
  deductions: string | null;
  net_pay: string | null;
  kiwisaver_employer: string | null;
  esct: string | null;
  kiwisaver_employer_net: string | null;
  employer_cost: string | null;
};

/**
 * A draft uses each employee's current details (so a fixed tax code shows
 * straight away, PRUN11); an approved pay run uses the copy kept when it was
 * approved.
 */
async function loadEmployees(tx: OrgTx, run: RunRow): Promise<EmployeeRow[]> {
  const snapshot = run.status !== "draft";
  const pick = (column: string, cast = "") => (snapshot ? `pe.${column}${cast}` : `e.${column}${cast}`);
  const result = await tx.query<EmployeeRow>(
    `select pe.employee_id,
            ${snapshot ? "pe.employee_name" : "e.first_name || ' ' || e.last_name"} as name,
            ${pick("tax_code")} as tax_code, ${pick("student_loan")} as student_loan,
            ${pick("kiwisaver_status")} as kiwisaver_status,
            ${pick("kiwisaver_employee_rate", "::text")} as kiwisaver_employee_rate,
            ${pick("kiwisaver_employer_rate", "::text")} as kiwisaver_employer_rate,
            ${pick("esct_rate", "::text")} as esct_rate,
            e.is_archived, e.start_date::text, e.finish_date::text,
            pe.gross::text, pe.taxable_earnings::text, pe.non_taxable_earnings::text, pe.kiwisaver_earnings::text,
            pe.paye::text, pe.student_loan_deduction::text, pe.kiwisaver_employee::text, pe.deductions::text,
            pe.net_pay::text, pe.kiwisaver_employer::text, pe.esct::text, pe.kiwisaver_employer_net::text,
            pe.employer_cost::text
       from payroll_pay_run_employees pe
       join payroll_employees e on e.id = pe.employee_id
      where pe.pay_run_id = $1
      order by lower(e.last_name), lower(e.first_name), pe.employee_id`,
    [run.id],
  );
  return result.rows;
}

type LineRow = {
  employee_id: string;
  line_number: number;
  pay_item_id: string;
  pay_item_name: string;
  category: PayItemCategory;
  kind: PayItemKind;
  subject_to_paye: boolean;
  subject_to_kiwisaver: boolean;
  quantity: string | null;
  rate: string | null;
  amount: string;
  description: string | null;
};

async function loadLines(tx: OrgTx, runId: string): Promise<LineRow[]> {
  const result = await tx.query<LineRow>(
    `select l.employee_id, l.line_number, l.pay_item_id, p.name as pay_item_name, p.category, p.kind,
            p.subject_to_paye, p.subject_to_kiwisaver, l.quantity::text, l.rate::text, l.amount::text, l.description
       from payroll_pay_run_lines l join payroll_pay_items p on p.id = l.pay_item_id
      where l.pay_run_id = $1
      order by l.employee_id, l.line_number`,
    [runId],
  );
  return result.rows;
}

function toLine(row: LineRow): PayRunLine {
  return {
    lineNumber: row.line_number,
    payItemId: row.pay_item_id,
    payItemName: row.pay_item_name,
    category: row.category,
    kind: row.kind,
    quantity: row.quantity === null ? null : toFixedString(dec(row.quantity), 2),
    rate: row.rate === null ? null : trimRate(row.rate),
    amount: toFixedString(dec(row.amount), 2),
    description: row.description,
  };
}

/** A rate with at least 2 decimal places and no trailing zeros past them (33.750000 → 33.75). */
function trimRate(rate: string): string {
  const fixed = toFixedString(dec(rate), 6);
  return fixed.replace(/(\.\d\d\d*?)0+$/, "$1");
}

function storedPay(row: EmployeeRow): EmployeePayResult | null {
  if (row.gross === null) return null;
  const m = (value: string | null) => toFixedString(dec(value ?? "0"), 2);
  return {
    gross: m(row.gross),
    taxableEarnings: m(row.taxable_earnings),
    nonTaxableEarnings: m(row.non_taxable_earnings),
    kiwiSaverEarnings: m(row.kiwisaver_earnings),
    paye: m(row.paye),
    studentLoan: m(row.student_loan_deduction),
    kiwiSaverEmployee: m(row.kiwisaver_employee),
    deductions: m(row.deductions),
    netPay: m(row.net_pay),
    kiwiSaverEmployer: m(row.kiwisaver_employer),
    esct: m(row.esct),
    kiwiSaverEmployerNet: m(row.kiwisaver_employer_net),
    employerCost: m(row.employer_cost),
  };
}

/** The pay rate for the period: the one in effect when it starts, or when the employee started (PRUN11). */
async function rateForPeriod(tx: OrgTx, employeeId: string, periodStart: string, startDate: string) {
  return payRateOn(tx, employeeId, startDate > periodStart ? startDate : periodStart);
}

function calculate(run: RunRow, employee: EmployeeRow, lines: LineRow[]): { pay: EmployeePayResult | null; problem: string | null } {
  if (run.status !== "draft") return { pay: storedPay(employee), problem: null };
  if (employee.is_archived) return { pay: null, problem: `${employee.name} is archived. Take them off this pay run.` };
  try {
    const pay = calculateEmployeePay({
      name: employee.name,
      frequency: run.pay_frequency,
      payDate: run.pay_date,
      taxCode: employee.tax_code,
      studentLoan: employee.student_loan,
      kiwiSaverStatus: employee.kiwisaver_status,
      kiwiSaverEmployeeRate: employee.kiwisaver_employee_rate,
      kiwiSaverEmployerRate: employee.kiwisaver_employer_rate,
      esctRate: employee.esct_rate,
      lines: lines.map((line) => ({
        category: line.category === "deduction" ? "deduction" : "earnings",
        taxable: line.subject_to_paye,
        kiwiSaver: line.subject_to_kiwisaver,
        amount: line.amount,
      })),
    });
    return { pay, problem: null };
  } catch (error) {
    if (error instanceof ValidationError) return { pay: null, problem: error.message };
    throw error;
  }
}

type Calculated = { employee: EmployeeRow; lines: LineRow[]; pay: EmployeePayResult | null; problem: string | null };

async function calculateRun(tx: OrgTx, run: RunRow): Promise<Calculated[]> {
  const employees = await loadEmployees(tx, run);
  const lines = await loadLines(tx, run.id);
  const calculated: Calculated[] = [];
  for (const employee of employees) {
    const own = lines.filter((line) => line.employee_id === employee.employee_id);
    const result = calculate(run, employee, own);
    // A finish date or pay rate change entered after the draft was made is refused here too (PRUN8).
    const later =
      run.status === "draft" && !employee.is_archived
        ? await periodRefusal(
            tx,
            { id: employee.employee_id, name: employee.name, start_date: employee.start_date, finish_date: employee.finish_date },
            run.period_start,
            run.period_end,
            run.pay_group_name,
            run.id,
          )
        : null;
    calculated.push({ employee, lines: own, ...(later ? { pay: null, problem: later } : result) });
  }
  return calculated;
}

function totalsOf(calculated: Calculated[]): PayRunTotals {
  const sum = (pick: (pay: EmployeePayResult) => string) =>
    toFixedString(
      calculated.reduce((total, entry) => (entry.pay ? add(total, dec(pick(entry.pay))) : total), ZERO_DECIMAL),
      2,
    );
  return {
    gross: sum((pay) => pay.gross),
    paye: sum((pay) => pay.paye),
    studentLoan: sum((pay) => pay.studentLoan),
    kiwiSaverEmployee: sum((pay) => pay.kiwiSaverEmployee),
    deductions: sum((pay) => pay.deductions),
    netPay: sum((pay) => pay.netPay),
    kiwiSaverEmployer: sum((pay) => pay.kiwiSaverEmployer),
    esct: sum((pay) => pay.esct),
    employerCost: sum((pay) => pay.employerCost),
  };
}

export async function getPayRun(tx: OrgTx, idInput: unknown): Promise<PayRun> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, idInput);
  const calculated = await calculateRun(tx, run);
  const hourly = new Map<string, string | null>();
  if (run.status === "draft") {
    for (const entry of calculated) {
      const rate = await rateForPeriod(tx, entry.employee.employee_id, run.period_start, entry.employee.start_date);
      hourly.set(entry.employee.employee_id, rate?.payBasis === "hourly" && rate.hourlyRate ? trimRate(rate.hourlyRate) : null);
    }
  }
  return {
    ...toSummary(run),
    approvalJournalId: run.approval_journal_id,
    voidJournalId: run.void_journal_id,
    preparedByMe: tx.actor.userId !== null && run.prepared_by_user_ids.includes(tx.actor.userId),
    approverMustDiffer: await approverMustDiffer(tx),
    employees: calculated.map((entry) => ({
      employeeId: entry.employee.employee_id,
      name: entry.employee.name,
      taxCode: entry.employee.tax_code,
      studentLoan: entry.employee.student_loan,
      kiwiSaverStatus: entry.employee.kiwisaver_status,
      kiwiSaverEmployeeRate: toFixedString(dec(entry.employee.kiwisaver_employee_rate), 2),
      kiwiSaverEmployerRate: toFixedString(dec(entry.employee.kiwisaver_employer_rate), 2),
      esctRate: entry.employee.esct_rate === null ? null : toFixedString(dec(entry.employee.esct_rate), 2),
      hourlyRate: hourly.get(entry.employee.employee_id) ?? null,
      lines: entry.lines.map(toLine),
      pay: entry.pay,
      problem: entry.problem,
    })),
    totals: totalsOf(calculated),
    problemCount: calculated.filter((entry) => entry.problem !== null).length,
  };
}

export async function listPayRuns(tx: OrgTx, options: { status?: unknown } = {}): Promise<PayRunSummary[]> {
  await requirePayrollAccess(tx);
  const status = options.status;
  if (status !== undefined && status !== null && status !== "" && status !== "draft" && status !== "approved" && status !== "voided") {
    throw new ValidationError('status must be "draft", "approved" or "voided".');
  }
  const result = await tx.query<RunRow>(
    `select ${RUN_COLUMNS} from ${RUN_FROM}
      where ($1::text is null or r.status = $1)
      order by r.pay_date desc, r.run_number desc
      limit 500`,
    [status || null],
  );
  return result.rows.map(toSummary);
}

// Creating a draft

type GroupEmployee = {
  id: string;
  name: string;
  start_date: string;
  finish_date: string | null;
};

async function ordinaryTimeItem(tx: OrgTx): Promise<string> {
  const result = await tx.query<{ id: string }>("select id from payroll_pay_items where is_system and kind = 'ordinary_time'");
  if (!result.rows[0]) throw new ValidationError("There's no Ordinary time pay item. Set up pay items under Payroll › Pay items.");
  return result.rows[0].id;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

/**
 * Creates a draft pay run (PRUN11): a line of Ordinary time for each
 * employee in the pay group who is paid in the period. Refuses (PRUN8) a
 * pay group where someone finishes inside the period (a final pay), someone
 * on a salary starts after the period starts, or a pay rate changes inside
 * the period.
 */
export async function createPayRun(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; payGroupId: unknown; periodStart: unknown; payDate: unknown },
): Promise<{ created: boolean; payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = requestHash("payroll_pay_run", { payGroupId: input.payGroupId, periodStart: input.periodStart, payDate: input.payDate });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; request_hash: string }>(
      "select id, request_hash from payroll_pay_runs where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "pay run");
    return { created: false, payRun: await getPayRun(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const groupId = typeof input.payGroupId === "string" && UUID_PATTERN.test(input.payGroupId) ? input.payGroupId : null;
  if (!groupId) throw new ValidationError("Choose a pay group.");
  // One pay run at a time per pay group, so two people can't create overlapping runs.
  const group = await tx.query<{ name: string; pay_frequency: PayFrequency; is_archived: boolean }>(
    "select name, pay_frequency, is_archived from payroll_pay_groups where id = $1 for update",
    [groupId],
  );
  if (!group.rows[0]) throw new ValidationError("That pay group wasn't found.");
  const { name: groupName, pay_frequency: frequency, is_archived: archived } = group.rows[0];
  if (archived) throw new ValidationError(`${groupName} is archived.`);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;

  const periodStart = parseIsoDate(input.periodStart, "Period start");
  const payDate = parseIsoDate(input.payDate, "Pay date");
  const periodEnd = payPeriodEnd(periodStart, frequency);
  if (payDate < periodStart) throw new ValidationError(`The pay date can't be before the pay period starts (${periodStart}).`);
  payrollRatesOn(payDate);

  const overlap = await tx.query<{ run_number: string; period_start: string; period_end: string }>(
    `select run_number::text, period_start::text, period_end::text from payroll_pay_runs
      where pay_group_id = $1 and status <> 'voided' and period_start <= $3 and period_end >= $2
      order by period_start limit 1`,
    [groupId, periodStart, periodEnd],
  );
  if (overlap.rows[0]) {
    const other = overlap.rows[0];
    throw new ConflictError(
      `${payRunReference(other.run_number)} already pays ${groupName} for ${other.period_start} to ${other.period_end}. Void it first to run that pay again.`,
    );
  }

  const employees = await tx.query<GroupEmployee>(
    `select id, first_name || ' ' || last_name as name, start_date::text, finish_date::text
       from payroll_employees
      where pay_group_id = $1 and not is_archived and start_date <= $3 and (finish_date is null or finish_date >= $2)
      order by lower(last_name), lower(first_name), id`,
    [groupId, periodStart, periodEnd],
  );
  if (employees.rows.length === 0) throw new ValidationError(`Nobody in ${groupName} is paid for ${periodStart} to ${periodEnd}.`);
  const ordinaryTime = await ordinaryTimeItem(tx);

  const drafts: Array<{ employeeId: string; quantity: string | null; rate: string | null; amount: string }> = [];
  for (const employee of employees.rows) {
    if (employee.finish_date !== null && employee.finish_date <= periodEnd) {
      throw new ValidationError(finalPayRefusal(employee, groupName));
    }
    const rate = await rateForPeriod(tx, employee.id, periodStart, employee.start_date);
    if (!rate) throw new ValidationError(`${employee.name} has no pay rate for ${periodStart}. Add one under Employees.`);
    if (rate.payBasis === "salary" && employee.start_date > periodStart) {
      throw new ValidationError(
        `${NOT_SUPPORTED}: part of a pay period on a salary. ${employee.name} starts on ${employee.start_date}, after the period starts.`,
      );
    }
    const refused = await periodRefusal(tx, employee, periodStart, periodEnd, groupName);
    if (refused) throw new ValidationError(refused);
    if (rate.payBasis === "salary") {
      drafts.push({ employeeId: employee.id, quantity: null, rate: null, amount: salaryForPeriod(rate.annualSalary!, frequency) });
    } else {
      const hours = ordinaryHoursForPeriod(rate.ordinaryHoursPerWeek!, frequency);
      drafts.push({ employeeId: employee.id, quantity: hours, rate: rate.hourlyRate!, amount: lineAmount(hours, rate.hourlyRate!) });
    }
  }

  let runId: string | undefined;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into payroll_pay_runs (
         command_source, idempotency_key, request_hash, pay_group_id, pay_frequency, period_start, period_end, pay_date,
         created_by_user_id, created_by_email, prepared_by_user_ids
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $9::uuid is null then '{}'::uuid[] else array[$9::uuid] end)
       on conflict (command_source, idempotency_key) do nothing returning id`,
      [source, idempotencyKey, hash, groupId, frequency, periodStart, periodEnd, payDate, tx.actor.userId, tx.actor.email],
    );
    runId = inserted.rows[0]?.id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a pay run for ${groupName} starting ${periodStart}.`);
    throw error;
  }
  if (!runId) {
    const winner = await replay();
    if (winner) return winner;
    throw new ConflictError("The pay run couldn't be saved. Try again with a new idempotency key.");
  }
  for (const draft of drafts) {
    await tx.query("insert into payroll_pay_run_employees (pay_run_id, employee_id) values ($1, $2)", [runId, draft.employeeId]);
    await tx.query(
      `insert into payroll_pay_run_lines (pay_run_id, employee_id, line_number, pay_item_id, quantity, rate, amount)
       values ($1, $2, 1, $3, $4, $5, $6)`,
      [runId, draft.employeeId, ordinaryTime, draft.quantity, draft.rate, draft.amount],
    );
  }
  const payRun = await getPayRun(tx, runId);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.created",
    entityType: "payroll_pay_run",
    entityId: runId,
    details: { reference: payRun.reference, payGroupId: groupId, periodStart, periodEnd, payDate, employeeCount: drafts.length },
  });
  return { created: true, payRun };
}

function finalPayRefusal(employee: GroupEmployee, groupName: string): string {
  return `${NOT_SUPPORTED}: final pays. ${employee.name} finishes on ${employee.finish_date}, inside this pay period; move them out of ${groupName} to pay everyone else.`;
}

/**
 * Why an employee can't be paid on a pay run for this period (PRUN8): they
 * finish inside it (a final pay) or their pay rate changes part-way through.
 * Checked when the draft is made and again every time it's calculated, so a
 * finish date or pay rate entered afterwards isn't missed on approval.
 */
async function periodRefusal(
  tx: OrgTx,
  employee: GroupEmployee,
  periodStart: string,
  periodEnd: string,
  groupName: string,
  payRunId: string | null = null,
): Promise<string | null> {
  if (employee.finish_date !== null && employee.finish_date < periodStart) {
    return `${employee.name} finished on ${employee.finish_date}, before this pay period. Take them off this pay run.`;
  }
  if (employee.finish_date !== null && employee.finish_date <= periodEnd) return finalPayRefusal(employee, groupName);
  const change = await tx.query<{ effective_from: string }>(
    `select effective_from::text from payroll_pay_rates
      where employee_id = $1 and effective_from > $2 and effective_from <= $3
      order by effective_from limit 1`,
    [employee.id, employee.start_date > periodStart ? employee.start_date : periodStart, periodEnd],
  );
  if (change.rows[0]) {
    return `${NOT_SUPPORTED}: a pay rate that changes part-way through a pay period. ${employee.name}'s pay rate changes on ${change.rows[0].effective_from}.`;
  }
  // Someone moved between pay groups mustn't be paid twice for the same days.
  const other = await tx.query<{ run_number: string; period_start: string; period_end: string }>(
    `select r.run_number::text, r.period_start::text, r.period_end::text
       from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id
      where pe.employee_id = $1 and r.status <> 'voided' and ($4::uuid is null or r.id <> $4::uuid)
        and r.period_start <= $3 and r.period_end >= $2
      order by r.period_start, r.run_number limit 1`,
    [employee.id, periodStart, periodEnd, payRunId],
  );
  if (other.rows[0]) {
    const run = other.rows[0];
    return `${employee.name} is already paid for ${run.period_start} to ${run.period_end} on ${payRunReference(run.run_number)}. Take them off one of the pay runs (or void it).`;
  }
  return null;
}

// Changing a draft

type ItemForLine = PayItemRow;

function parseQuantity(input: unknown, label: string): string {
  return toFixedString(dec(parseDecimalInput(input, `${label} hours`, { maxScale: 2, allowZero: true })), 2);
}

function parseRate(input: unknown, label: string): string {
  return parseDecimalInput(input, `${label} rate`, { maxScale: 6, allowZero: true });
}

function rejectNegative(input: unknown): void {
  if ((typeof input === "string" && input.trim().startsWith("-")) || (typeof input === "number" && input < 0)) {
    throw new ValidationError(`${NOT_SUPPORTED}: amounts below zero (corrections and back pay).`);
  }
}

/**
 * Replaces one employee's earnings and deductions on a draft (PRUN2). Each
 * line is a pay item with hours x rate (overtime's rate defaults to the
 * hourly rate x the item's multiplier) or an amount. Employer KiwiSaver,
 * PAYE, student loan and ESCT are calculated, not entered.
 */
export async function setPayRunEmployeeLines(
  tx: OrgTx,
  runIdInput: unknown,
  employeeIdInput: unknown,
  input: { lines: unknown },
): Promise<{ payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput, true);
  assertDraft(run);
  const employeeId = parseUuid(employeeIdInput, "employee");
  const onRun = await tx.query<{ start_date: string; name: string }>(
    `select e.start_date::text, e.first_name || ' ' || e.last_name as name
       from payroll_pay_run_employees pe join payroll_employees e on e.id = pe.employee_id
      where pe.pay_run_id = $1 and pe.employee_id = $2`,
    [run.id, employeeId],
  );
  if (!onRun.rows[0]) throw new NotFoundError(`That employee isn't on ${payRunReference(run.run_number)}.`);
  const rawLines = requireArray(input.lines, "lines", 200);
  const existing = new Set((await tx.query<{ pay_item_id: string }>(
    "select pay_item_id from payroll_pay_run_lines where pay_run_id = $1 and employee_id = $2",
    [run.id, employeeId],
  )).rows.map((row) => row.pay_item_id));
  const itemIds = [...new Set(rawLines.map((raw, index) => parseUuidField(asRecord(raw, `Line ${index + 1}`).payItemId, index)))];
  const items = new Map(
    (await tx.query<ItemForLine>(`select ${PAY_ITEM_COLUMNS} from ${PAY_ITEM_FROM} where p.id = any($1::uuid[])`, [itemIds])).rows.map((row) => [
      row.id,
      row,
    ]),
  );
  let hourlyRate: string | null | undefined;
  const parsed: Array<{ payItemId: string; quantity: string | null; rate: string | null; amount: string; description: string | null }> = [];
  for (const [index, raw] of rawLines.entries()) {
    const label = `Line ${index + 1}`;
    const line = asRecord(raw, label);
    const item = items.get(String(line.payItemId));
    if (!item) throw new ValidationError(`${label}: that pay item wasn't found.`);
    if (item.category === "employer_contribution") {
      throw new ValidationError(`${label}: ${item.name} is calculated by Tohyee, not entered.`);
    }
    if (item.is_archived && !existing.has(item.id)) throw new ValidationError(`${label}: ${item.name} is archived.`);
    const description = optionalString(line.description, `${label} description`, { maxLength: 200 });
    const hasQuantity = line.quantity !== undefined && line.quantity !== null && line.quantity !== "";
    const hasAmount = line.amount !== undefined && line.amount !== null && line.amount !== "";
    if (hasQuantity === hasAmount) throw new ValidationError(`${label}: give either hours (and a rate) or an amount.`);
    if (hasQuantity) {
      rejectNegative(line.quantity);
      rejectNegative(line.rate);
      const quantity = parseQuantity(line.quantity, label);
      let rate: string;
      if (line.rate === undefined || line.rate === null || line.rate === "") {
        if (hourlyRate === undefined) {
          const payRate = await rateForPeriod(tx, employeeId, run.period_start, onRun.rows[0].start_date);
          hourlyRate = payRate?.payBasis === "hourly" ? payRate.hourlyRate : null;
        }
        if (hourlyRate === null) throw new ValidationError(`${label}: ${onRun.rows[0].name} is on a salary, so give a rate for these hours.`);
        rate =
          item.kind === "overtime" && item.rate_multiplier !== null
            ? toFixedString(mul(dec(hourlyRate), dec(item.rate_multiplier)), 6)
            : hourlyRate;
      } else {
        rate = parseRate(line.rate, label);
      }
      parsed.push({ payItemId: item.id, quantity, rate, amount: lineAmount(quantity, rate), description });
    } else {
      rejectNegative(line.amount);
      const amount = toFixedString(dec(parseDecimalInput(line.amount, `${label} amount`, { maxScale: 2, allowZero: true })), 2);
      parsed.push({ payItemId: item.id, quantity: null, rate: null, amount, description });
    }
  }

  await tx.query("delete from payroll_pay_run_lines where pay_run_id = $1 and employee_id = $2", [run.id, employeeId]);
  for (const [index, line] of parsed.entries()) {
    await tx.query(
      `insert into payroll_pay_run_lines (pay_run_id, employee_id, line_number, pay_item_id, quantity, rate, amount, description)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [run.id, employeeId, index + 1, line.payItemId, line.quantity, line.rate, line.amount, line.description],
    );
  }
  await markPrepared(tx, run.id);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.changed",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference: payRunReference(run.run_number), employeeId, lineCount: parsed.length },
  });
  return { payRun: await getPayRun(tx, run.id) };
}

function parseUuidField(input: unknown, index: number): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) throw new ValidationError(`Line ${index + 1}: choose a pay item.`);
  return input;
}

/** Leaves an employee out of a draft (PRUN11). */
export async function removePayRunEmployee(tx: OrgTx, runIdInput: unknown, employeeIdInput: unknown): Promise<{ payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput, true);
  assertDraft(run);
  const employeeId = parseUuid(employeeIdInput, "employee");
  await tx.query("delete from payroll_pay_run_lines where pay_run_id = $1 and employee_id = $2", [run.id, employeeId]);
  const removed = await tx.query("delete from payroll_pay_run_employees where pay_run_id = $1 and employee_id = $2", [run.id, employeeId]);
  if (removed.rowCount !== 1) throw new NotFoundError(`That employee isn't on ${payRunReference(run.run_number)}.`);
  await markPrepared(tx, run.id);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.employee_removed",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference: payRunReference(run.run_number), employeeId },
  });
  return { payRun: await getPayRun(tx, run.id) };
}

/** Deletes a draft (PRUN11). Approved and voided pay runs are kept. */
export async function deletePayRun(tx: OrgTx, runIdInput: unknown): Promise<{ deleted: true }> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput, true);
  if (run.status !== "draft") {
    throw new ConflictError(`${payRunReference(run.run_number)} is ${run.status}, so it can't be deleted.${run.status === "approved" ? " Void it instead." : ""}`);
  }
  await tx.query("delete from payroll_pay_run_lines where pay_run_id = $1", [run.id]);
  await tx.query("delete from payroll_pay_run_employees where pay_run_id = $1", [run.id]);
  await tx.query("delete from payroll_pay_runs where id = $1", [run.id]);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.deleted",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference: payRunReference(run.run_number) },
  });
  return { deleted: true };
}

// Approving and voiding

const PAYE_ACCOUNT: ControlAccount = { systemKey: "paye_payable", label: "PAYE payable", accountClass: "liability" };
const KIWISAVER_ACCOUNT: ControlAccount = { systemKey: "kiwisaver_payable", label: "KiwiSaver payable", accountClass: "liability" };
const ESCT_ACCOUNT: ControlAccount = { systemKey: "esct_payable", label: "ESCT payable", accountClass: "liability" };
const STUDENT_LOAN_ACCOUNT: ControlAccount = { systemKey: "student_loan_payable", label: "Student loan payable", accountClass: "liability" };
const WAGES_ACCOUNT: ControlAccount = { systemKey: "wages_payable", label: "Wages payable", accountClass: "liability" };

type ItemAccount = { id: string; name: string; rank: number; accountId: string; accountCode: string };

async function itemAccounts(tx: OrgTx): Promise<Map<string, ItemAccount | { id: string; name: string; missing: true }>> {
  const result = await tx.query<{ id: string; name: string; rank: number; account_id: string | null; account_code: string | null; is_active: boolean | null }>(
    `select p.id, p.name, a.id::text as account_id, a.code as account_code, a.is_active,
            (row_number() over (order by array_position(array['earnings', 'deduction', 'employer_contribution'], p.category),
                                         array_position(array['ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement',
                                                              'after_tax_deduction', 'kiwisaver_employer'], p.kind),
                                         lower(p.name), p.id))::int as rank
       from payroll_pay_items p left join accounts a on a.id = p.account_id`,
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      row.account_id && row.account_code
        ? { id: row.id, name: row.name, rank: row.rank, accountId: row.account_id, accountCode: row.account_code }
        : { id: row.id, name: row.name, missing: true as const },
    ]),
  );
}

function accountFor(entry: ItemAccount | { id: string; name: string; missing: true } | undefined, refused: string): ItemAccount {
  if (!entry || "missing" in entry) {
    throw new ValidationError(`The pay item ${entry?.name ?? ""} has no account, so ${refused}. Set one under Payroll › Pay items.`);
  }
  return entry;
}

type Share = { percentage: string; tags: TrackingTags; projectId: string | null; projectName: string | null };

type Posting = {
  employeeId: string;
  payItemId: string;
  accountId: string;
  tags: TrackingTags;
  projectId: string | null;
  percentage: string;
  amount: string;
  group: string;
};

type DebitGroup = { key: string; rank: number; order: number; accountCode: string; description: string; tags: TrackingTags; amount: Decimal };

/**
 * Approves a draft (PRUN1-PRUN3, PRUN5, PRUN7): posts one journal dated the
 * pay date and keeps a copy of what each employee's pay was calculated from.
 */
export async function approvePayRun(
  tx: OrgTx,
  runIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const id = parseUuid(runIdInput, "pay run");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("payroll_pay_run_approval", { id });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; approve_request_hash: string }>(
      "select id, approve_request_hash from payroll_pay_runs where approve_command_source = $1 and approve_idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].approve_request_hash, hash, "pay run approval");
    return { created: false, payRun: await getPayRun(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const run = await findRun(tx, id, true);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const reference = payRunReference(run.run_number);
  if (run.status !== "draft") throw new ConflictError(`${reference} is already ${run.status}.`);
  if ((await approverMustDiffer(tx)) && tx.actor.userId !== null && run.prepared_by_user_ids.includes(tx.actor.userId)) {
    throw new ForbiddenError("You prepared this pay run, so someone else has to approve it.");
  }
  await assertPostingDateAllowed(tx, run.pay_date);

  const calculated = await calculateRun(tx, run);
  if (calculated.length === 0) throw new ValidationError(`${reference} has nobody on it. Delete it instead.`);
  const problems = calculated.filter((entry) => entry.problem !== null);
  if (problems.length > 0) {
    throw new ValidationError(`${reference} can't be approved yet: ${problems.map((entry) => entry.problem).join(" ")}`);
  }
  const refused = `${reference} can't be approved`;
  const accounts = await itemAccounts(tx);
  const ctx = await loadTrackingContext(tx);

  const postings: Posting[] = [];
  const groups = new Map<string, DebitGroup>();
  const deductions = new Map<string, { item: ItemAccount; amount: Decimal }>();
  let kiwiSaverItem: ItemAccount | null = null;
  const addShare = (employeeId: string, item: ItemAccount, amount: string, shares: Share[]) => {
    const split = splitByPercentages(amount, shares.map((share) => share.percentage));
    shares.forEach((share, index) => {
      if (isZero(dec(split[index]))) return;
      const key = `${item.id}|${item.accountCode}|${trackingKey(share.tags)}|${share.projectId ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          rank: item.rank,
          order: groups.size,
          accountCode: item.accountCode,
          description: share.projectName ? `${item.name} (project ${share.projectName})` : item.name,
          tags: share.tags,
          amount: ZERO_DECIMAL,
        };
        groups.set(key, group);
      }
      group.amount = add(group.amount, dec(split[index]));
      postings.push({
        employeeId,
        payItemId: item.id,
        accountId: item.accountId,
        tags: share.tags,
        projectId: share.projectId,
        percentage: share.percentage,
        amount: split[index],
        group: key,
      });
    });
  };

  for (const entry of calculated) {
    const pay = entry.pay!;
    const shares = await sharesOn(tx, ctx, entry.employee, run.pay_date);
    const byItem = new Map<string, Decimal>();
    for (const line of entry.lines) {
      if (line.category === "deduction") {
        const item = accountFor(accounts.get(line.pay_item_id), refused);
        const current = deductions.get(item.id) ?? { item, amount: ZERO_DECIMAL };
        current.amount = add(current.amount, dec(line.amount));
        deductions.set(item.id, current);
      } else {
        byItem.set(line.pay_item_id, add(byItem.get(line.pay_item_id) ?? ZERO_DECIMAL, dec(line.amount)));
      }
    }
    for (const [itemId, amount] of byItem) {
      if (isZero(amount)) continue;
      addShare(entry.employee.employee_id, accountFor(accounts.get(itemId), refused), toFixedString(amount, 2), shares);
    }
    if (!isZero(dec(pay.kiwiSaverEmployer))) {
      if (!kiwiSaverItem) kiwiSaverItem = await kiwiSaverEmployerItem(tx, accounts, refused);
      addShare(entry.employee.employee_id, kiwiSaverItem, pay.kiwiSaverEmployer, shares);
    }
  }

  const debits = [...groups.values()].sort((a, b) => a.rank - b.rank || a.order - b.order);
  const totals = totalsOf(calculated);
  const kiwiSaverPayable = add(dec(totals.kiwiSaverEmployee), calculated.reduce((total, entry) => add(total, dec(entry.pay!.kiwiSaverEmployerNet)), ZERO_DECIMAL));
  const credits: Array<{ accountCode: string; amount: string; description: string }> = [];
  const credit = async (control: ControlAccount, amount: string, description: string) => {
    if (isZero(dec(amount))) return;
    credits.push({ accountCode: await controlAccountCode(tx, control, `pay runs can't be approved`), amount, description });
  };
  await credit(PAYE_ACCOUNT, totals.paye, "PAYE");
  await credit(STUDENT_LOAN_ACCOUNT, totals.studentLoan, "Student loan");
  await credit(KIWISAVER_ACCOUNT, toFixedString(kiwiSaverPayable, 2), "KiwiSaver");
  await credit(ESCT_ACCOUNT, totals.esct, "ESCT");
  for (const { item, amount } of [...deductions.values()].sort((a, b) => a.item.rank - b.item.rank)) {
    if (!isZero(amount)) credits.push({ accountCode: item.accountCode, amount: toFixedString(amount, 2), description: item.name });
  }
  await credit(WAGES_ACCOUNT, totals.netPay, "Net pay");
  if (debits.length + credits.length > 500) {
    throw new ValidationError(`${NOT_SUPPORTED}: a pay run whose journal would have more than 500 lines.`);
  }

  const posted = await postJournalBody(
    tx,
    "payroll:approval",
    run.id,
    parseJournalBody(
      tx,
      {
        postingDate: run.pay_date,
        reference,
        description: `Pay run ${reference}: ${run.pay_group_name}, ${run.period_start} to ${run.period_end}`,
        lines: [
          ...debits.map((group) => ({
            accountCode: group.accountCode,
            debitAmount: toFixedString(group.amount, 2),
            creditAmount: "0",
            description: group.description,
            tracking: group.tags,
          })),
          ...credits.map((line) => ({ accountCode: line.accountCode, debitAmount: "0", creditAmount: line.amount, description: line.description })),
        ],
      },
      { internal: true },
    ),
    { origin: "payroll" },
  );

  for (const entry of calculated) {
    const pay = entry.pay!;
    await tx.query(
      `update payroll_pay_run_employees
          set employee_name = $3, tax_code = $4, student_loan = $5, kiwisaver_status = $6, kiwisaver_employee_rate = $7,
              kiwisaver_employer_rate = $8, esct_rate = $9, gross = $10, taxable_earnings = $11, non_taxable_earnings = $12,
              kiwisaver_earnings = $13, paye = $14, student_loan_deduction = $15, kiwisaver_employee = $16, deductions = $17,
              net_pay = $18, kiwisaver_employer = $19, esct = $20, kiwisaver_employer_net = $21, employer_cost = $22
        where pay_run_id = $1 and employee_id = $2`,
      [
        run.id,
        entry.employee.employee_id,
        entry.employee.name,
        entry.employee.tax_code,
        entry.employee.student_loan,
        entry.employee.kiwisaver_status,
        entry.employee.kiwisaver_employee_rate,
        entry.employee.kiwisaver_employer_rate,
        entry.employee.esct_rate,
        pay.gross,
        pay.taxableEarnings,
        pay.nonTaxableEarnings,
        pay.kiwiSaverEarnings,
        pay.paye,
        pay.studentLoan,
        pay.kiwiSaverEmployee,
        pay.deductions,
        pay.netPay,
        pay.kiwiSaverEmployer,
        pay.esct,
        pay.kiwiSaverEmployerNet,
        pay.employerCost,
      ],
    );
  }
  const lineOrder = new Map(debits.map((group, index) => [group.key, index + 1]));
  for (const [index, posting] of postings.entries()) {
    await tx.query(
      `insert into payroll_pay_run_postings (pay_run_id, posting_number, employee_id, pay_item_id, account_id, tracking, project_id,
                                             percentage, amount, journal_line_order)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
      [
        run.id,
        index + 1,
        posting.employeeId,
        posting.payItemId,
        posting.accountId,
        JSON.stringify(posting.tags),
        posting.projectId,
        posting.percentage,
        posting.amount,
        lineOrder.get(posting.group),
      ],
    );
  }
  try {
    await tx.query(
      `update payroll_pay_runs
          set status = 'approved', approval_journal_id = $2, approve_command_source = $3, approve_idempotency_key = $4,
              approve_request_hash = $5, approved_by_user_id = $6, approved_by_email = $7, approved_at = now(), updated_at = now()
        where id = $1`,
      [run.id, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different pay run approval. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.approved",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference, payDate: run.pay_date, journalId: posted.journal.id, employeeCount: calculated.length },
  });
  return { created: true, payRun: await getPayRun(tx, run.id) };
}

async function kiwiSaverEmployerItem(
  tx: OrgTx,
  accounts: Map<string, ItemAccount | { id: string; name: string; missing: true }>,
  refused: string,
): Promise<ItemAccount> {
  const result = await tx.query<{ id: string }>("select id from payroll_pay_items where is_system and kind = 'kiwisaver_employer'");
  if (!result.rows[0]) {
    throw new ValidationError(`There's no KiwiSaver employer contribution pay item, so ${refused}. Set it up under Payroll › Pay items.`);
  }
  return accountFor(accounts.get(result.rows[0].id), refused);
}

/**
 * An employee's shares of their costs on the pay date (PRUN1): their cost
 * allocation's lines, with Department, Class and Location as tracking tags
 * when advanced features are on, or 100% untagged before their first
 * allocation. A required category missing from the allocation is refused.
 */
async function sharesOn(
  tx: OrgTx,
  ctx: Awaited<ReturnType<typeof loadTrackingContext>>,
  employee: EmployeeRow,
  payDate: string,
): Promise<Share[]> {
  const allocation = await allocationOn(tx, employee.employee_id, payDate);
  const shares: Share[] = allocation
    ? allocation.lines.map((line) => {
        const tags: TrackingTags = {};
        if (ctx.advancedFeatures) {
          for (const valueId of [line.departmentId, line.classId, line.locationId]) {
            if (!valueId) continue;
            const value = ctx.values.get(valueId);
            if (value) tags[value.categoryId] = value.id;
          }
        }
        return { percentage: line.percentage, tags: sortedTags(tags), projectId: line.projectId, projectName: line.projectName };
      })
    : [{ percentage: "100.00", tags: {}, projectId: null, projectName: null }];
  for (const share of shares) {
    const missing = missingRequired(ctx, share.tags, "expense");
    if (missing) {
      throw new ValidationError(
        `${employee.name}'s cost allocation on ${payDate} has no ${missing}, and expense lines need one. Fix it under Employees › Cost allocation.`,
      );
    }
  }
  return shares;
}

/** Voids an approved pay run (PRUN6): posts the exact reversal of its journal on the void date. */
export async function voidPayRun(
  tx: OrgTx,
  runIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<{ created: boolean; payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const id = parseUuid(runIdInput, "pay run");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "Void date");
  const hash = requestHash("payroll_pay_run_void", { id, voidDate });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; void_request_hash: string }>(
      "select id, void_request_hash from payroll_pay_runs where void_command_source = $1 and void_idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].void_request_hash, hash, "pay run void");
    return { created: false, payRun: await getPayRun(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const run = await findRun(tx, id, true);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const reference = payRunReference(run.run_number);
  if (run.status === "voided") throw new ConflictError(`${reference} has already been voided.`);
  if (run.status !== "approved") throw new ConflictError(`${reference} isn't approved, so there's nothing to void. Delete the draft instead.`);
  if (voidDate < run.pay_date) throw new ValidationError(`The void date can't be before the pay date (${run.pay_date}).`);
  const original = await getJournal(tx, run.approval_journal_id!);
  const posted = await postJournalBody(
    tx,
    "payroll:void",
    run.id,
    parseJournalBody(
      tx,
      {
        postingDate: voidDate,
        reference: `VOID-${original.reference}`.slice(0, 100),
        description: `Void of pay run ${reference}: ${run.pay_group_name}, ${run.period_start} to ${run.period_end}`,
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
      `update payroll_pay_runs
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4, void_idempotency_key = $5,
              void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8, voided_at = now(), updated_at = now()
        where id = $1`,
      [run.id, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different pay run void. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.voided",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference, voidDate, journalId: posted.journal.id },
  });
  return { created: true, payRun: await getPayRun(tx, run.id) };
}

export type PayRunPosting = {
  postingNumber: number;
  employeeId: string;
  employeeName: string;
  payItemName: string;
  accountCode: string;
  tracking: TrackingTags;
  projectId: string | null;
  percentage: string;
  amount: string;
  journalLineOrder: number;
};

/** Each employee's share of each debit line of an approved pay run's journal (PRUN1). Payroll access only. */
export async function listPayRunPostings(tx: OrgTx, runIdInput: unknown): Promise<PayRunPosting[]> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput);
  const result = await tx.query<{
    posting_number: number;
    employee_id: string;
    employee_name: string;
    pay_item_name: string;
    account_code: string;
    tracking: TrackingTags;
    project_id: string | null;
    percentage: string;
    amount: string;
    journal_line_order: number;
  }>(
    `select p.posting_number, p.employee_id, pe.employee_name, i.name as pay_item_name, a.code as account_code, p.tracking,
            p.project_id::text, p.percentage::text, p.amount::text, p.journal_line_order
       from payroll_pay_run_postings p
       join payroll_pay_run_employees pe on pe.pay_run_id = p.pay_run_id and pe.employee_id = p.employee_id
       join payroll_pay_items i on i.id = p.pay_item_id
       join accounts a on a.id = p.account_id
      where p.pay_run_id = $1
      order by p.posting_number`,
    [run.id],
  );
  return result.rows.map((row) => ({
    postingNumber: row.posting_number,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    payItemName: row.pay_item_name,
    accountCode: row.account_code,
    tracking: row.tracking,
    projectId: row.project_id,
    percentage: toFixedString(dec(row.percentage), 2),
    amount: toFixedString(dec(row.amount), 2),
    journalLineOrder: row.journal_line_order,
  }));
}
