import { writeAuditEvent } from "@/lib/audit";
import type { Actor, OrgTx } from "@/lib/db/org-transaction";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { businessTimeZone, parseIsoDate, todayIsoDate } from "@/lib/dates";
import { ConflictError, NotFoundError, TooManyRequestsError, ValidationError } from "@/lib/errors";
import { requireFarmAccess, visibleFarmIds } from "@/lib/farming/access";
import { bounds, parseGeometry } from "@/lib/farming/geometry";
import { requireFarming } from "@/lib/farming/paddocks";
import { latestRainDay } from "@/lib/farming/rainfall-rules";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { requireArray, requireBoolean, requireId, requireString } from "@/lib/validation";
import {
  estimateUnits,
  type ForecastDay,
  type ForecastHour,
  forecastDays,
  forecastWarnings,
  type ForecastWarning,
  freshness,
  type Freshness,
  hoursAhead,
  isRefreshHours,
  isWeatherChoice,
  MANUAL_REFRESH_MINUTES,
  METSERVICE_ATTRIBUTION,
  onlyChosen,
  parseForecast,
  pastCacheLimit,
  rainDayForecast,
  rainDifference,
  STATUS_TEXT,
  stopsRefreshing,
  type UnitsEstimate,
  type WeatherChoice,
  type WeatherStatus,
  WARNINGS_NOTE,
} from "@/lib/weather/forecast-rules";
import { usingFakeProvider, weatherProvider, WeatherProviderError } from "@/lib/weather/provider";

/*
 * MetService forecasts with the organisation's own key (decisions
 * 1541-1550; examples WX1-WX10, not yet reviewed).
 *
 * - The key is the organisation's, never shared: admins save it, it's
 *   encrypted with the server's secret key and never leaves the server
 *   (no API answer, log, AI tool, Analytics or offline pack has it).
 * - Only the latest forecast is kept, a row a farm. It's deleted when the
 *   key is removed, when MetService refuses the key, when the farm's pin
 *   moves or the forecast is turned off, and once it's 24 hours old.
 * - Forecast records are optional; enabling them requires an admin
 *   acknowledgement of responsibility for compliance (keep_records).
 *   Combining records with farm data (rain gauge, Analytics, AI) needs a
 *   second switch (combine). Tohyee doesn't verify permission: it's the
 *   organisation's responsibility, and the screens say so.
 * - Refreshing calls MetService outside any database transaction, so a slow
 *   answer never holds the database.
 */

export type WeatherSetupStep = "about" | "get_key" | "paste" | "test" | "farms" | "choose" | "turn_on";
export const SETUP_STEPS: WeatherSetupStep[] = ["about", "get_key", "paste", "test", "farms", "choose", "turn_on"];

export type WeatherLocation = { farmId: string; farmName: string; point: { latitude: string; longitude: string } | null; centre: { latitude: string; longitude: string } | null };

export type WeatherPermission = {
  keepRecords: boolean;
  grantedOn: string | null;
  reference: string | null;
  setAt: string | null;
  setByEmail: string | null;
  file: { fileName: string; byteSize: number; addedAt: string } | null;
  combine: boolean;
  combineSetAt: string | null;
  combineSetByEmail: string | null;
  /** How many forecasts are kept as records. */
  records: number;
};

export type WeatherSetup = {
  /** Whether a key is saved. The key itself is never sent. */
  hasKey: boolean;
  keySavedAt: string | null;
  keySavedByEmail: string | null;
  secretsAvailable: boolean;
  step: WeatherSetupStep;
  choices: WeatherChoice[];
  refreshHours: number;
  enabled: boolean;
  status: WeatherStatus;
  statusText: string;
  testedAt: string | null;
  /** Set when refreshing stopped because of a problem MetService reported (the spending guard). */
  pausedAt: string | null;
  lastRefreshAt: string | null;
  locations: WeatherLocation[];
  estimate: UnitsEstimate;
  permission: WeatherPermission;
  fakeProvider: boolean;
};

type SettingsRow = {
  api_key_ciphertext: string | null;
  key_saved_at: string | null;
  key_saved_by_email: string | null;
  setup_step: WeatherSetupStep;
  choices: string[];
  refresh_hours: number;
  enabled: boolean;
  status: WeatherStatus;
  tested_at: string | null;
  paused_at: string | null;
  last_refresh_at: string | null;
  last_manual_refresh_at: string | null;
  keep_records: boolean;
  permission_granted_on: string | null;
  permission_reference: string | null;
  keep_records_set_at: string | null;
  keep_records_set_by_email: string | null;
  combine: boolean;
  combine_set_at: string | null;
  combine_set_by_email: string | null;
};

const SETTINGS_COLUMNS = `api_key_ciphertext, key_saved_at::text, key_saved_by_email, setup_step, choices, refresh_hours, enabled, status,
  tested_at::text, paused_at::text, last_refresh_at::text, last_manual_refresh_at::text, keep_records, permission_granted_on::text,
  permission_reference, keep_records_set_at::text, keep_records_set_by_email, combine, combine_set_at::text, combine_set_by_email`;

async function settingsRow(tx: OrgTx, lock = false): Promise<SettingsRow> {
  const row = await tx.query<SettingsRow>(`select ${SETTINGS_COLUMNS} from weather_settings where id = true${lock ? " for update" : ""}`);
  return row.rows[0];
}

function choicesOf(row: { choices: string[] }): WeatherChoice[] {
  return row.choices.filter(isWeatherChoice);
}

/** Every active farm the person can see, with its pin and the middle of its paddocks (the pin's default). */
async function listLocations(tx: OrgTx): Promise<WeatherLocation[]> {
  const visible = await visibleFarmIds(tx);
  const farms = await tx.query<{ id: string; name: string; latitude: string | null; longitude: string | null }>(
    `select f.id::text, f.name, l.latitude::text, l.longitude::text from farms f left join weather_locations l on l.farm_id = f.id
      where f.is_active and ($1::bigint[] is null or f.id = any($1::bigint[])) order by lower(f.name), f.id`,
    [visible],
  );
  const shapes = await tx.query<{ farm_id: string; geometry: unknown }>(
    `select p.farm_id::text, b.geometry from paddocks p
       join lateral (select geometry from paddock_boundaries pb where pb.paddock_id = p.id order by pb.id desc limit 1) b on true
      where p.status = 'active'`,
  );
  return farms.rows.map((farm) => {
    const geometries = shapes.rows.filter((shape) => shape.farm_id === farm.id).flatMap((shape) => {
      try {
        return [parseGeometry(shape.geometry)];
      } catch {
        return [];
      }
    });
    const box = bounds(geometries);
    return {
      farmId: farm.id,
      farmName: farm.name,
      point: farm.latitude !== null && farm.longitude !== null ? { latitude: farm.latitude, longitude: farm.longitude } : null,
      centre: box ? { longitude: ((box[0] + box[2]) / 2).toFixed(6), latitude: ((box[1] + box[3]) / 2).toFixed(6) } : null,
    };
  });
}

async function permissionOf(tx: OrgTx, row: SettingsRow): Promise<WeatherPermission> {
  const file = await tx.query<{ file_name: string; byte_size: number; added_at: string }>("select file_name, byte_size, added_at::text from weather_permission_files where id = true");
  const records = await tx.query<{ n: number }>("select count(*)::int as n from weather_forecast_history");
  return {
    keepRecords: row.keep_records,
    grantedOn: row.permission_granted_on,
    reference: row.permission_reference,
    setAt: row.keep_records_set_at,
    setByEmail: row.keep_records_set_by_email,
    file: file.rows[0] ? { fileName: file.rows[0].file_name, byteSize: file.rows[0].byte_size, addedAt: file.rows[0].added_at } : null,
    combine: row.combine,
    combineSetAt: row.combine_set_at,
    combineSetByEmail: row.combine_set_by_email,
    records: records.rows[0].n,
  };
}

/** The setup as an admin sees it (WX1). Never the key. */
export async function getWeatherSetup(tx: OrgTx): Promise<WeatherSetup> {
  await requireFarming(tx);
  const row = await settingsRow(tx);
  const locations = await listLocations(tx);
  const pinned = locations.filter((location) => location.point).length;
  return {
    hasKey: row.api_key_ciphertext !== null,
    keySavedAt: row.key_saved_at,
    keySavedByEmail: row.key_saved_by_email,
    secretsAvailable: secretsAvailable(),
    step: row.setup_step,
    choices: choicesOf(row),
    refreshHours: row.refresh_hours,
    enabled: row.enabled,
    status: row.status,
    statusText: STATUS_TEXT[row.status],
    testedAt: row.tested_at,
    pausedAt: row.paused_at,
    lastRefreshAt: row.last_refresh_at,
    locations,
    estimate: estimateUnits({ choices: choicesOf(row), farms: pinned, refreshHours: row.refresh_hours }),
    permission: await permissionOf(tx, row),
    fakeProvider: usingFakeProvider(),
  };
}

/** Saves where the setup is up to, so it carries on there (WX1). */
export async function saveSetupStep(tx: OrgTx, stepInput: unknown): Promise<WeatherSetup> {
  await requireFarming(tx);
  if (typeof stepInput !== "string" || !SETUP_STEPS.includes(stepInput as WeatherSetupStep)) throw new ValidationError("Unknown setup step.");
  await tx.query("update weather_settings set setup_step = $1, updated_at = now() where id = true", [stepInput]);
  return getWeatherSetup(tx);
}

/** Saves the organisation's key, encrypted (WX2). A new key needs testing before forecasts are fetched with it. */
export async function saveWeatherKey(tx: OrgTx, keyInput: unknown): Promise<WeatherSetup> {
  await requireFarming(tx);
  const key = requireString(keyInput, "Key", { maxLength: 400 }).trim();
  if (key.length < 8 || /\s/.test(key)) throw new ValidationError("That doesn't look like a whole key. Copy it again from MetService's console, with nothing before or after it.");
  await settingsRow(tx, true);
  await tx.query(
    `update weather_settings set api_key_ciphertext = $1, key_saved_at = now(), key_saved_by_email = $2, status = 'not_tested', tested_at = null,
       paused_at = null, last_refresh_at = null, updated_at = now() where id = true`,
    [encryptSecret(key), tx.actor.email],
  );
  // Forecasts fetched with the old key go with it.
  await tx.query("delete from weather_forecast_cache");
  await writeAuditEvent(tx, { eventType: "weather.key_saved", entityType: "weather_settings", entityId: "metservice", details: {} });
  return getWeatherSetup(tx);
}

/**
 * Removes the key (WX2). The forecast stops and the kept forecast is
 * deleted. Previously retained records stay until the
 * records switch is turned off (decision 1548).
 */
export async function removeWeatherKey(tx: OrgTx): Promise<WeatherSetup> {
  await requireFarming(tx);
  const row = await settingsRow(tx, true);
  if (!row.api_key_ciphertext) throw new NotFoundError("There's no key saved.");
  await tx.query(
    `update weather_settings set api_key_ciphertext = null, key_saved_at = null, key_saved_by_email = null, enabled = false, status = 'not_tested',
       tested_at = null, paused_at = null, updated_at = now() where id = true`,
  );
  const deleted = await tx.query("delete from weather_forecast_cache");
  await writeAuditEvent(tx, { eventType: "weather.key_removed", entityType: "weather_settings", entityId: "metservice", details: { forecastsDeleted: deleted.rowCount ?? 0 } });
  return getWeatherSetup(tx);
}

function parsePoint(input: unknown): { latitude: string; longitude: string } {
  let lon: unknown;
  let lat: unknown;
  if (Array.isArray(input)) [lon, lat] = input;
  else if (input && typeof input === "object") ({ longitude: lon, latitude: lat } = input as Record<string, unknown>);
  const toNumber = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value);
  lon = toNumber(lon);
  lat = toNumber(lat);
  if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new ValidationError("A farm's place must be a latitude (-90 to 90) and longitude (-180 to 180).");
  }
  return { longitude: lon.toFixed(6), latitude: lat.toFixed(6) };
}

/**
 * Which farms get a forecast, and where (WX1): `locations` is the whole
 * list, each { farmId, point } (null takes a farm off). A moved pin's kept
 * forecast goes, as it's for the old place.
 */
export async function saveWeatherLocations(tx: OrgTx, input: unknown): Promise<WeatherSetup> {
  await requireFarming(tx);
  const list = requireArray(input, "locations", 200);
  const wanted = new Map<string, { latitude: string; longitude: string } | null>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") throw new ValidationError("Each farm needs a farmId and a point.");
    const record = entry as Record<string, unknown>;
    const farmId = requireId(record.farmId, "farmId");
    const farm = await tx.query("select 1 from farms where id = $1 and is_active", [farmId]);
    if (!farm.rowCount) throw new NotFoundError("Farm not found.");
    await requireFarmAccess(tx, farmId);
    wanted.set(farmId, record.point === null || record.point === undefined ? null : parsePoint(record.point));
  }
  const before = new Map((await tx.query<{ farm_id: string; latitude: string; longitude: string }>("select farm_id::text, latitude::text, longitude::text from weather_locations")).rows.map((row) => [row.farm_id, row]));
  for (const [farmId, point] of wanted) {
    const was = before.get(farmId);
    if (!point) {
      await tx.query("delete from weather_locations where farm_id = $1", [farmId]);
      await tx.query("delete from weather_forecast_cache where farm_id = $1", [farmId]);
      continue;
    }
    if (was && was.latitude === point.latitude && was.longitude === point.longitude) continue;
    await tx.query(
      `insert into weather_locations (farm_id, latitude, longitude, updated_by_email) values ($1, $2, $3, $4)
       on conflict (farm_id) do update set latitude = excluded.latitude, longitude = excluded.longitude, updated_at = now(), updated_by_email = excluded.updated_by_email`,
      [farmId, point.latitude, point.longitude, tx.actor.email],
    );
    await tx.query("delete from weather_forecast_cache where farm_id = $1", [farmId]);
    // A new or moved pin is fetched at the next check, within 10 minutes.
    await tx.query("update weather_settings set last_refresh_at = null where id = true");
  }
  await writeAuditEvent(tx, { eventType: "weather.farms_changed", entityType: "weather_settings", entityId: "metservice", details: { farms: [...wanted].map(([farmId, point]) => ({ farmId, placed: Boolean(point) })) } });
  const pinned = await tx.query<{ n: number }>("select count(*)::int as n from weather_locations");
  if (pinned.rows[0].n === 0) await tx.query("update weather_settings set enabled = false where id = true");
  return getWeatherSetup(tx);
}

/** What's fetched and how often (WX1, WX2). Kept to the fewest variables to save units. */
export async function saveWeatherChoices(tx: OrgTx, input: { choices?: unknown; refreshHours?: unknown }): Promise<WeatherSetup> {
  await requireFarming(tx);
  const row = await settingsRow(tx, true);
  let choices = choicesOf(row);
  if (input.choices !== undefined) {
    const list = requireArray(input.choices, "choices", 10);
    if (!list.every(isWeatherChoice)) throw new ValidationError("Choose from rain, temperature, wind and gusts.");
    choices = [...new Set(list as WeatherChoice[])];
    if (!choices.length) throw new ValidationError("Choose at least one thing to fetch.");
  }
  let refreshHours = row.refresh_hours;
  if (input.refreshHours !== undefined) {
    const hours = typeof input.refreshHours === "string" ? Number(input.refreshHours) : input.refreshHours;
    if (!isRefreshHours(hours)) throw new ValidationError("Refresh every 1, 3, 6 or 12 hours.");
    refreshHours = hours;
  }
  const changedChoices = choices.join() !== choicesOf(row).join();
  // Changed choices are fetched at the next check (within 10 minutes), not at the next scheduled refresh.
  await tx.query("update weather_settings set choices = $1, refresh_hours = $2, last_refresh_at = case when $3 then null else last_refresh_at end, updated_at = now() where id = true", [choices, refreshHours, changedChoices]);
  // A forecast fetched for other variables is replaced at the next refresh; nothing is kept that wasn't chosen.
  if (changedChoices) await tx.query("delete from weather_forecast_cache");
  await writeAuditEvent(tx, { eventType: "weather.choices_changed", entityType: "weather_settings", entityId: "metservice", details: { choices, refreshHours } });
  return getWeatherSetup(tx);
}

/** Turns the forecast on or off (WX1). On needs a tested key and at least one farm. Off deletes the kept forecast. */
export async function setWeatherEnabled(tx: OrgTx, enabledInput: unknown): Promise<WeatherSetup> {
  await requireFarming(tx);
  const enabled = requireBoolean(enabledInput, "enabled");
  const row = await settingsRow(tx, true);
  if (enabled) {
    if (!row.api_key_ciphertext) throw new ConflictError("Paste your MetService key first.");
    if (row.status !== "ok") throw new ConflictError("Test the connection first. It needs to say Connected.");
    const pinned = await tx.query<{ n: number }>("select count(*)::int as n from weather_locations");
    if (!pinned.rows[0].n) throw new ConflictError("Choose at least one farm and place its pin first.");
  }
  await tx.query("update weather_settings set enabled = $1, setup_step = case when $1 then 'turn_on' else setup_step end, updated_at = now() where id = true", [enabled]);
  if (!enabled) await tx.query("delete from weather_forecast_cache");
  await writeAuditEvent(tx, { eventType: enabled ? "weather.turned_on" : "weather.turned_off", entityType: "weather_settings", entityId: "metservice", details: {} });
  return getWeatherSetup(tx);
}

// Talking to MetService (no transaction is open while it answers) ----------------------------------------

type FetchPlan = { apiKey: string; choices: WeatherChoice[]; refreshHours: number; keepRecords: boolean; locations: Array<{ farmId: string; latitude: string; longitude: string }> };

async function readPlan(tx: OrgTx): Promise<FetchPlan | null> {
  const row = await settingsRow(tx);
  if (!row.api_key_ciphertext) return null;
  const locations = await tx.query<{ farm_id: string; latitude: string; longitude: string }>(
    "select l.farm_id::text, l.latitude::text, l.longitude::text from weather_locations l join farms f on f.id = l.farm_id where f.is_active order by l.farm_id",
  );
  return {
    apiKey: decryptSecret(row.api_key_ciphertext),
    choices: choicesOf(row),
    refreshHours: row.refresh_hours,
    keepRecords: row.keep_records,
    locations: locations.rows.map((location) => ({ farmId: location.farm_id, latitude: location.latitude, longitude: location.longitude })),
  };
}

/** What a refusal does: a refused key deletes the kept forecast; a refused key, no units or no access stop refreshing (the spending guard). */
async function recordProblem(tx: OrgTx, status: WeatherStatus): Promise<void> {
  await tx.query(
    `update weather_settings set status = $1, tested_at = now(), paused_at = case when $2 then coalesce(paused_at, now()) else paused_at end, updated_at = now() where id = true`,
    [status, stopsRefreshing(status)],
  );
  if (status === "bad_key" || status === "not_allowed") await tx.query("delete from weather_forecast_cache");
  await writeAuditEvent(tx, { eventType: "weather.problem", entityType: "weather_settings", entityId: "metservice", details: { status, refreshingStopped: stopsRefreshing(status) } });
}

export type ConnectionTest = { status: WeatherStatus; statusText: string; unitsCharged: number | null };

/**
 * Test connection (WX7): one hour of one variable at one point, so it costs
 * one unit. Uses the first farm's pin, or the middle of the North Island
 * when no farm has one yet. A good answer clears the spending guard.
 */
export async function testWeatherConnection(organisation: OrganisationRecord, actor: Actor): Promise<ConnectionTest> {
  const plan = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireFarming(tx);
    return readPlan(tx);
  });
  if (!plan) throw new ConflictError("Paste your MetService key first.");
  const point = plan.locations[0] ?? { latitude: "-39.000000", longitude: "175.900000" };
  let status: WeatherStatus = "ok";
  let unitsCharged: number | null = null;
  try {
    const answer = await weatherProvider().fetchForecast({ apiKey: plan.apiKey, point, choices: ["temperature"], now: new Date(), hours: 1 });
    parseForecast(answer.body);
    unitsCharged = answer.unitsCharged;
  } catch (error) {
    status = error instanceof WeatherProviderError ? error.status : "error";
  }
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    if (status === "ok") {
      await tx.query("update weather_settings set status = 'ok', tested_at = now(), paused_at = null, units_charged_last = $1, updated_at = now() where id = true", [unitsCharged]);
      await writeAuditEvent(tx, { eventType: "weather.connection_tested", entityType: "weather_settings", entityId: "metservice", details: { status } });
    } else {
      await recordProblem(tx, status);
    }
  });
  return { status, statusText: STATUS_TEXT[status], unitsCharged };
}

export type RefreshResult = { refreshed: number; failed: number; status: WeatherStatus; skipped?: "off" | "paused" | "not_due" };

/**
 * Fetches each farm's forecast and replaces the kept one (WX3). With the
 * records switch on, each fetch is also kept as a record (WX8). A refusal
 * that stops refreshing ends the run. `manual` is the Refresh button:
 * at most once every 15 minutes (decision 1544).
 */
export async function refreshWeather(organisation: OrganisationRecord, actor: Actor, options: { manual?: boolean; now?: Date } = {}): Promise<RefreshResult> {
  const now = options.now ?? new Date();
  const ready = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const row = await settingsRow(tx, true);
    if (!row.enabled || !row.api_key_ciphertext) return { skipped: "off" as const };
    if (row.paused_at) return { skipped: "paused" as const };
    if (options.manual) {
      const last = row.last_manual_refresh_at ? Date.parse(row.last_manual_refresh_at) : 0;
      const wait = last + MANUAL_REFRESH_MINUTES * 60_000 - now.getTime();
      if (wait > 0) throw new TooManyRequestsError(`The forecast was refreshed a few minutes ago. Try again in ${Math.ceil(wait / 60_000)} minute${Math.ceil(wait / 60_000) === 1 ? "" : "s"}: each refresh uses API units.`, wait / 1000);
      await tx.query("update weather_settings set last_manual_refresh_at = $1 where id = true", [now.toISOString()]);
    } else {
      const due = !row.last_refresh_at || now.getTime() - Date.parse(row.last_refresh_at) >= row.refresh_hours * 3_600_000 - 5 * 60_000;
      if (!due) return { skipped: "not_due" as const };
    }
    // Claimed now, so a second server process doesn't fetch the same refresh.
    await tx.query("update weather_settings set last_refresh_at = $1 where id = true", [now.toISOString()]);
    return { plan: await readPlan(tx) };
  });
  if ("skipped" in ready) return { refreshed: 0, failed: 0, status: "ok", skipped: ready.skipped };
  const plan = ready.plan!;
  let refreshed = 0;
  let failed = 0;
  let status: WeatherStatus = "ok";
  for (const location of plan.locations) {
    let hours: ForecastHour[];
    try {
      const answer = await weatherProvider().fetchForecast({ apiKey: plan.apiKey, point: location, choices: plan.choices, now });
      hours = onlyChosen(parseForecast(answer.body), plan.choices);
    } catch (error) {
      failed += 1;
      status = error instanceof WeatherProviderError ? error.status : "error";
      if (stopsRefreshing(status)) break;
      continue;
    }
    await withOrganisationTransaction(organisation, actor, async (tx) => {
      // Only if the pin is still where it was fetched for.
      const still = await tx.query("select 1 from weather_locations where farm_id = $1 and latitude = $2 and longitude = $3", [location.farmId, location.latitude, location.longitude]);
      if (!still.rowCount) return;
      await tx.query(
        `insert into weather_forecast_cache (farm_id, latitude, longitude, fetched_at, choices, hours) values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (farm_id) do update set latitude = excluded.latitude, longitude = excluded.longitude, fetched_at = excluded.fetched_at, choices = excluded.choices, hours = excluded.hours`,
        [location.farmId, location.latitude, location.longitude, now.toISOString(), plan.choices, JSON.stringify(hours)],
      );
      const keep = await tx.query<{ keep_records: boolean }>("select keep_records from weather_settings where id = true");
      if (keep.rows[0].keep_records) {
        await tx.query("insert into weather_forecast_history (farm_id, latitude, longitude, fetched_at, choices, hours) values ($1, $2, $3, $4, $5, $6::jsonb)", [
          location.farmId,
          location.latitude,
          location.longitude,
          now.toISOString(),
          plan.choices,
          JSON.stringify(hours),
        ]);
      }
    });
    refreshed += 1;
  }
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    if (status === "ok") await tx.query("update weather_settings set status = 'ok', updated_at = now() where id = true and status <> 'ok'");
    else await recordProblem(tx, status);
  });
  return { refreshed, failed, status };
}

// What farm people see ---------------------------------------------------------------------------------

export type FarmForecast = {
  attribution: string;
  warningsNote: string;
  /** Whether the organisation has the forecast set up and on. */
  enabled: boolean;
  /** Whether this farm has a pin. */
  placed: boolean;
  status: WeatherStatus;
  statusText: string;
  paused: boolean;
  refreshHours: number;
  forecast: {
    fetchedAt: string;
    freshness: Freshness;
    point: { latitude: string; longitude: string };
    choices: WeatherChoice[];
    hours: ForecastHour[];
    days: ForecastDay[];
    warnings: ForecastWarning[];
  } | null;
  /** Whether the person may press Refresh (bookkeepers and up). */
  canRefresh: boolean;
  /** Whether records are kept and may be combined with the farm's own records (both switches). */
  combine: boolean;
};

/** A farm's forecast for the card and the Weather page (WX4-WX6). Farm staff and up, on the farms they see. */
export async function getFarmForecast(tx: OrgTx, farmIdInput: unknown, options: { now?: Date; canRefresh?: boolean } = {}): Promise<FarmForecast> {
  await requireFarming(tx);
  const farmId = requireId(farmIdInput, "farmId");
  await requireFarmAccess(tx, farmId);
  const now = options.now ?? new Date();
  const row = await settingsRow(tx);
  const placed = await tx.query("select 1 from weather_locations where farm_id = $1", [farmId]);
  const cached = await tx.query<{ fetched_at: string; latitude: string; longitude: string; choices: string[]; hours: ForecastHour[] }>(
    "select fetched_at::text, latitude::text, longitude::text, choices, hours from weather_forecast_cache where farm_id = $1",
    [farmId],
  );
  const kept = cached.rows[0];
  const usable = kept && row.enabled && !pastCacheLimit(kept.fetched_at, now) ? kept : null;
  const zone = businessTimeZone();
  const ahead = usable ? hoursAhead(usable.hours, now, 168) : [];
  return {
    attribution: METSERVICE_ATTRIBUTION,
    warningsNote: WARNINGS_NOTE,
    enabled: row.enabled,
    placed: Boolean(placed.rowCount),
    status: row.status,
    statusText: STATUS_TEXT[row.status],
    paused: Boolean(row.paused_at),
    refreshHours: row.refresh_hours,
    forecast: usable
      ? {
          fetchedAt: usable.fetched_at,
          freshness: freshness(usable.fetched_at, row.refresh_hours, now),
          point: { latitude: usable.latitude, longitude: usable.longitude },
          choices: usable.choices.filter(isWeatherChoice),
          hours: ahead.slice(0, 48),
          days: forecastDays(ahead, zone).slice(0, 7),
          warnings: forecastWarnings(ahead, zone),
        }
      : null,
    canRefresh: options.canRefresh ?? false,
    combine: row.keep_records && row.combine,
  };
}

/** Deletes kept forecasts that are 24 hours old (decision 1543). Returns how many went. */
export async function sweepOldForecasts(tx: OrgTx, now = new Date()): Promise<number> {
  const deleted = await tx.query("delete from weather_forecast_cache where fetched_at <= $1", [new Date(now.getTime() - 24 * 3_600_000).toISOString()]);
  return deleted.rowCount ?? 0;
}

// Optional forecast records ---------------------------------------------------------------------

/** Enables records after an admin acknowledges responsibility for their use (WX8). */
export async function turnOnRecords(tx: OrgTx, input: { acknowledged: unknown }): Promise<WeatherSetup> {
  await requireFarming(tx);
  if (input.acknowledged !== true) throw new ValidationError("Acknowledge responsibility for complying with MetService's terms before keeping records.");
  await settingsRow(tx, true);
  await tx.query(
    `update weather_settings set keep_records = true, keep_records_set_at = now(),
       keep_records_set_by_email = $1, updated_at = now() where id = true`,
    [tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "weather.records_turned_on",
    entityType: "weather_settings",
    entityId: "metservice",
    details: { acknowledged: true, acknowledgement: "I'm responsible for ensuring my use complies with MetService's terms." },
  });
  return getWeatherSetup(tx);
}

/**
 * Turns keeping records off (WX10). The records are deleted unless the
 * admin chooses to keep them (`deleteRecords` false): MetService's terms
 * want them deleted once they may no longer be kept. Combining goes off too.
 */
export async function turnOffRecords(tx: OrgTx, input: { deleteRecords?: unknown }): Promise<WeatherSetup & { recordsDeleted: number }> {
  await requireFarming(tx);
  const deleteRecords = input.deleteRecords === undefined ? true : requireBoolean(input.deleteRecords, "deleteRecords");
  const row = await settingsRow(tx, true);
  if (!row.keep_records) throw new ConflictError("Forecast records aren't being kept.");
  await tx.query(
    `update weather_settings set keep_records = false, combine = false, keep_records_set_at = now(), keep_records_set_by_email = $1,
       combine_set_at = case when combine then now() else combine_set_at end, combine_set_by_email = case when combine then $1 else combine_set_by_email end,
       updated_at = now() where id = true`,
    [tx.actor.email],
  );
  const deleted = deleteRecords ? ((await tx.query("delete from weather_forecast_history")).rowCount ?? 0) : 0;
  await writeAuditEvent(tx, { eventType: "weather.records_turned_off", entityType: "weather_settings", entityId: "metservice", details: { recordsDeleted: deleted, kept: !deleteRecords } });
  return { ...(await getWeatherSetup(tx)), recordsDeleted: deleted };
}

/** Deletes every kept forecast record now (WX10), e.g. ones kept when records were turned off. */
export async function deleteForecastRecords(tx: OrgTx): Promise<WeatherSetup & { recordsDeleted: number }> {
  await requireFarming(tx);
  const deleted = (await tx.query("delete from weather_forecast_history")).rowCount ?? 0;
  await writeAuditEvent(tx, { eventType: "weather.records_deleted", entityType: "weather_settings", entityId: "metservice", details: { recordsDeleted: deleted } });
  return { ...(await getWeatherSetup(tx)), recordsDeleted: deleted };
}

/** The second switch (WX9) enables comparisons, Analytics and AI access. Needs records on. */
export async function setCombine(tx: OrgTx, onInput: unknown): Promise<WeatherSetup> {
  await requireFarming(tx);
  const on = requireBoolean(onInput, "combine");
  const row = await settingsRow(tx, true);
  if (on && !row.keep_records) throw new ConflictError("Turn on keeping forecast records first.");
  if (row.combine === on) return getWeatherSetup(tx);
  await tx.query("update weather_settings set combine = $1, combine_set_at = now(), combine_set_by_email = $2, updated_at = now() where id = true", [on, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: on ? "weather.combine_turned_on" : "weather.combine_turned_off", entityType: "weather_settings", entityId: "metservice", details: {} });
  return getWeatherSetup(tx);
}

/** The permission file, to download (admins). */
export async function getPermissionFile(tx: OrgTx): Promise<{ fileName: string; contentType: string; content: Uint8Array }> {
  const row = await tx.query<{ file_name: string; content_type: string; content: Buffer }>("select file_name, content_type, content from weather_permission_files where id = true");
  if (!row.rows[0]) throw new NotFoundError("No permission file is attached.");
  return { fileName: row.rows[0].file_name, contentType: row.rows[0].content_type, content: new Uint8Array(row.rows[0].content) };
}

/** Refuses unless records and combining are enabled (WX9). */
export async function requireCombine(tx: OrgTx): Promise<void> {
  const row = await settingsRow(tx);
  if (!row.keep_records || !row.combine) {
    throw new ConflictError("Enable forecast records and combining in Settings, Weather forecast to use comparisons, Analytics and AI access.");
  }
}

export type ForecastRecord = { id: string; farmId: string; fetchedAt: string; point: { latitude: string; longitude: string }; choices: WeatherChoice[]; hours: ForecastHour[] };

/** Kept forecast records for a farm (WX9; both switches). */
export async function listForecastRecords(tx: OrgTx, input: { farmId: unknown; from?: unknown; to?: unknown; limit?: number }): Promise<ForecastRecord[]> {
  await requireFarming(tx);
  await requireCombine(tx);
  const farmId = requireId(input.farmId, "farmId");
  await requireFarmAccess(tx, farmId);
  const from = input.from ? parseIsoDate(input.from, "from") : null;
  const to = input.to ? parseIsoDate(input.to, "to") : null;
  const rows = await tx.query<{ id: string; farm_id: string; fetched_at: string; latitude: string; longitude: string; choices: string[]; hours: ForecastHour[] }>(
    `select h.id::text, h.farm_id::text, h.fetched_at::text, h.latitude::text, h.longitude::text, h.choices, h.hours from weather_forecast_history h
      where h.farm_id = $1 and ($2::date is null or h.fetched_at >= $2::date - interval '1 day') and ($3::date is null or h.fetched_at < $3::date + interval '1 day')
      order by h.fetched_at desc, h.id desc limit $4`,
    [farmId, from, to, Math.min(Math.max(input.limit ?? 500, 1), 2000)],
  );
  return rows.rows.map((row) => ({ id: row.id, farmId: row.farm_id, fetchedAt: row.fetched_at, point: { latitude: row.latitude, longitude: row.longitude }, choices: row.choices.filter(isWeatherChoice), hours: row.hours }));
}

export type GaugeComparisonDay = { rainDay: string; gaugeMm: string | null; forecastMm: string | null; difference: string | null; forecastFetchedAt: string | null };

/**
 * Forecast vs your rain gauge (WX9): for each rain day (9 am to 9 am), the
 * gauge's reading and the rain forecast for it by the last forecast fetched
 * before the day began. Both switches must be on.
 */
export async function forecastVsGauge(tx: OrgTx, input: { farmId: unknown; gaugeId?: unknown; days?: unknown }): Promise<{ gauge: { id: string; name: string } | null; days: GaugeComparisonDay[] }> {
  await requireFarming(tx);
  await requireCombine(tx);
  const farmId = requireId(input.farmId, "farmId");
  await requireFarmAccess(tx, farmId);
  const gauges = await tx.query<{ id: string; name: string }>("select g.id::text, g.name from rain_gauges g where g.farm_id = $1 and g.is_active order by lower(g.name), g.id", [farmId]);
  const gaugeId = input.gaugeId ? requireId(input.gaugeId, "gaugeId") : (gauges.rows[0]?.id ?? null);
  const gauge = gauges.rows.find((entry) => entry.id === gaugeId) ?? null;
  if (input.gaugeId && !gauge) throw new NotFoundError("Rain gauge not found on this farm.");
  const count = Math.min(Math.max(Number(input.days ?? 14) || 14, 1), 60);
  const zone = businessTimeZone();
  const lastRainDay = latestRainDay(todayIsoDate(zone));
  const days: GaugeComparisonDay[] = [];
  const records = await tx.query<{ fetched_at: string; hours: ForecastHour[] }>(
    "select fetched_at::text, hours from weather_forecast_history where farm_id = $1 and fetched_at >= now() - ($2::int + 2) * interval '1 day' order by fetched_at",
    [farmId, count],
  );
  const readings = gauge
    ? (await tx.query<{ read_on: string; mm: string }>("select read_on::text, mm::text from rainfall_readings where gauge_id = $1 and status = 'active' and read_on > $2::date - $3::int", [gauge.id, lastRainDay, count])).rows
    : [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const rainDay = new Date(Date.parse(`${lastRainDay}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    // The day begins at 9 am local; take the last record fetched before then.
    const begins = zonedNine(rainDay, zone);
    const before = records.rows.filter((record) => Date.parse(record.fetched_at) <= begins);
    const record = before[before.length - 1] ?? null;
    const forecastMm = record ? rainDayForecast(record.hours, rainDay, zone) : null;
    // A reading is kept under its rain day (decision 1452).
    const reading = readings.find((entry) => entry.read_on === rainDay) ?? null;
    days.push({
      rainDay,
      gaugeMm: reading?.mm ?? null,
      forecastMm,
      difference: reading && forecastMm !== null ? rainDifference(reading.mm, forecastMm) : null,
      forecastFetchedAt: forecastMm !== null ? record!.fetched_at : null,
    });
  }
  return { gauge, days };
}

/** A moment's wall-clock time in a time zone, read as if it were UTC (ms). */
function wallAsUtc(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
}

/** 9 am on a date in a time zone, as a moment (ms). */
export function zonedNine(date: string, timeZone: string): number {
  const wall = Date.parse(`${date}T09:00:00Z`);
  const first = wall - (wallAsUtc(wall, timeZone) - wall);
  return wall - (wallAsUtc(first, timeZone) - first);
}

/** For tests: whether an organisation has any forecast kept. */
export async function keptForecastCount(tx: OrgTx): Promise<{ cache: number; records: number }> {
  const cache = await tx.query<{ n: number }>("select count(*)::int as n from weather_forecast_cache");
  const records = await tx.query<{ n: number }>("select count(*)::int as n from weather_forecast_history");
  return { cache: cache.rows[0].n, records: records.rows[0].n };
}

