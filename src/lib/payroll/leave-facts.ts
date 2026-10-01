import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { add, dec, type Decimal, isPositive, mul, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import type { PayFrequency } from "@/lib/payroll/groups";
import { annualEntitlement, annualEntitlementDates, divisorReduction, employedTwelveMonths, entitlementYear, type UnpaidLeave } from "@/lib/payroll/leave/annual";
import { addDays, addMonths, eachDay, laterOf, weekdayIndex } from "@/lib/payroll/leave/dates";
import {
  averageDailyPay,
  averageWeeklyEarnings,
  averageWeeklyEarningsSinceStart,
  type DayWeight,
  earningsBetween,
  fiftyTwoWeeksTo,
  fourWeekOrdinaryPay,
  greaterOf,
  type PeriodEarnings,
  twelveMonthsTo,
} from "@/lib/payroll/leave/earnings";
import { addLeave, type LeaveQuantity, leaveHours, NO_LEAVE, subtractLeave } from "@/lib/payroll/leave/quantity";
import { NOT_SUPPORTED } from "@/lib/payroll/leave/rules";
import { familyViolenceLeaveBalance, hoursTestMet, sickEntitlementDates, sickLeaveBalance, type DayLeaveEvent } from "@/lib/payroll/leave/sick";
import { ordinaryWeeklyPay, relevantDailyPay, usualHoursOn, weekHours, type PayRateBasis } from "@/lib/payroll/leave/work-pattern";
import type { LeaveSettings } from "@/lib/payroll/leave-settings";
import { payRateOn } from "@/lib/payroll/pay-rates";
import { payRunReference } from "@/lib/payroll/pay-run-reference";

/**
 * What Tohyee knows about one employee's employment, pay and leave, read
 * once from the organisation's database, and the Holidays Act rates worked
 * out from it (P8): gross earnings by pay period from approved pay runs
 * (s 14; decision 139), approved timesheets' hours, unpaid leave, leave
 * already paid, and the usual week in effect on each date. Leave counts
 * when its pay run is approved; a voided pay run's leave doesn't count
 * (decision 141). Callers check payroll access.
 */

export type LeaveLineType =
  | "annual"
  | "sick"
  | "bereavement"
  | "family_violence"
  | "alternative"
  | "public_holiday"
  | "public_holiday_worked"
  | "cash_up"
  | "exchange"
  | "termination";

/** A leave line, from an approved pay run or worked out for a draft. */
export type LeaveLine = {
  payRunId: string | null;
  reference: string | null;
  payDate: string | null;
  leaveType: LeaveLineType;
  bookingId: string | null;
  from: string | null;
  to: string | null;
  hours: string | null;
  unitHours: string | null;
  units: string | null;
  inAdvance: boolean;
  holidayDate: string | null;
  cashUpId: string | null;
  exchangeId: string | null;
  amount: string;
  description: string | null;
  basis: Record<string, unknown>;
};

export type ApprovedPeriod = PeriodEarnings & { payRunId: string; reference: string; payDate: string };

export type EmployeeFacts = {
  id: string;
  name: string;
  startDate: string;
  finishDate: string | null;
  payFrequency: PayFrequency;
  /** The first approved pay period's start: Tohyee's pay records for the employee begin here. */
  recordsStart: string | null;
  /** Approved pay runs with typed holiday pay (P3's "Holiday pay"): leave Tohyee doesn't know about. */
  typedHolidayPay: string[];
  unpaid: UnpaidLeave[];
  periods: ApprovedPeriod[];
  lines: LeaveLine[];
  /** Approved timesheets: hours each day, and the weeks (Mondays) they cover. */
  timesheetHours: Map<string, string>;
  timesheetWeeks: Set<string>;
  settings: LeaveSettings[];
  noCashUps: boolean;
  organisationRegion: string | null;
};

type LineRow = {
  pay_run_id: string;
  run_number: string;
  pay_date: string;
  leave_type: LeaveLineType;
  leave_booking_id: string | null;
  leave_from: string | null;
  leave_to: string | null;
  leave_hours: string | null;
  leave_unit_hours: string | null;
  leave_units: string | null;
  leave_in_advance: boolean;
  holiday_date: string | null;
  cash_up_id: string | null;
  exchange_id: string | null;
  amount: string;
  description: string | null;
  leave_basis: Record<string, unknown> | null;
};

/** Loads an employee's facts. `excludeRunId` leaves out a pay run (a draft being worked out is never approved anyway). */
export async function loadEmployeeFacts(tx: OrgTx, employeeId: string, settings: LeaveSettings[]): Promise<EmployeeFacts> {
  const employee = await tx.query<{ id: string; name: string; start_date: string; finish_date: string | null; pay_frequency: PayFrequency }>(
    `select id::text, first_name || ' ' || last_name as name, start_date::text, finish_date::text, pay_frequency
       from payroll_employees where id::text = $1`,
    [employeeId],
  );
  const row = employee.rows[0];
  if (!row) throw new ValidationError("Employee not found.");
  const periods = await tx.query<{
    pay_run_id: string;
    run_number: string;
    period_start: string;
    period_end: string;
    pay_date: string;
    gross: string;
    irregular: string;
    typed_holiday_pay: boolean;
  }>(
    `select r.id::text as pay_run_id, r.run_number::text, r.period_start::text, r.period_end::text, r.pay_date::text,
            coalesce(sum(l.amount) filter (where p.counts_for_holiday_pay and coalesce(l.leave_type, '') <> 'termination'), 0)::text as gross,
            coalesce(sum(l.amount) filter (where p.counts_for_holiday_pay
                                             and (p.kind in ('extra_pay', 'back_pay')
                                                  or (p.kind in ('overtime', 'allowance') and l.regular = false))), 0)::text as irregular,
            bool_or(p.kind = 'holiday_pay') as typed_holiday_pay
       from payroll_pay_run_employees pe
       join payroll_pay_runs r on r.id = pe.pay_run_id and r.status = 'approved'
       left join payroll_pay_run_lines l on l.pay_run_id = pe.pay_run_id and l.employee_id = pe.employee_id
       left join payroll_pay_items p on p.id = l.pay_item_id
      where pe.employee_id::text = $1
      group by r.id
      order by r.period_start, r.run_number`,
    [employeeId],
  );
  const lines = await tx.query<LineRow>(
    `select l.pay_run_id::text, r.run_number::text, r.pay_date::text, l.leave_type, l.leave_booking_id::text, l.leave_from::text, l.leave_to::text,
            l.leave_hours::text, l.leave_unit_hours::text, l.leave_units::text, l.leave_in_advance, l.holiday_date::text, l.cash_up_id::text,
            l.exchange_id::text, l.amount::text, l.description, l.leave_basis
       from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id and r.status = 'approved'
      where l.employee_id::text = $1 and l.leave_type is not null
      order by coalesce(l.leave_from, l.holiday_date, r.period_start), r.run_number, l.line_number`,
    [employeeId],
  );
  const unpaid = await tx.query<{ start_date: string; end_date: string; reason: string; agreed_to_count: boolean }>(
    "select start_date::text, end_date::text, reason, agreed_to_count from payroll_unpaid_leave where employee_id::text = $1 and status = 'active' order by start_date",
    [employeeId],
  );
  const timesheets = await tx.query<{ week_start: string; work_date: string | null; hours: string | null }>(
    `select t.week_start::text, e.work_date::text, sum(e.hours)::text as hours
       from payroll_timesheets t
       left join payroll_timesheet_entries e on e.timesheet_id = t.id and e.status = 'active'
      where t.employee_id::text = $1 and t.status = 'approved'
      group by t.week_start, e.work_date`,
    [employeeId],
  );
  const organisation = await tx.query<{ payroll_anniversary_region: string | null; payroll_no_cash_ups: boolean }>(
    "select payroll_anniversary_region, payroll_no_cash_ups from organisation_settings where id = true",
  );
  const timesheetHours = new Map<string, string>();
  const timesheetWeeks = new Set<string>();
  for (const entry of timesheets.rows) {
    if (entry.work_date && entry.hours) {
      timesheetHours.set(entry.work_date, entry.hours);
      timesheetWeeks.add(entry.week_start);
    }
  }
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    finishDate: row.finish_date,
    payFrequency: row.pay_frequency,
    recordsStart: periods.rows[0]?.period_start ?? null,
    typedHolidayPay: periods.rows.filter((period) => period.typed_holiday_pay).map((period) => payRunReference(period.run_number)),
    unpaid: unpaid.rows.map((leave) => ({
      start: leave.start_date,
      end: leave.end_date,
      statutory: leave.reason !== "other",
      agreedToCount: leave.agreed_to_count,
    })),
    periods: periods.rows.map((period) => ({
      payRunId: period.pay_run_id,
      reference: payRunReference(period.run_number),
      payDate: period.pay_date,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      gross: period.gross,
      irregular: period.irregular,
    })),
    lines: lines.rows.map(toLeaveLine),
    timesheetHours,
    timesheetWeeks,
    settings,
    noCashUps: organisation.rows[0]?.payroll_no_cash_ups ?? false,
    organisationRegion: organisation.rows[0]?.payroll_anniversary_region ?? null,
  };
}

function toLeaveLine(row: LineRow): LeaveLine {
  return {
    payRunId: row.pay_run_id,
    reference: payRunReference(row.run_number),
    payDate: row.pay_date,
    leaveType: row.leave_type,
    bookingId: row.leave_booking_id,
    from: row.leave_from,
    to: row.leave_to,
    hours: row.leave_hours,
    unitHours: row.leave_unit_hours,
    units: row.leave_units,
    inAdvance: row.leave_in_advance,
    holidayDate: row.holiday_date,
    cashUpId: row.cash_up_id,
    exchangeId: row.exchange_id,
    amount: row.amount,
    description: row.description,
    basis: row.leave_basis ?? {},
  };
}

/** The settings in effect on a date (newest first in `facts.settings`). */
export function settingsOn(facts: EmployeeFacts, date: string): LeaveSettings | null {
  return facts.settings.find((settings) => settings.effectiveFrom <= date) ?? null;
}

export function requireSettingsOn(facts: EmployeeFacts, date: string): LeaveSettings {
  const settings = settingsOn(facts, date);
  if (!settings) throw new ValidationError(`${facts.name} has no usual week on ${formatDate(date)}. Set it under Employees › Leave.`);
  return settings;
}

/**
 * Whether Tohyee keeps the employee's leave (decision 143): it needs their
 * usual week, every entitlement since they started must have arisen while
 * Tohyee had their pay records (opening balances aren't supported yet), and
 * no approved pay run may have typed holiday pay for leave Tohyee didn't
 * see. Returns why not, or null.
 */
export function whyLeaveNotKept(facts: EmployeeFacts, recordsStart: string | null): string | null {
  if (facts.settings.length === 0) return `Tohyee doesn't keep ${facts.name}'s leave: set their usual week under Employees › Leave first.`;
  if (facts.typedHolidayPay.length > 0) {
    return `${NOT_SUPPORTED}: leave for ${facts.name}, who was paid typed holiday pay on ${facts.typedHolidayPay.join(", ")} (Tohyee doesn't know what leave it was for; opening leave balances need their own worked example).`;
  }
  // With no pay records yet, Tohyee's records would start now.
  const start = recordsStart ?? facts.recordsStart ?? todayIsoDate();
  {
    const firstAnnual = addMonths(facts.startDate, 12);
    const firstSick = addMonths(facts.startDate, 6);
    const first = firstSick < firstAnnual ? firstSick : firstAnnual;
    if (first < start) {
      return `${NOT_SUPPORTED}: leave for ${facts.name}, whose leave entitlements began before Tohyee's first pay run for them (${formatDate(start)}); opening leave balances need their own worked example.`;
    }
  }
  return null;
}

/** Tohyee's records start: the first approved pay period, or the draft's when there's none yet. */
export function recordsStartWith(facts: EmployeeFacts, draftPeriodStart: string | null): string | null {
  if (!facts.recordsStart) return draftPeriodStart;
  if (!draftPeriodStart) return facts.recordsStart;
  return facts.recordsStart < draftPeriodStart ? facts.recordsStart : draftPeriodStart;
}

const PERIOD_DAYS: Partial<Record<PayFrequency, number>> = { weekly: 7, fortnightly: 14, four_weekly: 28 };

/**
 * The last day of the pay period before the one a date falls in (s 8(2),
 * s 9A(2), s 21(2)(b)(ii), s 24(b)), from a known period start: the period
 * before the holiday, the calculation or the end of employment.
 */
export function lastPeriodEndBefore(anchorPeriodStart: string, frequency: PayFrequency, date: string): string {
  const days = PERIOD_DAYS[frequency];
  if (!days) return addDays(`${date.slice(0, 7)}-01`, -1);
  const offset = Math.floor((Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) - Date.UTC(+anchorPeriodStart.slice(0, 4), +anchorPeriodStart.slice(5, 7) - 1, +anchorPeriodStart.slice(8, 10))) / 86_400_000);
  const periodsBack = Math.floor(offset / days);
  const containingStart = addDays(anchorPeriodStart, periodsBack * days);
  return addDays(containingStart, -1);
}

/** The start of the pay period that ends on `end`. */
export function periodStartFor(frequency: PayFrequency, end: string): string {
  const days = PERIOD_DAYS[frequency];
  return days ? addDays(end, -(days - 1)) : `${end.slice(0, 7)}-01`;
}

/**
 * Refuses a calculation that needs pay records Tohyee doesn't have (decision
 * 143): earnings from before Tohyee's first pay run for the employee, or a
 * pay period up to `windowEnd` that hasn't been approved yet.
 */
export function assertEarningsKnown(facts: EmployeeFacts, from: string, windowEnd: string, recordsStart: string | null, what: string): void {
  const needed = laterOf(from, facts.startDate);
  if (needed > windowEnd) return;
  const start = recordsStart ?? facts.recordsStart;
  if (!start || needed < start) {
    throw new ValidationError(
      `${NOT_SUPPORTED}: ${what} for ${facts.name} needs pay from ${formatDate(needed)}, before Tohyee's first pay run for them${start ? ` (${formatDate(start)})` : ""}; earnings from before Tohyee need their own worked example.`,
    );
  }
  const lastApproved = facts.periods.reduce<string | null>((latest, period) => (!latest || period.periodEnd > latest ? period.periodEnd : latest), null);
  if (!lastApproved || lastApproved < windowEnd) {
    throw new ValidationError(
      `${what} for ${facts.name} needs the pay run for the period ending ${formatDate(windowEnd)} to be approved first (holiday pay is worked out from the pay periods before it).`,
    );
  }
}

/** How a day weighs when a pay period is only partly inside a window: timesheet hours in weeks with an approved timesheet, else usual hours. */
export function dayWeight(facts: EmployeeFacts): DayWeight {
  return (date) => {
    const monday = addDays(date, -weekdayIndex(date));
    if (facts.timesheetWeeks.has(monday)) return dec(facts.timesheetHours.get(date) ?? "0");
    const settings = settingsOn(facts, date) ?? facts.settings.at(-1) ?? null;
    if (!settings || settings.pattern.kind !== "fixed") return null;
    return usualHoursOn(settings.pattern, date);
  };
}

export type PayRateOn = PayRateBasis & { ordinaryHoursPerWeek: string | null };

export async function rateOn(tx: OrgTx, facts: EmployeeFacts, date: string): Promise<PayRateOn> {
  const rate = await payRateOn(tx, facts.id, laterOf(date, facts.startDate));
  if (!rate) throw new ValidationError(`${facts.name} has no pay rate on ${formatDate(date)}.`);
  return { payBasis: rate.payBasis, annualSalary: rate.annualSalary, hourlyRate: rate.hourlyRate, ordinaryHoursPerWeek: rate.ordinaryHoursPerWeek };
}

/** The weekly rate for annual holidays (s 21(2), s 22(2); decisions 10, 12, 14), with its inputs. */
export type WeeklyRate = {
  rate: Decimal;
  source: "owp" | "awe";
  owp: Decimal;
  owpMethod: "s 8(1)" | "s 8(2)";
  fourWeek: Decimal | null;
  awe: Decimal;
  aweFrom: string;
  aweTo: string;
  aweGross: Decimal;
  aweDivisor: Decimal;
  inAdvanceSinceStart: boolean;
};

/**
 * The greater of ordinary weekly pay at `date` and average weekly earnings
 * for the 12 calendar months to the end of the last pay period before it
 * (or since the start, for holidays in advance before 12 months, s 22).
 * The four-week figure is always worked out and shown, and used only when
 * s 8(1) can't give ordinary weekly pay (hours that vary; decision 12).
 */
export async function weeklyRateOn(
  tx: OrgTx,
  facts: EmployeeFacts,
  input: { date: string; anchorPeriodStart: string; recordsStart: string | null; inAdvance: boolean; what: string },
): Promise<WeeklyRate> {
  const settings = requireSettingsOn(facts, input.date);
  const rate = await rateOn(tx, facts, input.date);
  const windowEnd = lastPeriodEndBefore(input.anchorPeriodStart, facts.payFrequency, input.date);
  const weight = dayWeight(facts);
  const sinceStart = input.inAdvance && !employedTwelveMonths(facts.startDate, input.date);
  const window = sinceStart ? { from: facts.startDate, to: windowEnd } : twelveMonthsTo(windowEnd);
  assertEarningsKnown(facts, window.from, windowEnd, input.recordsStart, input.what);
  const awe = sinceStart
    ? averageWeeklyEarningsSinceStart({ periods: facts.periods, startDate: facts.startDate, windowEnd, weight })
    : averageWeeklyEarnings({ periods: facts.periods, windowEnd, weight, divisorReduction: String(divisorReduction(facts.unpaid, window)) });
  let fourWeek: Decimal | null = null;
  try {
    const longStart = facts.payFrequency === "monthly" ? `${windowEnd.slice(0, 7)}-01` : null;
    assertEarningsKnown(facts, longStart ?? addDays(windowEnd, -27), windowEnd, input.recordsStart, input.what);
    fourWeek = fourWeekOrdinaryPay({ periods: facts.periods, windowEnd, longPeriodStart: longStart, weight }).weekly;
  } catch (error) {
    if (!(error instanceof ValidationError) || settings.pattern.kind === "fixed") fourWeek = null;
    else throw error;
  }
  const owpMethod = settings.pattern.kind === "fixed" ? "s 8(1)" : "s 8(2)";
  const owp = settings.pattern.kind === "fixed" ? ordinaryWeeklyPay(settings.pattern, rate) : (fourWeek ?? ZERO_DECIMAL);
  const greater = greaterOf(owp, awe.weekly);
  return {
    rate: greater.rate,
    source: greater.source,
    owp,
    owpMethod,
    fourWeek,
    awe: awe.weekly,
    aweFrom: awe.from,
    aweTo: awe.to,
    aweGross: awe.gross,
    aweDivisor: awe.divisor,
    inAdvanceSinceStart: sinceStart,
  };
}

/** A daily rate for public holidays, alternative holidays, sick, bereavement and family violence leave (s 9, s 9A; decision 13). */
export type DailyRate = { rate: Decimal; method: "rdp" | "adp"; basis: Record<string, string | number | null> };

/**
 * Relevant daily pay for the date (s 9), or average daily pay (s 9A) when
 * the employee is set to it (decision 13). For someone whose hours vary,
 * RDP is the day's hours (from the leave booking) × the hourly rate.
 */
export async function dailyRateOn(
  tx: OrgTx,
  facts: EmployeeFacts,
  input: { date: string; anchorPeriodStart: string; recordsStart: string | null; dayHours?: string | null; what: string },
): Promise<DailyRate | null> {
  const settings = requireSettingsOn(facts, input.date);
  const rate = await rateOn(tx, facts, input.date);
  if (settings.dailyPay === "adp") {
    const windowEnd = lastPeriodEndBefore(input.anchorPeriodStart, facts.payFrequency, input.date);
    const window = fiftyTwoWeeksTo(windowEnd);
    assertEarningsKnown(facts, window.from, windowEnd, input.recordsStart, input.what);
    const gross = earningsBetween(facts.periods, window.from, window.to, dayWeight(facts)).gross;
    const days = daysWorkedOrPaid(facts, laterOf(window.from, facts.startDate), window.to);
    const adp = averageDailyPay({ gross, days });
    if (!adp) throw new ValidationError(`${NOT_SUPPORTED}: average daily pay for ${facts.name}, who has no days worked or paid in the 52 weeks to ${formatDate(windowEnd)}.`);
    return { rate: adp, method: "adp", basis: { gross: toFixedString(gross, 6), days, from: window.from, to: window.to } };
  }
  if (settings.pattern.kind === "fixed") {
    const rdp = relevantDailyPay(settings.pattern, rate, input.date);
    return rdp === null ? null : { rate: rdp, method: "rdp", basis: { usualHours: toPlainString(usualHoursOn(settings.pattern, input.date)) } };
  }
  if (!input.dayHours || !isPositive(dec(input.dayHours)) || rate.payBasis !== "hourly") return null;
  return {
    rate: mul(dec(input.dayHours), dec(rate.hourlyRate!)),
    method: "rdp",
    basis: { hours: input.dayHours, hourlyRate: rate.hourlyRate },
  };
}

/**
 * The whole or part days worked or on paid leave (s 9A(2) "b"): days with
 * approved timesheet hours or paid leave in weeks with timesheets; the usual
 * working days of a fixed week otherwise (less unpaid leave). Refused for
 * hours that vary without timesheets.
 */
export function daysWorkedOrPaid(facts: EmployeeFacts, from: string, to: string): number {
  const paidLeave = new Set<string>();
  for (const line of facts.lines) {
    if (line.leaveType === "public_holiday" && line.holidayDate) paidLeave.add(line.holidayDate);
    if (["annual", "sick", "bereavement", "family_violence", "alternative"].includes(line.leaveType) && line.from && line.to) {
      for (const date of eachDay(line.from, line.to)) paidLeave.add(date);
    }
  }
  const unpaid = new Set<string>();
  for (const leave of facts.unpaid) for (const date of eachDay(leave.start, leave.end)) unpaid.add(date);
  let count = 0;
  for (const period of facts.periods) {
    for (const date of eachDay(laterOf(period.periodStart, from), period.periodEnd < to ? period.periodEnd : to)) {
      if (date < facts.startDate || (facts.finishDate && date > facts.finishDate)) continue;
      const monday = addDays(date, -weekdayIndex(date));
      if (facts.timesheetWeeks.has(monday)) {
        if (isPositive(dec(facts.timesheetHours.get(date) ?? "0")) || paidLeave.has(date)) count += 1;
        continue;
      }
      const settings = settingsOn(facts, date);
      if (!settings || settings.pattern.kind !== "fixed") {
        throw new ValidationError(
          `${NOT_SUPPORTED}: average daily pay for ${facts.name}, whose hours vary, without approved timesheets for ${formatDate(period.periodStart)} to ${formatDate(period.periodEnd)} (the days worked aren't known).`,
        );
      }
      if (isPositive(usualHoursOn(settings.pattern, date)) && !unpaid.has(date)) count += 1;
    }
  }
  return count;
}

/** Gross earnings from `from` to `to` (s 23, s 25), from approved pay runs. */
export function grossEarningsBetween(facts: EmployeeFacts, from: string, to: string): Decimal {
  return earningsBetween(facts.periods, from, to, dayWeight(facts)).gross;
}

/** The dates each 4 weeks' annual holidays arose, to `until` (s 16; decision 14). */
export function annualDates(facts: EmployeeFacts, until: string): string[] {
  return annualEntitlementDates(facts.startDate, facts.unpaid, until);
}

/** A leave line's quantity: its hours over its unit hours (decision 8). */
export function lineQuantity(line: Pick<LeaveLine, "hours" | "unitHours">): LeaveQuantity {
  if (!line.hours || !line.unitHours) return NO_LEAVE;
  return leaveHours(line.hours, line.unitHours);
}

function lineDate(line: LeaveLine): string {
  return line.from ?? line.holidayDate ?? line.payDate ?? "9999-12-31";
}

/** The usual week's hours on a date, for entitlements (4 weeks in that week's hours). */
function weekHoursOn(facts: EmployeeFacts, date: string): string {
  const settings = settingsOn(facts, date) ?? facts.settings.at(-1);
  if (!settings) throw new ValidationError(`${facts.name} has no usual week. Set it under Employees › Leave.`);
  return toPlainString(weekHours(settings.pattern));
}

export type AnnualBalance = {
  balance: LeaveQuantity;
  /** The part of the balance that's an entitlement (not in advance): the balance when positive. */
  entitlementDates: string[];
  lastEntitled: string | null;
  nextEntitled: string;
  cashedUpThisYear: Decimal;
  entitlementYear: { from: string; to: string } | null;
  events: Array<{ date: string; kind: "entitled" | "taken" | "cashed_up" | "paid_out"; quantity: LeaveQuantity; line: LeaveLine | null }>;
};

/**
 * Annual holidays at a date (s 16; HL10-HL13, HL42): 4 weeks at each
 * anniversary less what's been taken, cashed up or paid out, from approved
 * pay runs and any `extra` lines (a draft's), all exact. Leave taken on a
 * date counts on that date.
 */
export function annualBalance(facts: EmployeeFacts, on: string, extra: readonly LeaveLine[] = []): AnnualBalance {
  const dates = annualDates(facts, on);
  const events: AnnualBalance["events"] = dates.map((date) => ({ date, kind: "entitled", quantity: annualEntitlement(weekHoursOn(facts, date)), line: null }));
  for (const line of [...facts.lines, ...extra]) {
    if (line.leaveType === "annual" && lineDate(line) <= on) events.push({ date: lineDate(line), kind: "taken", quantity: lineQuantity(line), line });
    if (line.leaveType === "cash_up" && lineDate(line) <= on) events.push({ date: lineDate(line), kind: "cashed_up", quantity: lineQuantity(line), line });
    if (line.leaveType === "termination" && line.basis.part === "untaken_entitlement" && lineDate(line) <= on) {
      events.push({ date: lineDate(line), kind: "paid_out", quantity: lineQuantity(line), line });
    }
  }
  events.sort((a, b) => (a.date === b.date ? (a.kind === "entitled" ? -1 : b.kind === "entitled" ? 1 : 0) : a.date < b.date ? -1 : 1));
  let balance: LeaveQuantity = NO_LEAVE;
  for (const event of events) balance = event.kind === "entitled" ? addLeave(balance, event.quantity) : subtractLeave(balance, event.quantity);
  const year = entitlementYear(dates, on);
  let cashedUp = ZERO_DECIMAL;
  if (year) {
    for (const event of events) {
      if (event.kind === "cashed_up" && event.date >= year.from && event.date <= year.to) cashedUp = add(cashedUp, dec(event.line?.units ?? "0"));
    }
  }
  const last = dates.at(-1) ?? null;
  const next = annualEntitlementDates(facts.startDate, facts.unpaid, addMonths(on, 25)).find((date) => date > on) ?? addMonths(on, 12);
  return { balance, entitlementDates: dates, lastEntitled: last, nextEntitled: next, cashedUpThisYear: cashedUp, entitlementYear: year, events };
}

/**
 * When sick, bereavement and family violence leave arise (s 63, s 72D;
 * HL20, HL21): 6 months after the start and each 12 months, or for a casual
 * at the end of the first 6 months meeting the hours test from approved
 * timesheets, and each 12 months while it's still met (decision 145).
 */
export function sickDates(facts: EmployeeFacts, until: string): string[] {
  const settings = facts.settings.at(-1);
  if (!settings || settings.employmentType === "continuous") return sickEntitlementDates(facts.startDate, until);
  const hours = Object.fromEntries(facts.timesheetHours);
  const dates: string[] = [];
  let from = facts.startDate;
  // The first 6 months that meet the test, sliding a day at a time.
  for (let guard = 0; guard < 3660; guard += 1) {
    const end = addMonths(from, 6);
    if (end > until) return dates;
    if (hoursTestMet(hours, from).met) {
      dates.push(end);
      break;
    }
    from = addDays(from, 1);
  }
  for (let next = addMonths(dates[0], 12); next <= until; next = addMonths(next, 12)) {
    if (!hoursTestMet(hours, addMonths(next, -6)).met) break;
    dates.push(next);
  }
  return dates;
}

export type DayLeaveBalance = { balance: LeaveQuantity; entitlementDates: string[]; events: DayLeaveEvent[] };

/** Sick leave (HL22) or family violence leave (HL27) at a date, from approved pay runs and `extra` lines. */
export function dayLeaveBalanceOf(facts: EmployeeFacts, type: "sick" | "family_violence", on: string, extra: readonly LeaveLine[] = []): DayLeaveBalance {
  const dates = sickDates(facts, on);
  const taken = [...facts.lines, ...extra].filter((line) => line.leaveType === type).map((line) => ({ date: lineDate(line), quantity: lineQuantity(line) }));
  const result = type === "sick" ? sickLeaveBalance(dates, taken, on) : familyViolenceLeaveBalance(dates, taken, on);
  return { ...result, entitlementDates: dates };
}

export type AlternativeHoliday = {
  arose: string;
  payRunReference: string | null;
  status: "untaken" | "taken" | "exchanged" | "paid_on_finishing";
  on: string | null;
};

/**
 * Alternative holidays (s 56-s 61; HL33): one for each public holiday
 * worked that would otherwise have been a working day, taken, exchanged or
 * paid out oldest first (decision 147).
 */
export function alternativeHolidays(facts: EmployeeFacts, on: string, extra: readonly LeaveLine[] = []): AlternativeHoliday[] {
  const all = [...facts.lines, ...extra];
  const holidays: AlternativeHoliday[] = all
    .filter((line) => line.leaveType === "public_holiday_worked" && line.basis.alternativeHoliday === true && line.holidayDate && line.holidayDate <= on)
    .map((line) => ({ arose: line.holidayDate!, payRunReference: line.reference, status: "untaken" as const, on: null }))
    .sort((a, b) => (a.arose < b.arose ? -1 : 1));
  const uses = all
    .filter((line) => ["alternative", "exchange"].includes(line.leaveType) || (line.leaveType === "termination" && line.basis.part === "alternative_holidays"))
    .map((line) => ({ line, date: lineDate(line) }))
    .filter((use) => use.date <= on)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const use of uses) {
    const wanted = typeof use.line.basis.arose === "string" ? use.line.basis.arose : null;
    const holiday = holidays.find((each) => each.status === "untaken" && (wanted === null || each.arose === wanted));
    if (!holiday) continue;
    holiday.status = use.line.leaveType === "alternative" ? "taken" : use.line.leaveType === "exchange" ? "exchanged" : "paid_on_finishing";
    holiday.on = use.date;
  }
  return holidays;
}

/** The running 8% since the last anniversary (HL42; decision 28): what would be owed under s 25 or s 23 for the part year. */
export function runningEightPercent(facts: EmployeeFacts, on: string, recordsStart: string | null): { since: string; gross: Decimal; amount: string } | { since: string; problem: string } {
  const dates = annualDates(facts, on);
  const since = dates.at(-1) ?? facts.startDate;
  try {
    assertEarningsKnown(facts, since, laterOf(since, lastApprovedEnd(facts) ?? since), recordsStart, "The running 8%");
  } catch (error) {
    if (error instanceof ValidationError) return { since, problem: error.message };
    throw error;
  }
  const gross = grossEarningsBetween(facts, since, on);
  return { since, gross, amount: toFixedString(mul(gross, dec("0.08")), 2) };
}

export function lastApprovedEnd(facts: EmployeeFacts): string | null {
  return facts.periods.reduce<string | null>((latest, period) => (!latest || period.periodEnd > latest ? period.periodEnd : latest), null);
}

/** Leave taken but not yet covered by an entitlement: holiday pay in advance since the last anniversary (s 23(2)(a), s 25(2)(a)). */
export function advancePaidSince(facts: EmployeeFacts, since: string, extra: readonly LeaveLine[] = []): Decimal {
  return [...facts.lines, ...extra]
    .filter((line) => line.leaveType === "annual" && line.inAdvance && lineDate(line) >= since)
    .reduce((total, line) => add(total, dec(line.amount)), ZERO_DECIMAL);
}
