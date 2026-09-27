import { UnavailableError } from "@/lib/errors";

/**
 * Connection settings.
 *
 * DATABASE_URL        Runtime login. Its database is the "core" control-plane
 *                     database (organisations, users, sessions).
 * DATABASE_ADMIN_URL  Optional. A login with CREATEDB that owns organisation
 *                     databases and runs migrations. Defaults to DATABASE_URL.
 *
 * Each organisation's database lives on the same server and is reached by
 * swapping the database name in these URLs.
 */
export function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new UnavailableError("DATABASE_URL is not configured on the server.");
  }
  return value;
}

export function getAdminDatabaseUrl(): string {
  return process.env.DATABASE_ADMIN_URL?.trim() || getDatabaseUrl();
}

export function hasSeparateAdminRole(): boolean {
  return usernameOf(getAdminDatabaseUrl()) !== usernameOf(getDatabaseUrl());
}

export function databaseNameOf(url: string): string {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!name) {
    throw new UnavailableError("DATABASE_URL must include a database name, e.g. .../tohyee");
  }
  return name;
}

export function usernameOf(url: string): string {
  return decodeURIComponent(new URL(url).username);
}

export function withDatabaseName(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(databaseName)}`;
  return parsed.toString();
}

export function coreDatabaseName(): string {
  return databaseNameOf(getDatabaseUrl());
}

/** Prefix for organisation databases, e.g. "tohyee_org_" + slug. */
export function organisationDatabasePrefix(): string {
  const configured = process.env.TOHYEE_ORG_DATABASE_PREFIX?.trim();
  if (configured && /^[a-z][a-z0-9_]{0,20}$/.test(configured)) {
    return configured;
  }
  const core = coreDatabaseName().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 20);
  return `${/^[a-z]/.test(core) ? core : "tohyee"}_org_`;
}
