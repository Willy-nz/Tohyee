"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useApiData } from "@/components/hooks";
import { SALES_PLATFORMS_HREF } from "@/components/navigation";
import { Badge, Button, Card, Empty, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { CoverageKind, CoverageState, KindCoverage } from "@/lib/sales-platforms/coverage-status";
import {
  AUTH_METHOD_LABELS,
  SALES_PLATFORM_LABELS,
  type SalesPlatformConnection,
  SYNC_LOG_ACTION_LABELS,
  type SyncLogEntry,
  type SyncResult,
} from "@/lib/sales-platforms/types";
import { integrationsSummary } from "@/lib/sales-platforms/summary";
import { useConfirm } from "@/components/confirm-dialog";
import { CustomerMatches } from "@/components/customer-matches";
import { ShopifyPartsList, ShopifyScopesCard, StockSection } from "@/components/sales-platform-extras";
import { CustomerChoiceField, type SetupStep, SkuNote, StoreSetup } from "@/components/store-setup";
import { type CustomerChoice, CUSTOMER_CHOICES, customerChoiceOf, customerChoiceSettings } from "@/lib/sales-platforms/setup";
import styles from "./store-setup.module.css";

/**
 * Settings › Sales platforms (examples SPC1-SPC34): connecting a store step
 * by step, what each part has brought in, "Sync now", the sync log and
 * disconnecting; and posting orders, refunds and payouts to the accounts
 * (SPC11-SPC31), set up with the guided steps in store-setup.tsx.
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
    ...(result.posted ? [`${result.posted} posted to the accounts`] : []),
    ...(result.waiting ? [`${result.waiting} waiting`] : []),
  ];
  return `Synced: ${parts.join(", ")}. The log below has the details.`;
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

const KIND_OPTIONS: Array<{ value: string; text: string }> = [
  { value: "", text: "Everything" },
  { value: "customers", text: "Customers" },
  { value: "products", text: "Products" },
  { value: "orders", text: "Orders and refunds" },
  { value: "payouts", text: "Payouts" },
  { value: "connection", text: "Connection and syncs" },
];

const OUTCOME_OPTIONS: Array<{ value: string; text: string }> = [
  { value: "", text: "Any" },
  { value: "problems", text: "Not brought in (skipped, failed, waiting)" },
  { value: "skipped", text: "Skipped" },
  { value: "failed", text: "Failed" },
  { value: "waiting", text: "Waiting" },
  { value: "posted", text: "Posted" },
  { value: "brought_in", text: "Added, linked or updated" },
];

export type LogFilter = { kind: string; outcome: string };

/**
 * The sync log, 200 lines at a time with "Load older" (#532 part 1). Pages
 * continue from the oldest line shown, so lines added meanwhile don't shift
 * them; changing a filter or a new sync starts again from the newest.
 */
function ConnectionLog({
  organisationId,
  connectionId,
  version,
  filter,
  onFilter,
}: {
  organisationId: string;
  connectionId: string;
  version: number;
  filter: LogFilter;
  onFilter: (filter: LogFilter) => void;
}) {
  const path = `/api/sales-platforms/connections/${connectionId}/log`;
  const query = { organisationId, kind: filter.kind || null, outcome: filter.outcome || null };
  const key = JSON.stringify({ path, query, version });
  // The newest page for this filter, then older pages added by "Load older"; kept with the request they answer.
  const [pages, setPages] = useState<{ key: string; entries: SyncLogEntry[]; hasMore: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const asked = JSON.parse(key) as { path: string; query: Record<string, string | null> };
    api<{ entries: SyncLogEntry[]; hasMore: boolean }>(asked.path, { query: asked.query }).then(
      (page) => {
        if (!cancelled) {
          setError(null);
          setPages({ key, entries: page.entries, hasMore: page.hasMore });
        }
      },
      (caught) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  const current = pages?.key === key ? pages : null;
  const entries = current?.entries ?? null;
  const hasMore = current?.hasMore ?? false;

  async function loadOlder() {
    if (!current || current.entries.length === 0) return;
    setLoading(true);
    try {
      const page = await api<{ entries: SyncLogEntry[]; hasMore: boolean }>(path, { query: { ...query, beforeId: current.entries[current.entries.length - 1].id } });
      setPages((latest) => (latest?.key === key ? { key, entries: [...latest.entries, ...page.entries], hasMore: page.hasMore } : latest));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className={styles.logFilters}>
        <label className={styles.smallField} style={{ flex: "0 1 220px" }}>
          <span>Show</span>
          <select value={filter.kind} onChange={(event) => onFilter({ ...filter, kind: event.target.value })}>
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.text}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.smallField} style={{ flex: "0 1 300px" }}>
          <span>What happened</span>
          <select value={filter.outcome} onChange={(event) => onFilter({ ...filter, outcome: event.target.value })}>
            {OUTCOME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.text}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {entries === null ? (
        <p className={ui.muted}>Loading the log…</p>
      ) : entries.length === 0 && (filter.kind || filter.outcome) ? (
        <Empty>Nothing in the log matches.</Empty>
      ) : (
        <SyncLog entries={entries} />
      )}
      {entries && entries.length > 0 ? (
        hasMore ? (
          <div>
            <Button variant="secondary" size="small" disabled={loading} onClick={() => void loadOlder()}>
              {loading ? "Loading…" : "Load older"}
            </Button>
          </div>
        ) : (
          <p className={ui.muted} style={{ margin: 0 }}>
            That&apos;s everything{filter.kind || filter.outcome ? " that matches" : ""}: {entries.length.toLocaleString("en-NZ")} {entries.length === 1 ? "line" : "lines"}.
          </p>
        )
      ) : null}
    </div>
  );
}

const STATE_BADGES: Record<CoverageState, { tone: "green" | "amber" | "neutral" | "red" | "blue"; text: string }> = {
  off: { tone: "neutral", text: "Off" },
  needs_setup: { tone: "amber", text: "Needs setting up" },
  not_synced: { tone: "neutral", text: "Not synced yet" },
  up_to_date: { tone: "green", text: "Up to date" },
  partly: { tone: "amber", text: "Partly brought in" },
  failed: { tone: "red", text: "Failed" },
};

const PROBLEM_OUTCOME = "problems";

/**
 * What each part has brought in (#532 part 2): Customers, Products, Orders
 * and Payouts, each with its state, real counts and what to do next. Shown
 * apart from whether the connection itself works.
 */
export function CoverageList({
  parts,
  onAction,
  onRetry,
  busy = false,
}: {
  parts: KindCoverage[];
  onAction: (part: KindCoverage) => void;
  /** "Try again" for payouts not posted (SPC39); admins only. */
  onRetry?: () => void;
  busy?: boolean;
}) {
  return (
    <ul className={styles.parts} aria-label="What's been brought in">
      {parts.map((part) => {
        const badge = STATE_BADGES[part.state];
        return (
          <li key={part.kind} className={styles.part}>
            <span className={styles.partName}>{part.label}</span>
            <span className={styles.partText}>
              {part.summary}
              {part.reasons.length > 0 ? (
                <span className={styles.partReasons}>
                  {part.reasons
                    .slice(0, 3)
                    .map((reason) => `${reason.count.toLocaleString("en-NZ")} ${reason.outcome}: ${reason.text}`)
                    .join(" · ")}
                  {part.reasons.length > 3 ? " · and more" : ""}
                </span>
              ) : null}
            </span>
            <span className={ui.actions} style={{ justifyContent: "end" }}>
              <Badge tone={badge.tone}>{badge.text}</Badge>
              {part.retry && onRetry ? (
                <Button size="small" onClick={onRetry} disabled={busy} aria-label={`Try again: ${part.label}`}>
                  Try again
                </Button>
              ) : null}
              {part.action ? (
                <Button size="small" variant={part.action.kind === "log" ? "secondary" : "primary"} onClick={() => onAction(part)} aria-label={`${part.action.text}: ${part.label}`}>
                  {part.action.text}
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
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
  const [showLog, setShowLog] = useState(false);
  const [logFilter, setLogFilter] = useState<LogFilter>({ kind: "", outcome: "" });
  const [setup, setSetup] = useState<SetupStep | null>(null);
  const status = STATUS_BADGES[connection.status];
  const connected = connection.status !== "disconnected";
  const shop = SALES_PLATFORM_LABELS[connection.platform];
  const coverage = useApiData<{ parts: KindCoverage[] }>(connected ? `/api/sales-platforms/connections/${connection.id}/parts` : null, {
    organisationId,
    v: logVersion,
  });
  const logRef = useRef<HTMLDivElement>(null);

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
  // SPC39: reads the payouts not in the accounts from the store again, then syncs. None is posted twice.
  const retryPayouts = () =>
    run(async () => {
      const answer = await api<{ payoutsToReadAgain: number; result: SyncResult }>(`${path}/payouts/retry`, { method: "POST", body: { organisationId } });
      return `Read ${answer.payoutsToReadAgain} payout${answer.payoutsToReadAgain === 1 ? "" : "s"} again. ${describeSyncResult(answer.result)}`;
    });
  const choose = (change: { syncProducts: boolean }) =>
    run(async () => {
      await api(path, { method: "PATCH", body: { organisationId, ...change } });
      return `Saved: products ${change.syncProducts ? "will" : "won't"} come in from the next sync.`;
    });
  const chooseCustomers = (choice: CustomerChoice) =>
    run(async () => {
      await api(path, { method: "PATCH", body: { organisationId, ...customerChoiceSettings(choice) } });
      const label = CUSTOMER_CHOICES.find((entry) => entry.value === choice)!.label;
      return `Saved: ${label.charAt(0).toLowerCase()}${label.slice(1)}, from the next sync. Contacts already brought in stay.`;
    });
  const turnOff = async () => {
    if (!(await confirm(`Turn posting off for ${connection.storeName ?? connection.storeDomain}? What's already posted stays. New ${shop} sales won't come into the accounts until it's on again.`))) return;
    void run(async () => {
      await api(path, { method: "PATCH", body: { organisationId, postToAccounts: false } });
      return "Posting is off. What was posted stays.";
    });
  };
  const disconnect = async () => {
    if (
      !(await confirm(
        `Disconnect ${connection.storeName ?? connection.storeDomain}? The contacts and items already brought in stay, and so does this log. Tohyee forgets the store's credentials and which ${shop} record each contact and item came from.`,
      ))
    ) {
      return;
    }
    void run(async () => {
      await api(path, { method: "DELETE", query: { organisationId } });
      return "Disconnected. The contacts and items brought in are kept.";
    });
  };
  const act = (part: KindCoverage) => {
    if (!part.action) return;
    if (part.action.kind === "setup") setSetup("start");
    else if (part.action.kind === "turn_on") setSetup("review");
    else if (part.action.kind === "scopes") {
      const scopes = document.getElementById("shopify-scopes");
      if (scopes instanceof HTMLDetailsElement) scopes.open = true;
      scopes?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    else {
      setLogFilter({ kind: part.kind as CoverageKind, outcome: PROBLEM_OUTCOME });
      setShowLog(true);
      requestAnimationFrame(() => logRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };

  if (setup && isAdmin && connected) {
    return (
      <Card title={`${shop}: ${connection.storeName ?? connection.storeDomain}`}>
        <StoreSetup
          organisationId={organisationId}
          connection={connection}
          firstStep={setup}
          onClose={(text) => {
            setSetup(null);
            if (text) setMessage({ tone: "success", text });
            setLogVersion((value) => value + 1);
            onChanged();
          }}
        />
      </Card>
    );
  }

  return (
    <Card
      title={`${shop}: ${connection.storeName ?? connection.storeDomain}`}
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
          <p className={ui.muted} style={{ margin: 0 }}>
            Connected by {connection.connectedByEmail} on {formatDateTime(connection.connectedAt)}.{" "}
            {connection.lastSyncAt ? `Last synced ${formatDateTime(connection.lastSyncAt)}.` : "Not synced yet."}{" "}
            {connection.webhooksActive ? `${shop} also sends changes as they happen.` : null}
          </p>
        ) : (
          <p className={ui.muted}>
            Disconnected by {connection.disconnectedByEmail} on {formatDateTime(connection.disconnectedAt)}.
          </p>
        )}
        {connected && connection.lastError ? <Notice tone="error">The last sync failed: {connection.lastError}</Notice> : null}
        {connected && connection.webhooksNote ? <Notice tone="warning">{connection.webhooksNote}</Notice> : null}
        {connected ? (
          coverage.data ? (
            <CoverageList parts={coverage.data.parts} onAction={act} onRetry={isAdmin ? () => void retryPayouts() : undefined} busy={busy} />
          ) : coverage.error ? (
            <Notice tone="error">{coverage.error}</Notice>
          ) : (
            <p className={ui.muted}>Working out what&apos;s been brought in…</p>
          )
        ) : null}
        {connected && isAdmin && connection.platform === "shopify" && connection.syncCustomers && connection.customerScope === "all" ? (
          <Notice tone="info">
            Every {shop} customer comes in as a contact, including newsletter sign-ups. You can bring in only customers who have ordered instead; contacts already brought in
            stay.{" "}
            <Button variant="secondary" disabled={busy} onClick={() => void chooseCustomers("buyers")}>
              Only customers who have ordered
            </Button>
          </Notice>
        ) : null}
        {connected ? (
          <CustomerMatches
            organisationId={organisationId}
            connectionId={connection.id}
            platform={connection.platform}
            isAdmin={isAdmin}
            version={logVersion}
            onResolved={(text) => {
              setMessage({ tone: "success", text });
              setLogVersion((value) => value + 1);
            }}
          />
        ) : null}
        {connected && isAdmin ? (
          <div className={ui.actions}>
            <Button onClick={() => void sync()} disabled={busy}>
              {busy ? "Working…" : "Sync now"}
            </Button>
            <Button variant="secondary" onClick={() => setSetup("start")} disabled={busy}>
              {connection.postToAccounts ? "Change posting settings" : "Set up posting"}
            </Button>
            {connection.postToAccounts ? (
              <Button variant="secondary" onClick={() => void turnOff()} disabled={busy}>
                Turn posting off
              </Button>
            ) : null}
          </div>
        ) : null}
        {connected ? (
          <details className={styles.more}>
            <summary>More: what comes in, {connection.platform === "shopify" ? "Shopify's parts, stock, " : ""}test or disconnect</summary>
            <div style={{ display: "grid", gap: 12 }}>
              {connection.platform === "shopify" ? (
                <div style={{ display: "grid", gap: 6 }}>
                  <strong>What comes in</strong>
                  <span className={ui.muted}>Each choice saves as soon as you make it.</span>
                  <CustomerChoiceField
                    name={`customers-${connection.id}`}
                    value={customerChoiceOf(connection)}
                    disabled={!isAdmin || busy}
                    onChange={(choice) => void chooseCustomers(choice)}
                  />
                  <div className={ui.actions}>
                    <label className={ui.checkbox}>
                      <input type="checkbox" checked={connection.syncProducts} disabled={!isAdmin || busy} onChange={(event) => void choose({ syncProducts: event.target.checked })} />{" "}
                      Products, as items
                    </label>
                  </div>
                  <SkuNote connection={connection} />
                  {connection.pricesIncludeTax ? (
                    <span className={ui.muted}>This store&apos;s prices include tax, so they aren&apos;t copied to items (Tohyee&apos;s item prices exclude GST).</span>
                  ) : null}
                </div>
              ) : null}
              {connection.platform === "shopify" ? <ShopifyPartsList grantedScopes={connection.grantedScopes} /> : null}
              {connection.platform === "shopify" ? <StockSection organisationId={organisationId} connectionId={connection.id} /> : null}
              {isAdmin ? (
                <div className={ui.actions}>
                  <Button variant="secondary" onClick={() => void test()} disabled={busy}>
                    Test connection
                  </Button>
                  <Button variant="danger" onClick={disconnect} disabled={busy}>
                    Disconnect
                  </Button>
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
        <div ref={logRef}>
          {showLog ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div className={ui.actions} style={{ justifyContent: "space-between" }}>
                <h3 style={{ margin: 0, fontSize: "1rem" }}>Sync log</h3>
                <Button variant="secondary" size="small" onClick={() => setShowLog(false)}>
                  Hide the log
                </Button>
              </div>
              <ConnectionLog organisationId={organisationId} connectionId={connection.id} version={logVersion} filter={logFilter} onFilter={setLogFilter} />
            </div>
          ) : (
            <Button variant="secondary" size="small" onClick={() => setShowLog(true)}>
              Show the sync log
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * A short card for CRM Home (#342, decision 582): connected stores with their
 * state, last sync and last error, from the same connections as Settings ›
 * Sales platforms; or, for an admin with none, a link to connect Shopify.
 * Connecting and every other change happen on that page.
 */
export function SalesPlatformsSummary({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const { data } = useApiData<{ connections: SalesPlatformConnection[] }>("/api/sales-platforms/connections", { organisationId });
  // Quiet while loading or if it can't be read: it's a pointer, not the page itself.
  if (!data) return null;
  const summary = integrationsSummary(data.connections, can("admin"));
  if (!summary) return null;
  if (summary.kind === "connect") {
    return (
      <Card
        title="Selling on Shopify?"
        actions={<Link href={SALES_PLATFORMS_HREF}>Connect Shopify</Link>}
      >
        <p className={ui.muted}>It hasn&apos;t been tried with a real Shopify store yet.</p>
      </Card>
    );
  }
  return (
    <Card title="Sales platforms" actions={<Link href={SALES_PLATFORMS_HREF}>Sales platforms</Link>}>
      <ul style={{ display: "grid", gap: 8, margin: 0, padding: 0, listStyle: "none" }}>
        {summary.connections.map((connection) => {
          const status = STATUS_BADGES[connection.status];
          return (
            <li key={connection.id}>
              <strong>
                {SALES_PLATFORM_LABELS[connection.platform]}: {connection.storeName ?? connection.storeDomain}
              </strong>{" "}
              <Badge tone={status.tone}>{status.text}</Badge>
              <div className={ui.muted}>{connection.lastSyncAt ? `Last synced ${formatDateTime(connection.lastSyncAt)}.` : "Not synced yet."}</div>
              {connection.lastError ? <div className={ui.muted}>The last sync failed: {connection.lastError}</div> : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function SalesPlatformsManager({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const isAdmin = can("admin");
  const { data, error, loading, reload } = useApiData<{ connections: SalesPlatformConnection[] }>("/api/sales-platforms/connections", { organisationId });
  const [notice, setNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (loading || !data) return <p className={ui.muted}>Loading…</p>;
  const current = data.connections.filter((connection) => connection.status !== "disconnected");
  const earlier = data.connections.filter((connection) => connection.status === "disconnected");
  const setupOpen = isAdmin && (connecting || current.length === 0);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {isAdmin ? null : <Notice>Admins connect shops; you can read the sync log.</Notice>}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {setupOpen ? (
        <Card title={current.length === 0 ? undefined : "Connect another shop"}>
          <StoreSetup
            organisationId={organisationId}
            onClose={(text) => {
              setConnecting(false);
              setNotice(text);
              reload();
            }}
          />
        </Card>
      ) : null}
      {current.map((connection) => (
        <ConnectionCard key={connection.id} organisationId={organisationId} connection={connection} isAdmin={isAdmin} onChanged={reload} />
      ))}
      {isAdmin && !setupOpen ? (
        <div>
          <Button variant="secondary" onClick={() => setConnecting(true)}>
            Connect another shop
          </Button>
        </div>
      ) : null}
      {!isAdmin && current.length === 0 ? <Empty>No shop is connected. An admin can connect a Shopify or WooCommerce store here.</Empty> : null}
      {current.some((connection) => connection.platform === "shopify") ? (
        <details id="shopify-scopes" className={styles.more}>
          <summary>Shopify access scopes: what to give the app</summary>
          <ShopifyScopesCard />
        </details>
      ) : null}
      {current.length > 0 ? (
        <p className={ui.muted} style={{ margin: 0 }}>
          Not tried with a real store&apos;s orders, refunds and payouts yet: check the first sync&apos;s log.
        </p>
      ) : null}
      {earlier.length > 0 ? (
        <details className={styles.more}>
          <summary>Earlier connections ({earlier.length})</summary>
          <div style={{ display: "grid", gap: 12 }}>
            {earlier.map((connection) => (
              <ConnectionCard key={connection.id} organisationId={organisationId} connection={connection} isAdmin={isAdmin} onChanged={reload} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
