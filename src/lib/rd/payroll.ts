import type { OrgTx } from "@/lib/db/org-transaction";
import { add, cmp, dec, divide, mul, sub, sum, toFixedString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";
import { payRunReference } from "@/lib/payroll/pay-runs";
import { weightShareRoundedDown } from "@/lib/payroll/timesheet-split";
import { daysBetween, isEnteredLate, rdShare } from "@/lib/rd/amounts";
import { rdSettings, timeZone } from "@/lib/rd/common";

/**
 * Pay as R&D employee costs (examples RD7, RD28-RD32, TS5-TS9; decisions 34,
 * 36, 37, 50, 66, 67, 98, 100). Reads posted pay runs only and calculates no
 * pay. Since timesheets (P9), each approved pay run keeps the shares its
 * costs were split by: timesheet rows for the days approved timesheets
 * covered, and the default allocation for the rest. A timesheet share is a
 * time record and counts; an allocation share counts only when that
 * allocation is 100% R&D (decision 34). Each R&D share is the cost × its
 * weight ÷ all weights, rounded down to the cent; the rest is non-R&D. Pay
 * runs approved before P9 have no shares and use the allocation the pay run
 * used, as R3 did (decision 67). Per-employee figures are payroll details:
 * callers show them only to people with payroll access (decision 6).
 */

/**
 * Pay item kinds that are employee costs IRD lists (IR1240 p 63; decisions 66
 * and 136): bonuses, back pay and holiday pay on finishing count; redundancy
 * isn't in IRD's list.
 */
export const RD_PAY_ITEM_KINDS = [
  "ordinary_time",
  "overtime",
  "allowance",
  "holiday_pay",
  "extra_pay",
  "back_pay",
  "termination_holiday_pay",
  "kiwisaver_employer",
  // Leave pay is salary or wages and holiday pay (IR1240 p 63; decision 155).
  "annual_leave",
  "sick_leave",
  "bereavement_leave",
  "family_violence_leave",
  "public_holiday",
  "public_holiday_worked",
  "alternative_holiday",
  "annual_leave_cash_up",
  "alternative_holiday_payout",
] as const;

export type RdPayShare = {
  activityId: string;
  /** The share of the pay's cost, to 2 places, for display. */
  percentage: string;
  amount: string;
  source: "timesheet" | "allocation";
  /** Timesheet hours on the activity in the period. */
  hours: string | null;
  /** A timesheet share always counts; an allocation share only when the allocation is 100% R&D (decisions 34, 100). */
  counts: boolean;
  enteredLate: boolean;
  timelinessText: string;
};

/** A timesheet approved after the pay run, so not used by it (TS9; decision 37). */
export type RdLaterTimesheet = { weekStart: string; rdHours: string };

export type RdPay = {
  payRunId: string;
  payRunReference: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  employeeId: string;
  employeeName: string;
  /** Pay items IRD lists, as posted (decision 66). */
  cost: string;
  /** Posted but not an employee cost (reimbursements). */
  excluded: string;
  allocationEnteredOn: string | null;
  allocationEnteredByEmail: string | null;
  /** The allocation's R&D lines total 100% (decision 34). */
  fullTimeRd: boolean;
  /** Some of the pay was split by approved timesheets (TS5, TS6). */
  usesTimesheets: boolean;
  shares: RdPayShare[];
  notRd: string;
  daysAfterPeriod: number | null;
  enteredLate: boolean;
  timelinessText: string;
  laterTimesheets: RdLaterTimesheet[];
};

type PayRow = {
  pay_run_id: string;
  run_number: string;
  pay_date: string;
  period_start: string;
  period_end: string;
  approved_at: string;
  employee_id: string;
  employee_name: string | null;
  kind: string;
  amount: string;
};

type AllocationRow = {
  pay_run_id: string;
  employee_id: string;
  allocation_id: string;
  entered_on: string;
  created_by_email: string;
  percentage: string;
  rd_activity_id: string | null;
};

type ShareRow = {
  pay_run_id: string;
  employee_id: string;
  share_number: number;
  source: "timesheet" | "allocation";
  allocation_id: string | null;
  allocation_percentage: string | null;
  hours: string | null;
  weight: string;
  rd_activity_id: string | null;
};

type TimesheetEntryRow = {
  pay_run_id: string;
  employee_id: string;
  rd_activity_id: string;
  work_date: string;
  entered_on: string;
};

function allocationTimeliness(days: number | null): string {
  if (days == null) return "no cost allocation: not R&D";
  if (days <= 0) return "allocation entered before the pay period ended";
  return `allocation entered ${days} day${days === 1 ? "" : "s"} after the pay period`;
}

function timesheetTimeliness(maxDays: number): string {
  if (maxDays <= 0) return "timesheet hours entered on the day of the work";
  return `timesheet hours entered up to ${maxDays} day${maxDays === 1 ? "" : "s"} after the work`;
}

const HUNDRED = dec("100");

/** Approved pay runs paid `start` to `end`, each employee's pay with its R&D shares. */
export async function loadRdPays(tx: OrgTx, start: string, end: string): Promise<RdPay[]> {
  const settings = await rdSettings(tx);
  const scale = settings.scale;
  const rows = (
    await tx.query<PayRow>(
      `select r.id::text as pay_run_id, r.run_number::text, r.pay_date::text, r.period_start::text, r.period_end::text, r.approved_at::text,
              p.employee_id::text, e.employee_name, i.kind, sum(p.amount)::text as amount
         from payroll_pay_runs r
         join payroll_pay_run_postings p on p.pay_run_id = r.id
         join payroll_pay_items i on i.id = p.pay_item_id
         join payroll_pay_run_employees e on e.pay_run_id = r.id and e.employee_id = p.employee_id
        where r.status = 'approved' and r.pay_date between $1 and $2
        group by r.id, r.run_number, r.pay_date, r.period_start, r.period_end, r.approved_at, p.employee_id, e.employee_name, i.kind
        order by r.pay_date, r.run_number, e.employee_name, p.employee_id`,
      [start, end],
    )
  ).rows;
  if (rows.length === 0) return [];
  const runIds = [...new Set(rows.map((row) => row.pay_run_id))];

  // The shares approved pay runs kept (P9), with the allocation each used.
  const shareRows = (
    await tx.query<ShareRow>(
      `select pay_run_id::text, employee_id::text, share_number, source, allocation_id::text, allocation_percentage::text, hours::text,
              weight::text, rd_activity_id::text
         from payroll_pay_run_shares where pay_run_id = any($1::uuid[]) order by pay_run_id, employee_id, share_number`,
      [runIds],
    )
  ).rows;
  const allocationIds = [...new Set(shareRows.map((row) => row.allocation_id).filter((id): id is string => id !== null))];
  const allocationStamps = new Map(
    (
      await tx.query<{ id: string; entered_on: string; created_by_email: string }>(
        `select id::text, to_char((created_at at time zone $2)::date, 'YYYY-MM-DD') as entered_on, created_by_email
           from payroll_cost_allocations where id = any($1::uuid[])`,
        [allocationIds, timeZone()],
      )
    ).rows.map((row) => [row.id, row]),
  );
  // Before P9: the allocation the pay run used (decision 67).
  const legacy = (
    await tx.query<AllocationRow>(
      `with pays as (
         select distinct r.id as pay_run_id, r.approved_at, r.pay_date, e.employee_id
           from payroll_pay_runs r join payroll_pay_run_employees e on e.pay_run_id = r.id
          where r.id = any($1::uuid[])
            and not exists (select 1 from payroll_pay_run_shares s where s.pay_run_id = r.id and s.employee_id = e.employee_id)
       )
       select pays.pay_run_id::text, pays.employee_id::text, alloc.id::text as allocation_id,
              to_char((alloc.created_at at time zone $2)::date, 'YYYY-MM-DD') as entered_on,
              alloc.created_by_email, l.percentage::text, l.rd_activity_id::text
         from pays
         cross join lateral (
           select a.id, a.created_at, a.created_by_email from payroll_cost_allocations a
            where a.employee_id = pays.employee_id and a.effective_from <= pays.pay_date and a.created_at <= pays.approved_at
            order by a.effective_from desc, a.entry_number desc limit 1
         ) alloc
         join payroll_cost_allocation_lines l on l.allocation_id = alloc.id
        order by l.line_number`,
      [runIds, timeZone()],
    )
  ).rows;
  // When each R&D hour in the timesheets the pay runs used was entered (decision 38).
  const timesheetEntries = (
    await tx.query<TimesheetEntryRow>(
      `select l.pay_run_id::text, t.employee_id::text, en.rd_activity_id::text, en.work_date::text,
              to_char((en.entered_at at time zone $2)::date, 'YYYY-MM-DD') as entered_on
         from payroll_pay_run_timesheets l
         join payroll_pay_runs r on r.id = l.pay_run_id
         join payroll_timesheets t on t.id = l.timesheet_id
         join payroll_timesheet_entries en on en.timesheet_id = t.id
        where l.pay_run_id = any($1::uuid[]) and en.status = 'active' and en.rd_activity_id is not null
          and en.work_date between r.period_start and r.period_end`,
      [runIds, timeZone()],
    )
  ).rows;
  // Approved after the pay run, so not used by it (TS9; decision 37).
  const later = (
    await tx.query<{ pay_run_id: string; employee_id: string; week_start: string; rd_hours: string }>(
      `select r.id::text as pay_run_id, t.employee_id::text, t.week_start::text, sum(en.hours)::text as rd_hours
         from payroll_pay_runs r
         join payroll_pay_run_employees e on e.pay_run_id = r.id
         join payroll_timesheets t on t.employee_id = e.employee_id and t.status = 'approved' and t.approved_at > r.approved_at
              and t.week_start <= r.period_end and t.week_start + 6 >= r.period_start
         join payroll_timesheet_entries en on en.timesheet_id = t.id and en.status = 'active' and en.rd_activity_id is not null
              and en.work_date between r.period_start and r.period_end
        where r.id = any($1::uuid[])
          and not exists (select 1 from payroll_pay_run_timesheets l where l.pay_run_id = r.id and l.timesheet_id = t.id)
        group by r.id, t.employee_id, t.week_start
        order by t.week_start`,
      [runIds],
    )
  ).rows;

  const pays = new Map<string, { row: PayRow; cost: Decimal; excluded: Decimal }>();
  for (const row of rows) {
    const id = `${row.pay_run_id}|${row.employee_id}`;
    const entry = pays.get(id) ?? { row, cost: ZERO_DECIMAL, excluded: ZERO_DECIMAL };
    if ((RD_PAY_ITEM_KINDS as readonly string[]).includes(row.kind)) entry.cost = add(entry.cost, dec(row.amount));
    else entry.excluded = add(entry.excluded, dec(row.amount));
    pays.set(id, entry);
  }

  return [...pays.entries()].map(([id, { row, cost, excluded }]) => {
    const costText = toFixedString(cost, scale);
    const base = {
      payRunId: row.pay_run_id,
      payRunReference: payRunReference(row.run_number),
      payDate: row.pay_date,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      employeeId: row.employee_id,
      employeeName: row.employee_name ?? "Employee",
      cost: costText,
      excluded: toFixedString(excluded, scale),
      laterTimesheets: later
        .filter((entry) => `${entry.pay_run_id}|${entry.employee_id}` === id)
        .map((entry) => ({ weekStart: entry.week_start, rdHours: toFixedString(dec(entry.rd_hours), 2) })),
    };
    const kept = shareRows.filter((share) => `${share.pay_run_id}|${share.employee_id}` === id);
    if (kept.length === 0) return legacyPay(base, legacy.filter((line) => `${line.pay_run_id}|${line.employee_id}` === id), cost, scale);

    const totalWeight = toFixedString(sum(kept.map((share) => dec(share.weight))), 8);
    const allocationShares = kept.filter((share) => share.source === "allocation");
    const fullTimeRd =
      allocationShares.length > 0 &&
      allocationShares.some((share) => share.rd_activity_id !== null) &&
      cmp(sum(allocationShares.filter((share) => share.rd_activity_id !== null).map((share) => dec(share.allocation_percentage!))), HUNDRED) === 0;
    const allocationId = allocationShares.find((share) => share.allocation_id !== null)?.allocation_id ?? null;
    const stamp = allocationId ? allocationStamps.get(allocationId) ?? null : null;
    const allocationDays = stamp ? daysBetween(row.period_end, stamp.entered_on) : null;

    const grouped = new Map<string, { source: "timesheet" | "allocation"; activityId: string; weight: Decimal; hours: Decimal | null }>();
    for (const share of kept) {
      if (share.rd_activity_id === null) continue;
      const key = `${share.source}|${share.rd_activity_id}`;
      const entry = grouped.get(key) ?? { source: share.source, activityId: share.rd_activity_id, weight: ZERO_DECIMAL, hours: share.hours === null ? null : ZERO_DECIMAL };
      entry.weight = add(entry.weight, dec(share.weight));
      if (share.hours !== null) entry.hours = add(entry.hours ?? ZERO_DECIMAL, dec(share.hours));
      grouped.set(key, entry);
    }
    const shares: RdPayShare[] = [...grouped.values()].map((entry) => {
      const weight = toFixedString(entry.weight, 8);
      if (entry.source === "timesheet") {
        const days = timesheetEntries
          .filter((each) => `${each.pay_run_id}|${each.employee_id}` === id && each.rd_activity_id === entry.activityId)
          .map((each) => daysBetween(each.work_date, each.entered_on));
        const maxDays = days.length ? Math.max(...days) : 0;
        return {
          activityId: entry.activityId,
          percentage: toFixedString(divide(mul(dec(weight), HUNDRED), dec(totalWeight), 2), 2),
          amount: weightShareRoundedDown(costText, weight, totalWeight, scale),
          source: "timesheet" as const,
          hours: entry.hours === null ? null : toFixedString(entry.hours, 2),
          counts: true,
          enteredLate: isEnteredLate(maxDays),
          timelinessText: timesheetTimeliness(maxDays),
        };
      }
      return {
        activityId: entry.activityId,
        percentage: toFixedString(divide(mul(dec(weight), HUNDRED), dec(totalWeight), 2), 2),
        amount: weightShareRoundedDown(costText, weight, totalWeight, scale),
        source: "allocation" as const,
        hours: null,
        counts: fullTimeRd,
        enteredLate: allocationDays != null && isEnteredLate(allocationDays),
        timelinessText: allocationTimeliness(allocationDays),
      };
    });
    const usesTimesheets = kept.some((share) => share.source === "timesheet");
    const timesheetShares = shares.filter((share) => share.source === "timesheet");
    return {
      ...base,
      allocationEnteredOn: stamp?.entered_on ?? null,
      allocationEnteredByEmail: stamp?.created_by_email ?? null,
      fullTimeRd,
      usesTimesheets,
      shares,
      notRd: toFixedString(sub(cost, sum(shares.map((share) => dec(share.amount)))), scale),
      daysAfterPeriod: allocationShares.length > 0 ? allocationDays : null,
      enteredLate: shares.some((share) => share.enteredLate),
      timelinessText:
        usesTimesheets && allocationShares.length === 0
          ? timesheetShares.find((share) => share.enteredLate)?.timelinessText ?? timesheetShares[0]?.timelinessText ?? "split by approved timesheets"
          : allocationTimeliness(allocationDays),
    };
  });
}

/** A pay approved before timesheets: the allocation the pay run used (decision 67; RD28-RD32). */
function legacyPay(
  base: Omit<RdPay, "allocationEnteredOn" | "allocationEnteredByEmail" | "fullTimeRd" | "usesTimesheets" | "shares" | "notRd" | "daysAfterPeriod" | "enteredLate" | "timelinessText">,
  lines: AllocationRow[],
  cost: Decimal,
  scale: number,
): RdPay {
  const rdLines = lines.filter((line) => line.rd_activity_id != null);
  const fullTimeRd = rdLines.length > 0 && cmp(sum(rdLines.map((line) => dec(line.percentage))), HUNDRED) === 0;
  const enteredOn = lines[0]?.entered_on ?? null;
  const days = enteredOn ? daysBetween(base.periodEnd, enteredOn) : null;
  const late = days != null && isEnteredLate(days);
  const shares: RdPayShare[] = rdLines.map((line) => ({
    activityId: line.rd_activity_id!,
    percentage: toFixedString(dec(line.percentage), 2),
    amount: rdShare(toFixedString(cost, scale), line.percentage, scale),
    source: "allocation",
    hours: null,
    counts: fullTimeRd,
    enteredLate: late,
    timelinessText: allocationTimeliness(days),
  }));
  return {
    ...base,
    allocationEnteredOn: enteredOn,
    allocationEnteredByEmail: lines[0]?.created_by_email ?? null,
    fullTimeRd,
    usesTimesheets: false,
    shares,
    notRd: toFixedString(sub(cost, sum(shares.map((share) => dec(share.amount)))), scale),
    daysAfterPeriod: days,
    enteredLate: late,
    timelinessText: allocationTimeliness(days),
  };
}
