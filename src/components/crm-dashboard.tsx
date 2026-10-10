"use client";

import Link from "next/link";
import { useState } from "react";
import { amountIn, useBaseCurrency } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import type { CurrencyAmount, Dashboard, DashboardDeal } from "@/lib/crm/dashboard";
import type { ForecastPeriodKind } from "@/lib/crm/forecast-figures";
import { LEAD_SOURCE_LABELS } from "@/lib/crm/lead-types";
import { formatDate, formatMoney } from "@/lib/format";

type Drill = { title: string; deals: DashboardDeal[] };

/**
 * CRM › Dashboard (decision 500): lead conversion, win rate, sales cycle,
 * stage ageing, activity, quota attainment and campaigns, per month or
 * quarter. Each count of deals opens the deals it's made of.
 */
export function DashboardPage({ organisationId }: { organisationId: string }) {
  const baseCurrency = useBaseCurrency();
  const [period, setPeriod] = useState<ForecastPeriodKind>("month");
  const [periods, setPeriods] = useState("6");
  const [drill, setDrill] = useState<Drill | null>(null);
  const data = useApiData<{ dashboard: Dashboard }>("/api/crm/dashboard", { organisationId, period, periods });
  const d = data.data?.dashboard;
  const label = (start: string) => d?.periods.find((entry) => entry.start === start)?.label ?? start;
  const amounts = (list: CurrencyAmount[]) => (list.length === 0 ? "—" : list.map((entry) => amountIn(entry.amount, entry.currencyCode, baseCurrency)).join(" + "));
  const open = (title: string, deals: DashboardDeal[]) => setDrill({ title, deals });
  const count = (value: number, title: string, deals: () => DashboardDeal[]) =>
    value === 0 ? (
      "0"
    ) : (
      <button type="button" className={ui.linkButton} onClick={() => open(title, deals())}>
        {value}
      </button>
    );
  const inPeriod = (start: string, end: string, deal: DashboardDeal) => deal.closedOn !== null && deal.closedOn >= start && deal.closedOn <= end;
  return (
    <>
      <Card
        title="Sales dashboard"
        description="Worked out from the CRM's records each time. Amounts exclude GST and are never added across currencies. A deal's closed date is the day it moved to Closed won or lost."
      >
        <div className={ui.grid3}>
          <Field label="By">
            <select value={period} onChange={(event) => setPeriod(event.target.value as ForecastPeriodKind)}>
              <option value="month">Month</option>
              <option value="quarter">Quarter (of the financial year)</option>
            </select>
          </Field>
          <Field label="Periods (ending with this one)">
            <input inputMode="numeric" className={ui.num} value={periods} onChange={(event) => setPeriods(event.target.value)} />
          </Field>
        </div>
        {data.error ? <Notice tone="error">{data.error}</Notice> : null}
        {d?.scoped ? <Notice>These figures are your own leads, deals and activity.</Notice> : null}
      </Card>
      {!d ? (
        <p className={ui.muted}>Loading…</p>
      ) : (
        <>
          <Card title="Leads" description="Of the leads added in each period, how many have been converted so far.">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Period</th>
                  <th className={ui.num}>Added</th>
                  <th className={ui.num}>Converted</th>
                  <th className={ui.num}>Conversion</th>
                </tr>
              </thead>
              <tbody>
                {d.leads.map((row) => (
                  <tr key={row.periodStart}>
                    <td>{label(row.periodStart)}</td>
                    <td className={ui.num}>{row.added}</td>
                    <td className={ui.num}>{row.converted}</td>
                    <td className={ui.num}>{row.rate === null ? "—" : `${row.rate}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.leadSources.length > 0 ? (
              <p className={ui.muted}>
                By how they came in:{" "}
                {d.leadSources.map((row) => `${LEAD_SOURCE_LABELS[row.source]} ${row.added} (${row.rate ?? "—"}% converted)`).join(" · ")}
              </p>
            ) : null}
          </Card>
          <Card title="Win rate and sales cycle" description="Deals closed in each period: won ÷ (won + lost). The sales cycle is the days from a deal being added to it being won.">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Period</th>
                  <th className={ui.num}>Won</th>
                  <th className={ui.num}>Lost</th>
                  <th className={ui.num}>Win rate</th>
                  <th className={ui.num}>Won amount</th>
                  <th className={ui.num}>Average days</th>
                  <th className={ui.num}>Median days</th>
                </tr>
              </thead>
              <tbody>
                {d.winLoss.map((row, index) => {
                  const p = d.periods[index];
                  const cycle = d.cycle[index];
                  return (
                    <tr key={row.periodStart}>
                      <td>{p.label}</td>
                      <td className={ui.num}>{count(row.won, `Won in ${p.label}`, () => d.deals.filter((deal) => deal.stageType === "won" && inPeriod(p.start, p.end, deal)))}</td>
                      <td className={ui.num}>{count(row.lost, `Lost in ${p.label}`, () => d.deals.filter((deal) => deal.stageType === "lost" && inPeriod(p.start, p.end, deal)))}</td>
                      <td className={ui.num}>{row.winRate === null ? "—" : `${row.winRate}%`}</td>
                      <td className={ui.num}>{amounts(row.wonAmounts)}</td>
                      <td className={ui.num}>{cycle.averageDays ?? "—"}</td>
                      <td className={ui.num}>{cycle.medianDays ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          <Card title="Open deals by stage" description="Today, with how long they've been in the stage they're in.">
            {d.ageing.length === 0 ? (
              <Empty>No open deals.</Empty>
            ) : (
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th className={ui.num}>Deals</th>
                    <th className={ui.num}>Amount</th>
                    <th className={ui.num}>Average days in stage</th>
                    <th className={ui.num}>Longest</th>
                  </tr>
                </thead>
                <tbody>
                  {d.ageing.map((row) => (
                    <tr key={row.stage}>
                      <td>{row.stageName}</td>
                      <td className={ui.num}>{count(row.count, `Open in ${row.stageName}`, () => d.deals.filter((deal) => deal.stageType === "open" && deal.stageName === row.stageName))}</td>
                      <td className={ui.num}>{amounts(row.amounts)}</td>
                      <td className={ui.num}>{row.averageDays ?? "—"}</td>
                      <td className={ui.num}>{row.oldestDays ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Activity" description="Calls, meetings and notes logged, tasks done and sales emails sent, by who did them.">
            {d.activity.length === 0 ? (
              <Empty>Nothing logged.</Empty>
            ) : (
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Who</th>
                    <th className={ui.num}>Calls</th>
                    <th className={ui.num}>Meetings</th>
                    <th className={ui.num}>Notes</th>
                    <th className={ui.num}>Tasks done</th>
                    <th className={ui.num}>Emails sent</th>
                  </tr>
                </thead>
                <tbody>
                  {d.activity.map((row) => (
                    <tr key={`${row.periodStart}:${row.userId}`}>
                      <td>{label(row.periodStart)}</td>
                      <td>{row.name}</td>
                      <td className={ui.num}>{row.calls}</td>
                      <td className={ui.num}>{row.meetings}</td>
                      <td className={ui.num}>{row.notes}</td>
                      <td className={ui.num}>{row.tasksDone}</td>
                      <td className={ui.num}>{row.emailsSent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Quota attainment" description={`As the forecast works it out: Closed in ${baseCurrency} by expected close date ÷ quota.`}>
            {d.quotas.length === 0 ? (
              <Empty>
                No quotas set. Admins set them on <Link href="/crm/forecasts">Forecasts</Link>.
              </Empty>
            ) : (
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Who</th>
                    <th className={ui.num}>Closed</th>
                    <th className={ui.num}>Quota</th>
                    <th className={ui.num}>Attainment</th>
                  </tr>
                </thead>
                <tbody>
                  {d.quotas.map((row) => (
                    <tr key={`${row.periodStart}:${row.ownerUserId}`}>
                      <td>{label(row.periodStart)}</td>
                      <td>{row.name}</td>
                      <td className={ui.num}>{formatMoney(row.closed)}</td>
                      <td className={ui.num}>{formatMoney(row.quota)}</td>
                      <td className={ui.num}>{row.attainment === null ? "—" : `${row.attainment}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Campaigns" description="Leads added and deals won in these periods, by their source campaign (one each).">
            {d.campaigns.length === 0 ? (
              <Empty>Nothing from campaigns in these periods.</Empty>
            ) : (
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th className={ui.num}>Leads</th>
                    <th className={ui.num}>Deals won</th>
                    <th className={ui.num}>Won amount</th>
                    <th className={ui.num}>Actual cost</th>
                  </tr>
                </thead>
                <tbody>
                  {d.campaigns.map((row) => (
                    <tr key={row.campaignId}>
                      <td>
                        <Link href={`/crm/campaigns/${row.campaignId}`}>{row.name}</Link>
                      </td>
                      <td className={ui.num}>{row.leads}</td>
                      <td className={ui.num}>{row.won}</td>
                      <td className={ui.num}>{amounts(row.wonAmounts)}</td>
                      <td className={ui.num}>{row.actualCost === null ? "—" : formatMoney(row.actualCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          {drill ? (
            <Card
              title={drill.title}
              actions={
                <Button size="small" variant="secondary" onClick={() => setDrill(null)}>
                  Close
                </Button>
              }
            >
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Deal</th>
                    <th>Stage</th>
                    <th className={ui.num}>Amount</th>
                    <th>Added</th>
                    <th>Closed</th>
                    <th className={ui.num}>Days</th>
                  </tr>
                </thead>
                <tbody>
                  {drill.deals.map((deal) => (
                    <tr key={deal.id}>
                      <td>
                        <Link href={`/crm/opportunities/${deal.id}`}>{deal.name}</Link>
                      </td>
                      <td>{deal.stageName}</td>
                      <td className={ui.num}>{amountIn(deal.amount, deal.currencyCode, baseCurrency)}</td>
                      <td>{formatDate(deal.addedOn)}</td>
                      <td>{deal.closedOn ? formatDate(deal.closedOn) : ""}</td>
                      <td className={ui.num}>{deal.days ?? deal.daysInStage ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}
