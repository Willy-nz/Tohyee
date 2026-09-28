"use client";

import Link from "next/link";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Card, Empty, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
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
  const banks = useApiData<{ bankAccounts: BankAccount[] }>("/api/bank-accounts", { organisationId });
  const error = pnl.error ?? bs.error ?? stock.error ?? journals.error ?? banks.error;

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.statRow}>
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
      {banks.data && banks.data.bankAccounts.length > 0 ? (
        <Card title="Bank accounts" actions={<Link href="/operations/bank-accounts">All bank accounts</Link>}>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th className={ui.num}>Statement balance</th>
                  <th className={ui.num}>Balance in Tohyee</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {banks.data.bankAccounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <Link href={`/operations/bank-accounts/${account.id}`}>
                        {account.code} · {account.name}
                      </Link>
                    </td>
                    <td className={ui.num}>{account.statementBalance !== null ? <Money value={account.statementBalance} /> : "—"}</td>
                    <td className={ui.num}>
                      <Money value={account.ledgerBalance} />
                    </td>
                    <td>
                      {account.unreconciledCount > 0 ? (
                        <Link href={`/operations/bank-accounts/${account.id}`}>
                          Reconcile {account.unreconciledCount} {account.unreconciledCount === 1 ? "item" : "items"}
                        </Link>
                      ) : (
                        <span className={ui.muted}>All reconciled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
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
        description="A quick look at the books. Amounts are in the organisation's base currency."
      />
      <RequireOrganisation>{(organisationId) => <Overview organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
