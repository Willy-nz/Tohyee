"use client";

import { type FormEvent, useState } from "react";
import { daysBefore } from "@/components/bank/common";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
import type { WiseLink, WiseStatus, WiseSyncResult } from "@/lib/bank/wise/service";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, personName, todayInBrowser } from "@/lib/format";

function syncMessage(result: WiseSyncResult): { tone: "success" | "error"; text: string } {
  const added = `${result.added} new ${result.added === 1 ? "line" : "lines"}${result.possibleDuplicates ? `, ${result.possibleDuplicates} flagged as possible duplicates` : ""}`;
  return result.status === "failed"
    ? { tone: "error", text: `Synced with problems: ${added}. ${result.error ?? ""}` }
    : { tone: "success", text: `Synced: ${added}.` };
}

/** The organisation's Wise connection (PP1, PP10): connect with the live app's client ID and secret, see balances and last sync, sync now, disconnect. */
export function WiseSettingsCard({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const data = useApiData<{ wise: WiseStatus }>("/api/bank-feeds/wise", { organisationId });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const status = data.data?.wise ?? null;
  // Another login (#182, BK30): its name.
  const [adding, setAdding] = useState(false);
  const [loginName, setLoginName] = useState("");

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
      await api("/api/bank-feeds/wise", { method: "POST", body: { organisationId, name: loginName.trim() || undefined, token } });
      setLoginName("");
      setAdding(false);
      setToken("");
      setMessage({ tone: "success", text: "Connected. Link Wise's balance on its bank account's Bank feed tab." });
      data.reload();
    });
  };
  const sync = (connectionId: string | null) =>
    run("sync", async () => {
      const response = await api<{ result: WiseSyncResult }>("/api/bank-feeds/wise/sync", { method: "POST", body: { organisationId, connectionId } });
      setMessage(syncMessage(response.result));
      data.reload();
    });
  const changeHours = (connectionId: string | null, hours: number) =>
    run("hours", async () => {
      await api("/api/bank-feeds/wise", { method: "PATCH", body: { organisationId, connectionId, syncEveryHours: hours } });
      data.reload();
    });
  const disconnect = async (connectionId: string | null, name: string | null) => {
    if (
      !(await confirm(`Disconnect ${name ?? "Wise"}? Tohyee deletes the token and unlinks its balances. Lines already brought in stay; nothing posted changes.`))
    )
      return;
    await run("disconnect", async () => {
      await api("/api/bank-feeds/wise", { method: "DELETE", query: { organisationId, ...(connectionId ? { connectionId } : {}) } });
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
          This server has no TOHYEE_SECRET_KEY, so the Wise token can&apos;t be stored. The server admin needs to set it.
        </Notice>
      ) : null}
      {status.connections.map((connection) => (
        <div key={connection.connectionId} style={{ display: "grid", gap: 12 }}>
          {status.connections.length > 1 || connection.name !== "Wise" ? <h4 style={{ margin: 0 }}>{connection.name}</h4> : null}
          <p>
            <Badge tone={connection.lastSyncStatus === "failed" ? "red" : "green"}>{connection.lastSyncStatus === "failed" ? "Problem" : "Connected"}</Badge>{" "}
            {connection.profileName ?? `Profile ${connection.profileId}`}
            <span className={ui.muted}>
              {" "}
              · connected {formatDateTime(connection.createdAt)}
              {personName(connection, "createdBy") ? ` by ${personName(connection, "createdBy")}` : ""} · last synced{" "}
              {connection.lastSyncedAt ? formatDateTime(connection.lastSyncedAt) : "not yet"}
            </span>
          </p>
          {connection.lastSyncError ? <Notice tone="error">{connection.lastSyncError}</Notice> : null}
          <div className={ui.tableWrap}>
            <table className={ui.table} style={{ minWidth: 480 }}>
              <thead>
                <tr>
                  <th>Wise balance</th>
                  <th className={ui.num}>Balance</th>
                  <th>Linked</th>
                </tr>
              </thead>
              <tbody>
                {connection.balances.map((balance) => (
                  <tr key={balance.currency}>
                    <td>{balance.currency}</td>
                    <td className={ui.num}>{balance.amount ?? "—"}</td>
                    <td>{balance.linkedAccountId ? <Badge tone="green">Linked</Badge> : <span className={ui.muted}>Not linked</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={ui.actions} style={{ justifyContent: "flex-start", alignItems: "center", flexWrap: "wrap" }}>
            {can("bookkeeper") ? (
              <Button onClick={() => void sync(connection.connectionId)} disabled={busy !== null}>
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </Button>
            ) : null}
            {can("admin") ? (
              <>
                <label style={{ display: "flex", gap: 8, alignItems: "center", whiteSpace: "nowrap" }}>
                  Sync every
                  <select value={connection.syncEveryHours} disabled={busy !== null} onChange={(event) => void changeHours(connection.connectionId, Number(event.target.value))}>
                    {[1, 2, 3, 4, 6, 8, 12, 24].map((hours) => (
                      <option key={hours} value={hours}>
                        {hours === 1 ? "hour" : `${hours} hours`}
                      </option>
                    ))}
                  </select>
                </label>
                <Button variant="secondary" onClick={() => void disconnect(connection.connectionId, connection.name)} disabled={busy !== null}>
                  Disconnect
                </Button>
              </>
            ) : null}
          </div>
          <p className={ui.muted}>
            Each statement line comes in with Wise&apos;s fee as its own line when Wise&apos;s running balance confirms it. Reconcile conversions as
            transfers between your Wise accounts, and payments to suppliers against their bills.
          </p>
        </div>
      ))}
      {!status.connected || adding ? (
        can("admin") ? (
          <form onSubmit={connect} style={{ display: "grid", gap: 12 }} autoComplete="off">
            <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
              <li>Sign in to the organisation&apos;s Wise business account and open Your account → Connect and manage apps → API tokens.</li>
              <li>Add a new token, and copy it (Wise shows it once).</li>
              <li>Paste it below. Tohyee reads the business profile and balances with it, then stores it encrypted.</li>
            </ol>
            <Notice tone="warning">
              Wise has no read-only token: this token could also create and fund transfers. Tohyee only ever uses it to read your balances and
              statements, and stores it encrypted; anyone who can see this server&apos;s secret key could use it. Wise allows statements with a token
              only for accounts based in the US, Canada, Australia, New Zealand, Singapore or Malaysia.
            </Notice>
            <div className={ui.grid2}>
              {status.connected ? (
                <Field label="Name" hint="Whose login this is, to tell it apart.">
                  <input value={loginName} onChange={(event) => setLoginName(event.target.value)} maxLength={100} required />
                </Field>
              ) : null}
              <Field label="Personal API token">
                <input type="password" value={token} onChange={(event) => setToken(event.target.value.trim())} required />
              </Field>
            </div>
            <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
              <Button type="submit" disabled={busy !== null || !token || !status.secretsAvailable}>
                {busy === "connect" ? "Checking with Wise…" : "Connect"}
              </Button>
              {adding ? (
                <Button variant="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        ) : (
          <Empty>Not connected. An organisation admin can connect Wise.</Empty>
        )
      ) : can("admin") ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add another Wise login
          </Button>
        </div>
      ) : null}
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
  status: WiseStatus;
  onLinked: () => void;
}) {
  const today = todayInBrowser();
  const currency = account.currencyCode ?? account.statementCurrency;
  // Every login's balances (#182): one link per currency per login.
  const balances = status.connections.flatMap((connection) =>
    connection.balances.map((balance) => ({ ...balance, connectionId: connection.connectionId ?? "", loginName: connection.name ?? "" })),
  );
  const several = status.connections.length > 1;
  const free = balances.filter((balance) => !balance.linkedAccountId || balance.linkedAccountId === account.id);
  const [choice, setChoice] = useState(() => {
    const first = free.find((balance) => balance.currency === currency);
    return first ? `${first.connectionId}|${first.currency}` : "";
  });
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
      await api(`/api/bank-accounts/${account.id}/wise`, { method: "POST", body: { organisationId, connectionId: choice.split("|")[0], currency: choice.split("|")[1], startDate } });
      onLinked();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!free.length) return <Empty>Every Wise balance is linked to another account.</Empty>;
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Wise balance" hint={`Only Wise's ${currency} balance can be linked to this account.`}>
          <select value={choice} onChange={(event) => setChoice(event.target.value)} required>
            <option value="">Choose the balance</option>
            {free.map((balance) => (
              <option key={`${balance.connectionId}|${balance.currency}`} value={`${balance.connectionId}|${balance.currency}`} disabled={balance.currency !== currency}>
                {several ? `${balance.loginName} · ${balance.currency}` : balance.currency}
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
          {busy ? "Linking…" : "Link Wise balance"}
        </Button>
      </div>
    </form>
  );
}

/** The account's Wise link (PP2-PP9): link it, see the last sync, sync now, unlink. */
export function WisePanel({ organisationId, account, onChanged }: { organisationId: string; account: BankAccount; onChanged: () => void }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const status = useApiData<{ wise: WiseStatus }>("/api/bank-feeds/wise", { organisationId });
  const link = useApiData<{ link: WiseLink | null }>(`/api/bank-accounts/${account.id}/wise`, { organisationId });
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
      const response = await api<{ result: WiseSyncResult }>("/api/bank-feeds/wise/sync", { method: "POST", body: { organisationId, connectionId: link.data?.link?.connectionId ?? null } });
      setMessage(syncMessage(response.result));
      reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }
  async function unlink() {
    if (!(await confirm("Unlink this account from Wise? Lines already brought in stay; nothing posted changes."))) return;
    setBusy(true);
    try {
      await api(`/api/bank-accounts/${account.id}/wise`, { method: "DELETE", query: { organisationId } });
      reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  const connected = status.data?.wise.connected;
  const current = link.data?.link ?? null;
  if ((!status.data || !link.data) && !status.error && !link.error) return null;
  if (!connected && !current) return null;
  const otherFeed = account.feed.active
    ? "an Akahu"
    : account.simplefin
      ? "a SimpleFIN"
      : account.stripe
        ? "a Stripe"
        : account.wise
          ? "a Wise"
          : null;
  return (
    <section style={{ display: "grid", gap: 12, marginTop: 24 }} aria-labelledby="wise-title">
      <h3 id="wise-title" style={{ margin: 0 }}>
        Wise
      </h3>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {status.error || link.error ? <Notice tone="error">{status.error ?? link.error}</Notice> : null}
      {!current ? (
        can("admin") && status.data ? (
          otherFeed ? (
            <p className={ui.muted}>This account has {otherFeed} feed. Wise&apos;s balance needs its own account (e.g. &ldquo;Wise&rdquo;).</p>
          ) : (
            <LinkForm organisationId={organisationId} account={account} status={status.data.wise} onLinked={reload} />
          )
        ) : (
          <Empty>Not linked to Wise. An organisation admin can link it.</Empty>
        )
      ) : (
        <>
          {current.lastSyncStatus === "failed" && current.lastSyncError ? <Notice tone="error">{current.lastSyncError}</Notice> : null}
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <tbody>
                <tr>
                  <th scope="row">Wise balance</th>
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
