"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { InfoTip } from "@/components/info-tip";
import { Badge, Button, Card, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { Farm } from "@/lib/farming/paddocks";
import { ageText, compassPoint, METSERVICE_ATTRIBUTION, type ForecastDay, type ForecastHour, type WeatherChoice } from "@/lib/weather/forecast-rules";
import type { FarmForecast, GaugeComparisonDay } from "@/lib/weather/service";
import styles from "./weather-forecast.module.css";

/*
 * The MetService forecast for a farm (decisions 1546, 1550): a card on
 * Today and the Weather page. The attribution sits right under the data in
 * the same size type. The forecast is never saved on the device: with no
 * connection, the page shows what it already loaded, with its age, and
 * otherwise says the forecast needs a connection.
 */

export const WEATHER_SETTINGS = "/operations/settings/weather";
export const WEATHER_PAGE = "/operations/farm/weather";

type Loaded = { forecast: FarmForecast; loadedAt: number };

/** Loads the forecast and keeps the last good answer in memory only, refreshing it every 10 minutes while open. */
export function useFarmForecast(organisationId: string, farmId: string) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api<{ forecast: FarmForecast }>("/api/farming/weather/forecast", { query: { organisationId, farmId } }).then(
      (data) => {
        if (cancelled) return;
        setLoaded({ forecast: data.forecast, loadedAt: Date.now() });
        setError(null);
        setOffline(false);
      },
      (caught: unknown) => {
        if (cancelled) return;
        const code = (caught as { code?: string })?.code;
        setOffline(code === "offline" || code === "offline_locked" || (typeof navigator !== "undefined" && navigator.onLine === false));
        setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [organisationId, farmId, version]);
  useEffect(() => {
    const timer = setInterval(() => setVersion((value) => value + 1), 10 * 60 * 1000);
    const back = () => setVersion((value) => value + 1);
    window.addEventListener("online", back);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", back);
    };
  }, []);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { loaded, error, offline, reload };
}

function hourLabel(at: string): string {
  const date = new Date(at);
  const hour = date.toLocaleTimeString("en-NZ", { hour: "numeric", hour12: true }).replace(/\s/g, "").toLowerCase();
  return hour === "12am" ? date.toLocaleDateString("en-NZ", { weekday: "short" }) : hour;
}

function dayLabel(date: string, index: number): string {
  if (index === 0) return "Today";
  const day = new Date(`${date}T12:00:00`);
  return day.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" });
}

function windText(speed: string | null, direction: string | null): string {
  if (speed === null) return "–";
  const from = compassPoint(direction);
  return `${from ? `${from} ` : ""}${speed}`;
}

const dash = (value: string | null, unit = "") => (value === null ? "–" : `${value}${unit}`);

function Attribution() {
  // MetService's terms (1.3(e), 2.8): beside the data, no smaller than it.
  return <p className={styles.attribution}>{METSERVICE_ATTRIBUTION}</p>;
}

/** When the forecast was fetched, and whether it's stale or only kept in this page. */
function Freshness({ forecast, loadedAt, offline, refreshHours }: { forecast: NonNullable<FarmForecast["forecast"]>; loadedAt: number; offline: boolean; refreshHours: number }) {
  const now = new Date();
  return (
    <p className={styles.meta}>
      <span>Updated {ageText(forecast.fetchedAt, now)}</span>
      {forecast.freshness === "stale" ? <Badge tone="amber">Out of date</Badge> : null}
      {offline ? <Badge tone="amber">No connection</Badge> : null}
      <InfoTip label="About the forecast's age">
        Tohyee fetches the forecast every {refreshHours === 1 ? "hour" : `${refreshHours} hours`}. It shows &quot;Out of date&quot; when a refresh is overdue.
        {offline ? ` With no connection you see what this page loaded ${ageText(new Date(loadedAt).toISOString(), now)}. The forecast isn't saved on this device: MetService's terms limit copies.` : null}
      </InfoTip>
    </p>
  );
}

/** `limit`: the card shows the first few, and says how many more the Weather page has. */
function Warnings({ forecast, note, limit }: { forecast: NonNullable<FarmForecast["forecast"]>; note: string; limit?: number }) {
  if (!forecast.warnings.length) return null;
  const shown = limit ? forecast.warnings.slice(0, limit) : forecast.warnings;
  const more = forecast.warnings.length - shown.length;
  const today = forecast.days[0]?.date;
  return (
    <div>
      <ul className={styles.warnings} aria-label="Frost and heavy rain">
        {shown.map((warning) => (
          <li key={`${warning.kind}-${warning.date}`} className={styles.warning} data-kind={warning.kind}>
            <strong>{warning.date === today ? "Today" : dayLabel(warning.date, 1)}</strong> {warning.text}
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <p className={styles.meta}>
          <Link href={WEATHER_PAGE}>{more} more on the Weather page</Link>
        </p>
      ) : null}
      <p className={styles.meta}>{note}</p>
    </div>
  );
}

function Strip({ hours, choices, every = 3 }: { hours: ForecastHour[]; choices: WeatherChoice[]; every?: number }) {
  const shown = hours.filter((_, index) => index % every === 0);
  return (
    <ul className={styles.strip} aria-label={`The next ${hours.length} hours, every ${every} hours`}>
      {shown.map((hour) => (
        <li key={hour.at} className={styles.slot}>
          <span className={styles.slotTime}>{hourLabel(hour.at)}</span>
          {choices.includes("temperature") ? <span>{dash(hour.temperatureC, "°")}</span> : null}
          {choices.includes("rain") ? <span className={styles.rain}>{dash(hour.rainMm, " mm")}</span> : null}
          {choices.includes("wind") ? <span>{windText(hour.windKmh, hour.windDirection)}</span> : null}
          {choices.includes("gusts") && !choices.includes("wind") ? <span>{dash(hour.gustKmh)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function DaysTable({ days, choices }: { days: ForecastDay[]; choices: WeatherChoice[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className={ui.srOnly}>The next 7 days</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {choices.includes("rain") ? <th scope="col">Rain (mm)</th> : null}
            {choices.includes("temperature") ? <th scope="col">Low / high (°C)</th> : null}
            {choices.includes("wind") ? <th scope="col">Wind (km/h)</th> : null}
            {choices.includes("gusts") ? <th scope="col">Gusts (km/h)</th> : null}
          </tr>
        </thead>
        <tbody>
          {days.map((day, index) => (
            <tr key={day.date}>
              <th scope="row" className={styles.dayRow}>
                {dayLabel(day.date, index)}
                {day.hours < 24 ? <span className={ui.muted}> ({day.hours} h)</span> : null}
              </th>
              {choices.includes("rain") ? <td>{dash(day.rainMm)}</td> : null}
              {choices.includes("temperature") ? <td>{day.minC === null ? "–" : `${day.minC} / ${day.maxC}`}</td> : null}
              {choices.includes("wind") ? <td>{dash(day.maxWindKmh)}</td> : null}
              {choices.includes("gusts") ? <td>{dash(day.maxGustKmh)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoursTable({ hours, choices }: { hours: ForecastHour[]; choices: WeatherChoice[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className={ui.srOnly}>The next 48 hours</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            {choices.includes("rain") ? <th scope="col">Rain (mm)</th> : null}
            {choices.includes("temperature") ? <th scope="col">Temp (°C)</th> : null}
            {choices.includes("wind") ? <th scope="col">Wind (km/h)</th> : null}
            {choices.includes("gusts") ? <th scope="col">Gusts (km/h)</th> : null}
          </tr>
        </thead>
        <tbody>
          {hours.map((hour) => (
            <tr key={hour.at}>
              <th scope="row">{new Date(hour.at).toLocaleString("en-NZ", { weekday: "short", hour: "numeric", hour12: true })}</th>
              {choices.includes("rain") ? <td>{dash(hour.rainMm)}</td> : null}
              {choices.includes("temperature") ? <td>{dash(hour.temperatureC)}</td> : null}
              {choices.includes("wind") ? <td>{windText(hour.windKmh, hour.windDirection)}</td> : null}
              {choices.includes("gusts") ? <td>{dash(hour.gustKmh)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RefreshButton({ organisationId, onDone }: { organisationId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMessage(null);
          try {
            const answer = await api<{ result: { refreshed: number; failed: number; skipped?: string } }>("/api/farming/weather/refresh", { method: "POST", body: { organisationId } });
            if (answer.result.skipped === "paused") setMessage("Refreshing has stopped because of a problem with MetService. An admin can test the connection in Settings.");
            else if (answer.result.failed) setMessage("Some farms couldn't be refreshed. It tries again at the next refresh.");
            onDone();
          } catch (caught) {
            setMessage(errorMessage(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Refreshing…" : "Refresh"}
      </Button>
      {message ? <span className={ui.muted}>{message}</span> : null}
    </>
  );
}

/** What to say when there's no forecast to show. Null when there's nothing worth a card (not set up, and not an admin). */
function NoForecast({ forecast, admin, offline }: { forecast: FarmForecast | null; admin: boolean; offline: boolean }): ReactNode {
  if (offline && !forecast) return <p>The forecast needs a connection. It isn&apos;t saved on this device, as MetService&apos;s terms limit copies.</p>;
  if (!forecast) return null;
  if (!forecast.enabled) {
    return admin ? (
      <p>
        Forecasts from MetService, with your own key. <Link href={WEATHER_SETTINGS}>Set up the forecast</Link>
      </p>
    ) : null;
  }
  if (!forecast.placed) {
    return admin ? (
      <p>
        This farm has no forecast pin. <Link href={WEATHER_SETTINGS}>Choose its place</Link>
      </p>
    ) : (
      <p>This farm has no forecast yet. An admin can add it.</p>
    );
  }
  if (forecast.paused) return <Notice tone="warning">{forecast.statusText}{admin ? <> <Link href={WEATHER_SETTINGS}>Weather settings</Link></> : " An admin can fix it in Settings."}</Notice>;
  return <p>No forecast yet. It&apos;s fetched every {forecast.refreshHours === 1 ? "hour" : `${forecast.refreshHours} hours`}.</p>;
}

/** The forecast card on Today (WX4): warnings, the next 48 hours every 3 hours, and the week. */
export function WeatherForecastCard({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const { can } = useWorkspace();
  const admin = can("admin");
  const { loaded, error, offline, reload } = useFarmForecast(organisationId, farm.id);
  const forecast = loaded?.forecast ?? null;
  const data = forecast?.forecast ?? null;
  if (!loaded && !error) return null;
  if (!data) {
    const message = NoForecast({ forecast, admin, offline });
    if (!message && !(error && !offline)) return null;
    return (
      <Card title="Weather forecast" href={forecast?.enabled ? WEATHER_PAGE : undefined}>
        {error && !offline ? <Notice tone="error">{error}</Notice> : message}
      </Card>
    );
  }
  return (
    <Card title="Weather forecast" href={WEATHER_PAGE} actions={forecast?.canRefresh && !offline ? <RefreshButton organisationId={organisationId} onDone={reload} /> : undefined}>
      <div className={styles.forecast}>
        <Freshness forecast={data} loadedAt={loaded!.loadedAt} offline={offline} refreshHours={forecast!.refreshHours} />
        <Warnings forecast={data} note={forecast!.warningsNote} limit={3} />
        <div>
          <Strip hours={data.hours} choices={data.choices} />
          <Attribution />
        </div>
        <div>
          <DaysTable days={data.days.slice(0, 7)} choices={data.choices} />
          <Attribution />
        </div>
        <p>
          <Link href={WEATHER_PAGE}>Hour by hour</Link>
        </p>
      </div>
    </Card>
  );
}

/** The Weather page (WX4-WX6, WX9): the next 48 hours by the hour, the week, and (with records and combining enabled) forecast vs rain gauge. */
export function WeatherPage({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const { can } = useWorkspace();
  const admin = can("admin");
  const { loaded, error, offline, reload } = useFarmForecast(organisationId, farm.id);
  const forecast = loaded?.forecast ?? null;
  const data = forecast?.forecast ?? null;
  return (
    <div className={styles.grid}>
      <Card
        title="Next 7 days"
        actions={forecast?.canRefresh && data && !offline ? <RefreshButton organisationId={organisationId} onDone={reload} /> : undefined}
        description={
          <>
            From MetService, for {farm.name}&apos;s pin.{" "}
            <InfoTip label="About this forecast">
              Tohyee fetches it with your organisation&apos;s own MetService key and keeps only the latest forecast. It isn&apos;t mixed with your own records.
              {admin ? " Change what's fetched, the farm's pin or how often under Settings, Weather forecast." : null}
            </InfoTip>
          </>
        }
      >
        {!loaded && !error ? <p className={ui.muted}>Loading…</p> : null}
        {error && !offline ? <Notice tone="error">{error}</Notice> : null}
        {data ? (
          <div className={styles.forecast}>
            <Freshness forecast={data} loadedAt={loaded!.loadedAt} offline={offline} refreshHours={forecast!.refreshHours} />
            {forecast!.paused ? <Notice tone="warning">{forecast!.statusText}</Notice> : null}
            <Warnings forecast={data} note={forecast!.warningsNote} />
            <div>
              <DaysTable days={data.days.slice(0, 7)} choices={data.choices} />
              <Attribution />
            </div>
          </div>
        ) : (
          (NoForecast({ forecast, admin, offline }) ?? <p>No forecast for this farm.</p>)
        )}
        {admin ? (
          <p>
            <Link href={WEATHER_SETTINGS}>Weather settings</Link>
          </p>
        ) : null}
      </Card>
      {data ? (
        <Card title="Next 48 hours">
          <div className={styles.forecast}>
            <HoursTable hours={data.hours} choices={data.choices} />
            <Attribution />
          </div>
        </Card>
      ) : null}
      {forecast?.combine && !offline ? <ForecastVsGauge organisationId={organisationId} farm={farm} /> : null}
    </div>
  );
}

/** Forecast vs your rain gauge (WX9): only shown when an admin has turned on records and combining. */
function ForecastVsGauge({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const [state, setState] = useState<{ gauge: { id: string; name: string } | null; days: GaugeComparisonDay[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ comparison: { gauge: { id: string; name: string } | null; days: GaugeComparisonDay[] } }>("/api/farming/weather/compare", { query: { organisationId, farmId: farm.id, days: "14" } }).then(
      (data) => !cancelled && setState(data.comparison),
      (caught) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [organisationId, farm.id]);
  return (
    <Card
      title="Forecast vs your rain gauge"
      description={
        <>
          Rain days, 9 am to 9 am, as your gauge reads them.{" "}
          <InfoTip label="About this comparison">
            The forecast for each day is the last one fetched before the day began. An admin enabled keeping records and comparing them with your rain gauge.
          </InfoTip>
        </>
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!state && !error ? <p className={ui.muted}>Loading…</p> : null}
      {state && !state.gauge ? <p>No active rain gauge on {farm.name}. Add one under Rainfall.</p> : null}
      {state?.gauge ? (
        <div className={styles.forecast}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={ui.srOnly}>Forecast rain and {state.gauge.name} gauge readings</caption>
              <thead>
                <tr>
                  <th scope="col">Rain day</th>
                  <th scope="col">Forecast (mm)</th>
                  <th scope="col">{state.gauge.name} (mm)</th>
                  <th scope="col">Difference</th>
                </tr>
              </thead>
              <tbody>
                {[...state.days].reverse().map((day) => (
                  <tr key={day.rainDay}>
                    <th scope="row">{new Date(`${day.rainDay}T12:00:00`).toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" })}</th>
                    <td>{dash(day.forecastMm)}</td>
                    <td>{dash(day.gaugeMm)}</td>
                    <td>{dash(day.difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Attribution />
          <p className={styles.meta}>A dash is a day with no reading, or no forecast record covering the whole day.</p>
        </div>
      ) : null}
    </Card>
  );
}
