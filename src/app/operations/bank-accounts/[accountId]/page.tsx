"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ACCOUNT_TYPE_LABELS, FeedBadge } from "@/components/bank/common";
import { CurrencyMoney, OpeningBalancePanel } from "@/components/bank/foreign";
import { FeedPanel } from "@/components/bank/feed-panel";
import { FileFeedsPanel } from "@/components/bank/file-feeds-panel";
import { ImportPanel } from "@/components/bank/import-panel";
import { StatementLinesPanel, TransactionsPanel } from "@/components/bank/lines-panel";
import { ReconcilePanel } from "@/components/bank/reconcile-panel";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Card, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
import { formatDate, formatDateTime } from "@/lib/format";

const TABS = ["reconcile", "lines", "import", "feed", "transactions"] as const;
type Tab = (typeof TABS)[number];

function BankAccountView({ organisationId, accountId }: { organisationId: string; accountId: string }) {
  const detail = useApiData<{ bankAccount: BankAccount }>(`/api/bank-accounts/${accountId}`, { organisationId });
  const { can, current } = useWorkspace();
  const [tab, setTab] = useState<Tab>("reconcile");

  if (detail.error) return <Notice tone="error">{detail.error}</Notice>;
  if (!detail.data) return <p className={ui.muted}>Loading…</p>;
  const account = detail.data.bankAccount;
  const labels: Record<Tab, string> = {
    reconcile: `Reconcile${account.unreconciledCount ? ` (${account.unreconciledCount})` : ""}`,
    lines: "Statement lines",
    import: "Import a statement",
    feed: "Bank feed",
    transactions: "Bank transactions",
  };
  // A foreign-currency account's statement is in its currency, so compare its balance in that currency (FXB7).
  const balanceInCurrency = account.isForeign ? account.foreignBalance : account.ledgerBalance;
  const difference =
    account.statementBalance !== null &&
    balanceInCurrency !== null &&
    account.unreconciledCount === 0 &&
    account.statementBalance !== balanceInCurrency;
  const money = (value: string | null) =>
    account.isForeign ? <CurrencyMoney currency={account.statementCurrency} value={value} /> : value === null ? "—" : <Money value={value} />;

  return (
    <>
      <PageHeader
        title={`${account.code} · ${account.name}`}
        description={`${ACCOUNT_TYPE_LABELS[account.accountType]}${account.currencyCode ? ` in ${account.currencyCode}` : ""}${account.isActive ? "" : " (archived)"}`}
      />
      <p className={ui.actions} style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <Link href="/operations/bank-accounts">← All bank accounts</Link>
        <Link href={`/operations/reports?report=bankrec&account=${account.id}`}>Bank reconciliation report</Link>
      </p>
      <div className={ui.statRow}>
        <Stat
          label={account.statementBalanceAt ? `Statement balance (${formatDateTime(account.statementBalanceAt)})` : "Statement balance"}
          value={account.statementBalance !== null ? money(account.statementBalance) : "—"}
        />
        <Stat
          label="Balance in Tohyee"
          value={
            account.isForeign ? (
              <>
                {money(account.foreignBalance)}
                <div className={ui.muted}>
                  <CurrencyMoney currency={current?.baseCurrency ?? "NZD"} value={account.ledgerBalance} />
                </div>
              </>
            ) : (
              <Money value={account.ledgerBalance} />
            )
          }
        />
        <Stat label="Lines to reconcile" value={account.unreconciledCount} />
        <Stat
          label={account.lastLineDate ? `Latest line ${formatDate(account.lastLineDate)}` : "Bank feed"}
          value={<FeedBadge feed={account.feed} />}
        />
      </div>
      {account.isForeign ? (
        <OpeningBalancePanel organisationId={organisationId} account={account} canEnter={can("bookkeeper")} onSaved={detail.reload} />
      ) : null}
      {account.isForeign ? (
        <p className={ui.muted}>
          Statement lines, matching and the reconciliation report are in {account.statementCurrency}, with{" "}
          {current?.baseCurrency ?? "NZD"} beside them. Spend and receive money use an exchange rate (filled in with the last one used);
          transfers to and from {current?.baseCurrency ?? "NZD"} accounts take both amounts. Invoices and bills can&apos;t be paid from
          these lines yet.
        </p>
      ) : null}
      {account.accountType === "credit_card" ? (
        <p className={ui.muted}>For a credit card, a negative balance is what&apos;s owed on the card.</p>
      ) : null}
      {difference ? (
        <Notice tone="warning">
          Every line is reconciled, but the bank&apos;s balance and Tohyee&apos;s differ. Usually that&apos;s something posted to this account
          that isn&apos;t on the statement yet, a statement from before the first import, or a balance from a different time of day.
        </Notice>
      ) : null}
      <Card>
        <div className={ui.tabs} role="tablist" aria-label="Bank account">
          {TABS.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              className={`${ui.tab} ${tab === entry ? ui.tabActive : ""}`}
              onClick={() => setTab(entry)}
            >
              {labels[entry]}
            </button>
          ))}
        </div>
        {tab === "reconcile" ? <ReconcilePanel organisationId={organisationId} account={account} onChanged={detail.reload} /> : null}
        {tab === "lines" ? <StatementLinesPanel organisationId={organisationId} account={account} onChanged={detail.reload} /> : null}
        {tab === "import" ? <ImportPanel organisationId={organisationId} account={account} onChanged={detail.reload} /> : null}
        {tab === "feed" ? (
          <>
            <FeedPanel organisationId={organisationId} account={account} onChanged={detail.reload} />
            <FileFeedsPanel organisationId={organisationId} account={account} onChanged={detail.reload} />
          </>
        ) : null}
        {tab === "transactions" ? <TransactionsPanel organisationId={organisationId} account={account} /> : null}
      </Card>
    </>
  );
}

export default function BankAccountPage() {
  const { accountId } = useParams<{ accountId: string }>();
  return (
    <Page>
      <RequireOrganisation>
        {(organisationId) => <BankAccountView key={`${organisationId}:${accountId}`} organisationId={organisationId} accountId={accountId} />}
      </RequireOrganisation>
    </Page>
  );
}
