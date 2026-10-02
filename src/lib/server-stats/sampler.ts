import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import packageJson from "../../../package.json";
import { getBackupSettings } from "@/lib/backups/service";
import { coreQuery } from "@/lib/db/transactions";
import { activeUsers, takeRequestCounts } from "@/lib/server-stats/counters";

/**
 * The server app's Stats page (decision 332), like a media server's dashboard:
 * how busy this computer and Tohyee are. Once a minute the server takes a
 * sample (CPU, memory, disk, requests, people using it, database connections)
 * and keeps the last 24 hours in memory; database sizes are read every 15
 * minutes. Nothing is stored, so a restart starts the graphs again. Off with
 * TOHYEE_SERVER_STATS=off.
 */

export const SAMPLE_EVERY_MS = 60 * 1000;
export const KEEP_SAMPLES = 24 * 60;
const SIZES_EVERY_MS = 15 * 60 * 1000;
const ACTIVE_WITHIN_MS = 5 * 60 * 1000;

export type StatsSample = {
  at: string;
  /** The whole computer's CPU use over the minute, 0 to 100. */
  cpuPercent: number | null;
  /** Tohyee's own share (this server process), 0 to 100 of the whole computer. */
  tohyeeCpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  tohyeeMemoryBytes: number;
  requests: number;
  serverErrors: number;
  averageMs: number | null;
  slowestMs: number | null;
  /** People who made a signed-in request in the last 5 minutes. */
  activeUsers: number;
  databaseConnections: number | null;
};

export type DiskUse = { label: string; path: string; freeBytes: number; totalBytes: number };
export type DatabaseSize = { organisationId: string | null; name: string; sizeBytes: number };

type CpuTimes = { idle: number; total: number };

type SamplerState = {
  startedAt: number;
  samples: StatsSample[];
  lastCpu: CpuTimes | null;
  lastProcessCpu: { usage: NodeJS.CpuUsage; at: number } | null;
  sizes: { at: string; databases: DatabaseSize[] } | null;
  sizesAt: number;
  timer?: ReturnType<typeof setInterval>;
};

const holder = globalThis as typeof globalThis & { __tohyeeStats?: SamplerState };

function sampler(): SamplerState {
  holder.__tohyeeStats ??= { startedAt: Date.now(), samples: [], lastCpu: null, lastProcessCpu: null, sizes: null, sizesAt: 0 };
  return holder.__tohyeeStats;
}

// ------------------------------------------------------------------ pure parts (tested)

export function cpuTimes(cpus: Pick<os.CpuInfo, "times">[]): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Busy share of CPU time between two readings, 0 to 100 (null when no time passed). */
export function cpuPercentBetween(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0) return null;
  return round1(Math.min(100, Math.max(0, ((total - idle) / total) * 100)));
}

/** This process's CPU time as a share of the whole computer (all cores), 0 to 100. */
export function processCpuPercent(usedMicros: number, elapsedMs: number, cores: number): number | null {
  if (elapsedMs <= 0 || cores <= 0) return null;
  return round1(Math.min(100, Math.max(0, (usedMicros / 1000 / (elapsedMs * cores)) * 100)));
}

/** Adds a sample, keeping the newest `keep`. */
export function pushSample(samples: StatsSample[], sample: StatsSample, keep = KEEP_SAMPLES): StatsSample[] {
  samples.push(sample);
  if (samples.length > keep) samples.splice(0, samples.length - keep);
  return samples;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ------------------------------------------------------------------ sampling

async function databaseConnections(): Promise<number | null> {
  try {
    const result = await coreQuery<{ count: string }>("select count(*)::text as count from pg_stat_activity where backend_type = 'client backend'");
    return Number(result.rows[0]?.count ?? 0);
  } catch {
    return null;
  }
}

/** Takes one sample now (the CPU figures cover the time since the last one). */
export async function takeSample(now = Date.now()): Promise<StatsSample> {
  const state = sampler();
  const cpu = cpuTimes(os.cpus());
  const cpuPercent = state.lastCpu ? cpuPercentBetween(state.lastCpu, cpu) : null;
  state.lastCpu = cpu;
  const usage = process.cpuUsage();
  const tohyeeCpuPercent = state.lastProcessCpu
    ? processCpuPercent(
        usage.user - state.lastProcessCpu.usage.user + (usage.system - state.lastProcessCpu.usage.system),
        now - state.lastProcessCpu.at,
        os.cpus().length,
      )
    : null;
  state.lastProcessCpu = { usage, at: now };
  const requests = takeRequestCounts();
  const sample: StatsSample = {
    at: new Date(now).toISOString(),
    cpuPercent,
    tohyeeCpuPercent,
    memoryUsedBytes: os.totalmem() - os.freemem(),
    memoryTotalBytes: os.totalmem(),
    tohyeeMemoryBytes: process.memoryUsage().rss,
    ...requests,
    activeUsers: activeUsers(ACTIVE_WITHIN_MS, now),
    databaseConnections: await databaseConnections(),
  };
  pushSample(state.samples, sample);
  return sample;
}

/** The size of the server's own database and each organisation's. */
export async function databaseSizes(): Promise<DatabaseSize[]> {
  const sizes: DatabaseSize[] = [];
  try {
    const core = await coreQuery<{ size: string }>("select pg_database_size(current_database())::text as size");
    sizes.push({ organisationId: null, name: "Server (users and settings)", sizeBytes: Number(core.rows[0].size) });
  } catch {
    // Not allowed to see it: left out.
  }
  const organisations = await coreQuery<{ id: string; display_name: string; database_name: string }>(
    "select id, display_name, database_name from organisations where provisioning_status = 'ready' order by display_name, id",
  );
  for (const organisation of organisations.rows) {
    try {
      const size = await coreQuery<{ size: string }>("select pg_database_size($1)::text as size", [organisation.database_name]);
      sizes.push({ organisationId: organisation.id, name: organisation.display_name, sizeBytes: Number(size.rows[0].size) });
    } catch {
      // A database that can't be read (e.g. being restored) is left out.
    }
  }
  return sizes;
}

async function cachedDatabaseSizes(now = Date.now()): Promise<{ at: string; databases: DatabaseSize[] } | null> {
  const state = sampler();
  if (!state.sizes || now - state.sizesAt >= SIZES_EVERY_MS) {
    try {
      state.sizes = { at: new Date(now).toISOString(), databases: await databaseSizes() };
      state.sizesAt = now;
    } catch {
      // Keep the last answer.
    }
  }
  return state.sizes;
}

/** The nearest folder that exists, for asking about its disk. */
async function existingFolder(folder: string): Promise<string> {
  let current = path.resolve(folder);
  for (;;) {
    try {
      await statfs(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** Free space on the disks Tohyee uses: where it's installed, and where backups go (one line when they're the same disk). */
export async function diskUse(): Promise<DiskUse[]> {
  const places: { label: string; folder: string }[] = [{ label: "Tohyee's program", folder: process.cwd() }];
  try {
    places.push({ label: "Backups", folder: (await getBackupSettings()).folder });
  } catch {
    // No backup settings yet.
  }
  const disks: (DiskUse & { key: string })[] = [];
  for (const place of places) {
    try {
      const folder = await existingFolder(place.folder);
      const fs = await statfs(folder);
      const totalBytes = Number(fs.blocks) * Number(fs.bsize);
      const freeBytes = Number(fs.bavail) * Number(fs.bsize);
      const key = `${totalBytes}:${process.platform === "win32" ? path.parse(folder).root.toLowerCase() : String(fs.type)}`;
      const same = disks.find((disk) => disk.key === key);
      if (same) same.label = `${same.label} and ${place.label.toLowerCase()}`;
      else disks.push({ key, label: place.label, path: place.folder, freeBytes, totalBytes });
    } catch {
      // Can't tell: left out.
    }
  }
  return disks.map((disk) => ({ label: disk.label, path: disk.path, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes }));
}

export type ServerStats = {
  version: string;
  startedAt: string;
  uptimeSeconds: number;
  computer: { platform: string; cpuModel: string | null; cores: number; memoryTotalBytes: number; computerUptimeSeconds: number };
  nodeVersion: string;
  postgresVersion: string | null;
  sampleEverySeconds: number;
  current: StatsSample | null;
  history: StatsSample[];
  disks: DiskUse[];
  databases: { at: string; list: DatabaseSize[]; totalBytes: number } | null;
  people: { activeNow: number; activeLast24Hours: number; signedIn: number; users: number };
  organisations: { ready: number; blocked: number };
};

async function postgresVersion(): Promise<string | null> {
  try {
    const result = await coreQuery<{ version: string }>("select current_setting('server_version') as version");
    return result.rows[0]?.version ?? null;
  } catch {
    return null;
  }
}

/** Everything the Stats page shows. */
export async function serverStats(now = Date.now()): Promise<ServerStats> {
  const state = sampler();
  const cpus = os.cpus();
  const sizes = await cachedDatabaseSizes(now);
  const people = await coreQuery<{ signed_in: string; users: string }>(
    `select (select count(distinct user_id) from sessions where expires_at > now() and not two_step_pending)::text as signed_in,
            (select count(*) from users where is_active)::text as users`,
  );
  const organisations = await coreQuery<{ ready: string; blocked: string }>(
    `select count(*) filter (where provisioning_status = 'ready')::text as ready,
            count(*) filter (where migration_status = 'failed')::text as blocked
       from organisations`,
  );
  return {
    version: packageJson.version,
    startedAt: new Date(state.startedAt).toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    computer: {
      platform: `${os.type()} ${os.release()}`,
      cpuModel: cpus[0]?.model?.trim() || null,
      cores: cpus.length,
      memoryTotalBytes: os.totalmem(),
      computerUptimeSeconds: Math.round(os.uptime()),
    },
    nodeVersion: process.version,
    postgresVersion: await postgresVersion(),
    sampleEverySeconds: SAMPLE_EVERY_MS / 1000,
    current: state.samples[state.samples.length - 1] ?? null,
    history: [...state.samples],
    disks: await diskUse(),
    databases: sizes ? { at: sizes.at, list: sizes.databases, totalBytes: sizes.databases.reduce((sum, d) => sum + d.sizeBytes, 0) } : null,
    people: {
      activeNow: activeUsers(ACTIVE_WITHIN_MS, now),
      activeLast24Hours: activeUsers(24 * 60 * 60 * 1000, now),
      signedIn: Number(people.rows[0].signed_in),
      users: Number(people.rows[0].users),
    },
    organisations: { ready: Number(organisations.rows[0].ready), blocked: Number(organisations.rows[0].blocked) },
  };
}

export function startStatsSampler(): void {
  const state = sampler();
  if (state.timer) return;
  // A first reading so the next one has something to compare CPU time with.
  state.lastCpu = cpuTimes(os.cpus());
  state.lastProcessCpu = { usage: process.cpuUsage(), at: Date.now() };
  state.timer = setInterval(() => {
    void takeSample().catch((error) => console.warn("[tohyee] Stats sample failed:", error instanceof Error ? error.message : error));
  }, SAMPLE_EVERY_MS);
  state.timer.unref?.();
}

export function stopStatsSampler(): void {
  const state = sampler();
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
}

/** For tests. */
export function resetStats(): void {
  stopStatsSampler();
  holder.__tohyeeStats = undefined;
}
