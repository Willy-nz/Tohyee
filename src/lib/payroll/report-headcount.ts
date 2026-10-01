import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { add, cmp, dec, type Decimal, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { parseReportFilters, type ReportInput } from "@/lib/payroll/report-common";
import { assertReportRange, fteFor, monthsBetween, parseStandardWeek, splitToPlaces } from "@/lib/payroll/report-figures";
import { financialYearStart } from "@/lib/financial-year";
import { financialYearEndMonth } from "@/lib/reports/financial";

/**
 * Headcount and FTE (PREP5, decision 107): who's employed on a date (start
 * and finish dates), their FTE from the usual weekly hours of the pay rate
 * in effect then over a standard week (salaries count 1, assumed), split
 * by the cost allocation in effect then; and the same at each month's end,
 * with starters, leavers and who was paid in the month. Read-only.
 */

export type HeadcountEmployee = {
  employeeId: string;
  name: string;
  payBasis: "salary" | "hourly";
  usualHours: string | null;
  fte: string;
  assumed: boolean;
  /** The biggest line's Department (headcount goes there). */
  primaryDepartmentId: string | null;
  departments: Array<{ departmentId: string | null; name: string; percentage: string; fte: string }>;
  archivedWithoutFinish: boolean;
};

export type HeadcountDepartment = { departmentId: string | null; name: string; headcount: number; fte: string };

export type HeadcountMonth = {
  month: string;
  start: string;
  end: string;
  headcount: number;
  fte: string;
  started: string[];
  finished: string[];
  /** Employees on approved pay runs paid in the month. */
  paid: number;
};

export type HeadcountReport = {
  date: string;
  standardWeek: string;
  from: string;
  to: string;
  employees: HeadcountEmployee[];
  headcount: number;
  fte: string;
  departments: HeadcountDepartment[];
  months: HeadcountMonth[];
};

type EmployeeRow = {
  id: string;
  name: string;
  start_date: string;
  finish_date: string | null;
  is_archived: boolean;
  pay_basis: "salary" | "hourly";
  hours: string | null;
};
type RateRow = { employee_id: string; effective_from: string; pay_basis: "salary" | "hourly"; hours: string | null };
type AllocationLineRow = { employee_id: string; allocation_id: string; effective_from: string; percentage: string; department_id: string | null; department_name: string | null };

const NO_DEPARTMENT = "No Department";

export async function headcountReport(tx: OrgTx, input: ReportInput): Promise<HeadcountReport> {
  await requirePayrollAccess(tx);
  const date = parseOptionalIsoDate(input.date, "date") ?? todayIsoDate();
  const standardWeek = parseStandardWeek(input.standardWeek);
  const to = parseOptionalIsoDate(input.to, "to") ?? date;
  const from = parseOptionalIsoDate(input.from, "from") ?? financialYearStart(to, await financialYearEndMonth(tx));
  assertReportRange(from, to);
  const filters = await parseReportFilters(tx, { departmentId: input.departmentId, employeeId: input.employeeId });

  const employees = (
    await tx.query<EmployeeRow>(
      `select id::text, first_name || ' ' || last_name as name, start_date::text, finish_date::text, is_archived, pay_basis,
              ordinary_hours_per_week::text as hours
         from payroll_employees where ($1::uuid is null or id = $1)`,
      [filters.employeeId],
    )
  ).rows;
  // Rates and allocations, latest first for each date's lookup (PE7: by effective date, then the last entered).
  const rates = (
    await tx.query<RateRow>(
      `select employee_id::text, effective_from::text, pay_basis, ordinary_hours_per_week::text as hours
         from payroll_pay_rates order by effective_from desc, entry_number desc`,
    )
  ).rows;
  const allocationLines = (
    await tx.query<AllocationLineRow>(
      `select a.employee_id::text, a.id::text as allocation_id, a.effective_from::text, l.percentage::text, l.department_id::text,
              d.name as department_name
         from payroll_cost_allocations a
         join payroll_cost_allocation_lines l on l.allocation_id = a.id
         left join tracking_values d on d.id = l.department_id
        order by a.effective_from desc, a.entry_number desc, l.line_number`,
    )
  ).rows;
  const paidRows = (
    await tx.query<{ pay_date: string; employee_id: string }>(
      `select distinct r.pay_date::text, e.employee_id::text
         from payroll_pay_runs r join payroll_pay_run_employees e on e.pay_run_id = r.id
        where r.status = 'approved' and r.pay_date between $1 and $2`,
      [from, to],
    )
  ).rows;

  const rateOn = (employee: EmployeeRow, on: string) => {
    const rate = rates.find((row) => row.employee_id === employee.id && row.effective_from <= on);
    return rate ? { payBasis: rate.pay_basis, hours: rate.hours } : { payBasis: employee.pay_basis, hours: employee.hours };
  };
  const allocationOn = (employeeId: string, on: string) => {
    const first = allocationLines.find((row) => row.employee_id === employeeId && row.effective_from <= on);
    return first ? allocationLines.filter((row) => row.allocation_id === first.allocation_id) : [];
  };
  const employedOn = (employee: EmployeeRow, on: string) => employee.start_date <= on && (employee.finish_date === null || employee.finish_date >= on);
  const primaryOn = (employeeId: string, on: string): string | null => {
    const lines = allocationOn(employeeId, on);
    let best: AllocationLineRow | null = null;
    for (const line of lines) if (!best || cmp(dec(line.percentage), dec(best.percentage)) > 0) best = line;
    return best?.department_id ?? null;
  };
  const inDepartment = (employeeId: string, on: string) => {
    if (!filters.departmentId) return true;
    const primary = primaryOn(employeeId, on);
    return primary !== null && filters.departmentIds.includes(primary);
  };

  const snapshot = (on: string): HeadcountEmployee[] =>
    employees
      .filter((employee) => employedOn(employee, on) && inDepartment(employee.id, on))
      .map((employee) => {
        const rate = rateOn(employee, on);
        const usualHours = rate.payBasis === "hourly" && rate.hours !== null ? toFixedString(dec(rate.hours), 2) : null;
        const { fte, assumed } = fteFor(usualHours, standardWeek);
        // A Department's share is the sum of its lines (a Department on two lines, say with two projects, counts once).
        const shares = new Map<string, { departmentId: string | null; name: string; percentage: Decimal }>();
        for (const line of allocationOn(employee.id, on)) {
          const id = line.department_id ?? "";
          const entry = shares.get(id) ?? { departmentId: line.department_id, name: line.department_name ?? NO_DEPARTMENT, percentage: ZERO_DECIMAL };
          entry.percentage = add(entry.percentage, dec(line.percentage));
          shares.set(id, entry);
        }
        if (shares.size === 0) shares.set("", { departmentId: null, name: NO_DEPARTMENT, percentage: dec("100") });
        const list = [...shares.values()];
        const split = splitToPlaces(fte, list.map((entry) => toFixedString(entry.percentage, 2)), 4);
        return {
          employeeId: employee.id,
          name: employee.name,
          payBasis: rate.payBasis,
          usualHours,
          fte,
          assumed,
          primaryDepartmentId: primaryOn(employee.id, on),
          departments: list.map((entry, index) => ({
            departmentId: entry.departmentId,
            name: entry.name,
            percentage: toFixedString(entry.percentage, 2),
            fte: split[index],
          })),
          archivedWithoutFinish: employee.is_archived && employee.finish_date === null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.employeeId.localeCompare(b.employeeId));

  const totalFte = (list: HeadcountEmployee[]) => toFixedString(list.length ? sum(list.map((entry) => dec(entry.fte))) : ZERO_DECIMAL, 4);

  const atDate = snapshot(date);
  const departments = new Map<string, { departmentId: string | null; name: string; headcount: number; fte: Decimal }>();
  for (const employee of atDate) {
    for (const share of employee.departments) {
      const id = share.departmentId ?? "";
      const entry = departments.get(id) ?? { departmentId: share.departmentId, name: share.name, headcount: 0, fte: ZERO_DECIMAL };
      entry.fte = add(entry.fte, dec(share.fte));
      departments.set(id, entry);
    }
    const primary = employee.primaryDepartmentId ?? "";
    const entry = departments.get(primary) ?? { departmentId: employee.primaryDepartmentId, name: NO_DEPARTMENT, headcount: 0, fte: ZERO_DECIMAL };
    entry.headcount += 1;
    departments.set(primary, entry);
  }

  const names = new Map(employees.map((employee) => [employee.id, employee.name]));
  const months = monthsBetween(from, to).map((month) => {
    const atEnd = snapshot(month.end);
    const within = (value: string | null) => value !== null && value >= month.start && value <= month.end;
    const started = employees.filter((employee) => within(employee.start_date) && inDepartment(employee.id, employee.start_date));
    const finished = employees.filter((employee) => within(employee.finish_date) && inDepartment(employee.id, employee.finish_date!));
    const paid = new Set(
      paidRows
        .filter((row) => row.pay_date >= month.start && row.pay_date <= month.end && names.has(row.employee_id) && inDepartment(row.employee_id, row.pay_date))
        .map((row) => row.employee_id),
    );
    const sorted = (list: EmployeeRow[]) => list.map((employee) => employee.name).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    return {
      month: month.month,
      start: month.start,
      end: month.end,
      headcount: atEnd.length,
      fte: totalFte(atEnd),
      started: sorted(started),
      finished: sorted(finished),
      paid: paid.size,
    };
  });

  return {
    date,
    standardWeek,
    from,
    to,
    employees: atDate,
    headcount: atDate.length,
    fte: totalFte(atDate),
    departments: [...departments.values()]
      .map((entry) => ({ departmentId: entry.departmentId, name: entry.name, headcount: entry.headcount, fte: toFixedString(entry.fte, 4) }))
      .sort((a, b) => (a.departmentId === null ? 1 : 0) - (b.departmentId === null ? 1 : 0) || a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
    months,
  };
}

