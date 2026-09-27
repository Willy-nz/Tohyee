import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";
import { hashPassword } from "@/lib/auth/password";
import { createSession, SESSION_COOKIE, type SessionUser } from "@/lib/auth/sessions";
import { migrateCoreDatabase } from "@/lib/db/migrations";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { closeAllPools } from "@/lib/db/pools";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { createOrganisation } from "@/lib/organisations/admin";
import { getOrganisation } from "@/lib/organisations/registry";

/**
 * Integration tests need a PostgreSQL server where TEST_DATABASE_URL's login
 * can CREATE DATABASE, e.g.
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
 * Each test file gets its own throwaway core database and organisation
 * databases, and drops them afterwards.
 */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() || null;

if (!testDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL must be set in CI so the database tests run.");
}

export const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

export function withDb(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export function withLogin(url: string, username: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}

/** A throwaway PostgreSQL login, for tests that need more than one. */
export async function createTestLogin(prefix: string): Promise<{ role: string; password: string }> {
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  const role = `${prefix}_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  const admin = new pg.Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`create role "${role}" login password '${password}'`);
  } finally {
    await admin.end();
  }
  return { role, password };
}

export async function dropTestLogin(role: string): Promise<void> {
  const admin = new pg.Client({ connectionString: testDatabaseUrl! });
  await admin.connect();
  try {
    await admin.query(`drop role if exists "${role}"`);
  } finally {
    await admin.end();
  }
}

export type TestServer = {
  coreDatabase: string;
  /** Set when the server runs with a separate runtime login (DATABASE_ADMIN_URL mode). */
  runtimeLogin: { role: string; password: string } | null;
  teardown(): Promise<void>;
};

/**
 * Creates a throwaway core database and points the app at it.
 *
 * By default one login does everything (DATABASE_URL only). With
 * `separateRuntimeLogin`, TEST_DATABASE_URL's login becomes DATABASE_ADMIN_URL
 * and the app runs as a new, unprivileged login, like a hardened install.
 */
export async function startTestServer(options: { separateRuntimeLogin?: boolean } = {}): Promise<TestServer> {
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  const coreDatabase = `tohyee_t_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  await admin.query(`create database "${coreDatabase}"`);
  await admin.end();

  const runtimeLogin = options.separateRuntimeLogin ? await createTestLogin("tohyee_rt") : null;
  if (runtimeLogin) {
    process.env.DATABASE_ADMIN_URL = withDb(testDatabaseUrl, coreDatabase);
    process.env.DATABASE_URL = withLogin(
      withDb(testDatabaseUrl, coreDatabase),
      runtimeLogin.role,
      runtimeLogin.password,
    );
  } else {
    process.env.DATABASE_URL = withDb(testDatabaseUrl, coreDatabase);
    delete process.env.DATABASE_ADMIN_URL;
  }
  process.env.SETUP_TOKEN = "test-setup-token-123456";
  await migrateCoreDatabase();

  return {
    coreDatabase,
    runtimeLogin,
    async teardown() {
      await closeAllPools();
      const cleaner = new pg.Client({ connectionString: testDatabaseUrl });
      await cleaner.connect();
      const databases = await cleaner.query<{ datname: string }>(
        "select datname from pg_database where datname = $1 or datname like $2",
        [coreDatabase, `${coreDatabase}_org_%`],
      );
      for (const row of databases.rows) {
        await cleaner.query(`drop database if exists "${row.datname}" with (force)`);
      }
      await cleaner.end();
      if (runtimeLogin) {
        await dropTestLogin(runtimeLogin.role);
      }
    },
  };
}

let passwordHashCache: Promise<string> | null = null;
export const TEST_PASSWORD = "correct-horse-battery";

export async function createTestUser(
  email: string,
  options: { serverAdmin?: boolean; displayName?: string } = {},
): Promise<SessionUser> {
  passwordHashCache ??= hashPassword(TEST_PASSWORD);
  const result = await coreQuery<{ id: string }>(
    `insert into users (email, display_name, password_hash, is_server_admin)
     values ($1, $2, $3, $4) returning id`,
    [email, options.displayName ?? email.split("@")[0], await passwordHashCache, options.serverAdmin ?? false],
  );
  return {
    id: result.rows[0].id,
    email,
    displayName: options.displayName ?? email.split("@")[0],
    isServerAdmin: options.serverAdmin ?? false,
  };
}

/** Signs a user in and returns a Cookie header value. */
export async function sessionCookieFor(user: SessionUser): Promise<string> {
  const session = await withCoreTransaction((client) =>
    createSession(client, user.id, { userAgent: "vitest", ipAddress: null }),
  );
  return `${SESSION_COOKIE}=${session.token}`;
}

export async function createTestOrganisation(
  owner: SessionUser,
  id: string,
  options: { baseCurrency?: string } = {},
) {
  const organisation = await createOrganisation(owner, {
    id,
    displayName: `Test ${id}`,
    baseCurrency: options.baseCurrency ?? "NZD",
    ownerEmail: owner.email,
  });
  if (organisation.provisioningStatus !== "ready") {
    throw new Error(`Provisioning failed: ${organisation.provisioningError}`);
  }
  return organisation;
}

/** Runs work in an organisation's database as the given actor. */
export async function inOrganisation<T>(
  organisationId: string,
  actor: Actor,
  work: (tx: OrgTx) => Promise<T>,
): Promise<T> {
  const organisation = await getOrganisation(organisationId);
  if (!organisation) throw new Error(`No organisation ${organisationId}`);
  return withOrganisationTransaction(organisation, actor, work);
}

/**
 * Waits until this many other connections to the transaction's database are
 * queued for a lock, e.g. behind a row the transaction has locked.
 */
export async function waitForLockWaiters(tx: OrgTx, count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await tx.query("select pg_stat_clear_snapshot()");
    const waiting = await tx.query<{ count: string }>(
      "select count(*)::text as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if (Number(waiting.rows[0].count) >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} connections to queue for a lock.`);
}

let keyCounter = 0;
/** Unique idempotency key for a test command. */
export function key(label = "k"): string {
  keyCounter += 1;
  return `${label}-${Date.now()}-${keyCounter}`;
}

/** Builds a Request like a browser on the same origin would send. */
export function apiRequest(
  path: string,
  options: { method?: string; cookie?: string; body?: unknown; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const origin = options.origin === undefined ? "http://tohyee.test" : options.origin;
  if (origin) headers.origin = origin;
  return new Request(`http://tohyee.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export function params<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}
