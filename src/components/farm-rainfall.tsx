"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DateInput } from "@/components/date-input";
import { type MapOverlay, PaddockMap } from "@/components/farming";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { QueuedWork, submitThroughQueue, useOfflineQueue } from "@/components/offline-queue";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { addDays, shortDate } from "@/lib/farming/farm-words";
import type { Position } from "@/lib/farming/geometry";
import type { Farm, FarmingSettings, Paddock } from "@/lib/farming/paddocks";
import type { RainGauge, RainImportPreview, RainReading, RainfallSummary } from "@/lib/farming/rainfall";
import type { RecentWeather } from "@/lib/farming/weather-history";
import { comparedText, latestRainDay, mmText, type Period, rainDayFor, readDayFor, tryMm } from "@/lib/farming/rainfall-rules";
import { formatDateTime, todayInBrowser } from "@/lib/format";
import { newOperationId } from "@/lib/offline/queue";
import styles from "./farm-workspace.module.css";

/*
 * Rainfall (decisions 1451-1456): the Log's quick "Rain gauge" entry, kept
 * on the phone first and sent through the device's one queue (so it works
 * with no signal and is kept once), and Farm › More › Rainfall with the
 * gauges, the history by month and season beside last year's, each day's
 * readings to change or backdate, and importing a file. Daily rain and
 * temperature from kept MetService forecasts sit above them (FW4).
 */

export const RAIN_KIND = "farm.rainfall";

export function useRainGauges(organisationId: string, farmId: string, includeRetired = false) {
  return useApiData<{ gauges: RainGauge[] }>(`/api/farming/farms/${farmId}/rain-gauges`, { organisationId, ...(includeRetired ? { retired: "1" } : {}) });
}

/** Gauges with a place, as dots on the farm map ("R"), for the Map tab. */
export function gaugeOverlays(gauges: RainGauge[], onSelect?: (id: string) => void): MapOverlay[] {
  return gauges
    .filter((gauge) => gauge.isActive && gauge.point)
    .map((gauge) => ({
      id: `gauge-${gauge.id}`,
      label: `Rain gauge ${gauge.name}${gauge.last ? `: ${mmText(gauge.last.mm)} on ${gauge.last.readOn}` : ""}`,
      tone: "effluent" as const,
      marker: "dot" as const,
      short: "R",
      point: gauge.point,
      onSelect: onSelect ? () => onSelect(gauge.id) : undefined,
    }));
}

function outcomeText(state: string) {
  return state === "synced" ? "Saved." : state === "waiting" ? "Saved on this device. It goes by itself when Tohyee can be reached." : "This device's storage wouldn't keep it. Keep Tohyee open until it shows Synced.";
}

// The Log's quick entry ------------------------------------------------------------------------------------

/** The Log's rain gauge reading: gauge, day and mm on one screen, big enough for a wet thumb. */
export function LogRainfall({ organisationId, farm, onClose }: { organisationId: string; farm: Farm; onClose: () => void }) {
  const today = todayInBrowser();
  const gauges = useRainGauges(organisationId, farm.id);
  const { queue } = useOfflineQueue(organisationId);
  const active = (gauges.data?.gauges ?? []).filter((gauge) => gauge.isActive);
  const [gaugeId, setGaugeId] = useState<string | null>(null);
  // The morning the gauge was read; the reading is for the day before (decision 1452).
  const [readDay, setReadDay] = useState(today);
  const readOn = rainDayFor(readDay);
  const [mm, setMm] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // One operation id per reading, kept if a save is tried again, so it's never kept twice.
  const operation = useRef<string | null>(null);
  const chosen = active.find((gauge) => gauge.id === gaugeId) ?? (active.length === 1 ? active[0] : null);
  const value = tryMm(mm);
  const save = async (figure: string) => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      operation.current ??= newOperationId();
      const outcome = await submitThroughQueue(queue, {
        operationId: operation.current,
        kind: RAIN_KIND,
        label: `Rain, ${chosen.name}: ${mmText(figure)} on ${shortDate(readOn, today)}`,
        farmId: farm.id,
        farmName: farm.name,
        request: { method: "POST", path: `/api/farming/farms/${farm.id}/rainfall`, body: { gaugeId: chosen.id, readOn, mm: figure, note: note.trim() || null } },
      });
      operation.current = null;
      setDone(outcomeText(outcome.state));
      setMm("");
      setNote("");
    } catch (caught) {
      // Refused: this id is let go, so a fixed reading is a new one.
      operation.current = null;
      setError(`Not saved: ${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.grid}>
      <Card
        title="Rain gauge"
        description={
          <>
            Read the gauge, then empty it.{" "}
            <InfoTip label="About rain readings">
              Read the gauge at 9 am: it holds the rain to 9 am, and is recorded for the day before, like official rainfall records. Read on Tuesday morning, it&apos;s Monday&apos;s rain. Type 0 on a dry day: a day with no reading counts as unknown, not dry. Change or backdate a reading under Rainfall.
            </InfoTip>
          </>
        }
        actions={
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      >
        {gauges.error ? <Notice tone="error">{gauges.error}</Notice> : null}
        {!gauges.data && !gauges.error ? <p className={ui.muted}>Loading…</p> : null}
        {gauges.data && !active.length ? (
          <Empty>
            No rain gauges on {farm.name} yet. <Link href={`/operations/farming/rainfall?farm=${farm.id}`}>Add a gauge under Rainfall</Link>.
          </Empty>
        ) : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {active.length ? (
          <form
            style={{ display: "grid", gap: 16 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (value !== null) void save(value);
            }}
          >
            {active.length > 1 ? (
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className={ui.muted}>Which gauge</legend>
                <div className={styles.bigButtons}>
                  {active.map((gauge) => (
                    <button key={gauge.id} type="button" className={styles.bigButton} aria-pressed={chosen?.id === gauge.id} style={chosen?.id === gauge.id ? { borderColor: "var(--accent)", boxShadow: "inset 0 0 0 2px var(--accent)" } : undefined} onClick={() => setGaugeId(gauge.id)}>
                      {gauge.name}
                      <small>{gauge.last ? `Last: ${mmText(gauge.last.mm)}, ${shortDate(gauge.last.readOn, today)}` : "No readings yet"}</small>
                    </button>
                  ))}
                </div>
              </fieldset>
            ) : (
              <p style={{ margin: 0 }}>
                <strong>{chosen?.name}</strong>
                {chosen?.last ? <span className={ui.muted}> · last {mmText(chosen.last.mm)}, {shortDate(chosen.last.readOn, today)}</span> : null}
              </p>
            )}
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className={ui.muted}>When you read the gauge</legend>
              <div className={styles.bigButtons}>
                {[
                  { value: today, label: "This morning" },
                  { value: addDays(today, -1), label: "Yesterday morning" },
                ].map((option) => (
                  <button key={option.value} type="button" className={styles.bigButton} aria-pressed={readDay === option.value} style={readDay === option.value ? { borderColor: "var(--accent)", boxShadow: "inset 0 0 0 2px var(--accent)" } : undefined} onClick={() => setReadDay(option.value)}>
                    {option.label}
                    <small>{shortDate(option.value, today)}</small>
                  </button>
                ))}
              </div>
              <label style={{ display: "grid", gap: 4, marginTop: 8 }}>
                <span className={ui.muted}>Another morning</span>
                <DateInput value={readDay} max={today} onChange={(event) => setReadDay(event.target.value || today)} />
              </label>
              <p role="status" style={{ margin: "8px 0 0", fontWeight: 600 }}>
                Rain to 9 am {readDay === today ? "today" : shortDate(readDay, today)}, recorded for {new Date(`${readOn}T00:00:00Z`).toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" })}.
              </p>
            </fieldset>
            <label style={{ display: "grid", gap: 6 }}>
              <span className={ui.muted}>Rain in the gauge</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input inputMode="decimal" autoComplete="off" value={mm} onChange={(event) => setMm(event.target.value)} aria-invalid={mm !== "" && value === null} style={{ fontSize: 32, minHeight: 64, width: "7ch", textAlign: "right" }} />
                <span>mm</span>
              </span>
              {mm !== "" && value === null ? <span className={ui.muted}>Type millimetres from 0 to 2,000, like 12 or 4.5.</span> : null}
            </label>
            <Field label="Note (optional)">
              <input value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} />
            </Field>
            <div className={styles.actions}>
              <Button type="submit" disabled={busy || value === null || !chosen}>
                Save {value !== null ? `${mmText(value)} for ${shortDate(readOn, today)}` : ""}
              </Button>
              <Button variant="secondary" disabled={busy || !chosen} onClick={() => void save("0.0")}>
                No rain (0 mm)
              </Button>
            </div>
            {!chosen ? <p className={ui.muted}>Choose the gauge first.</p> : null}
          </form>
        ) : null}
        <p>
          <Link href={`/operations/farming/rainfall?farm=${farm.id}`}>Rainfall history and gauges</Link>
        </p>
      </Card>
      <QueuedWork organisationId={organisationId} farmId={farm.id} kinds={[RAIN_KIND]} title="Rain readings on this device" onSynced={gauges.reload} />
    </div>
  );
}

// The Rainfall page -----------------------------------------------------------------------------------------

export function FarmRainfall({ organisationId, farm }: FarmContext) {
  const { can, current } = useWorkspace();
  const canRecord = current?.role === "farm_worker" || can("bookkeeper");
  const gauges = useRainGauges(organisationId, farm.id, true);
  const all = gauges.data?.gauges ?? [];
  const active = all.filter((gauge) => gauge.isActive);
  const [picked, setPicked] = useState<string | null>(null);
  // The gauge with the most readings first: usually the farm's main one.
  const gauge = all.find((entry) => entry.id === picked) ?? [...active].sort((a, b) => b.readings - a.readings)[0] ?? null;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {gauges.error ? <Notice tone="error">{gauges.error}</Notice> : null}
      {gauges.data && !all.length ? <Empty>No rain gauges on {farm.name} yet.{canRecord ? " Add one below." : ""}</Empty> : null}
      {all.length > 1 ? (
        <div className={ui.tabs} role="group" aria-label="Rain gauge">
          {all
            .filter((entry) => entry.isActive || entry.id === gauge?.id)
            .map((entry) => (
              <button key={entry.id} type="button" aria-pressed={entry.id === gauge?.id} className={`${ui.tab} ${entry.id === gauge?.id ? ui.tabActive : ""}`} onClick={() => setPicked(entry.id)}>
                {entry.name}
              </button>
            ))}
        </div>
      ) : null}
      <DailyWeather organisationId={organisationId} farmId={farm.id} />
      {gauge ? <RainHistory key={gauge.id} organisationId={organisationId} gauge={gauge} /> : null}
      {gauge ? <RainReadings key={`r${gauge.id}`} organisationId={organisationId} farm={farm} gauge={gauge} canRecord={canRecord} canRemove={can("bookkeeper")} onChanged={gauges.reload} /> : null}
      {canRecord ? (
        <Link className={styles.bigButton} href="/operations/farm/log?record=rain">
          Record today&apos;s rain
          <small>On the Log, works with no signal</small>
        </Link>
      ) : null}
      {gauges.data ? <RainGauges organisationId={organisationId} farm={farm} gauges={all} canRecord={canRecord} onChanged={gauges.reload} onPick={setPicked} /> : null}
      {gauge && can("bookkeeper") && gauge.isActive ? <ImportRain organisationId={organisationId} gauge={gauge} onImported={gauges.reload} /> : null}
    </div>
  );
}

type View = "months" | "seasons";

function RainHistory({ organisationId, gauge }: { organisationId: string; gauge: RainGauge }) {
  const today = todayInBrowser();
  const summary = useApiData<{ summary: RainfallSummary }>(`/api/farming/rain-gauges/${gauge.id}/summary`, { organisationId, onDate: today, n: gauge.readings });
  const [view, setView] = useState<View>("months");
  const data = summary.data?.summary;
  const periods = data ? (view === "months" ? data.months : data.seasons) : [];
  return (
    <Card
      title={`Rainfall: ${gauge.name}`}
      description={
        <>
          Totals from this gauge&apos;s readings, beside the same time last year.{" "}
          <InfoTip label="How totals work">
            A total adds the days with a reading, and says how many days have one. A day with no reading isn&apos;t counted as dry. A month or season still going is compared with the same days last year. Seasons: spring is September to November, summer December to February, autumn March to May, winter June to August.
          </InfoTip>
        </>
      }
    >
      {summary.error ? <Notice tone="error">{summary.error}</Notice> : null}
      {!data && !summary.error ? <p className={ui.muted}>Loading…</p> : null}
      {data ? (
        <>
          <div className={styles.tiles} style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            {[data.totals.thisMonth, data.totals.thisSeason, data.totals.last12Months].map((entry) => (
              <div key={entry.key} style={{ display: "grid", gap: 2, padding: 12, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)" }}>
                <span className={ui.muted}>{entry.label}</span>
                <strong style={{ fontSize: "var(--text-xl, 20px)" }}>{mmText(entry.current.mm)}</strong>
                <span className={ui.muted}>
                  {entry.current.daysRead} of {entry.current.days} days read
                </span>
                <span className={ui.muted}>Last year {mmText(entry.lastYear.mm)}</span>
              </div>
            ))}
          </div>
          <div className={ui.tabs} role="group" aria-label="Show rainfall by">
            {(["months", "seasons"] as const).map((entry) => (
              <button key={entry} type="button" aria-pressed={view === entry} className={`${ui.tab} ${view === entry ? ui.tabActive : ""}`} onClick={() => setView(entry)}>
                By {entry === "months" ? "month" : "season"}
              </button>
            ))}
          </div>
          <RainChart periods={periods} label={`Rainfall at ${gauge.name} by ${view === "months" ? "month" : "season"}, this year and last year`} />
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <caption className={styles.hiddenLabel}>Rainfall by {view === "months" ? "month" : "season"}</caption>
              <thead>
                <tr>
                  <th scope="col">{view === "months" ? "Month" : "Season"}</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Rain
                  </th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Last year
                  </th>
                  <th scope="col">Days read</th>
                </tr>
              </thead>
              <tbody>
                {[...periods].reverse().map((entry) => (
                  <tr key={entry.key}>
                    <td>
                      {entry.label}
                      {entry.toDate ? <span className={ui.muted}> (so far)</span> : null}
                    </td>
                    <td style={{ textAlign: "right" }}>{entry.current.mm === null ? "–" : mmText(entry.current.mm)}</td>
                    <td style={{ textAlign: "right" }}>{entry.lastYear.mm === null ? "–" : mmText(entry.lastYear.mm)}</td>
                    <td>
                      {entry.current.daysRead} of {entry.current.days}
                      {comparedText(entry) ? <span className={ui.muted}> · {comparedText(entry)}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.firstReadOn ? <p className={ui.muted}>Readings from {shortDate(data.firstReadOn, today)}. Earlier rain isn&apos;t kept here; import a file to add it.</p> : null}
        </>
      ) : null}
    </Card>
  );
}

/** Columns for this year and thinner, muted ones for last year, a pair a period. The table below has the same figures. */
export function RainChart({ periods, label }: { periods: Period[]; label: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(280, Math.round(entries[0].contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const height = 200;
  const pad = { top: 24, right: 8, bottom: 26, left: 44 };
  const values = periods.flatMap((entry) => [Number(entry.current.mm ?? 0), Number(entry.lastYear.mm ?? 0)]);
  const max = Math.max(10, ...values);
  const step = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((candidate) => max / candidate <= 4) ?? 1000;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, index) => index * step);
  const plotWidth = width - pad.left - pad.right;
  const slot = plotWidth / Math.max(1, periods.length);
  const bar = Math.max(3, Math.min(18, slot * 0.34));
  const y = (value: number) => pad.top + ((top - value) * (height - pad.top - pad.bottom)) / top;
  const every = Math.max(1, Math.ceil(periods.length / Math.max(2, Math.floor(plotWidth / 48))));
  const shown = hover === null ? null : periods[hover];
  return (
    <div ref={frame} style={{ position: "relative", margin: "12px 0" }}>
      <ul className={styles.legend} aria-hidden="true">
        <li>
          <span className={styles.swatch} style={{ background: "var(--chart-1)" }} />
          This year
        </li>
        <li>
          <span className={styles.swatch} style={{ background: "var(--chart-muted)" }} />
          Same time last year
        </li>
      </ul>
      <svg width={width} height={height} role="img" aria-label={`${label}. The table below has the figures.`} style={{ display: "block", maxWidth: "100%" }} onMouseLeave={() => setHover(null)}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} />
            <text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" fontSize={11} fill="var(--chart-text-muted)">
              {tick}
            </text>
          </g>
        ))}
        <text x={pad.left - 6} y={11} textAnchor="end" fontSize={11} fill="var(--chart-text-muted)">
          mm
        </text>
        {periods.map((entry, index) => {
          const x = pad.left + slot * index + slot / 2;
          const now = Number(entry.current.mm ?? 0);
          const before = Number(entry.lastYear.mm ?? 0);
          const short = entry.label.replace(/ \d{4}(-\d{2})?$/, "");
          return (
            <g key={entry.key} onMouseEnter={() => setHover(index)} onFocus={() => setHover(index)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${entry.label}: ${mmText(entry.current.mm)}, last year ${mmText(entry.lastYear.mm)}`}>
              <rect x={pad.left + slot * index} y={pad.top} width={slot} height={height - pad.top - pad.bottom} fill={hover === index ? "var(--chart-hover)" : "transparent"} />
              {entry.lastYear.mm !== null ? <rect x={x + 1} y={y(before)} width={bar * 0.75} height={Math.max(0, y(0) - y(before))} rx={2} fill="var(--chart-muted)" /> : null}
              {entry.current.mm !== null ? <rect x={x - bar - 1} y={y(now)} width={bar} height={Math.max(0, y(0) - y(now))} rx={2} fill="var(--chart-1)" /> : null}
              {index % every === 0 ? (
                <text x={x} y={height - 8} textAnchor="middle" fontSize={11} fill="var(--chart-text-muted)">
                  {short}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {shown ? (
        <div role="status" className={ui.muted} style={{ position: "absolute", top: 24, right: 8, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 8px", fontSize: 12 }}>
          <strong>{shown.label}</strong>: {mmText(shown.current.mm)} · last year {mmText(shown.lastYear.mm)}
        </div>
      ) : null}
    </div>
  );
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function monthEnd(start: string): string {
  const [y, m] = start.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function shiftMonth(start: string, by: number): string {
  const [y, m] = start.split("-").map(Number);
  const index = y * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

/** A month of a gauge's readings, newest first, each changeable (date, mm, note), with who and when. */
function RainReadings({ organisationId, farm, gauge, canRecord, canRemove, onChanged }: { organisationId: string; farm: Farm; gauge: RainGauge; canRecord: boolean; canRemove: boolean; onChanged: () => void }) {
  const today = todayInBrowser();
  const [month, setMonth] = useState(monthStart(today));
  const readings = useApiData<{ readings: RainReading[] }>(`/api/farming/farms/${farm.id}/rainfall`, { organisationId, gaugeId: gauge.id, from: month, to: monthEnd(month) });
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const label = new Date(`${month}T00:00:00Z`).toLocaleDateString("en-NZ", { month: "long", year: "numeric", timeZone: "UTC" });
  const changed = () => {
    readings.reload();
    onChanged();
  };
  return (
    <Card
      title="Readings"
      description="Each day is the rain to 9 am the next morning."
      actions={
        canRecord && gauge.isActive ? (
          <Button variant="secondary" onClick={() => setAdding(!adding)} aria-expanded={adding}>
            {adding ? "Cancel" : "Add a past reading"}
          </Button>
        ) : null
      }
    >
      {adding ? (
        <ReadingForm
          organisationId={organisationId}
          path={`/api/farming/farms/${farm.id}/rainfall`}
          method="POST"
          extra={{ gaugeId: gauge.id }}
          initial={{ readOn: latestRainDay(today), mm: "", note: "" }}
          onDone={() => {
            setAdding(false);
            changed();
          }}
        />
      ) : null}
      <div className={styles.actions} style={{ alignItems: "center" }}>
        <Button variant="secondary" aria-label="Month before" onClick={() => setMonth(shiftMonth(month, -1))}>
          ‹
        </Button>
        <strong aria-live="polite">{label}</strong>
        <Button variant="secondary" aria-label="Month after" disabled={month >= monthStart(today)} onClick={() => setMonth(shiftMonth(month, 1))}>
          ›
        </Button>
      </div>
      {readings.error ? <Notice tone="error">{readings.error}</Notice> : null}
      {readings.data && !readings.data.readings.length ? <p className={ui.muted}>No readings in {label}.</p> : null}
      {readings.data?.readings.length ? (
        <ul className={styles.links}>
          {readings.data.readings.map((reading) => (
            <li key={reading.id} style={{ display: "grid", gap: 4, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
                <span>
                  <strong>{shortDate(reading.readOn, today)}</strong> · {mmText(reading.mm)}
                  {reading.note ? <span className={ui.muted}> · {reading.note}</span> : null}
                </span>
                {canRecord ? (
                  <button type="button" className={ui.linkButton} aria-expanded={editing === reading.id} onClick={() => setEditing(editing === reading.id ? null : reading.id)}>
                    {editing === reading.id ? "Cancel" : `Change ${shortDate(reading.readOn, today)}`}
                  </button>
                ) : null}
              </span>
              <span className={ui.muted} style={{ fontSize: 12 }}>
                {reading.source === "Typed" ? "By" : `${reading.source}, by`} {reading.createdByName ?? reading.createdByEmail}
                {reading.updatedAt ? `; changed by ${reading.updatedByName ?? reading.updatedByEmail} ${formatDateTime(reading.updatedAt)}` : ""}
              </span>
              {editing === reading.id ? (
                <ReadingForm
                  organisationId={organisationId}
                  path={`/api/farming/rainfall/${reading.id}`}
                  method="PATCH"
                  initial={{ readOn: reading.readOn, mm: reading.mm, note: reading.note ?? "" }}
                  onRemove={canRemove ? `/api/farming/rainfall/${reading.id}` : undefined}
                  onDone={() => {
                    setEditing(null);
                    changed();
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function ReadingForm({ organisationId, path, method, extra = {}, initial, onRemove, onDone }: { organisationId: string; path: string; method: "POST" | "PATCH"; extra?: Record<string, unknown>; initial: { readOn: string; mm: string; note: string }; onRemove?: string; onDone: () => void }) {
  const today = todayInBrowser();
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const value = tryMm(form.mm);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={ui.inlineForm}
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => api(path, { method, body: { organisationId, ...extra, readOn: form.readOn, mm: form.mm, note: form.note.trim() || null } }));
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Rain day" hint={form.readOn ? `Read the morning of ${shortDate(readDayFor(form.readOn), today)}` : "The day before the gauge was read"}>
        <DateInput value={form.readOn} max={latestRainDay(today)} onChange={(event) => setForm({ ...form, readOn: event.target.value })} required />
      </Field>
      <Field label="Rain (mm)">
        <input inputMode="decimal" value={form.mm} onChange={(event) => setForm({ ...form, mm: event.target.value })} required style={{ width: "8ch" }} />
      </Field>
      <Field label="Note">
        <input value={form.note} maxLength={200} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
      <Button type="submit" disabled={busy || value === null || !form.readOn}>
        Save
      </Button>
      {onRemove ? (
        confirming ? (
          <>
            <span>Remove this reading? It&apos;s kept in the history.</span>
            <Button variant="danger" disabled={busy} onClick={() => void run(() => api(onRemove, { method: "DELETE", query: { organisationId } }))}>
              Remove
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Remove…
          </Button>
        )
      ) : null}
    </form>
  );
}

function useMapBits(organisationId: string, farmId: string) {
  const shapes = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farmId}/paddocks`, { organisationId });
  const imageryKey = useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId }).data?.settings.imageryKey ?? null;
  return { paddocks: (shapes.data?.paddocks ?? []).filter((paddock) => paddock.status === "active"), loaded: Boolean(shapes.data), imageryKey };
}

/** The farm's gauges: add, rename, note, place on the map (tap), retire or bring back. */
function RainGauges({ organisationId, farm, gauges, canRecord, onChanged, onPick }: { organisationId: string; farm: Farm; gauges: RainGauge[]; canRecord: boolean; onChanged: () => void; onPick: (id: string) => void }) {
  const [editing, setEditing] = useState<string | "new" | null>(gauges.length ? null : "new");
  const today = todayInBrowser();
  return (
    <Card
      title="Gauges"
      description="Each gauge has its own readings. Placing it on the map is optional."
      actions={
        canRecord && editing !== "new" ? (
          <Button variant="secondary" onClick={() => setEditing("new")}>
            Add a gauge
          </Button>
        ) : null
      }
    >
      {editing === "new" ? <GaugeForm organisationId={organisationId} farm={farm} gauge={null} onClose={() => setEditing(null)} onSaved={onChanged} /> : null}
      {gauges.length ? (
        <ul className={styles.links}>
          {gauges.map((gauge) => (
            <li key={gauge.id} style={{ display: "grid", gap: 4, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
                <span>
                  <button type="button" className={ui.linkButton} onClick={() => onPick(gauge.id)}>
                    <strong>{gauge.name}</strong>
                  </button>{" "}
                  {gauge.isActive ? null : <Badge>Retired</Badge>} <span className={ui.muted}>· {gauge.readings} reading{gauge.readings === 1 ? "" : "s"}{gauge.last ? `, last ${shortDate(gauge.last.readOn, today)}` : ""} · {gauge.point ? "on the map" : "not on the map"}</span>
                </span>
                {canRecord ? (
                  <button type="button" className={ui.linkButton} aria-expanded={editing === gauge.id} onClick={() => setEditing(editing === gauge.id ? null : gauge.id)}>
                    {editing === gauge.id ? "Cancel" : `Change ${gauge.name}`}
                  </button>
                ) : null}
              </span>
              {gauge.note ? <span className={ui.muted}>{gauge.note}</span> : null}
              {editing === gauge.id ? <GaugeForm organisationId={organisationId} farm={farm} gauge={gauge} onClose={() => setEditing(null)} onSaved={onChanged} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function GaugeForm({ organisationId, farm, gauge, onClose, onSaved }: { organisationId: string; farm: Farm; gauge: RainGauge | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(gauge?.name ?? "");
  const [note, setNote] = useState(gauge?.note ?? "");
  const [point, setPoint] = useState<Position | null>(gauge?.point ?? null);
  const [placing, setPlacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const map = useMapBits(organisationId, farm.id);
  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      if (gauge) await api(`/api/farming/rain-gauges/${gauge.id}`, { method: "PATCH", body: { organisationId, ...body } });
      else await api(`/api/farming/farms/${farm.id}/rain-gauges`, { method: "POST", body: { organisationId, ...body } });
      onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      style={{ display: "grid", gap: 12 }}
      onSubmit={(event) => {
        event.preventDefault();
        void save({ name, note: note.trim() || null, point });
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Name">
          <input value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} placeholder="Cowshed" />
        </Field>
        <Field label="Note">
          <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" aria-expanded={placing} onClick={() => setPlacing(!placing)}>
          {placing ? "Done placing" : point ? "Move on the map" : "Place on the map"}
        </Button>
        {point ? (
          <Button variant="secondary" onClick={() => setPoint(null)}>
            Take off the map
          </Button>
        ) : null}
      </div>
      {placing ? (
        map.loaded ? (
          <>
            <p className={ui.muted}>Tap the map where the gauge is.</p>
            <PaddockMap paddocks={map.paddocks} selected={null} imageryKey={map.imageryKey} drawing={point ? [point] : []} onMapTap={(position) => setPoint([Math.round(position[0] * 1e6) / 1e6, Math.round(position[1] * 1e6) / 1e6])} label="Map of the paddocks: tap to place the rain gauge" />
          </>
        ) : (
          <p className={ui.muted}>Loading the map…</p>
        )
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" disabled={busy || !name.trim()}>
          {gauge ? "Save" : "Add gauge"}
        </Button>
        {gauge ? (
          <Button variant="secondary" disabled={busy} onClick={() => void save({ isActive: !gauge.isActive })}>
            {gauge.isActive ? "Retire gauge" : "Bring gauge back"}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {gauge?.isActive ? <p className={ui.muted}>A retired gauge keeps its readings and history, and takes no new ones.</p> : null}
    </form>
  );
}

/** Importing a gauge's readings from a CSV or Excel file: preview first, then import the rows without errors (RF7). */
function ImportRain({ organisationId, gauge, onImported }: { organisationId: string; gauge: RainGauge; onImported: () => void }) {
  const [file, setFile] = useState<{ name: string; content?: string; contentBase64?: string } | null>(null);
  const [preview, setPreview] = useState<RainImportPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(0);
  const path = `/api/farming/rain-gauges/${gauge.id}/import`;
  const send = async (extra: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      return await api<{ preview?: RainImportPreview; imported?: number; skipped?: number }>(path, { method: "POST", body: { organisationId, fileName: file?.name, content: file?.content, contentBase64: file?.contentBase64, ...extra } });
    } catch (caught) {
      setError(errorMessage(caught));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const pick = async (picked: File | undefined) => {
    setPreview(null);
    setDone(null);
    if (!picked) return setFile(null);
    if (/\.xlsx$/i.test(picked.name)) {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      setFile({ name: picked.name, contentBase64: btoa(binary) });
    } else setFile({ name: picked.name, content: await picked.text() });
  };
  const column = (key: "date" | "mm", label: string) => (
    <Field label={label}>
      <select
        value={preview?.columns[key] ?? ""}
        onChange={async (event) => {
          if (!preview) return;
          const result = await send({ preview: true, columns: { ...preview.columns, [key]: event.target.value === "" ? null : Number(event.target.value) } });
          if (result?.preview) setPreview(result.preview);
        }}
      >
        <option value="">None</option>
        {preview?.headings.map((heading, index) => (
          <option key={index} value={index}>
            {heading || `Column ${index + 1}`}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <Card title={`Import readings for ${gauge.name}`}>
      <details>
        <summary className={ui.linkButton}>Import a file</summary>
        <p className={ui.muted}>A CSV or Excel file with a row a day: the date, and the rain in mm. The dates are used as they are, so use the rain day (the day before a 9 am reading), as official records do. Days {gauge.name} already has are skipped. Check the preview; nothing is saved until you import.</p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        <div className={ui.inlineForm}>
          <Field label="File">
            <input key={picker} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void pick(event.target.files?.[0])} />
          </Field>
          <Button
            variant="secondary"
            disabled={!file || busy}
            onClick={async () => {
              const result = await send({ preview: true });
              if (result?.preview) setPreview(result.preview);
            }}
          >
            Preview
          </Button>
        </div>
        {preview ? (
          <>
            <div className={ui.inlineForm}>
              {column("date", "Date column")}
              {column("mm", "Rain (mm) column")}
            </div>
            {preview.alreadyImportedOn ? <Notice tone="warning">This file was already imported on {preview.alreadyImportedOn.slice(0, 10)}.</Notice> : null}
            <p>
              {preview.counts.readings} reading{preview.counts.readings === 1 ? "" : "s"} to import{preview.counts.errors ? `, ${preview.counts.errors} skipped` : ""}.
            </p>
            {preview.counts.errors ? (
              <ul>
                {preview.rows
                  .filter((row) => row.error)
                  .slice(0, 20)
                  .map((row) => (
                    <li key={row.line}>
                      Row {row.line}: {row.error}
                    </li>
                  ))}
              </ul>
            ) : null}
            <Button
              disabled={busy || !preview.counts.readings || Boolean(preview.alreadyImportedOn)}
              onClick={async () => {
                const result = await send({ columns: preview.columns });
                if (result && result.imported !== undefined) {
                  setDone(`Imported ${result.imported} reading${result.imported === 1 ? "" : "s"}${result.skipped ? `, skipped ${result.skipped}` : ""}.`);
                  setPreview(null);
                  setFile(null);
                  setPicker(picker + 1);
                  onImported();
                }
              }}
            >
              Import {preview.counts.readings}
            </Button>
          </>
        ) : null}
      </details>
    </Card>
  );
}

/**
 * FW4: the last 30 days' rain and temperature. A gauge reading wins; else
 * MetService's, worked out from the forecasts Tohyee kept. Days MetService
 * had fewer than 24 hours for say so.
 */
function DailyWeather({ organisationId, farmId }: { organisationId: string; farmId: string }) {
  const answer = useApiData<{ weather: RecentWeather }>(`/api/farming/farms/${farmId}/weather-days`, { organisationId });
  const weather = answer.data?.weather;
  if (answer.error) return <Notice tone="error">{answer.error}</Notice>;
  if (!weather) return null;
  if (!weather.on) {
    return (
      <Card title="Daily rain from MetService">
        <p className={ui.muted}>
          {weather.why} Once forecasts are on, records kept and combining allowed, each day&apos;s rain and temperature are worked out from them here. <Link href="/operations/settings/weather">Weather settings</Link>
        </p>
      </Card>
    );
  }
  return (
    <Card
      title="Daily rain from MetService"
      description="Each hour from the forecast fetched closest before it, added up for the day (midnight to midnight). Your gauge's reading is used instead where there is one."
    >
      {weather.days.length === 0 ? (
        <p className={ui.muted}>No finished days yet. They&apos;re worked out each morning from the forecasts kept.</p>
      ) : (
        <table className={ui.table}>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col" className={ui.num}>
                Rain (mm)
              </th>
              <th scope="col">From</th>
              <th scope="col" className={ui.num}>
                Average °C
              </th>
            </tr>
          </thead>
          <tbody>
            {weather.days.map((day) => (
              <tr key={day.day}>
                <td>{shortDate(day.day, todayInBrowser())}</td>
                <td className={ui.num}>{day.rainMm === null ? "–" : mmText(day.rainMm)}</td>
                <td>
                  {day.rainSource === "gauge" ? "Your gauge" : day.rainSource === "metservice" ? "MetService" : "–"}
                  {day.rainSource === "gauge" && day.metserviceRainMm !== null ? <span className={ui.muted}> (MetService {mmText(day.metserviceRainMm)})</span> : null}
                  {day.hours !== null && day.hours < 24 && day.rainSource === "metservice" ? <span className={ui.muted}> ({day.hours} of 24 hours)</span> : null}
                </td>
                <td className={ui.num}>{day.temperatureC ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={ui.muted} style={{ margin: 0 }}>
        {weather.attribution}
      </p>
    </Card>
  );
}
