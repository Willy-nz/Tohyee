import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { createCopernicusProvider } from "@/lib/farming/vegetation/copernicus";
import { createDemoProvider } from "@/lib/farming/vegetation/fake-provider";
import { encodePng } from "@/lib/farming/vegetation/png";
import { bandsFromPicture, ProviderError, type ProviderId, type SceneCandidate, type VegetationProvider } from "@/lib/farming/vegetation/provider";
import { clearShare, farmGrid, type Grid, GridError, gridLonLatBox, ndviRaster, overlayPixels, paddockChange, paddockPixels, paddockStats } from "@/lib/farming/vegetation/raster";
import { estimateUnits, PROCESSOR_VERSION, SKIP_SCENE_CLOUD_PCT } from "@/lib/farming/vegetation/rules";
import {
  addObservations,
  currentBoundaries,
  enqueueFetch,
  enqueueJob,
  markReconnect,
  monthStart,
  type ObservationInput,
  pauseFetching,
  type PilotResult,
  providerCredentials,
  recordScene,
  requireVegetationFarm,
  saveLastTest,
  settingsRow,
  usageThisMonth,
} from "@/lib/farming/vegetation/service";
import { isDiskFull, picturePath, readPicture, removePicture, writePicture } from "@/lib/farming/vegetation/storage";

/*
 * The satellite vegetation worker (#612, decisions 1527-1537). One
 * low-priority worker for the whole server: one job at a time, a few a
 * minute at most, a cap on picture size (and so memory), and a pause to
 * let other work run between paddocks, so the books stay responsive on a
 * home server.
 *
 * Jobs are idempotent (decision 1534): each has a unique key, so asking
 * twice is one job; a fetch saves the picture and a checkpoint before it's
 * worked out, so a restart carries on without fetching again; and a date
 * and its paddock numbers are unique, so recording twice adds nothing.
 * Failures retry with growing waits (5, 30, 120, 720 minutes), at most 5
 * tries; the provider asking to slow down waits as long as it says. A
 * refused account stops everything until someone reconnects; a used-up
 * budget or full disk pauses with a reason on screen. Nothing is ever
 * switched to a paid service. Network calls are never made inside a
 * database transaction.
 */

const ACTOR: Actor = { userId: null, email: "satellite vegetation" };
const RETRY_MINUTES = [5, 30, 120, 720];
const MAX_ATTEMPTS = 5;
/** A job claimed longer ago than this was cut off (a restart): it goes back in the queue. */
const STALE_MINUTES = 15;
/** Jobs a tick, and how long a tick may work before it stops (decision 1529). */
const JOBS_PER_TICK = 3;
const TICK_BUDGET_MS = 20_000;
const TICK_MINUTES = 1;
/** Checks are daily, at a random time within 3 hours after the day's due time, so servers don't all ask at once. */
const CHECK_JITTER_MINUTES = 180;
/** A date is shown by default when at least this much of the farm's paddock land is clear (decision 1531). */
export const USABLE_FARM_CLEAR_PCT = 50;

export type ProviderFactory = (credentials: { provider: ProviderId; clientId: string; clientSecret: string }) => VegetationProvider;

export const defaultProviderFactory: ProviderFactory = (credentials) => (credentials.provider === "demo" ? createDemoProvider() : createCopernicusProvider({ clientId: credentials.clientId, clientSecret: credentials.clientSecret }));

/** Lets the event loop run other requests (decision 1529). */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

type ClaimedJob = { id: string; farm_id: string | null; kind: "discover" | "fetch" | "reprocess"; payload: Record<string, unknown>; checkpoint: Record<string, unknown>; attempts: number };

type Outcome =
  | { kind: "done"; units?: number; requests?: number; bytes?: number }
  | { kind: "skipped"; reason: string }
  | { kind: "retry"; error: string; waitSeconds?: number; requests?: number }
  | { kind: "failed"; error: string }
  | { kind: "hold"; error: string };

/** Jobs cut off by a restart go back in the queue; their checkpoint stays (decision 1534). */
async function requeueStale(tx: OrgTx, now: Date): Promise<void> {
  await tx.query("update vegetation_jobs set status = 'queued', next_attempt_at = $1 where status = 'running' and claimed_at < $1::timestamptz - make_interval(mins => $2)", [now.toISOString(), STALE_MINUTES]);
}

/** Quota pauses end with the month; a storage pause ends when there's room again. */
async function liftPauses(tx: OrgTx, now: Date): Promise<void> {
  const settings = await settingsRow(tx);
  if (!settings.paused_reason) return;
  if ((settings.paused_reason === "quota" || settings.paused_reason === "requests") && settings.paused_at && Date.parse(settings.paused_at) < Date.parse(monthStart(now))) {
    await tx.query("update vegetation_settings set paused_reason = null, paused_at = null where id = true");
  }
  if (settings.paused_reason === "storage" && (await usageThisMonth(tx, now)).storedBytes < Number(settings.storage_cap_bytes)) {
    await tx.query("update vegetation_settings set paused_reason = null, paused_at = null where id = true");
  }
}

/** Queues today's check for each farm that's due, and sets the next one about a day on (decision 1527). */
export async function scheduleChecks(tx: OrgTx, now: Date, random = Math.random): Promise<number> {
  const settings = await settingsRow(tx);
  if (!settings.enabled || settings.connection_status !== "ok" || settings.paused_reason) return 0;
  const due = await tx.query<{ farm_id: string; last_checked_at: string | null }>(
    "select f.farm_id::text, f.last_checked_at::text from vegetation_farms f join farms on farms.id = f.farm_id where f.enabled and farms.is_active and f.next_check_at <= $1",
    [now.toISOString()],
  );
  for (const farm of due.rows) {
    await enqueueJob(tx, { farmId: farm.farm_id, kind: "discover", key: `discover:${farm.farm_id}:${now.toISOString().slice(0, 10)}` });
    const next = new Date(now.getTime() + 24 * 3_600_000 + Math.floor(random() * CHECK_JITTER_MINUTES) * 60_000);
    await tx.query("update vegetation_farms set next_check_at = $2 where farm_id = $1", [farm.farm_id, next.toISOString()]);
  }
  return due.rows.length;
}

async function claim(tx: OrgTx, now: Date): Promise<ClaimedJob | null> {
  const row = await tx.query<ClaimedJob>(
    `update vegetation_jobs set status = 'running', claimed_at = $1::timestamptz, attempts = attempts + 1
      where id = (select id from vegetation_jobs where status = 'queued' and kind <> 'test' and next_attempt_at <= $1::timestamptz order by next_attempt_at, id limit 1 for update skip locked)
      returning id::text, farm_id::text, kind, payload, checkpoint, attempts`,
    [now.toISOString()],
  );
  return row.rows[0] ?? null;
}

async function record(tx: OrgTx, job: ClaimedJob, outcome: Outcome, now: Date): Promise<void> {
  const counts = "units_spent = units_spent + $2, requests = requests + $3, bytes_fetched = bytes_fetched + $4";
  if (outcome.kind === "done") {
    await tx.query(`update vegetation_jobs set status = 'done', finished_at = $5, last_error = null, ${counts} where id = $1`, [job.id, outcome.units ?? 0, outcome.requests ?? 0, outcome.bytes ?? 0, now.toISOString()]);
  } else if (outcome.kind === "skipped") {
    await tx.query("update vegetation_jobs set status = 'skipped', finished_at = $2, last_error = $3 where id = $1", [job.id, now.toISOString(), outcome.reason]);
  } else if (outcome.kind === "hold") {
    // Paused or reconnect: back in the queue without using up a try.
    await tx.query("update vegetation_jobs set status = 'queued', attempts = greatest(0, attempts - 1), next_attempt_at = $2, last_error = $3 where id = $1", [job.id, new Date(now.getTime() + 60 * 60_000).toISOString(), outcome.error]);
  } else if (outcome.kind === "retry" && job.attempts < MAX_ATTEMPTS) {
    const wait = outcome.waitSeconds ?? RETRY_MINUTES[Math.min(job.attempts - 1, RETRY_MINUTES.length - 1)] * 60;
    await tx.query("update vegetation_jobs set status = 'queued', next_attempt_at = $2, last_error = $3, requests = requests + $4 where id = $1", [job.id, new Date(now.getTime() + wait * 1000).toISOString(), outcome.error, outcome.requests ?? 0]);
  } else {
    await tx.query("update vegetation_jobs set status = 'failed', finished_at = $2, last_error = $3 where id = $1", [job.id, now.toISOString(), outcome.kind === "retry" || outcome.kind === "failed" ? outcome.error : "Failed."]);
  }
  if (job.farm_id && job.kind === "discover") {
    await tx.query("update vegetation_farms set last_checked_at = $2, last_check_error = $3 where farm_id = $1", [job.farm_id, now.toISOString(), outcome.kind === "done" || outcome.kind === "skipped" ? null : "error" in outcome ? outcome.error : null]);
  }
}

/** A provider error as an outcome, pausing or asking to reconnect where it should (decision 1534). */
async function providerOutcome(organisation: OrganisationRecord, error: unknown): Promise<Outcome> {
  if (error instanceof ProviderError) {
    if (error.kind === "auth") {
      await withOrganisationTransaction(organisation, ACTOR, (tx) => markReconnect(tx, error.message));
      return { kind: "hold", error: error.message };
    }
    if (error.kind === "quota") {
      await withOrganisationTransaction(organisation, ACTOR, (tx) => pauseFetching(tx, "quota"));
      return { kind: "hold", error: error.message };
    }
    if (error.kind === "rate_limited") return { kind: "retry", error: error.message, waitSeconds: error.retryAfterSeconds ?? 60 };
    if (error.kind === "unavailable") return { kind: "retry", error: error.message, waitSeconds: error.retryAfterSeconds ?? undefined };
    return { kind: "failed", error: error.message };
  }
  if (isDiskFull(error)) {
    await withOrganisationTransaction(organisation, ACTOR, (tx) => pauseFetching(tx, "disk_full"));
    return { kind: "hold", error: "The server's disk is full." };
  }
  if (error instanceof GridError) return { kind: "failed", error: error.message };
  return { kind: "retry", error: error instanceof Error ? error.message.slice(0, 300) : "Something went wrong." };
}

// Discover ---------------------------------------------------------------------------------------

async function farmGridNow(tx: OrgTx, farmId: string): Promise<Grid> {
  const boundaries = await currentBoundaries(tx, farmId);
  return farmGrid(boundaries.map((boundary) => boundary.geometry));
}

async function runDiscover(organisation: OrganisationRecord, provider: VegetationProvider, job: ClaimedJob, now: Date): Promise<Outcome> {
  const farmId = job.farm_id!;
  const prepared = await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
    const settings = await settingsRow(tx);
    const farm = await tx.query<{ last: string | null }>("select to_char(max(acquired_at) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as last from vegetation_scenes where farm_id = $1", [farmId]);
    return { grid: await farmGridNow(tx, farmId), historyDays: settings.history_days, last: farm.rows[0].last };
  });
  // From the history wanted, or a few days before the last date seen (the catalogue can be slow to list a date).
  const historyFrom = now.getTime() - prepared.historyDays * 86_400_000;
  const from = new Date(prepared.last ? Math.max(historyFrom, Date.parse(prepared.last) - 5 * 86_400_000) : historyFrom).toISOString();
  let candidates: SceneCandidate[];
  try {
    candidates = await provider.search({ box: gridLonLatBox(prepared.grid), from, to: now.toISOString(), maxSceneCloudPct: SKIP_SCENE_CLOUD_PCT });
  } catch (error) {
    return providerOutcome(organisation, error);
  }
  await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
    for (const candidate of candidates) await enqueueFetch(tx, farmId, candidate);
  });
  return { kind: "done", requests: provider.id === "demo" ? 0 : 1 };
}

// Fetch and work out ----------------------------------------------------------------------------

type Checkpoint = { grid?: Grid; rawPath?: string; sha256?: string; bytes?: number; units?: number | null; unitsEstimated?: number; dnOffset?: number; retrievedAt?: string };

type Worked = { observations: ObservationInput[]; overlay: Uint8Array; change: Uint8Array | null; changeFromSceneId: string | null; farmValidPct: number | null; usable: boolean };

/** Works out every paddock's numbers and the map pictures from a picture (decisions 1524-1532). */
async function workOut(organisationId: string, farmId: string, grid: Grid, png: Uint8Array, dnOffset: number, boundaries: Awaited<ReturnType<typeof currentBoundaries>>, thresholds: { minCoveragePct: number; minValidPixels: number }, earlier: { id: string; grid: Grid; rawPath: string; dnOffset: number } | null): Promise<Worked> {
  const ndvi = ndviRaster(bandsFromPicture(png, grid), dnOffset);
  let before: { grid: Grid; ndvi: Float32Array } | null = null;
  if (earlier) {
    const raw = await readPicture(organisationId, earlier.rawPath);
    if (raw) before = { grid: earlier.grid, ndvi: ndviRaster(bandsFromPicture(raw, earlier.grid), earlier.dnOffset) };
  }
  const inPaddock = new Uint8Array(grid.width * grid.height);
  const observations: ObservationInput[] = [];
  for (const boundary of boundaries) {
    const member = paddockPixels(grid, boundary.geometry);
    for (const index of member.pixels) inPaddock[index] = 1;
    const stats = paddockStats(ndvi, member, thresholds);
    const change = before && stats.quality === "good" ? paddockChange({ grid, ndvi }, before, member, thresholds) : { change: null, commonPixels: 0 };
    observations.push({ paddockId: boundary.paddockId, boundaryId: boundary.boundaryId, ...stats, changeNdvi: change.change, changePixels: before ? change.commonPixels : null });
    await breathe();
  }
  const farmValidPct = clearShare(ndvi, inPaddock);
  return {
    observations,
    overlay: encodePng(grid.width, grid.height, overlayPixels(grid, ndvi, inPaddock)),
    change: before ? encodePng(grid.width, grid.height, overlayPixels(grid, ndvi, inPaddock, before)) : null,
    changeFromSceneId: before ? earlier!.id : null,
    farmValidPct,
    // Mostly clear (decision 1531): a paddock good enough to compare and at least half the farm's paddock land clear. Other dates stay listed.
    usable: observations.some((observation) => observation.quality === "good") && farmValidPct !== null && farmValidPct >= USABLE_FARM_CLEAR_PCT,
  };
}

async function runFetch(organisation: OrganisationRecord, provider: VegetationProvider, job: ClaimedJob, now: Date): Promise<Outcome> {
  const farmId = job.farm_id!;
  const candidate = job.payload.candidate as SceneCandidate;
  const checkpoint = job.checkpoint as Checkpoint;
  const prepared = await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
    const settings = await settingsRow(tx);
    const done = await tx.query("select 1 from vegetation_scenes where farm_id = $1 and acquired_at = $2::timestamptz and processor_version = $3", [farmId, candidate.acquiredAt, PROCESSOR_VERSION]);
    const usage = await usageThisMonth(tx, now);
    // The last real charge for one of this farm's pictures, when the provider said (decision 1535).
    const lastCharge = await tx.query<{ units: string | null }>("select max(units_spent)::text as units from (select units_spent from vegetation_jobs where farm_id = $1 and kind = 'fetch' and units_spent > 0 order by id desc limit 3) recent", [farmId]);
    const earlier = await tx.query<{ id: string; grid: Grid; raw_path: string; dn_offset: number }>(
      "select id::text, grid, raw_path, dn_offset from vegetation_scenes where farm_id = $1 and usable and acquired_at < $2::timestamptz and raw_path is not null and files_removed_at is null order by acquired_at desc limit 1",
      [farmId, candidate.acquiredAt],
    );
    return {
      settings,
      lastCharge: lastCharge.rows[0].units === null ? 0 : Number(lastCharge.rows[0].units),
      done: Boolean(done.rowCount),
      usage,
      grid: checkpoint.grid ?? (await farmGridNow(tx, farmId)),
      boundaries: await currentBoundaries(tx, farmId),
      earlier: earlier.rows[0] ? { id: earlier.rows[0].id, grid: earlier.rows[0].grid, rawPath: earlier.rows[0].raw_path, dnOffset: earlier.rows[0].dn_offset } : null,
    };
  });
  if (prepared.done) return { kind: "skipped", reason: "Already worked out." };
  const estimate = estimateUnits(prepared.grid.width, prepared.grid.height);
  const expected = Math.max(estimate, prepared.lastCharge);
  let png: Uint8Array | null = checkpoint.rawPath ? await readPicture(organisation.id, checkpoint.rawPath) : null;
  let fetched = { units: 0, requests: 0, bytes: 0 };
  if (!png) {
    // Budgets are checked before asking (decision 1535): never go over, never switch to a paid service.
    if (Number(prepared.usage.units) + expected > Number(prepared.settings.monthly_unit_budget)) {
      await withOrganisationTransaction(organisation, ACTOR, (tx) => pauseFetching(tx, "quota"));
      return { kind: "hold", error: "This month's processing budget is used up." };
    }
    if (prepared.usage.requests + 1 > prepared.settings.monthly_request_budget) {
      await withOrganisationTransaction(organisation, ACTOR, (tx) => pauseFetching(tx, "requests"));
      return { kind: "hold", error: "This month's request budget is used up." };
    }
    if (prepared.usage.storedBytes >= Number(prepared.settings.storage_cap_bytes)) {
      await withOrganisationTransaction(organisation, ACTOR, (tx) => pauseFetching(tx, "storage"));
      return { kind: "hold", error: "The storage limit is reached." };
    }
    let picture;
    try {
      picture = await provider.fetch({ grid: prepared.grid, candidate });
    } catch (error) {
      return providerOutcome(organisation, error);
    }
    const rawPath = picturePath(organisation.id, farmId, candidate.acquiredAt, "raw");
    let sha256: string;
    try {
      sha256 = await writePicture(organisation.id, rawPath, picture.png);
    } catch (error) {
      return providerOutcome(organisation, error);
    }
    const units = picture.unitsSpent ?? (provider.id === "demo" ? 0 : estimate);
    const saved: Checkpoint = { grid: prepared.grid, rawPath, sha256, bytes: picture.png.byteLength, units: picture.unitsSpent, unitsEstimated: estimate, dnOffset: picture.dnOffset, retrievedAt: now.toISOString() };
    // The checkpoint and what was spent are saved before working it out, so a restart doesn't fetch (or count) it again.
    await withOrganisationTransaction(organisation, ACTOR, (tx) =>
      tx.query("update vegetation_jobs set checkpoint = $2::jsonb, units_spent = units_spent + $3, requests = requests + $4, bytes_fetched = bytes_fetched + $5 where id = $1", [job.id, JSON.stringify(saved), units, picture.requests, picture.png.byteLength]),
    );
    Object.assign(checkpoint, saved);
    png = picture.png;
    fetched = { units: 0, requests: 0, bytes: 0 };
  }
  const thresholds = { minCoveragePct: prepared.settings.min_coverage_pct, minValidPixels: prepared.settings.min_valid_pixels };
  let worked: Worked;
  try {
    worked = await workOut(organisation.id, farmId, prepared.grid, png, checkpoint.dnOffset ?? 0, prepared.boundaries, thresholds, prepared.earlier);
  } catch (error) {
    return error instanceof ProviderError ? { kind: "failed", error: error.message } : providerOutcome(organisation, error);
  }
  const overlayPath = picturePath(organisation.id, farmId, candidate.acquiredAt, "overlay");
  const changePath = worked.change ? picturePath(organisation.id, farmId, candidate.acquiredAt, "change") : null;
  try {
    await writePicture(organisation.id, overlayPath, worked.overlay);
    if (worked.change && changePath) await writePicture(organisation.id, changePath, worked.change);
  } catch (error) {
    return providerOutcome(organisation, error);
  }
  await withOrganisationTransaction(organisation, ACTOR, (tx) =>
    recordScene(
      tx,
      {
        farmId,
        provider: provider.id,
        candidate,
        retrievedAt: checkpoint.retrievedAt ?? now.toISOString(),
        dnOffset: checkpoint.dnOffset ?? 0,
        grid: prepared.grid,
        farmValidPct: worked.farmValidPct,
        usable: worked.usable,
        unitsSpent: checkpoint.units ?? null,
        unitsEstimated: checkpoint.unitsEstimated ?? estimate,
        rawPath: checkpoint.rawPath!,
        overlayPath,
        changePath,
        changeFromSceneId: worked.changeFromSceneId,
        bytes: (checkpoint.bytes ?? png!.byteLength) + worked.overlay.byteLength + (worked.change?.byteLength ?? 0),
        sha256: checkpoint.sha256 ?? "",
      },
      worked.observations,
    ),
  );
  return { kind: "done", ...fetched };
}

/** Works out a kept date again with today's boundaries (decision 1528): new rows for new boundaries; earlier ones stay. */
async function runReprocess(organisation: OrganisationRecord, job: ClaimedJob): Promise<Outcome> {
  const sceneId = String(job.payload.sceneId);
  const prepared = await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
    const scene = (await tx.query<{ farm_id: string; grid: Grid; raw_path: string | null; dn_offset: number; acquired_at: string; change_from_scene_id: string | null }>(
      "select farm_id::text, grid, raw_path, dn_offset, to_char(acquired_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as acquired_at, change_from_scene_id::text from vegetation_scenes where id = $1 and files_removed_at is null",
      [sceneId],
    )).rows[0];
    if (!scene) return null;
    const earlier = scene.change_from_scene_id
      ? (await tx.query<{ id: string; grid: Grid; raw_path: string; dn_offset: number }>("select id::text, grid, raw_path, dn_offset from vegetation_scenes where id = $1 and raw_path is not null and files_removed_at is null", [scene.change_from_scene_id])).rows[0]
      : undefined;
    const settings = await settingsRow(tx);
    return { scene, earlier, boundaries: await currentBoundaries(tx, scene.farm_id), thresholds: { minCoveragePct: settings.min_coverage_pct, minValidPixels: settings.min_valid_pixels } };
  });
  if (!prepared?.scene.raw_path) return { kind: "skipped", reason: "The picture is no longer kept." };
  const png = await readPicture(organisation.id, prepared.scene.raw_path);
  if (!png) return { kind: "skipped", reason: "The picture is no longer kept." };
  const worked = await workOut(organisation.id, prepared.scene.farm_id, prepared.scene.grid, png, prepared.scene.dn_offset, prepared.boundaries, prepared.thresholds, prepared.earlier ? { id: prepared.earlier.id, grid: prepared.earlier.grid, rawPath: prepared.earlier.raw_path, dnOffset: prepared.earlier.dn_offset } : null);
  await withOrganisationTransaction(organisation, ACTOR, (tx) => addObservations(tx, sceneId, prepared.scene.farm_id, prepared.scene.acquired_at, worked.changeFromSceneId, worked.observations));
  return { kind: "done" };
}

// Running ---------------------------------------------------------------------------------------

/**
 * Runs due jobs for one organisation, one at a time, up to `maxJobs` or the
 * time budget. A paused or disconnected organisation runs nothing.
 */
export async function runVegetationJobs(organisation: OrganisationRecord, options: { now?: () => Date; maxJobs?: number; budgetMs?: number; providerFactory?: ProviderFactory; farmId?: string } = {}): Promise<{ ran: number }> {
  const now = options.now ?? (() => new Date());
  const factory = options.providerFactory ?? defaultProviderFactory;
  const started = Date.now();
  let ran = 0;
  let provider: VegetationProvider | null = null;
  await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
    await requeueStale(tx, now());
    await liftPauses(tx, now());
  });
  while (ran < (options.maxJobs ?? JOBS_PER_TICK) && Date.now() - started < (options.budgetMs ?? TICK_BUDGET_MS)) {
    const claimed = await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
      const settings = await settingsRow(tx);
      if (!settings.enabled || settings.connection_status !== "ok" || settings.paused_reason) return null;
      const job = await claim(tx, now());
      return job ? { job, credentials: provider ? null : await providerCredentials(tx) } : null;
    });
    if (!claimed) break;
    if (!provider) {
      if (!claimed.credentials) {
        await withOrganisationTransaction(organisation, ACTOR, (tx) => record(tx, claimed.job, { kind: "hold", error: "No imagery account is connected." }, now()));
        break;
      }
      provider = factory(claimed.credentials);
    }
    let outcome: Outcome;
    try {
      outcome = claimed.job.kind === "discover" ? await runDiscover(organisation, provider, claimed.job, now()) : claimed.job.kind === "fetch" ? await runFetch(organisation, provider, claimed.job, now()) : await runReprocess(organisation, claimed.job);
    } catch (error) {
      outcome = { kind: "retry", error: error instanceof Error ? error.message.slice(0, 300) : "Something went wrong." };
    }
    await withOrganisationTransaction(organisation, ACTOR, (tx) => record(tx, claimed.job, outcome, now()));
    ran += 1;
    if (outcome.kind === "hold") break;
  }
  return { ran };
}

/** Removes pictures past the organisation's retention, never the newest usable one of a farm (decision 1536). The numbers stay. */
export async function removeOldPictures(organisation: OrganisationRecord, now = new Date()): Promise<number> {
  const old = await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
    const settings = await settingsRow(tx);
    const rows = await tx.query<{ id: string; raw_path: string | null; overlay_path: string | null; change_path: string | null }>(
      `update vegetation_scenes s set files_removed_at = $1
        where s.files_removed_at is null and s.acquired_at < $1::timestamptz - make_interval(days => $2)
          and s.id <> coalesce((select n.id from vegetation_scenes n where n.farm_id = s.farm_id and n.usable order by n.acquired_at desc limit 1), 0)
        returning s.id::text, s.raw_path, s.overlay_path, s.change_path`,
      [now.toISOString(), settings.retention_days],
    );
    return rows.rows;
  });
  for (const scene of old) {
    for (const path of [scene.raw_path, scene.overlay_path, scene.change_path]) {
      if (path) await removePicture(organisation.id, path).catch((error) => console.warn(`[tohyee] Couldn't remove an old satellite picture for ${organisation.id}: ${error instanceof Error ? error.message : error}`));
    }
  }
  return old.length;
}

let running = false;
let timer: NodeJS.Timeout | null = null;
let lastCleanup = 0;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const cleanup = Date.now() - lastCleanup > 60 * 60_000;
    if (cleanup) lastCleanup = Date.now();
    for (const organisation of await listOrganisationsForJobs()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      try {
        const active = await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
          const farming = await tx.query<{ enabled: boolean }>("select enabled from farming_settings where id = true");
          if (!farming.rows[0]?.enabled) return false;
          const settings = await settingsRow(tx);
          if (!settings.provider) return false;
          await scheduleChecks(tx, new Date());
          return true;
        });
        if (!active) continue;
        await runVegetationJobs(organisation);
        if (cleanup) await removeOldPictures(organisation);
      } catch (error) {
        console.warn(`[tohyee] Satellite vegetation failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    running = false;
  }
}

/** Starts the worker (off with TOHYEE_VEGETATION_SCHEDULER=off). */
export function startVegetationScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MINUTES * 60_000);
  timer.unref?.();
  setTimeout(() => void tick(), 4 * 60_000).unref?.();
}

/** "Check now" (decision 1527): runs this organisation's due jobs in the background, without waiting for the next tick. */
export function kickVegetation(organisation: OrganisationRecord): void {
  if (running) return;
  running = true;
  void runVegetationJobs(organisation, { maxJobs: 10, budgetMs: 60_000 })
    .catch((error) => console.warn(`[tohyee] Satellite vegetation failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`))
    .finally(() => {
      running = false;
    });
}

// Test one farm ---------------------------------------------------------------------------------

/**
 * The pilot (decision 1537): one bounded fetch for one farm (the least
 * cloudy date in the last 30 days), measuring bytes, time, memory and
 * processing units. Its picture isn't kept as an observation; a small
 * preview comes back for the screen. Counted in the month's usage like any
 * fetch. Only owners and admins can run it, and only once a minute.
 */
export async function testOneFarm(organisation: OrganisationRecord, actor: Actor, farmIdInput: unknown, options: { providerFactory?: ProviderFactory; now?: Date; connection?: { provider: ProviderId; clientId: string; clientSecret: string } } = {}): Promise<{ result: PilotResult; preview: string | null; bounds: [number, number, number, number] }> {
  const now = options.now ?? new Date();
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const farm = await requireVegetationFarm(tx, farmIdInput);
    const recent = await tx.query("select 1 from vegetation_jobs where kind = 'test' and created_at > $1::timestamptz - interval '1 minute'", [now.toISOString()]);
    if (recent.rowCount) return { error: "A test ran less than a minute ago. Wait a moment, then try again." } as const;
    const settings = await settingsRow(tx);
    const usage = await usageThisMonth(tx, now);
    const credentials = options.connection ?? (await providerCredentials(tx));
    let grid: Grid;
    try {
      grid = await farmGridNow(tx, farm.id);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "This farm can't be tested." } as const;
    }
    const jobKey = `test:${farm.id}:${now.toISOString()}`;
    await enqueueJob(tx, { farmId: farm.id, kind: "test", key: jobKey, status: "running" });
    return { farm, grid, settings, usage, credentials, jobKey } as const;
  });
  if ("error" in prepared) throw new ProviderError("bad_request", prepared.error!);
  if (!prepared.credentials) throw new ProviderError("auth", "Connect an imagery account first.");
  const estimate = estimateUnits(prepared.grid.width, prepared.grid.height);
  if (Number(prepared.usage.units) + estimate > Number(prepared.settings.monthly_unit_budget)) throw new ProviderError("quota", "This month's processing budget would be used up by the test. Raise the budget, or wait for next month.");
  const provider = (options.providerFactory ?? defaultProviderFactory)(prepared.credentials);
  const result: PilotResult = {
    farmId: prepared.farm.id,
    farmName: prepared.farm.name,
    ranAt: now.toISOString(),
    provider: provider.id,
    acquiredAt: null,
    datesFound: 0,
    width: prepared.grid.width,
    height: prepared.grid.height,
    bytes: 0,
    searchMs: 0,
    fetchMs: 0,
    processMs: 0,
    unitsSpent: null,
    unitsEstimated: estimate,
    rssBeforeMb: Math.round(process.memoryUsage().rss / 1048576),
    rssAfterMb: 0,
    clearPct: null,
    error: null,
  };
  let preview: string | null = null;
  let requests = 0;
  try {
    let at = Date.now();
    const candidates = await provider.search({ box: gridLonLatBox(prepared.grid), from: new Date(now.getTime() - 30 * 86_400_000).toISOString(), to: now.toISOString(), maxSceneCloudPct: SKIP_SCENE_CLOUD_PCT });
    requests += provider.id === "demo" ? 0 : 1;
    result.searchMs = Date.now() - at;
    result.datesFound = candidates.length;
    const best = [...candidates].sort((a, b) => (a.sceneCloudPct ?? 100) - (b.sceneCloudPct ?? 100) || Date.parse(b.acquiredAt) - Date.parse(a.acquiredAt))[0];
    if (best) {
      at = Date.now();
      const picture = await provider.fetch({ grid: prepared.grid, candidate: best });
      requests += picture.requests;
      result.fetchMs = Date.now() - at;
      result.bytes = picture.png.byteLength;
      result.unitsSpent = picture.unitsSpent;
      result.acquiredAt = best.acquiredAt;
      at = Date.now();
      const boundaries = await withOrganisationTransaction(organisation, actor, (tx) => currentBoundaries(tx, prepared.farm.id));
      const worked = await workOut(organisation.id, prepared.farm.id, prepared.grid, picture.png, picture.dnOffset, boundaries, { minCoveragePct: prepared.settings.min_coverage_pct, minValidPixels: prepared.settings.min_valid_pixels }, null);
      result.processMs = Date.now() - at;
      result.clearPct = worked.farmValidPct;
      preview = `data:image/png;base64,${Buffer.from(worked.overlay).toString("base64")}`;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : "The test failed.";
  }
  result.rssAfterMb = Math.round(process.memoryUsage().rss / 1048576);
  const units = result.unitsSpent ?? (provider.id === "demo" || !result.bytes ? 0 : estimate);
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query("update vegetation_jobs set status = $2, finished_at = now(), units_spent = $3, requests = $4, bytes_fetched = $5, last_error = $6 where job_key = $1", [prepared.jobKey, result.error ? "failed" : "done", units, requests, result.bytes, result.error]);
    await saveLastTest(tx, result);
  });
  return { result, preview, bounds: gridLonLatBox(prepared.grid) };
}
