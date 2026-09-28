"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { ACCOUNT_TYPE_LABELS, FeedBadge } from "@/components/bank/common";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime } from "@/lib/format";

const AKAHU_MESSAGES: Record<string, { tone: "success" | "warning" | "error"; text: string }> = {
  connected: { tone: "success", text: "Your banks are connected through Akahu. Link each account to its bank feed below." },
  cancelled: { tone: "warning", text: "Connecting through Akahu was cancelled. Nothing changed." },
  expired: { tone: "error", text: "That Akahu connection link had expired or was already used. Try Connect banks again." },
  failed: { tone: "error", text: "Akahu didn't finish the connection. Try again; if it keeps failing, check the server's Akahu settings." },
};

function AddAccountForm({ organisationId, onAdded }: { organisationId: string; onAdded: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState<BankAccount["accountType"]>("bank");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/bank-accounts", {
        method: "POST",
        body: { organisationId, code, name, accountType, description: description || undefined },
      });
      setCode("");
      setName("");
      setDescription("");
      onAdded();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid4}>
        <Field label="Type">
          <select value={accountType} onChange={(event) => setAccountType(event.target.value as BankAccount["accountType"])}>
            <option value="bank">Bank account</option>
            <option value="credit_card">Credit card</option>
          </select>
        </Field>
        <Field label="Code" hint="The chart of accounts code, e.g. 1020.">
          <input value={code} onChange={(event) => setCode(event.target.value)} maxLength={20} required />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="ANZ Business Visa" />
        </Field>
        <Field label="Description" hint="Optional, e.g. the account number.">
          <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add account"}
        </Button>
      </div>
    </form>
  );
}

function ConnectBanks({ organisationId }: { organisationId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/bank-feeds/akahu/connect", { query: { organisationId } });
      window.location.assign(url);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {error ? <Notice tone="warning">{error}</Notice> : null}
      <p className={ui.muted}>
        Bank feeds come through Akahu. With a full Akahu app, connecting takes you to Akahu to choose which bank accounts to
        share; then link each one to its account here (Bank feed tab). With a personal Akahu app, a server admin links accounts
        directly and there&apos;s nothing to connect.
      </p>
      <div className={ui.actions}>
        <Button variant="secondary" onClick={() => void connect()} disabled={busy}>
          {busy ? "Opening Akahu…" : "Connect banks"}
        </Button>
      </div>
    </div>
  );
}

function BankAccounts({ organisationId, akahu }: { organisationId: string; akahu: string | null }) {
  const { can } = useWorkspace();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const list = useApiData<{ bankAccounts: BankAccount[] }>("/api/bank-accounts", {
    organisationId,
    includeArchived: includeArchived ? "true" : null,
  });
  const message = akahu ? AKAHU_MESSAGES[akahu] : null;
  const accounts = list.data?.bankAccounts ?? [];
  const toReconcile = accounts.reduce((sum, account) => sum + account.unreconciledCount, 0);

  return (
    <>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Card
        title="Bank and credit card accounts"
        description={`Statement balance is the latest balance the bank gave (from a file or the feed). Balance in Tohyee is what's posted to the account. ${toReconcile} statement ${toReconcile === 1 ? "line is" : "lines are"} waiting to be reconciled.`}
        actions={
          can("admin") ? (
            <Button variant={adding ? "secondary" : "primary"} onClick={() => setAdding((value) => !value)}>
              {adding ? "Close" : "Add account"}
            </Button>
          ) : null
        }
      >
        {adding ? (
          <AddAccountForm
            organisationId={organisationId}
            onAdded={() => {
              setAdding(false);
              list.reload();
            }}
          />
        ) : null}
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
        {list.data && accounts.length === 0 ? (
          <Empty>No bank or credit card accounts yet. Add one, or add them in the chart of accounts.</Empty>
        ) : null}
        {accounts.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th className={ui.num}>Statement balance</th>
                  <th className={ui.num}>Balance in Tohyee</th>
                  <th>Latest line</th>
                  <th>To reconcile</th>
                  <th>Bank feed</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <Link href={`/operations/bank-accounts/${account.id}`}>
                        {account.code} · {account.name}
                      </Link>
                      {account.isActive ? null : (
                        <>
                          {" "}
                          <Badge>Archived</Badge>
                        </>
                      )}
                      {account.currencyCode ? <div className={ui.muted}>{account.currencyCode}</div> : null}
                    </td>
                    <td>{ACCOUNT_TYPE_LABELS[account.accountType]}</td>
                    <td className={ui.num}>
                      {account.statementBalance !== null ? (
                        <span title={account.statementBalanceAt ? `As at ${formatDateTime(account.statementBalanceAt)}` : undefined}>
                          <Money value={account.statementBalance} />
                        </span>
                      ) : (
                        <span className={ui.muted}>—</span>
                      )}
                    </td>
                    <td className={ui.num}>
                      <Money value={account.ledgerBalance} />
                    </td>
                    <td>{account.lastLineDate ? formatDate(account.lastLineDate) : <span className={ui.muted}>None yet</span>}</td>
                    <td>
                      {account.unreconciledCount > 0 ? (
                        <Link href={`/operations/bank-accounts/${account.id}`}>Reconcile {account.unreconciledCount}</Link>
                      ) : (
                        <span className={ui.muted}>Nothing</span>
                      )}
                    </td>
                    <td>
                      <FeedBadge feed={account.feed} />
                      {account.feed.akahuAccountName ? <div className={ui.muted}>{account.feed.akahuAccountName}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
          Show archived accounts
        </label>
      </Card>
      {can("admin") ? (
        <Card title="Bank feeds" description="Daily transactions from the bank, brought in automatically.">
          <ConnectBanks organisationId={organisationId} />
        </Card>
      ) : null}
    </>
  );
}

function BankAccountsPage() {
  const params = useSearchParams();
  const akahu = params.get("akahu");
  return (
    <Page>
      <PageHeader
        title="Bank accounts"
        description="Bank and credit card accounts: import statements or bring them in with a bank feed, then reconcile each line."
      />
      <RequireOrganisation>
        {(organisationId) => <BankAccounts key={organisationId} organisationId={organisationId} akahu={akahu} />}
      </RequireOrganisation>
    </Page>
  );
}

export default function BankAccountsIndexPage() {
  return (
    <Suspense fallback={null}>
      <BankAccountsPage />
    </Suspense>
  );
}
