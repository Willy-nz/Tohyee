import { parseIsoDate } from "@/lib/dates";
import { csvCell } from "@/lib/csv";
import { ValidationError } from "@/lib/errors";
import {
  add,
  cmp,
  dec,
  type Decimal,
  divide,
  isZero,
  mul,
  parseDecimalInput,
  roundHalfUp,
  sub,
  sum,
  toFixedString,
  truncate,
  ZERO_DECIMAL,
} from "@/lib/money/decimal";

/**
 * The pure rules of the payroll reports (examples PREP1-PREP8, decisions
 * 102-111): date ranges, months, FTE, grouping labour cost and writing CSV.
 * Browser-safe: no database, no network.
 */

export const PAYROLL_REPORTS = ["labour-cost", "summary", "reconciliation", "headcount", "earnings", "ird"] as const;
export type PayrollReportName = (typeof PAYROLL_REPORTS)[number];

export const PAYROLL_REPORT_TITLES: Record<PayrollReportName, string> = {
  "labour-cost": "Labour cost",
  summary: "Payroll summary",
  reconciliation: "Reconciliation to the ledger",
  headcount: "Headcount and FTE",
  earnings: "Employee earnings history",
  ird: "PAYE, KiwiSaver and student loan",
};

export function parsePayrollReportName(input: unknown): PayrollReportName {
  if (typeof input === "string" && (PAYROLL_REPORTS as readonly string[]).includes(input)) return input as PayrollReportName;
  throw new ValidationError(`Choose a report: ${PAYROLL_REPORTS.join(", ")}.`);
}

export const LABOUR_COST_GROUPS = ["department", "project", "rd_activity", "pay_item", "employee"] as const;
export type LabourCostGroupBy = (typeof LABOUR_COST_GROUPS)[number];

export function parseLabourCostGroupBy(input: unknown): LabourCostGroupBy {
  if (input == null || input === "") return "department";
  if (typeof input === "string" && (LABOUR_COST_GROUPS as readonly string[]).includes(input)) return input as LabourCostGroupBy;
  throw new ValidationError(`Group labour cost by one of: ${LABOUR_COST_GROUPS.join(", ")}.`);
}

/** At most 5 years of pay dates (decision 111). */
export const MAX_REPORT_YEARS = 5;

/** Checks a from/to range of pay dates (PREP8). */
export function assertReportRange(from: string, to: string): void {
  if (from > to) throw new ValidationError("The start date must be on or before the end date.");
  const [year, month, day] = from.split("-").map(Number);
  const limit = new Date(Date.UTC(year + MAX_REPORT_YEARS, month - 1, day)).toISOString().slice(0, 10);
  if (to >= limit) throw new ValidationError(`Choose ${MAX_REPORT_YEARS} years or less.`);
}

export type ReportMonth = { month: string; start: string; end: string };

function lastDayOf(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** Calendar months that overlap `from` to `to`, each from its 1st to its last day (PREP5, PREP7). */
export function monthsBetween(fromInput: string, toInput: string): ReportMonth[] {
  const from = parseIsoDate(fromInput, "from");
  const to = parseIsoDate(toInput, "to");
  assertReportRange(from, to);
  const months: ReportMonth[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  for (;;) {
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    if (start > to) break;
    months.push({ month: start.slice(0, 7), start, end: lastDayOf(year, month) });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

export const DEFAULT_STANDARD_WEEK = "40.00";
const MAX_WEEK = dec("168");
const ONE = dec("1");
const HUNDRED = dec("100");

/** The standard week for FTE: more than 0, at most 168 hours, 2 decimals; 40.00 unless given (decision 107). */
export function parseStandardWeek(input: unknown): string {
  if (input == null || input === "") return DEFAULT_STANDARD_WEEK;
  const value = dec(parseDecimalInput(input, "Standard week", { maxScale: 2 }));
  if (cmp(value, MAX_WEEK) > 0) throw new ValidationError("Standard week can't be more than 168 hours.");
  return toFixedString(value, 2);
}

/**
 * An employee's FTE (decision 107): usual weekly hours ÷ the standard week,
 * rounded half up to 4 places, at most 1.0000. No usual hours (a salary)
 * counts as 1.0000, assumed.
 */
export function fteFor(usualHours: string | null, standardWeek: string): { fte: string; assumed: boolean } {
  if (usualHours === null) return { fte: "1.0000", assumed: true };
  const exact = divide(dec(usualHours), dec(standardWeek), 10);
  const capped = cmp(exact, ONE) > 0 ? ONE : exact;
  return { fte: toFixedString(roundHalfUp(capped, 4), 4), assumed: false };
}

/**
 * Splits a figure by percentages totalling 100 into parts with `places`
 * decimals that add back to it exactly: each part cut towards zero, the
 * leftover units to the largest parts cut off, the earlier first on a tie
 * (PE3's rule, at any scale). Used for FTE by Department (PREP5).
 */
export function splitToPlaces(value: string, percentages: readonly string[], places: number): string[] {
  const whole = dec(value);
  const unit = dec(places === 0 ? "1" : `0.${"0".repeat(places - 1)}1`);
  const exact = percentages.map((percentage) => divide(mul(whole, dec(percentage)), HUNDRED, places + 6));
  const parts = exact.map((share) => truncate(share, places));
  const cutOff = exact.map((share, index) => sub(share, parts[index]));
  let leftOver = sub(whole, sum(parts));
  const order = cutOff.map((remainder, index) => ({ remainder, index })).sort((a, b) => cmp(b.remainder, a.remainder) || a.index - b.index);
  for (const { index } of order) {
    if (cmp(leftOver, unit) < 0) break;
    parts[index] = add(parts[index], unit);
    leftOver = sub(leftOver, unit);
  }
  return parts.map((part) => toFixedString(part, places));
}

/** One posting (an employee's share of a pay run's debit line) with what it's grouped by (PREP1, PREP2). */
export type LabourCostRow = {
  amount: string;
  payItemId: string;
  payItemName: string;
  isReimbursement: boolean;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  /** null: no R&D activity; "unrecorded": approved before timesheets (decision 104). */
  rdActivityId: string | null;
  rdActivityName: string | null;
  employeeId: string;
  employeeName: string;
};

export const UNRECORDED_RD = "unrecorded";

export type LabourCostGroup = {
  /** The record id grouped by, or null for "No …". */
  key: string | null;
  label: string;
  /** By pay item id. */
  amounts: Record<string, string>;
  total: string;
};

const NONE_LABELS: Record<LabourCostGroupBy, string> = {
  department: "No Department",
  project: "No project",
  rd_activity: "No R&D activity",
  pay_item: "No pay item",
  employee: "No employee",
};

function groupKey(row: LabourCostRow, groupBy: LabourCostGroupBy): { key: string | null; label: string } {
  switch (groupBy) {
    case "department":
      return row.departmentId ? { key: row.departmentId, label: row.departmentName ?? "Department" } : { key: null, label: NONE_LABELS.department };
    case "project":
      return row.projectId ? { key: row.projectId, label: row.projectName ?? "Project" } : { key: null, label: NONE_LABELS.project };
    case "rd_activity":
      if (row.rdActivityId === UNRECORDED_RD) return { key: UNRECORDED_RD, label: "Not recorded (pay run approved before timesheets)" };
      return row.rdActivityId ? { key: row.rdActivityId, label: row.rdActivityName ?? "R&D activity" } : { key: null, label: NONE_LABELS.rd_activity };
    case "pay_item":
      return { key: row.payItemId, label: row.payItemName };
    case "employee":
      return { key: row.employeeId, label: row.employeeName };
  }
}

/**
 * Labour cost grouped (PREP1, PREP2): reimbursements are left out and
 * totalled on their own (decision 103). Groups in label order with the
 * "No …" group last (and "Not recorded" before it); a column per pay item in
 * `payItemOrder`'s order, only those with an amount.
 */
export function groupLabourCost(
  rows: readonly LabourCostRow[],
  groupBy: LabourCostGroupBy,
  payItemOrder: readonly string[],
): { groups: LabourCostGroup[]; payItemIds: string[]; totals: Record<string, string>; total: string; reimbursements: string } {
  const groups = new Map<string, { key: string | null; label: string; amounts: Map<string, Decimal> }>();
  const totals = new Map<string, Decimal>();
  let reimbursements: Decimal = ZERO_DECIMAL;
  for (const row of rows) {
    const amount = dec(row.amount);
    if (row.isReimbursement) {
      reimbursements = add(reimbursements, amount);
      continue;
    }
    const { key, label } = groupKey(row, groupBy);
    const id = key ?? "";
    const group = groups.get(id) ?? { key, label, amounts: new Map<string, Decimal>() };
    group.amounts.set(row.payItemId, add(group.amounts.get(row.payItemId) ?? ZERO_DECIMAL, amount));
    groups.set(id, group);
    totals.set(row.payItemId, add(totals.get(row.payItemId) ?? ZERO_DECIMAL, amount));
  }
  const rank = new Map(payItemOrder.map((id, index) => [id, index]));
  const payItemIds = [...totals.keys()]
    .filter((id) => !isZero(totals.get(id)!))
    .sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
  const position = (group: { key: string | null }) => (group.key === null ? 2 : group.key === UNRECORDED_RD ? 1 : 0);
  const ordered = [...groups.values()].sort(
    (a, b) => position(a) - position(b) || a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || (a.key ?? "").localeCompare(b.key ?? ""),
  );
  const money = (value: Decimal) => toFixedString(value, 2);
  return {
    groups: ordered.map((group) => ({
      key: group.key,
      label: group.label,
      amounts: Object.fromEntries(payItemIds.filter((id) => group.amounts.has(id)).map((id) => [id, money(group.amounts.get(id)!)])),
      total: money(sum([...group.amounts.values()])),
    })),
    payItemIds,
    totals: Object.fromEntries(payItemIds.map((id) => [id, money(totals.get(id)!)])),
    total: money(sum([...totals.values()])),
    reimbursements: money(reimbursements),
  };
}

/** An employee's figures as approving stored them (PRUN1), added up (PREP3, PREP6). */
export type PayFigures = {
  gross: string;
  taxableEarnings: string;
  nonTaxableEarnings: string;
  paye: string;
  studentLoan: string;
  kiwiSaverEmployee: string;
  deductions: string;
  netPay: string;
  kiwiSaverEmployer: string;
  esct: string;
  kiwiSaverEmployerNet: string;
  employerCost: string;
};

export const PAY_FIGURE_KEYS: ReadonlyArray<keyof PayFigures> = [
  "gross",
  "taxableEarnings",
  "nonTaxableEarnings",
  "paye",
  "studentLoan",
  "kiwiSaverEmployee",
  "deductions",
  "netPay",
  "kiwiSaverEmployer",
  "esct",
  "kiwiSaverEmployerNet",
  "employerCost",
];

export const PAY_FIGURE_LABELS: Record<keyof PayFigures, string> = {
  gross: "Gross",
  taxableEarnings: "Taxable earnings",
  nonTaxableEarnings: "Not taxable",
  paye: "PAYE (incl. ACC earners' levy)",
  studentLoan: "Student loan",
  kiwiSaverEmployee: "KiwiSaver employee",
  deductions: "Other deductions",
  netPay: "Net pay",
  kiwiSaverEmployer: "KiwiSaver employer (gross)",
  esct: "ESCT",
  kiwiSaverEmployerNet: "KiwiSaver employer, net of ESCT",
  employerCost: "Employer cost",
};

/** One CSV cell (decision 109): shared with every export in `@/lib/csv`. */
export { csvCell };

/** Rows to CSV text, CR LF after every line (decision 109). */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return rows.map((row) => `${row.map(csvCell).join(",")}\r\n`).join("");
}
