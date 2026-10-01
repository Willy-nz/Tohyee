import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { PAY_FIGURE_KEYS, PAY_FIGURE_LABELS, type PayFigures, type ReportInput } from "@/lib/payroll/report-common";
import { type LabourCostGroupBy, parsePayrollReportName, type PayrollReportName, toCsv } from "@/lib/payroll/report-figures";
import { type PayrollReport, runPayrollReport } from "@/lib/payroll/reports";

/**
 * A payroll report as CSV (PREP8, decision 109): the rows shown, amounts as
 * plain numbers. Exporting writes one audit event with the report, dates,
 * the filters' record ids, the number of rows and the file's SHA-256, never
 * an amount or a name. Posts nothing.
 */

type Cell = string | number | null;

const GROUP_HEADINGS: Record<LabourCostGroupBy, string> = {
  department: "Department",
  project: "Project",
  rd_activity: "R&D activity",
  pay_item: "Pay item",
  employee: "Employee",
};

const figureCells = (figures: PayFigures): Cell[] => PAY_FIGURE_KEYS.map((key) => figures[key]);
const FIGURE_HEADINGS = PAY_FIGURE_KEYS.map((key) => PAY_FIGURE_LABELS[key]);

/** The header row(s) and data rows of a report. Section headings count as headers, not rows. */
function tableOf(result: PayrollReport): { rows: Cell[][]; headerRows: number } {
  switch (result.report) {
    case "labour-cost": {
      const data = result.data;
      const header = [GROUP_HEADINGS[data.groupBy], ...data.payItems.map((item) => item.name), "Labour cost"];
      const rows: Cell[][] = data.groups.map((group) => [group.label, ...data.payItems.map((item) => group.amounts[item.id] ?? null), group.total]);
      rows.push(["Total", ...data.payItems.map((item) => data.totals[item.id] ?? null), data.total]);
      rows.push(["Reimbursements (not labour cost)", ...data.payItems.map(() => null), data.reimbursements]);
      return { rows: [header, ...rows], headerRows: 1 };
    }
    case "summary": {
      const data = result.data;
      const header = ["Pay date", "Pay run", "Pay group", "Period start", "Period end", "Employees", ...FIGURE_HEADINGS];
      const rows: Cell[][] = data.payRuns.map((run) => [run.payDate, run.reference, run.payGroupName, run.periodStart, run.periodEnd, run.employeeCount, ...figureCells(run.figures)]);
      rows.push(["Total", null, null, null, null, data.totals.employeeCount, ...figureCells(data.totals)]);
      return { rows: [header, ...rows], headerRows: 1 };
    }
    case "reconciliation": {
      const header = ["Account code", "Account", "Payroll", "Ledger", "Difference", "Not explained", "Journal date", "Journal", "Explained by", "Amount"];
      const rows: Cell[][] = [];
      for (const account of result.data.accounts) {
        rows.push([account.code, account.name, account.payroll, account.ledger, account.difference, account.unexplained, null, null, null, null]);
        for (const journal of account.journals) rows.push([account.code, null, null, null, null, null, journal.date, journal.reference, journal.label, journal.amount]);
      }
      return { rows: [header, ...rows], headerRows: 1 };
    }
    case "headcount": {
      const data = result.data;
      const rows: Cell[][] = [[`At ${data.date}, standard week ${data.standardWeek} hours`], ["Employee", "Pay", "Usual hours", "FTE", "Assumed", "Departments"]];
      for (const employee of data.employees) {
        rows.push([
          employee.name,
          employee.payBasis,
          employee.usualHours,
          employee.fte,
          employee.assumed ? "assumed (salary)" : null,
          employee.departments.map((department) => `${department.name} ${department.percentage}%`).join("; "),
        ]);
      }
      rows.push(["Total", null, null, data.fte, null, `headcount ${data.headcount}`]);
      rows.push(["Department", "Headcount", "FTE"]);
      for (const department of data.departments) rows.push([department.name, department.headcount, department.fte]);
      rows.push(["Month", "Headcount", "FTE", "Started", "Finished", "Paid in the month"]);
      for (const month of data.months) rows.push([month.month, month.headcount, month.fte, month.started.join("; "), month.finished.join("; "), month.paid]);
      return { rows, headerRows: 4 };
    }
    case "earnings": {
      const header = ["Employee", "Pay date", "Pay run", "Pay item", "Kind", "Hours", "Rate", "Amount", ...FIGURE_HEADINGS];
      const rows: Cell[][] = [];
      for (const employee of result.data.employees) {
        for (const pay of employee.pays) {
          for (const line of pay.lines) {
            rows.push([pay.name, pay.payDate, pay.reference, line.description ? `${line.name} (${line.description})` : line.name, line.category, line.quantity, line.rate, line.amount]);
          }
          rows.push([pay.name, pay.payDate, pay.reference, "Pay totals", null, null, null, null, ...figureCells(pay.figures)]);
        }
        rows.push([employee.name, null, null, "Employee totals", null, null, null, null, ...figureCells(employee.totals)]);
      }
      return { rows: [header, ...rows], headerRows: 1 };
    }
    case "ird": {
      const data = result.data;
      const header = [
        "Month",
        "Taxable gross earnings",
        "PAYE",
        "Student loan",
        "KiwiSaver employee",
        "KiwiSaver employer net",
        "ESCT",
        "Total deducted",
        "PAYE paid",
        "Student loan paid",
        "KiwiSaver paid",
        "ESCT paid",
        "Total paid",
        "Total owing",
      ];
      const row = (label: string, month: (typeof data.months)[number] | (typeof data)["totals"]): Cell[] => [
        label,
        month.deducted.taxableEarnings,
        month.deducted.paye,
        month.deducted.studentLoan,
        month.deducted.kiwiSaverEmployee,
        month.deducted.kiwiSaverEmployerNet,
        month.deducted.esct,
        month.deducted.total,
        month.paid?.paye ?? null,
        month.paid?.studentLoan ?? null,
        month.paid?.kiwiSaver ?? null,
        month.paid?.esct ?? null,
        month.paid?.total ?? null,
        month.owing?.total ?? null,
      ];
      return { rows: [header, ...data.months.map((month) => row(month.month, month)), row("Total", data.totals)], headerRows: 1 };
    }
  }
}

function fileName(name: PayrollReportName, result: PayrollReport): string {
  if (result.report === "headcount") return `payroll-headcount-${result.data.date}.csv`;
  return `payroll-${name}-${result.data.from}-to-${result.data.to}.csv`;
}

/** The filters that shaped the report: record ids and options only (decision 109). */
function filtersOf(name: PayrollReportName, input: ReportInput, result: PayrollReport): Record<string, string> {
  const filters: Record<string, string> = {};
  if (result.report === "labour-cost") filters.groupBy = result.data.groupBy;
  if (result.report === "headcount") {
    filters.date = result.data.date;
    filters.standardWeek = result.data.standardWeek;
  }
  const allowed: Record<PayrollReportName, string[]> = {
    "labour-cost": ["departmentId", "projectId", "rdActivityId", "employeeId", "payItemId"],
    summary: ["employeeId"],
    reconciliation: [],
    headcount: ["departmentId", "employeeId"],
    earnings: ["employeeId", "payItemId"],
    ird: ["employeeId"],
  };
  for (const key of allowed[name]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") filters[key] = value.trim();
  }
  return filters;
}

export type PayrollReportFile = { fileName: string; csv: string; rows: number; sha256: string };

export async function exportPayrollReport(tx: OrgTx, nameInput: unknown, input: ReportInput): Promise<PayrollReportFile> {
  const name = parsePayrollReportName(nameInput);
  const result = await runPayrollReport(tx, name, input);
  const table = tableOf(result);
  const csv = toCsv(table.rows);
  const sha256 = createHash("sha256").update(csv, "utf8").digest("hex");
  const rows = table.rows.length - table.headerRows;
  const file = fileName(name, result);
  await writeAuditEvent(tx, {
    eventType: "payroll_report.exported",
    entityType: "payroll_report",
    entityId: name,
    details: { report: name, from: result.data.from, to: result.data.to, filters: filtersOf(name, input, result), rows, sha256 },
  });
  return { fileName: file, csv, rows, sha256 };
}
