import type { OrgTx } from "@/lib/db/org-transaction";
import { add, dec, type Decimal, isZero, significantScale, sub, sum, toFixedString } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { type IrdPaymentFrequency, irdPeriodFromStart } from "@/lib/payroll/ird-due-dates";
import { irdPaymentFrequency } from "@/lib/payroll/ird-payments";
import { payRunReference } from "@/lib/payroll/pay-runs";
import {
  addFigures,
  money,
  PAY_FIGURE_COLUMNS,
  type PayFigureRow,
  type PayFigures,
  payItemsInOrder,
  parseReportDates,
  parseReportFilters,
  type ReportInput,
  sumFigures,
  type VoidedPayRun,
  voidedPayRuns,
} from "@/lib/payroll/report-common";
import {
  groupLabourCost,
  type LabourCostGroup,
  type LabourCostGroupBy,
  type LabourCostRow,
  monthsBetween,
  parseLabourCostGroupBy,
  type PayrollReportName,
  UNRECORDED_RD,
} from "@/lib/payroll/report-figures";
import { headcountReport, type HeadcountReport } from "@/lib/payroll/report-headcount";
import { payrollReconciliation, type PayrollReconciliation } from "@/lib/payroll/report-reconciliation";

/**
 * Payroll reports, stage P10 (examples PREP1-PREP8, decisions 102-111):
 * labour cost, the payroll summary, each employee's earnings history and
 * the PAYE, KiwiSaver and student loan summary here; the reconciliation to
 * the ledger and headcount and FTE in their own files. All read approved
 * pay runs' stored figures and the shares they used, by pay date, and post
 * nothing. Every report needs payroll access (decision 105).
 */

export type { HeadcountReport } from "@/lib/payroll/report-headcount";
export type { PayrollReconciliation } from "@/lib/payroll/report-reconciliation";
export type { VoidedPayRun } from "@/lib/payroll/report-common";

export type CountedPayRun = { payRunId: string; reference: string; payGroupName: string; payDate: string };

// Labour cost (PREP1, PREP2)

export type LabourCostReport = {
  from: string;
  to: string;
  groupBy: LabourCostGroupBy;
  /** The pay item columns, in order: only those with an amount. */
  payItems: Array<{ id: string; name: string }>;
  groups: LabourCostGroup[];
  /** By pay item id. */
  totals: Record<string, string>;
  total: string;
  /** Not labour cost (decision 103). */
  reimbursements: string;
  payRuns: CountedPayRun[];
  voided: VoidedPayRun[];
};

type PostingRow = {
  pay_run_id: string;
  run_number: string;
  pay_group_name: string;
  pay_date: string;
  employee_id: string;
  employee_name: string | null;
  current_name: string;
  pay_item_id: string;
  pay_item_name: string;
  kind: string;
  amount: string;
  project_id: string | null;
  project_name: string | null;
  has_share: boolean;
  department_id: string | null;
  department_name: string | null;
  rd_activity_id: string | null;
  rd_activity_name: string | null;
};

/**
 * Labour cost (PREP1, PREP2): approved pay runs' postings, with the
 * Department, project and R&D activity of the share each came from
 * (decision 104), grouped and filtered.
 */
export async function labourCostReport(tx: OrgTx, input: ReportInput): Promise<LabourCostReport> {
  await requirePayrollAccess(tx);
  const { from, to } = await parseReportDates(tx, input);
  const groupBy = parseLabourCostGroupBy(input.groupBy);
  const filters = await parseReportFilters(tx, input);
  const rows = (
    await tx.query<PostingRow>(
      `with dept as (select id::text from tracking_categories where kind = 'department'),
       postings as (
         select r.id::text as pay_run_id, r.run_number::text, g.name as pay_group_name, r.pay_date::text,
                p.employee_id::text, e.employee_name, emp.first_name || ' ' || emp.last_name as current_name,
                p.pay_item_id::text, i.name as pay_item_name, i.kind, p.amount::text,
                p.project_id::text, pr.name as project_name,
                s.share_number is not null as has_share,
                case when s.share_number is not null then s.department_id::text
                     else (select p.tracking ->> dept.id from dept) end as department_id,
                s.rd_activity_id::text as rd_activity_id
           from payroll_pay_runs r
           join payroll_pay_groups g on g.id = r.pay_group_id
           join payroll_pay_run_postings p on p.pay_run_id = r.id
           join payroll_pay_items i on i.id = p.pay_item_id
           join payroll_pay_run_employees e on e.pay_run_id = r.id and e.employee_id = p.employee_id
           join payroll_employees emp on emp.id = p.employee_id
           left join projects pr on pr.id = p.project_id
           left join payroll_pay_run_shares s
             on s.pay_run_id = p.pay_run_id and s.employee_id = p.employee_id and s.share_number = p.share_number
          where r.status = 'approved' and r.pay_date between $1 and $2
       )
       select postings.*, d.name as department_name, a.code || ' ' || a.name as rd_activity_name
         from postings
         left join tracking_values d on d.id::text = postings.department_id
         left join rd_activities a on a.id::text = postings.rd_activity_id
        where ($3::text[] = '{}' or postings.department_id = any($3::text[]))
          and ($4::text is null or postings.project_id = $4)
          and ($5::text is null or postings.rd_activity_id = $5)
          and ($6::text is null or postings.employee_id = $6)
          and ($7::text is null or postings.pay_item_id = $7)
        order by postings.pay_date desc, postings.run_number desc`,
      [from, to, filters.departmentIds, filters.projectId, filters.rdActivityId, filters.employeeId, filters.payItemId],
    )
  ).rows;
  const items = await payItemsInOrder(tx);
  const rowsForGrouping: LabourCostRow[] = rows.map((row) => ({
    amount: row.amount,
    payItemId: row.pay_item_id,
    payItemName: row.pay_item_name,
    isReimbursement: row.kind === "reimbursement",
    departmentId: row.department_id,
    departmentName: row.department_name,
    projectId: row.project_id,
    projectName: row.project_name,
    // Pay runs approved before timesheets (P9) kept no shares, so no R&D activity (decision 104).
    rdActivityId: row.has_share ? row.rd_activity_id : UNRECORDED_RD,
    rdActivityName: row.rd_activity_name,
    employeeId: row.employee_id,
    employeeName: row.employee_name ?? row.current_name,
  }));
  const grouped = groupLabourCost(rowsForGrouping, groupBy, items.map((item) => item.id));
  const names = new Map(items.map((item) => [item.id, item.name]));
  const counted = new Map<string, CountedPayRun>();
  for (const row of [...rows].reverse()) {
    counted.set(row.pay_run_id, { payRunId: row.pay_run_id, reference: payRunReference(row.run_number), payGroupName: row.pay_group_name, payDate: row.pay_date });
  }
  return {
    from,
    to,
    groupBy,
    payItems: grouped.payItemIds.map((id) => ({ id, name: names.get(id) ?? "Pay item" })),
    groups: grouped.groups,
    totals: grouped.totals,
    total: grouped.total,
    reimbursements: grouped.reimbursements,
    payRuns: sortRuns([...counted.values()]),
    voided: await voidedPayRuns(tx, from, to, filters.employeeId),
  };
}

function sortRuns<T extends { payDate: string; reference: string }>(runs: T[]): T[] {
  const number = (reference: string) => Number(reference.replace(/\D/g, ""));
  return runs.sort((a, b) => (a.payDate < b.payDate ? -1 : a.payDate > b.payDate ? 1 : number(a.reference) - number(b.reference)));
}

// Payroll summary (PREP3)

export type PayrollSummaryRun = CountedPayRun & { periodStart: string; periodEnd: string; employeeCount: number; figures: PayFigures };

export type PayrollSummaryReport = {
  from: string;
  to: string;
  employeeId: string | null;
  payRuns: PayrollSummaryRun[];
  totals: PayFigures & { employeeCount: number };
  /** Totals by pay item; hours where lines were hours × rate. */
  payItems: Array<{ payItemId: string; name: string; category: string; hours: string | null; amount: string }>;
  voided: VoidedPayRun[];
};

type SummaryRow = PayFigureRow & {
  pay_run_id: string;
  run_number: string;
  pay_group_name: string;
  pay_date: string;
  period_start: string;
  period_end: string;
  employee_id: string;
};

/** The payroll summary (PREP3): each approved pay run gross to net, the totals and the totals by pay item. */
export async function payrollSummaryReport(tx: OrgTx, input: ReportInput): Promise<PayrollSummaryReport> {
  await requirePayrollAccess(tx);
  const { from, to } = await parseReportDates(tx, input);
  const { employeeId } = await parseReportFilters(tx, { employeeId: input.employeeId });
  const rows = (
    await tx.query<SummaryRow>(
      `select r.id::text as pay_run_id, r.run_number::text, g.name as pay_group_name, r.pay_date::text, r.period_start::text,
              r.period_end::text, pe.employee_id::text, ${PAY_FIGURE_COLUMNS}
         from payroll_pay_runs r
         join payroll_pay_groups g on g.id = r.pay_group_id
         join payroll_pay_run_employees pe on pe.pay_run_id = r.id
        where r.status = 'approved' and r.pay_date between $1 and $2 and ($3::uuid is null or pe.employee_id = $3)
        order by r.pay_date, r.run_number, pe.employee_id`,
      [from, to, employeeId],
    )
  ).rows;
  const byRun = new Map<string, SummaryRow[]>();
  for (const row of rows) byRun.set(row.pay_run_id, [...(byRun.get(row.pay_run_id) ?? []), row]);
  const payRuns: PayrollSummaryRun[] = [...byRun.values()].map((runRows) => ({
    payRunId: runRows[0].pay_run_id,
    reference: payRunReference(runRows[0].run_number),
    payGroupName: runRows[0].pay_group_name,
    payDate: runRows[0].pay_date,
    periodStart: runRows[0].period_start,
    periodEnd: runRows[0].period_end,
    employeeCount: runRows.length,
    figures: addFigures(runRows),
  }));

  const lines = (
    await tx.query<{ pay_item_id: string; hours: string | null; amount: string }>(
      `select l.pay_item_id::text, sum(l.quantity)::text as hours, sum(l.amount)::text as amount
         from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id
        where r.status = 'approved' and r.pay_date between $1 and $2 and ($3::uuid is null or l.employee_id = $3)
        group by l.pay_item_id`,
      [from, to, employeeId],
    )
  ).rows;
  const byItem = new Map(lines.map((line) => [line.pay_item_id, line]));
  const totals = sumFigures(payRuns.map((run) => run.figures));
  const items = await payItemsInOrder(tx);
  const payItems = items.flatMap((item) => {
    if (item.kind === "kiwisaver_employer") {
      return isZero(dec(totals.kiwiSaverEmployer))
        ? []
        : [{ payItemId: item.id, name: item.name, category: item.category, hours: null, amount: totals.kiwiSaverEmployer }];
    }
    const line = byItem.get(item.id);
    if (!line) return [];
    return [{ payItemId: item.id, name: item.name, category: item.category, hours: line.hours ? toFixedString(dec(line.hours), 2) : null, amount: money(dec(line.amount)) }];
  });
  return {
    from,
    to,
    employeeId,
    payRuns,
    totals: { employeeCount: new Set(rows.map((row) => row.employee_id)).size, ...totals },
    payItems,
    voided: await voidedPayRuns(tx, from, to, employeeId),
  };
}

// Earnings history (PREP6)

export type EarningsLine = {
  payItemId: string;
  name: string;
  category: string;
  quantity: string | null;
  rate: string | null;
  amount: string;
  description: string | null;
};

export type EarningsPay = CountedPayRun & { periodStart: string; periodEnd: string; name: string; lines: EarningsLine[]; figures: PayFigures };

export type EarningsHistoryEmployee = { employeeId: string; name: string; pays: EarningsPay[]; totals: PayFigures; voided: VoidedPayRun[] };

export type EarningsHistoryReport = { from: string; to: string; employees: EarningsHistoryEmployee[] };

/** A rate to at least 2 decimals, without the stored trailing zeros (22.500000 → 22.50). */
function rateText(rate: string): string {
  const value = dec(rate);
  return toFixedString(value, Math.max(2, significantScale(value)));
}

/** Each employee's pays (PREP6): the lines and figures each approved pay run stored, with the name it kept (decision 110). */
export async function earningsHistoryReport(tx: OrgTx, input: ReportInput): Promise<EarningsHistoryReport> {
  await requirePayrollAccess(tx);
  const { from, to } = await parseReportDates(tx, input);
  const { employeeId, payItemId } = await parseReportFilters(tx, { employeeId: input.employeeId, payItemId: input.payItemId });
  const pays = (
    await tx.query<SummaryRow & { employee_name: string | null; current_name: string }>(
      `select r.id::text as pay_run_id, r.run_number::text, g.name as pay_group_name, r.pay_date::text, r.period_start::text,
              r.period_end::text, pe.employee_id::text, pe.employee_name, emp.first_name || ' ' || emp.last_name as current_name,
              ${PAY_FIGURE_COLUMNS}
         from payroll_pay_runs r
         join payroll_pay_groups g on g.id = r.pay_group_id
         join payroll_pay_run_employees pe on pe.pay_run_id = r.id
         join payroll_employees emp on emp.id = pe.employee_id
        where r.status = 'approved' and r.pay_date between $1 and $2 and ($3::uuid is null or pe.employee_id = $3)
        order by r.pay_date, r.run_number`,
      [from, to, employeeId],
    )
  ).rows;
  const lines = (
    await tx.query<{
      pay_run_id: string;
      employee_id: string;
      pay_item_id: string;
      name: string;
      category: string;
      quantity: string | null;
      rate: string | null;
      amount: string;
      description: string | null;
    }>(
      `select l.pay_run_id::text, l.employee_id::text, l.pay_item_id::text, i.name, i.category, l.quantity::text, l.rate::text,
              l.amount::text, l.description
         from payroll_pay_run_lines l
         join payroll_pay_runs r on r.id = l.pay_run_id
         join payroll_pay_items i on i.id = l.pay_item_id
        where r.status = 'approved' and r.pay_date between $1 and $2 and ($3::uuid is null or l.employee_id = $3)
          and ($4::uuid is null or l.pay_item_id = $4)
        order by l.pay_run_id, l.employee_id, l.line_number`,
      [from, to, employeeId, payItemId],
    )
  ).rows;
  const linesFor = new Map<string, EarningsLine[]>();
  for (const line of lines) {
    const id = `${line.pay_run_id}|${line.employee_id}`;
    linesFor.set(id, [
      ...(linesFor.get(id) ?? []),
      {
        payItemId: line.pay_item_id,
        name: line.name,
        category: line.category,
        quantity: line.quantity === null ? null : toFixedString(dec(line.quantity), 2),
        rate: line.rate === null ? null : rateText(line.rate),
        amount: money(dec(line.amount)),
        description: line.description,
      },
    ]);
  }
  const voided = await voidedPayRuns(tx, from, to, employeeId);
  const employees = new Map<string, EarningsHistoryEmployee & { rows: PayFigureRow[] }>();
  for (const pay of pays) {
    const payLines = linesFor.get(`${pay.pay_run_id}|${pay.employee_id}`) ?? [];
    if (payItemId && payLines.length === 0) continue;
    const name = pay.employee_name ?? pay.current_name;
    const entry = employees.get(pay.employee_id) ?? {
      employeeId: pay.employee_id,
      name,
      pays: [],
      totals: addFigures([]),
      voided: voided.filter((run) => run.employeeIds.includes(pay.employee_id)),
      rows: [],
    };
    entry.name = name; // the latest pay's name
    entry.pays.push({
      payRunId: pay.pay_run_id,
      reference: payRunReference(pay.run_number),
      payGroupName: pay.pay_group_name,
      payDate: pay.pay_date,
      periodStart: pay.period_start,
      periodEnd: pay.period_end,
      name,
      lines: payLines,
      figures: addFigures([pay]),
    });
    entry.rows.push(pay);
    employees.set(pay.employee_id, entry);
  }
  return {
    from,
    to,
    employees: [...employees.values()]
      .map(({ rows, ...entry }) => ({ ...entry, totals: addFigures(rows) }))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.employeeId.localeCompare(b.employeeId)),
  };
}

// PAYE, KiwiSaver and student loan (PREP7)

export type IrdDeducted = {
  taxableEarnings: string;
  paye: string;
  studentLoan: string;
  kiwiSaverEmployee: string;
  kiwiSaverEmployerNet: string;
  /** Employee and employer together, as IRD is paid. */
  kiwiSaver: string;
  esct: string;
  /** HEI2 field 23: PAYE, student loan, KiwiSaver both, ESCT. */
  total: string;
};

export type IrdAmounts = { paye: string; studentLoan: string; kiwiSaver: string; esct: string; total: string };

/** made: an EI file was made; not_made: none made in Tohyee; voided_after_file: amend in myIR; voided: voided, no file. */
export type EiFileStatus = "made" | "not_made" | "voided_after_file" | "voided";

export type IrdMonth = {
  month: string;
  start: string;
  end: string;
  deducted: IrdDeducted;
  /** Null when filtered to one employee (IRD is paid per period, not per person). */
  paid: IrdAmounts | null;
  owing: IrdAmounts | null;
  periods: Array<{ start: string; end: string; dueDate: string; payBy: string }>;
  payRuns: Array<CountedPayRun & { status: "approved" | "voided"; file: EiFileStatus }>;
};

export type IrdDeductionsReport = {
  from: string;
  to: string;
  frequency: IrdPaymentFrequency;
  employeeId: string | null;
  months: IrdMonth[];
  totals: { deducted: IrdDeducted; paid: IrdAmounts | null; owing: IrdAmounts | null };
};

function deducted(rows: ReadonlyArray<{ taxable: string; paye: string; sl: string; kse: string; ksr: string; esct: string }>): IrdDeducted {
  const total = (pick: (row: (typeof rows)[number]) => string) => sum(rows.map((row) => dec(pick(row))));
  const paye = total((row) => row.paye);
  const studentLoan = total((row) => row.sl);
  const kse = total((row) => row.kse);
  const ksr = total((row) => row.ksr);
  const esct = total((row) => row.esct);
  return {
    taxableEarnings: money(total((row) => row.taxable)),
    paye: money(paye),
    studentLoan: money(studentLoan),
    kiwiSaverEmployee: money(kse),
    kiwiSaverEmployerNet: money(ksr),
    kiwiSaver: money(add(kse, ksr)),
    esct: money(esct),
    total: money(sum([paye, studentLoan, kse, ksr, esct])),
  };
}

function amounts(values: { paye: Decimal; studentLoan: Decimal; kiwiSaver: Decimal; esct: Decimal }): IrdAmounts {
  return {
    paye: money(values.paye),
    studentLoan: money(values.studentLoan),
    kiwiSaver: money(values.kiwiSaver),
    esct: money(values.esct),
    total: money(sum([values.paye, values.studentLoan, values.kiwiSaver, values.esct])),
  };
}

function owingOf(from: IrdDeducted, paid: IrdAmounts): IrdAmounts {
  return amounts({
    paye: sub(dec(from.paye), dec(paid.paye)),
    studentLoan: sub(dec(from.studentLoan), dec(paid.studentLoan)),
    kiwiSaver: sub(dec(from.kiwiSaver), dec(paid.kiwiSaver)),
    esct: sub(dec(from.esct), dec(paid.esct)),
  });
}

/**
 * PAYE, KiwiSaver and student loan by month of pay date (PREP7, decision
 * 108): what the counted pay runs deducted (their EI files' figures,
 * decision 58), what was paid to IRD for the IRD periods in the month, what's
 * owing, and each pay run's file from the audit log.
 */
export async function irdDeductionsReport(tx: OrgTx, input: ReportInput): Promise<IrdDeductionsReport> {
  await requirePayrollAccess(tx);
  const { from, to } = await parseReportDates(tx, input);
  const { employeeId } = await parseReportFilters(tx, { employeeId: input.employeeId });
  const frequency = await irdPaymentFrequency(tx);
  const months = monthsBetween(from, to);
  const first = months[0].start;
  const last = months[months.length - 1].end;
  const figures = (
    await tx.query<{ pay_date: string; taxable: string; paye: string; sl: string; kse: string; ksr: string; esct: string }>(
      `select r.pay_date::text, coalesce(pe.taxable_earnings, 0)::text as taxable, coalesce(pe.paye, 0)::text as paye,
              coalesce(pe.student_loan_deduction, 0)::text as sl, coalesce(pe.kiwisaver_employee, 0)::text as kse,
              coalesce(pe.kiwisaver_employer_net, 0)::text as ksr, coalesce(pe.esct, 0)::text as esct
         from payroll_pay_runs r join payroll_pay_run_employees pe on pe.pay_run_id = r.id
        where r.status = 'approved' and r.pay_date between $1 and $2 and r.pay_date between $3 and $4
          and ($5::uuid is null or pe.employee_id = $5)`,
      [first, last, from, to, employeeId],
    )
  ).rows;
  const paidRows = (
    await tx.query<{ period_start: string; liability: string; amount: string }>(
      `select p.period_start::text, l.liability, sum(l.amount)::text as amount
         from payroll_ird_payments p join payroll_ird_payment_lines l on l.ird_payment_id = p.id
        where p.status = 'active' and p.period_start between $1 and $2
        group by p.period_start, l.liability`,
      [first, last],
    )
  ).rows;
  const runs = (
    await tx.query<{ id: string; run_number: string; pay_group_name: string; pay_date: string; status: "approved" | "voided"; file_made: boolean }>(
      `select r.id::text, r.run_number::text, g.name as pay_group_name, r.pay_date::text, r.status,
              exists (select 1 from audit_events a where a.event_type = 'payroll_payday_filing.made' and a.entity_id = r.id::text) as file_made
         from payroll_pay_runs r join payroll_pay_groups g on g.id = r.pay_group_id
        where r.status <> 'draft' and r.pay_date between $1 and $2
          and ($3::uuid is null or exists (select 1 from payroll_pay_run_employees e where e.pay_run_id = r.id and e.employee_id = $3))
        order by r.pay_date, r.run_number`,
      [from, to, employeeId],
    )
  ).rows;

  const result: IrdMonth[] = months.map((month) => {
    const own = deducted(figures.filter((row) => row.pay_date >= month.start && row.pay_date <= month.end));
    const paidHere = paidRows.filter((row) => row.period_start >= month.start && row.period_start <= month.end);
    const paidOf = (liability: string) => sum(paidHere.filter((row) => row.liability === liability).map((row) => dec(row.amount)));
    const paid = employeeId
      ? null
      : amounts({ paye: paidOf("paye"), studentLoan: paidOf("student_loan"), kiwiSaver: paidOf("kiwisaver"), esct: paidOf("esct") });
    const starts = frequency === "twice_monthly" ? [month.start, `${month.month}-16`] : [month.start];
    return {
      month: month.month,
      start: month.start,
      end: month.end,
      deducted: own,
      paid,
      owing: paid ? owingOf(own, paid) : null,
      periods: starts.map((start) => {
        const period = irdPeriodFromStart(start, frequency);
        return { start: period.start, end: period.end, dueDate: period.dueDate, payBy: period.payBy };
      }),
      payRuns: runs
        .filter((run) => run.pay_date >= month.start && run.pay_date <= month.end)
        .map((run) => ({
          payRunId: run.id,
          reference: payRunReference(run.run_number),
          payGroupName: run.pay_group_name,
          payDate: run.pay_date,
          status: run.status,
          file: (run.status === "approved" ? (run.file_made ? "made" : "not_made") : run.file_made ? "voided_after_file" : "voided") as EiFileStatus,
        })),
    };
  });
  const totalDeducted = deducted(figures);
  const totalPaid = employeeId
    ? null
    : amounts({
        paye: sum(result.map((month) => dec(month.paid!.paye))),
        studentLoan: sum(result.map((month) => dec(month.paid!.studentLoan))),
        kiwiSaver: sum(result.map((month) => dec(month.paid!.kiwiSaver))),
        esct: sum(result.map((month) => dec(month.paid!.esct))),
      });
  return {
    from,
    to,
    frequency,
    employeeId,
    months: result,
    totals: { deducted: totalDeducted, paid: totalPaid, owing: totalPaid ? owingOf(totalDeducted, totalPaid) : null },
  };
}

// Any report by name

export type PayrollReport =
  | { report: "labour-cost"; data: LabourCostReport }
  | { report: "summary"; data: PayrollSummaryReport }
  | { report: "reconciliation"; data: PayrollReconciliation }
  | { report: "headcount"; data: HeadcountReport }
  | { report: "earnings"; data: EarningsHistoryReport }
  | { report: "ird"; data: IrdDeductionsReport };

export async function runPayrollReport(tx: OrgTx, name: PayrollReportName, input: ReportInput): Promise<PayrollReport> {
  switch (name) {
    case "labour-cost":
      return { report: name, data: await labourCostReport(tx, input) };
    case "summary":
      return { report: name, data: await payrollSummaryReport(tx, input) };
    case "reconciliation":
      return { report: name, data: await payrollReconciliation(tx, input) };
    case "headcount":
      return { report: name, data: await headcountReport(tx, input) };
    case "earnings":
      return { report: name, data: await earningsHistoryReport(tx, input) };
    case "ird":
      return { report: name, data: await irdDeductionsReport(tx, input) };
  }
}
