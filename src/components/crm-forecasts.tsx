"use client";

import Link from "next/link";
import { useState } from "react";
import { amountIn, StageBadge, useBaseCurrency, useBusy, useTeam } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import type { AdjustableMeasure, AdjustedRow, ForecastSnapshot, TeamForecast, TeamRow } from "@/lib/crm/forecast-teams";
import { FORECAST_CATEGORY_LABELS, FORECAST_MEASURE_LABELS, FORECAST_MEASURES, type ForecastMeasure, type ForecastPeriodKind, inMeasure } from "@/lib/crm/forecast-figures";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";

/**
 * CRM › Forecasts (examples CRMS8-CRMS10), after Salesforce's Collaborative
 * Forecasts: by expected close month or quarter, per owner and currency,
 * the cumulative Closed, Commit, Best case and Open pipeline totals, the
 * weighted pipeline, quotas and attainment. Each figure opens the
 * opportunities it's made of. Read-only, except quotas for admins.
 *
 * Team forecasts (decision 499): each sales team's figures added up, a
 * manager's adjustments to Commit and Best case (with a reason, shown next
 * to the deals' own figure), and submitted forecasts kept to compare.
 */

function AdjustForm({
  organisationId,
  row,
  period,
  onDone,
}: {
  organisationId: string;
  row: AdjustedRow;
  period: ForecastPeriodKind;
  onDone: (changed: boolean) => void;
}) {
  const [measure, setMeasure] = useState<AdjustableMeasure>("commit");
  const [amount, setAmount] = useState(row.adjusted.commit?.amount ?? "");
  const [reason, setReason] = useState("");
  const { busy, error, run } = useBusy();
  const save = (value: string | null) =>
    void run(async () => {
      await api("/api/crm/forecasts/adjustments", {
        method: "POST",
        body: { organisationId, ownerUserId: row.ownerUserId, period, periodStart: row.periodStart, currencyCode: row.currencyCode, measure, amount: value, reason: reason || null },
      });
      onDone(true);
    });
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Figure">
          <select
            value={measure}
            onChange={(event) => {
              const next = event.target.value as AdjustableMeasure;
              setMeasure(next);
              setAmount(row.adjusted[next]?.amount ?? "");
            }}
          >
            <option value="commit">Commit (deals: {formatMoney(row.commit)})</option>
            <option value="bestCase">Best case (deals: {formatMoney(row.bestCase)})</option>
          </select>
        </Field>
        <Field label={`Adjusted to (${row.currencyCode})`}>
          <input inputMode="decimal" className={ui.num} value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field label="Why">
          <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
      <span className={ui.rowButtons}>
        <Button size="small" disabled={busy || !amount.trim() || !reason.trim()} onClick={() => save(amount)}>
          Adjust
        </Button>
        {row.adjusted[measure] ? (
          <Button size="small" variant="secondary" disabled={busy} onClick={() => save(null)}>
            Clear adjustment
          </Button>
        ) : null}
        <Button size="small" variant="secondary" disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

function Snapshots({ organisationId, period, periodStart, rows, teams }: { organisationId: string; period: ForecastPeriodKind; periodStart: string; rows: AdjustedRow[]; teams: TeamRow[] }) {
  const { user, canCrm } = useWorkspace();
  const data = useApiData<{ snapshots: ForecastSnapshot[] }>("/api/crm/forecasts/snapshots", { organisationId, period, periodStart });
  const [note, setNote] = useState("");
  const { busy, error, run } = useBusy();
  const mine = rows.some((row) => row.ownerUserId === user.id);
  const myTeams = [...new Map(teams.filter((team) => team.managerUserId === user.id || canCrm("admin")).map((team) => [team.teamId, team.teamName])).entries()];
  const submit = (body: Record<string, unknown>) =>
    void run(async () => {
      await api("/api/crm/forecasts/snapshots", { method: "POST", body: { organisationId, period, periodStart, note: note || null, ...body } });
      setNote("");
      data.reload();
    });
  const snapshots = data.data?.snapshots ?? [];
  if (!canCrm("write") && snapshots.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
      <strong>Submitted</strong>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {snapshots.length === 0 ? <span className={ui.muted}>Nothing submitted for this period yet.</span> : null}
      {snapshots.map((snapshot) => (
        <div key={snapshot.id} className={ui.muted}>
          {snapshot.name}, {formatDate(snapshot.submittedAt.slice(0, 10))} by {snapshot.submittedByEmail ?? "someone"}:{" "}
          {snapshot.figures.length === 0
            ? "nothing closing"
            : snapshot.figures
                .map(
                  (figure) =>
                    `${figure.currencyCode} Closed ${formatMoney(figure.closed)}, Commit ${formatMoney(figure.adjustedCommit)}${figure.adjustedCommit !== figure.commit ? ` (deals ${formatMoney(figure.commit)})` : ""}, Best case ${formatMoney(figure.adjustedBestCase)}`,
                )
                .join("; ")}
          {snapshot.note ? ` · “${snapshot.note}”` : ""}
        </div>
      ))}
      {canCrm("write") && (mine || myTeams.length > 0 || canCrm("admin")) ? (
        <span className={ui.rowButtons}>
          <input aria-label="Note" placeholder="Note (optional)" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
          {mine ? (
            <Button size="small" variant="secondary" disabled={busy} onClick={() => submit({ ownerUserId: user.id })}>
              Submit mine
            </Button>
          ) : null}
          {myTeams.map(([teamId, teamName]) => (
            <Button key={teamId} size="small" variant="secondary" disabled={busy} onClick={() => submit({ teamId })}>
              Submit {teamName}
            </Button>
          ))}
          {canCrm("admin") ? (
            <Button size="small" variant="secondary" disabled={busy} onClick={() => submit({})}>
              Submit everyone&apos;s
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

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
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const data = useApiData<{ forecast: TeamForecast }>("/api/crm/forecasts", { organisationId, period, from, periods, ownerUserId });
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
          const teams = f.teams.filter((t) => t.periodStart === p.start);
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
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row: AdjustedRow) => {
                        const rowKey = `${p.start}:${row.ownerUserId}:${row.currencyCode}`;
                        const adjustedNote = (["commit", "bestCase"] as const)
                          .filter((measure) => row.adjusted[measure])
                          .map((measure) => `${FORECAST_MEASURE_LABELS[measure]} adjusted to ${formatMoney(row.adjusted[measure]!.amount)} by ${row.adjusted[measure]!.byEmail ?? "someone"}: ${row.adjusted[measure]!.reason}`)
                          .join(" · ");
                        return [
                          <tr key={rowKey}>
                            <td>
                              {row.ownerName}
                              {row.currencyCode === baseCurrency ? "" : ` (${row.currencyCode})`}
                              {adjustedNote ? <div className={ui.muted}>{adjustedNote}</div> : null}
                            </td>
                            {FORECAST_MEASURES.map((measure) => cell(row, row.ownerUserId, `${row.ownerName}, ${p.label}`, measure))}
                            <td className={ui.num}>{row.quota === null ? "" : formatMoney(row.quota)}</td>
                            <td className={ui.num}>{row.attainment === null ? "" : `${row.attainment}%`}</td>
                            <td>
                              {row.canAdjust && adjusting !== rowKey ? (
                                <Button size="small" variant="secondary" onClick={() => setAdjusting(rowKey)}>
                                  Adjust
                                </Button>
                              ) : null}
                            </td>
                          </tr>,
                          adjusting === rowKey ? (
                            <tr key={`${rowKey}:adjust`}>
                              <td colSpan={FORECAST_MEASURES.length + 4}>
                                <AdjustForm
                                  organisationId={organisationId}
                                  row={row}
                                  period={f.period}
                                  onDone={(changed) => {
                                    setAdjusting(null);
                                    if (changed) data.reload();
                                  }}
                                />
                              </td>
                            </tr>
                          ) : null,
                        ];
                      })}
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
                          <td />
                        </tr>
                      ))}
                    </tfoot>
                  </table>
                </div>
              )}
              {teams.length > 0 ? (
                <div className={ui.tableWrap} style={{ marginTop: 12 }}>
                  <table className={ui.table}>
                    <thead>
                      <tr>
                        <th>Team</th>
                        <th className={ui.num}>Closed</th>
                        <th className={ui.num}>Commit</th>
                        <th className={ui.num}>Best case</th>
                        <th className={ui.num}>Open pipeline</th>
                        <th className={ui.num}>Weighted</th>
                        <th className={ui.num}>Quota</th>
                        <th className={ui.num}>Attainment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {teams.map((team) => (
                        <tr key={`${team.teamId}:${team.currencyCode}`}>
                          <td>
                            {team.teamName}
                            {team.currencyCode === baseCurrency ? "" : ` (${team.currencyCode})`}
                          </td>
                          <td className={ui.num}>{money(team.closed, team.currencyCode)}</td>
                          <td className={ui.num} title={team.adjustedCommit !== team.commit ? `Deals: ${team.commit}` : undefined}>
                            {money(team.adjustedCommit, team.currencyCode)}
                          </td>
                          <td className={ui.num} title={team.adjustedBestCase !== team.bestCase ? `Deals: ${team.bestCase}` : undefined}>
                            {money(team.adjustedBestCase, team.currencyCode)}
                          </td>
                          <td className={ui.num}>{money(team.pipeline, team.currencyCode)}</td>
                          <td className={ui.num}>{money(team.weighted, team.currencyCode)}</td>
                          <td className={ui.num}>{team.quota === null ? "" : formatMoney(team.quota)}</td>
                          <td className={ui.num}>{team.attainment === null ? "" : `${team.attainment}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className={ui.muted}>A team is its members and its manager. Commit and Best case include managers&apos; adjustments.</p>
                </div>
              ) : null}
              <Snapshots organisationId={organisationId} period={f.period} periodStart={p.start} rows={rows} teams={teams} />
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
