"use client";

import { Fragment, useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { GstReturnReport } from "@/components/reports/gst-return";
import { Badge, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { formatDate, formatMoney, formatQuantity, todayInBrowser } from "@/lib/format";

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
  items: Array<{ itemCode: string; quantity: string; value: string; averageCost: string | null; lastMovementDate: string | null }>;
  totalValue: string;
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
  const report = useApiData<ProfitAndLoss>("/api/reports/profit-and-loss", { organisationId, from, to });
  return (
    <Card
      title="Profit and loss"
      actions={
        <div className={ui.inlineForm}>
          <Field label="From">
            <input
              type="date"
              value={from ?? report.data?.from ?? ""}
              onChange={(event) => setFrom(event.target.value || null)}
            />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
        </div>
      }
    >
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {report.data ? (
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
    <Card title="Stock valuation" description="Weighted average cost. Matches the inventory account to the cent.">
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
                  <th className={ui.num}>On hand</th>
                  <th className={ui.num}>Average cost</th>
                  <th className={ui.num}>Value</th>
                  <th>Last movement</th>
                </tr>
              </thead>
              <tbody>
                {report.data.items.map((item) => (
                  <tr key={item.itemCode}>
                    <td>{item.itemCode}</td>
                    <td className={ui.num}>{formatQuantity(item.quantity)}</td>
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
                  <td colSpan={3}>Total ({report.data.currencyCode})</td>
                  <td className={ui.num}>
                    <Money value={report.data.totalValue} />
                  </td>
                  <td />
                </tr>
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
  { key: "gst", label: "GST return" },
] as const;

function Reports({ organisationId }: { organisationId: string }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("pnl");
  return (
    <>
      <div className={ui.tabs} role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={`${ui.tab} ${tab === entry.key ? ui.tabActive : ""}`}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {tab === "pnl" ? <ProfitAndLossReport organisationId={organisationId} /> : null}
      {tab === "bs" ? <BalanceSheetReport organisationId={organisationId} /> : null}
      {tab === "tb" ? <TrialBalanceReport organisationId={organisationId} /> : null}
      {tab === "stock" ? <StockReport organisationId={organisationId} /> : null}
      {tab === "gst" ? <GstReturnReport organisationId={organisationId} /> : null}
    </>
  );
}

export default function ReportsPage() {
  return (
    <Page>
      <PageHeader title="Reports" description="Built straight from the ledger, in the organisation's base currency." />
      <RequireOrganisation>{(organisationId) => <Reports key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
