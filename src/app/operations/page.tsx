"use client";

import Link from "next/link";
import { Money, RequireOrganisation } from "@/components/books";
import { HomeTiles } from "@/components/home/home";
import { LeaveLiabilityReminders } from "@/components/payroll-leave";
import { RdDeadlineReminders } from "@/components/rd-claim";
import { useApiData } from "@/components/hooks";
import { Card, Empty, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Journal } from "@/lib/ledger/journals";
import { formatDate, todayInBrowser } from "@/lib/format";

type ProfitAndLoss = { from: string; netProfit: string; revenue: { total: string } };
type BalanceSheet = { assets: { total: string }; balanced: boolean };
type Valuation = { totalValue: string };

function Overview({ organisationId }: { organisationId: string }) {
  const today = todayInBrowser();
  // No "from" date: the financial year to date.
  const pnl = useApiData<ProfitAndLoss>("/api/reports/profit-and-loss", { organisationId, to: today });
  const bs = useApiData<BalanceSheet>("/api/reports/balance-sheet", { organisationId, asAt: today });
  const stock = useApiData<Valuation>("/api/reports/inventory-valuation", { organisationId });
  const journals = useApiData<{ journals: Journal[] }>("/api/ledger/journals", { organisationId, limit: 8 });
  const error = pnl.error ?? bs.error ?? stock.error ?? journals.error;

  return (
    <>
      <RdDeadlineReminders organisationId={organisationId} />
      <LeaveLiabilityReminders organisationId={organisationId} />
      <HomeTiles organisationId={organisationId} />
      <h2 style={{ margin: "8px 0 10px", fontSize: "1.05rem" }}>This financial year</h2>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.statRow} style={{ marginBottom: 16 }}>
        <Stat
          label={pnl.data ? `Income since ${formatDate(pnl.data.from)}` : "Income this financial year"}
          value={<Money value={pnl.data?.revenue.total ?? "0"} />}
        />
        <Stat label="Net profit this financial year" value={<Money value={pnl.data?.netProfit ?? "0"} />} />
        <Stat label="Total assets today" value={<Money value={bs.data?.assets.total ?? "0"} />} />
        <Stat label="Stock on hand" value={<Money value={stock.data?.totalValue ?? "0"} />} />
      </div>
      {bs.data && !bs.data.balanced ? (
        <Notice tone="error">The balance sheet doesn&apos;t balance. That shouldn&apos;t be possible; please report it.</Notice>
      ) : null}
      <Card
        title="Latest journals"
        actions={<Link href="/operations/ledger-journals">All journals</Link>}
      >
        {journals.data && journals.data.journals.length === 0 ? (
          <Empty>
            Nothing posted yet. Start with a <Link href="/operations/ledger-journals">journal</Link> or a{" "}
            <Link href="/operations/inventory">stock movement</Link>.
          </Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Description</th>
                  <th className={ui.num}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {(journals.data?.journals ?? []).map((journal) => (
                  <tr key={journal.id}>
                    <td>
                      <Link href={`/operations/ledger-journals?journal=${journal.id}`}>{journal.id}</Link>
                    </td>
                    <td>{formatDate(journal.postingDate)}</td>
                    <td>{journal.reference}</td>
                    <td className={ui.muted}>{journal.description}</td>
                    <td className={ui.num}>
                      <Money value={journal.totalDebit} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export default function OperationsPage() {
  const { current } = useWorkspace();
  return (
    <Page>
      <PageHeader
        title={current ? current.displayName : "Welcome to Tohyee"}
        description="Home: your bank accounts, what's owed each way and the next GST return. Amounts are in the organisation's base currency."
      />
      <RequireOrganisation>{(organisationId) => <Overview organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
