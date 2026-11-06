"use client";

import { useSaveAsCustomReport } from "@/components/reports/save-as-custom-report";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, type ReactNode, Suspense, useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { BudgetVsActualReport } from "@/components/budgets";
import { BankReconciliationReportView } from "@/components/reports/bank-reconciliation";
import { AgedReceivablesReport } from "@/components/customers";
import { AccountTransactionsReport, AgedPayablesReport, JournalReportView } from "@/components/reports/ledger-reports";
import { ReportExport } from "@/components/reports/report-export";
import { ReportFrame, type ReportDates, ReportToolbar, StatementHeading, useYearEndMonth } from "@/components/reports/report-frame";
import { CashFlowStatementReport, ChangesInEquityReport } from "@/components/reports/statements";
import { CustomReportList, FavouriteToggle, ReportWarnings, StartCustomReport, useFavourite } from "@/components/reports/custom-report";
import { CustomFiguresTable } from "@/components/reports/custom-report-table";
import { useReportLayout } from "@/components/reports/report-layout";
import { AnnualStatementsReport } from "@/components/reports/annual-statements";
import type { CustomReportFigures, FinancialReportBase } from "@/lib/reports/custom-layout";
import { SalesBySalespersonReport, useSalespeople } from "@/components/salespeople";
import { reportCategories, useTracking } from "@/components/tracking";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { formatDate, formatMoney, formatQuantity, todayInBrowser } from "@/lib/format";
import { accountTransactionsHref } from "@/lib/reports/drilldown";
import type { ProfitAndLossSplit, SplitColumn, SplitGroup } from "@/lib/reports/financial";
import {
  MAX_COMPARE_PERIODS,
  PERIOD_ORDERS,
  type PeriodOrder,
  periodOrderStorageKey,
  rememberedPeriodOrder,
  searchWithOrder } from "@/lib/reports/compare-columns";
import type { PeriodLength } from "@/lib/reports/custom-layout";
import { columnHeading, statementAsAt, statementPeriod } from "@/lib/reports/report-dates";
import type { MultiColumnStatement } from "@/lib/reports/statement-compare";
import {
  MultiColumnStatementTable,
  parseTrackingChoice,
  type TrackingChoice,
  TrackingFilterField,
  trackingQuery } from "@/components/reports/statement-table";

type Line = { accountId: string; code: string; name: string; amount: string };
type Section = { key: string; label: string; lines: Line[]; total: string };
type Group = { sections: Section[]; total: string };
/** A balance sheet group, with current and non-current subtotals (P4). */
type TermGroup = Group & { current: Group; nonCurrent: Group };
type Drilldown = {
  from?: string | null;
  to: string;
  trackingCategoryId?: string | null;
  trackingValueId?: string | null;
  trackingUnassigned?: boolean;
};

/** An account's amount, linked to its transactions; blank (no link) when it's zero and `blankZero` is set (decision 1351). */
function AccountAmount({ accountId, value, drilldown, blankZero = false }: { accountId: string; value: string; drilldown: Drilldown; blankZero?: boolean }) {
  if (blankZero && /^-?0*(\.0*)?$/.test(value)) return <Money value={value} blankZero />;
  return (
    <Link href={accountTransactionsHref({ accountId, ...drilldown })}>
      <Money value={value} />
    </Link>
  );
}

/** The account column's heading: read out, not shown (Xero leaves it blank). */
function AccountHeading() {
  return (
    <th>
      <span className={ui.srOnly}>Account</span>
    </th>
  );
}

const printReport: { label: string; onSelect: () => void } = { label: "Print", onSelect: () => window.print() };
const startCustom = { label: "Start a custom report", href: "/operations/reports?view=custom" };

type TrialBalance = {
  asAt: string;
  financialYearStart: string;
  filter: ReportFilter;
  previousYearsEarnings: string;
  currencyCode: string;
  rows: Array<{ accountId: string | null; code: string; name: string; debit: string; credit: string; previousYearsEarnings?: string }>;
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
};
type ReportFilter = { categoryId: string; valueId: string; label: string } | null;
type ProfitAndLoss = {
  from: string;
  to: string;
  currencyCode: string;
  filter: ReportFilter;
  revenue: Group;
  costOfSales: Group;
  grossProfit: string;
  otherIncome: Group;
  expenses: Group;
  netProfit: string;
};
type BalanceSheet = {
  asAt: string;
  financialYearStart: string;
  currencyCode: string;
  filter: ReportFilter;
  assets: TermGroup;
  liabilities: TermGroup;
  netAssets: string;
  equity: Group & {
    retainedEarnings: { account: { id: string; code: string; name: string } | null; accountBalance: string; previousYearsEarnings: string; total: string };
    previousYearsEarnings: string;
    currentYearEarnings: string;
  };
  liabilitiesAndEquity: string;
  balanced: boolean;
};
type Valuation = {
  currencyCode: string;
  items: Array<{
    itemCode: string;
    itemName: string | null;
    unit: string | null;
    locationValueId: string | null;
    locationName: string | null;
    quantity: string;
    value: string;
    averageCost: string | null;
    lastMovementDate: string | null;
  }>;
  totalValue: string;
  inventoryAccountCode: string | null;
  inventoryAccountBalance: string;
};

function AccountLine({ line, drilldown }: { line: Line; drilldown?: Drilldown }) {
  return (
    <tr className={ui.reportSection}>
      <td>
        {line.code} · {line.name}
      </td>
      <td className={ui.num}>{drilldown ? <AccountAmount accountId={line.accountId} value={line.amount} drilldown={drilldown} /> : <Money value={line.amount} />}</td>
    </tr>
  );
}

function TotalRow({ label, value, grand = false }: { label: ReactNode; value: string; grand?: boolean }) {
  return (
    <tr className={grand ? ui.reportGrand : ui.reportTotal}>
      <td>{label}</td>
      <td className={ui.num}>
        <Money value={value} />
      </td>
    </tr>
  );
}

/** Assets or liabilities: current, then non-current, each with its subtotal, then the group total. */
function TermGroupRows({ title, group, drilldown }: { title: string; group: TermGroup; drilldown: Drilldown }) {
  const noun = title.toLowerCase();
  const part = (label: string, part: Group) => (
    <>
      <tr className={ui.reportSubheading}>
        <td colSpan={2}>{label}</td>
      </tr>
      {part.sections.flatMap((section) => section.lines.map((line) => <AccountLine key={line.accountId} line={line} drilldown={drilldown} />))}
      <TotalRow label={`Total ${label.toLowerCase()}`} value={part.total} />
    </>
  );
  return (
    <>
      <tr className={ui.reportHeading}>
        <td colSpan={2}>{title}</td>
      </tr>
      {group.current.sections.length > 0 ? part(`Current ${noun}`, group.current) : null}
      {group.nonCurrent.sections.length > 0 ? part(`Non-current ${noun}`, group.nonCurrent) : null}
      <TotalRow label={`Total ${noun}`} value={group.total} />
    </>
  );
}

/** A profit and loss group; left out when it has nothing, as in Xero. */
function GroupRows({ title, group, totalLabel, drilldown }: { title: string; group: Group; totalLabel: string; drilldown?: Drilldown }) {
  if (group.sections.length === 0) return null;
  return (
    <>
      <tr className={ui.reportHeading}>
        <td colSpan={2}>{title}</td>
      </tr>
      {group.sections.map((section) => (
        <Fragment key={section.key}>
          {group.sections.length > 1 ? (
            <tr className={ui.reportSubheading}>
              <td colSpan={2}>{section.label}</td>
            </tr>
          ) : null}
          {section.lines.map((line) => (
            <AccountLine key={line.accountId} line={line} drilldown={drilldown} />
          ))}
        </Fragment>
      ))}
      <TotalRow label={totalLabel} value={group.total} />
    </>
  );
}

function SplitGroupRows({
  title,
  group,
  columns,
  totalLabel,
  from,
  to,
  categoryId,
  totalDrill }: {
  title: string;
  group: SplitGroup;
  columns: SplitColumn[];
  totalLabel: string;
  from: string;
  to: string;
  categoryId: string;
  totalDrill: Pick<Drilldown, "trackingCategoryId" | "trackingValueId" | "trackingUnassigned">;
}) {
  const span = columns.length + 1;
  if (group.sections.length === 0) return null;
  return (
    <>
      <tr className={ui.reportHeading}>
        <td colSpan={span}>{title}</td>
      </tr>
      {group.sections.map((section) => (
        <Fragment key={section.key}>
          {group.sections.length > 1 ? (
            <tr className={ui.reportSubheading}>
              <td colSpan={span}>{section.label}</td>
            </tr>
          ) : null}
          {section.lines.map((line) => (
            <tr key={line.accountId} className={ui.reportSection}>
              <td>
                {line.code} · {line.name}
              </td>
              {columns.map((column) => (
                <td key={column.key} className={ui.num}>
                  {column.valueId || column.key === "none" ? (
                    <AccountAmount
                      accountId={line.accountId}
                      value={line.amounts[column.key]}
                      blankZero
                      drilldown={{
                        from,
                        to,
                        trackingCategoryId: categoryId,
                        trackingValueId: column.valueId,
                        trackingUnassigned: column.key === "none" }}
                    />
                  ) : column.key === "total" ? (
                    <AccountAmount accountId={line.accountId} value={line.amounts[column.key]} drilldown={{ from, to, ...totalDrill }} />
                  ) : (
                    <Money value={line.amounts[column.key]} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </Fragment>
      ))}
      <tr className={ui.reportTotal}>
        <td>{totalLabel}</td>
        {columns.map((column) => (
          <td key={column.key} className={ui.num}>
            <Money value={group.totals[column.key]} />
          </td>
        ))}
      </tr>
    </>
  );
}

/** Profit and loss with one column per top-level value of a tracking category (TC7). */
function SplitProfitAndLoss({ report, filter }: { report: ProfitAndLossSplit; filter: TrackingChoice }) {
  const { columns } = report;
  // A drill-down can carry one tracking filter: the split's value wins, the Total column keeps the report's filter.
  const rows = (title: string, group: SplitGroup, totalLabel: string) => (
    <SplitGroupRows title={title} group={group} columns={columns} totalLabel={totalLabel} from={report.from} to={report.to} categoryId={report.category.id} totalDrill={filterDrill(filter)} />
  );
  return (
    <div className={ui.statementWrap}>
      <table id="profit-and-loss-report" className={`${ui.table} ${ui.statement} ${ui.statementWide}`}>
        <thead>
          <tr>
            <th>{report.category.name}</th>
            {columns.map((column) => (
              <th key={column.key} className={ui.num}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows("Trading income", report.revenue, "Total trading income")}
          {rows("Cost of sales", report.costOfSales, "Total cost of sales")}
          <tr className={ui.reportTotal}>
            <td>Gross profit</td>
            {columns.map((column) => (
              <td key={column.key} className={ui.num}>
                <Money value={report.grossProfit[column.key]} />
              </td>
            ))}
          </tr>
          {rows("Other income", report.otherIncome, "Total other income")}
          {rows("Operating expenses", report.expenses, "Total operating expenses")}
        </tbody>
        <tfoot>
          <tr className={ui.reportGrand}>
            <td>Net profit</td>
            {columns.map((column) => (
              <td key={column.key} className={ui.num}>
                <Money value={report.netProfit[column.key]} />
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function LoadState({ loading, error }: { loading: boolean; error: string | null }) {
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading ? <p className={ui.muted}>Loading…</p> : null}
    </>
  );
}

function TrialBalanceReport({ organisationId }: { organisationId: string }) {
  const yearEndMonth = useYearEndMonth(organisationId);
  const [dates, setDates] = useState<ReportDates>(() => ({ from: null, to: todayInBrowser() }));
  const [applied, setApplied] = useState("");
  const [draft, setDraft] = useState("");
  const tracking = useTracking(organisationId).data;
  const filter = parseTrackingChoice(applied);
  const report = useApiData<TrialBalance>("/api/reports/trial-balance", { organisationId, asAt: dates.to, ...trackingQuery(filter) });
  const save = useSaveAsCustomReport(organisationId, "trial_balance", { asAt: dates.to });
  const data = report.data;
  const drilldown = data ? { from: data.financialYearStart, to: data.asAt, ...filterDrill(filter) } : null;
  const period = data ? statementAsAt(data.asAt) : "";
  const lines = data?.filter ? [`Only lines tagged ${data.filter.label}`] : [];
  return (
    <ReportFrame
      label="Trial balance"
      toolbar={
        <ReportToolbar
          mode="asAt"
          dates={dates}
          yearEndMonth={yearEndMonth}
          onUpdate={(next) => {
            setDates(next);
            setApplied(draft);
          }}
          filters={<TrackingFilterField setup={tracking} value={draft} onChange={setDraft} />}
          busy={report.loading}
          more={[printReport, ...(save.item ? [save.item] : [])]}
          info={
            data ? (
              <>
                Income and expense accounts show this financial year only, from {formatDate(data.financialYearStart)}; earlier years&apos; profit is in retained
                earnings, as on the balance sheet.
              </>
            ) : null
          }
          exportProps={
            data
              ? { organisationId, report: "trial-balance", title: "Trial balance", period, filters: lines, style: "statement", tables: [{ id: "trial-balance-report" }] }
              : null
          }
        />
      }
    >
      <LoadState loading={report.loading} error={report.error} />
      {data ? <StatementHeading title="Trial balance" period={period} lines={lines} /> : null}
      {data ? (
        data.rows.length === 0 ? (
          <Empty>No postings up to {formatDate(data.asAt)}.</Empty>
        ) : (
          <div className={ui.statementWrap}>
            <table id="trial-balance-report" className={`${ui.table} ${ui.statement}`}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th className={ui.num}>Debit</th>
                  <th className={ui.num}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.accountId ?? "retained"}>
                    <td>
                      {row.code ? `${row.code} · ` : ""}
                      {row.name}
                      {row.previousYearsEarnings && row.previousYearsEarnings !== "0.00" ? (
                        <>
                          {" "}
                          <span data-export-ignore>
                          <InfoTip label="Retained earnings">
                            Includes {formatMoney(row.previousYearsEarnings)} of earnings from previous years, worked out and never posted (as on the balance
                            sheet).
                          </InfoTip>
                          </span>
                        </>
                      ) : null}
                    </td>
                    {(["debit", "credit"] as const).map((side) => (
                      <td key={side} className={ui.num}>
                        {row.accountId ? (
                          <AccountAmount accountId={row.accountId} value={row[side]} drilldown={drilldown!} blankZero />
                        ) : (
                          <Money value={row[side]} blankZero />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className={ui.reportGrand}>
                  <td>
                    Total{" "}
                    {data.balanced ? null : (
                      <span data-export-ignore>
                        <Badge tone="red">Out of balance</Badge>
                      </span>
                    )}
                  </td>
                  <td className={ui.num}>
                    <Money value={data.totalDebit} />
                  </td>
                  <td className={ui.num}>
                    <Money value={data.totalCredit} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      ) : null}
    </ReportFrame>
  );
}

type LayoutRun = { layout: { report: { id: string; title: string }; figures: CustomReportFigures } | null };

/** The report's figures in its default layout, as the custom report shows them. */
function LayoutFigures({ run, filter }: { run: NonNullable<LayoutRun["layout"]>; filter: TrackingChoice }) {
  return (
    <>
      {run.figures.blocks.map((block) =>
        block.kind === "table" ? (
          <section key={block.id}>
            {block.title ? <h3 className={ui.reportBlockTitle}>{block.title}</h3> : null}
            <CustomFiguresTable
              id={`layout-${block.id}`}
              block={block}
              figures={run.figures}
              filter={filter && filter.valueId !== "unassigned" ? { categoryId: filter.categoryId, valueId: filter.valueId } : null}
            />
          </section>
        ) : (
          <p key={block.id} className={ui.reportNote}>
            {block.text}
          </p>
        ),
      )}
      <ReportWarnings figures={run.figures} />
    </>
  );
}

const layoutTables = (run: LayoutRun["layout"]) =>
  run ? run.figures.blocks.filter((block) => block.kind === "table").map((block) => ({ id: `layout-${block.id}`, title: (block as { title: string }).title || undefined })) : [];

type PnlOptions = {
  splitBy: string;
  tracking: string;
  compare: number;
  compareBy: PeriodLength;
  order: PeriodOrder;
  total: boolean;
  ytd: boolean;
  percent: boolean;
};
const PNL_OPTIONS: PnlOptions = { splitBy: "", tracking: "", compare: 0, compareBy: "month", order: "oldest_first", total: false, ytd: false, percent: false };

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Which way the compared periods run (decisions 1366-1367): from the
 * address, else this report's last choice in this browser, else oldest
 * first. `remember` keeps an applied choice and puts it in the address.
 * Reports only render in the browser (after the organisation is known), so
 * reading storage while the state is set up can't differ from the server.
 */
function usePeriodOrder(base: FinancialReportBase) {
  const [initial] = useState<PeriodOrder>(() => (typeof window === "undefined" ? "oldest_first" : rememberedPeriodOrder(base, window.location.search, browserStorage())));
  const remember = (order: PeriodOrder, comparing: boolean) => {
    if (comparing) {
      try {
        browserStorage()?.setItem(periodOrderStorageKey(base), order);
      } catch {
        // Not kept: the report still shows it.
      }
    }
    const search = searchWithOrder(window.location.search, comparing ? order : null);
    if (search !== window.location.search) window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  };
  return { initial, remember };
}

type CompareChange = { compare: number; compareBy: PeriodLength; order: PeriodOrder };

/** Compare with N earlier periods, by months, quarters or years (decision 1353), oldest or newest first (1366). */
function CompareFields({ compare, compareBy, order, onChange }: CompareChange & { onChange: (next: CompareChange) => void }) {
  return (
    <>
      <Field label="Compare with">
        <select value={compare} onChange={(event) => onChange({ compare: Number(event.target.value), compareBy, order })}>
          <option value={0}>None</option>
          {Array.from({ length: MAX_COMPARE_PERIODS }, (_, index) => index + 1).map((count) => (
            <option key={count} value={count}>
              {count} previous {count === 1 ? "period" : "periods"}
            </option>
          ))}
        </select>
      </Field>
      {compare > 0 ? (
        <Field label="Each period">
          <select value={compareBy} onChange={(event) => onChange({ compare, compareBy: event.target.value as PeriodLength, order })}>
            <option value="month">Month</option>
            <option value="quarter">Quarter</option>
            <option value="year">Year</option>
          </select>
        </Field>
      ) : null}
      {compare > 0 ? (
        <Field label="Order">
          <select value={order} onChange={(event) => onChange({ compare, compareBy, order: event.target.value as PeriodOrder })}>
            {(Object.keys(PERIOD_ORDERS) as PeriodOrder[]).map((value) => (
              <option key={value} value={value}>
                {PERIOD_ORDERS[value]}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
    </>
  );
}

function ProfitAndLossReport({ organisationId }: { organisationId: string }) {
  const yearEndMonth = useYearEndMonth(organisationId);
  // No "from" date means the financial year to date (the server works it out
  // from the organisation's year end).
  const [dates, setDates] = useState<ReportDates>(() => ({ from: null, to: todayInBrowser() }));
  const periodOrder = usePeriodOrder("profit_and_loss");
  const [applied, setApplied] = useState<PnlOptions>(() => ({ ...PNL_OPTIONS, order: periodOrder.initial }));
  const [draft, setDraft] = useState<PnlOptions>(() => ({ ...PNL_OPTIONS, order: periodOrder.initial }));
  const tracking = useTracking(organisationId).data;
  const categories = reportCategories(tracking);
  const splitting = categories.some((category) => category.id === applied.splitBy) ? applied.splitBy : "";
  const filter = parseTrackingChoice(applied.tracking);
  const multi = !splitting && (applied.compare > 0 || applied.ytd || applied.percent || (applied.total && applied.compare > 0));
  const layout = useReportLayout(organisationId, "profit_and_loss");
  const inLayout = layout.active && !splitting;
  const layoutRun = useApiData<LayoutRun>(inLayout ? "/api/reports/layout" : null, {
    organisationId,
    base: "profit_and_loss",
    from: dates.from,
    to: dates.to,
    ...trackingQuery(filter),
    ...(applied.compare > 0 ? { compare: applied.compare, compareBy: applied.compareBy, order: applied.order } : {}),
    ...(applied.ytd ? { ytd: true } : {}) });
  const report = useApiData<ProfitAndLoss | ProfitAndLossSplit | MultiColumnStatement>(!layout.loaded || inLayout ? null : "/api/reports/profit-and-loss", {
    organisationId,
    from: dates.from,
    to: dates.to,
    ...trackingQuery(filter),
    ...(splitting ? { splitBy: splitting } : {}),
    ...(multi ? { compare: applied.compare, compareBy: applied.compareBy, order: applied.order, total: applied.total, ytd: applied.ytd, percent: applied.percent } : {}) });
  const data = inLayout ? null : report.data;
  const run = inLayout ? (layoutRun.data?.layout ?? null) : null;
  const runPeriods = run ? run.figures.columns.filter((column) => column.kind === "period") : [];
  // p0 is the chosen period, whichever way the columns run.
  const chosen = runPeriods.find((column) => column.key === "p0") ?? runPeriods[0];
  const from = data ? (data.from as string) : (chosen?.from ?? null);
  const to = data ? data.to : (chosen?.to ?? null);
  const period = from && to ? statementPeriod(from, to, yearEndMonth) : "";
  const lines = data
    ? [
        ...("category" in data ? [`Split by ${data.category.name}`] : []),
        ...(data.filter ? [`Only lines tagged ${data.filter.label}`] : []),
      ]
    : run?.figures.filterLabel
      ? [`Only lines tagged ${run.figures.filterLabel}`]
      : [];
  const loading = inLayout ? layoutRun.loading : report.loading;
  const loadError = inLayout ? layoutRun.error : report.error;
  return (
    <ReportFrame
      label="Profit and loss"
      toolbar={
        <ReportToolbar
          mode="range"
          dates={dates}
          shownFrom={from}
          yearEndMonth={yearEndMonth}
          busy={loading}
          onUpdate={(next) => {
            setDates(next);
            setApplied(draft);
            periodOrder.remember(draft.order, draft.compare > 0);
          }}
          actions={layout.button(to ?? dates.to)}
          filters={
            <>
              <CompareFields
                compare={draft.compare}
                compareBy={draft.compareBy}
                order={draft.order}
                onChange={(next) => setDraft({ ...draft, ...next, splitBy: next.compare > 0 ? "" : draft.splitBy })}
              />
              <TrackingFilterField setup={tracking} value={draft.tracking} onChange={(value) => setDraft({ ...draft, tracking: value })} exclude={draft.splitBy || undefined} />
              {categories.length > 0 && draft.compare === 0 && !draft.ytd && !draft.percent ? (
                <Field label="Columns by">
                  <select value={draft.splitBy} onChange={(event) => setDraft({ ...draft, splitBy: event.target.value })}>
                    <option value="">No tracking columns</option>
                    {categories
                      .filter((category) => category.id !== parseTrackingChoice(draft.tracking)?.categoryId)
                      .map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                  </select>
                </Field>
              ) : null}
              <fieldset className={ui.reportToolbarChecks}>
                <legend className={ui.srOnly}>Extra columns</legend>
                {draft.compare > 0 ? (
                  <label className={ui.checkbox}>
                    <input type="checkbox" checked={draft.total} onChange={(event) => setDraft({ ...draft, total: event.target.checked })} /> Total
                  </label>
                ) : null}
                <label className={ui.checkbox}>
                  <input type="checkbox" checked={draft.ytd} onChange={(event) => setDraft({ ...draft, ytd: event.target.checked, splitBy: event.target.checked ? "" : draft.splitBy })} /> Year to
                  date
                </label>
                <label className={ui.checkbox}>
                  <input
                    type="checkbox"
                    checked={draft.percent}
                    onChange={(event) => setDraft({ ...draft, percent: event.target.checked, splitBy: event.target.checked ? "" : draft.splitBy })}
                  />{" "}
                  % of trading income
                </label>
              </fieldset>
            </>
          }
          more={[...layout.more, printReport, startCustom]}
          info={
            <>
              % of trading income is each amount divided by that column&apos;s total trading income, to one decimal place; it&apos;s blank when there&apos;s none.
              {inLayout ? " In your default layout, the layout's own rows are shown: Total and % of trading income are on the standard layout." : ""}
            </>
          }
          exportProps={
            data || run
              ? {
                  organisationId,
                  report: "profit-and-loss",
                  title: "Profit and loss",
                  period,
                  filters: lines,
                  style: "statement",
                  tables: run ? layoutTables(run) : [{ id: "profit-and-loss-report" }] }
              : null
          }
        />
      }
    >
      <LoadState loading={loading} error={loadError ?? layout.error} />
      {data || run ? <StatementHeading title="Profit and loss" period={period} lines={lines} /> : null}
      {run ? <LayoutFigures run={run} filter={filter} /> : null}
      {data && "category" in data ? <SplitProfitAndLoss report={data} filter={filter} /> : null}
      {data && "rows" in data ? <MultiColumnStatementTable id="profit-and-loss-report" report={data} tracking={filter} /> : null}
      {data && "revenue" in data && !("category" in data) ? <ProfitAndLossTable report={data as ProfitAndLoss} filter={filter} /> : null}
    </ReportFrame>
  );
}

/** The drill-down's tracking filter, as the report has it. */
function filterDrill(filter: TrackingChoice): Pick<Drilldown, "trackingCategoryId" | "trackingValueId" | "trackingUnassigned"> {
  if (!filter) return {};
  return filter.valueId === "unassigned"
    ? { trackingCategoryId: filter.categoryId, trackingUnassigned: true }
    : { trackingCategoryId: filter.categoryId, trackingValueId: filter.valueId };
}

function ProfitAndLossTable({ report, filter }: { report: ProfitAndLoss; filter: TrackingChoice }) {
  const drilldown = { from: report.from, to: report.to, ...filterDrill(filter) };
  const empty = [report.revenue, report.costOfSales, report.otherIncome, report.expenses].every((group) => group.sections.length === 0);
  if (empty) return <Empty>Nothing posted to income or expense accounts in this period.</Empty>;
  return (
    <div className={ui.statementWrap}>
      <table id="profit-and-loss-report" className={`${ui.table} ${ui.statement}`}>
        <thead>
          <tr>
            <AccountHeading />
            <th className={ui.num}>{columnHeading(report.from, report.to)}</th>
          </tr>
        </thead>
        <tbody>
          <GroupRows title="Trading income" group={report.revenue} totalLabel="Total trading income" drilldown={drilldown} />
          <GroupRows title="Cost of sales" group={report.costOfSales} totalLabel="Total cost of sales" drilldown={drilldown} />
          <TotalRow label="Gross profit" value={report.grossProfit} />
          <GroupRows title="Other income" group={report.otherIncome} totalLabel="Total other income" drilldown={drilldown} />
          <GroupRows title="Operating expenses" group={report.expenses} totalLabel="Total operating expenses" drilldown={drilldown} />
        </tbody>
        <tfoot>
          <TotalRow label="Net profit" value={report.netProfit} grand />
        </tfoot>
      </table>
    </div>
  );
}

type SheetOptions = { tracking: string; compare: number; compareBy: PeriodLength; order: PeriodOrder };
const SHEET_OPTIONS: SheetOptions = { tracking: "", compare: 0, compareBy: "month", order: "oldest_first" };

function BalanceSheetReport({ organisationId }: { organisationId: string }) {
  const yearEndMonth = useYearEndMonth(organisationId);
  const [dates, setDates] = useState<ReportDates>(() => ({ from: null, to: todayInBrowser() }));
  const periodOrder = usePeriodOrder("balance_sheet");
  const [applied, setApplied] = useState<SheetOptions>(() => ({ ...SHEET_OPTIONS, order: periodOrder.initial }));
  const [draft, setDraft] = useState<SheetOptions>(() => ({ ...SHEET_OPTIONS, order: periodOrder.initial }));
  const tracking = useTracking(organisationId).data;
  const filter = parseTrackingChoice(applied.tracking);
  const layout = useReportLayout(organisationId, "balance_sheet");
  const layoutRun = useApiData<LayoutRun>(layout.active ? "/api/reports/layout" : null, {
    organisationId,
    base: "balance_sheet",
    asAt: dates.to,
    ...trackingQuery(filter),
    ...(applied.compare > 0 ? { compare: applied.compare, compareBy: applied.compareBy, order: applied.order } : {}) });
  const run = layout.active ? (layoutRun.data?.layout ?? null) : null;
  const report = useApiData<BalanceSheet | MultiColumnStatement>(!layout.loaded || layout.active ? null : "/api/reports/balance-sheet", {
    organisationId,
    asAt: dates.to,
    ...trackingQuery(filter),
    ...(applied.compare > 0 ? { compare: applied.compare, compareBy: applied.compareBy, order: applied.order } : {}) });
  const data = layout.active ? null : report.data;
  const asAt = data ? ("asAt" in data ? data.asAt : data.to) : ((run?.figures.columns.find((column) => column.key === "p0") ?? run?.figures.columns[0])?.to ?? "");
  const period = asAt ? statementAsAt(asAt) : "";
  const lines = data?.filter ? [`Only lines tagged ${data.filter.label}`] : run?.figures.filterLabel ? [`Only lines tagged ${run.figures.filterLabel}`] : [];
  const unbalanced = data ? ("rows" in data ? Object.values(data.balanced ?? {}).some((ok) => !ok) : !data.balanced) : false;
  return (
    <ReportFrame
      label="Balance sheet"
      toolbar={
        <ReportToolbar
          mode="asAt"
          dates={dates}
          yearEndMonth={yearEndMonth}
          onUpdate={(next) => {
            setDates(next);
            setApplied(draft);
            periodOrder.remember(draft.order, draft.compare > 0);
          }}
          busy={report.loading || layoutRun.loading}
          actions={layout.button(dates.to)}
          filters={
            <>
              <CompareFields compare={draft.compare} compareBy={draft.compareBy} order={draft.order} onChange={(next) => setDraft({ ...draft, ...next })} />
              <TrackingFilterField setup={tracking} value={draft.tracking} onChange={(value) => setDraft({ ...draft, tracking: value })} />
            </>
          }
          info={draft.tracking ? <>Filtered by tracking, a balance sheet only balances when both sides of each journal are tagged.</> : null}
          more={[...layout.more, printReport, startCustom]}
          exportProps={
            data || run
              ? {
                  organisationId,
                  report: "balance-sheet",
                  title: "Balance sheet",
                  period,
                  filters: lines,
                  style: "statement",
                  tables: run ? layoutTables(run) : [{ id: "balance-sheet-report" }] }
              : null
          }
        />
      }
    >
      <LoadState loading={report.loading || layoutRun.loading} error={report.error ?? layoutRun.error ?? layout.error} />
      {data || run ? <StatementHeading title="Balance sheet" period={period} lines={lines} /> : null}
      {run ? <LayoutFigures run={run} filter={filter} /> : null}
      {unbalanced ? (
        <Notice tone="warning">
          {data && "rows" in data
            ? "Total assets less liabilities doesn't equal total equity in at least one column."
            : data && !("rows" in data)
              ? `Total assets less liabilities (${formatMoney(data.netAssets)}) doesn't equal total equity (${formatMoney(data.equity.total)}).`
              : null}
          {filter ? " With a tracking filter, both sides of each journal need the tag." : null}
        </Notice>
      ) : null}
      {data && "rows" in data ? <MultiColumnStatementTable id="balance-sheet-report" report={data} tracking={filter} /> : null}
      {data && !("rows" in data) ? <BalanceSheetTable report={data} filter={filter} /> : null}
    </ReportFrame>
  );
}

function BalanceSheetTable({ report, filter }: { report: BalanceSheet; filter: TrackingChoice }) {
  const drilldown = { from: report.financialYearStart, to: report.asAt, ...filterDrill(filter) };
  const retained = report.equity.retainedEarnings;
  return (
    <div className={ui.statementWrap}>
      <table id="balance-sheet-report" className={`${ui.table} ${ui.statement}`}>
        <thead>
          <tr>
            <AccountHeading />
            <th className={ui.num}>{columnHeading(null, report.asAt)}</th>
          </tr>
        </thead>
        <tbody>
          <TermGroupRows title="Assets" group={report.assets} drilldown={drilldown} />
          <TermGroupRows title="Liabilities" group={report.liabilities} drilldown={drilldown} />
          <TotalRow label="Net assets" value={report.netAssets} grand />
          <tr className={ui.reportHeading}>
            <td colSpan={2}>Equity</td>
          </tr>
          {report.equity.sections.flatMap((section) => section.lines.map((line) => <AccountLine key={line.accountId} line={line} drilldown={drilldown} />))}
          <tr className={ui.reportSection}>
            <td>
              {retained.account ? `${retained.account.code} · ${retained.account.name}` : "Retained earnings"}{" "}
              <span data-export-ignore>
                <InfoTip label="Retained earnings">Profit before {formatDate(report.financialYearStart)}, with anything posted to the account.</InfoTip>
              </span>
            </td>
            <td className={ui.num}>
              {retained.account ? (
                <AccountAmount accountId={retained.account.id} value={retained.total} drilldown={drilldown} />
              ) : (
                <Money value={retained.total} />
              )}
            </td>
          </tr>
          <tr className={ui.reportSection}>
            <td>
              Current year earnings{" "}
              <span data-export-ignore>
                <InfoTip label="Current year earnings">Profit since {formatDate(report.financialYearStart)}, the start of this financial year.</InfoTip>
              </span>
            </td>
            <td className={ui.num}>
              <Money value={report.equity.currentYearEarnings} />
            </td>
          </tr>
          <TotalRow label="Total equity" value={report.equity.total} grand />
        </tbody>
      </table>
    </div>
  );
}

function StockReport({ organisationId }: { organisationId: string }) {
  const report = useApiData<Valuation>("/api/reports/inventory-valuation", { organisationId });
  const save = useSaveAsCustomReport(organisationId, "inventory_valuation", { asAt: null });
  return (
    <Card
      title="Stock on hand"
      actions={
        save.allowed ? (
          <Button variant="secondary" size="small" disabled={save.busy} onClick={() => void save.save()}>
            {save.busy ? "Saving…" : "Save as custom report"}
          </Button>
        ) : null
      }
    >
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {save.error ? <Notice tone="error">{save.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {report.data ? (
        <ReportExport
          organisationId={organisationId}
          report="inventory-valuation"
          title="Stock on hand"
          period={`As at ${formatDate(todayInBrowser())}`}
          tables={[{ id: "inventory-valuation-report" }]}
        />
      ) : null}
      {report.data ? (
        report.data.items.length === 0 ? (
          <Empty>No stock on hand.</Empty>
        ) : (
          <>
            <div className={ui.tableWrap}>
              <table id="inventory-valuation-report" className={ui.table}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Location</th>
                  <th className={ui.num}>On hand</th>
                  <th className={ui.num}>Average cost</th>
                  <th className={ui.num}>Value</th>
                  <th>Last movement</th>
                </tr>
              </thead>
              <tbody>
                {report.data.items.map((item) => (
                  <tr key={`${item.itemCode}|${item.locationValueId ?? ""}`}>
                    <td>
                      {item.itemCode}
                      {item.itemName ? <span className={ui.muted}> · {item.itemName}</span> : null}
                    </td>
                    <td>{item.locationName ?? ""}</td>
                    <td className={ui.num}>
                      <span data-export-value={item.quantity}>{formatQuantity(item.quantity)}</span>
                      {item.unit ? ` ${item.unit}` : ""}
                    </td>
                    <td className={ui.num}>{item.averageCost ? formatMoney(item.averageCost, 4) : ""}</td>
                    <td className={ui.num}>
                      <Money value={item.value} />
                    </td>
                    <td>{formatDate(item.lastMovementDate)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>Total ({report.data.currencyCode})</td>
                  <td className={ui.num}>
                    <Money value={report.data.totalValue} />
                  </td>
                  <td />
                </tr>
                {report.data.inventoryAccountCode ? (
                  <tr>
                    <td colSpan={4}>Inventory account {report.data.inventoryAccountCode} in the ledger</td>
                    <td className={ui.num}>
                      <Money value={report.data.inventoryAccountBalance} />
                    </td>
                    <td />
                  </tr>
                ) : null}
              </tfoot>
                </table>
              </div>
            </>
        )
      ) : null}
    </Card>
  );
}

/** The standard reports, in the picker's groups (decision 1323). */
const TABS = [
  { key: "pnl", label: "Profit and loss", group: "Financial statements" },
  { key: "bs", label: "Balance sheet", group: "Financial statements" },
  { key: "equity", label: "Changes in equity", group: "Financial statements" },
  { key: "cashflow", label: "Cash flows", group: "Financial statements" },
  { key: "statements", label: "Annual financial statements", group: "Financial statements" },
  { key: "aged", label: "Aged receivables", group: "Owed and owing" },
  { key: "payables", label: "Aged payables", group: "Owed and owing" },
  { key: "sales", label: "Sales by salesperson", group: "Owed and owing" },
  { key: "tb", label: "Trial balance", group: "Ledger" },
  { key: "transactions", label: "Account transactions", group: "Ledger" },
  { key: "journals", label: "Journal report", group: "Ledger" },
  { key: "bankrec", label: "Bank reconciliation", group: "Ledger" },
  { key: "stock", label: "Stock valuation", group: "Ledger" },
  { key: "budget", label: "Budget vs actual", group: "Budgets" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const TAB_GROUPS = [...new Set(TABS.map((entry) => entry.group))];

function StandardReports({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  // The report shown is in the address (?report=), so the menus can open each one.
  const tab: TabKey = TABS.find((entry) => entry.key === params.get("report"))?.key ?? "pnl";
  // Sales by salesperson is an advanced feature (SR3).
  const advanced = useSalespeople(organisationId).data?.advancedFeatures ?? false;
  const shown = TABS.filter((entry) => entry.key !== "sales" || advanced || tab === "sales");
  // Saved reports are in the picker too, with each person's favourites first (decision 1362).
  const drafts = useApiData<{ reports: Array<{ id: string; title: string }> }>("/api/custom-reports", { organisationId, view: "drafts" });
  const published = useApiData<{ reports: Array<{ id: string; title: string }> }>("/api/custom-reports", { organisationId, view: "published" });
  const custom = [
    ...(drafts.data?.reports ?? []).map((report) => ({ key: `custom:${report.id}`, label: `${report.title} (draft)` })),
    ...(published.data?.reports ?? []).map((report) => ({ key: `custom:${report.id}`, label: report.title })),
  ];
  const favourite = useFavourite(organisationId, `std:${tab}`);
  const labelOf = (key: string) => (key.startsWith("std:") ? TABS.find((entry) => `std:${entry.key}` === key)?.label : custom.find((entry) => entry.key === key)?.label);
  const starred = favourite.favourites.filter((key) => labelOf(key));
  const choose = (value: string) => {
    if (value.startsWith("custom:")) router.push(`/operations/reports/custom/${value.slice(7)}`);
    else router.replace(`/operations/reports?report=${value.replace(/^std:/, "")}`, { scroll: false });
  };
  return (
    <div className={ui.standardReport}>
      <div className={`${ui.reportPicker} ${ui.reportPickerRow}`} data-print="hide">
        <Field label="Report">
          <select value={`std:${tab}`} onChange={(event) => choose(event.target.value)}>
            {starred.length > 0 ? (
              <optgroup label="Favourites">
                {starred.map((key) => (
                  <option key={`fav-${key}`} value={key}>
                    ★ {labelOf(key)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {TAB_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {shown
                  .filter((entry) => entry.group === group)
                  .map((entry) => (
                    <option key={entry.key} value={`std:${entry.key}`}>
                      {entry.label}
                    </option>
                  ))}
              </optgroup>
            ))}
            {custom.length > 0 ? (
              <optgroup label="Custom reports">
                {custom.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </Field>
        <FavouriteToggle favourite={favourite} name={TABS.find((entry) => entry.key === tab)?.label ?? ""} />
      </div>
      {tab === "pnl" ? <ProfitAndLossReport organisationId={organisationId} /> : null}
      {tab === "bs" ? <BalanceSheetReport organisationId={organisationId} /> : null}
      {tab === "tb" ? <TrialBalanceReport organisationId={organisationId} /> : null}
      {tab === "equity" ? <ChangesInEquityReport organisationId={organisationId} /> : null}
      {tab === "cashflow" ? <CashFlowStatementReport organisationId={organisationId} /> : null}
      {tab === "statements" ? <AnnualStatementsReport organisationId={organisationId} /> : null}
      {tab === "stock" ? <StockReport organisationId={organisationId} /> : null}
      {tab === "aged" ? <AgedReceivablesReport organisationId={organisationId} /> : null}
      {tab === "payables" ? <AgedPayablesReport organisationId={organisationId} /> : null}
      {tab === "transactions" ? (
        <AccountTransactionsReport
          organisationId={organisationId}
          initialAccountId={params.get("account")}
          initialAccountIds={params.get("accounts")}
          initialFrom={params.get("from")}
          initialTo={params.get("to")}
          initialTrackingCategoryId={params.get("trackingCategoryId")}
          initialTrackingValueId={params.get("trackingValueId")}
        />
      ) : null}
      {tab === "bankrec" ? (
        <BankReconciliationReportView organisationId={organisationId} initialAccountId={params.get("account")} initialAsAt={params.get("asAt")} />
      ) : null}
      {tab === "journals" ? <JournalReportView organisationId={organisationId} /> : null}
      {tab === "sales" ? <SalesBySalespersonReport organisationId={organisationId} /> : null}
      {tab === "budget" ? <BudgetVsActualReport organisationId={organisationId} initialBudgetId={params.get("budget")} /> : null}
    </div>
  );
}

/** Reports: the standard reports (Home), and custom reports: new, drafts, published and archived (examples CR1-CR10). */
const VIEWS = [
  { key: "home", label: "Home" },
  { key: "custom", label: "Custom" },
  { key: "drafts", label: "Drafts" },
  { key: "published", label: "Published" },
  { key: "archived", label: "Archived" },
] as const;
type ViewKey = (typeof VIEWS)[number]["key"];

function Reports({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const view: ViewKey = VIEWS.find((entry) => entry.key === params.get("view"))?.key ?? "home";
  return (
    <>
      <div className={ui.tabs} role="tablist" aria-label="Reports" data-print="hide">
        {VIEWS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={view === entry.key}
            className={`${ui.tab} ${view === entry.key ? ui.tabActive : ""}`}
            onClick={() => router.replace(entry.key === "home" ? "/operations/reports" : `/operations/reports?view=${entry.key}`, { scroll: false })}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {view === "home" ? <StandardReports organisationId={organisationId} /> : null}
      {view === "custom" ? <StartCustomReport organisationId={organisationId} /> : null}
      {view === "drafts" || view === "published" || view === "archived" ? <CustomReportList key={view} organisationId={organisationId} view={view} /> : null}
    </>
  );
}

export default function ReportsPage() {
  return (
    <Page>
      <PageHeader title="Reports" />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <Reports key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
