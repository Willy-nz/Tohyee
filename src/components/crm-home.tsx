"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useApiData } from "@/components/hooks";
import { DashboardCardChooser, PageDashboardFrame, useDashboardPreferences } from "@/components/page-dashboard";
import { Badge, Card, Empty, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { CurrencyAmount } from "@/lib/crm/dashboard";
import type { SalesHome, SalesHomeDeal } from "@/lib/crm/sales-home";
import { defaultsNote } from "@/lib/dashboard/defaults";
import { dashboardPage, defaultDashboardTileIds, maxTilesFor } from "@/lib/dashboard/pages";
import { formatDate, formatMoney } from "@/lib/format";
import styles from "./crm-home.module.css";

/*
 * The CRM Home as a sales dashboard (decision 662, SD1-SD6): the pipeline,
 * conversion and next actions, then the person's own opportunities, tasks
 * and the team's activity. Customise turns cards on or off and orders them,
 * per person; everyone starts with the cards for their kind (decision 660).
 */

const PAGE = dashboardPage("crm_home")!;
const DEFAULT_IDS = defaultDashboardTileIds(PAGE);

/** Amounts in several currencies, never added together (decision 324): the base currency without its code. */
export function formatAmounts(amounts: CurrencyAmount[], base: string): string {
  if (amounts.length === 0) return formatMoney("0.00");
  return [...amounts]
    .sort((a, b) => (a.currencyCode === base ? -1 : b.currencyCode === base ? 1 : a.currencyCode.localeCompare(b.currencyCode)))
    .map((entry) => (entry.currencyCode === base ? formatMoney(entry.amount) : `${entry.currencyCode} ${formatMoney(entry.amount)}`))
    .join(" + ");
}

const quarterLabel = (start: string, end: string) => `${formatDate(start)} – ${formatDate(end)}`;

function PipelineCard({ data }: { data: SalesHome }) {
  const { pipeline } = data;
  return (
    <Card
      title="Pipeline"
      description={`Open opportunities by stage, excluding GST${data.scoped ? ": yours and your team's" : ""}.`}
      actions={<Link href="/crm/pipeline">Open the pipeline</Link>}
    >
      {pipeline.count === 0 ? (
        <Empty>No open opportunities.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Stage</th>
                <th className={ui.num}>Opportunities</th>
                <th className={ui.num}>Amount</th>
                <th className={ui.num}>Longest in stage</th>
              </tr>
            </thead>
            <tbody>
              {pipeline.stages.map((stage) => (
                <tr key={stage.stage}>
                  <td><Link href="/crm/pipeline">{stage.stageName}</Link></td>
                  <td className={ui.num}>{stage.count}</td>
                  <td className={ui.num}>{formatAmounts(stage.amounts, data.baseCurrency)}</td>
                  <td className={ui.num}>{stage.oldestDays === null ? "" : `${stage.oldestDays} ${stage.oldestDays === 1 ? "day" : "days"}`}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th>
                <th className={ui.num}>{pipeline.count}</th>
                <th className={ui.num}>{formatAmounts(pipeline.totals, data.baseCurrency)}</th>
                <th />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className={ui.muted}><Link href="/crm/dashboard">Sales dashboard</Link>: stage ageing, with the opportunities behind each figure.</p>
    </Card>
  );
}

function ConversionCard({ data }: { data: SalesHome }) {
  const rate = (value: string | null) => (value === null ? "–" : `${value}%`);
  return (
    <Card title="Conversion" description="Leads added that have been converted, and opportunities won of those closed, by quarter of the financial year." actions={<Link href="/crm/dashboard">Sales dashboard</Link>}>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th />
              {data.conversion.map((quarter, index) => (
                <th key={quarter.periodStart} className={ui.num}>
                  {index === data.conversion.length - 1 ? "This quarter" : "Last quarter"}
                  <div className={ui.muted}>{quarterLabel(quarter.periodStart, quarter.periodEnd)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row"><Link href="/crm/leads">Leads converted</Link></th>
              {data.conversion.map((quarter) => (
                <td key={quarter.periodStart} className={ui.num}>{quarter.leadsConverted} of {quarter.leadsAdded} · {rate(quarter.leadRate)}</td>
              ))}
            </tr>
            <tr>
              <th scope="row"><Link href="/crm/dashboard">Win rate</Link></th>
              {data.conversion.map((quarter) => (
                <td key={quarter.periodStart} className={ui.num}>{quarter.won} won, {quarter.lost} lost · {rate(quarter.winRate)}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Won</th>
              {data.conversion.map((quarter) => (
                <td key={quarter.periodStart} className={ui.num}>{formatAmounts(quarter.wonAmounts, data.baseCurrency)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function DealList({ deals, note }: { deals: SalesHomeDeal[]; note: (deal: SalesHomeDeal) => string }) {
  return (
    <ul className={styles.list}>
      {deals.map((deal) => (
        <li key={deal.id}>
          <Link href={`/crm/opportunities/${deal.id}`}>{deal.name}</Link>
          <span className={ui.muted}>{deal.contactName} · {note(deal)}</span>
        </li>
      ))}
    </ul>
  );
}

function More({ count, shown, href, label }: { count: number; shown: number; href: string; label: string }) {
  return count > shown ? <Link href={href}>{label} ({count})</Link> : null;
}

function NextActionsCard({ data }: { data: SalesHome }) {
  const { tasks, pastClose, noNextStep } = data.nextActions;
  const nothing = tasks.count + pastClose.count + noNextStep.count === 0;
  return (
    <Card title="Next actions" description="Yours: tasks due, opportunities past their close date, and open ones with nothing to do next.">
      {nothing ? <Empty>You&apos;re up to date.</Empty> : null}
      {tasks.count ? (
        <section className={styles.group} aria-label="Tasks due">
          <h3 className={styles.groupTitle}>Tasks due ({tasks.count})</h3>
          <ul className={styles.list}>
            {tasks.items.map((task) => (
              <li key={task.id}>
                {task.href ? <Link href={task.href}>{task.title}</Link> : <span>{task.title}</span>}
                <span className={ui.muted}>
                  {task.about ? `${task.about} · ` : ""}Due {formatDate(task.dueDate)} {task.overdue ? <Badge tone="red">Overdue</Badge> : null}
                </span>
              </li>
            ))}
          </ul>
          <More count={tasks.count} shown={tasks.items.length} href="/crm/tasks" label="All my tasks" />
        </section>
      ) : null}
      {pastClose.count ? (
        <section className={styles.group} aria-label="Past their close date">
          <h3 className={styles.groupTitle}>Past their close date ({pastClose.count})</h3>
          <p className={ui.muted}>Move the date, or mark them won or lost.</p>
          <DealList deals={pastClose.items} note={(deal) => `${deal.stageName}, closing ${deal.closeDate ? formatDate(deal.closeDate) : ""}`} />
          <More count={pastClose.count} shown={pastClose.items.length} href="/crm/pipeline" label="Open the pipeline" />
        </section>
      ) : null}
      {noNextStep.count ? (
        <section className={styles.group} aria-label="No next step">
          <h3 className={styles.groupTitle}>No next step ({noNextStep.count})</h3>
          <p className={ui.muted}>Open opportunities with no task still to do.</p>
          <DealList deals={noNextStep.items} note={(deal) => deal.stageName} />
          <More count={noNextStep.count} shown={noNextStep.items.length} href="/crm/pipeline" label="Open the pipeline" />
        </section>
      ) : null}
    </Card>
  );
}

/** The CRM Home's frame: the person's cards in their order, with Customise and Hide. */
export function CrmHomeDashboard({ organisationId, cards }: { organisationId: string; cards: Record<string, ReactNode> }) {
  const { current } = useWorkspace();
  const sales = useApiData<SalesHome>("/api/crm/sales-home", { organisationId });
  const dashboard = useDashboardPreferences({ organisationId, page: PAGE.id, defaultTiles: DEFAULT_IDS });
  const salesCard = (render: (data: SalesHome) => ReactNode, label: string) =>
    sales.error ? <Notice tone="error">{sales.error}</Notice> : sales.data ? render(sales.data) : <Card title={label}><p role="status" className={ui.muted}>Loading…</p></Card>;
  const all: Record<string, ReactNode> = {
    ...cards,
    pipeline: salesCard((data) => <PipelineCard data={data} />, "Pipeline"),
    conversion: salesCard((data) => <ConversionCard data={data} />, "Conversion"),
    next_actions: salesCard((data) => <NextActionsCard data={data} />, "Next actions"),
  };
  return (
    <>
      {dashboard.error ? <Notice tone="error">{dashboard.error}</Notice> : null}
      <PageDashboardFrame
        hidden={dashboard.hidden}
        onToggleHidden={() => dashboard.setHidden(!dashboard.hidden)}
        customise={
          <DashboardCardChooser
            tiles={dashboard.tiles}
            options={[...PAGE.cards]}
            maxTiles={maxTilesFor(PAGE)}
            saving={dashboard.saving}
            onChange={(tiles) => dashboard.setTiles(tiles)}
            intro="Choose the cards on your CRM Home and their order. Only you see this choice."
            startingNote={defaultsNote(PAGE.id, { role: current?.role ?? "viewer" })}
            customised={dashboard.customised}
            onReset={() => void dashboard.reset()}
          />
        }
      >
        {dashboard.ready ? (
          <div className={styles.cards}>
            {dashboard.tiles.map((tile) => (all[tile] ? <div key={tile}>{all[tile]}</div> : null))}
          </div>
        ) : (
          <p role="status" className={ui.muted}>Loading…</p>
        )}
      </PageDashboardFrame>
    </>
  );
}
