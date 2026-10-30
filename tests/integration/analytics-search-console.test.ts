import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as gaCallback from "@/app/api/analytics/google/callback/route";
import * as gscRoute from "@/app/api/analytics/google/search-console/route";
import * as gscLoadRoute from "@/app/api/analytics/google/search-console/load/route";
import * as gscSitesRoute from "@/app/api/analytics/google/search-console/sites/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as freshnessRoute from "@/app/api/analytics/dashboards/[dashboardId]/freshness/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import { closeAnalytics, listTables, queryAnalytics } from "@/lib/analytics/engine";
import { claimGaState, getGaStatus } from "@/lib/analytics/google-analytics";
import {
  disconnectGsc,
  fetchGscSignIn,
  getGscStatus,
  gscLoadsNightly,
  listGscSites,
  refreshGsc,
  saveGscSettings,
  saveGscSignIn,
  setGscRetryDelaysForTests,
  startGscConnect,
} from "@/lib/analytics/search-console";
import { claimGoogleState } from "@/lib/analytics/google-analytics";
import { runDueLoads } from "@/lib/analytics/scheduler";
import { recentLoads } from "@/lib/analytics/sources";
import { buildTemplate } from "@/lib/analytics/templates";
import type { SessionUser } from "@/lib/auth/sessions";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "gsc-website";
const noContext = undefined as unknown;
const SCOPE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/webmasters.readonly";
const SITE = "sc-domain:pawprints.example";
const API = "https://searchconsole.googleapis.com/webmasters/v3";
/** 1pm 31 October 2026 in California (9am 1 November in New Zealand): Google's today is 31 October. */
const NOW = new Date("2026-10-31T20:00:00Z");
const NEXT_DAY = new Date("2026-11-01T20:00:00Z");

type Row = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
const r = (keys: string[], clicks: number, impressions: number, position: number): Row => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

/** Made-up search figures for a small shop's website, 26-31 October 2026. `late` bumps 29 October, as Google finishing its count would. */
function fixture(day: string, dimension: string, late: boolean): Row[] {
  const days: Record<string, number> = { "2026-10-26": 10, "2026-10-27": 12, "2026-10-28": 8, "2026-10-29": late ? 15 : 9, "2026-10-30": 4, "2026-10-31": 1 };
  const clicks = days[day];
  if (clicks === undefined) return [];
  if (dimension === "date") return [r([day], clicks, clicks * 30, 6.5)];
  if (dimension === "query") return [r([day, "paw print necklace"], clicks - 1, 120, 3.25), r([day, "nose print ring"], 0, 400, 9.5), r([day, "pet keepsake jewellery nz"], 1, 60, 1.8)];
  if (dimension === "page") return [r([day, "https://www.pawprints.example/products/paw-print-necklace"], clicks, clicks * 20, 4.1)];
  if (dimension === "country") return [r([day, "nzl"], clicks - 1, clicks * 25, 5.5), r([day, "aus"], 1, clicks * 5, 12)];
  if (dimension === "device") return [r([day, "MOBILE"], clicks - 1, clicks * 22, 6), r([day, "DESKTOP"], 1, clicks * 8, 7.75)];
  return [];
}

/** Examples GSC1-GSC9 in docs/ACCOUNTING-EXAMPLES.md (Google Search Console, as Looker Studio's connector does, not yet reviewed). Google is a fake throughout. */
describeWithDatabase("analytics: Google Search Console website search data", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let reportViewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let reportViewerCookie: string;
  let root: string;
  let organisation: OrganisationRecord;
  let calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  let tokenReply: () => Response;
  let late = false;
  /** A failure to answer for the query of this day (every attempt), or for the next request. */
  let failDay: { day: string; reply: () => Response } | null = null;
  let failures: Response[] = [];
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const actor = () => ({ userId: owner.id, email: owner.email });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const goodTokens = () => reply({ access_token: "gsc-access", refresh_token: "gsc-refresh", expires_in: 3600, scope: SCOPE });
  const queriesFor = () => calls.filter((call) => call.url.includes("/searchAnalytics/query"));

  const fake = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url: input, body });
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") return tokenReply();
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") return new Response("", { status: 200 });
    if (url.pathname === "/oauth2/v2/userinfo") return reply({ email: "Jess@PawPrints.example", verified_email: true });
    if (input === `${API}/sites`) {
      return reply({
        siteEntry: [
          { siteUrl: "https://www.pawprints.example/", permissionLevel: "siteFullUser" },
          { siteUrl: SITE, permissionLevel: "siteOwner" },
          { siteUrl: "https://old.pawprints.example/", permissionLevel: "siteUnverifiedUser" },
        ],
      });
    }
    if (url.host === "searchconsole.googleapis.com" && url.pathname.endsWith("/searchAnalytics/query")) {
      const failure = failures.shift();
      if (failure) return failure;
      const dimensions = body!.dimensions as string[];
      const start = body!.startDate as string;
      const end = body!.endDate as string;
      if (failDay && start === failDay.day && dimensions[1] === "query") return failDay.reply();
      const rows: Row[] = [];
      for (let day = start; day <= end; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
        rows.push(...fixture(day, dimensions[1] ?? "date", late));
      }
      const incomplete = end >= "2026-10-30" ? { metadata: { firstIncompleteDate: "2026-10-30" } } : {};
      return reply({ rows: rows.slice(Number(body!.startRow ?? 0), Number(body!.startRow ?? 0) + Number(body!.rowLimit)), responseAggregationType: dimensions.includes("page") ? "byPage" : "byProperty", ...incomplete });
    }
    return new Response("not found", { status: 404 });
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "search-console-test-secret-key-0123456789abcdef";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-gsc-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("gsc-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("gsc-viewer@example.com");
    reportViewer = await createTestUser("gsc-client@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'report_viewer')", [ORG, viewer.id, reportViewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    reportViewerCookie = await sessionCookieFor(reportViewer);
    await as(owner, (tx) => updateOrganisationSettings(tx, { analyticsEnabled: true }));
    await as(owner, (tx) => saveMailSettings(tx, { googleClientId: "g-client.apps.googleusercontent.com", googleClientSecret: "g-secret" }));
    organisation = (await getOrganisation(ORG))!;
    tokenReply = goodTokens;
    setMailFetchForTests(fake);
    setGscRetryDelaysForTests([0, 0, 0]);
  });

  afterAll(async () => {
    setMailFetchForTests(null);
    setGscRetryDelaysForTests(null);
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  const scalar = async (sql: string) => Object.values((await queryAnalytics(ORG, sql))[0])[0];

  it("GSC1 an admin signs in asking only to read Search Console, through Google Analytics' return address; stored encrypted and apart from Google Analytics", async () => {
    const refused = await gscRoute.POST(apiRequest("/api/analytics/google/search-console", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }), noContext);
    expect(refused.status).toBe(403);
    const started = await gscRoute.POST(apiRequest("/api/analytics/google/search-console", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext);
    const { url } = (await started.json()) as { url: string };
    const query = new URL(url).searchParams;
    expect([query.get("scope"), query.get("redirect_uri"), query.get("access_type"), query.get("include_granted_scopes")]).toEqual([
      SCOPE,
      "http://tohyee.test/api/analytics/google/callback",
      "offline",
      null,
    ]);
    // A Search Console state can't finish a Google Analytics sign-in.
    const other = await as(owner, async (tx) => new URL((await startGscConnect(tx, "https://tohyee.test")).url).searchParams.get("state")!);
    await expect(as(owner, (tx) => claimGaState(tx, other))).rejects.toThrow("for another connection");

    const back = await gaCallback.GET(apiRequest(`/api/analytics/google/callback?state=${encodeURIComponent(query.get("state")!)}&code=code-1`, { cookie: ownerCookie }));
    expect(back.headers.get("location")).toBe("http://tohyee.test/analytics/sources?googleSearchConsole=connected");
    const again = await gaCallback.GET(apiRequest(`/api/analytics/google/callback?state=${encodeURIComponent(query.get("state")!)}&code=code-1`, { cookie: ownerCookie }));
    const location = new URL(again.headers.get("location")!);
    expect([location.searchParams.get("googleSearchConsole"), location.searchParams.get("message")]).toEqual(["error", expect.stringContaining("expired or was already used")]);

    const stored = await as(owner, (tx) => tx.query<{ refresh_token_ciphertext: string; google_email: string; search_type: string }>("select * from analytics_search_console_connections"));
    expect(stored.rows[0]).toMatchObject({ google_email: "jess@pawprints.example", search_type: "web" });
    expect(stored.rows[0].refresh_token_ciphertext).not.toContain("gsc-refresh");
    expect((await as(owner, (tx) => getGaStatus(tx, true))).connection).toBeNull();
    expect((await as(viewer, (tx) => getGscStatus(tx, false))).connection).toMatchObject({ googleEmail: null, siteUrl: null, reloadDaily: true });

    // Unticking the Search Console permission at Google is refused.
    tokenReply = () => reply({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid https://www.googleapis.com/auth/userinfo.email" });
    const { app } = await as(owner, async (tx) => claimGoogleState(tx, new URL((await startGscConnect(tx, "https://tohyee.test")).url).searchParams.get("state")!));
    await expect(fetchGscSignIn(app, "code-2", "https://tohyee.test")).rejects.toThrow("didn't allow reading Search Console");
    tokenReply = goodTokens;
  });

  it("GSC2 lists only verified properties, domains first, and only those can be chosen", async () => {
    const response = await gscSitesRoute.GET(apiRequest(`/api/analytics/google/search-console/sites?organisationId=${ORG}`, { cookie: ownerCookie }), noContext);
    expect(((await response.json()) as { sites: unknown }).sites).toEqual([
      { siteUrl: SITE, label: "pawprints.example (whole domain)", permissionLevel: "siteOwner" },
      { siteUrl: "https://www.pawprints.example/", label: "https://www.pawprints.example/", permissionLevel: "siteFullUser" },
    ]);
    for (const cookie of [viewerCookie, reportViewerCookie]) {
      expect((await gscSitesRoute.GET(apiRequest(`/api/analytics/google/search-console/sites?organisationId=${ORG}`, { cookie }), noContext)).status).toBe(403);
    }
    const available = await listGscSites(organisation, actor());
    await expect(as(owner, (tx) => saveGscSettings(tx, { siteUrl: "https://old.pawprints.example/" }, available))).rejects.toThrow("isn't a verified one");
    await expect(as(owner, (tx) => saveGscSettings(tx, { siteUrl: SITE, searchType: "discover" }, available))).rejects.toThrow("web, images, videos or news");
    const saved = await as(owner, (tx) => saveGscSettings(tx, { siteUrl: SITE }, available));
    expect(saved).toMatchObject({ startAgain: false, connection: { siteUrl: SITE, siteLabel: "pawprints.example (whole domain)", permissionLevel: "siteOwner", searchType: "web" } });
  });

  it("GSC3 the first load goes back 16 months a day at a time, and GSC5 loads plain tables with the newest days marked", async () => {
    calls = [];
    const run = await refreshGsc(organisation, actor(), "manual", NOW);
    expect(run).toMatchObject({ status: "ok", error: null, sourceName: "Google Search Console", fileName: "pawprints.example (whole domain) (web search)" });
    const asked = queriesFor();
    // The domain property's address is encoded in the path.
    expect(asked.every((call) => call.url === `${API}/sites/sc-domain%3Apawprints.example/searchAnalytics/query`)).toBe(true);
    expect(asked[0].body).toEqual({ startDate: "2025-06-30", endDate: "2026-10-31", dimensions: ["date"], type: "web", dataState: "all", aggregationType: "auto", rowLimit: 25000, startRow: 0 });
    // 489 days, each asked for queries, pages, countries and devices on its own.
    const perDay = asked.slice(1);
    expect(perDay).toHaveLength(489 * 4);
    expect(perDay.every((call) => call.body!.startDate === call.body!.endDate)).toBe(true);
    expect(new Set(perDay.map((call) => call.body!.startDate)).size).toBe(489);

    expect(await queryAnalytics(ORG, "select date::varchar as date, clicks::varchar as clicks, impressions::varchar as impressions, click_rate::varchar as rate, average_position::varchar as position, may_still_change from google_search_console_daily order by date")).toEqual([
      { date: "2026-10-26", clicks: "10", impressions: "300", rate: "0.033333", position: "6.50", may_still_change: false },
      { date: "2026-10-27", clicks: "12", impressions: "360", rate: "0.033333", position: "6.50", may_still_change: false },
      { date: "2026-10-28", clicks: "8", impressions: "240", rate: "0.033333", position: "6.50", may_still_change: true },
      { date: "2026-10-29", clicks: "9", impressions: "270", rate: "0.033333", position: "6.50", may_still_change: true },
      { date: "2026-10-30", clicks: "4", impressions: "120", rate: "0.033333", position: "6.50", may_still_change: true },
      { date: "2026-10-31", clicks: "1", impressions: "30", rate: "0.033333", position: "6.50", may_still_change: true },
    ]);
    expect(await scalar("select count(*)::int from google_search_console_queries")).toBe(18);
    expect(await queryAnalytics(ORG, "select query, clicks::int as clicks, average_position::varchar as position from google_search_console_queries where date = '2026-10-26' order by query")).toEqual([
      { query: "nose print ring", clicks: 0, position: "9.50" },
      { query: "paw print necklace", clicks: 9, position: "3.25" },
      { query: "pet keepsake jewellery nz", clicks: 1, position: "1.80" },
    ]);
    expect(await scalar("select string_agg(distinct country || ':' || country_code, ',' order by country || ':' || country_code) from google_search_console_countries")).toBe("Australia:aus,New Zealand:nzl");
    expect(await scalar("select string_agg(distinct device, ',' order by device) from google_search_console_devices")).toBe("Computer,Mobile");
    expect(await scalar("select page from google_search_console_pages limit 1")).toBe("https://www.pawprints.example/products/paw-print-necklace");
    const status = await as(owner, (tx) => getGscStatus(tx, true));
    expect(status.connection).toMatchObject({ loadedFrom: "2025-06-30", loadedThrough: "2026-10-31", changingFrom: "2026-10-28" });
    // A CSV source can't take the prefix.
    const csv = await sourcesRoute.POST(
      apiRequest("/api/analytics/sources", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "x", tableName: "google_search_console_extra", fileName: "x.csv", columns: [{ source: "a", name: "a", kind: "text" }] } }),
      noContext,
    );
    expect(((await csv.json()) as { error: string }).error).toContain("kept for Google Search Console");
  });

  it("GSC4 the next day fetches only the changing and new days; finished days are kept and changed ones replaced", async () => {
    calls = [];
    late = true;
    const run = await refreshGsc(organisation, actor(), "manual", NEXT_DAY);
    expect(run.status).toBe("ok");
    const asked = queriesFor();
    expect(asked[0].body).toMatchObject({ startDate: "2026-10-28", endDate: "2026-11-01" });
    expect(asked.slice(1)).toHaveLength(5 * 4);
    expect(await queryAnalytics(ORG, "select date::varchar as date, clicks::int as clicks, may_still_change from google_search_console_daily order by date")).toEqual([
      { date: "2026-10-26", clicks: 10, may_still_change: false },
      { date: "2026-10-27", clicks: 12, may_still_change: false },
      { date: "2026-10-28", clicks: 8, may_still_change: false },
      { date: "2026-10-29", clicks: 15, may_still_change: true },
      { date: "2026-10-30", clicks: 4, may_still_change: true },
      { date: "2026-10-31", clicks: 1, may_still_change: true },
    ]);
    // No day twice.
    expect(await scalar("select count(*)::int from (select date, query from google_search_console_queries group by all having count(*) > 1)")).toBe(0);
    expect(await scalar("select sum(clicks)::int from google_search_console_queries where date = '2026-10-29'")).toBe(15);
    expect((await as(owner, (tx) => getGscStatus(tx, true))).connection).toMatchObject({ loadedThrough: "2026-11-01", changingFrom: "2026-10-29" });
    late = false;
  });

  it("GSC6 Google's limits are retried with waits; one that lasts keeps the whole days before it, and the next load carries on", async () => {
    // Two quota answers are waited out and retried; the load goes ahead.
    failures = [reply({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }, 429), reply({ error: { code: 503, message: "busy" } }, 503)];
    expect((await refreshGsc(organisation, actor(), "manual", NEXT_DAY)).status).toBe("ok");

    // Start again on the URL-prefix property: its first load stops at 30 Jun 2026, every try refused.
    const available = await listGscSites(organisation, actor());
    const changed = await as(owner, (tx) => saveGscSettings(tx, { siteUrl: "https://www.pawprints.example/" }, available));
    expect(changed.startAgain).toBe(true);
    calls = [];
    failDay = { day: "2026-06-30", reply: () => reply({ error: { code: 403, message: "Search Analytics load quota exceeded.", errors: [{ reason: "quotaExceeded" }] } }, 403) };
    const stopped = await refreshGsc(organisation, actor(), "manual", NOW);
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toContain("limit for this site is used up");
    expect(stopped.error).toContain("Days up to 29 Jun 2026 are loaded; the next load carries on from 30 Jun 2026.");
    // Four tries at that day (the first and three waits), and no days after it were started beyond those already asked.
    expect(queriesFor().filter((call) => call.body!.startDate === "2026-06-30" && (call.body!.dimensions as string[])[1] === "query")).toHaveLength(4);
    expect((await as(owner, (tx) => getGscStatus(tx, true))).connection).toMatchObject({ siteUrl: "https://www.pawprints.example/", loadedFrom: "2025-06-30", loadedThrough: "2026-06-29", changingFrom: null });
    // The October days weren't kept: they come after the stop.
    expect(await scalar("select count(*)::int from google_search_console_daily")).toBe(0);

    failDay = null;
    calls = [];
    expect((await refreshGsc(organisation, actor(), "manual", NOW)).status).toBe("ok");
    expect(queriesFor()[0].body).toMatchObject({ startDate: "2026-06-30", endDate: "2026-10-31" });
    expect(await scalar("select count(*)::int from google_search_console_daily")).toBe(6);

    // An account that can't read the property, and the API turned off: plain messages, nothing changed.
    failures = [reply({ error: { code: 403, message: "User does not have sufficient permission for site 'https://www.pawprints.example/'.", errors: [{ reason: "forbidden" }] } }, 403)];
    expect((await refreshGsc(organisation, actor(), "manual", NOW)).error).toContain("can't read that Search Console property");
    failures = [reply({ error: { code: 403, message: "Google Search Console API has not been used in project 123 before or it is disabled.", errors: [{ reason: "accessNotConfigured" }] } }, 403)];
    expect((await refreshGsc(organisation, actor(), "manual", NOW)).error).toContain("Search Console API isn't turned on");
    expect(await scalar("select count(*)::int from google_search_console_daily")).toBe(6);
  });

  it("GSC7 Google refusing the sign-in stops loading until an admin connects again", async () => {
    await as(owner, (tx) => tx.query("update analytics_search_console_connections set access_token_expires_at = now() - interval '1 minute'"));
    tokenReply = () => reply({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    const run = await refreshGsc(organisation, actor(), "manual", NOW);
    expect(run.error).toContain("Google ends sign-ins after 7 days");
    expect(await as(owner, (tx) => gscLoadsNightly(tx))).toBe(false);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setUTCHours(18, 0, 0, 0);
    expect((await runDueLoads(tomorrow)).map((made) => made.sourceName)).not.toContain("Google Search Console");

    tokenReply = goodTokens;
    const { app } = await as(owner, async (tx) => claimGoogleState(tx, new URL((await startGscConnect(tx, "https://tohyee.test")).url).searchParams.get("state")!));
    const signIn = await fetchGscSignIn(app, "code-3", "https://tohyee.test");
    await as(owner, (tx) => saveGscSignIn(tx, signIn));
    // Connecting again keeps the property and what's loaded.
    expect((await as(owner, (tx) => getGscStatus(tx, true))).connection).toMatchObject({ needsReconnect: false, siteUrl: "https://www.pawprints.example/", loadedThrough: "2026-10-31" });
    const nightly = await runDueLoads(new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000));
    expect(nightly.find((made) => made.sourceName === "Google Search Console")).toMatchObject({ status: "ok", trigger: "schedule" });
  });

  it("GSC9 the Website search report reads the tables, for people who can see Analytics, with the changing days in its freshness", async () => {
    const tables = await listTables(ORG);
    const built = buildTemplate("search", [...tables].map(([name, columns]) => ({ name, columns })), "2026-10-31")!;
    expect(built).not.toBeNull();
    const made = await dashboardsRoute.POST(
      apiRequest("/api/analytics/dashboards", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: built.name, description: built.description, settings: { ...built.settings, preset: null, from: "2026-10-01", to: "2026-10-31" }, tiles: built.tiles } }),
      noContext,
    );
    expect(made.status).toBe(201);
    const dashboardId = ((await made.json()) as { dashboard: { id: string } }).dashboard.id;
    const ask = async (title: string, cookie = viewerCookie) => {
      const tile = built.tiles.find((entry) => entry.title === title)!;
      const response = await queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie, body: { organisationId: ORG, dashboardId, tileId: tile.id, filters: {} } }), noContext);
      return { status: response.status, data: (await response.json()) as { rows: Array<Record<string, unknown>> } };
    };
    // Average position over the month is weighted by impressions: (6.5 x 1,320) / 1,320 for the daily totals.
    const position = await ask("Average position");
    expect(position.status).toBe(200);
    expect(Number(position.data.rows[0].m0)).toBeCloseTo(6.5, 6);
    const rate = await ask("Click rate");
    expect(Number(rate.data.rows[0].m0)).toBeCloseTo(44 / 1320, 6);
    const low = await ask("Shown a lot, rarely clicked");
    expect(low.data.rows.map((row) => row.category)).toEqual(["nose print ring", "paw print necklace", "pet keepsake jewellery nz"]);
    expect(Number(low.data.rows[0].m2)).toBe(0);
    // A report viewer it isn't shared with gets nothing.
    expect((await ask("Clicks", reportViewerCookie)).status).toBe(404);
    const freshness = await freshnessRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}/freshness?organisationId=${ORG}`, { cookie: viewerCookie }), params({ dashboardId }));
    const sources = ((await freshness.json()) as { sources: Array<Record<string, unknown>> }).sources;
    expect(sources).toEqual([expect.objectContaining({ name: "Google Search Console", dataThrough: "2026-10-31", mayChangeFrom: expect.stringMatching(/^2026-1[01]-\d\d$/) })]);
    // The connection's status: viewers yes (no Google address), report viewers no.
    expect((await gscRoute.GET(apiRequest(`/api/analytics/google/search-console?organisationId=${ORG}`, { cookie: viewerCookie }), noContext)).status).toBe(200);
    expect((await gscRoute.GET(apiRequest(`/api/analytics/google/search-console?organisationId=${ORG}`, { cookie: reportViewerCookie }), noContext)).status).toBe(403);
    expect((await gscLoadRoute.POST(apiRequest("/api/analytics/google/search-console/load", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }), noContext)).status).toBe(403);
  });

  it("GSC8 disconnecting deletes the sign-in and the tables, withdraws it at Google unless Google Analytics uses the same account, and keeps the load history", async () => {
    const refused = await gscRoute.DELETE(apiRequest(`/api/analytics/google/search-console?organisationId=${ORG}`, { method: "DELETE", cookie: viewerCookie }), noContext);
    expect(refused.status).toBe(403);
    // Google Analytics connected with the same Google account: Search Console's sign-in isn't withdrawn at Google.
    await as(owner, (tx) =>
      tx.query("insert into analytics_google_connections (id, google_email, refresh_token_ciphertext, connected_by_email) values (true, 'jess@pawprints.example', 'x', 'gsc-owner@example.com')"),
    );
    calls = [];
    await disconnectGsc(organisation, actor());
    expect(calls.filter((call) => call.url === "https://oauth2.googleapis.com/revoke")).toHaveLength(0);
    expect((await as(owner, (tx) => tx.query("select 1 from analytics_search_console_connections"))).rows).toEqual([]);
    expect(await scalar("select count(*)::int from information_schema.tables where table_name like 'google_search_console%'")).toBe(0);
    expect((await as(owner, (tx) => recentLoads(tx))).filter((run) => run.sourceName === "Google Search Console").length).toBeGreaterThan(3);
    await expect(refreshGsc(organisation, actor(), "manual", NOW)).rejects.toThrow("isn't connected");

    // Without Google Analytics on that account, it is withdrawn.
    await as(owner, (tx) => tx.query("delete from analytics_google_connections"));
    const { app } = await as(owner, async (tx) => claimGoogleState(tx, new URL((await startGscConnect(tx, "https://tohyee.test")).url).searchParams.get("state")!));
    const fresh = await fetchGscSignIn(app, "code-4", "https://tohyee.test");
    await as(owner, (tx) => saveGscSignIn(tx, fresh));
    calls = [];
    await disconnectGsc(organisation, actor());
    expect(calls.filter((call) => call.url === "https://oauth2.googleapis.com/revoke")).toHaveLength(1);
  });
});
