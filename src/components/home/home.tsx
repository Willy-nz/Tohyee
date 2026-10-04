"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Chart } from "@/components/analytics/chart";
import { PinnedAnalyticsTile } from "@/components/analytics/pinned-tile";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { DashboardTileSlots, PageDashboardFrame, useDashboardPreferences } from "@/components/page-dashboard";
import { Notice, ui } from "@/components/ui";
import { formatDate } from "@/lib/format";
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
    <section className={styles.tile} aria-label="Cash in bank">
      <div className={styles.tileTitle}>
        <Link href="/operations/reports?report=bs">Cash in bank</Link>
      </div>
      <div className={styles.figure}>
        <Money value={summary.cashInBank} />
      </div>
      <div className={ui.muted}>Bank accounts · cards are under Banking</div>
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

function NextGstTile({ summary }: { summary: HomeSummary }) {
  const gst = summary.nextGstReturn;
  return (
    <section className={styles.tile} aria-label="Next GST return">
      <div className={styles.tileTitle}>
        <Link href="/operations/gst-return">Next GST return</Link>
        {gst.status === "ready" ? <span className={styles.kind}>{GST_BASIS_LABELS[gst.basis]}</span> : null}
      </div>
      {gst.status === "none_filed" ? (
        <p className={ui.muted}>No filed GST return yet.</p>
      ) : (
        <>
          <div className={styles.figure}>
            <Money value={gst.status === "ready" ? gst.box15.replace(/^-/, "") : "0.00"} />
          </div>
          <div className={ui.muted}>
            {gst.status === "ready" ? (gst.box15.startsWith("-") ? "Refund due so far · " : gst.box15 === "0.00" ? "Nothing to pay so far · " : "To pay so far · ") : ""}
            {gst.periodEnd ? `period ends ${formatDate(gst.periodEnd)}` : ""}
            {gst.status === "error" ? ` · ${gst.message}` : ""}
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
        title="Money owed to you"
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

function ToDoCard({ summary }: { summary: HomeSummary }) {
  const plural = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("#", String(count)));
  const items = [
    { count: summary.toDo.paydayFilingsDue, text: plural(summary.toDo.paydayFilingsDue, "A payday filing is due this week", "# payday filings are due this week"), action: "File", href: "/operations/payroll/pay-runs" },
    { count: summary.toDo.accountsToReconcile, text: plural(summary.toDo.accountsToReconcile, "1 bank line to reconcile", "# bank lines to reconcile"), action: "Reconcile", href: "/operations/bank-accounts" },
    { count: summary.toDo.feedsToReconnect, text: plural(summary.toDo.feedsToReconnect, "A bank feed needs reconnecting", "# bank feeds need reconnecting"), action: "Reconnect", href: "/operations/bank-accounts" },
    { count: summary.toDo.draftsToApprove, text: plural(summary.toDo.draftsToApprove, "1 draft to approve", "# drafts to approve"), action: "Review", href: "/operations/invoices" },
  ].filter((item) => item.count > 0);
  return (
    <section className={styles.tile}>
      <div className={styles.tileTitle}>To do</div>
      {items.length === 0 ? (
        <p className={ui.muted}>Nothing needs doing.</p>
      ) : (
        <div className={styles.rows}>
          {items.map((item) => (
            <div key={item.action} className={styles.row}>
              <span>{item.text}</span>
              <Link href={item.href}>{item.action}</Link>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentActivity({ summary }: { summary: HomeSummary }) {
  return (
    <section className={styles.tile}>
      <div className={styles.tileTitle}>
        <span>Recent activity</span>
        <Link href="/operations/ledger-journals">All journals</Link>
      </div>
      <div className={styles.rows}>
        {summary.recentActivity.map((item) => (
          <div key={item.journalId} className={styles.row}>
            <span>
              {formatDate(item.postingDate)} · {item.description}
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
  if (!summary) return <p className={ui.muted}>Loading…</p>;
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
            <span className={styles.kind}>This financial year</span>
          </div>
          <Chart
            spec={{ kind: "column", category: "month", series: [{ field: "netProfit", label: "Net profit" }], valueFormat: "money", currency: summary.currencyCode }}
            rows={chartRows}
          />
        </section>
        <ToDoCard summary={summary} />
      </div>
      <RecentActivity summary={summary} />
    </>
  );
}
