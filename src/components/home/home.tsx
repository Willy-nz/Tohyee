"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Chart } from "@/components/analytics/chart";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { DashboardTileSlots, PageDashboardFrame, useDashboardPreferences } from "@/components/page-dashboard";
import { Notice, ui } from "@/components/ui";
import { formatDate } from "@/lib/format";
import type { AmountsDue, HomeSummary } from "@/lib/reports/home";
import { GST_BASIS_LABELS } from "@/lib/tax/categories";
import styles from "./home.module.css";

const HOME_TILES = [
  { id: "cash_in_bank", label: "Cash in bank" },
  { id: "owed_to_you", label: "Money owed to you" },
  { id: "bills_to_pay", label: "Bills to pay" },
  { id: "next_gst_return", label: "Next GST return" },
] as const;
const HOME_DEFAULT_TILE_IDS = HOME_TILES.map((tile) => tile.id);

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
      <div className={ui.muted}>Active bank accounts only.</div>
      <Link className={styles.action} href="/operations/reports?report=bs">
        Open balance sheet
      </Link>
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
  note: string;
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
      <Link className={styles.action} href={href}>
        Open report
      </Link>
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
            {gst.periodEnd ? `Period ends ${formatDate(gst.periodEnd)}` : ""}
            {gst.status === "error" ? ` · ${gst.message}` : ""}
          </div>
        </>
      )}
      <Link className={styles.action} href="/operations/gst-return">
        Open GST return
      </Link>
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
        note={`Overdue: ${summary.owedToYou.overdueCount}`}
        href="/operations/reports?report=aged"
      />
    );
  }
  if (tile === "bills_to_pay") {
    return (
      <AmountsDueTile
        title="Bills to pay"
        due={summary.billsToPay}
        note={`Due this week: ${summary.billsDueThisWeek}`}
        href="/operations/reports?report=payables"
      />
    );
  }
  return <NextGstTile summary={summary} />;
}

function ToDoCard({ summary }: { summary: HomeSummary }) {
  return (
    <section className={styles.tile}>
      <div className={styles.tileTitle}>To do</div>
      <div className={styles.rows}>
        <Link className={styles.action} href="/operations/payroll/pay-runs">
          Payday filings due ({summary.toDo.paydayFilingsDue})
        </Link>
        <Link className={styles.action} href="/operations/bank-accounts">
          Accounts to reconcile ({summary.toDo.accountsToReconcile})
        </Link>
        <Link className={styles.action} href="/operations/bank-accounts">
          Feeds to reconnect ({summary.toDo.feedsToReconnect})
        </Link>
        <Link className={styles.action} href="/operations/invoices">
          Drafts to approve ({summary.toDo.draftsToApprove})
        </Link>
      </div>
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
  const dashboard = useDashboardPreferences({ organisationId, page: "home", defaultTiles: HOME_DEFAULT_TILE_IDS });
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
          <DashboardTileSlots<HomeTileId>
            tiles={dashboard.tiles as HomeTileId[]}
            options={HOME_TILES.map((tile) => ({ id: tile.id, label: tile.label }))}
            onChange={(tiles) => dashboard.setTiles(tiles)}
          />
        }
      >
        <div className={styles.grid}>
          {(dashboard.tiles as HomeTileId[]).map((tile) => (
            <HomeTile key={tile} tile={tile} summary={summary} />
          ))}
        </div>
      </PageDashboardFrame>
      <SectionTitle>Net profit by month</SectionTitle>
      <Chart
        spec={{ kind: "column", category: "month", series: [{ field: "netProfit", label: "Net profit" }], valueFormat: "money", currency: summary.currencyCode }}
        rows={chartRows}
      />
      <SectionTitle>Today</SectionTitle>
      <div className={styles.grid}>
        <ToDoCard summary={summary} />
        <RecentActivity summary={summary} />
      </div>
    </>
  );
}
