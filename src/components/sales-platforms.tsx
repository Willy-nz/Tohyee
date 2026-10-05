"use client";

import { type FormEvent, useState } from "react";
import { AccountSelect, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDateTime } from "@/lib/format";
import {
  AUTH_METHOD_LABELS,
  SALES_PLATFORM_LABELS,
  type SalesPlatformConnection,
  SHOPIFY_AUTH_METHODS,
  type ShopifyAuthMethod,
  SYNC_LOG_ACTION_LABELS,
  type SyncLogEntry,
  type SyncResult,
} from "@/lib/sales-platforms/types";
import type { TaxCode } from "@/lib/tax/codes";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Settings › Sales platforms (examples SPC1-SPC10): connecting a Shopify
 * store, what to sync, "Sync now", the sync log and disconnecting; and
 * posting orders, refunds and payouts to the accounts (SPC11-SPC24).
 * Everyone can read the connections and the log; only admins change
 * anything.
 */

const STATUS_BADGES: Record<SalesPlatformConnection["status"], { tone: "green" | "amber" | "neutral"; text: string }> = {
  active: { tone: "green", text: "Connected" },
  paused: { tone: "amber", text: "Paused after failed syncs" },
  disconnected: { tone: "neutral", text: "Disconnected" },
};

const ACTION_TONES: Partial<Record<SyncLogEntry["action"], "green" | "blue" | "amber" | "red">> = {
  created: "green",
  linked: "blue",
  updated: "blue",
  kept: "amber",
  skipped: "amber",
  failed: "red",
};

export function describeSyncResult(result: SyncResult): string {
  const parts = [
    `${result.created} added`,
    `${result.linked} linked`,
    `${result.updated} updated`,
    ...(result.kept ? [`${result.kept} kept Tohyee's value`] : []),
    ...(result.skipped ? [`${result.skipped} skipped`] : []),
    ...(result.failed ? [`${result.failed} failed`] : []),
  ];
  return `Synced: ${parts.join(", ")}. The log below has the details.`;
}

function ConnectForm({ organisationId, onConnected }: { organisationId: string; onConnected: (message: string) => void }) {
  const [storeDomain, setStoreDomain] = useState("");
  const [authMethod, setAuthMethod] = useState<ShopifyAuthMethod>("client_credentials");
  const [accessToken, setAccessToken] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [syncCustomers, setSyncCustomers] = useState(true);
  const [syncProducts, setSyncProducts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const credentials = authMethod === "access_token" ? { accessToken, apiSecret } : { clientId, clientSecret };
      const { connection } = await api<{ connection: SalesPlatformConnection }>("/api/sales-platforms/connections", {
        method: "POST",
        body: { organisationId, platform: "shopify", storeDomain, authMethod, ...credentials, syncCustomers, syncProducts },
      });
      setAccessToken("");
      setApiSecret("");
      setClientSecret("");
      onConnected(`Connected ${connection.storeName ?? connection.storeDomain}. Choose "Sync now" to bring its customers and products in.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      <Notice tone="info">
        <strong>Before you start:</strong> Tohyee connects through an app in your own Shopify account, so no one else&apos;s app has access. In the
        Shopify Dev Dashboard (dev.shopify.com), create an app, give it only the Admin API access scopes <code>read_customers</code> and{" "}
        <code>read_products</code>, release it and install it on your store, then copy its client ID and secret from the app&apos;s Settings. If your
        store already has a custom app made in the store admin before 2026, you can use its Admin API access token and API secret key instead. Tohyee
        refuses access that can change your store: it only reads.
      </Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid2}>
        <Field label="Store address" hint="Like glimmers.myshopify.com, or just glimmers.">
          <input value={storeDomain} onChange={(event) => setStoreDomain(event.target.value)} maxLength={255} autoComplete="off" required />
        </Field>
        <Field label="How the app signs in">
          <select value={authMethod} onChange={(event) => setAuthMethod(event.target.value as ShopifyAuthMethod)}>
            {SHOPIFY_AUTH_METHODS.map((method) => (
              <option key={method} value={method}>
                {method === "client_credentials" ? "Client ID and secret (Dev Dashboard app)" : "Admin API access token (older custom app)"}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {authMethod === "client_credentials" ? (
        <div className={ui.grid2}>
          <Field label="Client ID">
            <input value={clientId} onChange={(event) => setClientId(event.target.value)} maxLength={200} autoComplete="off" required />
          </Field>
          <Field label="Client secret" hint="Stored encrypted on this server; never shown again. Shopify signs webhooks with it too.">
            <input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} maxLength={500} autoComplete="new-password" required />
          </Field>
        </div>
      ) : (
        <div className={ui.grid2}>
          <Field label="Admin API access token" hint="Starts with shpat_. Stored encrypted; never shown again.">
            <input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} maxLength={500} autoComplete="new-password" required />
          </Field>
          <Field label="API secret key" hint="Shopify signs webhooks with it. Stored encrypted.">
            <input type="password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} maxLength={500} autoComplete="new-password" required />
          </Field>
        </div>
      )}
      <div className={ui.actions}>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={syncCustomers} onChange={(event) => setSyncCustomers(event.target.checked)} /> Customers into contacts
        </label>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={syncProducts} onChange={(event) => setSyncProducts(event.target.checked)} /> Products into items
        </label>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Checking with Shopify…" : "Connect store"}
        </Button>
      </div>
    </form>
  );
}

export function SyncLog({ entries }: { entries: SyncLogEntry[] }) {
  if (entries.length === 0) return <Empty>Nothing has happened yet.</Empty>;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th>Details</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(entry.loggedAt)}</td>
              <td>
                <Badge tone={ACTION_TONES[entry.action] ?? "neutral"}>{SYNC_LOG_ACTION_LABELS[entry.action]}</Badge>
                {entry.source === "webhook" ? <span className={ui.muted}> (webhook)</span> : null}
              </td>
              <td>{entry.message}</td>
              <td className={ui.muted}>{entry.actorEmail === "sales-platform-sync@tohyee" ? "Automatic" : entry.actorEmail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConnectionLog({ organisationId, connectionId, version }: { organisationId: string; connectionId: string; version: number }) {
  const { data, error, loading } = useApiData<{ entries: SyncLogEntry[] }>(`/api/sales-platforms/connections/${connectionId}/log`, {
    organisationId,
    v: version,
  });
  if (error) return <Notice tone="error">{error}</Notice>;
  if (loading || !data) return <p className={ui.muted}>Loading the log…</p>;
  return <SyncLog entries={data.entries} />;
}

export function ConnectionCard({
  organisationId,
  connection,
  isAdmin,
  onChanged,
}: {
  organisationId: string;
  connection: SalesPlatformConnection;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [logVersion, setLogVersion] = useState(0);
  const [showLog, setShowLog] = useState(connection.status !== "disconnected");
  const status = STATUS_BADGES[connection.status];
  const connected = connection.status !== "disconnected";

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: "success", text: await work() });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
      setLogVersion((value) => value + 1);
      onChanged();
    }
  }

  const path = `/api/sales-platforms/connections/${connection.id}`;
  const test = () =>
    run(async () => {
      const { result } = await api<{ result: { ok: boolean; message: string } }>(`${path}/test`, { method: "POST", body: { organisationId } });
      if (!result.ok) throw new Error(result.message);
      return result.message;
    });
  const sync = () =>
    run(async () => describeSyncResult((await api<{ result: SyncResult }>(`${path}/sync`, { method: "POST", body: { organisationId } })).result));
  const choose = (change: { syncCustomers?: boolean; syncProducts?: boolean }) =>
    run(async () => {
      await api(path, { method: "PATCH", body: { organisationId, ...change } });
      return "Saved.";
    });
  const disconnect = async () => {
    if (
      !(await confirm(
        `Disconnect ${connection.storeName ?? connection.storeDomain}? The contacts and items already brought in stay, and so does this log. Tohyee forgets the store's credentials and which Shopify record each contact and item came from.`,
      ))
    ) {
      return;
    }
    void run(async () => {
      await api(path, { method: "DELETE", query: { organisationId } });
      return "Disconnected. The contacts and items brought in are kept.";
    });
  };

  return (
    <Card
      title={`${SALES_PLATFORM_LABELS[connection.platform]}: ${connection.storeName ?? connection.storeDomain}`}
      description={
        <>
          {connection.storeDomain} · {AUTH_METHOD_LABELS[connection.authMethod] ?? connection.authMethod}
          {connection.storeCurrency ? ` · prices in ${connection.storeCurrency}, ${connection.pricesIncludeTax ? "including" : "excluding"} tax` : ""}
        </>
      }
      actions={<Badge tone={status.tone}>{status.text}</Badge>}
    >
      <div style={{ display: "grid", gap: 12 }}>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        {connected ? (
          <p className={ui.muted}>
            Connected by {connection.connectedByEmail} on {formatDateTime(connection.connectedAt)}.{" "}
            {connection.lastSyncAt ? `Last synced ${formatDateTime(connection.lastSyncAt)}.` : "Not synced yet."}{" "}
            {connection.webhooksActive ? "Shopify also sends changes as they happen." : null}
          </p>
        ) : (
          <p className={ui.muted}>
            Disconnected by {connection.disconnectedByEmail} on {formatDateTime(connection.disconnectedAt)}.
          </p>
        )}
        {connected && connection.lastError ? <Notice tone="error">The last sync failed: {connection.lastError}</Notice> : null}
        {connected && connection.webhooksNote ? <Notice tone="warning">{connection.webhooksNote}</Notice> : null}
        {connected && connection.pricesIncludeTax ? (
          <Notice tone="info">
            This store&apos;s prices include tax, so they aren&apos;t copied to items (Tohyee&apos;s item prices exclude GST). Items keep their own sale price.
          </Notice>
        ) : null}
        {connected ? (
          <div className={ui.actions}>
            <label className={ui.checkbox}>
              <input
                type="checkbox"
                checked={connection.syncCustomers}
                disabled={!isAdmin || busy}
                onChange={(event) => void choose({ syncCustomers: event.target.checked })}
              />{" "}
              Customers into contacts
            </label>
            <label className={ui.checkbox}>
              <input
                type="checkbox"
                checked={connection.syncProducts}
                disabled={!isAdmin || busy}
                onChange={(event) => void choose({ syncProducts: event.target.checked })}
              />{" "}
              Products into items
            </label>
          </div>
        ) : null}
        {connected ? <PostingSettings organisationId={organisationId} connection={connection} isAdmin={isAdmin} busy={busy} run={run} path={path} /> : null}
        {connected && isAdmin ? (
          <div className={ui.actions}>
            <Button onClick={() => void sync()} disabled={busy}>
              Sync now
            </Button>
            <Button variant="secondary" onClick={() => void test()} disabled={busy}>
              Test connection
            </Button>
            <Button variant="danger" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        ) : null}
        {showLog ? (
          <>
            <h3 style={{ margin: 0, fontSize: "1rem" }}>Sync log</h3>
            <ConnectionLog organisationId={organisationId} connectionId={connection.id} version={logVersion} />
          </>
        ) : (
          <div>
            <Button variant="secondary" size="small" onClick={() => setShowLog(true)}>
              Show its sync log
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function SalesPlatformsManager({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const isAdmin = can("admin");
  const { data, error, loading, reload } = useApiData<{ connections: SalesPlatformConnection[] }>("/api/sales-platforms/connections", { organisationId });
  const [notice, setNotice] = useState<string | null>(null);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (loading || !data) return <p className={ui.muted}>Loading…</p>;
  const current = data.connections.filter((connection) => connection.status !== "disconnected");
  const earlier = data.connections.filter((connection) => connection.status === "disconnected");

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Notice tone="warning">
        This hasn&apos;t been tried against a real Shopify store yet, only against Shopify&apos;s documented responses. Check the first sync&apos;s log
        carefully. Orders, refunds and payouts are posted only when &quot;Post to the accounts&quot; is on for a store.
      </Notice>
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {current.map((connection) => (
        <ConnectionCard key={connection.id} organisationId={organisationId} connection={connection} isAdmin={isAdmin} onChanged={reload} />
      ))}
      {isAdmin ? (
        <Card
          title={current.length === 0 ? "Connect a Shopify store" : "Connect another Shopify store"}
          description="Shopify's customers become contacts (as customers) and its products' variants become items, matched to existing ones by email or SKU."
        >
          <ConnectForm
            organisationId={organisationId}
            onConnected={(text) => {
              setNotice(text);
              reload();
            }}
          />
        </Card>
      ) : current.length === 0 ? (
        <Empty>No sales platform is connected. An admin can connect a Shopify store here.</Empty>
      ) : null}
      {earlier.length > 0 ? (
        <>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Earlier connections</h2>
          {earlier.map((connection) => (
            <ConnectionCard key={connection.id} organisationId={organisationId} connection={connection} isAdmin={isAdmin} onChanged={reload} />
          ))}
        </>
      ) : null}
    </div>
  );
}

/**
 * Posting to the accounts (SPC11-SPC24): the switch, the start date, the
 * accounts, Shopify's tax rates matched to tax codes, the code for untaxed
 * sales and the contact for guest checkouts (decision 317). Saved together;
 * the server checks everything posting needs before the switch goes on.
 */
function PostingSettings({
  organisationId,
  connection,
  isAdmin,
  busy,
  run,
  path,
}: {
  organisationId: string;
  connection: SalesPlatformConnection;
  isAdmin: boolean;
  busy: boolean;
  run: (work: () => Promise<string>) => Promise<void>;
  path: string;
}) {
  const accounts = useAccounts(organisationId);
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const [form, setForm] = useState(() => ({
    postToAccounts: connection.postToAccounts,
    startDate: connection.startDate ?? "",
    clearingAccountCode: connection.clearingAccountCode ?? "",
    payoutAccountCode: connection.payoutAccountCode ?? "",
    feesAccountCode: connection.feesAccountCode ?? "",
    salesAccountCode: connection.salesAccountCode ?? "",
    shippingAccountCode: connection.shippingAccountCode ?? "",
    chargebacksAccountCode: connection.chargebacksAccountCode ?? "",
    reserveAccountCode: connection.reserveAccountCode ?? "",
    untaxedTaxCode: connection.untaxedTaxCode ?? "",
    guestContactId: connection.guestContactId ?? "",
    taxCodes: connection.taxCodes.length > 0 ? connection.taxCodes.map((entry) => ({ ...entry })) : [{ rate: "15", taxCode: "" }],
  }));
  const list = accounts.data?.accounts ?? [];
  const codes = (taxCodes.data?.taxCodes ?? []).filter((code) => code.isActive && code.availableOn !== "purchases");
  const customers = (contacts.data?.contacts ?? []).filter((contact) => contact.isCustomer);
  const set = (change: Partial<typeof form>) => setForm((current) => ({ ...current, ...change }));
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async () => {
      await api(path, {
        method: "PATCH",
        body: {
          organisationId,
          postToAccounts: form.postToAccounts,
          startDate: form.startDate || null,
          clearingAccountCode: form.clearingAccountCode || null,
          payoutAccountCode: form.payoutAccountCode || null,
          feesAccountCode: form.feesAccountCode || null,
          salesAccountCode: form.salesAccountCode || null,
          shippingAccountCode: form.shippingAccountCode || null,
          chargebacksAccountCode: form.chargebacksAccountCode || null,
          reserveAccountCode: form.reserveAccountCode || null,
          untaxedTaxCode: form.untaxedTaxCode || null,
          guestContactId: form.guestContactId || null,
          taxCodes: form.taxCodes.filter((entry) => entry.rate !== "" && entry.taxCode !== ""),
        },
      });
      return "Posting settings saved.";
    });
  };
  const accountField = (label: string, key: "clearingAccountCode" | "payoutAccountCode" | "feesAccountCode" | "salesAccountCode" | "shippingAccountCode" | "chargebacksAccountCode" | "reserveAccountCode", filter: (account: (typeof list)[number]) => boolean, hint?: string) => (
    <Field label={label} hint={hint}>
      <AccountSelect accounts={list} filter={filter} placeholder="Not chosen" value={form[key]} onChange={(code) => set({ [key]: code } as Partial<typeof form>)} />
    </Field>
  );
  return (
    <details>
      <summary>
        <strong>Posting to the accounts</strong> · {connection.postToAccounts ? `on, from ${connection.startDate}` : "off"}
      </summary>
      <form onSubmit={save} style={{ display: "grid", gap: 12, marginTop: 12 }}>
        <fieldset disabled={!isAdmin || busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={form.postToAccounts} onChange={(event) => set({ postToAccounts: event.target.checked })} /> Post orders, refunds and payouts to the accounts
          </label>
          <div className={ui.grid2}>
            <Field label="Start date" hint="Orders processed before it aren't brought in.">
              <input type="date" value={form.startDate} onChange={(event) => set({ startDate: event.target.value })} />
            </Field>
            {accountField("Clearing account", "clearingAccountCode", (account) => account.accountType === "bank", "A bank account for money Shopify holds until it pays out.")}
            {accountField("Payouts arrive in", "payoutAccountCode", (account) => account.accountType === "bank")}
            {accountField("Fees", "feesAccountCode", (account) => account.accountClass === "expense")}
            {accountField("Sales", "salesAccountCode", (account) => account.accountClass === "revenue")}
            {accountField("Shipping", "shippingAccountCode", (account) => account.accountClass === "revenue")}
            {accountField("Chargebacks", "chargebacksAccountCode", (account) => account.accountClass === "expense", "Disputed amounts Shopify takes back. Needed once a payout has a chargeback.")}
            {accountField("Reserve", "reserveAccountCode", (account) => account.accountType === "bank", "A bank account for money Shopify holds back. Needed once a payout has a reserve.")}
            <Field label="Tax code for untaxed sales" hint="Zero-rated or exempt; needed when the organisation is GST registered.">
              <select value={form.untaxedTaxCode} onChange={(event) => set({ untaxedTaxCode: event.target.value })}>
                <option value="">Not chosen</option>
                {codes.filter((code) => code.category === "zero_rated" || code.category === "exempt").map((code) => (
                  <option key={code.id} value={code.code}>{code.code} {code.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Guest checkouts go to" hint="Orders without a Shopify customer. Not chosen: they're refused and logged.">
              <select value={form.guestContactId} onChange={(event) => set({ guestContactId: event.target.value })}>
                <option value="">Not chosen (refused)</option>
                {customers.map((contact) => (
                  <option key={contact.id} value={String(contact.id)}>{contact.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <div>
            <strong>Shopify&apos;s tax rates</strong>
            {form.taxCodes.map((entry, index) => (
              <div key={index} className={ui.actions}>
                <input
                  aria-label="Rate %"
                  inputMode="decimal"
                  value={entry.rate}
                  style={{ width: 80 }}
                  onChange={(event) => set({ taxCodes: form.taxCodes.map((other, at) => (at === index ? { ...other, rate: event.target.value } : other)) })}
                />
                % →
                <select
                  aria-label="Tax code"
                  value={entry.taxCode}
                  onChange={(event) => set({ taxCodes: form.taxCodes.map((other, at) => (at === index ? { ...other, taxCode: event.target.value } : other)) })}
                >
                  <option value="">Choose a tax code</option>
                  {codes.map((code) => (
                    <option key={code.id} value={code.code}>{code.code} {code.label}</option>
                  ))}
                </select>
                <Button type="button" size="small" variant="secondary" onClick={() => set({ taxCodes: form.taxCodes.filter((_, at) => at !== index) })}>
                  Remove
                </Button>
              </div>
            ))}
            <Button type="button" size="small" variant="secondary" onClick={() => set({ taxCodes: [...form.taxCodes, { rate: "", taxCode: "" }] })}>
              Add a rate
            </Button>
          </div>
          {isAdmin ? (
            <div className={ui.actions}>
              <Button type="submit">Save posting settings</Button>
            </div>
          ) : (
            <p className={ui.muted}>Only admins can change these.</p>
          )}
        </fieldset>
      </form>
    </details>
  );
}
