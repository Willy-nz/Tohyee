/**
 * Each farm's daily rain and temperature from MetService (FW1-FW8, decision
 * 1597). Only while the organisation keeps MetService records and has
 * allowed combining them with farm data (the switches under Settings › Weather,
 * decision 1556): both are its responsibility under its MetService terms.
 *
 * - Once a day, each farm's finished days are worked out from the forecasts
 *   Tohyee kept (weather-history-rules.ts), and saved in farm_weather_days.
 * - Once a day, MetService's five days of recent history are fetched for
 *   each pinned farm and kept like any forecast, so a day the server missed
 *   (switched off, no signal) is still filled. That uses API units:
 *   rain and temperature for 120 hours, a farm.
 * - The farm's own rain gauges, where read, still come first.
 */
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { isoDateAt } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { visibleFarmIds } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { daysFromForecasts, HISTORY_DAYS, type KeptForecast, MIN_HOURS, rainFor, type RainSource, shiftDay } from "@/lib/farming/weather-history-rules";
import { decryptSecret } from "@/lib/secrets";
import { METSERVICE_ATTRIBUTION, onlyChosen, parseForecast, type WeatherChoice } from "@/lib/weather/forecast-rules";
import { weatherProvider } from "@/lib/weather/provider";

const ACTOR: Actor = { userId: null, email: "weather history" };
const TIME_ZONE = "Pacific/Auckland";

type Switches = { on: boolean; why: string | null; apiKey: string | null; choices: WeatherChoice[] };

/** FW1: whether daily weather is kept, and why not. */
async function switches(tx: OrgTx): Promise<Switches> {
  const row = (
    await tx.query<{ enabled: boolean; key: string | null; key_tested: boolean; paused: boolean; keep_records: boolean; combine: boolean; choices: string[] }>(
      `select enabled, api_key_ciphertext as key, key_tested, paused_at is not null as paused, keep_records, combine, choices from weather_settings where id = true`,
    )
  ).rows[0];
  const why = !row || !row.key || !row.enabled
    ? "MetService forecasts aren't on (Settings › Weather)."
    : !row.keep_records
      ? "Forecast records aren't kept (Settings › Weather › Records)."
      : !row.combine
        ? "Forecast records aren't allowed to be combined with farm data (Settings › Weather › Records)."
        : null;
  const choices = (row?.choices ?? []).filter((choice): choice is WeatherChoice => choice === "rain" || choice === "temperature");
  return { on: why === null, why, apiKey: why === null && row.key_tested && !row.paused ? row.key : null, choices };
}

/** FW2: works out the farm's finished days from `from`, replacing what was there, a month at a time. */
export async function workOutFarmDays(tx: OrgTx, farmId: string, from: string, today: string): Promise<number> {
  let saved = 0;
  for (let start = from; start < today; start = shiftDay(start, 31)) {
    const end = shiftDay(start, 31) < today ? shiftDay(start, 31) : today;
    // A forecast reaches up to a week ahead, so ones fetched 8 days before `start` still cover it; ones after `end` only as history.
    const rows = await tx.query<{ fetched_at: string; hours: KeptForecast["hours"] }>(
      `select to_char(fetched_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as fetched_at, hours
         from weather_forecast_history
        where farm_id = $1 and fetched_at >= ($2::date - 8)::timestamp at time zone $4 and fetched_at < ($3::date + ${HISTORY_DAYS + 1})::timestamp at time zone $4
        order by fetched_at`,
      [farmId, start, end, TIME_ZONE],
    );
    const days = daysFromForecasts(
      rows.rows.map((row) => ({ fetchedAt: row.fetched_at, hours: row.hours })),
      end,
    ).filter((day) => day.day >= start);
    for (const day of days) {
      await tx.query(
        `insert into farm_weather_days (farm_id, day, source, rain_mm, temperature_c, hours) values ($1, $2, 'metservice', $3::numeric, $4::numeric, $5)
         on conflict (farm_id, day, source) do update set rain_mm = excluded.rain_mm, temperature_c = excluded.temperature_c, hours = excluded.hours, worked_out_at = now()`,
        [farmId, day.day, day.rainMm, day.temperatureC, day.hours],
      );
    }
    saved += days.length;
  }
  return saved;
}

export type WeatherRun = { farms: number; days: number; fetched: number; error: string | null; skipped: string | null };

/**
 * FW3: one run: fetch the five days of recent history for each pinned farm
 * (at most once a day), then work out each farm's days from a week before
 * its last worked-out day (or its first kept forecast).
 */
export async function refreshFarmWeather(organisation: OrganisationRecord, options: { now?: Date; fetchHistory?: boolean } = {}): Promise<WeatherRun> {
  const now = options.now ?? new Date();
  const today = isoDateAt(now, TIME_ZONE);
  const plan = await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
    const state = await switches(tx);
    if (!state.on) return { skipped: state.why };
    const due = await tx.query<{ due: boolean }>(
      `select coalesce((select last_backfill_at < $1::timestamptz - interval '20 hours' from farm_weather_state where id = true), true) as due`,
      [now.toISOString()],
    );
    const farms = await tx.query<{ farm_id: string; latitude: string; longitude: string }>(
      "select l.farm_id::text, l.latitude::text, l.longitude::text from weather_locations l join farms f on f.id = l.farm_id where f.is_active order by l.farm_id",
    );
    const fetch = (options.fetchHistory ?? due.rows[0].due) && state.apiKey !== null && state.choices.length > 0;
    if (fetch) {
      await tx.query(
        `insert into farm_weather_state (id, last_backfill_at) values (true, $1) on conflict (id) do update set last_backfill_at = excluded.last_backfill_at`,
        [now.toISOString()],
      );
    }
    return { skipped: null, farms: farms.rows, apiKey: fetch ? decryptSecret(state.apiKey!) : null, choices: state.choices };
  });
  if (plan.skipped !== null || !("farms" in plan)) return { farms: 0, days: 0, fetched: 0, error: null, skipped: plan.skipped ?? null };
  const result: WeatherRun = { farms: 0, days: 0, fetched: 0, error: null, skipped: null };
  if (plan.apiKey) {
    for (const farm of plan.farms) {
      try {
        const from = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
        const answer = await weatherProvider().fetchForecast({ apiKey: plan.apiKey, point: farm, choices: plan.choices, now: from, hours: HISTORY_DAYS * 24 });
        const hours = onlyChosen(parseForecast(answer.body), plan.choices);
        await withOrganisationTransaction(organisation, ACTOR, (tx) =>
          tx.query(
            "insert into weather_forecast_history (farm_id, latitude, longitude, fetched_at, choices, hours) values ($1, $2, $3, $4, $5, $6::jsonb)",
            [farm.farm_id, farm.latitude, farm.longitude, now.toISOString(), plan.choices, JSON.stringify(hours)],
          ),
        );
        result.fetched += 1;
      } catch (error) {
        result.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      }
    }
  }
  await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
    const farms = await tx.query<{ farm_id: string; from: string | null }>(
      `select f.id::text as farm_id,
              coalesce((select max(day) - 7 from farm_weather_days d where d.farm_id = f.id),
                       (select min((fetched_at at time zone $1)::date) from weather_forecast_history h where h.farm_id = f.id))::text as from
         from farms f where f.is_active`,
      [TIME_ZONE],
    );
    for (const farm of farms.rows) {
      if (!farm.from) continue;
      result.days += await workOutFarmDays(tx, farm.farm_id, farm.from, today);
      result.farms += 1;
    }
    await tx.query(
      "insert into farm_weather_state (id, last_error) values (true, $1) on conflict (id) do update set last_error = excluded.last_error",
      [result.error],
    );
  });
  return result;
}

export type FarmWeatherDay = { day: string; rainMm: string | null; rainSource: RainSource | null; metserviceRainMm: string | null; temperatureC: string | null; hours: number | null };

/** FW4: a farm's days between two dates: its gauges' rain where read, else MetService's, and MetService's temperature. */
export async function farmWeatherDays(tx: OrgTx, farmId: string, from: string, to: string): Promise<FarmWeatherDay[]> {
  const gauges = await tx.query<{ day: string; mm: string }>(
    `select r.read_on::text as day, r.mm::text from rainfall_readings r where r.farm_id = $1 and r.status = 'active' and r.read_on between $2::date and $3::date`,
    [farmId, from, to],
  );
  const kept = await tx.query<{ day: string; rain_mm: string | null; temperature_c: string | null; hours: number }>(
    `select day::text, rain_mm::text, temperature_c::text, hours from farm_weather_days where farm_id = $1 and source = 'metservice' and day between $2::date and $3::date`,
    [farmId, from, to],
  );
  const byGauge = new Map<string, string[]>();
  for (const row of gauges.rows) byGauge.set(row.day, [...(byGauge.get(row.day) ?? []), row.mm]);
  const byMetService = new Map(kept.rows.map((row) => [row.day, row]));
  return [...new Set([...byGauge.keys(), ...byMetService.keys()])].sort().map((day) => {
    const metservice = byMetService.get(day) ?? null;
    const rain = rainFor(byGauge.get(day) ?? [], metservice?.rain_mm ?? null);
    return {
      day,
      rainMm: rain?.mm ?? null,
      rainSource: rain?.source ?? null,
      metserviceRainMm: metservice?.rain_mm ?? null,
      temperatureC: metservice?.temperature_c ?? null,
      hours: metservice?.hours ?? null,
    };
  });
}

/**
 * MCV9: a farm's days usable for modelling, as maps by day: rain where a
 * gauge was read or MetService had at least MIN_HOURS hours, temperature
 * where MetService had them.
 */
export async function weatherMaps(tx: OrgTx, farmId: string, from: string, to: string): Promise<{ rain: Map<string, string>; temperature: Map<string, string> }> {
  const rain = new Map<string, string>();
  const temperature = new Map<string, string>();
  for (const day of await farmWeatherDays(tx, farmId, from, to)) {
    const enoughHours = day.hours !== null && day.hours >= MIN_HOURS;
    if (day.rainMm !== null && (day.rainSource === "gauge" || enoughHours)) rain.set(day.day, day.rainMm);
    if (day.temperatureC !== null && enoughHours) temperature.set(day.day, day.temperatureC);
  }
  return { rain, temperature };
}

export type RecentWeather = { on: boolean; why: string | null; days: FarmWeatherDay[]; attribution: string };

/** FW4 for the screen: a farm's last 30 days, newest first, for anyone who can see the farm. */
export async function recentFarmWeather(tx: OrgTx, farmIdInput: unknown, now = new Date()): Promise<RecentWeather> {
  await requireFarming(tx);
  const farmId = String(farmIdInput ?? "");
  const visible = await visibleFarmIds(tx);
  if (!/^\d+$/.test(farmId) || (visible !== null && !visible.includes(farmId))) throw new ValidationError("Choose one of your farms.");
  const state = await switches(tx);
  const today = isoDateAt(now, TIME_ZONE);
  const days = state.on ? (await farmWeatherDays(tx, farmId, shiftDay(today, -30), shiftDay(today, -1))).reverse() : [];
  return { on: state.on, why: state.why, days, attribution: METSERVICE_ATTRIBUTION };
}

// The worker ---------------------------------------------------------------------------------------

const TICK_HOURS = 3;
let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const organisation of await listOrganisationsForJobs()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      try {
        await refreshFarmWeather(organisation);
      } catch (error) {
        console.warn(`[tohyee] Farm weather history failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    running = false;
  }
}

/** Starts the worker (off with TOHYEE_FARM_WEATHER_SCHEDULER=off). */
export function startFarmWeatherScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_HOURS * 60 * 60_000);
  timer.unref?.();
  setTimeout(() => void tick(), 7 * 60_000).unref?.();
}
