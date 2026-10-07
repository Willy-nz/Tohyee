"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { Chart } from "@/components/analytics/chart";
import { PinnedAnalyticsTile } from "@/components/analytics/pinned-tile";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { DashboardTileSlots, PageDashboardFrame, useDashboardPreferences } from "@/components/page-dashboard";
import { Notice, ui } from "@/components/ui";
import type { BankAccount } from "@/lib/bank/accounts";
import { addDays, monthLabel } from "@/lib/financial-year";
import { formatDate, formatDateTime } from "@/lib/format";
import { parseAnalyticsTileReference } from "@/lib/dashboard/analytics-tile-reference";
import { dashboardPage, defaultDashboardTileIds } from "@/lib/dashboard/pages";
import type { Dashboard } from "@/lib/analytics/dashboards";
import type { AmountsDue, HomeSummary } from "@/lib/reports/home";
import { GST_BASIS_LABELS } from "@/lib/tax/categories";
import styles from "./home.module.css";

const HOME_PAGE = dashboardPage("home")!;
const HOME_TILES = HOME_PAGE.defaultTiles;
const HOME_DEFAULT_TILE_IDS = defaultDashboardTileIds(HOME_PAGE);

type HomeTileId = (typeof HOME_TILES)[number]["id"];

/** Home's figures, loaded after the page. */
export function useHomeSummary(organisationId: string) {
  return useApiData<HomeSummary>("/api/home", { organisationId });
}

/** A heading between Home's groups of cards. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className={styles.sectionTitle}>{children}</h2>;
}

function CashInBankTile({ summary }: { summary: HomeSummary }) {
  return (
    <section className={`${styles.tile} ${styles.mainStat}`} aria-label="Cash in bank">
      <div className={styles.tileTitle}>
        <Link href="/operations/bank-accounts">Cash in bank</Link>
      </div>
      <div className={styles.figure}>
        <Money value={summary.cashInBank} />
      </div>
      <div className={ui.muted}>Current ledger balances · excludes credit cards</div>
    </section>
  );
}

export function AmountsDueTile({
  title,
  due,
  note,
  href,
}: {
  title: string;
  due: AmountsDue;
  note: ReactNode;
  href: string;
}) {
  return (
    <section className={styles.tile} aria-label={title}>
      <div className={styles.tileTitle}>
        <Link href={href}>{title}</Link>
      </div>
      <div className={styles.figure}>
        <Money value={due.total} />
      </div>
      <div className={ui.muted}>{note}</div>
    </section>
  );
}

export function NextGstTile({ summary }: { summary: HomeSummary }) {
  const gst = summary.nextGstReturn;
  return (
    <section className={styles.tile} aria-label="GST position">
      <div className={styles.tileTitle}>
        <Link href="/operations/gst-return">GST position</Link>
        {gst.status === "ready" ? <span className={styles.kind}>{GST_BASIS_LABELS[gst.basis]}</span> : null}
      </div>
      {gst.status !== "ready" ? (
        <>
          <div className={styles.unavailable}>Unavailable</div>
          <p className={ui.muted}>{gst.status === "none_filed" ? "No filed GST return yet." : gst.message}</p>
        </>
      ) : (
        <>
          <div className={styles.figure}>
            <Money value={gst.box15.replace(/^-/, "")} />
          </div>
          <div className={ui.muted}>
            Estimate · {/^-?0(\.0+)?$/.test(gst.box15) ? "Nothing to pay so far" : gst.box15.startsWith("-") ? "Refundable" : "Payable"}
            <br />{formatDate(gst.periodStart)} – {formatDate(gst.periodEnd)}
          </div>
        </>
      )}
    </section>
  );
}

function HomeTile({ tile, summary }: { tile: HomeTileId; summary: HomeSummary }) {
  if (tile === "cash_in_bank") return <CashInBankTile summary={summary} />;
  if (tile === "owed_to_you") {
    return (
      <AmountsDueTile
        title="Owed to you"
        due={summary.owedToYou}
        note={summary.owedToYou.overdueCount > 0 ? <span className={styles.bad}><Money value={summary.owedToYou.overdueTotal} /> overdue</span> : "Nothing overdue"}
        href="/operations/reports?report=aged"
      />
    );
  }
  if (tile === "bills_to_pay") {
    return (
      <AmountsDueTile
        title="Bills to pay"
        due={summary.billsToPay}
        note={summary.billsDueThisWeek > 0 ? `${summary.billsDueThisWeek} due this week` : "None due this week"}
        href="/operations/reports?report=payables"
      />
    );
  }
  return <NextGstTile summary={summary} />;
}

export function NeedsAttention({ summary }: { summary: HomeSummary }) {
  const [showAll, setShowAll] = useState(false);
  const plural = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("#", String(count)));
  const items = [
    { count: summary.owedToYou.overdueCount, text: `${summary.owedToYou.overdueCount} overdue ${summary.owedToYou.overdueCount === 1 ? "invoice" : "invoices"}`, action: "Review invoices", href: "/operations/reports?report=aged" },
    { count: summary.toDo.feedsToReconnect, text: plural(summary.toDo.feedsToReconnect, "A bank feed needs reconnecting", "# bank feeds need reconnecting"), action: "Reconnect", href: "/operations/bank-accounts" },
    { count: summary.toDo.paydayFilingsDue, text: plural(summary.toDo.paydayFilingsDue, "A payday filing is due this week", "# payday filings are due this week"), action: "File", href: "/operations/payroll/pay-runs" },
    { count: summary.toDo.accountsToReconcile, text: plural(summary.toDo.accountsToReconcile, "1 bank line to reconcile", "# bank lines to reconcile"), action: "Reconcile", href: "/operations/bank-accounts" },
    { count: summary.billsDueThisWeek, text: `${summary.billsDueThisWeek} ${summary.billsDueThisWeek === 1 ? "bill" : "bills"} due ${formatDate(summary.today)} – ${formatDate(addDays(summary.today, 6))}`, action: "Review bills", href: "/operations/reports?report=payables" },
    { count: summary.toDo.draftsToApprove, text: plural(summary.toDo.draftsToApprove, "1 draft to approve", "# drafts to approve"), action: "Review", href: "/operations/invoices" },
  ].filter((item) => item.count > 0);
  return (
    <section className={styles.tile}>
      <h2 className={styles.tileTitle}>Needs attention</h2>
      {items.length === 0 ? (
        <p className={ui.muted}>You&apos;re up to date.</p>
      ) : (
        <div className={styles.rows}>
          {(showAll ? items : items.slice(0, 5)).map((item) => (
            <div key={item.action} className={styles.row}>
              <span>{item.text}</span>
              <Link href={item.href}>{item.action}</Link>
            </div>
          ))}
        </div>
      )}
      {items.length > 5 ? <button type="button" className={ui.linkButton} onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : "View all"}</button> : null}
    </section>
  );
}

function RecentActivity({ summary }: { summary: HomeSummary }) {
  return (
    <section className={styles.activity}>
      <div className={styles.tileTitle}>
        <h2>Recent activity</h2>
        <Link href="/operations/ledger-journals">All journals</Link>
      </div>
      <div className={styles.rows}>
        {summary.recentActivity.length === 0 ? <p className={ui.muted}>No recent activity.</p> : null}
        {summary.recentActivity.map((item) => (
          <div key={item.journalId} className={styles.row}>
            <span>
              <Link href="/operations/ledger-journals">{item.description}</Link>
              <small className={styles.activityMeta}>{item.reference} · Posted {formatDate(item.postingDate)}</small>
            </span>
            <span>
              <Money value={item.amount} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** How many bank accounts Home shows; the rest are a click away under Banking. */
export const HOME_BANK_ACCOUNT_LIMIT = 5;

/** The bank feed Banking shows for an account (the same precedence when more than one is set up). */
function feedOf(account: BankAccount) {
  return account.feed.active ? account.feed : account.simplefin ?? account.stripe ?? account.paypal ?? account.wise ?? null;
}

/**
 * The active accounts Home shows: those whose feed failed first, then the rest
 * in Banking's order, up to HOME_BANK_ACCOUNT_LIMIT. An organisation can have
 * a hundred accounts, so Home doesn't list them all.
 */
export function bankAccountsForHome(accounts: BankAccount[]): { shown: BankAccount[]; total: number } {
  const active = accounts.filter((account) => account.isActive);
  const failed = (account: BankAccount) => (feedOf(account)?.lastSyncStatus === "failed" ? 0 : 1);
  const ordered = active.map((account, index) => ({ account, index })).sort((a, b) => failed(a.account) - failed(b.account) || a.index - b.index);
  return { shown: ordered.slice(0, HOME_BANK_ACCOUNT_LIMIT).map((entry) => entry.account), total: active.length };
}

/** Bank health uses the same source as Banking; a failed feed never changes a balance. */
export function BankHealth({ organisationId, currency }: { organisationId: string; currency: string }) {
  const banks = useApiData<{ bankAccounts: BankAccount[] }>("/api/bank-accounts", { organisationId });
  const list = banks.data ? bankAccountsForHome(banks.data.bankAccounts) : null;
  return (
    <section className={styles.tile} aria-label="Bank accounts">
      <div className={styles.tileTitle}><h2>Bank accounts</h2><Link href="/operations/bank-accounts">View all</Link></div>
      <p className={ui.muted}>Current ledger balances · {currency}</p>
      {banks.error ? <Notice tone="error">{banks.error}</Notice> : !list ? <p role="status">Loading bank accounts…</p> : list.total === 0 ? <p className={ui.muted}>No bank accounts yet.</p> : (
        <div className={styles.banks}>
          {list.shown.map((account) => {
            const feed = feedOf(account);
            const feeds = feed ? [feed] : [];
            const failed = feeds.some((feed) => feed.lastSyncStatus === "failed");
            const connected = feeds.some((feed) => feed.lastSyncStatus === "ok");
            const status = failed ? "Needs reconnecting" : connected ? "Connected" : feeds.length ? "Awaiting first sync" : "Manual import";
            // A failed attempt is not a successful update timestamp.
            const updated = feeds.filter((feed) => feed.lastSyncStatus === "ok" && feed.lastSyncedAt).map((feed) => feed.lastSyncedAt!).sort().at(-1);
            return (
              <div key={account.id} className={styles.bank}>
                <div className={styles.row}><span><Link href="/operations/bank-accounts">{account.name}</Link><small className={styles.activityMeta}>Account {account.code}{account.accountType === "credit_card" ? " · Credit card" : ""}</small></span><span><Money value={account.ledgerBalance} /><small className={styles.activityMeta}>Ledger · {currency}</small></span></div>
                <p className={failed ? styles.bad : ui.muted}><span aria-hidden="true">{failed ? "⚠" : connected ? "✓" : "↔"}</span> {status}</p>
                <small className={ui.muted}>{updated ? `Last successful sync ${formatDateTime(updated)}` : "No confirmed successful sync"}</small>
                {account.statementBalance !== null ? <p className={ui.muted}>Statement · {account.statementCurrency} <Money value={account.statementBalance} />{account.statementBalanceAt ? ` · ${formatDateTime(account.statementBalanceAt)}` : ""}</p> : null}
                <Link href="/operations/bank-accounts">{account.unreconciledCount ? `Reconcile ${account.unreconciledCount} ${account.unreconciledCount === 1 ? "item" : "items"}` : account.lastLineDate ? "All reconciled" : "No statement yet: import one"}</Link>
              </div>
            );
          })}
          {list.total > HOME_BANK_ACCOUNT_LIMIT ? (
            <p className={ui.muted}>
              Showing {HOME_BANK_ACCOUNT_LIMIT} of {list.total} accounts ·{" "}
              <Link href="/operations/bank-accounts">See them all under Banking</Link>
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function HomeTiles({ organisationId }: { organisationId: string }) {
  const home = useHomeSummary(organisationId);
  const dashboard = useDashboardPreferences({ organisationId, page: HOME_PAGE.id, defaultTiles: HOME_DEFAULT_TILE_IDS });
  const pinned = dashboard.tiles.flatMap((tile) => {
    const reference = parseAnalyticsTileReference(tile);
    return reference ? [{ ...reference, reference: tile }] : [];
  });
  const availableDashboards = useApiData<{ dashboards: Dashboard[] }>(pinned.length ? "/api/analytics/dashboards" : null, { organisationId });
  const pinOptions = pinned.map((reference) => {
    const source = availableDashboards.data?.dashboards.find((entry) => entry.id === reference.dashboardId);
    const tile = source?.tiles.find((entry) => entry.id === reference.tileId);
    return {
      id: reference.reference,
      label: tile && source ? `${tile.title} · ${source.name}` : `Analytics tile ${reference.tileId}`,
    };
  });
  const tileOptions = [...HOME_TILES, ...pinOptions];
  if (home.error) return <Notice tone="error">{home.error}</Notice>;
  const summary = home.data;
  if (!summary) return <div className={styles.loading} role="status" aria-label="Loading financial summary"><span>Loading financial summary…</span><div className={styles.skeleton} /></div>;
  const chartRows = summary.profitByMonth.map((point) => ({ month: point.monthStart, netProfit: point.netProfit }));
  return (
    <>
      {dashboard.error ? <Notice tone="error">{dashboard.error}</Notice> : null}
      <PageDashboardFrame
        hidden={dashboard.hidden}
        onToggleHidden={() => dashboard.setHidden(!dashboard.hidden)}
        customise={
          <DashboardTileSlots<string>
            tiles={dashboard.tiles}
            options={tileOptions}
            onChange={(tiles) => dashboard.setTiles(tiles)}
          />
        }
      >
        <div className={styles.grid}>
          {dashboard.tiles.map((tile) => {
            const reference = parseAnalyticsTileReference(tile);
            if (reference) {
              return <PinnedAnalyticsTile key={tile} organisationId={organisationId} dashboardId={reference.dashboardId} tileId={reference.tileId} />;
            }
            if (HOME_TILES.some((entry) => entry.id === tile)) {
              return <HomeTile key={tile} tile={tile as HomeTileId} summary={summary} />;
            }
            return null;
          })}
        </div>
      </PageDashboardFrame>
      <div className={styles.split}>
        <section className={styles.tile} aria-label="Net profit by month">
          <div className={styles.tileTitle}>
            <Link href="/operations/reports?report=pnl">Net profit by month</Link>
            <span className={styles.chartMeta}>{summary.profitByMonth.length ? `${monthLabel(summary.profitByMonth[0].monthStart)} – ${formatDate(summary.today)}` : "This financial year"} · {summary.currencyCode}</span>
          </div>
          <p className={ui.muted}>Accrual profit from the profit and loss report.</p>
          <Chart
            palette="accent"
            spec={{ kind: "column", category: "month", series: [{ field: "netProfit", label: "Net profit" }], valueFormat: "money", currency: summary.currencyCode }}
            rows={chartRows}
          />
        </section>
        <NeedsAttention summary={summary} />
      </div>
      <div className={styles.split}>
        <RecentActivity summary={summary} />
        <BankHealth organisationId={organisationId} currency={summary.currencyCode} />
      </div>
    </>
  );
}
