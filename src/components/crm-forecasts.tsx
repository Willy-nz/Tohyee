"use client";

import Link from "next/link";
import { useState } from "react";
import { amountIn, StageBadge, useBaseCurrency, useBusy, useTeam } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import type { Forecast, ForecastRow } from "@/lib/crm/forecast";
import { FORECAST_CATEGORY_LABELS, FORECAST_MEASURE_LABELS, FORECAST_MEASURES, type ForecastMeasure, type ForecastPeriodKind, inMeasure } from "@/lib/crm/forecast-figures";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";

/**
 * CRM › Forecasts (examples CRMS8-CRMS10), after Salesforce's Collaborative
 * Forecasts: by expected close month or quarter, per owner and currency,
 * the cumulative Closed, Commit, Best case and Open pipeline totals, the
 * weighted pipeline, quotas and attainment. Each figure opens the
 * opportunities it's made of. Read-only, except quotas for admins.
 */

type Drill = { periodStart: string; ownerUserId: string | null | "all"; currencyCode: string; measure: ForecastMeasure; title: string };

function QuotaForm({ organisationId, baseCurrency, onSaved }: { organisationId: string; baseCurrency: string; onSaved: () => void }) {
  const team = useTeam(organisationId);
  const [ownerUserId, setOwnerUserId] = useState("");
  const [month, setMonth] = useState(todayInBrowser().slice(0, 7));
  const [amount, setAmount] = useState("");
  const { busy, error, run } = useBusy();
  const save = (value: string | null) =>
    run(async () => {
      await api("/api/crm/forecasts/quotas", { method: "PUT", body: { organisationId, ownerUserId, month: `${month}-01`, amount: value } });
      setAmount("");
      onSaved();
    });
  return (
    <form
      style={{ display: "grid", gap: 8 }}
      onSubmit={(event) => {
        event.preventDefault();
        void save(amount);
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Owner">
          <select value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)} required>
            <option value="">Choose someone</option>
            {(team.data?.team ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Month">
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} required />
        </Field>
        <Field label={`Quota (${baseCurrency})`}>
          <input inputMode="decimal" className={ui.num} value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
      </div>
      <span className={ui.rowButtons}>
        <Button type="submit" size="small" disabled={busy || !ownerUserId || !month || !amount.trim()}>
          Set quota
        </Button>
        <Button size="small" variant="secondary" disabled={busy || !ownerUserId || !month} onClick={() => void save(null)}>
          Clear quota
        </Button>
      </span>
    </form>
  );
}

export function ForecastsPage({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const baseCurrency = useBaseCurrency();
  const team = useTeam(organisationId);
  const [period, setPeriod] = useState<ForecastPeriodKind>("month");
  const [from, setFrom] = useState(todayInBrowser());
  const [periods, setPeriods] = useState("3");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [drill, setDrill] = useState<Drill | null>(null);
  const data = useApiData<{ forecast: Forecast }>("/api/crm/forecasts", { organisationId, period, from, periods, ownerUserId });
  const f = data.data?.forecast;
  const money = (amount: string, currency: string) => amountIn(amount, currency, baseCurrency);
  const cell = (row: { periodStart: string; currencyCode: string } & Record<ForecastMeasure, string>, owner: string | null | "all", label: string, measure: ForecastMeasure) => (
    <td className={ui.num} key={measure}>
      <button
        type="button"
        className={ui.linkButton}
        onClick={() => setDrill({ periodStart: row.periodStart, ownerUserId: owner, currencyCode: row.currencyCode, measure, title: `${label}: ${FORECAST_MEASURE_LABELS[measure]}` })}
      >
        {money(row[measure], row.currencyCode)}
      </button>
    </td>
  );
  const drilled = drill && f
    ? f.opportunities.filter(
        (o) =>
          o.periodStart === drill.periodStart &&
          o.currencyCode === drill.currencyCode &&
          (drill.ownerUserId === "all" || o.ownerUserId === drill.ownerUserId) &&
          inMeasure(o, drill.measure),
      )
    : [];
  return (
    <>
      <Card
        title="Forecast"
        description="Opportunities by expected close date, amounts excluding GST. Totals are cumulative, as in Salesforce: Commit includes Closed, Best case includes Commit and Closed, and Open pipeline is open opportunities in Pipeline, Best case or Commit. Weighted is amount × probability. Omitted and lost opportunities count in none. Currencies are never added together."
      >
        <div className={ui.grid3}>
          <Field label="By">
            <select value={period} onChange={(event) => setPeriod(event.target.value as ForecastPeriodKind)}>
              <option value="month">Month</option>
              <option value="quarter">Quarter (of the financial year)</option>
            </select>
          </Field>
          <Field label="From">
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="Periods">
            <input inputMode="numeric" className={ui.num} value={periods} onChange={(event) => setPeriods(event.target.value)} />
          </Field>
          <Field label="Owner">
            <select value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)}>
              <option value="">Everyone</option>
              {(team.data?.team ?? []).map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName}
                </option>
              ))}
              <option value="none">No owner</option>
            </select>
          </Field>
        </div>
        {data.error ? <Notice tone="error">{data.error}</Notice> : null}
        {f && f.noCloseDate > 0 ? (
          <p className={ui.muted}>
            {f.noCloseDate} open {f.noCloseDate === 1 ? "opportunity has" : "opportunities have"} no expected close date, so {f.noCloseDate === 1 ? "isn't" : "aren't"} in the forecast.
          </p>
        ) : null}
      </Card>
      {!f ? (
        <p className={ui.muted}>Loading…</p>
      ) : (
        f.periods.map((p) => {
          const rows = f.rows.filter((r) => r.periodStart === p.start);
          const totals = f.totals.filter((t) => t.periodStart === p.start);
          return (
            <Card key={p.start} title={p.label}>
              {rows.length === 0 ? (
                <Empty>Nothing closing in {p.label}.</Empty>
              ) : (
                <div className={ui.tableWrap}>
                  <table className={ui.table}>
                    <thead>
                      <tr>
                        <th>Owner</th>
                        {FORECAST_MEASURES.map((measure) => (
                          <th key={measure} className={ui.num}>
                            {FORECAST_MEASURE_LABELS[measure]}
                          </th>
                        ))}
                        <th className={ui.num}>Quota</th>
                        <th className={ui.num}>Attainment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row: ForecastRow) => (
                        <tr key={`${row.ownerUserId}:${row.currencyCode}`}>
                          <td>
                            {row.ownerName}
                            {row.currencyCode === baseCurrency ? "" : ` (${row.currencyCode})`}
                          </td>
                          {FORECAST_MEASURES.map((measure) => cell(row, row.ownerUserId, `${row.ownerName}, ${p.label}`, measure))}
                          <td className={ui.num}>{row.quota === null ? "" : formatMoney(row.quota)}</td>
                          <td className={ui.num}>{row.attainment === null ? "" : `${row.attainment}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      {totals.map((total) => (
                        <tr key={total.currencyCode}>
                          <td>
                            <strong>Total{total.currencyCode === baseCurrency ? "" : ` (${total.currencyCode})`}</strong>
                          </td>
                          {FORECAST_MEASURES.map((measure) => cell(total, "all", `Everyone, ${p.label}`, measure))}
                          <td />
                          <td />
                        </tr>
                      ))}
                    </tfoot>
                  </table>
                </div>
              )}
            </Card>
          );
        })
      )}
      {drill ? (
        <Card
          title={drill.title}
          description={drill.currencyCode === baseCurrency ? undefined : `In ${drill.currencyCode}.`}
          actions={
            <Button size="small" variant="secondary" onClick={() => setDrill(null)}>
              Close
            </Button>
          }
        >
          {drilled.length === 0 ? (
            <Empty>No opportunities.</Empty>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Opportunity</th>
                    <th>Company</th>
                    <th>Stage</th>
                    <th>Forecast category</th>
                    <th className={ui.num}>Probability</th>
                    <th className={ui.num}>Amount</th>
                    <th className={ui.num}>Weighted</th>
                    <th>Expected close</th>
                  </tr>
                </thead>
                <tbody>
                  {drilled.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link href={`/crm/opportunities/${o.id}`}>{o.name}</Link>
                        </td>
                        <td>{o.contactName}</td>
                        <td>
                          <StageBadge name={o.stageName} type={o.stageType} />
                        </td>
                        <td>{FORECAST_CATEGORY_LABELS[o.forecastCategory]}</td>
                        <td className={ui.num}>{o.probability}%</td>
                        <td className={ui.num}>{money(o.amount, o.currencyCode)}</td>
                        <td className={ui.num}>{money(o.weightedAmount, o.currencyCode)}</td>
                        <td>{formatDate(o.closeDate)}</td>
                      </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
      {can("admin") ? (
        <Card title="Quotas" description={`Per owner per month, in ${baseCurrency}. A quarter's quota is its months' added. Attainment is Closed (${baseCurrency}) ÷ quota.`}>
          <QuotaForm organisationId={organisationId} baseCurrency={baseCurrency} onSaved={data.reload} />
        </Card>
      ) : null}
    </>
  );
}
