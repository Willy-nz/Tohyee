"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ACCOUNT_TYPE_LABELS, FeedBadge } from "@/components/bank/common";
import { FeedPanel } from "@/components/bank/feed-panel";
import { ImportPanel } from "@/components/bank/import-panel";
import { StatementLinesPanel, TransactionsPanel } from "@/components/bank/lines-panel";
import { ReconcilePanel } from "@/components/bank/reconcile-panel";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Card, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import type { BankAccount } from "@/lib/bank/accounts";
import { formatDate, formatDateTime } from "@/lib/format";

const TABS = ["reconcile", "lines", "import", "feed", "transactions"] as const;
type Tab = (typeof TABS)[number];

function BankAccountView({ organisationId, accountId }: { organisationId: string; accountId: string }) {
  const detail = useApiData<{ bankAccount: BankAccount }>(`/api/bank-accounts/${accountId}`, { organisationId });
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
  const difference =
    account.statementBalance !== null && account.unreconciledCount === 0 && account.statementBalance !== account.ledgerBalance;

  return (
    <>
      <PageHeader
        title={`${account.code} · ${account.name}`}
        description={`${ACCOUNT_TYPE_LABELS[account.accountType]}${account.currencyCode ? ` in ${account.currencyCode}` : ""}${account.isActive ? "" : " (archived)"}`}
      />
      <p>
        <Link href="/operations/bank-accounts">← All bank accounts</Link>
      </p>
      <div className={ui.statRow}>
        <Stat
          label={account.statementBalanceAt ? `Statement balance (${formatDateTime(account.statementBalanceAt)})` : "Statement balance"}
          value={account.statementBalance !== null ? <Money value={account.statementBalance} /> : "—"}
        />
        <Stat label="Balance in Tohyee" value={<Money value={account.ledgerBalance} />} />
        <Stat label="Lines to reconcile" value={account.unreconciledCount} />
        <Stat
          label={account.lastLineDate ? `Latest line ${formatDate(account.lastLineDate)}` : "Bank feed"}
          value={<FeedBadge feed={account.feed} />}
        />
      </div>
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
        {tab === "feed" ? <FeedPanel organisationId={organisationId} account={account} onChanged={detail.reload} /> : null}
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
