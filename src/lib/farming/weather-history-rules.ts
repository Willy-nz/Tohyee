/**
 * Daily weather for each farm from MetService (FW1-FW8, decision 1597; Jess,
 * 12 Nov 2026: "use MetService and their history"). Pure and browser-safe.
 *
 * - Tohyee keeps every MetService forecast it fetches (when the organisation
 *   keeps records). For each hour of a past day, the forecast fetched most
 *   recently at or before that hour is used: the shortest lead time, so the
 *   closest MetService came to seeing it happen. With none before it, the
 *   earliest after it (MetService's own five days of recent history).
 * - A day is New Zealand's calendar day (midnight to midnight). It's only
 *   worked out once it's over, and only from hours with a value: `hours`
 *   says how many of 24 it had. Rain is the hours' total; temperature their
 *   average. A day with no hours isn't a day of no rain: it's unknown.
 * - A farm's own rain gauge, where it was read, comes first (rainFor).
 * - "Rain in the 14 days before" a date counts the 14 days ending the day
 *   before it, and is unknown if any of those days is.
 */
import { dec, type Decimal, divide, roundHalfUp, sum, toFixedString } from "@/lib/money/decimal";

export const RAIN_WINDOW_DAYS = 14;
/** MetService's Point Forecast API includes this many days of recent history. */
export const HISTORY_DAYS = 5;
/** A day needs at least this many hours known before it's used for modelling. */
export const MIN_HOURS = 20;

export type KeptForecast = { fetchedAt: string; hours: ReadonlyArray<{ at: string; rainMm: string | null; temperatureC: string | null }> };
export type WeatherDay = { day: string; rainMm: string | null; temperatureC: string | null; hours: number };

/** Adds days to an ISO date. */
export function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
}

/** The New Zealand date of an instant. */
export function nzDay(at: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/**
 * FW2: each hour's value from the forecast fetched latest at or before it
 * (else the earliest after it), then New Zealand days before `today`.
 */
export function daysFromForecasts(forecasts: readonly KeptForecast[], today: string): WeatherDay[] {
  type Pick = { fetched: number; before: boolean; rain: string | null; temperature: string | null };
  const best = new Map<number, Pick>();
  for (const forecast of forecasts) {
    const fetched = Date.parse(forecast.fetchedAt);
    for (const hour of forecast.hours) {
      if (hour.rainMm === null && hour.temperatureC === null) continue;
      const at = Date.parse(hour.at);
      if (!Number.isFinite(at)) continue;
      const before = fetched <= at;
      const current = best.get(at);
      const better =
        !current || (before && !current.before) || (before && current.before && fetched > current.fetched) || (!before && !current.before && fetched < current.fetched);
      if (better) best.set(at, { fetched, before, rain: hour.rainMm, temperature: hour.temperatureC });
    }
  }
  const byDay = new Map<string, Pick[]>();
  for (const [at, pick] of best) {
    const day = nzDay(new Date(at).toISOString());
    if (day >= today) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), pick]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, picks]) => {
      const rains = picks.flatMap((pick) => (pick.rain === null ? [] : [dec(pick.rain)]));
      const temperatures = picks.flatMap((pick) => (pick.temperature === null ? [] : [dec(pick.temperature)]));
      return {
        day,
        rainMm: rains.length ? toFixedString(roundHalfUp(sum(rains), 1), 1) : null,
        temperatureC: temperatures.length ? toFixedString(roundHalfUp(divide(sum(temperatures), dec(String(temperatures.length)), 4), 1), 1) : null,
        hours: Math.min(24, picks.length),
      };
    });
}

export type RainSource = "gauge" | "metservice";

/** A day's rain: the farm's gauges' average if any were read, else MetService's, else unknown. To 0.1 mm, exact. */
export function rainFor(gauges: readonly string[], metservice: string | null): { mm: string; source: RainSource } | null {
  if (gauges.length > 0) {
    const average = divide(sum(gauges.map((mm) => dec(mm))), dec(String(gauges.length)), 4);
    return { mm: toFixedString(roundHalfUp(average, 1), 1), source: "gauge" };
  }
  return metservice === null ? null : { mm: metservice, source: "metservice" };
}

/** The N values before a date (not counting it), or null if any day is unknown. */
function before(byDay: ReadonlyMap<string, string>, date: string, days: number): Decimal[] | null {
  const values: Decimal[] = [];
  for (let back = 1; back <= days; back += 1) {
    const found = byDay.get(shiftDay(date, -back));
    if (found === undefined) return null;
    values.push(dec(found));
  }
  return values;
}

/** Rain in the N days before a date (not counting it), or null if any day is unknown. */
export function rainBefore(rainByDay: ReadonlyMap<string, string>, date: string, days = RAIN_WINDOW_DAYS): string | null {
  const values = before(rainByDay, date, days);
  return values ? toFixedString(sum(values), 1) : null;
}

/** Mean temperature over the N days before a date, or null if any day is unknown. */
export function temperatureBefore(temperatureByDay: ReadonlyMap<string, string>, date: string, days = RAIN_WINDOW_DAYS): string | null {
  const values = before(temperatureByDay, date, days);
  return values ? toFixedString(roundHalfUp(divide(sum(values), dec(String(days)), 4), 1), 1) : null;
}
