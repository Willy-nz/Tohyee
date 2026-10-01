import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, isPositive, parseDecimalInput, sum, toPlainString } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { ANNIVERSARY_REGIONS, type AnniversaryRegion } from "@/lib/payroll/leave/public-holiday-dates";
import { NOT_SUPPORTED } from "@/lib/payroll/leave/rules";
import { patternDayHours, type PatternDay, type PatternExtra, type WorkPattern } from "@/lib/payroll/leave/work-pattern";
import { payRateOn } from "@/lib/payroll/pay-rates";
import { asRecord, optionalString, requireArray, requireBoolean, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Each employee's usual week and leave settings (payroll stage P8;
 * decisions 8, 9, 11, 13, 19, 22, 142): dated rows, never changed, as pay
 * rates are (PE7). The setting in effect on a date is the latest one from
 * on or before it. Payroll access only.
 */

export const DAILY_PAY_METHODS = ["rdp", "adp"] as const;
export type DailyPayMethod = (typeof DAILY_PAY_METHODS)[number];
/** The two reasons s 9A(1) allows average daily pay for (decision 13). */
export const ADP_REASONS = ["not_practicable", "varies_within_period"] as const;
export type AdpReason = (typeof ADP_REASONS)[number];
export const ADP_REASON_LABELS: Record<AdpReason, string> = {
  not_practicable: "Relevant daily pay can't practicably be worked out (s 9A(1)(a))",
  varies_within_period: "Daily pay varies within the pay period (s 9A(1)(b))",
};
export const EMPLOYMENT_TYPES = ["continuous", "casual"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export type LeaveSettings = {
  id: string;
  employeeId: string;
  effectiveFrom: string;
  pattern: WorkPattern;
  dailyPay: DailyPayMethod;
  adpReason: AdpReason | null;
  /** Agreed that annual holidays are paid in the pay for the period they're taken (s 27(1)(a)). */
  annualPaidInPeriod: boolean;
  /** A part-day sick leave agreement is recorded (decision 19). */
  partDaySickAgreed: boolean;
  /** Casual: sick leave by the hours test (s 63(1)(b)). */
  employmentType: EmploymentType;
  /** Null: the organisation's anniversary day (decision 22). */
  anniversaryRegion: AnniversaryRegion | null;
  note: string | null;
  createdAt: string;
  createdByEmail: string;
};

type SettingsRow = {
  id: string;
  employee_id: string;
  effective_from: string;
  pattern_kind: "fixed" | "varies";
  pattern_days: PatternDay[] | null;
  week_hours: string | null;
  week_days: string | null;
  daily_pay: DailyPayMethod;
  adp_reason: AdpReason | null;
  annual_paid_in_period: boolean;
  part_day_sick_agreed: boolean;
  employment_type: EmploymentType;
  anniversary_region: AnniversaryRegion | null;
  note: string | null;
  created_at: string;
  created_by_email: string;
  request_hash: string;
};

const COLUMNS = `id, employee_id, effective_from::text, pattern_kind, pattern_days, week_hours::text, week_days::text, daily_pay, adp_reason,
  annual_paid_in_period, part_day_sick_agreed, employment_type, anniversary_region, note, created_at::text, created_by_email, request_hash`;

function toSettings(row: SettingsRow): LeaveSettings {
  return {
    id: row.id,
    employeeId: row.employee_id,
    effectiveFrom: row.effective_from,
    pattern:
      row.pattern_kind === "fixed"
        ? { kind: "fixed", days: row.pattern_days! }
        : { kind: "varies", weekHours: toPlainString(dec(row.week_hours!)), weekDays: toPlainString(dec(row.week_days!)) },
    dailyPay: row.daily_pay,
    adpReason: row.adp_reason,
    annualPaidInPeriod: row.annual_paid_in_period,
    partDaySickAgreed: row.part_day_sick_agreed,
    employmentType: row.employment_type,
    anniversaryRegion: row.anniversary_region,
    note: row.note,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
  };
}

/** The leave settings in effect on a date, or null before the first (no payroll access check: callers check). */
export async function leaveSettingsOn(tx: OrgTx, employeeId: string, date: string): Promise<LeaveSettings | null> {
  const result = await tx.query<SettingsRow>(
    `select ${COLUMNS} from payroll_leave_settings where employee_id = $1 and effective_from <= $2
      order by effective_from desc, entry_number desc limit 1`,
    [employeeId, date],
  );
  return result.rows[0] ? toSettings(result.rows[0]) : null;
}

/** Every leave setting row an employee has, newest first. */
export async function listLeaveSettings(tx: OrgTx, employeeId: string): Promise<LeaveSettings[]> {
  await requirePayrollAccess(tx);
  const result = await tx.query<SettingsRow>(
    `select ${COLUMNS} from payroll_leave_settings where employee_id = $1 order by effective_from desc, entry_number desc`,
    [employeeId],
  );
  return result.rows.map(toSettings);
}

/** Whether a setting starts inside a period (after its first day), which a pay run refuses (decision 142). */
export async function settingsChangeInside(tx: OrgTx, employeeId: string, from: string, to: string): Promise<string | null> {
  const result = await tx.query<{ effective_from: string }>(
    "select effective_from::text from payroll_leave_settings where employee_id = $1 and effective_from > $2 and effective_from <= $3 order by effective_from limit 1",
    [employeeId, from, to],
  );
  return result.rows[0]?.effective_from ?? null;
}

function hours(input: unknown, label: string, allowZero: boolean): string {
  const text = parseDecimalInput(input ?? "0", label, { maxScale: 2, allowZero });
  if (cmp(dec(text), dec("24")) > 0) throw new ValidationError(`${label} can't be more than 24.`);
  return text;
}

/**
 * The usual week (decisions 9, 11): seven days, Monday first, each with
 * ordinary hours and usual extras: overtime (hours, at the overtime pay
 * item's multiplier) and allowances (an amount for the day), each regular or
 * not. Or "varies", with the agreed week in hours and days (s 17).
 */
async function parsePattern(tx: OrgTx, input: unknown, salaried: boolean): Promise<WorkPattern> {
  const record = asRecord(input, "Usual week");
  const kind = requireOneOf(record.kind, "Usual week kind", ["fixed", "varies"] as const);
  if (kind === "varies") {
    const weekHours = parseDecimalInput(record.weekHours, "Hours in the agreed working week", { maxScale: 2 });
    if (cmp(dec(weekHours), dec("168")) > 0) throw new ValidationError("Hours in the agreed working week can't be more than 168.");
    const weekDays = parseDecimalInput(record.weekDays, "Days in the agreed working week", { maxScale: 2 });
    if (cmp(dec(weekDays), dec("7")) > 0) throw new ValidationError("Days in the agreed working week can't be more than 7.");
    return { kind: "varies", weekHours, weekDays };
  }
  const daysInput = requireArray(record.days, "Usual week days", 7);
  if (daysInput.length !== 7) throw new ValidationError("A usual week has 7 days, Monday to Sunday.");
  const itemIds = new Set<string>();
  for (const day of daysInput) {
    for (const extra of requireArray(asRecord(day, "Day").extras ?? [], "Extras", 10)) itemIds.add(String(asRecord(extra, "Extra").payItemId));
  }
  const items = new Map(
    (
      await tx.query<{ id: string; name: string; kind: string; rate_multiplier: string | null; is_archived: boolean }>(
        "select id::text, name, kind, rate_multiplier::text, is_archived from payroll_pay_items where id::text = any($1::text[])",
        [[...itemIds]],
      )
    ).rows.map((row) => [row.id, row]),
  );
  const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const days: PatternDay[] = daysInput.map((dayInput, index) => {
    const day = asRecord(dayInput, names[index]);
    const extras: PatternExtra[] = requireArray(day.extras ?? [], `${names[index]} extras`, 10).map((extraInput) => {
      const extra = asRecord(extraInput, `${names[index]} extra`);
      const item = items.get(String(extra.payItemId));
      if (!item) throw new ValidationError(`${names[index]}: that pay item wasn't found.`);
      if (item.is_archived) throw new ValidationError(`${names[index]}: ${item.name} is archived.`);
      const regular = extra.regular === undefined ? true : requireBoolean(extra.regular, "Regular");
      if (item.kind === "overtime") {
        if (salaried) throw new ValidationError(`${NOT_SUPPORTED}: overtime in the usual week of someone on a salary.`);
        return {
          payItemId: item.id,
          name: item.name,
          kind: "overtime",
          hours: hours(extra.hours, `${names[index]} ${item.name} hours`, false),
          multiplier: toPlainString(dec(item.rate_multiplier ?? "1.5")),
          amount: null,
          regular,
        };
      }
      if (item.kind === "allowance") {
        return {
          payItemId: item.id,
          name: item.name,
          kind: "allowance",
          hours: null,
          multiplier: null,
          amount: parseDecimalInput(extra.amount, `${names[index]} ${item.name} amount`, { maxScale: 2 }),
          regular,
        };
      }
      throw new ValidationError(`${names[index]}: only overtime and allowances can be part of a usual week.`);
    });
    return { ordinaryHours: hours(day.ordinaryHours, `${names[index]} hours`, true), extras };
  });
  for (const [index, day] of days.entries()) {
    if (!isPositive(dec(day.ordinaryHours)) && day.extras.length > 0) {
      throw new ValidationError(`${names[index]} has extras but no ordinary hours. Extras go on working days.`);
    }
    if (cmp(patternDayHours(day), dec("24")) > 0) throw new ValidationError(`${names[index]}'s hours come to more than 24.`);
  }
  if (!isPositive(sum(days.map(patternDayHours)))) throw new ValidationError("A usual week needs at least one working day.");
  return { kind: "fixed", days };
}

/**
 * Saves leave settings from a date (decision 142). The first can't start
 * before the employee does. Drafts covering the employee are updated by the
 * caller (leave-pay-runs).
 */
export async function addLeaveSettings(
  tx: OrgTx,
  employeeId: string,
  input: Record<string, unknown>,
): Promise<{ created: boolean; settings: LeaveSettings }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = requestHash("payroll_leave_settings", { employeeId, ...input });
  const earlier = await tx.query<SettingsRow>(`select ${COLUMNS} from payroll_leave_settings where idempotency_key = $1`, [idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "leave settings");
    return { created: false, settings: toSettings(earlier.rows[0]) };
  }
  const employee = await tx.query<{ start_date: string; finish_date: string | null }>(
    "select start_date::text, finish_date::text from payroll_employees where id::text = $1 for update",
    [employeeId],
  );
  if (!employee.rows[0]) throw new NotFoundError("Employee not found.");
  const effectiveFrom = parseIsoDate(input.effectiveFrom ?? employee.rows[0].start_date, "Effective from");
  if (effectiveFrom < employee.rows[0].start_date) throw new ValidationError(`Leave settings can't start before the employee does (${employee.rows[0].start_date}).`);
  const rate = await payRateOn(tx, employeeId, effectiveFrom);
  if (!rate) throw new ValidationError(`There's no pay rate on ${effectiveFrom}. Add one under Pay rates first.`);
  const pattern = await parsePattern(tx, input.pattern, rate.payBasis === "salary");
  const dailyPay = requireOneOf(input.dailyPay ?? "rdp", "Daily pay", DAILY_PAY_METHODS);
  const adpReason = dailyPay === "adp" ? requireOneOf(input.adpReason, "Reason for average daily pay", ADP_REASONS) : null;
  if (dailyPay === "rdp" && input.adpReason !== undefined && input.adpReason !== null && input.adpReason !== "") {
    throw new ValidationError("A reason is only recorded for average daily pay.");
  }
  if (dailyPay === "rdp" && pattern.kind === "varies" && rate.payBasis === "salary") {
    throw new ValidationError(`${NOT_SUPPORTED}: relevant daily pay for someone on a salary whose hours vary. Use average daily pay.`);
  }
  const annualPaidInPeriod = requireBoolean(input.annualPaidInPeriod, "Annual holidays paid in the pay for the period they're taken");
  const partDaySickAgreed = input.partDaySickAgreed === undefined ? false : requireBoolean(input.partDaySickAgreed, "Part-day sick leave agreement");
  const employmentType = requireOneOf(input.employmentType ?? "continuous", "Employment", EMPLOYMENT_TYPES);
  const region =
    input.anniversaryRegion === undefined || input.anniversaryRegion === null || input.anniversaryRegion === ""
      ? null
      : requireOneOf(input.anniversaryRegion, "Anniversary day", ANNIVERSARY_REGIONS);
  const note = optionalString(input.note, "Note", { maxLength: 1000 });
  const inserted = await tx.query<SettingsRow>(
    `insert into payroll_leave_settings (idempotency_key, request_hash, employee_id, effective_from, pattern_kind, pattern_days, week_hours,
                                         week_days, daily_pay, adp_reason, annual_paid_in_period, part_day_sick_agreed, employment_type,
                                         anniversary_region, note, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     on conflict (idempotency_key) do nothing returning ${COLUMNS}`,
    [
      idempotencyKey,
      hash,
      employeeId,
      effectiveFrom,
      pattern.kind,
      pattern.kind === "fixed" ? JSON.stringify(pattern.days) : null,
      pattern.kind === "varies" ? pattern.weekHours : null,
      pattern.kind === "varies" ? pattern.weekDays : null,
      dailyPay,
      adpReason,
      annualPaidInPeriod,
      partDaySickAgreed,
      employmentType,
      region,
      note,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  if (!inserted.rows[0]) throw new ConflictError("The leave settings couldn't be saved. Try again with a new idempotency key.");
  await writeAuditEvent(tx, {
    eventType: "payroll_leave_settings.added",
    entityType: "payroll_employee",
    entityId: employeeId,
    details: { effectiveFrom, patternKind: pattern.kind, dailyPay },
  });
  return { created: true, settings: toSettings(inserted.rows[0]) };
}

/** The organisation's leave settings (decision 22; s 28E). */
export type OrganisationLeaveSettings = { anniversaryRegion: AnniversaryRegion | null; noCashUps: boolean };

export async function readOrganisationLeaveSettings(tx: OrgTx): Promise<OrganisationLeaveSettings> {
  const result = await tx.query<{ payroll_anniversary_region: AnniversaryRegion | null; payroll_no_cash_ups: boolean }>(
    "select payroll_anniversary_region, payroll_no_cash_ups from organisation_settings where id = true",
  );
  return { anniversaryRegion: result.rows[0]?.payroll_anniversary_region ?? null, noCashUps: result.rows[0]?.payroll_no_cash_ups ?? false };
}

export async function getOrganisationLeaveSettings(tx: OrgTx): Promise<OrganisationLeaveSettings> {
  await requirePayrollAccess(tx);
  return readOrganisationLeaveSettings(tx);
}

/** Changes the organisation's anniversary day or cash-up policy (admins with payroll access; the route checks the role). */
export async function updateOrganisationLeaveSettings(tx: OrgTx, input: Record<string, unknown>): Promise<OrganisationLeaveSettings> {
  await requirePayrollAccess(tx);
  const current = await readOrganisationLeaveSettings(tx);
  const anniversaryRegion =
    input.anniversaryRegion === undefined
      ? current.anniversaryRegion
      : input.anniversaryRegion === null || input.anniversaryRegion === ""
        ? null
        : requireOneOf(input.anniversaryRegion, "Anniversary day", ANNIVERSARY_REGIONS);
  const noCashUps = input.noCashUps === undefined ? current.noCashUps : requireBoolean(input.noCashUps, "noCashUps");
  await tx.query("update organisation_settings set payroll_anniversary_region = $1, payroll_no_cash_ups = $2 where id = true", [anniversaryRegion, noCashUps]);
  await writeAuditEvent(tx, {
    eventType: "payroll_leave_organisation_settings.updated",
    entityType: "organisation_settings",
    entityId: "payroll_leave",
    details: { anniversaryRegion, noCashUps },
  });
  return { anniversaryRegion, noCashUps };
}
