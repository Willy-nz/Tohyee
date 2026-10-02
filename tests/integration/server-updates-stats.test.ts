import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import * as prepareRoute from "@/app/api/admin/updates/prepare/route";
import * as adminUpdatesRoute from "@/app/api/admin/updates/route";
import * as statsRoute from "@/app/api/admin/stats/route";
import * as statusRoute from "@/app/api/updates/status/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { updateBackupSettings } from "@/lib/backups/service";
import { coreQuery } from "@/lib/db/transactions";
import { resetCounters } from "@/lib/server-stats/counters";
import { resetStats, takeSample } from "@/lib/server-stats/sampler";
import { recordServerStart } from "@/lib/updates/server-starts";
import { resetUpdateCheckState } from "@/lib/updates/update-checker";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "update-co";
const KEY = "update-test-key-0123456789abcdefghijklmnop";
const HASH = "b".repeat(64);
const noContext = undefined as unknown;
const [major] = packageJson.version.split(".");
const NEWER = `${Number.parseInt(major, 10) + 1}.0.0`;

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/** GitHub answering with a newer release that has a Windows installer (with or without a digest). */
function stubNewerRelease(digest: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () =>
      Response.json({
        tag_name: `v${NEWER}`,
        name: `Tohyee v${NEWER}`,
        html_url: `https://github.com/Willy-nz/Tohyee/releases/tag/v${NEWER}`,
        published_at: "2026-10-01T00:00:00Z",
        draft: false,
        prerelease: false,
        assets: [
          {
            name: `TohyeeSetup-${NEWER}.exe`,
            browser_download_url: `https://github.com/Willy-nz/Tohyee/releases/download/v${NEWER}/TohyeeSetup-${NEWER}.exe`,
            size: 200_000_000,
            content_type: "application/octet-stream",
            digest,
          },
        ],
      }),
    ),
  );
}

describeWithDatabase("server updates and stats (decisions 328 to 332)", () => {
  let server: TestServer;
  let admin: SessionUser;
  let cookie = "";
  let folder = "";
  const originalKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = KEY;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-update-backups-"));
    admin = await createTestUser("update-admin@example.com", { serverAdmin: true });
    cookie = await sessionCookieFor(admin);
    await createTestOrganisation(admin, ORG);
    await updateBackupSettings({ user: admin }, { folder });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetUpdateCheckState();
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = originalKey;
    resetStats();
    resetCounters();
    await server?.teardown();
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("records each start, with the version before it and any blocked organisations", async () => {
    await recordServerStart({ core: { applied: [] }, organisations: [{ organisationId: ORG, ok: true, applied: [] }] }, "0.9.0");
    const start = await recordServerStart(
      { core: { applied: ["0004"] }, organisations: [{ organisationId: ORG, ok: false, applied: [], error: "column x already exists" }] },
      "1.0.0",
    );
    expect(start).toMatchObject({
      version: "1.0.0",
      previousVersion: "0.9.0",
      coreApplied: ["0004"],
      organisationsChecked: 1,
      organisationsUpgraded: 0,
      organisationsBlocked: [{ organisationId: ORG, error: "column x already exists" }],
    });
    // Nobody can change the record afterwards.
    await expect(coreQuery("update server_starts set version = 'x'")).rejects.toThrow("server_starts is append-only");
  });

  it("tells the tray icon about updates without a sign-in, but only on the server computer, and with counts only", async () => {
    const remote = await statusRoute.GET(apiRequest("/api/updates/status", { local: false }), noContext);
    expect(remote.status).toBe(403);
    const local = await statusRoute.GET(apiRequest("/api/updates/status"), noContext);
    expect(local.status).toBe(200);
    const status = await body(local);
    expect(status).toMatchObject({
      currentVersion: packageJson.version,
      checkedAt: null,
      updateAvailable: false,
      lastStart: { version: "1.0.0", previousVersion: "0.9.0", organisationsBlocked: 1 },
    });
    expect(JSON.stringify(status)).not.toContain("column x already exists");
  });

  it("shows a server admin the last update and the blocked organisations", async () => {
    await coreQuery("update organisations set migration_status = 'failed', migration_error = 'column x already exists' where id = $1", [ORG]);
    const response = await adminUpdatesRoute.GET(apiRequest("/api/admin/updates", { cookie }), noContext);
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      lastUpdate: { version: "1.0.0", previousVersion: "0.9.0" },
      blockedOrganisations: [{ organisationId: ORG, displayName: `Test ${ORG}`, error: "column x already exists" }],
    });
    await coreQuery("update organisations set migration_status = 'current', migration_error = null where id = $1", [ORG]);
    const noSignIn = await adminUpdatesRoute.GET(apiRequest("/api/admin/updates"), noContext);
    expect(noSignIn.status).toBe(401);
  });

  it("Install: refuses without a fingerprint or for another version; otherwise backs everything up first and hands back the installer", async () => {
    stubNewerRelease(null);
    const noHash = await prepareRoute.POST(apiRequest("/api/admin/updates/prepare", { method: "POST", cookie, body: { version: NEWER } }), noContext);
    expect(noHash.status).toBe(503);
    expect((await body(noHash)).error).toContain("Couldn't get a SHA-256 fingerprint");
    expect((await coreQuery("select count(*)::int as n from backup_runs where trigger = 'update'")).rows[0]).toEqual({ n: 0 });

    stubNewerRelease(`sha256:${HASH}`);
    const otherVersion = await prepareRoute.POST(apiRequest("/api/admin/updates/prepare", { method: "POST", cookie, body: { version: "0.0.1" } }), noContext);
    expect(otherVersion.status).toBe(409);
    expect((await body(otherVersion)).error).toBe(`The latest release is now v${NEWER}, not v0.0.1. Check again before installing.`);

    const prepared = await prepareRoute.POST(apiRequest("/api/admin/updates/prepare", { method: "POST", cookie, body: { version: `v${NEWER}` } }), noContext);
    expect(prepared.status).toBe(200);
    const result = await body(prepared);
    expect(result).toMatchObject({
      currentVersion: packageJson.version,
      version: NEWER,
      setup: { name: `TohyeeSetup-${NEWER}.exe`, sha256: HASH, sha256From: "github-digest", size: 200_000_000 },
    });
    expect((result.backups as { organisationId: string | null; status: string; trigger: string }[]).map((r) => [r.organisationId, r.status, r.trigger])).toEqual([
      [null, "ok", "update"],
      [ORG, "ok", "update"],
    ]);
  });

  it("Install: stops before the download when a backup fails", async () => {
    stubNewerRelease(`sha256:${HASH}`);
    const original = process.env.TOHYEE_PG_BIN;
    process.env.TOHYEE_PG_BIN = path.join(folder, "no-such-folder");
    try {
      const response = await prepareRoute.POST(apiRequest("/api/admin/updates/prepare", { method: "POST", cookie, body: { version: NEWER } }), noContext);
      expect(response.status).toBe(409);
      const error = (await body(response)).error as string;
      expect(error).toMatch(/^The update wasn't started because 2 backups failed: /);
      expect(error).not.toContain("TohyeeSetup");
    } finally {
      if (original === undefined) delete process.env.TOHYEE_PG_BIN;
      else process.env.TOHYEE_PG_BIN = original;
    }
  });

  it("gives a server admin the stats, with the last 24 hours", async () => {
    resetStats();
    resetCounters();
    await takeSample();
    // A request made between samples is counted in the next one.
    await adminUpdatesRoute.GET(apiRequest("/api/admin/updates", { cookie }), noContext);
    await takeSample();
    const response = await statsRoute.GET(apiRequest("/api/admin/stats", { cookie }), noContext);
    expect(response.status).toBe(200);
    const stats = await body(response);
    expect(stats).toMatchObject({
      version: packageJson.version,
      sampleEverySeconds: 60,
      people: { activeNow: 1, users: expect.any(Number) },
      organisations: { ready: 1, blocked: 0 },
    });
    const history = stats.history as { requests: number; cpuPercent: number | null; memoryTotalBytes: number }[];
    expect(history).toHaveLength(2);
    expect(history[1].requests).toBe(1);
    expect(history[1].memoryTotalBytes).toBeGreaterThan(0);
    const databases = stats.databases as { list: { organisationId: string | null; sizeBytes: number }[] };
    expect(databases.list.map((d) => d.organisationId)).toEqual([null, ORG]);
    expect(databases.list.every((d) => d.sizeBytes > 0)).toBe(true);
    expect((stats.disks as unknown[]).length).toBeGreaterThan(0);
    expect(typeof stats.postgresVersion).toBe("string");

    const remote = await statsRoute.GET(apiRequest("/api/admin/stats", { cookie, local: false }), noContext);
    expect(remote.status).toBe(403);
  });
});
