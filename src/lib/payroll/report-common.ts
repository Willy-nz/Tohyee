import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { add, dec, type Decimal, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { PAY_ITEM_KIND_ORDER_SQL } from "@/lib/payroll/pay-items";
import { payRunReference } from "@/lib/payroll/pay-runs";
import { assertReportRange, PAY_FIGURE_KEYS, type PayFigures } from "@/lib/payroll/report-figures";

export { PAY_FIGURE_KEYS, PAY_FIGURE_LABELS, type PayFigures } from "@/lib/payroll/report-figures";
import { parseReportPeriod } from "@/lib/reports/account-transactions";
import { valueWithDescendants } from "@/lib/tracking/service";
import { optionalId } from "@/lib/validation";

/**
 * What the payroll reports share (decisions 102-111): the pay date range,
 * the filters, the voided pay runs listed as "not counted", and pay item
 * order. Callers check payroll access first.
 */

export type ReportInput = Record<string, unknown>;

/** Pay dates from `from` to `to`: `to` defaults to today and `from` to the start of its financial year (decision 102). */
export async function parseReportDates(tx: OrgTx, input: ReportInput): Promise<{ from: string; to: string }> {
  const { from, to } = await parseReportPeriod(tx, input.from, input.to);
  assertReportRange(from, to);
  return { from, to };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalUuid(input: unknown, label: string): string | null {
  if (input == null || input === "") return null;
  if (typeof input !== "string" || !UUID.test(input.trim())) throw new ValidationError(`${label} must be an id.`);
  return input.trim().toLowerCase();
}

export type ReportFilters = {
  departmentId: string | null;
  /** The Department and every value under it. */
  departmentIds: string[];
  projectId: string | null;
  rdActivityId: string | null;
  employeeId: string | null;
  payItemId: string | null;
};

/** The filters given, each checked to exist (PREP1, PREP8). */
export async function parseReportFilters(tx: OrgTx, input: ReportInput): Promise<ReportFilters> {
  const departmentId = optionalId(input.departmentId, "departmentId");
  const projectId = optionalId(input.projectId, "projectId");
  const rdActivityId = optionalUuid(input.rdActivityId, "rdActivityId");
  const employeeId = optionalUuid(input.employeeId, "employeeId");
  const payItemId = optionalUuid(input.payItemId, "payItemId");
  const exists = async (sql: string, id: string | null, what: string) => {
    if (id === null) return;
    const found = await tx.query(sql, [id]);
    if (found.rows.length === 0) throw new NotFoundError(`That ${what} wasn't found.`);
  };
  await exists(
    "select 1 from tracking_values v join tracking_categories c on c.id = v.category_id where v.id = $1 and c.kind = 'department'",
    departmentId,
    "Department",
  );
  await exists("select 1 from projects where id = $1", projectId, "project");
  await exists("select 1 from rd_activities where id = $1", rdActivityId, "R&D activity");
  await exists("select 1 from payroll_employees where id = $1", employeeId, "employee");
  await exists("select 1 from payroll_pay_items where id = $1", payItemId, "pay item");
  return {
    departmentId,
    departmentIds: departmentId ? await valueWithDescendants(tx, departmentId) : [],
    projectId,
    rdActivityId,
    employeeId,
    payItemId,
  };
}

/** A voided pay run paid in the dates, listed as "voided, not counted" (decision 102). */
export type VoidedPayRun = { payRunId: string; reference: string; payGroupName: string; payDate: string; voidDate: string; employeeIds: string[] };

export async function voidedPayRuns(tx: OrgTx, from: string, to: string, employeeId: string | null = null): Promise<VoidedPayRun[]> {
  const result = await tx.query<{ id: string; run_number: string; pay_group_name: string; pay_date: string; void_date: string; employee_ids: string[] }>(
    `select r.id::text, r.run_number::text, g.name as pay_group_name, r.pay_date::text, r.void_date::text,
            array(select e.employee_id::text from payroll_pay_run_employees e where e.pay_run_id = r.id order by e.employee_id) as employee_ids
       from payroll_pay_runs r join payroll_pay_groups g on g.id = r.pay_group_id
      where r.status = 'voided' and r.pay_date between $1 and $2
        and ($3::uuid is null or exists (select 1 from payroll_pay_run_employees e where e.pay_run_id = r.id and e.employee_id = $3))
      order by r.pay_date, r.run_number`,
    [from, to, employeeId],
  );
  return result.rows.map((row) => ({
    payRunId: row.id,
    reference: payRunReference(row.run_number),
    payGroupName: row.pay_group_name,
    payDate: row.pay_date,
    voidDate: row.void_date,
    employeeIds: row.employee_ids,
  }));
}

/** Pay items in the pay runs' order: category, kind, then name (as the journal's lines). */
export async function payItemsInOrder(tx: OrgTx): Promise<Array<{ id: string; name: string; category: string; kind: string; accountId: string | null }>> {
  const result = await tx.query<{ id: string; name: string; category: string; kind: string; account_id: string | null }>(
    `select id::text, name, category, kind, account_id::text from payroll_pay_items
      order by array_position(array['earnings', 'deduction', 'employer_contribution'], category),
               array_position(${PAY_ITEM_KIND_ORDER_SQL}, kind),
               lower(name), payroll_pay_items.id`,
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, category: row.category, kind: row.kind, accountId: row.account_id }));
}

/** The stored columns of payroll_pay_run_employees, in PayFigures order. */
export const PAY_FIGURE_COLUMNS = `pe.gross::text as gross, pe.taxable_earnings::text as taxable_earnings,
  pe.non_taxable_earnings::text as non_taxable_earnings, pe.paye::text as paye, pe.student_loan_deduction::text as student_loan,
  pe.kiwisaver_employee::text as kiwisaver_employee, pe.deductions::text as deductions, pe.net_pay::text as net_pay,
  pe.kiwisaver_employer::text as kiwisaver_employer, pe.esct::text as esct, pe.kiwisaver_employer_net::text as kiwisaver_employer_net,
  pe.employer_cost::text as employer_cost`;

export type PayFigureRow = {
  gross: string | null;
  taxable_earnings: string | null;
  non_taxable_earnings: string | null;
  paye: string | null;
  student_loan: string | null;
  kiwisaver_employee: string | null;
  deductions: string | null;
  net_pay: string | null;
  kiwisaver_employer: string | null;
  esct: string | null;
  kiwisaver_employer_net: string | null;
  employer_cost: string | null;
};

const ROW_KEYS: Record<keyof PayFigures, keyof PayFigureRow> = {
  gross: "gross",
  taxableEarnings: "taxable_earnings",
  nonTaxableEarnings: "non_taxable_earnings",
  paye: "paye",
  studentLoan: "student_loan",
  kiwiSaverEmployee: "kiwisaver_employee",
  deductions: "deductions",
  netPay: "net_pay",
  kiwiSaverEmployer: "kiwisaver_employer",
  esct: "esct",
  kiwiSaverEmployerNet: "kiwisaver_employer_net",
  employerCost: "employer_cost",
};

/** Adds stored figures up, 2 decimals. */
export function addFigures(rows: readonly PayFigureRow[]): PayFigures {
  const totals = {} as PayFigures;
  for (const key of PAY_FIGURE_KEYS) {
    const values: Decimal[] = rows.map((row) => dec(row[ROW_KEYS[key]] ?? "0"));
    totals[key] = toFixedString(values.length ? sum(values) : ZERO_DECIMAL, 2);
  }
  return totals;
}

export function sumFigures(list: readonly PayFigures[]): PayFigures {
  const totals = {} as PayFigures;
  for (const key of PAY_FIGURE_KEYS) totals[key] = toFixedString(list.reduce((total, figures) => add(total, dec(figures[key])), ZERO_DECIMAL), 2);
  return totals;
}

export function money(value: Decimal): string {
  return toFixedString(value, 2);
}
