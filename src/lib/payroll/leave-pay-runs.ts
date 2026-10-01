import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { formatDate, formatMoney } from "@/lib/format";
import { add, cmp, dec, type Decimal, divide, isPositive, isZero, mul, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import type { PayFrequency } from "@/lib/payroll/groups";
import { annualHolidayPay, checkCashUp, earnedTowardsNext, terminationHolidayPay } from "@/lib/payroll/leave/annual";
import { addDays, eachDay, earlierOf, laterOf } from "@/lib/payroll/leave/dates";
import { payment } from "@/lib/payroll/leave/earnings";
import { holidaysInUntakenLeave, type ObservedHoliday, observedHolidays, publicHolidayWorkedPay, suggestOtherwiseWorkingDay } from "@/lib/payroll/leave/public-holidays";
import type { AnniversaryRegion } from "@/lib/payroll/leave/public-holiday-dates";
import { compareLeave, hoursAt, type LeaveQuantity, leaveHours, signOfLeave, unitsOf } from "@/lib/payroll/leave/quantity";
import { EMPLOYMENT_LEAVE_ACT_STARTS, NOT_SUPPORTED } from "@/lib/payroll/leave/rules";
import { BEREAVEMENT_DAYS, type BereavementKind, dayLeaveTaken, partDaySickPay } from "@/lib/payroll/leave/sick";
import {
  isUsualWorkingDay,
  patternDayHours,
  payForTimeWorked as payForTime,
  relevantDailyPay,
  usualHoursOn,
  weekHours,
  type WorkPattern,
} from "@/lib/payroll/leave/work-pattern";
import {
  advancePaidSince,
  alternativeHolidays,
  annualBalance,
  annualDates,
  assertEarningsKnown,
  dailyRateOn,
  dayLeaveBalanceOf,
  type EmployeeFacts,
  grossEarningsBetween,
  lastApprovedEnd,
  type LeaveLine,
  type LeaveLineType,
  loadEmployeeFacts,
  rateOn,
  recordsStartWith,
  settingsOn,
  weeklyRateOn,
  whyLeaveNotKept,
} from "@/lib/payroll/leave-facts";
import { leaveSettingsOn, type LeaveSettings, settingsChangeInside } from "@/lib/payroll/leave-settings";
import { lineAmount, salaryForPeriod } from "@/lib/payroll/pay-calculation";
import type { PayItemKind } from "@/lib/payroll/pay-items";
import { payRunReference } from "@/lib/payroll/pay-run-reference";

/**
 * Leave on a draft pay run (payroll stage P8; decisions 141, 148-150):
 * for an employee whose leave Tohyee keeps, the draft's usual pay is made
 * from their usual week, and leave lines are worked out from their leave
 * bookings, the public holidays in the period (with the decisions recorded
 * for them), agreed cash-ups and exchanges, and on a final pay their
 * holiday pay on finishing. Worked out when the draft is made and again
 * whenever something it depends on changes ("Update leave"); approving
 * works it out again and refuses if it changed. Callers check payroll
 * access.
 */

export type DraftRun = { id: string; run_number: string; period_start: string; period_end: string; pay_frequency: PayFrequency; status: string };

/** A line Tohyee works out: usual pay or leave. */
export type WorkedLine = {
  kind: PayItemKind;
  /** For usual pay's overtime and allowances: their own pay item. */
  payItemId: string | null;
  source: "usual_pay" | "leave";
  quantity: string | null;
  rate: string | null;
  amount: string;
  description: string;
  regular: boolean | null;
  leave: LeaveLine | null;
};

export type LeaveWorkResult = {
  /** Null when the usual pay isn't Tohyee's to change (hours that vary, or typed by hand). */
  usualPay: WorkedLine[] | null;
  leave: WorkedLine[];
  problem: string | null;
  notes: string[];
  kept: boolean;
};

type Booking = {
  id: string;
  booking_number: string;
  leave_type: "annual" | "sick" | "bereavement" | "family_violence" | "alternative";
  start_date: string;
  end_date: string;
  day_hours: Record<string, string> | null;
  hours_worked: string | null;
  bereavement_kind: BereavementKind | null;
  in_advance_agreed: boolean;
};

type Decision = {
  holiday_date: string;
  otherwise_working: boolean;
  hours_worked: string | null;
  penal_hourly_rate: string | null;
  extra_amount: string | null;
  suggestion: string | null;
};

const LEAVE_KIND: Record<string, PayItemKind> = {
  annual: "annual_leave",
  sick: "sick_leave",
  bereavement: "bereavement_leave",
  family_violence: "family_violence_leave",
  alternative: "alternative_holiday",
  public_holiday: "public_holiday",
  public_holiday_worked: "public_holiday_worked",
  cash_up: "annual_leave_cash_up",
  exchange: "alternative_holiday_payout",
  termination: "termination_holiday_pay",
};

const DAY_LEAVE_LABEL: Record<string, string> = {
  sick: "Sick leave",
  bereavement: "Bereavement leave",
  family_violence: "Special leave",
  alternative: "Alternative holiday",
};

function leaveLine(fields: Partial<LeaveLine> & { leaveType: LeaveLineType; amount: string }): LeaveLine {
  return {
    payRunId: null,
    reference: null,
    payDate: null,
    bookingId: null,
    from: null,
    to: null,
    hours: null,
    unitHours: null,
    units: null,
    inAdvance: false,
    holidayDate: null,
    cashUpId: null,
    exchangeId: null,
    description: null,
    basis: {},
    ...fields,
  };
}

function worked(line: LeaveLine, description: string): WorkedLine {
  return {
    kind: LEAVE_KIND[line.leaveType],
    payItemId: null,
    source: "leave",
    quantity: null,
    rate: null,
    amount: line.amount,
    description: description.slice(0, 200),
    regular: null,
    leave: { ...line, description: description.slice(0, 200) },
  };
}

const hoursText = (value: Decimal | string) => {
  const text = toFixedString(typeof value === "string" ? dec(value) : value, 4).replace(/0+$/, "").replace(/\.$/, "");
  return text === "" ? "0" : text;
};
const fixed = (value: Decimal, places = 8) => toFixedString(value, places);

/**
 * Works out an employee's usual pay and leave on a draft (decisions 141,
 * 148-150). Throws nothing for leave problems: they come back as `problem`,
 * which stops the pay run being approved until fixed.
 */
export async function workOutLeave(tx: OrgTx, run: DraftRun, employeeId: string): Promise<LeaveWorkResult> {
  const notes: string[] = [];
  const settingsRows = await tx.query<{ effective_from: string }>(
    "select effective_from::text from payroll_leave_settings where employee_id::text = $1 limit 1",
    [employeeId],
  );
  const pending = await pendingLeave(tx, run, employeeId);
  if (settingsRows.rows.length === 0) {
    return {
      usualPay: null,
      leave: [],
      problem: pending ? `${pending} is booked, but Tohyee doesn't keep this employee's leave: set their usual week under Employees › Leave first.` : null,
      notes,
      kept: false,
    };
  }
  const settingsList = await allSettings(tx, employeeId);
  const facts = await loadEmployeeFacts(tx, employeeId, settingsList);
  const recordsStart = recordsStartWith(facts, run.period_start);
  const notKept = whyLeaveNotKept(facts, recordsStart);
  if (notKept) {
    return { usualPay: null, leave: [], problem: pending ? `${pending} is booked, but ${notKept.replace(/\.$/, "")}.` : null, notes: [notKept], kept: false };
  }
  try {
    return await workOutKept(tx, run, facts, recordsStart, notes);
  } catch (error) {
    if (error instanceof ValidationError) return { usualPay: null, leave: [], problem: error.message, notes, kept: true };
    throw error;
  }
}

async function allSettings(tx: OrgTx, employeeId: string): Promise<LeaveSettings[]> {
  const dates = await tx.query<{ effective_from: string }>(
    "select distinct effective_from::text from payroll_leave_settings where employee_id::text = $1 order by effective_from desc",
    [employeeId],
  );
  const list: LeaveSettings[] = [];
  for (const row of dates.rows) {
    const settings = await leaveSettingsOn(tx, employeeId, row.effective_from);
    if (settings) list.push(settings);
  }
  return list;
}

/** A short description of leave waiting to be paid in the period, or null. */
async function pendingLeave(tx: OrgTx, run: DraftRun, employeeId: string): Promise<string | null> {
  const bookings = await tx.query<{ booking_number: string }>(
    `select booking_number::text from payroll_leave_bookings
      where employee_id::text = $1 and status = 'booked' and start_date <= $3 and end_date >= $2 order by start_date limit 1`,
    [employeeId, run.period_start, run.period_end],
  );
  if (bookings.rows[0]) return `Leave booking LEAVE-${bookings.rows[0].booking_number}`;
  const cashUps = await tx.query<{ cash_up_number: string }>(
    `select c.cash_up_number::text from payroll_cash_ups c
      where c.employee_id::text = $1 and c.status = 'agreed' and c.agreed_on <= $2
        and not exists (select 1 from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id
                         where l.cash_up_id = c.id and r.status = 'approved') limit 1`,
    [employeeId, run.period_end],
  );
  return cashUps.rows[0] ? `Cash-up CASHUP-${cashUps.rows[0].cash_up_number}` : null;
}

async function workOutKept(tx: OrgTx, run: DraftRun, facts: EmployeeFacts, recordsStart: string | null, notes: string[]): Promise<LeaveWorkResult> {
  const name = facts.name;
  if (run.period_start >= EMPLOYMENT_LEAVE_ACT_STARTS) {
    throw new ValidationError(
      `${NOT_SUPPORTED}: leave for ${name} in a pay period starting on or after 6 Aug 2028, under the Employment Leave Act 2026. Tohyee follows the Holidays Act 2003 until then (decision 7).`,
    );
  }
  const from = laterOf(run.period_start, facts.startDate);
  const to = facts.finishDate ? earlierOf(run.period_end, facts.finishDate) : run.period_end;
  const change = await settingsChangeInside(tx, facts.id, from, to);
  if (change) throw new ValidationError(`${NOT_SUPPORTED}: leave settings that change part-way through a pay period (${name}'s change on ${formatDate(change)}).`);
  const settings = settingsOn(facts, from);
  if (!settings) throw new ValidationError(`${name} has no usual week on ${formatDate(from)}. Set it under Employees › Leave.`);
  const pattern = settings.pattern;
  const region = (settings.anniversaryRegion ?? facts.organisationRegion) as AnniversaryRegion | null;
  if (!region) throw new ValidationError(`Choose the organisation's anniversary day under Payroll › Leave (or ${name}'s own under Employees › Leave): Tohyee needs it for public holidays.`);
  const rate = await rateOn(tx, facts, from);
  const extra: LeaveLine[] = [];
  const leave: WorkedLine[] = [];
  const problems: string[] = [];
  const anchor = run.period_start;

  // Public holidays (s 44-s 50; decisions 21-23).
  const decisions = new Map(
    (
      await tx.query<Decision>(
        `select holiday_date::text, otherwise_working, hours_worked::text, penal_hourly_rate::text, extra_amount::text, suggestion
           from payroll_public_holiday_decisions where employee_id::text = $1 and status = 'current' and holiday_date between $2 and $3`,
        [facts.id, addDays(run.period_start, -3), run.period_end],
      )
    ).rows.map((row) => [row.holiday_date, row]),
  );
  const timesheetHoursOn = (date: string): string | null => {
    const monday = addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
    return facts.timesheetWeeks.has(monday) ? (facts.timesheetHours.get(date) ?? "0") : null;
  };
  const wouldWork = (date: string): boolean | null => {
    const decision = decisions.get(date);
    if (decision) return decision.otherwise_working;
    return pattern.kind === "fixed" ? isUsualWorkingDay(pattern, date) : null;
  };
  const { holidays, uncertain } = observedHolidays({ from, to, region, wouldWork });
  const holidayDays = new Map<string, { holiday: ObservedHoliday; otherwiseWorking: boolean; hoursWorked: Decimal }>();
  for (const holiday of uncertain) {
    const suggestion = suggestOtherwiseWorkingDay(holiday.date, Object.fromEntries(facts.timesheetHours));
    problems.push(
      `Confirm whether ${holiday.name} on ${formatDate(holiday.date)} would otherwise have been a working day for ${name} (Tohyee suggests ${suggestion.suggested ? "yes" : "no"}: ${suggestion.basis}).`,
    );
  }
  for (const holiday of holidays) {
    const decision = decisions.get(holiday.date);
    const fromTimesheet = timesheetHoursOn(holiday.date);
    let otherwiseWorking = decision ? decision.otherwise_working : pattern.kind === "fixed" ? isUsualWorkingDay(pattern, holiday.date) : null;
    if (otherwiseWorking === null) {
      const suggestion = suggestOtherwiseWorkingDay(holiday.date, Object.fromEntries(facts.timesheetHours));
      problems.push(
        `Confirm whether ${holiday.name} on ${formatDate(holiday.date)} would otherwise have been a working day for ${name} (Tohyee suggests ${suggestion.suggested ? "yes" : "no"}: ${suggestion.basis}).`,
      );
      otherwiseWorking = false;
      continue;
    }
    const hoursWorked = dec(decision?.hours_worked ?? fromTimesheet ?? "0");
    holidayDays.set(holiday.date, { holiday, otherwiseWorking, hoursWorked });
    if (isPositive(hoursWorked)) {
      const forTime = payForTime(pattern, rate, holiday.date, toPlainString(hoursWorked));
      const pay = publicHolidayWorkedPay({ payForTime: forTime, hoursWorked: toPlainString(hoursWorked), penalHourlyRate: decision?.penal_hourly_rate ?? null });
      const line = leaveLine({
        leaveType: "public_holiday_worked",
        holidayDate: holiday.date,
        from: holiday.date,
        to: holiday.date,
        hours: toPlainString(hoursWorked),
        unitHours: toPlainString(hoursWorked),
        amount: payment(pay.amount),
        basis: {
          section: "s 50",
          holiday: holiday.name,
          hoursWorked: toPlainString(hoursWorked),
          payForTimeWorked: fixed(forTime, 6),
          timeAndAHalf: fixed(pay.timeAndAHalf, 6),
          withPenalRate: fixed(pay.withPenal, 6),
          penalHourlyRate: decision?.penal_hourly_rate ?? null,
          otherwiseWorkingDay: otherwiseWorking,
          alternativeHoliday: otherwiseWorking,
          hoursFrom: decision?.hours_worked ? "decision" : "approved timesheets",
        },
      });
      extra.push(line);
      leave.push(worked(line, `${holiday.name}, ${formatDate(holiday.date)}: worked ${hoursText(hoursWorked)} h${otherwiseWorking ? "; alternative holiday" : ""}`));
      if (decision?.extra_amount) {
        const typed = leaveLine({ leaveType: "public_holiday_worked", holidayDate: holiday.date, amount: toFixedString(dec(decision.extra_amount), 2), basis: { section: "agreement", typed: true } });
        extra.push(typed);
        leave.push(worked(typed, `${holiday.name}, ${formatDate(holiday.date)}: extra under the employment agreement`));
      }
    } else if (otherwiseWorking) {
      const daily = await dailyRateOn(tx, facts, { date: holiday.date, anchorPeriodStart: anchor, recordsStart, what: "Pay for a public holiday" });
      if (!daily) {
        problems.push(
          `${NOT_SUPPORTED}: relevant daily pay for ${holiday.name} for ${name}, whose hours vary (set them to average daily pay, decision 13, or record the hours worked).`,
        );
        continue;
      }
      const usual = pattern.kind === "fixed" ? usualHoursOn(pattern, holiday.date) : ZERO_DECIMAL;
      const line = leaveLine({
        leaveType: "public_holiday",
        holidayDate: holiday.date,
        from: holiday.date,
        to: holiday.date,
        hours: isPositive(usual) ? toPlainString(usual) : null,
        unitHours: isPositive(usual) ? toPlainString(usual) : null,
        amount: payment(daily.rate),
        basis: { section: "s 49", holiday: holiday.name, method: daily.method, rate: fixed(daily.rate, 6), ...daily.basis },
      });
      extra.push(line);
      leave.push(worked(line, `${holiday.name}, ${formatDate(holiday.date)} (${daily.method === "adp" ? "average" : "relevant"} daily pay)`));
    }
  }

  // Leave bookings: sick, bereavement and family violence leave over annual holidays (s 36-s 38),
  // public holidays over all of them (s 40(1), s 61A).
  const bookings = (
    await tx.query<Booking>(
      `select id::text, booking_number::text, leave_type, start_date::text, end_date::text, day_hours, hours_worked::text, bereavement_kind,
              in_advance_agreed
         from payroll_leave_bookings
        where employee_id::text = $1 and status = 'booked' and start_date <= $3 and end_date >= $2
        order by start_date, booking_number`,
      [facts.id, from, to],
    )
  ).rows;
  const tier = (type: Booking["leave_type"]) => (type === "annual" ? 2 : type === "alternative" ? 1 : 0);
  const dayOwner = new Map<string, Booking>();
  for (const booking of [...bookings].sort((a, b) => tier(a.leave_type) - tier(b.leave_type))) {
    for (const date of eachDay(laterOf(booking.start_date, from), earlierOf(booking.end_date, to))) {
      const owner = dayOwner.get(date);
      if (owner && tier(owner.leave_type) === tier(booking.leave_type)) {
        problems.push(`LEAVE-${owner.booking_number} and LEAVE-${booking.booking_number} are both booked for ${name} on ${formatDate(date)}. Cancel one.`);
        continue;
      }
      if (!owner) dayOwner.set(date, booking);
    }
  }
  const dayHoursFor = (booking: Booking, date: string): Decimal => {
    if (pattern.kind === "fixed") return usualHoursOn(pattern, date);
    return dec(booking.day_hours?.[date] ?? "0");
  };
  const partDays = new Map<string, Decimal>();
  for (const booking of bookings) {
    const days = eachDay(laterOf(booking.start_date, from), earlierOf(booking.end_date, to)).filter((date) => {
      if (dayOwner.get(date)?.id !== booking.id) return false;
      const holiday = holidayDays.get(date);
      if (holiday && holiday.otherwiseWorking) return false;
      return isPositive(dayHoursFor(booking, date));
    });
    if (days.length === 0) continue;
    const label = `LEAVE-${booking.booking_number}`;
    if (booking.leave_type === "annual") {
      if (!(settingsOn(facts, booking.start_date) ?? facts.settings.at(-1))!.annualPaidInPeriod) {
        problems.push(
          `${NOT_SUPPORTED}: paying ${name}'s annual holidays (${label}) before they're taken (s 27(1)). Record in their leave settings that annual holidays are paid in the pay for the period they're taken (s 27(1)(a)).`,
        );
        continue;
      }
      const weekly = toPlainString(weekHours(pattern));
      let entitledHours = ZERO_DECIMAL;
      let advanceHours = ZERO_DECIMAL;
      for (const date of days) {
        const hours = dayHoursFor(booking, date);
        const balance = annualBalance(facts, date, extra).balance;
        const available = signOfLeave(balance) > 0 ? hoursAt(balance, weekly, 8) : ZERO_DECIMAL;
        const fromEntitlement = cmp(available, hours) >= 0 ? hours : available;
        entitledHours = add(entitledHours, fromEntitlement);
        advanceHours = add(advanceHours, sub(hours, fromEntitlement));
        extra.push(leaveLine({ leaveType: "annual", from: date, to: date, hours: toPlainString(hours), unitHours: weekly, amount: "0", basis: { provisional: true } }));
      }
      // The provisional day entries only fed the balance; replace them with the lines below.
      extra.splice(extra.length - days.length, days.length);
      for (const [part, hours] of [
        ["entitled", entitledHours],
        ["advance", advanceHours],
      ] as const) {
        if (!isPositive(hours)) continue;
        const inAdvance = part === "advance";
        const weeklyRate = await weeklyRateOn(tx, facts, { date: booking.start_date, anchorPeriodStart: anchor, recordsStart, inAdvance, what: "Pay for annual holidays" });
        const pay = annualHolidayPay({ hours, weekHours: weekly, weeklyRate: weeklyRate.rate });
        const line = leaveLine({
          leaveType: "annual",
          bookingId: booking.id,
          from: days[0],
          to: days.at(-1)!,
          hours: toPlainString(hours),
          unitHours: weekly,
          units: fixed(pay.weeks),
          inAdvance,
          amount: pay.amount,
          basis: {
            section: inAdvance ? "s 22" : "s 21",
            holidayStarts: booking.start_date,
            weeks: fixed(pay.weeks),
            weeklyRate: fixed(weeklyRate.rate, 6),
            rateUsed: weeklyRate.source,
            ordinaryWeeklyPay: fixed(weeklyRate.owp, 6),
            ordinaryWeeklyPayMethod: weeklyRate.owpMethod,
            fourWeekOrdinaryPay: weeklyRate.fourWeek ? fixed(weeklyRate.fourWeek, 6) : null,
            averageWeeklyEarnings: fixed(weeklyRate.awe, 6),
            averageWeeklyEarningsFrom: weeklyRate.aweFrom,
            averageWeeklyEarningsTo: weeklyRate.aweTo,
            grossEarnings: fixed(weeklyRate.aweGross, 6),
            divisor: toPlainString(weeklyRate.aweDivisor),
          },
        });
        extra.push(line);
        leave.push(
          worked(
            line,
            `Annual holidays ${formatDate(line.from)} to ${formatDate(line.to)}, ${hoursText(hours)} h = ${hoursText(pay.weeks)} weeks at $${formatMoney(fixed(weeklyRate.rate, 2))}${inAdvance ? " (in advance)" : ""}`,
          ),
        );
        if (inAdvance) {
          const since = annualDates(facts, booking.start_date).at(-1) ?? facts.startDate;
          const earned = earnedTowardsNext(since, booking.start_date);
          const after = unitsOf(annualBalance(facts, line.to!, extra).balance, 8);
          const owing = cmp(after, ZERO_DECIMAL) < 0 ? mul(after, dec("-1")) : ZERO_DECIMAL;
          notes.push(
            `${name}'s annual holidays ${label} include ${hoursText(pay.weeks)} weeks in advance (s 20). Keep the written agreement to recover it if they leave (decision 15).${
              cmp(owing, earned) > 0 ? ` That takes them ${toFixedString(owing, 2)} weeks below 0, more than the ${toFixedString(earned, 2)} weeks earned since ${formatDate(since)}.` : ""
            }`,
          );
        }
      }
      continue;
    }
    for (const date of days) {
      const dayHours = dayHoursFor(booking, date);
      const settingsThen = settingsOn(facts, date)!;
      const partWorked = booking.hours_worked ? dec(booking.hours_worked) : null;
      if (partWorked && cmp(partWorked, dayHours) >= 0) {
        problems.push(`${label}: ${name} worked ${hoursText(partWorked)} of ${hoursText(dayHours)} usual hours on ${formatDate(date)}, so there's no part day to take.`);
        continue;
      }
      const daily = await dailyRateOn(tx, facts, { date, anchorPeriodStart: anchor, recordsStart, dayHours: toPlainString(dayHours), what: `Pay for ${DAY_LEAVE_LABEL[booking.leave_type].toLowerCase()}` });
      if (!daily) {
        problems.push(`${NOT_SUPPORTED}: relevant daily pay for ${label} on ${formatDate(date)} for ${name}.`);
        continue;
      }
      let quantity: LeaveQuantity;
      let amount: Decimal;
      const unitHours = toPlainString(dayHours);
      let hours = toPlainString(dayHours);
      if (partWorked) {
        partDays.set(date, partWorked);
        const off = sub(dayHours, partWorked);
        quantity = dayLeaveTaken({ hoursOff: toPlainString(off), dayHours: unitHours, partDayAgreed: settingsThen.partDaySickAgreed });
        hours = settingsThen.partDaySickAgreed ? toPlainString(off) : unitHours;
        amount =
          daily.method === "rdp" && pattern.kind === "fixed"
            ? partDaySickPay(daily.rate, payForTime(pattern, rate, date, toPlainString(partWorked)))
            : divide(mul(daily.rate, off), dayHours, 10);
      } else {
        quantity = leaveHours(dayHours, dayHours);
        amount = daily.rate;
      }
      if (booking.leave_type === "alternative") {
        const holiday = holidayDays.get(date);
        if (holiday) {
          problems.push(`${label}: an alternative holiday can't be taken on a public holiday (${holiday.holiday.name}, s 57(1)(d)).`);
          continue;
        }
        const available = alternativeHolidays(facts, date, extra).find((each) => each.status === "untaken");
        if (!available) {
          problems.push(`${label}: ${name} has no alternative holiday to take on ${formatDate(date)}.`);
          continue;
        }
        const line = leaveLine({
          leaveType: "alternative",
          bookingId: booking.id,
          from: date,
          to: date,
          hours,
          unitHours,
          units: fixed(unitsOf(quantity)),
          amount: payment(amount),
          basis: { section: "s 60(1)", arose: available.arose, method: daily.method, rate: fixed(daily.rate, 6), ...daily.basis },
        });
        extra.push(line);
        leave.push(worked(line, `Alternative holiday (arose ${formatDate(available.arose)}) taken ${formatDate(date)}`));
        continue;
      }
      if (booking.leave_type === "bereavement") {
        const allowed = BEREAVEMENT_DAYS[booking.bereavement_kind ?? "other"];
        const earlier = (await approvedBookingDays(tx, run, booking, date)) + extra.filter((line) => line.bookingId === booking.id).length;
        if (earlier >= allowed) {
          problems.push(`${label}: ${allowed} day${allowed === 1 ? "" : "s"} of bereavement leave for this bereavement are already used (s 70(1)).`);
          continue;
        }
      }
      if (booking.leave_type !== "bereavement") {
        const type = booking.leave_type === "family_violence" ? "family_violence" : "sick";
        const balance = dayLeaveBalanceOf(facts, type, date, extra);
        if (!booking.in_advance_agreed && compareLeave(quantity, balance.balance) > 0) {
          problems.push(
            balance.entitlementDates.length === 0
              ? `${label}: ${name} isn't entitled to ${DAY_LEAVE_LABEL[type].toLowerCase()} yet on ${formatDate(date)} (6 months' employment, s 63). Record on the booking that leave in advance was agreed (s 63(3)), or cancel it.`
              : `${label}: ${name} has ${toFixedString(unitsOf(balance.balance), 2)} days of ${type === "sick" ? "sick" : "family violence"} leave left on ${formatDate(date)}. Record on the booking that leave in advance was agreed, shorten it, or cancel it.`,
          );
          continue;
        }
      } else {
        const entitled = dayLeaveBalanceOf(facts, "sick", date, extra).entitlementDates.length > 0;
        if (!entitled && !booking.in_advance_agreed) {
          problems.push(`${label}: ${name} isn't entitled to bereavement leave yet on ${formatDate(date)} (6 months' employment, s 63). Record that leave in advance was agreed (s 63(3)), or cancel it.`);
          continue;
        }
      }
      const type = booking.leave_type;
      const line = leaveLine({
        leaveType: type,
        bookingId: booking.id,
        from: date,
        to: date,
        hours,
        unitHours,
        units: fixed(unitsOf(quantity)),
        amount: payment(amount),
        basis: {
          section: type === "family_violence" ? "s 72I" : "s 71",
          method: daily.method,
          rate: fixed(daily.rate, 6),
          partDayHoursWorked: partWorked ? toPlainString(partWorked) : null,
          bereavementKind: booking.bereavement_kind,
          ...daily.basis,
        },
      });
      extra.push(line);
      leave.push(
        worked(
          line,
          `${DAY_LEAVE_LABEL[type]} ${formatDate(date)}${partWorked ? `, part day (${hoursText(partWorked)} h worked)` : ""}, ${toFixedString(unitsOf(quantity), 2).replace(/\.00$/, "")} day`,
        ),
      );
    }
  }

  // Cash-ups agreed and not paid yet (s 28B; decision 29).
  const cashUps = (
    await tx.query<{ id: string; cash_up_number: string; agreed_on: string; weeks: string; hours: string; week_hours: string }>(
      `select c.id::text, c.cash_up_number::text, c.agreed_on::text, c.weeks::text, c.hours::text, c.week_hours::text from payroll_cash_ups c
        where c.employee_id::text = $1 and c.status = 'agreed' and c.agreed_on <= $2
          and not exists (select 1 from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id
                           where l.cash_up_id = c.id and r.status <> 'voided' and r.id::text <> $3)
        order by c.agreed_on, c.cash_up_number`,
      [facts.id, run.period_end, run.id],
    )
  ).rows;
  for (const cashUp of cashUps) {
    const balance = annualBalance(facts, cashUp.agreed_on, extra);
    try {
      checkCashUp({
        weeks: cashUp.weeks,
        cashedUpThisYear: toPlainString(balance.cashedUpThisYear),
        entitledBalance: balance.balance,
        weekHours: cashUp.week_hours,
        noCashUpPolicy: false,
        hasEntitlement: balance.entitlementDates.length > 0,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        problems.push(`CASHUP-${cashUp.cash_up_number}: ${error.message}`);
        continue;
      }
      throw error;
    }
    const weeklyRate = await weeklyRateOn(tx, facts, { date: cashUp.agreed_on, anchorPeriodStart: anchor, recordsStart, inAdvance: false, what: "A cash-up" });
    const pay = annualHolidayPay({ hours: cashUp.hours, weekHours: cashUp.week_hours, weeklyRate: weeklyRate.rate });
    const line = leaveLine({
      leaveType: "cash_up",
      cashUpId: cashUp.id,
      from: cashUp.agreed_on,
      to: cashUp.agreed_on,
      hours: toPlainString(dec(cashUp.hours)),
      unitHours: toPlainString(dec(cashUp.week_hours)),
      units: fixed(dec(cashUp.weeks)),
      amount: pay.amount,
      basis: {
        section: "s 28B",
        weeks: toPlainString(dec(cashUp.weeks)),
        weeklyRate: fixed(weeklyRate.rate, 6),
        rateUsed: weeklyRate.source,
        ordinaryWeeklyPay: fixed(weeklyRate.owp, 6),
        averageWeeklyEarnings: fixed(weeklyRate.awe, 6),
        averageWeeklyEarningsFrom: weeklyRate.aweFrom,
        averageWeeklyEarningsTo: weeklyRate.aweTo,
      },
    });
    extra.push(line);
    leave.push(worked(line, `Annual holidays cashed up (CASHUP-${cashUp.cash_up_number}), ${hoursText(dec(cashUp.weeks))} weeks at $${formatMoney(fixed(weeklyRate.rate, 2))}`));
  }

  // Alternative holidays exchanged for payment (s 61; decision 24).
  const exchanges = (
    await tx.query<{ id: string; arose_on: string; agreed_on: string; amount: string }>(
      `select x.id::text, x.arose_on::text, x.agreed_on::text, x.amount::text from payroll_alternative_exchanges x
        where x.employee_id::text = $1 and x.status = 'agreed' and x.agreed_on <= $2
          and not exists (select 1 from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id
                           where l.exchange_id = x.id and r.status <> 'voided' and r.id::text <> $3)
        order by x.agreed_on`,
      [facts.id, run.period_end, run.id],
    )
  ).rows;
  for (const exchange of exchanges) {
    const untaken = alternativeHolidays(facts, exchange.agreed_on, extra).find((holiday) => holiday.status === "untaken" && holiday.arose === exchange.arose_on);
    if (!untaken) {
      problems.push(`${name}'s alternative holiday that arose on ${formatDate(exchange.arose_on)} has already been taken or paid, so it can't be exchanged.`);
      continue;
    }
    const line = leaveLine({
      leaveType: "exchange",
      exchangeId: exchange.id,
      from: exchange.agreed_on,
      to: exchange.agreed_on,
      amount: toFixedString(dec(exchange.amount), 2),
      basis: { section: "s 61(3)", arose: exchange.arose_on },
    });
    extra.push(line);
    leave.push(worked(line, `Alternative holiday (arose ${formatDate(exchange.arose_on)}) exchanged for payment`));
  }

  // Usual pay from the usual week (decisions 148, 149).
  const usualPay = usualPayLines(run, facts, pattern, rate, from, to, holidayDays, dayOwner, partDays);

  // Holiday pay on finishing (s 23-s 26, s 40(3), s 60(2)(b); decisions 17, 18, 150).
  if (facts.finishDate && facts.finishDate >= run.period_start && facts.finishDate <= run.period_end) {
    const termination = await terminationLines(tx, run, facts, recordsStart, region, extra, usualPay, notes);
    leave.push(...termination);
  }
  return { usualPay, leave, problem: problems.length > 0 ? problems.join(" ") : null, notes, kept: true };
}

/** Days of a booking paid by approved pay runs before `date`. */
async function approvedBookingDays(tx: OrgTx, run: DraftRun, booking: Booking, date: string): Promise<number> {
  const paid = await tx.query<{ count: string }>(
    `select count(*)::text from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id
      where l.leave_booking_id::text = $1 and r.status = 'approved' and r.id::text <> $2 and l.leave_from < $3`,
    [booking.id, run.id, date],
  );
  return Number(paid.rows[0].count);
}

/**
 * The usual pay for the days worked (decisions 148, 149): the usual week's
 * ordinary hours and extras on each day of the period the employee works,
 * leaving out leave, public holidays (paid by their own lines) and the part
 * of a part day not worked. Salaries are the period's salary × the share of
 * the usual ordinary hours worked. Null when hours vary. With approved
 * timesheets covering every day, an hourly employee's ordinary time is the
 * timesheets' hours less public holiday hours (P9; decision 99).
 */
function usualPayLines(
  run: DraftRun,
  facts: EmployeeFacts,
  pattern: WorkPattern,
  rate: { payBasis: "salary" | "hourly"; annualSalary: string | null; hourlyRate: string | null },
  from: string,
  to: string,
  holidayDays: Map<string, { otherwiseWorking: boolean; hoursWorked: Decimal }>,
  dayOwner: Map<string, Booking>,
  partDays: Map<string, Decimal>,
): WorkedLine[] | null {
  if (pattern.kind !== "fixed") return null;
  const days = eachDay(from, to);
  const allMondays = new Set(days.map((date) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7))));
  const coveredByTimesheets = rate.payBasis === "hourly" && days.length > 0 && [...allMondays].every((monday) => facts.timesheetWeeks.has(monday));
  if (coveredByTimesheets) {
    let hours = ZERO_DECIMAL;
    for (const date of days) {
      if (holidayDays.has(date)) continue;
      hours = add(hours, dec(facts.timesheetHours.get(date) ?? "0"));
    }
    return [
      {
        kind: "ordinary_time",
        payItemId: null,
        source: "usual_pay",
        quantity: toFixedString(hours, 2),
        rate: rate.hourlyRate!,
        amount: lineAmount(toFixedString(hours, 2), rate.hourlyRate!),
        description: "From approved timesheets",
        regular: null,
        leave: null,
      },
    ];
  }
  let ordinary = ZERO_DECIMAL;
  let allOrdinary = ZERO_DECIMAL;
  const extras = new Map<string, { kind: "overtime" | "allowance"; name: string; hours: Decimal; multiplier: string | null; amount: Decimal; count: number; regular: boolean }>();
  for (const date of days) {
    const day = pattern.days[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];
    allOrdinary = add(allOrdinary, dec(day.ordinaryHours));
    if (!isPositive(patternDayHours(day))) continue;
    if (holidayDays.has(date)) continue;
    const part = partDays.get(date);
    if (dayOwner.has(date) && !part) continue;
    let available = part ?? patternDayHours(day);
    const ordinaryToday = cmp(available, dec(day.ordinaryHours)) < 0 ? available : dec(day.ordinaryHours);
    ordinary = add(ordinary, ordinaryToday);
    available = sub(available, ordinaryToday);
    for (const extra of day.extras) {
      const entry = extras.get(extra.payItemId) ?? { kind: extra.kind, name: extra.name, hours: ZERO_DECIMAL, multiplier: extra.multiplier, amount: ZERO_DECIMAL, count: 0, regular: extra.regular };
      if (extra.kind === "overtime") {
        const hours = cmp(available, dec(extra.hours ?? "0")) < 0 ? available : dec(extra.hours ?? "0");
        available = sub(available, hours);
        entry.hours = add(entry.hours, hours);
      } else {
        entry.amount = add(entry.amount, dec(extra.amount ?? "0"));
        entry.count += 1;
      }
      extras.set(extra.payItemId, entry);
    }
  }
  const lines: WorkedLine[] = [];
  if (rate.payBasis === "hourly") {
    const hours = toFixedString(ordinary, 2);
    lines.push({
      kind: "ordinary_time",
      payItemId: null,
      source: "usual_pay",
      quantity: hours,
      rate: rate.hourlyRate!,
      amount: lineAmount(hours, rate.hourlyRate!),
      description: "From the usual week",
      regular: null,
      leave: null,
    });
  } else {
    const salary = dec(salaryForPeriod(rate.annualSalary!, run.pay_frequency));
    const amount = isZero(allOrdinary) ? ZERO_DECIMAL : cmp(ordinary, allOrdinary) === 0 ? salary : divide(mul(salary, ordinary), allOrdinary, 2);
    lines.push({
      kind: "ordinary_time",
      payItemId: null,
      source: "usual_pay",
      quantity: null,
      rate: null,
      amount: toFixedString(amount, 2),
      description: cmp(ordinary, allOrdinary) === 0 ? "From the usual week" : `From the usual week: ${hoursText(ordinary)} of ${hoursText(allOrdinary)} ordinary hours`,
      regular: null,
      leave: null,
    });
  }
  // Overtime before allowances, as pay runs order kinds.
  for (const [payItemId, entry] of [...extras].sort((a, b) => (a[1].kind === b[1].kind ? 0 : a[1].kind === "overtime" ? -1 : 1))) {
    if (entry.kind === "overtime") {
      if (!isPositive(entry.hours)) continue;
      const lineRate = toFixedString(mul(dec(rate.hourlyRate!), dec(entry.multiplier ?? "1")), 6);
      const hours = toFixedString(entry.hours, 2);
      lines.push({ kind: "overtime", payItemId, source: "usual_pay", quantity: hours, rate: lineRate, amount: lineAmount(hours, lineRate), description: "From the usual week", regular: entry.regular, leave: null });
    } else if (isPositive(entry.amount)) {
      lines.push({
        kind: "allowance",
        payItemId,
        source: "usual_pay",
        quantity: null,
        rate: null,
        amount: toFixedString(entry.amount, 2),
        description: `From the usual week: ${entry.count} day${entry.count === 1 ? "" : "s"}`,
        regular: entry.regular,
        leave: null,
      });
    }
  }
  return lines;
}

/** The final pay's holiday pay on finishing (decision 150): parts of s 23-s 26, s 40(3) and s 60(2)(b), each a line. */
async function terminationLines(
  tx: OrgTx,
  run: DraftRun,
  facts: EmployeeFacts,
  recordsStart: string | null,
  region: AnniversaryRegion,
  extra: LeaveLine[],
  usualPay: WorkedLine[] | null,
  notes: string[],
): Promise<WorkedLine[]> {
  const finish = facts.finishDate!;
  const settings = settingsOn(facts, finish)!;
  const pattern = settings.pattern;
  const entitlements = annualDates(facts, finish);
  const entitled = entitlements.length > 0;
  const balance = annualBalance(facts, finish, extra).balance;
  const weekly = toPlainString(weekHours(pattern));
  const untaken = entitled && signOfLeave(balance) > 0 ? balance : new Map();
  const rate = await weeklyRateOn(tx, facts, { date: finish, anchorPeriodStart: run.period_start, recordsStart, inAdvance: false, what: "Holiday pay on finishing" });
  const payRate = await rateOn(tx, facts, finish);
  const holidays: Array<{ date: string; name: string; pay: Decimal }> = [];
  if (entitled && signOfLeave(untaken) > 0) {
    const walk = holidaysInUntakenLeave({ finishDate: finish, hours: hoursAt(untaken, weekly, 8), pattern, region });
    for (const holiday of walk.holidays) {
      let pay: Decimal | null;
      if (settings.dailyPay === "adp") {
        pay = (await dailyRateOn(tx, facts, { date: finish, anchorPeriodStart: run.period_start, recordsStart, what: "Public holidays in untaken annual holidays" }))?.rate ?? null;
      } else {
        pay = relevantDailyPay(pattern, payRate, holiday.date);
      }
      if (pay) holidays.push({ date: holiday.date, name: holiday.name, pay });
    }
  }
  const since = entitled ? entitlements.at(-1)! : facts.startDate;
  const before = addDays(run.period_start, -1);
  let gross = ZERO_DECIMAL;
  if (since <= before) {
    assertEarningsKnown(facts, since, before, recordsStart, "Holiday pay on finishing");
    gross = grossEarningsBetween(facts, since, before);
  }
  gross = add(gross, await draftGross(tx, run, facts.id, usualPay, extra));
  const alternative = alternativeHolidays(facts, finish, extra).filter((holiday) => holiday.status === "untaken");
  let lastDayPay: Decimal | null = null;
  if (alternative.length > 0) {
    const daily = await dailyRateOn(tx, facts, { date: finish, anchorPeriodStart: run.period_start, recordsStart, what: "Untaken alternative holidays" });
    if (!daily) throw new ValidationError(`${NOT_SUPPORTED}: paying ${facts.name}'s untaken alternative holidays at their last day's pay (s 60(2)(b)) when the last day (${formatDate(finish)}) isn't a working day.`);
    lastDayPay = daily.rate;
  }
  const result = terminationHolidayPay({
    entitled,
    untaken,
    weekHours: weekly,
    owp: rate.owp,
    awe: rate.awe,
    publicHolidays: holidays,
    grossSince: gross,
    grossSinceDate: since,
    advancePaid: advancePaidSince(facts, since, extra),
    alternativeHolidays: alternative.map((holiday) => {
      const usual = usualHoursOn(pattern, finish);
      return { arose: holiday.arose, pay: lastDayPay!, hours: isPositive(usual) ? toPlainString(usual) : "1" };
    }),
  });
  if (result.advanceExcess) {
    notes.push(
      `${facts.name} was paid $${formatMoney(result.advanceExcess)} more for annual holidays in advance than the 8% owed. It can be deducted only with their written consent (Wages Protection Act s 5; decision 16); ${NOT_SUPPORTED.toLowerCase()}: deducting it, as how the recovery is taxed needs its own worked example.`,
    );
  }
  return result.parts.map((part) => {
    let hours: string | null = null;
    let unitHours: string | null = null;
    if (part.kind === "untaken_entitlement") {
      hours = toPlainString(hoursAt(part.quantity, weekly, 4));
      unitHours = weekly;
    } else if (part.kind === "alternative_holidays") {
      const [[per, quantityHours]] = [...part.quantity];
      hours = toPlainString(quantityHours);
      unitHours = per;
    }
    const line = leaveLine({
      leaveType: "termination",
      from: finish,
      to: finish,
      hours,
      unitHours,
      units: hours ? fixed(unitsOf(part.quantity)) : null,
      amount: part.amount,
      basis: { ...part.basis, part: part.kind },
    });
    extra.push(line);
    return worked(line, part.description);
  });
}

/** This draft's gross earnings for holiday pay (s 14): its usual pay, leave and typed lines that count. */
async function draftGross(tx: OrgTx, run: DraftRun, employeeId: string, usualPay: WorkedLine[] | null, extra: LeaveLine[]): Promise<Decimal> {
  const counting = new Map(
    (await tx.query<{ kind: PayItemKind; id: string; counts_for_holiday_pay: boolean }>("select kind, id::text, counts_for_holiday_pay from payroll_pay_items")).rows.map((row) => [
      row.id,
      row,
    ]),
  );
  const systemCounts = new Map<string, boolean>();
  for (const item of counting.values()) systemCounts.set(item.kind, systemCounts.get(item.kind) ?? item.counts_for_holiday_pay);
  let total = ZERO_DECIMAL;
  const typed = await tx.query<{ pay_item_id: string; amount: string; source: string }>(
    "select pay_item_id::text, amount::text, source from payroll_pay_run_lines where pay_run_id::text = $1 and employee_id::text = $2 and source = 'typed'",
    [run.id, employeeId],
  );
  for (const line of typed.rows) if (counting.get(line.pay_item_id)?.counts_for_holiday_pay) total = add(total, dec(line.amount));
  if (usualPay) {
    for (const line of usualPay) {
      const counts = line.payItemId ? counting.get(line.payItemId)?.counts_for_holiday_pay : systemCounts.get(line.kind);
      if (counts) total = add(total, dec(line.amount));
    }
  } else {
    const kept = await tx.query<{ pay_item_id: string; amount: string }>(
      "select pay_item_id::text, amount::text from payroll_pay_run_lines where pay_run_id::text = $1 and employee_id::text = $2 and source = 'usual_pay'",
      [run.id, employeeId],
    );
    for (const line of kept.rows) if (counting.get(line.pay_item_id)?.counts_for_holiday_pay) total = add(total, dec(line.amount));
  }
  for (const line of extra) {
    if (line.leaveType === "termination" || line.leaveType === "cash_up") continue;
    total = add(total, dec(line.amount));
  }
  return total;
}

/** The employee's leave lines as stored on a draft, for comparing with what's worked out now. */
type StoredLine = { kind: PayItemKind; pay_item_id: string; source: string; amount: string; quantity: string | null; description: string | null; leave_type: string | null; leave_from: string | null; holiday_date: string | null; leave_hours: string | null };

function signature(line: { kind: string; amount: string; quantity: string | null; leaveType: string | null; from: string | null; holiday: string | null; hours: string | null; payItemId?: string | null }): string {
  return [line.kind, line.payItemId ?? "", toFixedString(dec(line.amount), 2), line.quantity ? toFixedString(dec(line.quantity), 2) : "", line.leaveType ?? "", line.from ?? "", line.holiday ?? "", line.hours ? toPlainString(dec(line.hours)) : ""].join("|");
}

/**
 * Whether the usual pay is still Tohyee's to work out (decision 149): it is
 * while the draft has Tohyee's usual pay lines, or nothing typed by hand.
 */
async function usualPayIsTohyees(tx: OrgTx, runId: string, employeeId: string): Promise<boolean> {
  const lines = await tx.query<{ usual: string; typed: string }>(
    `select count(*) filter (where source = 'usual_pay')::text as usual,
            count(*) filter (where source = 'typed' and back_pay_for_pay_run_id is null)::text as typed
       from payroll_pay_run_lines where pay_run_id::text = $1 and employee_id::text = $2`,
    [runId, employeeId],
  );
  return lines.rows[0].usual !== "0" || lines.rows[0].typed === "0";
}

/**
 * Whether Tohyee keeps an employee's leave for a pay period starting on
 * `periodStart` (decision 143), and the pay items that are regular extras in
 * their usual week (decision 11).
 */
export async function leaveKeptFor(tx: OrgTx, employeeId: string, periodStart: string): Promise<{ kept: boolean; regularItems: Set<string> }> {
  const settings = await allSettings(tx, employeeId);
  if (settings.length === 0) return { kept: false, regularItems: new Set() };
  const facts = await loadEmployeeFacts(tx, employeeId, settings);
  const kept = whyLeaveNotKept(facts, recordsStartWith(facts, periodStart)) === null;
  const current = settingsOn(facts, laterOf(periodStart, facts.startDate)) ?? settings.at(-1)!;
  const regularItems = new Set<string>();
  if (current.pattern.kind === "fixed") {
    for (const day of current.pattern.days) for (const extra of day.extras) if (extra.regular) regularItems.add(extra.payItemId);
  }
  return { kept, regularItems };
}

async function systemItems(tx: OrgTx): Promise<Map<PayItemKind, string>> {
  const result = await tx.query<{ kind: PayItemKind; id: string }>("select kind, id::text from payroll_pay_items where is_system");
  return new Map(result.rows.map((row) => [row.kind, row.id]));
}

/**
 * Works out and saves an employee's usual pay and leave on a draft
 * (decisions 141, 149): replaces their leave lines, and their usual pay when
 * no line has been typed by hand (`initial` treats the draft's first line as
 * Tohyee's). Saves the problem and notes with the employee.
 */
export async function updateEmployeeLeave(tx: OrgTx, run: DraftRun, employeeId: string, options: { initial?: boolean } = {}): Promise<LeaveWorkResult> {
  if (run.status !== "draft") throw new Error("Leave is only worked out on drafts.");
  const result = await workOutLeave(tx, run, employeeId);
  const replaceUsual = result.usualPay !== null && (options.initial || (await usualPayIsTohyees(tx, run.id, employeeId)));
  const items = await systemItems(tx);
  await tx.query("delete from payroll_pay_run_lines where pay_run_id::text = $1 and employee_id::text = $2 and source = 'leave'", [run.id, employeeId]);
  if (replaceUsual) {
    await tx.query(
      `delete from payroll_pay_run_lines where pay_run_id::text = $1 and employee_id::text = $2
          and (source = 'usual_pay' or ($3::boolean and source = 'typed' and back_pay_for_pay_run_id is null))`,
      [run.id, employeeId, options.initial ?? false],
    );
  } else if (result.usualPay !== null && result.leave.some((line) => line.leave && ["annual", "sick", "bereavement", "family_violence", "alternative", "public_holiday", "public_holiday_worked"].includes(line.leave.leaveType))) {
    result.notes.push("Earnings were typed by hand, so Tohyee didn't take leave and public holidays off the usual pay: check the hours.");
  }
  if (result.usualPay === null && result.kept && result.leave.some((line) => line.leave && ["annual", "sick", "bereavement", "family_violence", "alternative", "public_holiday", "public_holiday_worked"].includes(line.leave.leaveType))) {
    result.notes.push("Hours vary, so Tohyee didn't take leave and public holidays off Ordinary time: enter the hours worked.");
  }
  // Line numbers: keep the rest in order, then usual pay, then leave.
  const kept = await tx.query<{ line_number: number }>(
    "select line_number from payroll_pay_run_lines where pay_run_id::text = $1 and employee_id::text = $2 order by line_number",
    [run.id, employeeId],
  );
  let next = 0;
  for (const row of kept.rows) {
    next += 1;
    if (row.line_number !== next) {
      await tx.query("update payroll_pay_run_lines set line_number = $4 where pay_run_id::text = $1 and employee_id::text = $2 and line_number = $3", [
        run.id,
        employeeId,
        row.line_number,
        next,
      ]);
    }
  }
  const toInsert = [...(replaceUsual ? result.usualPay! : []), ...result.leave];
  if (next + toInsert.length > 200) throw new ValidationError("An employee can have at most 200 lines on a pay run, leave included.");
  for (const line of toInsert) {
    next += 1;
    const itemId = line.payItemId ?? items.get(line.kind) ?? null;
    if (!itemId) throw new ValidationError(`There's no ${line.kind.replace(/_/g, " ")} pay item. Repair the organisation under Server › Organisations, or ask an admin.`);
    const leave = line.leave;
    await tx.query(
      `insert into payroll_pay_run_lines (pay_run_id, employee_id, line_number, pay_item_id, quantity, rate, amount, description, source, regular,
                                          leave_type, leave_booking_id, leave_from, leave_to, leave_hours, leave_unit_hours, leave_units,
                                          leave_in_advance, holiday_date, cash_up_id, exchange_id, leave_basis)
       values ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12::uuid, $13, $14, $15, $16, $17, $18, $19, $20::uuid, $21::uuid, $22::jsonb)`,
      [
        run.id,
        employeeId,
        next,
        itemId,
        line.quantity,
        line.rate,
        line.amount,
        line.description,
        line.source,
        line.regular,
        leave?.leaveType ?? null,
        leave?.bookingId ?? null,
        leave?.from ?? null,
        leave?.to ?? null,
        leave?.hours ?? null,
        leave?.hours ? leave.unitHours : null,
        leave?.units ?? null,
        leave?.inAdvance ?? false,
        leave?.holidayDate ?? null,
        leave?.cashUpId ?? null,
        leave?.exchangeId ?? null,
        leave ? JSON.stringify(leave.basis) : null,
      ],
    );
  }
  await tx.query("update payroll_pay_run_employees set leave_problem = $3, leave_notes = $4::jsonb where pay_run_id::text = $1 and employee_id::text = $2", [
    run.id,
    employeeId,
    result.problem,
    JSON.stringify(result.notes),
  ]);
  return result;
}

/**
 * Whether the leave saved on a draft is what Tohyee works out now (checked
 * on approval; decision 141). Null when it is, otherwise why not.
 */
export async function leaveOutOfDate(tx: OrgTx, run: DraftRun, employeeId: string, name: string): Promise<string | null> {
  const result = await workOutLeave(tx, run, employeeId);
  if (result.problem) return result.problem;
  const stored = (
    await tx.query<StoredLine>(
      `select p.kind, l.pay_item_id::text, l.source, l.amount::text, l.quantity::text, l.description, l.leave_type, l.leave_from::text,
              l.holiday_date::text, l.leave_hours::text
         from payroll_pay_run_lines l join payroll_pay_items p on p.id = l.pay_item_id
        where l.pay_run_id::text = $1 and l.employee_id::text = $2 and l.source in ('leave', 'usual_pay')
        order by l.line_number`,
      [run.id, employeeId],
    )
  ).rows;
  const usualIsTohyees = result.usualPay !== null && stored.some((line) => line.source === "usual_pay");
  const want = [...(usualIsTohyees ? result.usualPay! : []), ...result.leave]
    .map((line) =>
      signature({
        kind: line.kind,
        payItemId: line.source === "usual_pay" && line.payItemId ? line.payItemId : null,
        amount: line.amount,
        quantity: line.quantity,
        leaveType: line.leave?.leaveType ?? null,
        from: line.leave?.from ?? null,
        holiday: line.leave?.holidayDate ?? null,
        hours: line.leave?.hours ?? null,
      }),
    )
    .sort();
  const have = stored
    .filter((line) => line.source === "leave" || usualIsTohyees)
    .map((line) =>
      signature({
        kind: line.kind,
        payItemId: line.source === "usual_pay" && (line.kind === "overtime" || line.kind === "allowance") ? line.pay_item_id : null,
        amount: line.amount,
        quantity: line.quantity,
        leaveType: line.leave_type,
        from: line.leave_from,
        holiday: line.holiday_date,
        hours: line.leave_hours,
      }),
    )
    .sort();
  if (want.length !== have.length || want.some((entry, index) => entry !== have[index])) {
    return `${name}'s leave has changed since it was worked out on this draft (a booking, a public holiday decision, a cash-up, an approved timesheet or an earlier pay run). Press Update leave and check it again.`;
  }
  return null;
}

/** Works out leave again on every draft that covers an employee's dates (after a booking, decision or setting changes). */
export async function updateDraftsCovering(tx: OrgTx, employeeId: string, from: string, to: string): Promise<string[]> {
  const drafts = await tx.query<DraftRun>(
    `select r.id::text, r.run_number::text, r.period_start::text, r.period_end::text, r.pay_frequency, r.status
       from payroll_pay_runs r join payroll_pay_run_employees pe on pe.pay_run_id = r.id
      where pe.employee_id::text = $1 and r.status = 'draft' and r.period_end >= $2 and r.period_start <= $3
      order by r.period_start`,
    [employeeId, from, to],
  );
  for (const run of drafts.rows) await updateEmployeeLeave(tx, run, employeeId);
  return drafts.rows.map((run) => payRunReference(run.run_number));
}

/** The draft runs an employee is on, for "Update leave" after anything changes. */
export async function updateAllDrafts(tx: OrgTx, employeeId: string): Promise<string[]> {
  return updateDraftsCovering(tx, employeeId, "0001-01-01", "9999-12-31");
}

export { lastApprovedEnd };
