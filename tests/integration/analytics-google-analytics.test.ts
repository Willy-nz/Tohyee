import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as gaRoute from "@/app/api/analytics/google/route";
import * as gaCallback from "@/app/api/analytics/google/callback/route";
import * as gaLoadRoute from "@/app/api/analytics/google/load/route";
import * as gaPropertiesRoute from "@/app/api/analytics/google/properties/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import { closeAnalytics, queryAnalytics } from "@/lib/analytics/engine";
import { claimGaState, disconnectGa, fetchGaSignIn, gaLoadsNightly, getGaStatus, listGaProperties, refreshGa, saveGaSettings, saveGaSignIn, setGaRetryDelaysForTests, startGaConnect } from "@/lib/analytics/google-analytics";
import { runDueLoads } from "@/lib/analytics/scheduler";
import { recentLoads } from "@/lib/analytics/sources";
import type { SessionUser } from "@/lib/auth/sessions";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "ga-website";
const noContext = undefined as unknown;
const SCOPE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/analytics.readonly";

type FixtureRow = { d: string[]; m: Record<string, string> };
/** Made-up GA4 answers for 1-3 October 2026, by the dimensions asked for. */
const FIXTURE: Record<string, FixtureRow[]> = {
  date: [
    { d: ["20261001"], m: { activeUsers: "48", newUsers: "31", sessions: "60", engagedSessions: "40", screenPageViews: "212", engagementRate: "0.6666666666666666", keyEvents: "2", totalRevenue: "129.95" } },
    { d: ["20261002"], m: { activeUsers: "30", newUsers: "20", sessions: "35", engagedSessions: "21", screenPageViews: "120", engagementRate: "0.6", keyEvents: "1", totalRevenue: "64.5" } },
    { d: ["20261003"], m: { activeUsers: "25", newUsers: "15", sessions: "28", engagedSessions: "14", screenPageViews: "90", engagementRate: "0.5", keyEvents: "0", totalRevenue: "0" } },
  ],
  "date,sessionDefaultChannelGroup,sessionSource,sessionMedium": [
    { d: ["20261001", "Organic Social", "instagram.com", "referral"], m: { sessions: "40", activeUsers: "33", engagedSessions: "28", keyEvents: "2", totalRevenue: "129.95" } },
    { d: ["20261001", "Organic Search", "google", "organic"], m: { sessions: "20", activeUsers: "15", engagedSessions: "12", keyEvents: "0", totalRevenue: "0" } },
    { d: ["20261002", "Direct", "(direct)", "(none)"], m: { sessions: "35", activeUsers: "30", engagedSessions: "21", keyEvents: "1", totalRevenue: "64.5" } },
  ],
  "date,pagePath,pageTitle": [
    { d: ["20261001", "/", "Home"], m: { screenPageViews: "150", activeUsers: "45" } },
    { d: ["20261001", "/products/paw-print-pendant", "Paw print pendant"], m: { screenPageViews: "62", activeUsers: "20" } },
  ],
  "date,country": [{ d: ["20261001", "New Zealand"], m: { activeUsers: "40", newUsers: "25", sessions: "50" } }],
  "date,deviceCategory": [{ d: ["20261001", "mobile"], m: { activeUsers: "36", sessions: "44", screenPageViews: "160" } }],
};
/** Rows the fake sends a page, fewer than Tohyee asks for, so paging is exercised. */
const PAGE = 2;

/** Examples GA1-GA8 in docs/ACCOUNTING-EXAMPLES.md (Google Analytics website data, not yet reviewed). Google is a fake throughout. */
describeWithDatabase("analytics: Google Analytics website data", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let root: string;
  let organisation: OrganisationRecord;
  let calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  let tokenReply: () => Response;
  let reportFailures: Response[] = [];
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const actor = () => ({ userId: owner.id, email: owner.email });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const goodTokens = () => reply({ access_token: "ga-access", refresh_token: "ga-refresh", expires_in: 3600, scope: SCOPE });

  const fake = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url: input, body });
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") return tokenReply();
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") return new Response("", { status: 200 });
    if (url.pathname === "/oauth2/v2/userinfo") return reply({ email: "Jess@PawPrints.example", verified_email: true });
    if (url.host === "analyticsadmin.googleapis.com") {
      if (url.searchParams.get("pageToken") === "page-2") {
        return reply({ accountSummaries: [{ name: "accountSummaries/2", account: "accounts/2", displayName: "Old shop", propertySummaries: [{ property: "properties/111", displayName: "Old site", propertyType: "PROPERTY_TYPE_ORDINARY" }] }] });
      }
      return reply({
        accountSummaries: [{ name: "accountSummaries/1", account: "accounts/1", displayName: "Paw Prints Ltd", propertySummaries: [{ property: "properties/321654987", displayName: "Paw Prints website", propertyType: "PROPERTY_TYPE_ORDINARY" }] }],
        nextPageToken: "page-2",
      });
    }
    if (url.host === "analyticsdata.googleapis.com") {
      const failure = reportFailures.shift();
      if (failure) return failure;
      const dimensions = (body!.dimensions as Array<{ name: string }>).map((entry) => entry.name);
      const metrics = (body!.metrics as Array<{ name: string }>).map((entry) => entry.name);
      const rows = FIXTURE[dimensions.join(",")] ?? [];
      const offset = Number(body!.offset ?? 0);
      return reply({
        dimensionHeaders: dimensions.map((name) => ({ name })),
        metricHeaders: metrics.map((name) => ({ name, type: "TYPE_INTEGER" })),
        rows: rows.slice(offset, offset + PAGE).map((row) => ({ dimensionValues: row.d.map((value) => ({ value })), metricValues: metrics.map((name) => ({ value: row.m[name] ?? "0" })) })),
        rowCount: rows.length,
        metadata: { currencyCode: "NZD", timeZone: "Pacific/Auckland" },
        kind: "analyticsData#runReport",
      });
    }
    return new Response("not found", { status: 404 });
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "google-analytics-test-secret-key-0123456789abcdef";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-ga-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("ga-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("ga-viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    await as(owner, (tx) => updateOrganisationSettings(tx, { analyticsEnabled: true }));
    await as(owner, (tx) => saveMailSettings(tx, { googleClientId: "g-client.apps.googleusercontent.com", googleClientSecret: "g-secret" }));
    organisation = (await getOrganisation(ORG))!;
    tokenReply = goodTokens;
    setMailFetchForTests(fake);
    setGaRetryDelaysForTests([0, 0]);
  });

  afterAll(async () => {
    setMailFetchForTests(null);
    setGaRetryDelaysForTests(null);
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  /** Signs in as the owner, as Google's callback does, and chooses the Paw Prints property. */
  async function connect(propertyId = "321654987") {
    const { url } = await as(owner, (tx) => startGaConnect(tx, "https://tohyee.test"));
    const state = new URL(url).searchParams.get("state")!;
    const app = await as(owner, (tx) => claimGaState(tx, state));
    const signIn = await fetchGaSignIn(app, "code-1", "https://tohyee.test");
    await as(owner, (tx) => saveGaSignIn(tx, signIn));
    const available = await listGaProperties(organisation, actor());
    return as(owner, (tx) => saveGaSettings(tx, { propertyId }, available));
  }

  const scalar = async (sql: string) => Object.values((await queryAnalytics(ORG, sql))[0])[0];

  it("GA1 an admin signs in with Google asking only to read Analytics; the sign-in is theirs, used once, and stored encrypted", async () => {
    // Viewers can't start connecting.
    const refused = await gaRoute.POST(apiRequest("/api/analytics/google", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }), noContext);
    expect(refused.status).toBe(403);
    const started = await gaRoute.POST(apiRequest("/api/analytics/google", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext);
    const { url } = (await started.json()) as { url: string };
    const query = new URL(url).searchParams;
    expect([query.get("scope"), query.get("redirect_uri"), query.get("access_type"), query.get("include_granted_scopes"), query.get("client_id")]).toEqual([
      SCOPE,
      "http://tohyee.test/api/analytics/google/callback",
      "offline",
      null,
      "g-client.apps.googleusercontent.com",
    ]);
    // Someone else can't use the state, and it works once.
    await expect(as(viewer, (tx) => claimGaState(tx, query.get("state")!))).rejects.toThrow("expired or was already used");
    const back = await gaCallback.GET(apiRequest(`/api/analytics/google/callback?state=${encodeURIComponent(query.get("state")!)}&code=code-1`, { cookie: ownerCookie }));
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("http://tohyee.test/analytics/sources?googleAnalytics=connected");
    const again = await gaCallback.GET(apiRequest(`/api/analytics/google/callback?state=${encodeURIComponent(query.get("state")!)}&code=code-1`, { cookie: ownerCookie }));
    expect(new URL(again.headers.get("location")!).searchParams.get("message")).toContain("expired or was already used");

    const stored = await as(owner, (tx) => tx.query<{ refresh_token_ciphertext: string; access_token_ciphertext: string; google_email: string }>("select * from analytics_google_connections"));
    expect(stored.rows[0].google_email).toBe("jess@pawprints.example");
    expect(stored.rows[0].refresh_token_ciphertext).not.toContain("ga-refresh");
    expect(stored.rows[0].access_token_ciphertext).not.toContain("ga-access");
    // The viewer sees that it's connected, not the Google account.
    const forViewer = await as(viewer, (tx) => getGaStatus(tx, false));
    expect(forViewer.connection).toMatchObject({ googleEmail: null, propertyId: null, historyMonths: 13, reloadDaily: true, needsReconnect: false });

    // Unticking the Analytics permission at Google is refused.
    tokenReply = () => reply({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid https://www.googleapis.com/auth/userinfo.email" });
    const app = await as(owner, async (tx) => claimGaState(tx, new URL((await startGaConnect(tx, "https://tohyee.test")).url).searchParams.get("state")!));
    await expect(fetchGaSignIn(app, "code-2", "https://tohyee.test")).rejects.toThrow("didn't allow reading Google Analytics");
    tokenReply = goodTokens;
  });

  it("GA2 lists the GA4 properties the account can see, every page, and only those can be chosen", async () => {
    const response = await gaPropertiesRoute.GET(apiRequest(`/api/analytics/google/properties?organisationId=${ORG}`, { cookie: ownerCookie }), noContext);
    expect(((await response.json()) as { properties: unknown }).properties).toEqual([
      { id: "111", name: "Old site", account: "Old shop" },
      { id: "321654987", name: "Paw Prints website", account: "Paw Prints Ltd" },
    ]);
    const viewerList = await gaPropertiesRoute.GET(apiRequest(`/api/analytics/google/properties?organisationId=${ORG}`, { cookie: viewerCookie }), noContext);
    expect(viewerList.status).toBe(403);
    const available = await listGaProperties(organisation, actor());
    await expect(as(owner, (tx) => saveGaSettings(tx, { propertyId: "999" }, available))).rejects.toThrow("isn't one this Google account can see");
    await expect(as(owner, (tx) => saveGaSettings(tx, { propertyId: "321654987", historyMonths: 61 }, available))).rejects.toThrow("between 1 and 60");
    const saved = await as(owner, (tx) => saveGaSettings(tx, { propertyId: "321654987" }, available));
    expect(saved).toMatchObject({ propertyChanged: false, connection: { propertyId: "321654987", propertyName: "Paw Prints website", accountName: "Paw Prints Ltd" } });
  });

  it("GA3-GA5 Refresh now loads each daily report, every page, into google_analytics_* tables with exact decimals", async () => {
    calls = [];
    const response = await gaLoadRoute.POST(apiRequest("/api/analytics/google/load", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext);
    const { run } = (await response.json()) as { run: { status: string; rowsLoaded: string; error: string | null; sourceName: string; fileName: string } };
    expect(run).toMatchObject({ status: "ok", error: null, rowsLoaded: "10", sourceName: "Google Analytics", fileName: "Paw Prints website (GA4 property 321654987)" });
    // GA5: 13 months back from today, to today.
    const reports = calls.filter((call) => call.url.startsWith("https://analyticsdata.googleapis.com/v1beta/properties/321654987:runReport"));
    const today = new Date();
    expect(reports[0].body!.dateRanges).toEqual([{ startDate: expect.stringMatching(/^\d{4}-\d{2}-01$/), endDate: "today" }]);
    expect(Number((reports[0].body!.dateRanges as Array<{ startDate: string }>)[0].startDate.slice(0, 4))).toBeLessThan(today.getUTCFullYear() + 1);
    // Paging: the daily report's three rows came two at a time.
    expect(reports.filter((call) => (call.body!.dimensions as unknown[]).length === 1).map((call) => call.body!.offset)).toEqual(["0", "2"]);
    expect(reports.every((call) => call.body!.limit === "50000")).toBe(true);

    expect(await queryAnalytics(ORG, "select date::varchar as date, active_users::varchar as users, sessions::varchar as sessions, page_views::varchar as views, engagement_rate::varchar as rate, key_events::varchar as key_events, revenue::varchar as revenue from google_analytics_daily order by date")).toEqual([
      { date: "2026-10-01", users: "48", sessions: "60", views: "212", rate: "0.666667", key_events: "2.00", revenue: "129.95" },
      { date: "2026-10-02", users: "30", sessions: "35", views: "120", rate: "0.600000", key_events: "1.00", revenue: "64.50" },
      { date: "2026-10-03", users: "25", sessions: "28", views: "90", rate: "0.500000", key_events: "0.00", revenue: "0.00" },
    ]);
    expect(await scalar("select sum(revenue)::varchar from google_analytics_daily")).toBe("194.45");
    expect(await queryAnalytics(ORG, "select channel, source, medium, sessions::varchar as sessions from google_analytics_traffic order by date, sessions desc")).toEqual([
      { channel: "Organic Social", source: "instagram.com", medium: "referral", sessions: "40" },
      { channel: "Organic Search", source: "google", medium: "organic", sessions: "20" },
      { channel: "Direct", source: "(direct)", medium: "(none)", sessions: "35" },
    ]);
    expect(await scalar("select string_agg(page_path, ' ' order by page_views desc) from google_analytics_pages")).toBe("/ /products/paw-print-pendant");
    expect(await scalar("select country from google_analytics_countries")).toBe("New Zealand");
    expect(await scalar("select device from google_analytics_devices")).toBe("mobile");
    // Revenue's currency and the property's time zone, as Google said.
    const status = await as(owner, (tx) => getGaStatus(tx, true));
    expect(status.connection).toMatchObject({ currencyCode: "NZD", timeZone: "Pacific/Auckland", googleEmail: "jess@pawprints.example" });
    expect(status.lastLoad).toMatchObject({ status: "ok", trigger: "manual", requestedByEmail: owner.email });
    // A CSV source can't take the prefix.
    const csv = await sourcesRoute.POST(
      apiRequest("/api/analytics/sources", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "x", tableName: "google_analytics_extra", fileName: "x.csv", columns: [{ source: "a", name: "a", kind: "text" }] } }),
      noContext,
    );
    expect(((await csv.json()) as { error: string }).error).toContain("kept for Google Analytics");
  });

  it("GA6 Google's quota, a disabled API and a passing outage: clear messages, retries only where they help, and the last copy kept", async () => {
    reportFailures = [reply({ error: { code: 429, message: "Exhausted property tokens per hour.", status: "RESOURCE_EXHAUSTED" } }, 429)];
    const quota = await refreshGa(organisation, actor(), "manual");
    expect(quota.status).toBe("failed");
    expect(quota.error).toContain("limit for this property is used up");
    expect(await scalar("select count(*)::int from google_analytics_daily")).toBe(3);

    reportFailures = [
      reply({ error: { code: 403, message: "Google Analytics Data API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }] } }, 403),
    ];
    const disabled = await refreshGa(organisation, actor(), "manual");
    expect(disabled.error).toContain("The Google Analytics Data API isn't turned on");

    reportFailures = [reply({ error: { code: 403, message: "User does not have sufficient permissions for this property.", status: "PERMISSION_DENIED" } }, 403)];
    expect((await refreshGa(organisation, actor(), "manual")).error).toContain("can't read that Google Analytics property");

    // Two 503s are retried; the third try works.
    reportFailures = [reply({ error: { code: 503, status: "UNAVAILABLE", message: "busy" } }, 503), reply({ error: { code: 503, status: "UNAVAILABLE", message: "busy" } }, 503)];
    expect((await refreshGa(organisation, actor(), "manual")).status).toBe("ok");
    // A 429 isn't retried straight away (Google's quotas are by the hour and day): one request, and the load stops.
    calls = [];
    reportFailures = [reply({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "x" } }, 429)];
    await refreshGa(organisation, actor(), "manual");
    expect(calls.filter((call) => call.url.includes(":runReport"))).toHaveLength(1);
  });

  it("GA7 Google refusing the sign-in (7 days in Testing) stops loading until an admin connects again", async () => {
    await as(owner, (tx) => tx.query("update analytics_google_connections set access_token_expires_at = now() - interval '1 minute'"));
    tokenReply = () => reply({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    const run = await refreshGa(organisation, actor(), "manual");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Google ends sign-ins after 7 days");
    expect(await as(owner, (tx) => gaLoadsNightly(tx))).toBe(false);
    expect((await as(owner, (tx) => getGaStatus(tx, true))).connection!.needsReconnect).toBe(true);
    // The nightly load leaves it alone; the books still copy.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setUTCHours(18, 0, 0, 0);
    expect((await runDueLoads(tomorrow)).map((made) => made.sourceName)).not.toContain("Google Analytics");

    tokenReply = goodTokens;
    await connect();
    const after = await as(owner, (tx) => getGaStatus(tx, true));
    expect(after.connection).toMatchObject({ needsReconnect: false, propertyId: "321654987" });
    expect(await as(owner, (tx) => gaLoadsNightly(tx))).toBe(true);
    // Nightly, once due.
    const nightly = await runDueLoads(new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000));
    expect(nightly.find((made) => made.sourceName === "Google Analytics")).toMatchObject({ status: "ok", trigger: "schedule" });
  });

  it("GA2 changing the property drops the old property's tables", async () => {
    const available = await listGaProperties(organisation, actor());
    const changed = await as(owner, (tx) => saveGaSettings(tx, { propertyId: "111", historyMonths: 25, reloadDaily: false }, available));
    expect(changed.propertyChanged).toBe(true);
    expect(changed.connection).toMatchObject({ propertyId: "111", propertyName: "Old site", accountName: "Old shop", currencyCode: null, historyMonths: 25, reloadDaily: false });
    const patch = await gaRoute.PATCH(apiRequest("/api/analytics/google", { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, propertyId: "321654987" } }), noContext);
    expect(patch.status).toBe(200);
    expect(await scalar("select count(*)::int from information_schema.tables where table_name like 'google_analytics%'")).toBe(0);
    expect((await refreshGa(organisation, actor(), "manual")).status).toBe("ok");
  });

  it("GA8 disconnecting deletes the sign-in and the loaded tables, withdraws it at Google, and keeps the load history", async () => {
    const refused = await gaRoute.DELETE(apiRequest(`/api/analytics/google?organisationId=${ORG}`, { method: "DELETE", cookie: viewerCookie }), noContext);
    expect(refused.status).toBe(403);
    calls = [];
    await disconnectGa(organisation, actor());
    expect(calls.filter((call) => call.url === "https://oauth2.googleapis.com/revoke")).toHaveLength(1);
    expect((await as(owner, (tx) => tx.query("select 1 from analytics_google_connections"))).rows).toEqual([]);
    expect(await scalar("select count(*)::int from information_schema.tables where table_name like 'google_analytics%'")).toBe(0);
    expect((await as(owner, (tx) => recentLoads(tx))).filter((run) => run.sourceName === "Google Analytics").length).toBeGreaterThan(3);
    expect((await as(viewer, (tx) => getGaStatus(tx, false))).connection).toBeNull();
    await expect(refreshGa(organisation, actor(), "manual")).rejects.toThrow("isn't connected");
  });
});
