import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, parseDecimalInput, toPlainString } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { markEmployeeDetailsChanged } from "@/lib/payroll/draft-changes";
import { keyedSecretHash } from "@/lib/secrets";
import { optionalString, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Pay rate history (example PE7): each change of salary or hourly rate is a
 * new row with the date it starts. Rows are never changed; the rate in effect
 * on a date is the one with the latest start on or before it (for the same
 * start date, the one saved last, which is how a mistake is corrected).
 */

export const PAY_BASES = ["salary", "hourly"] as const;
export type PayBasis = (typeof PAY_BASES)[number];

export type PayDetails = {
  payBasis: PayBasis;
  annualSalary: string | null;
  hourlyRate: string | null;
  ordinaryHoursPerWeek: string | null;
};

export type PayRate = PayDetails & {
  id: string;
  effectiveFrom: string;
  reason: string | null;
  createdAt: string;
  createdByEmail: string;
};

type PayRateRow = {
  id: string;
  employee_id: string;
  effective_from: string;
  pay_basis: PayBasis;
  annual_salary: string | null;
  hourly_rate: string | null;
  ordinary_hours_per_week: string | null;
  reason: string | null;
  created_at: string;
  created_by_email: string;
  request_hash: string;
};

const PAY_RATE_COLUMNS = `id, employee_id, effective_from::text, pay_basis, annual_salary::text, hourly_rate::text,
  ordinary_hours_per_week::text, reason, created_at, created_by_email, request_hash`;

function plain(value: string | null): string | null {
  return value === null ? null : toPlainString(dec(value));
}

function toPayRate(row: PayRateRow): PayRate {
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    payBasis: row.pay_basis,
    annualSalary: plain(row.annual_salary),
    hourlyRate: plain(row.hourly_rate),
    ordinaryHoursPerWeek: plain(row.ordinary_hours_per_week),
    reason: row.reason,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
  };
}

function required(value: unknown, field: string): unknown {
  if (value === undefined || value === null || value === "") throw new ValidationError(`${field} is required.`);
  return value;
}

/** Salary needs an annual salary; hourly needs a rate and ordinary hours (PE1, PE7). */
export function parsePayDetails(input: Record<string, unknown>): PayDetails {
  const payBasis = requireOneOf(input.payBasis, "Pay basis", PAY_BASES);
  if (payBasis === "salary" && (input.hourlyRate != null || input.ordinaryHoursPerWeek != null)) {
    throw new ValidationError("Salary employees can't also have an hourly rate or ordinary hours.");
  }
  if (payBasis === "hourly" && input.annualSalary != null) {
    throw new ValidationError("Hourly employees can't also have an annual salary.");
  }
  const amount = (value: unknown, field: string) => parseDecimalInput(required(value, field), field, { maxScale: 2 });
  const annualSalary = payBasis === "salary" ? amount(input.annualSalary, "Annual salary") : null;
  const hourlyRate = payBasis === "hourly" ? amount(input.hourlyRate, "Hourly rate") : null;
  const ordinaryHoursPerWeek = payBasis === "hourly" ? amount(input.ordinaryHoursPerWeek, "Ordinary hours per week") : null;
  for (const [field, value] of [
    ["Annual salary", annualSalary],
    ["Hourly rate", hourlyRate],
  ] as const) {
    if (value !== null && cmp(dec(value), dec("99999999999999.99")) > 0) throw new ValidationError(`${field} is too large.`);
  }
  if (ordinaryHoursPerWeek && cmp(dec(ordinaryHoursPerWeek), dec("99999.99")) > 0) {
    throw new ValidationError("Ordinary hours per week is too large.");
  }
  return { payBasis, annualSalary, hourlyRate, ordinaryHoursPerWeek };
}

async function employeeStartDate(tx: OrgTx, employeeId: string, forUpdate = false): Promise<string> {
  const result = await tx.query<{ start_date: string }>(
    `select start_date::text from payroll_employees where id = $1${forUpdate ? " for update" : ""}`,
    [employeeId],
  );
  if (!result.rows[0]) throw new NotFoundError("Employee not found.");
  return result.rows[0].start_date;
}

/**
 * The pay an employee starts on, saved with them (PE1, PE7). Called by
 * createEmployee, and when a start date moves earlier than their first rate.
 */
export async function insertStartingPayRate(
  tx: OrgTx,
  employeeId: string,
  startDate: string,
  pay: PayDetails,
  idempotencyKey = `starting-pay:${employeeId}`,
): Promise<void> {
  await tx.query(
    `insert into payroll_pay_rates (
       employee_id, effective_from, pay_basis, annual_salary, hourly_rate, ordinary_hours_per_week,
       reason, idempotency_key, request_hash, created_by_user_id, created_by_email
     ) values ($1, $2, $3, $4, $5, $6, 'Starting pay', $7, 'starting-pay', $8, $9)`,
    [
      employeeId,
      startDate,
      pay.payBasis,
      pay.annualSalary,
      pay.hourlyRate,
      pay.ordinaryHoursPerWeek,
      idempotencyKey,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_rate.added",
    entityType: "payroll_employee",
    entityId: employeeId,
    details: { effectiveFrom: startDate, payBasis: pay.payBasis, reason: "Starting pay" },
  });
}

export async function listPayRates(tx: OrgTx, employeeId: string): Promise<PayRate[]> {
  await requirePayrollAccess(tx);
  await employeeStartDate(tx, employeeId);
  const result = await tx.query<PayRateRow>(
    `select ${PAY_RATE_COLUMNS} from payroll_pay_rates where employee_id = $1 order by effective_from, entry_number`,
    [employeeId],
  );
  return result.rows.map(toPayRate);
}

/** The rate in effect on `date`, or null before the first one (PE7). For pay runs (P3). */
export async function payRateOn(tx: OrgTx, employeeId: string, dateInput: unknown): Promise<PayRate | null> {
  await requirePayrollAccess(tx);
  const date = parseIsoDate(dateInput, "Date");
  await employeeStartDate(tx, employeeId);
  const result = await tx.query<PayRateRow>(
    `select ${PAY_RATE_COLUMNS} from payroll_pay_rates
      where employee_id = $1 and effective_from <= $2
      order by effective_from desc, entry_number desc
      limit 1`,
    [employeeId, date],
  );
  return result.rows[0] ? toPayRate(result.rows[0]) : null;
}

/** The employee's first pay rate (earliest date; the last saved for that date). Callers check payroll access. */
export async function firstPayRate(tx: OrgTx, employeeId: string): Promise<(PayDetails & { effectiveFrom: string }) | null> {
  const result = await tx.query<PayRateRow>(
    `select ${PAY_RATE_COLUMNS} from payroll_pay_rates where employee_id = $1 order by effective_from, entry_number desc limit 1`,
    [employeeId],
  );
  return result.rows[0] ? toPayRate(result.rows[0]) : null;
}

/**
 * Each employee's pay as of today: the rate in effect today, or for someone
 * who hasn't started yet, their first rate. Callers check payroll access.
 */
export async function currentPay(tx: OrgTx, employeeIds: readonly string[]): Promise<Map<string, PayDetails>> {
  if (employeeIds.length === 0) return new Map();
  const result = await tx.query<PayRateRow>(
    `select distinct on (employee_id) ${PAY_RATE_COLUMNS}
       from payroll_pay_rates
      where employee_id = any($1::uuid[])
      order by employee_id, (effective_from <= $2) desc,
               case when effective_from <= $2 then effective_from end desc nulls last,
               effective_from, entry_number desc`,
    [employeeIds, todayIsoDate()],
  );
  return new Map(
    result.rows.map((row) => {
      const rate = toPayRate(row);
      return [
        row.employee_id,
        {
          payBasis: rate.payBasis,
          annualSalary: rate.annualSalary,
          hourlyRate: rate.hourlyRate,
          ordinaryHoursPerWeek: rate.ordinaryHoursPerWeek,
        },
      ];
    }),
  );
}

export async function addPayRate(
  tx: OrgTx,
  employeeId: string,
  input: Record<string, unknown>,
): Promise<{ created: boolean; payRate: PayRate }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = keyedSecretHash(requestHash("payroll_pay_rate", { ...input, employeeId }));
  const replay = async () => {
    const earlier = await tx.query<PayRateRow>(`select ${PAY_RATE_COLUMNS} from payroll_pay_rates where idempotency_key = $1`, [
      idempotencyKey,
    ]);
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "pay rate");
    return { created: false, payRate: toPayRate(earlier.rows[0]) };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const startDate = await employeeStartDate(tx, employeeId, true);
  const effectiveFrom = parseIsoDate(input.effectiveFrom, "Effective from");
  if (effectiveFrom < startDate) {
    throw new ValidationError(`A pay rate can't be before the employee's start date (${startDate}).`);
  }
  const pay = parsePayDetails(input);
  const reason = optionalString(input.reason, "Reason", { maxLength: 200 });
  const inserted = await tx.query<PayRateRow>(
    `insert into payroll_pay_rates (
       employee_id, effective_from, pay_basis, annual_salary, hourly_rate, ordinary_hours_per_week,
       reason, idempotency_key, request_hash, created_by_user_id, created_by_email
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (idempotency_key) do nothing
     returning ${PAY_RATE_COLUMNS}`,
    [
      employeeId,
      effectiveFrom,
      pay.payBasis,
      pay.annualSalary,
      pay.hourlyRate,
      pay.ordinaryHoursPerWeek,
      reason,
      idempotencyKey,
      hash,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    const winner = await replay();
    if (winner) return winner;
    throw new ConflictError("The pay rate couldn't be saved. Try again with a new idempotency key.");
  }
  // A new pay rate changes what their draft pay runs pay (PRUN7b).
  await markEmployeeDetailsChanged(tx, employeeId);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_rate.added",
    entityType: "payroll_employee",
    entityId: employeeId,
    details: { effectiveFrom, payBasis: pay.payBasis },
  });
  return { created: true, payRate: toPayRate(row) };
}
