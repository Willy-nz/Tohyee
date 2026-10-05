"use client";

import { type FormEvent, useState } from "react";
import { daysBefore } from "@/components/bank/common";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
import type { StripeLink, StripeStatus, StripeSyncResult } from "@/lib/bank/stripe/service";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, personName, todayInBrowser } from "@/lib/format";

function syncMessage(result: StripeSyncResult): { tone: "success" | "error"; text: string } {
  const added = `${result.added} new ${result.added === 1 ? "line" : "lines"}${result.possibleDuplicates ? `, ${result.possibleDuplicates} flagged as possible duplicates` : ""}`;
  return result.status === "failed"
    ? { tone: "error", text: `Synced with problems: ${added}. ${result.error ?? ""}` }
    : { tone: "success", text: `Synced: ${added}.` };
}

/** The organisation's Stripe connection (ST1, ST10): connect with a restricted key, see balances and last sync, sync now, disconnect. */
export function StripeSettingsCard({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const data = useApiData<{ stripe: StripeStatus }>("/api/bank-feeds/stripe", { organisationId });
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const status = data.data?.stripe ?? null;

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    setMessage(null);
    try {
      await work();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }

  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run("connect", async () => {
      await api("/api/bank-feeds/stripe", { method: "POST", body: { organisationId, apiKey } });
      setApiKey("");
      setMessage({ tone: "success", text: "Connected. Link Stripe's balance on its bank account's Bank feed tab." });
      data.reload();
    });
  };
  const sync = () =>
    run("sync", async () => {
      const response = await api<{ result: StripeSyncResult }>("/api/bank-feeds/stripe/sync", { method: "POST", body: { organisationId } });
      setMessage(syncMessage(response.result));
      data.reload();
    });
  const changeHours = (hours: number) =>
    run("hours", async () => {
      await api("/api/bank-feeds/stripe", { method: "PATCH", body: { organisationId, syncEveryHours: hours } });
      data.reload();
    });
  const disconnect = async () => {
    if (
      !(await confirm("Disconnect Stripe? Tohyee deletes the key and unlinks its balances. Lines already brought in stay; nothing posted changes."))
    )
      return;
    await run("disconnect", async () => {
      await api("/api/bank-feeds/stripe", { method: "DELETE", query: { organisationId } });
      data.reload();
    });
  };

  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!status) return <p className={ui.muted}>Loading…</p>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {!status.secretsAvailable ? (
        <Notice tone="warning">
          This server has no TOHYEE_SECRET_KEY, so the Stripe key can&apos;t be stored. The server admin needs to set it.
        </Notice>
      ) : null}
      {!status.connected ? (
        can("admin") ? (
          <form onSubmit={connect} style={{ display: "grid", gap: 12 }} autoComplete="off">
            <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
              <li>In this organisation&apos;s Stripe dashboard, open Developers → API keys and create a restricted key.</li>
              <li>Give it read access to the balance (and nothing else), and copy it.</li>
              <li>Paste it below. Tohyee checks it with Stripe, then stores it encrypted. Full secret keys aren&apos;t accepted.</li>
            </ol>
            <div className={ui.grid2}>
              <Field label="Restricted key" hint="Starts with rk_live_.">
                <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value.trim())} required />
              </Field>
            </div>
            <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
              <Button type="submit" disabled={busy !== null || !apiKey || !status.secretsAvailable}>
                {busy === "connect" ? "Checking with Stripe…" : "Connect"}
              </Button>
            </div>
          </form>
        ) : (
          <Empty>Not connected. An organisation admin can connect Stripe.</Empty>
        )
      ) : (
        <>
          <p>
            <Badge tone={status.lastSyncStatus === "failed" ? "red" : "green"}>{status.lastSyncStatus === "failed" ? "Problem" : "Connected"}</Badge>{" "}
            {status.keyHint}
            {status.liveMode ? null : <Badge tone="amber">Test mode</Badge>}
            <span className={ui.muted}>
              {" "}
              · connected {formatDateTime(status.createdAt)}
              {personName(status, "createdBy") ? ` by ${personName(status, "createdBy")}` : ""} · last synced{" "}
              {status.lastSyncedAt ? formatDateTime(status.lastSyncedAt) : "not yet"}
            </span>
          </p>
          {status.lastSyncError ? <Notice tone="error">{status.lastSyncError}</Notice> : null}
          <div className={ui.tableWrap}>
            <table className={ui.table} style={{ minWidth: 480 }}>
              <thead>
                <tr>
                  <th>Stripe balance</th>
                  <th className={ui.num}>Available</th>
                  <th className={ui.num}>Pending</th>
                  <th>Linked</th>
                </tr>
              </thead>
              <tbody>
                {status.balances.map((balance) => (
                  <tr key={balance.currency}>
                    <td>{balance.currency}</td>
                    <td className={ui.num}>{balance.available}</td>
                    <td className={ui.num}>{balance.pending}</td>
                    <td>{balance.linkedAccountId ? <Badge tone="green">Linked</Badge> : <span className={ui.muted}>Not linked</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={ui.actions} style={{ justifyContent: "flex-start", alignItems: "center", flexWrap: "wrap" }}>
            {can("bookkeeper") ? (
              <Button onClick={() => void sync()} disabled={busy !== null}>
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </Button>
            ) : null}
            {can("admin") ? (
              <>
                <label style={{ display: "flex", gap: 8, alignItems: "center", whiteSpace: "nowrap" }}>
                  Sync every
                  <select value={status.syncEveryHours} disabled={busy !== null} onChange={(event) => void changeHours(Number(event.target.value))}>
                    {[1, 2, 3, 4, 6, 8, 12, 24].map((hours) => (
                      <option key={hours} value={hours}>
                        {hours === 1 ? "hour" : `${hours} hours`}
                      </option>
                    ))}
                  </select>
                </label>
                <Button variant="secondary" onClick={() => void disconnect()} disabled={busy !== null}>
                  Disconnect
                </Button>
              </>
            ) : null}
          </div>
          <p className={ui.muted}>
            Each charge comes in at its full amount with Stripe&apos;s fees (and any tax on them) as separate lines. Reconcile payouts as transfers to
            the bank account they landed in.
          </p>
        </>
      )}
    </div>
  );
}

function LinkForm({
  organisationId,
  account,
  status,
  onLinked,
}: {
  organisationId: string;
  account: BankAccount;
  status: StripeStatus;
  onLinked: () => void;
}) {
  const today = todayInBrowser();
  const currency = account.currencyCode ?? account.statementCurrency;
  const free = status.balances.filter((balance) => !balance.linkedAccountId || balance.linkedAccountId === account.id);
  const [choice, setChoice] = useState(() => free.find((balance) => balance.currency === currency)?.currency ?? "");
  const [startDate, setStartDate] = useState(() =>
    account.lastLineDate && account.lastLineDate < today ? account.lastLineDate : daysBefore(today, 90),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bank-accounts/${account.id}/stripe`, { method: "POST", body: { organisationId, currency: choice, startDate } });
      onLinked();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!free.length) return <Empty>Every Stripe balance is linked to another account.</Empty>;
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Stripe balance" hint={`Only Stripe's ${currency} balance can be linked to this account.`}>
          <select value={choice} onChange={(event) => setChoice(event.target.value)} required>
            <option value="">Choose the balance</option>
            {free.map((balance) => (
              <option key={balance.currency} value={balance.currency} disabled={balance.currency !== currency}>
                {balance.currency}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bring in transactions from" hint="The first sync goes back to this date.">
          <input type="date" value={startDate} max={today} onChange={(event) => setStartDate(event.target.value)} required />
        </Field>
      </div>
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button type="submit" disabled={busy || !choice}>
          {busy ? "Linking…" : "Link Stripe balance"}
        </Button>
      </div>
    </form>
  );
}

/** The account's Stripe link (ST2-ST9): link it, see the last sync, sync now, unlink. */
export function StripePanel({ organisationId, account, onChanged }: { organisationId: string; account: BankAccount; onChanged: () => void }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const status = useApiData<{ stripe: StripeStatus }>("/api/bank-feeds/stripe", { organisationId });
  const link = useApiData<{ link: StripeLink | null }>(`/api/bank-accounts/${account.id}/stripe`, { organisationId });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const reload = () => {
    link.reload();
    status.reload();
    onChanged();
  };
  async function sync() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await api<{ result: StripeSyncResult }>("/api/bank-feeds/stripe/sync", { method: "POST", body: { organisationId } });
      setMessage(syncMessage(response.result));
      reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }
  async function unlink() {
    if (!(await confirm("Unlink this account from Stripe? Lines already brought in stay; nothing posted changes."))) return;
    setBusy(true);
    try {
      await api(`/api/bank-accounts/${account.id}/stripe`, { method: "DELETE", query: { organisationId } });
      reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  const connected = status.data?.stripe.connected;
  const current = link.data?.link ?? null;
  if ((!status.data || !link.data) && !status.error && !link.error) return null;
  if (!connected && !current) return null;
  const otherFeed = account.feed.active ? "an Akahu" : account.simplefin ? "a SimpleFIN" : null;
  return (
    <section style={{ display: "grid", gap: 12, marginTop: 24 }} aria-labelledby="stripe-title">
      <h3 id="stripe-title" style={{ margin: 0 }}>
        Stripe
      </h3>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {status.error || link.error ? <Notice tone="error">{status.error ?? link.error}</Notice> : null}
      {!current ? (
        can("admin") && status.data ? (
          otherFeed ? (
            <p className={ui.muted}>
              This account has {otherFeed} bank feed. Stripe&apos;s balance needs its own account (e.g. &ldquo;Stripe&rdquo;).
            </p>
          ) : (
            <LinkForm organisationId={organisationId} account={account} status={status.data.stripe} onLinked={reload} />
          )
        ) : (
          <Empty>Not linked to Stripe. An organisation admin can link it.</Empty>
        )
      ) : (
        <>
          {current.lastSyncStatus === "failed" && current.lastSyncError ? <Notice tone="error">{current.lastSyncError}</Notice> : null}
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <tbody>
                <tr>
                  <th scope="row">Stripe balance</th>
                  <td>{current.currencyCode}</td>
                </tr>
                <tr>
                  <th scope="row">Transactions from</th>
                  <td>{formatDate(current.startDate)}</td>
                </tr>
                <tr>
                  <th scope="row">Last synced</th>
                  <td>{current.lastSyncedAt ? formatDateTime(current.lastSyncedAt) : "Not yet"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            {can("bookkeeper") && connected ? (
              <Button onClick={() => void sync()} disabled={busy}>
                {busy ? "Syncing…" : "Sync now"}
              </Button>
            ) : null}
            {can("admin") ? (
              <Button variant="secondary" onClick={() => void unlink()} disabled={busy}>
                Unlink
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
