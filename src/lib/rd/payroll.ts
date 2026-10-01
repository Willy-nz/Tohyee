import type { OrgTx } from "@/lib/db/org-transaction";
import { payRunReference } from "@/lib/payroll/pay-runs";
import { add, cmp, dec, sub, sum, toFixedString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";
import { daysBetween, isEnteredLate, rdShare } from "@/lib/rd/amounts";
import { rdSettings, timeZone } from "@/lib/rd/common";

/**
 * Pay as R&D employee costs (examples RD7, RD28-RD32; decisions 34, 36, 37,
 * 50, 56, 57). Timesheets (P9) aren't built, so a pay's R&D share comes from
 * the cost allocation the pay run used: the employee's latest allocation
 * effective on the pay date that was entered before the pay run was
 * approved. It counts only when that allocation is 100% R&D; any other split
 * is "default split, no time record" and left out. Each R&D share is rounded
 * down to the cent; the rest is non-R&D. Reads posted pay runs only and
 * calculates no pay. Per-employee figures are payroll details: callers show
 * them only to people with payroll access (decision 6).
 */

/** Pay item kinds that are employee costs IRD lists (IR1240 p 63; decision 56). */
export const RD_PAY_ITEM_KINDS = ["ordinary_time", "overtime", "allowance", "holiday_pay", "kiwisaver_employer"] as const;

export type RdPayShare = {
  activityId: string;
  percentage: string;
  amount: string;
};

export type RdPay = {
  payRunId: string;
  payRunReference: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  employeeId: string;
  employeeName: string;
  /** Pay items IRD lists, as posted (decision 56). */
  cost: string;
  /** Posted but not an employee cost (reimbursements). */
  excluded: string;
  allocationEnteredOn: string | null;
  allocationEnteredByEmail: string | null;
  /** The allocation's R&D lines total 100% (decision 34). */
  fullTimeRd: boolean;
  shares: RdPayShare[];
  notRd: string;
  daysAfterPeriod: number | null;
  enteredLate: boolean;
  timelinessText: string;
};

type PayRow = {
  pay_run_id: string;
  run_number: string;
  pay_date: string;
  period_start: string;
  period_end: string;
  employee_id: string;
  employee_name: string | null;
  kind: string;
  amount: string;
};

type AllocationRow = {
  pay_run_id: string;
  employee_id: string;
  entered_on: string;
  created_by_email: string;
  percentage: string;
  rd_activity_id: string | null;
};

function timelinessText(days: number | null): string {
  if (days == null) return "no cost allocation: not R&D";
  if (days <= 0) return "allocation entered before the pay period ended";
  return `allocation entered ${days} day${days === 1 ? "" : "s"} after the pay period`;
}

/** Approved pay runs paid `start` to `end`, each employee's pay with its R&D shares. */
export async function loadRdPays(tx: OrgTx, start: string, end: string): Promise<RdPay[]> {
  const settings = await rdSettings(tx);
  const scale = settings.scale;
  const rows = (
    await tx.query<PayRow>(
      `select r.id::text as pay_run_id, r.run_number::text, r.pay_date::text, r.period_start::text, r.period_end::text,
              p.employee_id::text, e.employee_name, i.kind, sum(p.amount)::text as amount
         from payroll_pay_runs r
         join payroll_pay_run_postings p on p.pay_run_id = r.id
         join payroll_pay_items i on i.id = p.pay_item_id
         join payroll_pay_run_employees e on e.pay_run_id = r.id and e.employee_id = p.employee_id
        where r.status = 'approved' and r.pay_date between $1 and $2
        group by r.id, r.run_number, r.pay_date, r.period_start, r.period_end, p.employee_id, e.employee_name, i.kind
        order by r.pay_date, r.run_number, e.employee_name, p.employee_id`,
      [start, end],
    )
  ).rows;
  if (rows.length === 0) return [];
  const allocations = (
    await tx.query<AllocationRow>(
      `with pays as (
         select distinct r.id as pay_run_id, r.approved_at, r.pay_date, e.employee_id
           from payroll_pay_runs r join payroll_pay_run_employees e on e.pay_run_id = r.id
          where r.status = 'approved' and r.pay_date between $1 and $2
       )
       select pays.pay_run_id::text, pays.employee_id::text, to_char((alloc.created_at at time zone $3)::date, 'YYYY-MM-DD') as entered_on,
              alloc.created_by_email, l.percentage::text, l.rd_activity_id::text
         from pays
         cross join lateral (
           select a.id, a.created_at, a.created_by_email from payroll_cost_allocations a
            where a.employee_id = pays.employee_id and a.effective_from <= pays.pay_date and a.created_at <= pays.approved_at
            order by a.effective_from desc, a.entry_number desc limit 1
         ) alloc
         join payroll_cost_allocation_lines l on l.allocation_id = alloc.id
        order by l.line_number`,
      [start, end, timeZone()],
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
    const lines = allocations.filter((line) => `${line.pay_run_id}|${line.employee_id}` === id);
    const rdLines = lines.filter((line) => line.rd_activity_id != null);
    const rdPercent = sum(rdLines.map((line) => dec(line.percentage)));
    const shares = rdLines.map((line) => ({
      activityId: line.rd_activity_id!,
      percentage: toFixedString(dec(line.percentage), 2),
      amount: rdShare(toFixedString(cost, scale), line.percentage, scale),
    }));
    const notRd = sub(cost, sum(shares.map((share) => dec(share.amount))));
    const enteredOn = lines[0]?.entered_on ?? null;
    const days = enteredOn ? daysBetween(row.period_end, enteredOn) : null;
    return {
      payRunId: row.pay_run_id,
      payRunReference: payRunReference(row.run_number),
      payDate: row.pay_date,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      employeeId: row.employee_id,
      employeeName: row.employee_name ?? "Employee",
      cost: toFixedString(cost, scale),
      excluded: toFixedString(excluded, scale),
      allocationEnteredOn: enteredOn,
      allocationEnteredByEmail: lines[0]?.created_by_email ?? null,
      fullTimeRd: rdLines.length > 0 && cmp(rdPercent, dec("100")) === 0,
      shares,
      notRd: toFixedString(notRd, scale),
      daysAfterPeriod: days,
      enteredLate: days != null && isEnteredLate(days),
      timelinessText: timelinessText(days),
    };
  });
}
