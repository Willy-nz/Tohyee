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
    const [oldestName, oldest] = [...pools.organisations.entries()]
      .filter(([name]) => name !== databaseName)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    pools.organisations.delete(oldestName);
    void oldest.pool.end().catch(() => undefined);
  }

  return pool;
}

/** Closes and forgets a single organisation pool (e.g. before dropping it). */
export async function closeOrganisationPool(databaseName: string): Promise<void> {
  const pools = registry();
  const entry = pools.organisations.get(databaseName);
  if (entry) {
    pools.organisations.delete(databaseName);
    await entry.pool.end();
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

export async function closeAllPools(): Promise<void> {
  const pools = registry();
  const all: pg.Pool[] = [];
  if (pools.core) all.push(pools.core);
  if (pools.admin) all.push(pools.admin);
  for (const entry of pools.organisations.values()) all.push(entry.pool);
  pools.core = null;
  pools.admin = null;
  pools.organisations.clear();
  await Promise.all(all.map((pool) => pool.end().catch(() => undefined)));
}
