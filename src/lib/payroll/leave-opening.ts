import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { dec, isNegative, parseDecimalInput, toPlainString } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { checkOpeningBalances, type OpeningBalanceFigures, type OpeningEarningsRow } from "@/lib/payroll/leave/opening";
import { weekHours } from "@/lib/payroll/leave/work-pattern";
import { loadOpening, type OpeningFacts } from "@/lib/payroll/leave-facts";
import { updateDraftsCovering } from "@/lib/payroll/leave-pay-runs";
import { fileHash, loadSettingsList, storeFile, type UploadedFile } from "@/lib/payroll/leave-records";
import { optionalString, requireArray, requireIdempotencyKey } from "@/lib/validation";

/**
 * Opening leave balances (decision 168; examples HL43-HL48): an employee's
 * leave and earlier earnings from another payroll, as at the end of the
 * opening date, entered once by someone with payroll access with where they
 * came from and the previous system's report attached. A replacement keeps
 * the old one, and is refused once an approved pay run has paid the
 * employee leave. Drafts covering the employee are worked out again.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function employeeIdFrom(input: unknown): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) throw new NotFoundError("Employee not found.");
  return input.toLowerCase();
}

export type OpeningBalances = OpeningFacts & { employeeId: string; replaced: Array<{ asAt: string; createdAt: string; createdByEmail: string }> };

/** An employee's current opening balances (payroll access), or null, with the ones they replaced. */
export async function getOpeningBalances(tx: OrgTx, employeeIdInput: unknown): Promise<OpeningBalances | null> {
  await requirePayrollAccess(tx);
  const employeeId = employeeIdFrom(employeeIdInput);
  const exists = await tx.query("select 1 from payroll_employees where id = $1", [employeeId]);
  if (!exists.rows[0]) throw new NotFoundError("Employee not found.");
  const opening = await loadOpening(tx, employeeId);
  if (!opening) return null;
  const replaced = await tx.query<{ as_at: string; created_at: string; created_by_email: string }>(
    "select as_at::text, created_at::text, created_by_email from payroll_leave_opening_balances where employee_id = $1 and status = 'replaced' order by entry_number desc",
    [employeeId],
  );
  return {
    ...opening,
    employeeId,
    replaced: replaced.rows.map((row) => ({ asAt: row.as_at, createdAt: row.created_at, createdByEmail: row.created_by_email })),
  };
}

function decimalField(value: unknown, label: string, options: { allowNegative?: boolean; maxScale?: number } = {}): string {
  if (value === undefined || value === null || value === "") return "0";
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") throw new ValidationError(`${label} must be a number.`);
  const trimmed = text.trim();
  if (options.allowNegative && trimmed.startsWith("-")) {
    return `-${parseDecimalInput(trimmed.slice(1), label, { maxScale: options.maxScale ?? 4, allowZero: true })}`;
  }
  return parseDecimalInput(trimmed, label, { maxScale: options.maxScale ?? 4, allowZero: true });
}

function readFigures(input: Record<string, unknown>): OpeningBalanceFigures {
  const asAt = parseIsoDate(input.asAt, "Opening date");
  const lastEntitled = input.annualLastEntitled === undefined || input.annualLastEntitled === null || input.annualLastEntitled === "" ? null : parseIsoDate(input.annualLastEntitled, "Date last entitled to annual holidays");
  const alternativeHolidays = requireArray(input.alternativeHolidays ?? [], "Alternative holidays", 100).map((date) => parseIsoDate(date, "Date an alternative holiday arose"));
  const earnings: OpeningEarningsRow[] = requireArray(input.earnings ?? [], "Earnings", 400).map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`Earnings row ${index + 1} must be an object.`);
    const row = value as Record<string, unknown>;
    const days = typeof row.days === "number" ? row.days : typeof row.days === "string" && /^\d+$/.test(row.days.trim()) ? Number(row.days.trim()) : Number.NaN;
    return {
      periodStart: parseIsoDate(row.periodStart, `Earnings row ${index + 1}: from`),
      periodEnd: parseIsoDate(row.periodEnd, `Earnings row ${index + 1}: to`),
      gross: decimalField(row.gross, `Earnings row ${index + 1}: gross earnings`, { maxScale: 2 }),
      irregular: decimalField(row.irregular, `Earnings row ${index + 1}: irregular or one-off`, { maxScale: 2 }),
      days,
    };
  });
  return {
    asAt,
    annualWeeks: decimalField(input.annualWeeks, "Annual holidays (weeks)", { allowNegative: true, maxScale: 8 }),
    annualLastEntitled: lastEntitled,
    annualCashedUpWeeks: decimalField(input.annualCashedUpWeeks, "Weeks cashed up this entitlement year", { maxScale: 8 }),
    annualAdvancePaid: decimalField(input.annualAdvancePaid, "Holiday pay paid in advance", { maxScale: 2 }),
    sickDays: decimalField(input.sickDays, "Sick leave (days)", { allowNegative: true }),
    familyViolenceDays: decimalField(input.familyViolenceDays, "Family violence leave (days)", { allowNegative: true }),
    alternativeHolidays,
    earnings,
  };
}

/**
 * Enters (or replaces) an employee's opening balances (decision 168; HL43,
 * HL48), with the previous payroll's report attached as "report".
 */
export async function saveOpeningBalances(
  tx: OrgTx,
  input: Record<string, unknown> & { report?: UploadedFile | null },
): Promise<{ created: boolean; opening: OpeningBalances; payRuns: string[] }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const { report, ...fields } = input;
  const hash = requestHash("payroll_leave_opening_balances", { ...fields, report: fileHash(report) });
  const earlier = await tx.query<{ employee_id: string; request_hash: string }>(
    "select employee_id::text, request_hash from payroll_leave_opening_balances where idempotency_key = $1",
    [idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "opening balances");
    return { created: false, opening: (await getOpeningBalances(tx, earlier.rows[0].employee_id))!, payRuns: [] };
  }
  const employeeId = employeeIdFrom(input.employeeId);
  const employee = await tx.query<{ name: string; start_date: string; finish_date: string | null }>(
    "select first_name || ' ' || last_name as name, start_date::text, finish_date::text from payroll_employees where id = $1 for update",
    [employeeId],
  );
  if (!employee.rows[0]) throw new NotFoundError("Employee not found.");
  const { name, start_date: startDate, finish_date: finishDate } = employee.rows[0];
  const source = optionalString(input.source, "Where the figures came from", { maxLength: 1000 });
  if (!source) throw new ValidationError("Say where the opening balances came from (the previous payroll's report and its date).");
  if (!report) throw new ValidationError("Attach the previous payroll's leave and earnings report. Opening balances aren't saved without it (s 81(4) keeps the record).");
  const figures = readFigures(fields);

  const settings = await loadSettingsList(tx, employeeId);
  if (settings.length === 0) throw new ValidationError(`Set ${name}'s usual week under Employees › Leave before their opening balances.`);
  const onDate = settings.find((entry) => entry.effectiveFrom <= figures.asAt) ?? settings.at(-1)!;
  if (settings.some((entry) => entry.employmentType === "casual")) {
    throw new ValidationError(
      `Not supported yet (refused rather than guessed): opening balances for ${name}, who is set to casual (the s 63(1)(b) hours test needs approved timesheets for the 6 months, decision 145).`,
    );
  }
  const leavePaid = await tx.query<{ run_number: string }>(
    `select distinct r.run_number::text from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id and r.status = 'approved'
      where l.employee_id = $1 and l.leave_type is not null order by 1 limit 1`,
    [employeeId],
  );
  if (leavePaid.rows[0]) {
    throw new ConflictError(`PAYRUN-${leavePaid.rows[0].run_number} is approved with ${name}'s leave worked out by Tohyee, so opening balances can't be entered or replaced. Void it first.`);
  }
  const unpaid = await tx.query<{ start_date: string; end_date: string; reason: string; agreed_to_count: boolean }>(
    "select start_date::text, end_date::text, reason, agreed_to_count from payroll_unpaid_leave where employee_id = $1 and status = 'active'",
    [employeeId],
  );
  const approved = await tx.query<{ period_start: string; period_end: string; run_number: string }>(
    `select r.period_start::text, r.period_end::text, r.run_number::text
       from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id and r.status = 'approved'
      where pe.employee_id = $1 order by r.period_start`,
    [employeeId],
  );
  const across = approved.rows.find((period) => period.period_start <= figures.asAt && period.period_end > figures.asAt);
  if (across) {
    throw new ValidationError(`The opening date must be the end of a pay period: PAYRUN-${across.run_number} runs from ${formatDate(across.period_start)} to ${formatDate(across.period_end)}.`);
  }
  checkOpeningBalances({
    figures,
    startDate,
    finishDate,
    unpaid: unpaid.rows.map((leave) => ({ start: leave.start_date, end: leave.end_date, statutory: leave.reason !== "other", agreedToCount: leave.agreed_to_count })),
    approvedPeriods: approved.rows.map((period) => ({ periodStart: period.period_start, periodEnd: period.period_end })),
  });

  const fileId = await storeFile(tx, employeeId, "opening_balances_report", report);
  const replaced = await tx.query(
    "update payroll_leave_opening_balances set status = 'replaced', replaced_at = now(), replaced_by_email = $2 where employee_id = $1 and status = 'current'",
    [employeeId, tx.actor.email],
  );
  const weekly = toPlainString(weekHours(onDate.pattern));
  const inserted = await tx.query<{ id: string }>(
    `insert into payroll_leave_opening_balances (idempotency_key, request_hash, employee_id, as_at, annual_weeks, annual_week_hours, annual_last_entitled,
                                                 annual_cashed_up_weeks, annual_advance_paid, sick_days, family_violence_days, alternative_holidays,
                                                 source, report_file_id, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date[], $13, $14, $15, $16) returning id::text`,
    [
      idempotencyKey,
      hash,
      employeeId,
      figures.asAt,
      figures.annualWeeks,
      weekly,
      figures.annualLastEntitled,
      figures.annualCashedUpWeeks,
      isNegative(dec(figures.annualWeeks)) ? figures.annualAdvancePaid : "0",
      figures.sickDays,
      figures.familyViolenceDays,
      figures.alternativeHolidays,
      source,
      fileId,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const id = inserted.rows[0].id;
  const rows = [...figures.earnings].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1));
  for (const [index, row] of rows.entries()) {
    await tx.query(
      `insert into payroll_leave_opening_earnings (opening_id, line_number, period_start, period_end, gross, irregular, days)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, index + 1, row.periodStart, row.periodEnd, row.gross, row.irregular, row.days],
    );
  }
  // Never the balances themselves: the audit log isn't private (family violence leave, decision 27).
  await writeAuditEvent(tx, {
    eventType: "payroll_leave_opening_balances.saved",
    entityType: "payroll_employee",
    entityId: employeeId,
    details: { asAt: figures.asAt, earningsRows: rows.length, replacedEarlier: (replaced.rowCount ?? 0) > 0 },
  });
  const payRuns = await updateDraftsCovering(tx, employeeId, "0001-01-01", "9999-12-31");
  return { created: true, opening: (await getOpeningBalances(tx, employeeId))!, payRuns };
}
