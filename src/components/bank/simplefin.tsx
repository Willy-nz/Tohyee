"use client";

import { type FormEvent, useMemo, useState } from "react";
import { daysBefore } from "@/components/bank/common";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
import type { SimpleFinLink, SimpleFinStatus, SimpleFinSyncResult } from "@/lib/bank/simplefin/service";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, personName, todayInBrowser } from "@/lib/format";

function syncMessage(result: SimpleFinSyncResult): { tone: "success" | "error"; text: string } {
  const added = `${result.added} new ${result.added === 1 ? "line" : "lines"}`;
  const extra = [
    result.possibleDuplicates ? `${result.possibleDuplicates} flagged as possible duplicates` : null,
    result.skipped ? `${result.skipped} skipped` : null,
  ].filter(Boolean);
  if (result.status === "failed")
    return { tone: "error", text: `Synced with problems: ${added}${extra.length ? `, ${extra.join(", ")}` : ""}. ${result.error ?? ""}` };
  return { tone: "success", text: `Synced: ${added}${extra.length ? `, ${extra.join(", ")}` : ""}.` };
}

/**
 * The organisation's own SimpleFIN Bridge connection (SF1, SF10): connect
 * with a setup token, see its accounts and last sync, sync now, disconnect.
 */
export function SimpleFinSettingsCard({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const data = useApiData<{ simplefin: SimpleFinStatus }>("/api/bank-feeds/simplefin", { organisationId });
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const status = data.data?.simplefin ?? null;
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
      await api("/api/bank-feeds/simplefin", { method: "POST", body: { organisationId, name: loginName.trim() || undefined, setupToken } });
      setLoginName("");
      setAdding(false);
      setSetupToken("");
      setMessage({ tone: "success", text: "Connected. Link each account on its bank account's Bank feed tab." });
      data.reload();
    });
  };
  const sync = (connectionId: string | null) =>
    run("sync", async () => {
      const response = await api<{ result: SimpleFinSyncResult }>("/api/bank-feeds/simplefin/sync", { method: "POST", body: { organisationId, connectionId } });
      setMessage(syncMessage(response.result));
      data.reload();
    });
  const refresh = (connectionId: string | null) =>
    run("refresh", async () => {
      await api("/api/bank-feeds/simplefin/accounts", { method: "POST", body: { organisationId, connectionId } });
      data.reload();
    });
  const changeHours = (connectionId: string | null, hours: number) =>
    run("hours", async () => {
      await api("/api/bank-feeds/simplefin", { method: "PATCH", body: { organisationId, connectionId, syncEveryHours: hours } });
      data.reload();
    });
  const disconnect = async (connectionId: string | null, name: string | null) => {
    if (
      !(await confirm(`Disconnect ${name ?? "SimpleFIN"}? Tohyee deletes its access and unlinks every account. Lines already brought in stay; nothing posted changes.`))
    )
      return;
    await run("disconnect", async () => {
      await api("/api/bank-feeds/simplefin", { method: "DELETE", query: { organisationId, ...(connectionId ? { connectionId } : {}) } });
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
          This server has no TOHYEE_SECRET_KEY, so the SimpleFIN connection can&apos;t be stored. The server admin needs to set it.
        </Notice>
      ) : null}
      {status.connections.map((connection) => (
        <div key={connection.connectionId} style={{ display: "grid", gap: 12 }}>
          {status.connections.length > 1 || connection.name !== "SimpleFIN" ? <h4 style={{ margin: 0 }}>{connection.name}</h4> : null}
          <p>
            <Badge tone={connection.lastSyncStatus === "failed" ? "red" : "green"}>{connection.lastSyncStatus === "failed" ? "Problem" : "Connected"}</Badge>{" "}
            {connection.host}
            <span className={ui.muted}>
              {" "}
              · connected {formatDateTime(connection.createdAt)}
              {personName(connection, "createdBy") ? ` by ${personName(connection, "createdBy")}` : ""} · last synced{" "}
              {connection.lastSyncedAt ? formatDateTime(connection.lastSyncedAt) : "not yet"} · {connection.requestsLast24h} of 24 requests used in the last 24
              hours
            </span>
          </p>
          {connection.lastSyncError ? <Notice tone="error">{connection.lastSyncError}</Notice> : null}
          {connection.problems.length && !connection.lastSyncError ? <Notice tone="error">{connection.problems.join(" ")}</Notice> : null}
          <div className={ui.tableWrap}>
            <table className={ui.table} style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th>SimpleFIN account</th>
                  <th>Currency</th>
                  <th className={ui.num}>Balance</th>
                  <th>Linked</th>
                </tr>
              </thead>
              <tbody>
                {connection.accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      {account.name}
                      {account.connectionName ? <div className={ui.muted}>{account.connectionName}</div> : null}
                    </td>
                    <td>{account.currency}</td>
                    <td className={ui.num}>{account.balance ?? "—"}</td>
                    <td>{account.linkedAccountId ? <Badge tone="green">Linked</Badge> : <span className={ui.muted}>Not linked</span>}</td>
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
                <Button variant="secondary" onClick={() => void refresh(connection.connectionId)} disabled={busy !== null}>
                  {busy === "refresh" ? "Asking…" : "Refresh account list"}
                </Button>
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
            SimpleFIN Bridge allows 24 requests a day. Sync now stops at 20, leaving room for the schedule. Pending transactions come in once they
            post.
          </p>
        </div>
      ))}
      {!status.connected || adding ? (
        can("admin") ? (
          <form onSubmit={connect} style={{ display: "grid", gap: 12 }} autoComplete="off">
            <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
              <li>Sign up at bridge.simplefin.org with this organisation&apos;s own account (SimpleFIN charges for it) and connect its banks.</li>
              <li>Create a new app connection there, and copy its setup token.</li>
              <li>Paste it below. It works once; Tohyee keeps the access it gives, encrypted.</li>
            </ol>
            <div className={ui.grid2}>
              {status.connected ? (
                <Field label="Name" hint="Whose login this is, to tell it apart.">
                  <input value={loginName} onChange={(event) => setLoginName(event.target.value)} maxLength={100} required />
                </Field>
              ) : null}
              <Field label="Setup token">
                <input type="password" value={setupToken} onChange={(event) => setSetupToken(event.target.value.trim())} required />
              </Field>
            </div>
            <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
              <Button type="submit" disabled={busy !== null || !setupToken || !status.secretsAvailable}>
                {busy === "connect" ? "Connecting…" : "Connect"}
              </Button>
              {adding ? (
                <Button variant="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        ) : (
          <Empty>Not connected. An organisation admin can connect SimpleFIN.</Empty>
        )
      ) : can("admin") ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add another SimpleFIN login
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["Pacific/Auckland", "Australia/Sydney", "America/Los_Angeles", "America/New_York", "Europe/London"];
  }
}

function LinkForm({
  organisationId,
  account,
  status,
  onLinked,
}: {
  organisationId: string;
  account: BankAccount;
  status: SimpleFinStatus;
  onLinked: () => void;
}) {
  const today = todayInBrowser();
  const zones = useMemo(() => timeZones(), []);
  const currency = account.currencyCode ?? account.statementCurrency;
  // Every login's accounts (#182, BK31).
  const several = status.connections.length > 1;
  const free = status.connections
    .flatMap((connection) => connection.accounts.map((option) => ({ ...option, connectionId: connection.connectionId ?? "", loginName: connection.name ?? "" })))
    .filter((option) => !option.linkedAccountId || option.linkedAccountId === account.id);
  const [simplefinAccountId, setSimplefinAccountId] = useState("");
  const [startDate, setStartDate] = useState(() =>
    account.lastLineDate && account.lastLineDate < today ? account.lastLineDate : daysBefore(today, 90),
  );
  const [timeZone, setTimeZone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const [connectionId, accountId] = simplefinAccountId.split("|");
      await api(`/api/bank-accounts/${account.id}/simplefin`, {
        method: "POST",
        body: { organisationId, connectionId, simplefinAccountId: accountId, startDate, timeZone },
      });
      onLinked();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!free.length)
    return <Empty>SimpleFIN has no unlinked accounts. Connect more banks in SimpleFIN Bridge, then refresh the account list on Bank accounts.</Empty>;
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="SimpleFIN account" hint={`Only accounts in ${currency} can be linked to this account.`}>
          <select value={simplefinAccountId} onChange={(event) => setSimplefinAccountId(event.target.value)} required>
            <option value="">Choose the account</option>
            {free.map((option) => (
              <option key={`${option.connectionId}|${option.id}`} value={`${option.connectionId}|${option.id}`} disabled={option.currency !== currency}>
                {[several ? option.loginName : null, option.connectionName, option.name].filter(Boolean).join(" · ")} ({option.currency})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bring in transactions from" hint="The first sync goes back to this date, as far as the bank allows.">
          <input type="date" value={startDate} max={today} onChange={(event) => setStartDate(event.target.value)} required />
        </Field>
        <Field label="The bank's time zone" hint="SimpleFIN gives a time, not a date: this decides which day each line is on.">
          <select value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
            <option value="">The organisation&apos;s time zone</option>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button type="submit" disabled={busy || !simplefinAccountId}>
          {busy ? "Linking…" : "Link SimpleFIN account"}
        </Button>
      </div>
    </form>
  );
}

/** The account's SimpleFIN link (SF2-SF9): link it, see its last sync and skipped transactions, unlink. */
export function SimpleFinPanel({ organisationId, account, onChanged }: { organisationId: string; account: BankAccount; onChanged: () => void }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const status = useApiData<{ simplefin: SimpleFinStatus }>("/api/bank-feeds/simplefin", { organisationId });
  const link = useApiData<{ link: SimpleFinLink | null }>(`/api/bank-accounts/${account.id}/simplefin`, { organisationId });
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
      const response = await api<{ result: SimpleFinSyncResult }>("/api/bank-feeds/simplefin/sync", { method: "POST", body: { organisationId, connectionId: link.data?.link?.connectionId ?? null } });
      setMessage(syncMessage(response.result));
      reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }
  async function unlink() {
    if (!(await confirm("Unlink this account from SimpleFIN? Lines already brought in stay; nothing posted changes."))) return;
    setBusy(true);
    try {
      await api(`/api/bank-accounts/${account.id}/simplefin`, { method: "DELETE", query: { organisationId } });
      reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  const connected = status.data?.simplefin.connected;
  const current = link.data?.link ?? null;
  if ((!status.data || !link.data) && !status.error && !link.error) return null;
  if (!connected && !current) return null;
  return (
    <section style={{ display: "grid", gap: 12, marginTop: 24 }} aria-labelledby="simplefin-title">
      <h3 id="simplefin-title" style={{ margin: 0 }}>
        SimpleFIN bank feed
      </h3>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {status.error || link.error ? <Notice tone="error">{status.error ?? link.error}</Notice> : null}
      {!current ? (
        can("admin") && status.data ? (
          account.feed.active || account.stripe || account.paypal || account.wise ? (
            <p className={ui.muted}>
              This account has{" "}
              {account.feed.active ? "an Akahu bank feed" : account.stripe ? "a Stripe feed" : account.paypal ? "a PayPal feed" : "a Wise feed"}. Stop
              it to link SimpleFIN instead.
            </p>
          ) : (
            <LinkForm organisationId={organisationId} account={account} status={status.data.simplefin} onLinked={reload} />
          )
        ) : (
          <Empty>Not linked to SimpleFIN. An organisation admin can link it.</Empty>
        )
      ) : (
        <>
          {current.lastSyncStatus === "failed" && current.lastSyncError ? <Notice tone="error">{current.lastSyncError}</Notice> : null}
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <tbody>
                <tr>
                  <th scope="row">SimpleFIN account</th>
                  <td>
                    {[current.connectionName, current.simplefinAccountName].filter(Boolean).join(" · ")} ({current.currencyCode})
                  </td>
                </tr>
                <tr>
                  <th scope="row">Transactions from</th>
                  <td>
                    {formatDate(current.startDate)}
                    {current.firstLineDate && current.firstLineDate > current.startDate ? (
                      <div className={ui.muted}>The earliest line SimpleFIN has given is {formatDate(current.firstLineDate)}.</div>
                    ) : null}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Dates in</th>
                  <td>{current.timeZone}</td>
                </tr>
                <tr>
                  <th scope="row">Last synced</th>
                  <td>{current.lastSyncedAt ? formatDateTime(current.lastSyncedAt) : "Not yet"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {current.skipped.length ? (
            <Notice tone="warning">
              {current.skipped.length} {current.skipped.length === 1 ? "transaction was" : "transactions were"} skipped:{" "}
              {current.skipped.map((entry) => `${entry.id ?? "no id"}: ${entry.reason}`).join(" ")}
            </Notice>
          ) : null}
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
