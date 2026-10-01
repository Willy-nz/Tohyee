"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { useRdActivities, activityText } from "@/components/rd";
import { PrintButton } from "@/components/reports/ledger-reports";
import { useTracking } from "@/components/tracking";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { formatDate, formatQuantity, todayInBrowser } from "@/lib/format";
import type { EmployeeSummary } from "@/lib/payroll/employees";
import type { PayItem } from "@/lib/payroll/pay-items";
import {
  LABOUR_COST_GROUPS,
  PAY_FIGURE_KEYS,
  PAY_FIGURE_LABELS,
  PAYROLL_REPORT_TITLES,
  PAYROLL_REPORTS,
  type LabourCostGroupBy,
  type PayFigures,
  type PayrollReportName,
} from "@/lib/payroll/report-figures";
import type {
  EarningsHistoryReport,
  EiFileStatus,
  HeadcountReport,
  IrdDeductionsReport,
  LabourCostReport,
  PayrollReconciliation,
  PayrollSummaryReport,
  VoidedPayRun,
} from "@/lib/payroll/reports";
import type { ProjectSummary } from "@/lib/projects/service";

/**
 * Payroll › Reports (stage P10; examples PREP1-PREP8): labour cost, the
 * payroll summary, the reconciliation to the ledger, headcount and FTE,
 * earnings history and the PAYE, KiwiSaver and student loan summary. Every
 * figure is what approved pay runs stored, by pay date; nothing is posted.
 * Payroll access only (decision 105).
 */

const DESCRIPTIONS: Record<PayrollReportName, string> = {
  "labour-cost":
    "What approved pay runs charged for earnings and employer KiwiSaver, split the way each pay run split it (cost allocation or approved timesheets). Reimbursements are shown on their own line.",
  summary: "Each approved pay run, gross to net, with the employer's KiwiSaver and ESCT, and the totals by pay item.",
  reconciliation:
    "Each payroll account's movement in the ledger against what the pay runs and payroll payments say, with every other journal that explains a difference.",
  headcount: "Who's employed on a date and their FTE (usual weekly hours ÷ the standard week; salaries count as 1, assumed), by Department and by month.",
  earnings: "Each employee's pays: the lines and figures each approved pay run kept, with the name on it.",
  ird: "PAYE, KiwiSaver and student loan by month of pay date: what the pay runs deducted (their employment information files' figures), what was paid to IRD and what's owing.",
};

const GROUP_LABELS: Record<LabourCostGroupBy, string> = {
  department: "Department",
  project: "Project",
  rd_activity: "R&D activity",
  pay_item: "Pay item",
  employee: "Employee",
};

/** Which filters each report takes (decision 105). */
const FILTERS: Record<PayrollReportName, Array<"departmentId" | "projectId" | "rdActivityId" | "employeeId" | "payItemId">> = {
  "labour-cost": ["departmentId", "projectId", "rdActivityId", "employeeId", "payItemId"],
  summary: ["employeeId"],
  reconciliation: [],
  headcount: ["departmentId", "employeeId"],
  earnings: ["employeeId", "payItemId"],
  ird: ["employeeId"],
};

const FILE_TEXT: Record<EiFileStatus, { tone: "green" | "amber" | "neutral"; text: string }> = {
  made: { tone: "green", text: "File made" },
  not_made: { tone: "amber", text: "No employment information file made in Tohyee" },
  voided_after_file: { tone: "amber", text: "Voided after its file was made: amend the employment information in myIR" },
  voided: { tone: "neutral", text: "Voided, no file made" },
};

function monthStart(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

function monthEnd(today: string): string {
  const [year, month] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

async function downloadCsv(body: Record<string, string>): Promise<void> {
  const response = await fetch("/api/payroll/reports/export", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Export failed (${response.status}).`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "payroll-report.csv";
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function Voided({ runs }: { runs: VoidedPayRun[] }) {
  if (runs.length === 0) return null;
  return (
    <p className={ui.muted}>
      Voided pay runs, not counted:{" "}
      {runs.map((run, index) => (
        <Fragment key={run.payRunId}>
          {index > 0 ? ", " : ""}
          <Link href={`/operations/payroll/pay-runs/${run.payRunId}`}>{run.reference}</Link> (paid {formatDate(run.payDate)}, voided {formatDate(run.voidDate)})
        </Fragment>
      ))}
      .
    </p>
  );
}

function FigureRows({ columns }: { columns: Array<{ key: string; label: string; figures: PayFigures }> }) {
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th />
            {columns.map((column) => (
              <th key={column.key} className={ui.num}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PAY_FIGURE_KEYS.map((key) => (
            <tr key={key}>
              <td>{key === "netPay" || key === "employerCost" ? <strong>{PAY_FIGURE_LABELS[key]}</strong> : PAY_FIGURE_LABELS[key]}</td>
              {columns.map((column) => (
                <td key={column.key} className={ui.num}>
                  <Money value={column.figures[key]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LabourCost({ data }: { data: LabourCostReport }) {
  return (
    <>
      <div className={ui.statRow}>
        <Stat label="Labour cost" value={<Money value={data.total} />} />
        <Stat label="Reimbursements (not labour cost)" value={<Money value={data.reimbursements} />} />
        <Stat label="Pay runs counted" value={data.payRuns.length} />
      </div>
      {data.groups.length === 0 ? (
        <Empty>No labour cost matches.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>{GROUP_LABELS[data.groupBy]}</th>
                {data.payItems.map((item) => (
                  <th key={item.id} className={ui.num}>
                    {item.name}
                  </th>
                ))}
                <th className={ui.num}>Labour cost</th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((group) => (
                <tr key={group.key ?? "none"}>
                  <td>{group.label}</td>
                  {data.payItems.map((item) => (
                    <td key={item.id} className={ui.num}>
                      <Money value={group.amounts[item.id]} blankZero />
                    </td>
                  ))}
                  <td className={ui.num}>
                    <Money value={group.total} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                {data.payItems.map((item) => (
                  <td key={item.id} className={ui.num}>
                    <Money value={data.totals[item.id]} />
                  </td>
                ))}
                <td className={ui.num}>
                  <Money value={data.total} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <Voided runs={data.voided} />
    </>
  );
}

function Summary({ data }: { data: PayrollSummaryReport }) {
  if (data.payRuns.length === 0) return <Empty>No approved pay runs were paid in these dates.</Empty>;
  return (
    <>
      <FigureRows
        columns={[
          ...data.payRuns.map((run) => ({ key: run.payRunId, label: `${run.reference} (${formatDate(run.payDate)}, ${run.payGroupName}, ${run.employeeCount})`, figures: run.figures })),
          { key: "total", label: `Total (${data.totals.employeeCount} employee${data.totals.employeeCount === 1 ? "" : "s"})`, figures: data.totals },
        ]}
      />
      <h3>By pay item</h3>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Pay item</th>
              <th className={ui.num}>Hours</th>
              <th className={ui.num}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.payItems.map((item) => (
              <tr key={item.payItemId}>
                <td>
                  {item.name} {item.category === "deduction" ? <span className={ui.muted}>(deduction)</span> : null}
                </td>
                <td className={ui.num}>{item.hours ? formatQuantity(item.hours) : ""}</td>
                <td className={ui.num}>
                  <Money value={item.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Voided runs={data.voided} />
    </>
  );
}

function Reconciliation({ data }: { data: PayrollReconciliation }) {
  return (
    <>
      {data.allExplained ? (
        <Notice tone="success">Every difference is explained by the journals listed.</Notice>
      ) : (
        <Notice tone="warning">
          Some of a difference isn&apos;t explained by a journal. Check whether a pay item&apos;s account was changed after pay runs used the old one.
        </Notice>
      )}
      <p className={ui.muted}>
        Counted: {[...data.counted.payRuns, ...data.counted.wagePayments, ...data.counted.irdPayments].join(", ") || "nothing"}. Expense accounts are
        debits less credits; liability accounts credits less debits.
      </p>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Account</th>
              <th className={ui.num}>Payroll</th>
              <th className={ui.num}>Ledger</th>
              <th className={ui.num}>Difference</th>
              <th>Explained by</th>
              <th className={ui.num}>Not explained</th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((account) => (
              <tr key={account.accountId}>
                <td>
                  {account.code} {account.name}
                </td>
                <td className={ui.num}>
                  <Money value={account.payroll} />
                </td>
                <td className={ui.num}>
                  <Money value={account.ledger} />
                </td>
                <td className={ui.num}>
                  <Money value={account.difference} />
                </td>
                <td>
                  {account.journals.length === 0 ? null : (
                    <ul>
                      {account.journals.map((journal) => (
                        <li key={journal.journalId}>
                          {formatDate(journal.date)} · <Link href={journal.href}>{journal.label}</Link> · <Money value={journal.amount} />
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className={ui.num}>
                  {account.unexplained === "0.00" ? <Money value={account.unexplained} /> : <Badge tone="amber">{account.unexplained}</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Headcount({ data }: { data: HeadcountReport }) {
  return (
    <>
      <div className={ui.statRow}>
        <Stat label={`Headcount at ${formatDate(data.date)}`} value={data.headcount} />
        <Stat label="FTE" value={data.fte} />
        <Stat label="Standard week" value={`${data.standardWeek} hours`} />
      </div>
      {data.employees.length === 0 ? (
        <Empty>Nobody is employed on this date.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Pay</th>
                <th className={ui.num}>Usual hours</th>
                <th className={ui.num}>FTE</th>
                <th>Department</th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((employee) => (
                <tr key={employee.employeeId}>
                  <td>
                    {employee.name} {employee.archivedWithoutFinish ? <Badge tone="amber">Archived but no finish date</Badge> : null}
                  </td>
                  <td>{employee.payBasis === "salary" ? "Salary" : "Hourly"}</td>
                  <td className={ui.num}>{employee.usualHours ?? ""}</td>
                  <td className={ui.num}>
                    {employee.fte} {employee.assumed ? <span className={ui.muted}>(assumed, salary)</span> : null}
                  </td>
                  <td>{employee.departments.map((department) => (employee.departments.length === 1 ? department.name : `${department.name} ${department.percentage}%`)).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>By Department</h3>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Department</th>
              <th className={ui.num}>Headcount</th>
              <th className={ui.num}>FTE</th>
            </tr>
          </thead>
          <tbody>
            {data.departments.map((department) => (
              <tr key={department.departmentId ?? "none"}>
                <td>{department.name}</td>
                <td className={ui.num}>{department.headcount}</td>
                <td className={ui.num}>{department.fte}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={ui.muted}>Headcount goes to each person&apos;s biggest Department; FTE is split by their cost allocation.</p>
      <h3>By month</h3>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Month</th>
              <th className={ui.num}>Headcount</th>
              <th className={ui.num}>FTE</th>
              <th>Started</th>
              <th>Finished</th>
              <th className={ui.num}>Paid in the month</th>
            </tr>
          </thead>
          <tbody>
            {data.months.map((month) => (
              <tr key={month.month}>
                <td>{formatDate(month.end).replace(/^\d+ /, "")}</td>
                <td className={ui.num}>{month.headcount}</td>
                <td className={ui.num}>{month.fte}</td>
                <td>{month.started.join(", ")}</td>
                <td>{month.finished.join(", ")}</td>
                <td className={ui.num}>{month.paid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={ui.muted}>Each month&apos;s headcount and FTE are at its last day.</p>
    </>
  );
}

function Earnings({ data }: { data: EarningsHistoryReport }) {
  if (data.employees.length === 0) return <Empty>No approved pay runs match.</Empty>;
  return (
    <>
      {data.employees.map((employee) => (
        <section key={employee.employeeId}>
          <h3>{employee.name}</h3>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Pay date</th>
                  <th>Pay run</th>
                  <th>Pay item</th>
                  <th className={ui.num}>Hours</th>
                  <th className={ui.num}>Rate</th>
                  <th className={ui.num}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {employee.pays.map((pay) =>
                  pay.lines.map((line, index) => (
                    <tr key={`${pay.payRunId}-${index}`}>
                      <td>{index === 0 ? formatDate(pay.payDate) : ""}</td>
                      <td>{index === 0 ? <Link href={`/operations/payroll/pay-runs/${pay.payRunId}`}>{pay.reference}</Link> : ""}</td>
                      <td>
                        {line.name}
                        {line.description ? ` (${line.description})` : ""} {line.category === "deduction" ? <span className={ui.muted}>(deduction)</span> : null}
                      </td>
                      <td className={ui.num}>{line.quantity ?? ""}</td>
                      <td className={ui.num}>{line.rate ?? ""}</td>
                      <td className={ui.num}>
                        <Money value={line.amount} />
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          <FigureRows
            columns={[
              ...employee.pays.map((pay) => ({ key: pay.payRunId, label: `${pay.reference} (${formatDate(pay.payDate)})`, figures: pay.figures })),
              ...(employee.pays.length > 1 ? [{ key: "total", label: "Total", figures: employee.totals }] : []),
            ]}
          />
          <Voided runs={employee.voided} />
        </section>
      ))}
    </>
  );
}

function Ird({ data }: { data: IrdDeductionsReport }) {
  type Month = IrdDeductionsReport["months"][number];
  type Liability = "paye" | "studentLoan" | "kiwiSaver" | "esct" | "total";
  const rows: Array<{ label: string; deducted: (month: Month) => string; liability?: Liability }> = [
    { label: "Taxable gross earnings", deducted: (month) => month.deducted.taxableEarnings },
    { label: "PAYE (incl. ACC earners' levy)", deducted: (month) => month.deducted.paye, liability: "paye" },
    { label: "Student loan", deducted: (month) => month.deducted.studentLoan, liability: "studentLoan" },
    { label: "KiwiSaver employee deductions", deducted: (month) => month.deducted.kiwiSaverEmployee },
    { label: "KiwiSaver employer, net of ESCT", deducted: (month) => month.deducted.kiwiSaverEmployerNet },
    { label: "KiwiSaver together", deducted: (month) => month.deducted.kiwiSaver, liability: "kiwiSaver" },
    { label: "ESCT", deducted: (month) => month.deducted.esct, liability: "esct" },
    { label: "Total deducted", deducted: (month) => month.deducted.total, liability: "total" },
  ];
  return (
    <>
      <p className={ui.muted}>
        IRD is paid {data.frequency === "monthly" ? "monthly" : "twice a month"}. Deducted figures are what each pay run&apos;s employment information file
        contains. Tohyee can&apos;t tell what was uploaded to myIR.
      </p>
      {data.months.map((month) => (
        <section key={month.month}>
          <h3>{formatDate(month.end).replace(/^\d+ /, "")}</h3>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th />
                  <th className={ui.num}>Deducted (EI files)</th>
                  {month.paid ? <th className={ui.num}>Paid to IRD</th> : null}
                  {month.paid ? <th className={ui.num}>Owing</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td className={ui.num}>
                      <Money value={row.deducted(month)} />
                    </td>
                    {month.paid ? <td className={ui.num}>{row.liability ? <Money value={month.paid[row.liability]} /> : ""}</td> : null}
                    {month.owing ? <td className={ui.num}>{row.liability ? <Money value={month.owing[row.liability]} /> : ""}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={ui.muted}>
            Due:{" "}
            {month.periods.map((period) => `${formatDate(period.start)} to ${formatDate(period.end)} by ${formatDate(period.payBy)}`).join("; ")}. If that day is a
            public holiday, IRD accepts payment on the next working day.
          </p>
          {month.payRuns.length > 0 ? (
            <ul>
              {month.payRuns.map((run) => (
                <li key={run.payRunId}>
                  <Link href={`/operations/payroll/pay-runs/${run.payRunId}`}>{run.reference}</Link> ({formatDate(run.payDate)}, {run.payGroupName}){" "}
                  <Badge tone={FILE_TEXT[run.file].tone}>{FILE_TEXT[run.file].text}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </>
  );
}

export function PayrollReports({ organisationId }: { organisationId: string }) {
  const today = todayInBrowser();
  const [name, setName] = useState<PayrollReportName>("labour-cost");
  const [from, setFrom] = useState(() => monthStart(today));
  const [to, setTo] = useState(() => monthEnd(today));
  const [date, setDate] = useState(today);
  const [standardWeek, setStandardWeek] = useState("40.00");
  const [groupBy, setGroupBy] = useState<LabourCostGroupBy>("department");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tracking = useTracking(organisationId);
  const departments = tracking.data?.categories.find((category) => category.kind === "department")?.values ?? [];
  const projects = useApiData<{ projects: ProjectSummary[] }>("/api/projects", { organisationId });
  const activities = useRdActivities(organisationId, true);
  const employees = useApiData<{ employees: EmployeeSummary[] }>("/api/payroll/employees", { organisationId, includeArchived: "true" });
  const payItems = useApiData<{ payItems: PayItem[] }>("/api/payroll/pay-items", { organisationId });

  const allowed = FILTERS[name];
  const query: Record<string, string> = { report: name, from, to };
  if (name === "labour-cost") query.groupBy = groupBy;
  if (name === "headcount") {
    query.date = date;
    query.standardWeek = standardWeek;
  }
  for (const key of allowed) if (filters[key]) query[key] = filters[key];
  const loaded = useApiData<{ report: unknown }>("/api/payroll/reports", { organisationId, ...query });
  const report = loaded.data?.report ?? null;

  const setFilter = (key: string, value: string) => setFilters((current) => ({ ...current, [key]: value }));

  async function exportCsv() {
    setBusy(true);
    setError(null);
    try {
      await downloadCsv({ organisationId, ...query });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={ui.tabs} role="tablist" aria-label="Payroll reports" data-print="hide">
        {PAYROLL_REPORTS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={name === entry}
            className={`${ui.tab} ${name === entry ? ui.tabActive : ""}`}
            onClick={() => setName(entry)}
          >
            {PAYROLL_REPORT_TITLES[entry]}
          </button>
        ))}
      </div>
      <Card
        title={PAYROLL_REPORT_TITLES[name]}
        description={DESCRIPTIONS[name]}
        actions={
          <span data-print="hide">
            <Button size="small" variant="secondary" disabled={busy || !report} onClick={() => void exportCsv()}>
              Export CSV
            </Button>{" "}
            <PrintButton />
          </span>
        }
      >
        <div className={ui.inlineForm} data-print="hide">
          {name === "headcount" ? (
            <>
              <Field label="At">
                <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </Field>
              <Field label="Standard week (hours)">
                <input inputMode="decimal" value={standardWeek} onChange={(event) => setStandardWeek(event.target.value)} />
              </Field>
            </>
          ) : null}
          <Field label={name === "headcount" ? "Months from" : "Pay dates from"}>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          {name === "labour-cost" ? (
            <Field label="Group by">
              <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as LabourCostGroupBy)}>
                {LABOUR_COST_GROUPS.map((entry) => (
                  <option key={entry} value={entry}>
                    {GROUP_LABELS[entry]}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {allowed.includes("departmentId") ? (
            <Field label="Department">
              <select value={filters.departmentId ?? ""} onChange={(event) => setFilter("departmentId", event.target.value)}>
                <option value="">All</option>
                {departments.map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.path}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {allowed.includes("projectId") ? (
            <Field label="Project">
              <select value={filters.projectId ?? ""} onChange={(event) => setFilter("projectId", event.target.value)}>
                <option value="">All</option>
                {(projects.data?.projects ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {allowed.includes("rdActivityId") ? (
            <Field label="R&D activity">
              <select value={filters.rdActivityId ?? ""} onChange={(event) => setFilter("rdActivityId", event.target.value)}>
                <option value="">All</option>
                {(activities.data?.activities ?? []).map((activity) => (
                  <option key={activity.id} value={activity.id}>
                    {activityText(activity)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {allowed.includes("employeeId") ? (
            <Field label="Employee">
              <select value={filters.employeeId ?? ""} onChange={(event) => setFilter("employeeId", event.target.value)}>
                <option value="">All</option>
                {(employees.data?.employees ?? []).map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.firstName} {employee.lastName}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {allowed.includes("payItemId") ? (
            <Field label="Pay item">
              <select value={filters.payItemId ?? ""} onChange={(event) => setFilter("payItemId", event.target.value)}>
                <option value="">All</option>
                {(payItems.data?.payItems ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {loaded.loading ? <p className={ui.muted}>Loading…</p> : null}
        <p className={`${ui.muted} ${ui.printOnly}`}>
          {name === "headcount" ? `At ${formatDate(date)}; months ${formatDate(from)} to ${formatDate(to)}` : `Pay dates ${formatDate(from)} to ${formatDate(to)}`}
        </p>
        {report && name === "labour-cost" ? <LabourCost data={report as LabourCostReport} /> : null}
        {report && name === "summary" ? <Summary data={report as PayrollSummaryReport} /> : null}
        {report && name === "reconciliation" ? <Reconciliation data={report as PayrollReconciliation} /> : null}
        {report && name === "headcount" ? <Headcount data={report as HeadcountReport} /> : null}
        {report && name === "earnings" ? <Earnings data={report as EarningsHistoryReport} /> : null}
        {report && name === "ird" ? <Ird data={report as IrdDeductionsReport} /> : null}
      </Card>
    </>
  );
}
