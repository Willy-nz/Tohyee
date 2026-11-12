import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm, requireFarmAccess, requirePaddockAccess, visibleFarmIds } from "@/lib/farming/access";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import { requireFarming } from "@/lib/farming/paddocks";
import type { ProviderId, SceneCandidate } from "@/lib/farming/vegetation/provider";
import type { Grid } from "@/lib/farming/vegetation/raster";
import { attributionText, farmState, PROCESSOR_VERSION, type Quality, type QualityFlag, THRESHOLD_LIMITS, type VegetationState } from "@/lib/farming/vegetation/rules";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import type { ModelledCover } from "@/lib/farming/vegetation/cover-fit";
import { activeCoverModel, type CoverModel, estimateFor, usesWeather } from "@/lib/farming/vegetation/cover-estimates";
import { weatherMaps } from "@/lib/farming/weather-history";
import { rainBefore, RAIN_WINDOW_DAYS, shiftDay, temperatureBefore } from "@/lib/farming/weather-history-rules";
import { requireId } from "@/lib/validation";

/*
 * Satellite vegetation in the organisation's database (#612, decisions
 * 1520-1540): the connection and limits, which farms, the dates fetched and
 * each paddock's numbers. No network calls here: the provider is called by
 * the worker (jobs.ts) and the routes between transactions. Every farm and
 * paddock read checks the person may see that farm (decision 744).
 */

export const LICENCE = "Copernicus Sentinel data licence (free, full and open; attribution required)";
export const DEMO_LICENCE = "Made-up demo pictures; no licence applies";

// Settings ----------------------------------------------------------------------------------------

type SettingsRow = {
  provider: ProviderId | null;
  client_id: string | null;
  client_secret_ciphertext: string | null;
  connected_by_email: string | null;
  connected_at: string | null;
  connection_status: "none" | "ok" | "reconnect";
  connection_error: string | null;
  enabled: boolean;
  monthly_unit_budget: string;
  monthly_request_budget: number;
  storage_cap_bytes: string;
  min_coverage_pct: number;
  min_valid_pixels: number;
  history_days: number;
  retention_days: number;
  paused_reason: "quota" | "requests" | "storage" | "disk_full" | null;
  paused_at: string | null;
  last_test: PilotResult | null;
};

/** What "Test one farm" measured (decision 1537): figures from one real fetch, never estimates passed off as measured. */
export type PilotResult = {
  farmId: string;
  farmName: string;
  ranAt: string;
  provider: ProviderId;
  acquiredAt: string | null;
  datesFound: number;
  width: number;
  height: number;
  bytes: number;
  searchMs: number;
  fetchMs: number;
  processMs: number;
  unitsSpent: number | null;
  unitsEstimated: number;
  rssBeforeMb: number;
  rssAfterMb: number;
  clearPct: number | null;
  error: string | null;
};

/** The settings as the screens see them: never the secret. */
export type VegetationSettings = {
  provider: ProviderId | null;
  /** Only the end of the client ID, so it can be recognised. */
  clientIdHint: string | null;
  connectedByEmail: string | null;
  connectedAt: string | null;
  connectionStatus: "none" | "ok" | "reconnect";
  connectionError: string | null;
  enabled: boolean;
  monthlyUnitBudget: string;
  monthlyRequestBudget: number;
  storageCapBytes: number;
  minCoveragePct: number;
  minValidPixels: number;
  historyDays: number;
  retentionDays: number;
  pausedReason: SettingsRow["paused_reason"];
  pausedAt: string | null;
  lastTest: PilotResult | null;
  usage: { month: string; units: string; requests: number; bytesFetched: number; storedBytes: number };
};

const SETTINGS_COLUMNS = `provider, client_id, client_secret_ciphertext, connected_by_email, to_char(connected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as connected_at,
  connection_status, connection_error, enabled, monthly_unit_budget::text, monthly_request_budget, storage_cap_bytes::text, min_coverage_pct, min_valid_pixels,
  history_days, retention_days, paused_reason, to_char(paused_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as paused_at, last_test`;

export async function settingsRow(tx: OrgTx): Promise<SettingsRow> {
  await tx.query("insert into vegetation_settings (id) values (true) on conflict (id) do nothing");
  return (await tx.query<SettingsRow>(`select ${SETTINGS_COLUMNS} from vegetation_settings where id = true`)).rows[0];
}

/** The first day of this month (UTC), when the month's budget starts (unverified: whether the provider's month is the calendar month). */
export function monthStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01T00:00:00Z`;
}

export async function usageThisMonth(tx: OrgTx, now = new Date()): Promise<VegetationSettings["usage"]> {
  const used = await tx.query<{ units: string; requests: number; bytes: string }>(
    "select coalesce(sum(units_spent), 0)::text as units, coalesce(sum(requests), 0)::int as requests, coalesce(sum(bytes_fetched), 0)::text as bytes from vegetation_jobs where coalesce(finished_at, claimed_at, created_at) >= $1::timestamptz",
    [monthStart(now)],
  );
  const stored = await tx.query<{ bytes: string }>("select coalesce(sum(bytes), 0)::text as bytes from vegetation_scenes where files_removed_at is null");
  return { month: now.toISOString().slice(0, 7), units: Number(used.rows[0].units).toFixed(2), requests: used.rows[0].requests, bytesFetched: Number(used.rows[0].bytes), storedBytes: Number(stored.rows[0].bytes) };
}

export async function getVegetationSettings(tx: OrgTx): Promise<VegetationSettings> {
  await requireFarming(tx);
  const row = await settingsRow(tx);
  return {
    provider: row.provider,
    clientIdHint: row.client_id ? `…${row.client_id.slice(-4)}` : null,
    connectedByEmail: row.connected_by_email,
    connectedAt: row.connected_at,
    connectionStatus: row.connection_status,
    connectionError: row.connection_error,
    enabled: row.enabled,
    monthlyUnitBudget: Number(row.monthly_unit_budget).toFixed(2),
    monthlyRequestBudget: row.monthly_request_budget,
    storageCapBytes: Number(row.storage_cap_bytes),
    minCoveragePct: row.min_coverage_pct,
    minValidPixels: row.min_valid_pixels,
    historyDays: row.history_days,
    retentionDays: row.retention_days,
    pausedReason: row.paused_reason,
    pausedAt: row.paused_at,
    lastTest: row.last_test,
    usage: await usageThisMonth(tx),
  };
}

/** The provider and its credentials, for the worker and routes only. Never returned to a browser, logged or given to the AI (decision 1523). */
export async function providerCredentials(tx: OrgTx): Promise<{ provider: ProviderId; clientId: string; clientSecret: string } | null> {
  const row = await settingsRow(tx);
  if (!row.provider) return null;
  if (row.provider === "demo") return { provider: "demo", clientId: "", clientSecret: "" };
  if (!row.client_id || !row.client_secret_ciphertext) return null;
  return { provider: "copernicus", clientId: row.client_id, clientSecret: decryptSecret(row.client_secret_ciphertext) };
}

/** Checks a connection's fields before anything is sent anywhere. */
export function parseConnection(input: { provider?: unknown; clientId?: unknown; clientSecret?: unknown }): { provider: ProviderId; clientId: string; clientSecret: string } {
  if (input.provider === "demo") return { provider: "demo", clientId: "", clientSecret: "" };
  if (input.provider !== "copernicus") throw new ValidationError("Choose Copernicus.");
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
  if (!/^[A-Za-z0-9._:-]{4,200}$/.test(clientId)) throw new ValidationError("Paste the client ID from your Copernicus account's OAuth clients.");
  if (clientSecret.length < 8 || clientSecret.length > 500 || /\s/.test(clientSecret)) throw new ValidationError("Paste the client secret shown when you made the OAuth client.");
  return { provider: "copernicus", clientId, clientSecret };
}

/** Saves a connection that was just checked (decision 1523). The secret is encrypted with the server's key. */
export async function saveConnection(tx: OrgTx, connection: { provider: ProviderId; clientId: string; clientSecret: string }): Promise<VegetationSettings> {
  await requireFarming(tx);
  await settingsRow(tx);
  await tx.query(
    `update vegetation_settings set provider = $1, client_id = $2, client_secret_ciphertext = $3, connected_by_email = $4, connected_at = now(),
       connection_status = 'ok', connection_error = null, updated_by_email = $4, updated_at = now() where id = true`,
    [connection.provider, connection.provider === "demo" ? null : connection.clientId, connection.provider === "demo" ? null : encryptSecret(connection.clientSecret), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.vegetation_connected", entityType: "vegetation_settings", entityId: "1", details: { provider: connection.provider } });
  return getVegetationSettings(tx);
}

/** The provider refused the account: stop until someone connects again (decision 1534). */
export async function markReconnect(tx: OrgTx, message: string): Promise<void> {
  await tx.query("update vegetation_settings set connection_status = 'reconnect', connection_error = $1 where id = true", [message.slice(0, 500)]);
}

export async function disconnect(tx: OrgTx): Promise<VegetationSettings> {
  await requireFarming(tx);
  await settingsRow(tx);
  await tx.query("update vegetation_settings set provider = null, client_id = null, client_secret_ciphertext = null, connection_status = 'none', connection_error = null, enabled = false, updated_by_email = $1, updated_at = now() where id = true", [tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.vegetation_disconnected", entityType: "vegetation_settings", entityId: "1", details: {} });
  return getVegetationSettings(tx);
}

function whole(value: unknown, label: string, limits: { min: number; max: number }): number {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < limits.min || number > limits.max) throw new ValidationError(`${label} must be a whole number from ${limits.min} to ${limits.max}.`);
  return number;
}

/** Changes the limits, thresholds and on/off (decision 1530), and "Carry on" after a pause. */
export async function updateVegetationSettings(
  tx: OrgTx,
  input: { enabled?: unknown; monthlyUnitBudget?: unknown; monthlyRequestBudget?: unknown; storageCapMb?: unknown; minCoveragePct?: unknown; minValidPixels?: unknown; historyDays?: unknown; retentionDays?: unknown; resume?: unknown },
): Promise<VegetationSettings> {
  await requireFarming(tx);
  const before = await settingsRow(tx);
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new ValidationError("Choose on or off.");
    if (input.enabled && (!before.provider || before.connection_status !== "ok")) throw new ValidationError("Connect an imagery account first.");
    set("enabled", input.enabled);
  }
  if (input.monthlyUnitBudget !== undefined) set("monthly_unit_budget", whole(input.monthlyUnitBudget, "The processing budget", THRESHOLD_LIMITS.monthlyUnitBudget));
  if (input.monthlyRequestBudget !== undefined) set("monthly_request_budget", whole(input.monthlyRequestBudget, "The request budget", THRESHOLD_LIMITS.monthlyRequestBudget));
  if (input.storageCapMb !== undefined) set("storage_cap_bytes", whole(input.storageCapMb, "The storage limit (MB)", THRESHOLD_LIMITS.storageCapMb) * 1024 * 1024);
  if (input.minCoveragePct !== undefined) set("min_coverage_pct", whole(input.minCoveragePct, "The least clear share of a paddock", THRESHOLD_LIMITS.minCoveragePct));
  if (input.minValidPixels !== undefined) set("min_valid_pixels", whole(input.minValidPixels, "The fewest clear pixels", THRESHOLD_LIMITS.minValidPixels));
  if (input.historyDays !== undefined) set("history_days", whole(input.historyDays, "Days of history", THRESHOLD_LIMITS.historyDays));
  if (input.retentionDays !== undefined) set("retention_days", whole(input.retentionDays, "Days to keep pictures", THRESHOLD_LIMITS.retentionDays));
  if (input.resume === true) {
    sets.push("paused_reason = null", "paused_at = null");
  }
  if (!sets.length) return getVegetationSettings(tx);
  set("updated_by_email", tx.actor.email);
  sets.push("updated_at = now()");
  await tx.query(`update vegetation_settings set ${sets.join(", ")} where id = true`, values);
  await writeAuditEvent(tx, { eventType: "farming.vegetation_settings_changed", entityType: "vegetation_settings", entityId: "1", details: { changed: Object.keys(input) } });
  return getVegetationSettings(tx);
}

export async function pauseFetching(tx: OrgTx, reason: NonNullable<SettingsRow["paused_reason"]>): Promise<void> {
  await tx.query("update vegetation_settings set paused_reason = $1, paused_at = now() where id = true and paused_reason is distinct from $1", [reason]);
}

export async function saveLastTest(tx: OrgTx, result: PilotResult): Promise<void> {
  await settingsRow(tx);
  await tx.query("update vegetation_settings set last_test = $1::jsonb where id = true", [JSON.stringify(result)]);
}

// Farms and boundaries --------------------------------------------------------------------------

export type CurrentBoundary = { paddockId: string; name: string; boundaryId: string; geometry: PaddockGeometry; mappedHa: string };

/** Each active paddock's current boundary on a farm (the newest version, decision 1528). */
export async function currentBoundaries(tx: OrgTx, farmId: string): Promise<CurrentBoundary[]> {
  const rows = await tx.query<{ paddock_id: string; name: string; boundary_id: string; geometry: PaddockGeometry; mapped_ha: string }>(
    `select p.id::text as paddock_id, p.name, b.id::text as boundary_id, b.geometry, round(b.mapped_ha, 2)::text as mapped_ha
       from paddocks p
       join lateral (select id, geometry, mapped_ha from paddock_boundaries pb where pb.paddock_id = p.id order by pb.id desc limit 1) b on true
      where p.farm_id = $1 and p.status = 'active'
      order by lower(p.name), p.id`,
    [farmId],
  );
  return rows.rows.map((row) => ({ paddockId: row.paddock_id, name: row.name, boundaryId: row.boundary_id, geometry: row.geometry, mappedHa: row.mapped_ha }));
}

/**
 * The boundaries confirmed when the farm was turned on (decision 1520;
 * issue #619): the area sent to the provider. A boundary edited or a
 * paddock added since isn't sent until they're confirmed again. Paddocks
 * no longer active are left out.
 */
export async function confirmedBoundaries(tx: OrgTx, farmId: string): Promise<CurrentBoundary[]> {
  const rows = await tx.query<{ paddock_id: string; name: string; boundary_id: string; geometry: PaddockGeometry; mapped_ha: string }>(
    `select p.id::text as paddock_id, p.name, b.id::text as boundary_id, b.geometry, round(b.mapped_ha, 2)::text as mapped_ha
       from vegetation_farms vf
       join paddock_boundaries b on b.id = any(vf.confirmed_boundary_ids)
       join paddocks p on p.id = b.paddock_id and p.farm_id = vf.farm_id and p.status = 'active'
      where vf.farm_id = $1
      order by lower(p.name), p.id`,
    [farmId],
  );
  return rows.rows.map((row) => ({ paddockId: row.paddock_id, name: row.name, boundaryId: row.boundary_id, geometry: row.geometry, mappedHa: row.mapped_ha }));
}

/** Whether a farm's pictures are on and the farm is active (issue #619): checked just before each request. */
export async function farmPicturesOn(tx: OrgTx, farmId: string): Promise<boolean> {
  const row = await tx.query("select 1 from vegetation_farms vf join farms f on f.id = vf.farm_id where vf.farm_id = $1 and vf.enabled and f.is_active", [farmId]);
  return Boolean(row.rowCount);
}

/**
 * A farm's waiting checks and downloads, when it's turned off (issue
 * #619). Ones that haven't spent anything go (so they're queued afresh
 * when it's on again); any that have are marked skipped, keeping what they
 * spent in the month's count.
 */
async function cancelFarmJobs(tx: OrgTx, farmId: string): Promise<number> {
  const gone = await tx.query(
    "delete from vegetation_jobs where farm_id = $1 and status = 'queued' and kind in ('discover', 'fetch') and units_spent = 0 and requests = 0 and bytes_fetched = 0 and checkpoint = '{}'::jsonb",
    [farmId],
  );
  const skipped = await tx.query("update vegetation_jobs set status = 'skipped', finished_at = now(), last_error = 'The farm was turned off.' where farm_id = $1 and status = 'queued' and kind in ('discover', 'fetch')", [farmId]);
  return (gone.rowCount ?? 0) + (skipped.rowCount ?? 0);
}

async function requireFarm(tx: OrgTx, input: unknown): Promise<{ id: string; name: string }> {
  await requireFarming(tx);
  const farmId = requireId(input, "farmId");
  const farm = await tx.query<{ id: string; name: string }>("select id::text, name from farms where id = $1", [farmId]);
  if (!farm.rows[0]) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  return farm.rows[0];
}

export type FarmSetup = { farmId: string; enabled: boolean; confirmedBoundaryIds: string[]; confirmedByEmail: string | null; confirmedAt: string | null; boundariesChanged: boolean; lastCheckedAt: string | null; lastCheckError: string | null };

async function farmSetup(tx: OrgTx, farmId: string): Promise<FarmSetup> {
  const row = (
    await tx.query<{ enabled: boolean; ids: string[]; confirmed_by_email: string | null; confirmed_at: string | null; last_checked_at: string | null; last_check_error: string | null }>(
      `select enabled, confirmed_boundary_ids::text[] as ids, confirmed_by_email, to_char(confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as confirmed_at,
              to_char(last_checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_checked_at, last_check_error
         from vegetation_farms where farm_id = $1`,
      [farmId],
    )
  ).rows[0];
  const current = (await currentBoundaries(tx, farmId)).map((boundary) => boundary.boundaryId).sort();
  const confirmed = [...(row?.ids ?? [])].sort();
  return {
    farmId,
    enabled: row?.enabled ?? false,
    confirmedBoundaryIds: confirmed,
    confirmedByEmail: row?.confirmed_by_email ?? null,
    confirmedAt: row?.confirmed_at ?? null,
    boundariesChanged: Boolean(row?.confirmed_at) && current.join(",") !== confirmed.join(","),
    lastCheckedAt: row?.last_checked_at ?? null,
    lastCheckError: row?.last_check_error ?? null,
  };
}

/**
 * Turns pictures on or off for a farm (decision 1520). Turning on confirms
 * the paddock boundaries as they are now: they're the area sent to the
 * provider. The first check is due straight away.
 */
export async function setFarmVegetation(tx: OrgTx, farmIdInput: unknown, input: { enabled: unknown }): Promise<FarmSetup> {
  const farm = await requireFarm(tx, farmIdInput);
  if (typeof input.enabled !== "boolean") throw new ValidationError("Choose on or off.");
  const boundaries = await currentBoundaries(tx, farm.id);
  if (input.enabled && boundaries.length === 0) throw new ValidationError("This farm has no paddock boundaries yet. Import or draw them first.");
  await tx.query(
    `insert into vegetation_farms (farm_id, enabled, confirmed_boundary_ids, confirmed_by_email, confirmed_at, next_check_at, updated_by_email, updated_at)
       values ($1, $2, $3::bigint[], $4, case when $2 then now() end, case when $2 then now() end, $4, now())
     on conflict (farm_id) do update set enabled = excluded.enabled,
       confirmed_boundary_ids = case when excluded.enabled then excluded.confirmed_boundary_ids else vegetation_farms.confirmed_boundary_ids end,
       confirmed_by_email = case when excluded.enabled then excluded.confirmed_by_email else vegetation_farms.confirmed_by_email end,
       confirmed_at = case when excluded.enabled then excluded.confirmed_at else vegetation_farms.confirmed_at end,
       next_check_at = case when excluded.enabled then coalesce(vegetation_farms.next_check_at, now()) else null end,
       updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [farm.id, input.enabled, boundaries.map((boundary) => boundary.boundaryId), tx.actor.email],
  );
  const cancelled = input.enabled ? 0 : await cancelFarmJobs(tx, farm.id);
  await writeAuditEvent(tx, { eventType: input.enabled ? "farming.vegetation_farm_on" : "farming.vegetation_farm_off", entityType: "farm", entityId: farm.id, details: input.enabled ? { boundaries: boundaries.length } : { boundaries: boundaries.length, jobsCancelled: cancelled } });
  return farmSetup(tx, farm.id);
}

export type SetupFarm = FarmSetup & { farmName: string; paddocks: number; withBoundary: number; mappedHa: string; smallPaddocks: string[] };

/** Every active farm with its satellite setup, for the setup steps (owners and admins see every farm). */
export async function listVegetationFarms(tx: OrgTx): Promise<SetupFarm[]> {
  await requireFarming(tx);
  const visible = await visibleFarmIds(tx);
  const farms = await tx.query<{ id: string; name: string; paddocks: number }>(
    "select f.id::text, f.name, (select count(*)::int from paddocks p where p.farm_id = f.id and p.status = 'active') as paddocks from farms f where f.is_active and ($1::bigint[] is null or f.id = any($1::bigint[])) order by lower(f.name), f.id",
    [visible],
  );
  const result: SetupFarm[] = [];
  for (const farm of farms.rows) {
    const boundaries = await currentBoundaries(tx, farm.id);
    const total = boundaries.reduce((sum, boundary) => sum + Number(boundary.mappedHa), 0);
    result.push({
      ...(await farmSetup(tx, farm.id)),
      farmName: farm.name,
      paddocks: farm.paddocks,
      withBoundary: boundaries.length,
      mappedHa: total.toFixed(2),
      // Under 0.6 ha is about 60 pixels: likely flagged small (decision 1530).
      smallPaddocks: boundaries.filter((boundary) => Number(boundary.mappedHa) < 0.6).map((boundary) => boundary.name),
    });
  }
  return result;
}

// Jobs ------------------------------------------------------------------------------------------

/** Adds a job unless one with the same key exists (decision 1534): asking twice is one job. True when added. */
export async function enqueueJob(tx: OrgTx, job: { farmId: string | null; kind: "discover" | "fetch" | "reprocess" | "test"; key: string; payload?: Record<string, unknown>; status?: "queued" | "running" }): Promise<boolean> {
  const added = await tx.query(
    "insert into vegetation_jobs (farm_id, kind, job_key, payload, status, created_by_email) values ($1, $2, $3, $4::jsonb, $5, $6) on conflict (job_key) do nothing",
    [job.farmId, job.kind, job.key, JSON.stringify(job.payload ?? {}), job.status ?? "queued", tx.actor.email],
  );
  return (added.rowCount ?? 0) > 0;
}

/** A pass to fetch, unless that date is already done with this processor (decision 1534). */
export async function enqueueFetch(tx: OrgTx, farmId: string, candidate: SceneCandidate): Promise<boolean> {
  const done = await tx.query("select 1 from vegetation_scenes where farm_id = $1 and acquired_at = $2::timestamptz and processor_version = $3", [farmId, candidate.acquiredAt, PROCESSOR_VERSION]);
  if (done.rowCount) return false;
  return enqueueJob(tx, { farmId, kind: "fetch", key: `fetch:${farmId}:${candidate.acquiredAt}:${PROCESSOR_VERSION}`, payload: { candidate } });
}

/** At most one manual check a farm every 15 minutes (decision 1527). */
export const MANUAL_CHECK_MINUTES = 15;

/** "Check now": a discovery job for the farm, at most every 15 minutes. */
export async function requestCheck(tx: OrgTx, farmIdInput: unknown, now = new Date()): Promise<{ queued: boolean; nextAllowedAt: string }> {
  const farm = await requireFarm(tx, farmIdInput);
  const setup = await farmSetup(tx, farm.id);
  if (!setup.enabled) throw new ValidationError("Satellite vegetation isn't on for this farm.");
  const slot = Math.floor(now.getTime() / (MANUAL_CHECK_MINUTES * 60_000)) * MANUAL_CHECK_MINUTES * 60_000;
  const queued = await enqueueJob(tx, { farmId: farm.id, kind: "discover", key: `discover:${farm.id}:manual:${new Date(slot).toISOString()}`, payload: { manual: true } });
  return { queued, nextAllowedAt: new Date(slot + MANUAL_CHECK_MINUTES * 60_000).toISOString() };
}

/** Works out a date's numbers again with today's boundaries, while its picture is still kept (decision 1528). Earlier numbers stay. */
export async function requestReprocess(tx: OrgTx, sceneIdInput: unknown): Promise<{ queued: boolean }> {
  await requireFarming(tx);
  const sceneId = requireId(sceneIdInput, "sceneId");
  const scene = await tx.query<{ farm_id: string; raw_path: string | null; files_removed_at: string | null }>("select farm_id::text, raw_path, files_removed_at::text from vegetation_scenes where id = $1", [sceneId]);
  if (!scene.rows[0] || !(await canSeeFarm(tx, scene.rows[0].farm_id))) throw new NotFoundError("Satellite date not found.");
  if (!scene.rows[0].raw_path || scene.rows[0].files_removed_at) throw new ValidationError("That date's picture is no longer kept, so it can't be worked out again. Its numbers stay as they were.");
  const boundaries = (await currentBoundaries(tx, scene.rows[0].farm_id)).map((boundary) => boundary.boundaryId).join(",");
  const queued = await enqueueJob(tx, { farmId: scene.rows[0].farm_id, kind: "reprocess", key: `reprocess:${sceneId}:${PROCESSOR_VERSION}:${boundaries}`, payload: { sceneId } });
  await writeAuditEvent(tx, { eventType: "farming.vegetation_reprocess", entityType: "vegetation_scene", entityId: sceneId, details: { queued } });
  return { queued };
}

// Scenes and observations ---------------------------------------------------------------------

export type ObservationInput = {
  paddockId: string;
  boundaryId: string;
  totalPixels: number;
  validPixels: number;
  edgePixels: number;
  coveragePct: number | null;
  meanNdvi: number | null;
  medianNdvi: number | null;
  quality: Quality;
  flags: QualityFlag[];
  changeNdvi: number | null;
  changePixels: number | null;
};

export type SceneInput = {
  farmId: string;
  provider: ProviderId;
  candidate: SceneCandidate;
  retrievedAt: string;
  dnOffset: number;
  grid: Grid;
  farmValidPct: number | null;
  usable: boolean;
  unitsSpent: number | null;
  unitsEstimated: number;
  rawPath: string;
  overlayPath: string;
  changePath: string | null;
  changeFromSceneId: string | null;
  bytes: number;
  sha256: string;
};

/**
 * Records a date and its paddocks' numbers. Doing it twice (a restart, a
 * retry) changes nothing: the date and each paddock-boundary pair are
 * unique (decision 1534). Returns the date's id.
 */
export async function recordScene(tx: OrgTx, scene: SceneInput, observations: ObservationInput[]): Promise<string> {
  const good = observations.filter((observation) => observation.quality === "good").length;
  const inserted = await tx.query<{ id: string }>(
    `insert into vegetation_scenes (farm_id, provider, acquired_at, retrieved_at, product_ids, processing_baseline, platform, scene_cloud_pct, processor_version, dn_offset, licence, grid,
        farm_valid_pct, usable, paddocks_good, units_spent, units_estimated, raw_path, overlay_path, change_path, change_from_scene_id, bytes, sha256)
     values ($1, $2, $3::timestamptz, $4::timestamptz, $5::text[], $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     on conflict (farm_id, acquired_at, processor_version) do nothing returning id::text`,
    [
      scene.farmId,
      scene.provider,
      scene.candidate.acquiredAt,
      scene.retrievedAt,
      scene.candidate.productIds,
      scene.candidate.processingBaseline,
      scene.candidate.platform,
      scene.candidate.sceneCloudPct,
      PROCESSOR_VERSION,
      scene.dnOffset,
      scene.provider === "demo" ? DEMO_LICENCE : LICENCE,
      JSON.stringify(scene.grid),
      scene.farmValidPct,
      scene.usable,
      good,
      scene.unitsSpent,
      scene.unitsEstimated,
      scene.rawPath,
      scene.overlayPath,
      scene.changePath,
      scene.changeFromSceneId,
      scene.bytes,
      scene.sha256,
    ],
  );
  const sceneId =
    inserted.rows[0]?.id ??
    (await tx.query<{ id: string }>("select id::text from vegetation_scenes where farm_id = $1 and acquired_at = $2::timestamptz and processor_version = $3", [scene.farmId, scene.candidate.acquiredAt, PROCESSOR_VERSION])).rows[0].id;
  await addObservations(tx, sceneId, scene.farmId, scene.candidate.acquiredAt, scene.changeFromSceneId, observations);
  return sceneId;
}

export async function addObservations(tx: OrgTx, sceneId: string, farmId: string, acquiredAt: string, changeFromSceneId: string | null, observations: ObservationInput[]): Promise<number> {
  let added = 0;
  for (const o of observations) {
    const result = await tx.query(
      `insert into vegetation_observations (scene_id, farm_id, paddock_id, boundary_id, processor_version, acquired_at, total_pixels, valid_pixels, edge_pixels, coverage_pct, mean_ndvi, median_ndvi, quality, flags, change_ndvi, change_from_scene_id, change_pixels)
       values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12, $13, $14::text[], $15, $16, $17)
       on conflict (scene_id, paddock_id, boundary_id) do nothing`,
      [sceneId, farmId, o.paddockId, o.boundaryId, PROCESSOR_VERSION, acquiredAt, o.totalPixels, o.validPixels, o.edgePixels, o.coveragePct, o.meanNdvi, o.medianNdvi, o.quality, o.flags, o.changeNdvi, o.changeNdvi === null ? null : changeFromSceneId, o.changePixels],
    );
    added += result.rowCount ?? 0;
  }
  return added;
}

// Reading -----------------------------------------------------------------------------------------

export type SceneSummary = {
  id: string;
  acquiredAt: string;
  acquiredOn: string;
  retrievedAt: string;
  provider: ProviderId;
  usable: boolean;
  farmValidPct: string | null;
  paddocksGood: number;
  sceneCloudPct: string | null;
  productIds: string[];
  processingBaseline: string | null;
  platform: string | null;
  processorVersion: string;
  licence: string;
  hasPicture: boolean;
  hasChange: boolean;
  changeFromSceneId: string | null;
  grid: Grid;
  bounds: [number, number, number, number];
};

type SceneRow = {
  id: string;
  acquired_at: string;
  acquired_on: string;
  retrieved_at: string;
  provider: ProviderId;
  usable: boolean;
  farm_valid_pct: string | null;
  paddocks_good: number;
  scene_cloud_pct: string | null;
  product_ids: string[];
  processing_baseline: string | null;
  platform: string | null;
  processor_version: string;
  licence: string;
  overlay_path: string | null;
  change_path: string | null;
  change_from_scene_id: string | null;
  files_removed_at: string | null;
  grid: Grid;
};

const SCENE_COLUMNS = `s.id::text, to_char(s.acquired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as acquired_at, to_char(s.acquired_at at time zone 'Pacific/Auckland', 'YYYY-MM-DD') as acquired_on,
  to_char(s.retrieved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as retrieved_at, s.provider, s.usable, s.farm_valid_pct::text, s.paddocks_good, s.scene_cloud_pct::text, s.product_ids, s.processing_baseline, s.platform,
  s.processor_version, s.licence, s.overlay_path, s.change_path, s.change_from_scene_id::text, s.files_removed_at::text, s.grid`;

function gridBounds(grid: Grid): [number, number, number, number] {
  // Web Mercator metres to longitude and latitude, inline so this module needn't import the raster maths.
  const C = 2 * Math.PI * 6378137;
  const lon = (x: number) => (x / C) * 360;
  const lat = (y: number) => (Math.atan(Math.sinh((2 * Math.PI * y) / C)) * 180) / Math.PI;
  return [lon(grid.minX), lat(grid.maxY - grid.height * grid.pixel), lon(grid.minX + grid.width * grid.pixel), lat(grid.maxY)];
}

function toScene(row: SceneRow): SceneSummary {
  const kept = !row.files_removed_at;
  return {
    id: row.id,
    acquiredAt: row.acquired_at,
    acquiredOn: row.acquired_on,
    retrievedAt: row.retrieved_at,
    provider: row.provider,
    usable: row.usable,
    farmValidPct: row.farm_valid_pct,
    paddocksGood: row.paddocks_good,
    sceneCloudPct: row.scene_cloud_pct,
    productIds: row.product_ids,
    processingBaseline: row.processing_baseline,
    platform: row.platform,
    processorVersion: row.processor_version,
    licence: row.licence,
    hasPicture: kept && Boolean(row.overlay_path),
    hasChange: kept && Boolean(row.change_path),
    changeFromSceneId: row.change_from_scene_id,
    grid: row.grid,
    bounds: gridBounds(row.grid),
  };
}

export type PaddockObservation = {
  id: string;
  sceneId: string;
  paddockId: string;
  paddockName: string;
  boundaryId: string;
  /** False when the paddock's boundary has changed since: the numbers are for the earlier outline (decision 1528). */
  currentBoundary: boolean;
  acquiredAt: string;
  acquiredOn: string;
  totalPixels: number;
  validPixels: number;
  edgePixels: number;
  coveragePct: string | null;
  meanNdvi: string | null;
  medianNdvi: string | null;
  quality: Quality;
  flags: QualityFlag[];
  changeNdvi: string | null;
  changeFromSceneId: string | null;
  processorVersion: string;
  /**
   * Modelled pasture cover from the farm's checked line (#612 phase 3, MCV6), only when an admin has turned
   * estimates on and the view was clear. An estimate, kept apart from measured cover; null otherwise.
   */
  modelledCover: ModelledCover | null;
};

type ObservationRow = {
  id: string;
  scene_id: string;
  paddock_id: string;
  paddock_name: string;
  boundary_id: string;
  current_boundary: boolean;
  acquired_at: string;
  acquired_on: string;
  total_pixels: number;
  valid_pixels: number;
  edge_pixels: number;
  coverage_pct: string | null;
  mean_ndvi: string | null;
  median_ndvi: string | null;
  quality: Quality;
  flags: QualityFlag[];
  change_ndvi: string | null;
  change_from_scene_id: string | null;
  processor_version: string;
};

const OBSERVATION_COLUMNS = `o.id::text, o.scene_id::text, o.paddock_id::text, p.name as paddock_name, o.boundary_id::text,
  o.boundary_id = (select max(pb.id) from paddock_boundaries pb where pb.paddock_id = o.paddock_id) as current_boundary,
  to_char(o.acquired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as acquired_at, to_char(o.acquired_at at time zone 'Pacific/Auckland', 'YYYY-MM-DD') as acquired_on,
  o.total_pixels, o.valid_pixels, o.edge_pixels, o.coverage_pct::text, o.mean_ndvi::text, o.median_ndvi::text, o.quality, o.flags, o.change_ndvi::text, o.change_from_scene_id::text, o.processor_version`;

function toObservation(row: ObservationRow): PaddockObservation {
  return {
    id: row.id,
    sceneId: row.scene_id,
    paddockId: row.paddock_id,
    paddockName: row.paddock_name,
    boundaryId: row.boundary_id,
    currentBoundary: row.current_boundary,
    acquiredAt: row.acquired_at,
    acquiredOn: row.acquired_on,
    totalPixels: row.total_pixels,
    validPixels: row.valid_pixels,
    edgePixels: row.edge_pixels,
    coveragePct: row.coverage_pct,
    meanNdvi: row.mean_ndvi,
    medianNdvi: row.median_ndvi,
    quality: row.quality,
    flags: row.flags,
    changeNdvi: row.change_ndvi,
    changeFromSceneId: row.change_from_scene_id,
    processorVersion: row.processor_version,
    modelledCover: null,
  };
}

/** MCV6, MCV9: each observation with its modelled cover from the farm's line in use, if any (with the weather before it, if the line uses it). */
async function withEstimates(tx: OrgTx, farmId: string, observations: PaddockObservation[], model: CoverModel | null): Promise<PaddockObservation[]> {
  if (!model || observations.length === 0) return observations;
  const dates = observations.map((observation) => observation.acquiredOn).sort();
  const weather = usesWeather(model) ? await weatherMaps(tx, farmId, shiftDay(dates[0], -RAIN_WINDOW_DAYS), dates[dates.length - 1]) : null;
  return observations.map((observation) => ({
    ...observation,
    modelledCover: estimateFor(
      model,
      observation,
      weather ? { rain14: rainBefore(weather.rain, observation.acquiredOn), temperature14: temperatureBefore(weather.temperature, observation.acquiredOn) } : {},
    ),
  }));
}

export type FarmVegetation = {
  farmId: string;
  farmName: string;
  state: VegetationState;
  provider: ProviderId | null;
  setup: FarmSetup;
  pausedReason: SettingsRow["paused_reason"];
  connectionError: string | null;
  jobsWaiting: number;
  thresholds: { minCoveragePct: number; minValidPixels: number };
  /** Every date fetched for the farm, newest first. */
  scenes: SceneSummary[];
  /** The date shown: the one asked for, else the newest usable, else the newest. */
  scene: SceneSummary | null;
  observations: PaddockObservation[];
  attribution: string;
  /** Modelled cover in use on this farm (MCV6, MCV7), or null when estimates are off. */
  coverEstimates: { meanError: number; likelyWithin: number; acceptableError: number; turnedOnAt: string; turnedOnBy: string } | null;
};

async function jobsWaiting(tx: OrgTx, farmId: string): Promise<number> {
  return (await tx.query<{ n: number }>("select count(*)::int as n from vegetation_jobs where farm_id = $1 and status in ('queued', 'running') and kind in ('discover', 'fetch')", [farmId])).rows[0].n;
}

async function stateFor(tx: OrgTx, settings: SettingsRow, setup: FarmSetup, scenes: SceneSummary[], waiting: number): Promise<VegetationState> {
  return farmState({
    connected: Boolean(settings.provider) && settings.enabled,
    reconnect: settings.connection_status === "reconnect",
    farmEnabled: setup.enabled,
    paused: settings.paused_reason !== null,
    jobsWaiting: waiting > 0,
    lastUsableOn: scenes.find((scene) => scene.usable)?.acquiredOn ?? null,
    lastSceneOn: scenes[0]?.acquiredOn ?? null,
    today: todayIsoDate("Pacific/Auckland"),
  });
}

/** Observations for one date, the latest boundary each paddock was worked out with first. */
async function sceneObservations(tx: OrgTx, sceneId: string): Promise<PaddockObservation[]> {
  const rows = await tx.query<ObservationRow>(
    `select distinct on (o.paddock_id) ${OBSERVATION_COLUMNS}
       from vegetation_observations o join paddocks p on p.id = o.paddock_id
      where o.scene_id = $1 order by o.paddock_id, o.boundary_id desc`,
    [sceneId],
  );
  return rows.rows.map(toObservation).sort((a, b) => a.paddockName.localeCompare(b.paddockName, "en-NZ", { numeric: true }));
}

/** A farm's satellite vegetation for the map (decisions 1531-1533): state, dates, the date shown and its paddocks. */
export async function getFarmVegetation(tx: OrgTx, farmIdInput: unknown, options: { sceneId?: unknown } = {}): Promise<FarmVegetation> {
  const farm = await requireFarm(tx, farmIdInput);
  const settings = await settingsRow(tx);
  const setup = await farmSetup(tx, farm.id);
  const scenes = (await tx.query<SceneRow>(`select ${SCENE_COLUMNS} from vegetation_scenes s where s.farm_id = $1 order by s.acquired_at desc, s.id desc limit 400`, [farm.id])).rows.map(toScene);
  const waiting = await jobsWaiting(tx, farm.id);
  let scene: SceneSummary | null = null;
  if (options.sceneId !== undefined && options.sceneId !== null && options.sceneId !== "") {
    const sceneId = requireId(options.sceneId, "sceneId");
    scene = scenes.find((candidate) => candidate.id === sceneId) ?? null;
    if (!scene) throw new NotFoundError("Satellite date not found.");
  } else {
    scene = scenes.find((candidate) => candidate.usable) ?? scenes[0] ?? null;
  }
  const provider = scene?.provider ?? settings.provider;
  const model = await activeCoverModel(tx, farm.id);
  return {
    farmId: farm.id,
    farmName: farm.name,
    state: await stateFor(tx, settings, setup, scenes, waiting),
    provider: settings.provider,
    setup,
    pausedReason: settings.paused_reason,
    connectionError: settings.connection_status === "reconnect" ? settings.connection_error : null,
    jobsWaiting: waiting,
    thresholds: { minCoveragePct: settings.min_coverage_pct, minValidPixels: settings.min_valid_pixels },
    scenes,
    scene,
    observations: scene ? await withEstimates(tx, farm.id, await sceneObservations(tx, scene.id), model) : [],
    attribution: provider ? attributionText(provider, scene ? [Number(scene.acquiredAt.slice(0, 4))] : []) : "",
    coverEstimates: model
      ? { meanError: model.meanError, likelyWithin: model.likelyWithin, acceptableError: model.acceptableError, turnedOnAt: model.turnedOnAt, turnedOnBy: model.turnedOnBy }
      : null,
  };
}

export type PaddockTrend = { paddockId: string; paddockName: string; farmId: string; observations: PaddockObservation[]; attribution: string; provider: ProviderId | null };

/** A paddock's numbers over time, oldest first, every boundary version labelled (decision 1528). */
export async function getPaddockTrend(tx: OrgTx, paddockIdInput: unknown, options: { from?: string; to?: string } = {}): Promise<PaddockTrend> {
  await requireFarming(tx);
  const paddockId = requireId(paddockIdInput, "paddockId");
  const from = parseOptionalIsoDate(options.from, "from");
  const to = parseOptionalIsoDate(options.to, "to");
  await requirePaddockAccess(tx, paddockId);
  const paddock = (await tx.query<{ name: string; farm_id: string }>("select name, farm_id::text from paddocks where id = $1", [paddockId])).rows[0];
  const rows = await tx.query<ObservationRow & { provider: ProviderId }>(
    `select ${OBSERVATION_COLUMNS}, s.provider from vegetation_observations o join paddocks p on p.id = o.paddock_id join vegetation_scenes s on s.id = o.scene_id
      where o.paddock_id = $1 and ($2::date is null or o.acquired_at >= $2::date) and ($3::date is null or o.acquired_at < $3::date + 1)
      order by o.acquired_at, o.boundary_id`,
    [paddockId, from, to],
  );
  const provider = rows.rows.at(-1)?.provider ?? null;
  return {
    paddockId,
    paddockName: paddock.name,
    farmId: paddock.farm_id,
    observations: await withEstimates(tx, paddock.farm_id, rows.rows.map(toObservation), await activeCoverModel(tx, paddock.farm_id)),
    provider,
    attribution: provider ? attributionText(provider, rows.rows.map((row) => Number(row.acquired_at.slice(0, 4)))) : "",
  };
}

export type OverviewRow = { farmId: string; farmName: string; state: VegetationState; enabled: boolean; lastUsableOn: string | null; lastUsableClearPct: string | null; lastCheckedAt: string | null; paddocksGood: number | null; paddocks: number };

/** Every farm the person can see, with its latest usable date and how clear it was (decision 1538). */
export async function vegetationOverview(tx: OrgTx): Promise<OverviewRow[]> {
  await requireFarming(tx);
  const visible = await visibleFarmIds(tx);
  const farms = await tx.query<{ id: string; name: string }>("select id::text, name from farms where is_active and ($1::bigint[] is null or id = any($1::bigint[])) order by lower(name), farms.id", [visible]);
  const settings = await settingsRow(tx);
  const rows: OverviewRow[] = [];
  for (const farm of farms.rows) {
    const setup = await farmSetup(tx, farm.id);
    const scenes = (await tx.query<SceneRow>(`select ${SCENE_COLUMNS} from vegetation_scenes s where s.farm_id = $1 order by s.acquired_at desc, s.id desc limit 60`, [farm.id])).rows.map(toScene);
    const usable = scenes.find((scene) => scene.usable) ?? null;
    const paddocks = (await tx.query<{ n: number }>("select count(*)::int as n from paddocks where farm_id = $1 and status = 'active'", [farm.id])).rows[0].n;
    rows.push({
      farmId: farm.id,
      farmName: farm.name,
      state: await stateFor(tx, settings, setup, scenes, await jobsWaiting(tx, farm.id)),
      enabled: setup.enabled,
      lastUsableOn: usable?.acquiredOn ?? null,
      lastUsableClearPct: usable?.farmValidPct ?? null,
      lastCheckedAt: setup.lastCheckedAt,
      paddocksGood: usable?.paddocksGood ?? null,
      paddocks,
    });
  }
  return rows;
}

/** A date's picture file, if the person may see its farm and it's still kept. */
export async function scenePicture(tx: OrgTx, sceneIdInput: unknown, kind: "overlay" | "change"): Promise<{ path: string; farmId: string; acquiredAt: string; provider: ProviderId } | null> {
  await requireFarming(tx);
  const sceneId = requireId(sceneIdInput, "sceneId");
  const row = (await tx.query<{ farm_id: string; overlay_path: string | null; change_path: string | null; files_removed_at: string | null; acquired_at: string; provider: ProviderId }>(
    `select farm_id::text, overlay_path, change_path, files_removed_at::text, to_char(acquired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as acquired_at, provider from vegetation_scenes where id = $1`,
    [sceneId],
  )).rows[0];
  if (!row || !(await canSeeFarm(tx, row.farm_id))) throw new NotFoundError("Satellite date not found.");
  const path = kind === "overlay" ? row.overlay_path : row.change_path;
  if (!path || row.files_removed_at) return null;
  return { path, farmId: row.farm_id, acquiredAt: row.acquired_at, provider: row.provider };
}

/** A farm's observations as CSV rows (decision 1538), with the attribution and what the numbers are. */
export async function exportObservations(tx: OrgTx, farmIdInput: unknown): Promise<{ farmName: string; csv: string }> {
  const farm = await requireFarm(tx, farmIdInput);
  const rows = await tx.query<ObservationRow & { provider: ProviderId; product_ids: string[]; processing_baseline: string | null }>(
    `select ${OBSERVATION_COLUMNS}, s.provider, s.product_ids, s.processing_baseline from vegetation_observations o join paddocks p on p.id = o.paddock_id join vegetation_scenes s on s.id = o.scene_id
      where o.farm_id = $1 order by o.acquired_at, lower(p.name), o.boundary_id`,
    [farm.id],
  );
  const quote = (value: string | number | null) => (value === null ? "" : /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
  const lines = [
    ["acquired_at_utc", "paddock", "paddock_id", "boundary_id", "current_boundary", "mean_ndvi", "median_ndvi", "valid_pixels", "total_pixels", "coverage_pct", "quality", "flags", "change_ndvi", "products", "processing_baseline", "processor_version"].join(","),
    ...rows.rows.map((row) =>
      [row.acquired_at, row.paddock_name, row.paddock_id, row.boundary_id, row.current_boundary ? "yes" : "no", row.mean_ndvi, row.median_ndvi, row.valid_pixels, row.total_pixels, row.coverage_pct, row.quality, row.flags.join(" "), row.change_ndvi, row.product_ids.join(" "), row.processing_baseline, row.processor_version]
        .map(quote)
        .join(","),
    ),
  ];
  const provider = rows.rows.at(-1)?.provider;
  const note = `# Greenness (NDVI), not feed available. Blank means no clear view, not zero. ${provider ? attributionText(provider, rows.rows.map((row) => Number(row.acquired_at.slice(0, 4)))) : ""}`.trim();
  return { farmName: farm.name, csv: `${note}\n${lines.join("\n")}\n` };
}

export { requireFarm as requireVegetationFarm };
