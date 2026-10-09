import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { add, dec, divide, isPositive, isZero, mul, sum, toFixedString, toPlainString, truncate, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { annualEntitlement } from "@/lib/payroll/leave/annual";
import { laterOf } from "@/lib/payroll/leave/dates";
import { averageWeeklyEarnings, greaterOf, twelveMonthsTo } from "@/lib/payroll/leave/earnings";
import { hoursAt, signOfLeave, unitsOf } from "@/lib/payroll/leave/quantity";
import { ordinaryWeeklyPay, weekDays, weekHours } from "@/lib/payroll/leave/work-pattern";
import {
  type AlternativeHoliday,
  alternativeHolidays,
  annualBalance,
  assertEarningsKnown,
  dayLeaveBalanceOf,
  dayWeight,
  type EmployeeFacts,
  grossEarningsBetween,
  type LeaveLine,
  loadEmployeeFacts,
  rateOn,
  recordsStartWith,
  settingsOn,
  sickDates,
  whyLeaveNotKept,
} from "@/lib/payroll/leave-facts";
import { leaveSettingsOn, type LeaveSettings } from "@/lib/payroll/leave-settings";
import { toCsv } from "@/lib/payroll/report-figures";

/**
 * Leave balances, the holiday and leave record (s 81; HL40-HL42) and the
 * leave liability report (decision 153; posted to the ledger by
 * `leave-liability.ts`, decision 177). Read-only,
 * payroll access only. Balances count leave on approved pay runs, at the
 * date asked for.
 */

export type LeaveSummary = {
  employeeId: string;
  name: string;
  startDate: string;
  finishDate: string | null;
  asAt: string;
  /** Whether Tohyee keeps this employee's leave, and why not (decision 143). */
  kept: boolean;
  notKeptReason: string | null;
  usualWeek: { hours: string; days: string } | null;
  annual: {
    weeks: string;
    hours: string;
    days: string;
    lastEntitled: string | null;
    nextEntitled: string;
    cashedUpThisYear: string;
    entitlementYear: { from: string; to: string } | null;
  } | null;
  sick: { days: string; lastEntitled: string | null } | null;
  familyViolence: { days: string } | null;
  alternative: { untaken: number; holidays: AlternativeHoliday[] } | null;
  runningEightPercent: { since: string; to: string | null; gross: string; amount: string } | { since: string; problem: string } | null;
};

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function factsFor(tx: OrgTx, employeeIdInput: unknown): Promise<EmployeeFacts> {
  if (typeof employeeIdInput !== "string" || !UUID_PATTERN.test(employeeIdInput)) throw new NotFoundError("Employee not found.");
  const exists = await tx.query("select 1 from payroll_employees where id = $1", [employeeIdInput]);
  if (!exists.rows[0]) throw new NotFoundError("Employee not found.");
  return loadEmployeeFacts(tx, employeeIdInput, await allSettings(tx, employeeIdInput));
}

/** The last approved pay period ending on or before a date. */
function approvedThrough(facts: EmployeeFacts, on: string): string | null {
  return facts.periods.filter((period) => period.periodEnd <= on).reduce<string | null>((latest, period) => (!latest || period.periodEnd > latest ? period.periodEnd : latest), null);
}

/** An employee's balances at a date (HL42). Family violence leave is shown: everything here needs payroll access (decision 27). */
export function summarise(facts: EmployeeFacts, on: string): LeaveSummary {
  const recordsStart = recordsStartWith(facts, null);
  const notKept = whyLeaveNotKept(facts, recordsStart);
  const settings = settingsOn(facts, laterOf(on, facts.startDate)) ?? facts.settings.at(-1) ?? null;
  const base: LeaveSummary = {
    employeeId: facts.id,
    name: facts.name,
    startDate: facts.startDate,
    finishDate: facts.finishDate,
    asAt: on,
    kept: notKept === null,
    notKeptReason: notKept,
    usualWeek: settings ? { hours: toPlainString(weekHours(settings.pattern)), days: toPlainString(weekDays(settings.pattern)) } : null,
    annual: null,
    sick: null,
    familyViolence: null,
    alternative: null,
    runningEightPercent: null,
  };
  if (notKept || !settings) return base;
  const annual = annualBalance(facts, on);
  const week = toPlainString(weekHours(settings.pattern));
  const days = weekDays(settings.pattern);
  const weeks = unitsOf(annual.balance, 8);
  const sick = dayLeaveBalanceOf(facts, "sick", on);
  const violence = dayLeaveBalanceOf(facts, "family_violence", on);
  const alternative = alternativeHolidays(facts, on);
  const since = annual.lastEntitled ?? facts.startDate;
  const through = approvedThrough(facts, on);
  let running: LeaveSummary["runningEightPercent"];
  try {
    if (through && through >= since) assertEarningsKnown(facts, since, through, recordsStart, "The running 8%");
    const gross = through && through >= since ? grossEarningsBetween(facts, since, through) : ZERO_DECIMAL;
    running = { since, to: through && through >= since ? through : null, gross: toFixedString(gross, 2), amount: toFixedString(mul(gross, dec("0.08")), 2) };
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    running = { since, problem: error.message };
  }
  return {
    ...base,
    annual: {
      weeks: toFixedString(weeks, 4),
      hours: toFixedString(hoursAt(annual.balance, week, 8), 2),
      days: toFixedString(mul(weeks, days), 2),
      lastEntitled: annual.lastEntitled,
      nextEntitled: annual.nextEntitled,
      cashedUpThisYear: toFixedString(annual.cashedUpThisYear, 4),
      entitlementYear: annual.entitlementYear,
    },
    sick: { days: toFixedString(unitsOf(sick.balance, 8), 2), lastEntitled: sick.entitlementDates.at(-1) ?? null },
    familyViolence: { days: toFixedString(unitsOf(violence.balance, 8), 2) },
    alternative: { untaken: alternative.filter((holiday) => holiday.status === "untaken").length, holidays: alternative },
    runningEightPercent: running,
  };
}

export async function getLeaveSummary(tx: OrgTx, employeeIdInput: unknown, onInput?: unknown): Promise<LeaveSummary> {
  await requirePayrollAccess(tx);
  const on = onInput ? parseIsoDate(onInput, "As at") : todayIsoDate();
  return summarise(await factsFor(tx, employeeIdInput), on);
}

/** Everyone's balances at a date (Payroll › Leave). */
export async function listLeaveBalances(tx: OrgTx, onInput?: unknown): Promise<LeaveSummary[]> {
  await requirePayrollAccess(tx);
  const on = onInput ? parseIsoDate(onInput, "As at") : todayIsoDate();
  const employees = await tx.query<{ id: string }>(
    `select id::text from payroll_employees where not is_archived and start_date <= $1 and (finish_date is null or finish_date >= $1 - 400)
      order by lower(last_name), lower(first_name), payroll_employees.id`,
    [on],
  );
  const summaries: LeaveSummary[] = [];
  for (const employee of employees.rows) summaries.push(summarise(await loadEmployeeFacts(tx, employee.id, await allSettings(tx, employee.id)), on));
  return summaries;
}

// The holiday and leave record (s 81; HL40, HL41)

export type LeaveRecordEntry = {
  date: string;
  /** For leave over several days. */
  to: string | null;
  /** The s 81(2) item the entry answers. */
  item: string;
  entry: string;
  hours: string | null;
  amount: string | null;
  payRun: string | null;
};

export type LeaveRecord = {
  employeeId: string;
  name: string;
  startDate: string;
  finishDate: string | null;
  summary: LeaveSummary;
  entries: LeaveRecordEntry[];
  /** s 81(2)(c): hours each pay period and the pay for them (from approved pay runs; the usual week where hours weren't recorded, s 81(3A)). */
  payPeriods: Array<{ payRun: string; periodStart: string; periodEnd: string; hours: string; gross: string }>;
};

const DAY_LABELS: Record<string, string> = {
  sick: "Sick leave",
  bereavement: "Bereavement leave",
  family_violence: "Family violence leave",
  alternative: "Alternative holiday taken",
};

function units(line: LeaveLine, unit: "week" | "day"): string {
  const value = line.units ? toFixedString(dec(line.units), 4).replace(/\.?0+$/, "") : "";
  return value ? `${value} ${unit}${value === "1" ? "" : "s"}` : "";
}

/**
 * The holiday and leave record for an employee (s 81(2); HL40, HL41): when
 * they started, each entitlement, leave taken with its dates, hours and pay,
 * cash-ups, public holidays worked and paid, alternative holidays, and the
 * holiday pay on finishing. Kept from approved pay runs, which are never
 * changed, so the 6 years (s 81(4)) are kept.
 */
export async function getLeaveRecord(tx: OrgTx, employeeIdInput: unknown): Promise<LeaveRecord> {
  await requirePayrollAccess(tx);
  const facts = await factsFor(tx, employeeIdInput);
  const today = todayIsoDate();
  const until = facts.finishDate && facts.finishDate < today ? facts.finishDate : today;
  const entries: LeaveRecordEntry[] = [{ date: facts.startDate, to: null, item: "(b)", entry: "Employment started", hours: null, amount: null, payRun: null }];
  const kept = whyLeaveNotKept(facts, recordsStartWith(facts, null)) === null;
  const opening = facts.opening;
  // Entitlements on or before the opening balances' date are in them (decision 168).
  const afterOpening = (date: string) => !opening || date > opening.asAt;
  if (kept && opening) {
    const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    entries.push({
      date: opening.asAt,
      to: null,
      item: "(d), (e), (f), (k)",
      entry:
        `Opening balances (${opening.source}): annual holidays ${opening.annualWeeks} weeks` +
        `${opening.annualLastEntitled ? `, last entitled ${formatDate(opening.annualLastEntitled)}` : ""}` +
        `${!isZero(dec(opening.annualCashedUpWeeks)) ? `, ${opening.annualCashedUpWeeks} week cashed up that entitlement year` : ""}` +
        `; sick leave ${opening.sickDays} days; family violence leave ${opening.familyViolenceDays} days; ` +
        `${plural(opening.alternativeHolidays.length, "untaken alternative holiday")}${opening.alternativeHolidays.length ? ` (arose ${opening.alternativeHolidays.map(formatDate).join(", ")})` : ""}`,
      hours: null,
      amount: null,
      payRun: null,
    });
  }
  if (kept) {
    for (const date of annualBalance(facts, until).entitlementDates.filter(afterOpening)) {
      const settings = settingsOn(facts, date) ?? facts.settings.at(-1)!;
      const hours = [...annualEntitlement(toPlainString(weekHours(settings.pattern))).values()][0];
      entries.push({ date, to: null, item: "(d), (e)", entry: "Entitled to 4 weeks' annual holidays", hours: toPlainString(hours), amount: null, payRun: null });
    }
    for (const event of dayLeaveBalanceOf(facts, "sick", until).events) {
      if (event.kind !== "entitled" || !afterOpening(event.date)) continue;
      const carried = toFixedString(unitsOf(event.carried, 4), 2);
      const lapsed = toFixedString(unitsOf(event.lapsed, 4), 2);
      entries.push({
        date: event.date,
        to: null,
        item: "(f)",
        entry: `Entitled to 10 days' sick leave${signOfLeave(event.carried) > 0 ? `; ${carried} carried over` : ""}${signOfLeave(event.lapsed) > 0 ? `; ${lapsed} lapsed` : ""}`,
        hours: null,
        amount: null,
        payRun: null,
      });
    }
    for (const date of sickDates(facts, until).filter(afterOpening)) {
      entries.push({ date, to: null, item: "(f)", entry: "Entitled to 10 days' family violence leave", hours: null, amount: null, payRun: null });
    }
  }
  for (const line of facts.lines) {
    const base = { hours: line.hours, amount: toFixedString(dec(line.amount), 2), payRun: line.reference, to: null as string | null };
    switch (line.leaveType) {
      case "annual":
        entries.push({ ...base, date: line.from!, to: line.to, item: "(g), (h)", entry: `Annual holidays, ${units(line, "week")}${line.inAdvance ? " (in advance)" : ""}` });
        break;
      case "sick":
      case "bereavement":
      case "family_violence":
      case "alternative":
        entries.push({ ...base, date: line.from!, item: line.leaveType === "alternative" ? "(l)" : "(g), (h)", entry: `${DAY_LABELS[line.leaveType]}, ${units(line, "day")}` });
        break;
      case "public_holiday":
        entries.push({ ...base, date: line.holidayDate!, item: "(l)", entry: `${String(line.basis.holiday ?? "Public holiday")}, not worked, paid` });
        break;
      case "public_holiday_worked":
        if (line.basis.typed) {
          entries.push({ ...base, date: line.holidayDate!, item: "(i)", entry: "Public holiday worked: extra under the agreement", hours: null });
          break;
        }
        entries.push({ ...base, hours: String(line.basis.hoursWorked ?? ""), date: line.holidayDate!, item: "(i), (j)", entry: `Worked ${String(line.basis.holiday ?? "a public holiday")}, ${String(line.basis.hoursWorked)} hours` });
        if (line.basis.alternativeHoliday === true) {
          entries.push({ date: line.holidayDate!, to: null, item: "(k)", entry: "Alternative holiday arose", hours: null, amount: null, payRun: line.reference });
        }
        break;
      case "cash_up":
        entries.push({ ...base, date: line.from!, item: "(ha), (hb)", entry: `Annual holidays cashed up, ${units(line, "week")}` });
        break;
      case "exchange":
        entries.push({ ...base, date: line.from!, item: "(n)", entry: `Alternative holiday (arose ${String(line.basis.arose)}) exchanged for payment` });
        break;
      case "termination":
        entries.push({ ...base, date: line.from!, item: "(p)", entry: `Holiday pay on termination: ${line.description ?? ""}` });
        break;
    }
  }
  if (facts.finishDate) entries.push({ date: facts.finishDate, to: null, item: "(o)", entry: "Employment ended", hours: null, amount: null, payRun: null });
  entries.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  const periods = await tx.query<{ run_number: string; period_start: string; period_end: string; hours: string; gross: string }>(
    `select r.run_number::text, r.period_start::text, r.period_end::text,
            (coalesce(sum(l.quantity) filter (where p.category = 'earnings' and l.leave_type is null), 0)
             + coalesce(sum(l.leave_hours) filter (where l.leave_type in ('annual', 'sick', 'bereavement', 'family_violence', 'alternative')), 0))::text as hours,
            pe.gross::text
       from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id and r.status = 'approved'
       left join payroll_pay_run_lines l on l.pay_run_id = pe.pay_run_id and l.employee_id = pe.employee_id
       left join payroll_pay_items p on p.id = l.pay_item_id
      where pe.employee_id = $1
      group by r.id, pe.gross order by r.period_start`,
    [facts.id],
  );
  return {
    employeeId: facts.id,
    name: facts.name,
    startDate: facts.startDate,
    finishDate: facts.finishDate,
    summary: summarise(facts, until),
    entries,
    payPeriods: periods.rows.map((row) => ({
      payRun: `PAYRUN-${row.run_number}`,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      hours: toFixedString(dec(row.hours), 2),
      gross: toFixedString(dec(row.gross ?? "0"), 2),
    })),
  };
}

/** The record as CSV (HL41), audited without figures. */
export async function exportLeaveRecord(tx: OrgTx, employeeIdInput: unknown): Promise<{ fileName: string; csv: string; sha256: string }> {
  const record = await getLeaveRecord(tx, employeeIdInput);
  const csv = toCsv([
    ["Date", "To", "s 81(2)", "Entry", "Hours", "Amount", "Pay run"],
    ...record.entries.map((entry) => [entry.date, entry.to, entry.item, entry.entry, entry.hours, entry.amount, entry.payRun]),
  ]);
  const sha256 = createHash("sha256").update(csv).digest("hex");
  await writeAuditEvent(tx, { eventType: "payroll_leave_record.exported", entityType: "payroll_employee", entityId: record.employeeId, details: { rows: record.entries.length, sha256 } });
  return { fileName: `Holiday and leave record ${record.name}.csv`.replace(/[\\/:*?"<>|]/g, "_"), csv, sha256 };
}

// Leave liability (decision 28; HL42)

export type LeaveLiabilityRow = {
  employeeId: string;
  name: string;
  departmentId: string | null;
  department: string | null;
  annualWeeks: string | null;
  weeklyRate: string | null;
  rateUsed: "owp" | "awe" | null;
  annualValue: string;
  runningEightPercent: string;
  eightPercentSince: string | null;
  alternativeHolidays: number;
  alternativeValue: string;
  /** Someone who finished before the date and isn't paid yet (decision 189): their finish date and final pay's pay date. */
  finishDate: string | null;
  finalPayDate: string | null;
  /** The holiday pay on finishing on their approved final pay (decision 189). */
  holidayPayOnFinishing: string;
  /** Holiday pay owed: annual holidays, the running 8%, alternative holidays and holiday pay on finishing. */
  total: string;
  /** The employer's KiwiSaver rate when enrolled (null otherwise), and the employer KiwiSaver on `total` (decision 190). */
  kiwiSaverRate: string | null;
  kiwiSaver: string;
  problem: string | null;
};

type LiabilityFigures = { annualValue: string; runningEightPercent: string; alternativeValue: string; holidayPayOnFinishing: string; total: string; kiwiSaver: string; withKiwiSaver: string };

export type LeaveLiabilityReport = {
  asAt: string;
  rows: LeaveLiabilityRow[];
  departments: Array<{ departmentId: string | null; department: string | null } & LiabilityFigures>;
  totals: LiabilityFigures;
};

/**
 * The employer KiwiSaver on an employee's leave liability (decision 190):
 * the employer rate × the holiday pay owed, truncated to cents as each
 * pay's contribution is (spec 5.20.2). Gross, before ESCT.
 */
export function kiwiSaverOnLiability(total: string, employerRate: string): string {
  const amount = mul(dec(total), divide(dec(employerRate), dec("100"), 10));
  return toFixedString(truncate(amount, 2), 2);
}

/**
 * The leave liability report (decision 28; HL42): for each employee whose
 * leave Tohyee keeps, the annual holidays they're entitled to, valued at the
 * greater of ordinary weekly pay and average weekly earnings to the last
 * approved pay period; the running 8% since their last anniversary; and
 * untaken alternative holidays at a usual day's pay (ordinary weekly pay ÷
 * usual days, decision 153). Someone who finished before the date stays in
 * until their final pay is paid, at the holiday pay on finishing on it, and
 * is a problem while it isn't approved (decision 189). The employer
 * KiwiSaver on each enrolled employee's total is shown beside it (decision
 * 190). By Department (the biggest line of their cost allocation at the
 * date). Read-only; `postLeaveLiability` posts it by Department (decision
 * 177).
 */
export async function leaveLiabilityReport(tx: OrgTx, input: { asAt?: unknown } = {}): Promise<LeaveLiabilityReport> {
  await requirePayrollAccess(tx);
  const asAt = input.asAt ? parseIsoDate(input.asAt, "As at") : todayIsoDate();
  // Finished before the date: in until an approved pay run that includes the finish date (the final pay) is
  // dated on or before it; never paid by an approved pay run in Tohyee: nothing to wait for (decision 189).
  const employees = await tx.query<{ id: string; finish_date: string | null; kiwisaver_status: string; kiwisaver_employer_rate: string }>(
    `select e.id::text, e.finish_date::text, e.kiwisaver_status, e.kiwisaver_employer_rate::text
       from payroll_employees e
      where e.start_date <= $1
        and (e.finish_date is null or e.finish_date >= $1
          or (exists (select 1 from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id
                       where pe.employee_id = e.id and r.status = 'approved')
              and not exists (select 1 from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id
                               where pe.employee_id = e.id and r.status = 'approved' and r.pay_date <= $1
                                 and r.period_start <= e.finish_date and r.period_end >= e.finish_date)))
      order by lower(e.last_name), lower(e.first_name), e.id`,
    [asAt],
  );
  const departments = await tx.query<{ employee_id: string; department_id: string | null; department_name: string | null }>(
    `with current_allocation as (
       select distinct on (employee_id) id, employee_id from payroll_cost_allocations
        where effective_from <= $1 order by employee_id, effective_from desc, entry_number desc
     )
     select distinct on (a.employee_id) a.employee_id::text, l.department_id::text, d.name as department_name
       from current_allocation a join payroll_cost_allocation_lines l on l.allocation_id = a.id
       left join tracking_values d on d.id = l.department_id
      order by a.employee_id, l.percentage desc, l.line_number`,
    [asAt],
  );
  const departmentOf = new Map(departments.rows.map((row) => [row.employee_id, row]));
  const rows: LeaveLiabilityRow[] = [];
  for (const employee of employees.rows) {
    const facts = await loadEmployeeFacts(tx, employee.id, await allSettings(tx, employee.id));
    if (facts.settings.length === 0) continue;
    const department = departmentOf.get(facts.id);
    const enrolled = employee.kiwisaver_status === "enrolled";
    const row: LeaveLiabilityRow = {
      employeeId: facts.id,
      name: facts.name,
      departmentId: department?.department_id ?? null,
      department: department?.department_name ?? null,
      annualWeeks: null,
      weeklyRate: null,
      rateUsed: null,
      annualValue: "0.00",
      runningEightPercent: "0.00",
      eightPercentSince: null,
      alternativeHolidays: 0,
      alternativeValue: "0.00",
      finishDate: null,
      finalPayDate: null,
      holidayPayOnFinishing: "0.00",
      total: "0.00",
      kiwiSaverRate: enrolled ? toFixedString(dec(employee.kiwisaver_employer_rate), 2) : null,
      kiwiSaver: "0.00",
      problem: null,
    };
    if (employee.finish_date !== null && employee.finish_date < asAt) {
      row.finishDate = employee.finish_date;
      const finalPay = await tx.query<{ pay_date: string; amount: string }>(
        `select r.pay_date::text,
                coalesce((select sum(l.amount) from payroll_pay_run_lines l join payroll_pay_items i on i.id = l.pay_item_id
                           where l.pay_run_id = r.id and l.employee_id = pe.employee_id and i.kind = 'termination_holiday_pay'), 0)::text as amount
           from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id
          where pe.employee_id = $1 and r.status = 'approved' and r.period_start <= $2 and r.period_end >= $2
          order by r.pay_date desc limit 1`,
        [facts.id, employee.finish_date],
      );
      if (!finalPay.rows[0]) {
        row.problem = `${facts.name} finished on ${formatDate(employee.finish_date)} and their final pay isn't approved yet. Approve the pay run that includes ${formatDate(employee.finish_date)} (their final pay) first.`;
      } else {
        row.finalPayDate = finalPay.rows[0].pay_date;
        row.holidayPayOnFinishing = toFixedString(dec(finalPay.rows[0].amount), 2);
        row.total = row.holidayPayOnFinishing;
        if (enrolled) row.kiwiSaver = kiwiSaverOnLiability(row.total, employee.kiwisaver_employer_rate);
      }
      rows.push(row);
      continue;
    }
    const summary = summarise(facts, asAt);
    if (!summary.kept) {
      row.problem = summary.notKeptReason;
      rows.push(row);
      continue;
    }
    try {
      const settings = settingsOn(facts, asAt)!;
      const rate = await rateOn(tx, facts, asAt);
      const through = approvedThrough(facts, asAt);
      const recordsStart = recordsStartWith(facts, null);
      let awe = ZERO_DECIMAL;
      if (through) {
        const window = twelveMonthsTo(through);
        assertEarningsKnown(facts, window.from, through, recordsStart, "Average weekly earnings");
        awe = averageWeeklyEarnings({ periods: facts.periods, windowEnd: through, weight: dayWeight(facts) }).weekly;
      }
      const owp = settings.pattern.kind === "fixed" ? ordinaryWeeklyPay(settings.pattern, rate) : awe;
      const greater = greaterOf(owp, awe);
      const balance = annualBalance(facts, asAt).balance;
      const weeks = signOfLeave(balance) > 0 ? unitsOf(balance, 12) : ZERO_DECIMAL;
      row.annualWeeks = toFixedString(unitsOf(balance, 8), 4);
      row.weeklyRate = toFixedString(greater.rate, 2);
      row.rateUsed = greater.source;
      row.annualValue = toFixedString(mul(greater.rate, weeks), 2);
      if (summary.runningEightPercent && "amount" in summary.runningEightPercent) {
        row.runningEightPercent = summary.runningEightPercent.amount;
        row.eightPercentSince = summary.runningEightPercent.since;
      } else if (summary.runningEightPercent && "problem" in summary.runningEightPercent) {
        row.problem = summary.runningEightPercent.problem;
      }
      row.alternativeHolidays = summary.alternative?.untaken ?? 0;
      const usualDays = weekDays(settings.pattern);
      if (row.alternativeHolidays > 0 && isPositive(usualDays)) {
        row.alternativeValue = toFixedString(divide(mul(owp, dec(String(row.alternativeHolidays))), usualDays, 6), 2);
      }
      row.total = toFixedString(sum([dec(row.annualValue), dec(row.runningEightPercent), dec(row.alternativeValue)]), 2);
      if (enrolled) row.kiwiSaver = kiwiSaverOnLiability(row.total, employee.kiwisaver_employer_rate);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      row.problem = error.message;
    }
    rows.push(row);
  }
  const zero = (): LiabilityFigures => ({ annualValue: "0.00", runningEightPercent: "0.00", alternativeValue: "0.00", holidayPayOnFinishing: "0.00", total: "0.00", kiwiSaver: "0.00", withKiwiSaver: "0.00" });
  const addTo = (figures: LiabilityFigures, row: LeaveLiabilityRow) => {
    for (const field of ["annualValue", "runningEightPercent", "alternativeValue", "holidayPayOnFinishing", "total", "kiwiSaver"] as const) {
      figures[field] = toFixedString(add(dec(figures[field]), dec(row[field])), 2);
    }
    figures.withKiwiSaver = toFixedString(add(dec(figures.total), dec(figures.kiwiSaver)), 2);
  };
  const byDepartment = new Map<string, LeaveLiabilityReport["departments"][number]>();
  const totals = zero();
  for (const row of rows) {
    const keyOf = row.departmentId ?? "";
    const entry = byDepartment.get(keyOf) ?? { departmentId: row.departmentId, department: row.department, ...zero() };
    addTo(entry, row);
    byDepartment.set(keyOf, entry);
    addTo(totals, row);
  }
  return {
    asAt,
    rows,
    departments: [...byDepartment.values()].sort((a, b) => (a.department ?? "~").localeCompare(b.department ?? "~")),
    totals,
  };
}

/** The liability report as CSV, audited without figures (as P10's exports, decision 109). */
export async function exportLeaveLiability(tx: OrgTx, input: { asAt?: unknown } = {}): Promise<{ fileName: string; csv: string; sha256: string }> {
  const report = await leaveLiabilityReport(tx, input);
  const csv = toCsv([
    [
      "Employee",
      "Department",
      "Annual holidays (weeks)",
      "Weekly rate",
      "Rate",
      "Annual holidays value",
      "Running 8%",
      "8% since",
      "Alternative holidays",
      "Alternative holidays value",
      "Finished",
      "Final pay date",
      "Holiday pay on finishing",
      "Total",
      "Employer KiwiSaver rate",
      "Employer KiwiSaver",
      "Problem",
    ],
    ...report.rows.map((row) => [
      row.name,
      row.department,
      row.annualWeeks,
      row.weeklyRate,
      row.rateUsed === "awe" ? "AWE" : row.rateUsed === "owp" ? "OWP" : null,
      row.annualValue,
      row.runningEightPercent,
      row.eightPercentSince,
      row.alternativeHolidays,
      row.alternativeValue,
      row.finishDate,
      row.finalPayDate,
      row.holidayPayOnFinishing,
      row.total,
      row.kiwiSaverRate,
      row.kiwiSaver,
      row.problem,
    ]),
    [
      "Total",
      null,
      null,
      null,
      null,
      report.totals.annualValue,
      report.totals.runningEightPercent,
      null,
      null,
      report.totals.alternativeValue,
      null,
      null,
      report.totals.holidayPayOnFinishing,
      report.totals.total,
      null,
      report.totals.kiwiSaver,
      null,
    ],
  ]);
  const sha256 = createHash("sha256").update(csv).digest("hex");
  await writeAuditEvent(tx, { eventType: "payroll_leave_liability.exported", entityType: "payroll_report", entityId: "leave-liability", details: { asAt: report.asAt, rows: report.rows.length, sha256 } });
  return { fileName: `Leave liability ${report.asAt}.csv`, csv, sha256 };
}
