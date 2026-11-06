import pg from "pg";
import {
  getAdminDatabaseUrl,
  getDatabaseUrl,
  withDatabaseName,
} from "@/lib/db/connection";
import { tohyeeTypes } from "@/lib/db/pg-types";

type OrganisationPoolEntry = {
  pool: pg.Pool;
  lastUsedAt: number;
};

type PoolRegistry = {
  core: pg.Pool | null;
  admin: pg.Pool | null;
  organisations: Map<string, OrganisationPoolEntry>;
};

// Kept on globalThis so dev-server hot reloads don't leak connection pools.
const globalForPools = globalThis as typeof globalThis & {
  __tohyeePools?: PoolRegistry;
};

function registry(): PoolRegistry {
  if (!globalForPools.__tohyeePools) {
    globalForPools.__tohyeePools = {
      core: null,
      admin: null,
      organisations: new Map(),
    };
  }
  return globalForPools.__tohyeePools;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createPool(connectionString: string, max: number): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    types: tohyeeTypes,
  });
  // An idle client dying (e.g. database restart) must not crash the server.
  pool.on("error", (error) => {
    console.error("[tohyee] idle database connection error:", error.message);
  });
  // The pool only listens to idle clients. One in use whose session is ended
  // (a database dropped WITH (FORCE), or a restart) mustn't crash the server
  // either: its next query fails instead.
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      console.error("[tohyee] database connection error:", error.message);
    });
  });
  return pool;
}

/** Pool for the core control-plane database (runtime login). */
export function getCorePool(): pg.Pool {
  const pools = registry();
  if (!pools.core) {
    pools.core = createPool(getDatabaseUrl(), positiveInt(process.env.TOHYEE_CORE_POOL_SIZE, 10));
  }
  return pools.core;
}

/** Pool for administrative work on the core database (CREATE DATABASE etc.). */
export function getAdminPool(): pg.Pool {
  const pools = registry();
  if (!pools.admin) {
    pools.admin = createPool(getAdminDatabaseUrl(), 2);
  }
  return pools.admin;
}

/**
 * One small pool per organisation database. Least-recently-used pools are
 * closed when there are more than TOHYEE_MAX_ORG_POOLS open.
 */
export function getOrganisationPool(databaseName: string): pg.Pool {
  const pools = registry();
  const existing = pools.organisations.get(databaseName);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.pool;
  }

  const pool = createPool(
    withDatabaseName(getDatabaseUrl(), databaseName),
    positiveInt(process.env.TOHYEE_ORG_POOL_SIZE, 5),
  );
  pools.organisations.set(databaseName, { pool, lastUsedAt: Date.now() });

  const maxPools = positiveInt(process.env.TOHYEE_MAX_ORG_POOLS, 25);
  if (pools.organisations.size > maxPools) {
    // Only an idle pool is closed: ending one with a transaction in flight would break it (#136). If every pool
    // is busy, there are a few more open for a while.
    const idle = (entry: { pool: pg.Pool }) => entry.pool.totalCount === entry.pool.idleCount && entry.pool.waitingCount === 0;
    const oldest = [...pools.organisations.entries()]
      .filter(([name, entry]) => name !== databaseName && idle(entry))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (oldest) {
      pools.organisations.delete(oldest[0]);
      void oldest[1].pool.end().catch(() => undefined);
    }
  }

  return pool;
}

/** How long closing a pool waits for connections still out (TOHYEE_POOL_CLOSE_WAIT_MS, default 10 seconds). */
function closeWaitMs(): number {
  return positiveInt(process.env.TOHYEE_POOL_CLOSE_WAIT_MS, 10_000);
}

/**
 * Ends a pool, waiting at most `waitMs` for connections still out (a job,
 * or a query stuck behind a lock). pg's end() otherwise waits for every one
 * to come back, which can be forever. What's left is said in the log; a
 * DROP DATABASE ... WITH (FORCE) after this ends those sessions.
 */
async function endPool(pool: pg.Pool, name: string, waitMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const ended = pool.end().then(
    () => true,
    () => true,
  );
  const waited = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
    timer.unref?.();
  });
  const done = await Promise.race([ended, waited]);
  if (timer) clearTimeout(timer);
  if (!done) {
    const out = pool.totalCount - pool.idleCount;
    console.warn(`[tohyee] Closing the ${name} pool: ${out} connection${out === 1 ? "" : "s"} still in use after ${waitMs} ms. Going on without them.`);
  }
}

/** Closes and forgets a single organisation pool (e.g. before dropping it). */
export async function closeOrganisationPool(databaseName: string, options: { waitMs?: number } = {}): Promise<void> {
  const pools = registry();
  const entry = pools.organisations.get(databaseName);
  if (entry) {
    pools.organisations.delete(databaseName);
    await endPool(entry.pool, databaseName, options.waitMs ?? closeWaitMs());
  }
}

/** Opens a single admin connection to any database (used for migrations). */
export async function connectAsAdmin(databaseName: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: withDatabaseName(getAdminDatabaseUrl(), databaseName),
    types: tohyeeTypes,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
}

export async function closeAllPools(options: { waitMs?: number } = {}): Promise<void> {
  const pools = registry();
  const all: Array<[string, pg.Pool]> = [];
  if (pools.core) all.push(["core", pools.core]);
  if (pools.admin) all.push(["admin", pools.admin]);
  for (const [name, entry] of pools.organisations.entries()) all.push([name, entry.pool]);
  pools.core = null;
  pools.admin = null;
  pools.organisations.clear();
  const waitMs = options.waitMs ?? closeWaitMs();
  await Promise.all(all.map(([name, pool]) => endPool(pool, name, waitMs)));
}
