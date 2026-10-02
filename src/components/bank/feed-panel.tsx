"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { daysBefore, FeedBadge } from "@/components/bank/common";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Button, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import { useConfirm } from "@/components/confirm-dialog";

type AkahuAccountOption = {
  id: string;
  name: string;
  formattedAccount: string | null;
  type: string | null;
  status: string | null;
  connectionName: string | null;
  balance: string | null;
  linkedAccountId: string | null;
};

type SyncResult = { added: number; duplicates: number; possibleDuplicates: number; syncedAt: string };

function LinkFeedForm({ organisationId, account, onLinked }: { organisationId: string; account: BankAccount; onLinked: () => void }) {
  const today = todayInBrowser();
  const options = useApiData<{ accounts: AkahuAccountOption[] }>("/api/bank-feeds/akahu/accounts", { organisationId });
  const [akahuAccountId, setAkahuAccountId] = useState("");
  // A year back by default; Akahu may have more or less depending on the bank.
  const [startDate, setStartDate] = useState(() => (account.lastLineDate && account.lastLineDate < today ? account.lastLineDate : daysBefore(today, 365)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bank-accounts/${account.id}/feed`, { method: "POST", body: { organisationId, akahuAccountId, startDate } });
      onLinked();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (options.error) {
    return (
      <Notice tone="warning">
        {options.error} <Link href="/operations/bank-accounts">Bank accounts</Link>
      </Notice>
    );
  }
  if (!options.data) return <p className={ui.muted}>Asking Akahu which accounts are shared…</p>;
  const free = options.data.accounts.filter((option) => !option.linkedAccountId || option.linkedAccountId === account.id);
  if (free.length === 0) {
    return (
      <Empty>
        Akahu has no unlinked accounts to offer. Connect more banks, or share more accounts with the personal app, at my.akahu.nz.
      </Empty>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid2}>
        <Field label="Akahu account">
          <select value={akahuAccountId} onChange={(event) => setAkahuAccountId(event.target.value)} required>
            <option value="">Choose the bank account</option>
            {free.map((option) => (
              <option key={option.id} value={option.id}>
                {[option.connectionName, option.name, option.formattedAccount].filter(Boolean).join(" · ")}
                {option.balance !== null ? ` (${option.balance})` : ""}
                {option.status && option.status !== "ACTIVE" ? ` [${option.status.toLowerCase()}]` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Bring in transactions from"
          hint="The first sync goes back to this date, as far as Akahu and the bank allow. Akahu's default is up to 2 years, but some banks give less (Akahu lists ASB at 12 months, Kiwibank credit cards at 180 days, SBS at about 6 months). Lines already imported from files are skipped or flagged as possible duplicates."
        >
          <input type="date" value={startDate} max={today} onChange={(event) => setStartDate(event.target.value)} required />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Linking…" : "Link bank feed"}
        </Button>
      </div>
    </form>
  );
}

/** The account's Akahu bank feed: link it, sync now, or stop it. */
export function FeedPanel({ organisationId, account, onChanged }: { organisationId: string; account: BankAccount; onChanged: () => void }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const feed = account.feed;
  const foreign = account.isForeign;

  async function sync() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await api<{ result: SyncResult }>(`/api/bank-accounts/${account.id}/feed/sync`, {
        method: "POST",
        body: { organisationId },
      });
      setResult(response.result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function unlink() {
    if (!(await confirm("Stop this bank feed? Lines already brought in stay; nothing posted changes."))) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bank-accounts/${account.id}/feed`, { method: "DELETE", query: { organisationId } });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (account.currencyCode) {
    return <Notice tone="info">Bank feeds are for accounts in the base currency; this account is in {account.currencyCode}.</Notice>;
  }

  if (!feed.active) {
    if (foreign && !feed.active) {
    return (
      <Notice tone="info">
        Akahu bank feeds can&apos;t be used for {account.currencyCode} accounts yet: Akahu&apos;s transactions don&apos;t say their
        currency, so Tohyee can&apos;t tell {account.currencyCode} from NZD. Import statement files from your bank instead (the Import a
        statement tab).
      </Notice>
    );
  }
  return (
      <div style={{ display: "grid", gap: 12 }}>
        <p className={ui.muted}>
          A bank feed brings in this account&apos;s settled transactions every few hours through Akahu, so you don&apos;t have to import
          files. Pending transactions come in once they settle.
        </p>
        {can("admin") ? (
          <LinkFeedForm organisationId={organisationId} account={account} onLinked={onChanged} />
        ) : (
          <Empty>No bank feed. An organisation admin can link one.</Empty>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {result ? (
        <Notice tone="success">
          Synced: {result.added} new {result.added === 1 ? "line" : "lines"}
          {result.duplicates > 0 ? `, ${result.duplicates} already here` : ""}
          {result.possibleDuplicates > 0 ? `, ${result.possibleDuplicates} flagged as possible duplicates` : ""}.
        </Notice>
      ) : null}
      {feed.lastSyncStatus === "failed" && feed.lastSyncError ? <Notice tone="error">The last sync failed: {feed.lastSyncError}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <tbody>
            <tr>
              <th scope="row">Status</th>
              <td>
                <FeedBadge feed={feed} />
              </td>
            </tr>
            <tr>
              <th scope="row">Akahu account</th>
              <td>{[feed.akahuConnectionName, feed.akahuAccountName].filter(Boolean).join(" · ")}</td>
            </tr>
            <tr>
              <th scope="row">Transactions from</th>
              <td>{formatDate(feed.startDate)}</td>
            </tr>
            <tr>
              <th scope="row">Last synced</th>
              <td>{feed.lastSyncedAt ? formatDateTime(feed.lastSyncedAt) : "Not yet"}</td>
            </tr>
            <tr>
              <th scope="row">Bank&apos;s balance</th>
              <td>
                {account.statementBalance !== null ? (
                  <>
                    <Money value={account.statementBalance} />
                    {account.statementBalanceAt ? <span className={ui.muted}> at {formatDateTime(account.statementBalanceAt)}</span> : null}
                  </>
                ) : (
                  "Not known yet"
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        {can("bookkeeper") ? (
          <Button onClick={() => void sync()} disabled={busy}>
            {busy ? "Syncing…" : "Sync now"}
          </Button>
        ) : null}
        {can("admin") ? (
          <Button variant="secondary" onClick={() => void unlink()} disabled={busy}>
            Stop the feed
          </Button>
        ) : null}
      </div>
      <p className={ui.muted}>
        Akahu refreshes from the bank about once a day, so a sync may not find anything new straight away.
      </p>
    </div>
  );
}
