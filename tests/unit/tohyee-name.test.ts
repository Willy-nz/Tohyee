import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";
import { SESSION_COOKIE, clearSessionCookieHeader, sessionCookieHeader } from "@/lib/auth/sessions";
import { businessTimeZone } from "@/lib/dates";
import { organisationDatabasePrefix } from "@/lib/db/connection";
import { coreMigrations } from "@/lib/db/migrations/core";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { closeAllPools, getCorePool, getOrganisationPool } from "@/lib/db/pools";

// The project's old name, written as t[o]eyee so this file doesn't match itself.
const OLD_NAME = /t[o]eyee/i;
const OLD_NAME_WORDS = /\w*t[o]eyee\w*/gi;

/** Whole words containing the old name, other than the kept database function names. */
function oldNamesIn(text: string, keptNames: ReadonlySet<string>): string[] {
  return [...text.matchAll(OLD_NAME_WORDS)].map((match) => match[0]).filter((word) => !keptNames.has(word));
}

describe("the Tohyee name", () => {
  it("the old name only survives in database functions created by released migrations", () => {
    // Released migrations are checksummed, so the functions they created keep
    // their names. Later migrations must not add more.
    const released = [
      ...coreMigrations.filter((migration) => migration.version <= "0001"),
      ...tenantMigrations.filter((migration) => migration.version <= "0004"),
    ];
    const keptNames = new Set(
      released
        .flatMap((migration) => [...migration.sql.matchAll(/create function (\w+)/gi)].map((match) => match[1]))
        .filter((name) => OLD_NAME.test(name)),
    );
    expect(keptNames.size).toBeGreaterThan(0);

    // Only whole kept names pass: a new name that starts with one is still caught.
    const old = ["t", "oeyee"].join("");
    const kept = [...keptNames][0];
    expect(oldNamesIn(`perform ${kept}(new.id);`, keptNames)).toEqual([]);
    expect(oldNamesIn(`create function ${kept}_v2()`, keptNames)).toEqual([`${kept}_v2`]);
    expect(oldNamesIn(`create function ${old}_brand_new()`, keptNames)).toEqual([`${old}_brand_new`]);
    expect(oldNamesIn(`container_name: ${old.toUpperCase()}-postgres`, keptNames)).toEqual([old.toUpperCase()]);

    const offenders: string[] = [];
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter((file) => file && existsSync(file));
    for (const file of files) {
      if (oldNamesIn(file, keptNames).length > 0) {
        offenders.push(`${file}: file name`);
      }
      const content = readFileSync(file);
      if (content.includes(0)) {
        continue; // binary, e.g. screenshots
      }
      content
        .toString("utf8")
        .split("\n")
        .forEach((line, index) => {
          if (oldNamesIn(line, keptNames).length > 0) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe("server settings (TOHYEE_* environment variables)", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await closeAllPools();
  });

  it("the session cookie is tohyee_session, and TOHYEE_COOKIE_SECURE overrides the Secure flag", () => {
    const overHttp = new Request("http://tohyee.test/api/auth/login");
    const overHttps = new Request("https://tohyee.test/api/auth/login");
    vi.stubEnv("TOHYEE_COOKIE_SECURE", undefined);
    expect(SESSION_COOKIE).toBe("tohyee_session");
    expect(sessionCookieHeader(overHttp, "abc")).toMatch(/^tohyee_session=abc; /);
    expect(clearSessionCookieHeader(overHttp)).toMatch(/^tohyee_session=; /);
    expect(sessionCookieHeader(overHttp, "abc")).not.toMatch(/; Secure$/);
    expect(sessionCookieHeader(overHttps, "abc")).toMatch(/; Secure$/);

    vi.stubEnv("TOHYEE_COOKIE_SECURE", "true");
    expect(sessionCookieHeader(overHttp, "abc")).toMatch(/; Secure$/);
    vi.stubEnv("TOHYEE_COOKIE_SECURE", "false");
    expect(sessionCookieHeader(overHttps, "abc")).not.toMatch(/; Secure$/);
  });

  it("TOHYEE_TIME_ZONE sets the business time zone (default Pacific/Auckland)", () => {
    vi.stubEnv("TOHYEE_TIME_ZONE", undefined);
    expect(businessTimeZone()).toBe("Pacific/Auckland");
    vi.stubEnv("TOHYEE_TIME_ZONE", "Pacific/Chatham");
    expect(businessTimeZone()).toBe("Pacific/Chatham");
  });

  it("TOHYEE_ORG_DATABASE_PREFIX names new organisation databases (default <core database>_org_)", () => {
    vi.stubEnv("TOHYEE_ORG_DATABASE_PREFIX", undefined);
    vi.stubEnv("DATABASE_URL", "postgresql://app@localhost:5432/tohyee");
    expect(organisationDatabasePrefix()).toBe("tohyee_org_");
    vi.stubEnv("DATABASE_URL", "postgresql://app@localhost:5432/books");
    expect(organisationDatabasePrefix()).toBe("books_org_");
    // A core database name that doesn't start with a letter falls back to "tohyee".
    vi.stubEnv("DATABASE_URL", "postgresql://app@localhost:5432/2026");
    expect(organisationDatabasePrefix()).toBe("tohyee_org_");
    vi.stubEnv("TOHYEE_ORG_DATABASE_PREFIX", "ledger_");
    expect(organisationDatabasePrefix()).toBe("ledger_");
  });

  it("TOHYEE_CORE_POOL_SIZE, TOHYEE_ORG_POOL_SIZE and TOHYEE_MAX_ORG_POOLS size the connection pools", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://app@localhost:5432/tohyee");
    vi.stubEnv("TOHYEE_CORE_POOL_SIZE", "3");
    vi.stubEnv("TOHYEE_ORG_POOL_SIZE", "2");
    vi.stubEnv("TOHYEE_MAX_ORG_POOLS", "1");
    expect(getCorePool().options.max).toBe(3);
    const first = getOrganisationPool("tohyee_org_one");
    expect(first.options.max).toBe(2);
    // Only one organisation pool is kept open, so opening another closes the first.
    getOrganisationPool("tohyee_org_two");
    expect(first.ending).toBe(true);
  });

  it("TOHYEE_SKIP_STARTUP_MIGRATIONS=1 skips the migrations at startup", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", undefined);
    // Nothing listens here, so migrating would fail.
    vi.stubEnv("DATABASE_URL", "postgresql://app@127.0.0.1:1/tohyee");
    vi.stubEnv("TOHYEE_SKIP_STARTUP_MIGRATIONS", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await register();
    expect(log).toHaveBeenCalledWith("[tohyee] Skipping startup migrations (TOHYEE_SKIP_STARTUP_MIGRATIONS=1).");
  });
});
