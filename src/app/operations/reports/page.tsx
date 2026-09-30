"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { BudgetVsActualReport } from "@/components/budgets";
import { BankReconciliationReportView } from "@/components/reports/bank-reconciliation";
import { AgedReceivablesReport } from "@/components/customers";
import { AccountTransactionsReport, AgedPayablesReport, JournalReportView } from "@/components/reports/ledger-reports";
import { CustomReportList, StartCustomReport } from "@/components/reports/custom-report";
import { SalesBySalespersonReport, useSalespeople } from "@/components/salespeople";
import { reportCategories, useTracking } from "@/components/tracking";
import { Badge, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { formatDate, formatMoney, formatQuantity, todayInBrowser } from "@/lib/format";
import type { ProfitAndLossSplit, SplitColumn, SplitGroup } from "@/lib/reports/financial";

type Line = { accountId: string; code: string; name: string; amount: string };
type Section = { key: string; label: string; lines: Line[]; total: string };
type Group = { sections: Section[]; total: string };

type TrialBalance = {
  asAt: string;
  currencyCode: string;
  rows: Array<{ accountId: string; code: string; name: string; debit: string; credit: string }>;
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
};
type ProfitAndLoss = {
  from: string;
  to: string;
  currencyCode: string;
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
  assets: Group;
  liabilities: Group;
  equity: Group & { previousYearsEarnings: string; currentYearEarnings: string };
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

function GroupRows({ title, group, totalLabel }: { title: string; group: Group; totalLabel: string }) {
  return (
    <>
      <tr className={ui.reportHeading}>
        <td colSpan={2}>{title}</td>
      </tr>
      {group.sections.length === 0 ? (
        <tr>
          <td className={ui.muted} colSpan={2}>
            Nothing in this period.
          </td>
        </tr>
      ) : null}
      {group.sections.map((section) => (
        <Fragment key={section.key}>
          {group.sections.length > 1 ? (
            <tr>
              <td className={ui.muted} colSpan={2}>
                {section.label}
              </td>
            </tr>
          ) : null}
          {section.lines.map((line) => (
            <tr key={line.accountId} className={ui.reportSection}>
              <td>
                {line.code} · {line.name}
              </td>
              <td className={ui.num}>
                <Money value={line.amount} />
              </td>
            </tr>
          ))}
        </Fragment>
      ))}
      <tr className={ui.reportTotal}>
        <td>{totalLabel}</td>
        <td className={ui.num}>
          <Money value={group.total} />
        </td>
      </tr>
    </>
  );
}

function SplitGroupRows({ title, group, columns, totalLabel }: { title: string; group: SplitGroup; columns: SplitColumn[]; totalLabel: string }) {
  const span = columns.length + 1;
  return (
    <>
      <tr className={ui.reportHeading}>
        <td colSpan={span}>{title}</td>
      </tr>
      {group.sections.length === 0 ? (
        <tr>
          <td className={ui.muted} colSpan={span}>
            Nothing in this period.
          </td>
        </tr>
      ) : null}
      {group.sections.map((section) => (
        <Fragment key={section.key}>
          {group.sections.length > 1 ? (
            <tr>
              <td className={ui.muted} colSpan={span}>
                {section.label}
              </td>
            </tr>
          ) : null}
          {section.lines.map((line) => (
            <tr key={line.accountId} className={ui.reportSection}>
              <td>
                {line.code} · {line.name}
              </td>
              {columns.map((column) => (
                <td key={column.key} className={ui.num}>
                  <Money value={line.amounts[column.key]} />
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
function SplitProfitAndLoss({ report }: { report: ProfitAndLossSplit }) {
  const { columns } = report;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
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
          <SplitGroupRows title="Trading income" group={report.revenue} columns={columns} totalLabel="Total trading income" />
          <SplitGroupRows title="Cost of sales" group={report.costOfSales} columns={columns} totalLabel="Total cost of sales" />
          <tr className={ui.reportTotal}>
            <td>Gross profit</td>
            {columns.map((column) => (
              <td key={column.key} className={ui.num}>
                <Money value={report.grossProfit[column.key]} />
              </td>
            ))}
          </tr>
          <SplitGroupRows title="Other income" group={report.otherIncome} columns={columns} totalLabel="Total other income" />
          <SplitGroupRows title="Operating expenses" group={report.expenses} columns={columns} totalLabel="Total operating expenses" />
        </tbody>
        <tfoot>
          <tr>
            <td>Net profit ({report.currencyCode})</td>
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

function TrialBalanceReport({ organisationId }: { organisationId: string }) {
  const [asAt, setAsAt] = useState(todayInBrowser);
  const report = useApiData<TrialBalance>("/api/reports/trial-balance", { organisationId, asAt });
  return (
    <Card title="Trial balance" actions={<Field label="As at"><input type="date" value={asAt} onChange={(event) => setAsAt(event.target.value)} /></Field>}>
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {report.data ? (
        report.data.rows.length === 0 ? (
          <Empty>No postings up to {formatDate(report.data.asAt)}.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th className={ui.num}>Debit</th>
                  <th className={ui.num}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {report.data.rows.map((row) => (
                  <tr key={row.accountId}>
                    <td>
                      {row.code} · {row.name}
                    </td>
                    <td className={ui.num}>
                      <Money value={row.debit} blankZero />
                    </td>
                    <td className={ui.num}>
                      <Money value={row.credit} blankZero />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    Total ({report.data.currencyCode}){" "}
                    {report.data.balanced ? <Badge tone="green">Balanced</Badge> : <Badge tone="red">Out of balance</Badge>}
                  </td>
                  <td className={ui.num}>
                    <Money value={report.data.totalDebit} />
                  </td>
                  <td className={ui.num}>
                    <Money value={report.data.totalCredit} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      ) : null}
    </Card>
  );
}

function ProfitAndLossReport({ organisationId }: { organisationId: string }) {
  // No "from" date means the financial year to date (the server works it out
  // from the organisation's year end).
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState(todayInBrowser);
  const [splitBy, setSplitBy] = useState("");
  const categories = reportCategories(useTracking(organisationId).data);
  const splitting = categories.some((category) => category.id === splitBy) ? splitBy : "";
  const report = useApiData<ProfitAndLoss>(splitting ? null : "/api/reports/profit-and-loss", { organisationId, from, to });
  const split = useApiData<ProfitAndLossSplit>(splitting ? "/api/reports/profit-and-loss" : null, { organisationId, from, to, splitBy: splitting });
  const shown = splitting ? split : report;
  return (
    <Card
      title="Profit and loss"
      actions={
        <div className={ui.inlineForm}>
          <Field label="From">
            <input
              type="date"
              value={from ?? shown.data?.from ?? ""}
              onChange={(event) => setFrom(event.target.value || null)}
            />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          {categories.length > 0 ? (
            <Field label="Split by">
              <select value={splitting} onChange={(event) => setSplitBy(event.target.value)}>
                <option value="">No split</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      }
    >
      {shown.error ? <Notice tone="error">{shown.error}</Notice> : null}
      {shown.loading ? <p className={ui.muted}>Loading…</p> : null}
      {splitting && split.data ? <SplitProfitAndLoss report={split.data} /> : null}
      {!splitting && report.data ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <tbody>
              <GroupRows title="Trading income" group={report.data.revenue} totalLabel="Total trading income" />
              <GroupRows title="Cost of sales" group={report.data.costOfSales} totalLabel="Total cost of sales" />
              <tr className={ui.reportTotal}>
                <td>Gross profit</td>
                <td className={ui.num}>
                  <Money value={report.data.grossProfit} />
                </td>
              </tr>
              <GroupRows title="Other income" group={report.data.otherIncome} totalLabel="Total other income" />
              <GroupRows title="Operating expenses" group={report.data.expenses} totalLabel="Total operating expenses" />
            </tbody>
            <tfoot>
              <tr>
                <td>Net profit ({report.data.currencyCode})</td>
                <td className={ui.num}>
                  <Money value={report.data.netProfit} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function BalanceSheetReport({ organisationId }: { organisationId: string }) {
  const [asAt, setAsAt] = useState(todayInBrowser);
  const report = useApiData<BalanceSheet>("/api/reports/balance-sheet", { organisationId, asAt });
  return (
    <Card title="Balance sheet" actions={<Field label="As at"><input type="date" value={asAt} onChange={(event) => setAsAt(event.target.value)} /></Field>}>
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {report.data ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <tbody>
              <GroupRows title="Assets" group={report.data.assets} totalLabel="Total assets" />
              <GroupRows title="Liabilities" group={report.data.liabilities} totalLabel="Total liabilities" />
              <tr className={ui.reportHeading}>
                <td colSpan={2}>Equity</td>
              </tr>
              {report.data.equity.sections.flatMap((section) =>
                section.lines.map((line) => (
                  <tr key={line.accountId} className={ui.reportSection}>
                    <td>
                      {line.code} · {line.name}
                    </td>
                    <td className={ui.num}>
                      <Money value={line.amount} />
                    </td>
                  </tr>
                )),
              )}
              <tr className={ui.reportSection}>
                <td>Earnings from previous years</td>
                <td className={ui.num}>
                  <Money value={report.data.equity.previousYearsEarnings} />
                </td>
              </tr>
              <tr className={ui.reportSection}>
                <td>Current year earnings (since {formatDate(report.data.financialYearStart)})</td>
                <td className={ui.num}>
                  <Money value={report.data.equity.currentYearEarnings} />
                </td>
              </tr>
              <tr className={ui.reportTotal}>
                <td>Total equity</td>
                <td className={ui.num}>
                  <Money value={report.data.equity.total} />
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>
                  Liabilities + equity ({report.data.currencyCode}){" "}
                  {report.data.balanced ? <Badge tone="green">Balances</Badge> : <Badge tone="red">Doesn&apos;t balance</Badge>}
                </td>
                <td className={ui.num}>
                  <Money value={report.data.liabilitiesAndEquity} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function StockReport({ organisationId }: { organisationId: string }) {
  const report = useApiData<Valuation>("/api/reports/inventory-valuation", { organisationId });
  return (
    <Card title="Stock on hand" description="By item and location, at weighted average cost per location. Matches the inventory account to the cent.">
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {report.data ? (
        report.data.items.length === 0 ? (
          <Empty>No stock on hand.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
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
                      {formatQuantity(item.quantity)}
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
        )
      ) : null}
    </Card>
  );
}

const TABS = [
  { key: "pnl", label: "Profit and loss" },
  { key: "bs", label: "Balance sheet" },
  { key: "tb", label: "Trial balance" },
  { key: "stock", label: "Stock valuation" },
  { key: "aged", label: "Aged receivables" },
  { key: "payables", label: "Aged payables" },
  { key: "transactions", label: "Account transactions" },
  { key: "bankrec", label: "Bank reconciliation" },
  { key: "journals", label: "Journal report" },
  { key: "sales", label: "Sales by salesperson" },
  { key: "budget", label: "Budget vs actual" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function StandardReports({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  // The report shown is in the address (?report=), so the menus can open each one.
  const tab: TabKey = TABS.find((entry) => entry.key === params.get("report"))?.key ?? "pnl";
  // Sales by salesperson is an advanced feature (SR3).
  const advanced = useSalespeople(organisationId).data?.advancedFeatures ?? false;
  return (
    <>
      <div className={ui.tabs} role="tablist" aria-label="Standard reports" data-print="hide">
        {TABS.filter((entry) => entry.key !== "sales" || advanced || tab === "sales").map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={`${ui.tab} ${tab === entry.key ? ui.tabActive : ""}`}
            onClick={() => router.replace(`/operations/reports?report=${entry.key}`, { scroll: false })}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {tab === "pnl" ? <ProfitAndLossReport organisationId={organisationId} /> : null}
      {tab === "bs" ? <BalanceSheetReport organisationId={organisationId} /> : null}
      {tab === "tb" ? <TrialBalanceReport organisationId={organisationId} /> : null}
      {tab === "stock" ? <StockReport organisationId={organisationId} /> : null}
      {tab === "aged" ? <AgedReceivablesReport organisationId={organisationId} /> : null}
      {tab === "payables" ? <AgedPayablesReport organisationId={organisationId} /> : null}
      {tab === "transactions" ? <AccountTransactionsReport organisationId={organisationId} /> : null}
      {tab === "bankrec" ? <BankReconciliationReportView organisationId={organisationId} initialAccountId={params.get("account")} /> : null}
      {tab === "journals" ? <JournalReportView organisationId={organisationId} /> : null}
      {tab === "sales" ? <SalesBySalespersonReport organisationId={organisationId} /> : null}
      {tab === "budget" ? <BudgetVsActualReport organisationId={organisationId} initialBudgetId={params.get("budget")} /> : null}
      <p className={ui.muted} data-print="hide">
        The GST return and GST audit report are under <Link href="/operations/gst-return">Tax</Link>; customer statements are under{" "}
        <Link href="/operations/customer-statements">Contacts</Link>.
      </p>
    </>
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
      <PageHeader title="Reports" description="Built straight from the ledger, in the organisation's base currency." />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <Reports key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
