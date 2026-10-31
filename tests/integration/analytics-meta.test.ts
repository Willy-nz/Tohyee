import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as metaRoute from "@/app/api/analytics/meta/route";
import * as metaAppRoute from "@/app/api/analytics/meta/app/route";
import * as metaAccountsRoute from "@/app/api/analytics/meta/accounts/route";
import * as metaCallback from "@/app/api/analytics/meta/callback/route";
import * as metaCheckRoute from "@/app/api/analytics/meta/check/route";
import * as metaLoadRoute from "@/app/api/analytics/meta/load/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as freshnessRoute from "@/app/api/analytics/dashboards/[dashboardId]/freshness/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import { closeAnalytics, listTables, queryAnalytics } from "@/lib/analytics/engine";
import {
  saveMetaApp,
  availableMetaAccounts,
  checkMetaSetup,
  claimMetaState,
  disconnectMeta,
  fetchMetaSignIn,
  getMetaStatus,
  metaLoadsNightly,
  refreshMeta,
  saveMetaChoice,
  saveMetaSignIn,
  setMetaRetryDelaysForTests,
  startMetaConnect,
} from "@/lib/analytics/meta";
import { metaMidnight, metaPostedDay } from "@/lib/analytics/meta-reports";
import { runDueLoads } from "@/lib/analytics/scheduler";
import { recentLoads } from "@/lib/analytics/sources";
import { buildTemplate } from "@/lib/analytics/templates";
import type { SessionUser } from "@/lib/auth/sessions";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "meta-social";
const noContext = undefined as unknown;
const GRAPH = "https://graph.facebook.com/v26.0";
const APP_ID = "1234567890123";
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const PAGE = "1111";
const IG = "17841400000000001";
const AD = "act_999";
/** 1pm 31 October 2026 in California (9am 1 November in New Zealand): Meta's today is 31 October; the ad account's (Auckland) is 1 November. */
const NOW = new Date("2026-10-31T20:00:00Z");
const NEXT_DAY = new Date("2026-11-01T20:00:00Z");
const ALL = ["pages_show_list", "pages_read_engagement", "read_insights", "instagram_basic", "instagram_manage_insights", "ads_read", "public_profile"];

const day = (unixSeconds: string) => metaPostedDay(new Date(Number(unixSeconds) * 1000).toISOString()).day;
const nextDay = (value: string) => new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** Meta's end_time for a day's value: the Pacific midnight that ends it. */
const endTime = (value: string) => `${new Date(metaMidnight(nextDay(value)) * 1000).toISOString().slice(0, 19)}+0000`;

/** Examples META1-META10 in docs/ACCOUNTING-EXAMPLES.md (Meta, as Looker Studio's and Power BI's Meta connectors do, not yet reviewed). Meta is a fake throughout. */
describeWithDatabase("analytics: Meta (Facebook Page, Instagram and ads)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let reportViewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let reportViewerCookie: string;
  let root: string;
  let organisation: OrganisationRecord;
  let calls: Array<{ url: URL; method: string }> = [];
  let granted = ALL;
  let late = false;
  let instagramLinked = true;
  /** Answers to give before the usual ones, matched by path. */
  let failures: Array<{ path: RegExp; reply: () => Response }> = [];
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const actor = () => ({ userId: owner.id, email: owner.email });
  const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const asked = (pattern: RegExp) => calls.filter((call) => pattern.test(call.url.pathname));

  const pageValues: Record<string, (d: string) => number> = {
    page_follows: (d) => (d < "2026-10-25" ? 600 : 600 + Number(d.slice(8)) - 24),
    page_daily_follows_unique: () => 2,
    page_daily_unfollows_unique: () => 1,
    page_media_view: () => 300,
    page_total_media_view_unique: (d) => (late && d === "2026-10-30" ? 260 : 200),
    page_post_engagements: () => 25,
  };

  const fake = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const q = url.searchParams;
    const failure = failures.find((entry) => entry.path.test(url.pathname));
    if (failure) {
      failures = failures.filter((entry) => entry !== failure);
      return failure.reply();
    }
    const p = url.pathname.replace("/v26.0", "");
    if (url.host !== "graph.facebook.com") return new Response("not found", { status: 404 });
    if (p === "/oauth/access_token") {
      if (q.get("client_secret") !== APP_SECRET) return reply({ error: { message: "Error validating client secret.", type: "OAuthException", code: 1 } }, 400);
      return q.get("grant_type") === "fb_exchange_token" ? reply({ access_token: "long-user-token", token_type: "bearer", expires_in: 5_184_000 }) : reply({ access_token: "short-user-token", token_type: "bearer" });
    }
    if (p === "/me" && q.get("fields") === "id,name") return reply({ id: "10001", name: "Jess Example" });
    if (p === "/me/permissions") {
      if (method === "DELETE") return reply({ success: true });
      return reply({ data: ALL.map((permission) => ({ permission, status: granted.includes(permission) ? "granted" : "declined" })) });
    }
    if (p === "/debug_token") {
      return reply({ data: { app_id: APP_ID, is_valid: true, expires_at: Math.round(NOW.getTime() / 1000) + 60 * 86_400, data_access_expires_at: Math.round(NOW.getTime() / 1000) + 90 * 86_400, scopes: granted } });
    }
    if (p === `/${APP_ID}`) {
      return q.get("access_token") === `${APP_ID}|${APP_SECRET}` ? reply({ id: APP_ID, name: "Tohyee reports" }) : reply({ error: { message: "Invalid OAuth access token signature.", code: 190 } }, 400);
    }
    if (p === "/me/accounts") {
      const first = { id: PAGE, name: "Paw Prints NZ", access_token: "page-token", tasks: ["ANALYZE", "ADVERTISE", "CREATE_CONTENT", "MODERATE", "MANAGE"], ...(instagramLinked ? { instagram_business_account: { id: IG, username: "pawprints.nz", followers_count: 812 } } : {}) };
      const second = { id: "2222", name: "Another Page", access_token: "page-token-2", tasks: ["ADVERTISE"] };
      return q.get("after") === "p2" ? reply({ data: [second], paging: { cursors: { after: "p3" } } }) : reply({ data: [first], paging: { cursors: { after: "p2" }, next: `${GRAPH}/me/accounts?after=p2` } });
    }
    if (p === "/me/adaccounts") return reply({ data: [{ id: AD, name: "Paw Prints ads", currency: "NZD", timezone_name: "Pacific/Auckland", account_status: 1 }] });
    if (p === `/${PAGE}/insights`) {
      if (q.get("access_token") !== "page-token") return reply({ error: { message: "bad token", code: 190 } }, 400);
      const from = day(q.get("since")!);
      const to = day(String(Number(q.get("until")) - 1));
      const data = q.get("metric")!.split(",").map((name) => {
        const values: Array<{ value: number; end_time: string }> = [];
        for (let d = from; d <= to; d = nextDay(d)) values.push({ value: pageValues[name](d), end_time: endTime(d) });
        return { name, period: "day", values };
      });
      return reply({ data });
    }
    if (p === `/${PAGE}/published_posts`) {
      const insights = (reach: number) => ({
        data: [
          { name: "post_media_view", values: [{ value: reach + 100 }] },
          { name: "post_total_media_view_unique", values: [{ value: reach }] },
          { name: "post_clicks", values: [{ value: 20 }] },
          { name: "post_reactions_by_type_total", values: [{ value: { like: 30, love: 5 } }] },
          { name: "post_activity_by_action_type", values: [{ value: { comment: 4, share: 2 } }] },
        ],
      });
      return reply({
        data: [
          { id: `${PAGE}_3`, created_time: "2026-10-29T22:00:00+0000", message: "Nose print rings are back", permalink_url: "https://www.facebook.com/1111/posts/3", status_type: "added_photos", insights: insights(late ? 950 : 900) },
          { id: `${PAGE}_2`, created_time: "2026-10-20T22:00:00+0000", message: "Behind the scenes", permalink_url: "https://www.facebook.com/1111/posts/2", status_type: "added_video", insights: insights(400) },
          { id: `${PAGE}_1`, created_time: "2024-09-01T22:00:00+0000", message: "Too old to load", status_type: "mobile_status_update", insights: insights(10) },
        ],
      });
    }
    if (p === `/${IG}/insights`) {
      const d = day(q.get("since")!);
      if (q.get("breakdown") === "follow_type") {
        return reply({ data: [{ name: "follows_and_unfollows", period: "day", total_value: { breakdowns: [{ dimension_keys: ["follow_type"], results: [{ dimension_values: ["FOLLOWER"], value: 5 }, { dimension_values: ["NON_FOLLOWER"], value: 1 }] }] } }] });
      }
      // Meta sends nothing (not 0) for days without data.
      if (d < "2026-10-25") return reply({ data: [] });
      return reply({ data: q.get("metric")!.split(",").map((name) => ({ name, period: "day", total_value: { value: name === "reach" ? 400 + Number(d.slice(8)) : 10 } })) });
    }
    if (p === `/${IG}`) return reply({ id: IG, followers_count: 812, username: "pawprints.nz" });
    if (p === `/${IG}/media`) {
      return reply({
        data: [
          { id: "m3", caption: "Kobe's paw print pendant", media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-10-30T01:00:00+0000", permalink: "https://www.instagram.com/p/m3/", like_count: 51, comments_count: 4 },
          { id: "m2", caption: "Making a nose print ring", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-10-26T01:00:00+0000", permalink: "https://www.instagram.com/reel/m2/", like_count: 120, comments_count: 9 },
          { id: "m1", caption: "Our first post", media_type: "IMAGE", media_product_type: "FEED", timestamp: "2025-01-10T01:00:00+0000", permalink: "https://www.instagram.com/p/m1/", like_count: 7, comments_count: 0 },
        ],
      });
    }
    if (p === "/m1/insights") return reply({ error: { message: "Media posted before business account conversion", code: 100, error_subcode: 2108006 } }, 400);
    if (/^\/m\d\/insights$/.test(p)) return reply({ data: q.get("metric")!.split(",").map((name) => ({ name, period: "lifetime", values: [{ value: name === "reach" ? (p === "/m3/insights" ? 700 : 2400) : 12 }] })) });
    if (p === `/${AD}/insights`) {
      const range = JSON.parse(q.get("time_range")!) as { since: string; until: string };
      const rows: Array<Record<string, unknown>> = [];
      for (let d = range.since; d <= range.until; d = nextDay(d)) {
        if (d < "2026-10-26") continue;
        rows.push({ campaign_id: "120200000000001", campaign_name: "Spring nose prints", account_currency: "NZD", spend: "12.34", impressions: "2150", reach: "1600", clicks: "41", inline_link_clicks: "30", results: [{ indicator: "actions:link_click", values: [{ value: "30" }] }], date_start: d, date_stop: d });
        rows.push({ campaign_id: "120200000000002", campaign_name: "Christmas gift guide", account_currency: "NZD", spend: "5.5", impressions: "800", reach: "700", clicks: "9", inline_link_clicks: "6", date_start: d, date_stop: d });
      }
      // Two pages of rows.
      const half = Math.ceil(rows.length / 2);
      return q.get("after") === "a2" ? reply({ data: rows.slice(half) }) : reply({ data: rows.slice(0, half), ...(rows.length > half ? { paging: { cursors: { after: "a2" }, next: "x" } } : {}) });
    }
    return reply({ error: { message: `Unknown path ${p}`, code: 100 } }, 400);
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "meta-test-secret-key-0123456789abcdef-0123";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-meta-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("meta-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("meta-viewer@example.com");
    reportViewer = await createTestUser("meta-client@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'report_viewer')", [ORG, viewer.id, reportViewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    reportViewerCookie = await sessionCookieFor(reportViewer);
    await as(owner, (tx) => updateOrganisationSettings(tx, { analyticsEnabled: true }));
    organisation = (await getOrganisation(ORG))!;
    setMailFetchForTests(fake);
    setMetaRetryDelaysForTests([0, 0, 0]);
  });

  afterAll(async () => {
    setMailFetchForTests(null);
    setMetaRetryDelaysForTests(null);
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  const scalar = async (sql: string) => Object.values((await queryAnalytics(ORG, sql))[0])[0];
  const connect = async (withAds = true) => {
    const { app } = await as(owner, async (tx) => claimMetaState(tx, new URL((await startMetaConnect(tx, "https://tohyee.test", { withAds })).url).searchParams.get("state")!));
    const signIn = await fetchMetaSignIn(app, "code-x", "https://tohyee.test", NOW);
    await as(owner, (tx) => saveMetaSignIn(tx, signIn));
  };

  it("META1 an admin saves the Meta app, then signs in asking only to read; tokens are stored encrypted", async () => {
    // Nothing to sign in with until the app is saved.
    const early = await metaRoute.POST(apiRequest("/api/analytics/meta", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext);
    expect(((await early.json()) as { error: string }).error).toContain("Meta isn't set up yet");
    const put = (cookie: string, body: Record<string, unknown>) => metaAppRoute.PUT(apiRequest("/api/analytics/meta/app", { method: "PUT", cookie, body: { organisationId: ORG, ...body } }), noContext);
    expect((await put(viewerCookie, { appId: APP_ID, appSecret: APP_SECRET })).status).toBe(403);
    expect(((await (await put(ownerCookie, { appId: APP_ID, appSecret: "not-a-secret" })).json()) as { error: string }).error).toContain("32 letters and numbers");
    expect(((await (await put(ownerCookie, { appId: "abc", appSecret: APP_SECRET })).json()) as { error: string }).error).toContain("only digits");
    expect((await put(ownerCookie, { appId: APP_ID, appSecret: APP_SECRET })).status).toBe(200);
    const saved = await metaAppRoute.GET(apiRequest(`/api/analytics/meta/app?organisationId=${ORG}`, { cookie: ownerCookie }), noContext);
    expect(await saved.json()).toEqual({ appId: APP_ID, secretSaved: true, configId: null });
    expect((await metaAppRoute.GET(apiRequest(`/api/analytics/meta/app?organisationId=${ORG}`, { cookie: viewerCookie }), noContext)).status).toBe(403);
    const stored = await as(owner, (tx) => tx.query<{ app_secret_ciphertext: string }>("select app_secret_ciphertext from analytics_meta_apps"));
    expect(stored.rows[0].app_secret_ciphertext).not.toContain(APP_SECRET);

    expect((await metaRoute.POST(apiRequest("/api/analytics/meta", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }), noContext)).status).toBe(403);
    const started = await metaRoute.POST(apiRequest("/api/analytics/meta", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, withAds: true } }), noContext);
    const { url } = (await started.json()) as { url: string };
    const query = new URL(url).searchParams;
    expect(url.startsWith("https://www.facebook.com/v26.0/dialog/oauth?")).toBe(true);
    expect([query.get("client_id"), query.get("redirect_uri"), query.get("response_type"), query.get("scope")]).toEqual([
      APP_ID,
      "http://tohyee.test/api/analytics/meta/callback",
      "code",
      "pages_show_list,pages_read_engagement,read_insights,instagram_basic,instagram_manage_insights,ads_read",
    ]);

    const back = await metaCallback.GET(apiRequest(`/api/analytics/meta/callback?state=${encodeURIComponent(query.get("state")!)}&code=code-1`, { cookie: ownerCookie }));
    expect(back.headers.get("location")).toBe("http://tohyee.test/analytics/sources?meta=connected");
    // The code was swapped for a long-lived token.
    expect(asked(/oauth\/access_token$/).map((call) => call.url.searchParams.get("grant_type"))).toEqual([null, "fb_exchange_token"]);
    const again = await metaCallback.GET(apiRequest(`/api/analytics/meta/callback?state=${encodeURIComponent(query.get("state")!)}&code=code-1`, { cookie: ownerCookie }));
    const location = new URL(again.headers.get("location")!);
    expect([location.searchParams.get("meta"), location.searchParams.get("message")]).toEqual(["error", expect.stringContaining("expired or was already used")]);

    const row = await as(owner, (tx) => tx.query<{ user_token_ciphertext: string; facebook_user_id: string }>("select * from analytics_meta_connections"));
    expect(row.rows[0].facebook_user_id).toBe("10001");
    expect(row.rows[0].user_token_ciphertext).not.toContain("long-user-token");
    const status = await as(owner, (tx) => getMetaStatus(tx, true, NOW));
    expect(status.connection).toMatchObject({ facebookName: "Jess Example", pageId: null, canReadAds: true, signInEndsSoon: false, signInEndsAt: "2026-12-30T20:00:00.000Z" });
    expect((await as(viewer, (tx) => getMetaStatus(tx, false))).connection).toMatchObject({ facebookName: null });

    // Unticking reading insights at Meta is refused, and nothing changes.
    granted = ALL.filter((name) => name !== "read_insights");
    const { app } = await as(owner, async (tx) => claimMetaState(tx, new URL((await startMetaConnect(tx, "https://tohyee.test")).url).searchParams.get("state")!));
    await expect(fetchMetaSignIn(app, "code-2", "https://tohyee.test")).rejects.toThrow("didn't allow Tohyee to read your Page's insights");
    granted = ALL;

    // With a Facebook Login for Business configuration, its ID is sent instead of the permissions.
    await put(ownerCookie, { appId: APP_ID, configId: "555000111" });
    const configured = new URL((await as(owner, (tx) => startMetaConnect(tx, "https://tohyee.test"))).url).searchParams;
    expect([configured.get("config_id"), configured.get("scope")]).toEqual(["555000111", null]);
    await put(ownerCookie, { appId: APP_ID, configId: "" });
  });

  it("META2 lists the Pages with their Instagram accounts and the ad accounts; only those can be chosen", async () => {
    const response = await metaAccountsRoute.GET(apiRequest(`/api/analytics/meta/accounts?organisationId=${ORG}`, { cookie: ownerCookie }), noContext);
    const accounts = (await response.json()) as Record<string, unknown>;
    expect(accounts).toEqual({
      pages: [
        { id: "2222", name: "Another Page", canAnalyse: false, instagram: null },
        { id: PAGE, name: "Paw Prints NZ", canAnalyse: true, instagram: { id: IG, username: "pawprints.nz", followers: 812 } },
      ],
      adAccounts: [{ id: AD, name: "Paw Prints ads", currency: "NZD", timeZone: "Pacific/Auckland", active: true }],
      canReadAds: true,
    });
    // No tokens leave the server.
    expect(JSON.stringify(accounts)).not.toContain("page-token");
    for (const cookie of [viewerCookie, reportViewerCookie]) {
      expect((await metaAccountsRoute.GET(apiRequest(`/api/analytics/meta/accounts?organisationId=${ORG}`, { cookie }), noContext)).status).toBe(403);
    }
    const available = await availableMetaAccounts(organisation, actor());
    await expect(as(owner, (tx) => saveMetaChoice(tx, { pageId: "2222" }, available))).rejects.toThrow("can't see its insights");
    await expect(as(owner, (tx) => saveMetaChoice(tx, { pageId: "3333" }, available))).rejects.toThrow("isn't one this Facebook account manages");
    await expect(as(owner, (tx) => saveMetaChoice(tx, { pageId: PAGE, adAccountId: "act_1" }, available))).rejects.toThrow("ad account isn't one");
    const patched = await metaRoute.PATCH(apiRequest("/api/analytics/meta", { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, pageId: PAGE, adAccountId: AD } }), noContext);
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { connection: unknown }).connection).toMatchObject({ pageId: PAGE, pageName: "Paw Prints NZ", instagramId: IG, instagramUsername: "pawprints.nz", adAccountId: AD, adCurrency: "NZD", adTimeZone: "Pacific/Auckland" });
    const stored = await as(owner, (tx) => tx.query<{ page_token_ciphertext: string }>("select page_token_ciphertext from analytics_meta_connections"));
    expect(stored.rows[0].page_token_ciphertext).not.toContain("page-token");
  });

  it("META3 the first load reads two years of the Page, 90 days of Instagram and 13 months of ads, and META5 loads plain tables", async () => {
    calls = [];
    const run = await refreshMeta(organisation, actor(), "manual", NOW);
    expect(run).toMatchObject({ status: "ok", error: null, sourceName: "Meta (Facebook and Instagram)", fileName: "Paw Prints NZ, @pawprints.nz, ads: Paw Prints ads" });
    // Page insights: 2 years in 90-day questions, each with Pacific midnights.
    const pageAsks = asked(new RegExp(`/${PAGE}/insights$`));
    expect(pageAsks).toHaveLength(9);
    expect(pageAsks[0].url.searchParams.get("since")).toBe(String(metaMidnight("2024-11-02")));
    expect(pageAsks[0].url.searchParams.get("period")).toBe("day");
    // Instagram: 90 days, two questions a day.
    expect(asked(new RegExp(`/${IG}/insights$`))).toHaveLength(180);
    expect(asked(new RegExp(`/${IG}/insights$`))[0].url.searchParams.get("metric_type")).toBe("total_value");
    // Ads: 13 months back from the ad account's today (1 Nov in Auckland), a month a question.
    const adAsks = asked(new RegExp(`/${AD}/insights$`)).filter((call) => !call.url.searchParams.get("after"));
    expect(JSON.parse(adAsks[0].url.searchParams.get("time_range")!)).toEqual({ since: "2025-10-01", until: "2025-10-30" });
    expect(adAsks[0].url.searchParams.get("level")).toBe("campaign");

    expect(await queryAnalytics(ORG, "select date::varchar as date, followers::int as followers, reach::int as reach, engagements::int as engagements, may_still_change from meta_facebook_daily where date >= '2026-10-27' order by date")).toEqual([
      { date: "2026-10-27", followers: 603, reach: 200, engagements: 25, may_still_change: false },
      { date: "2026-10-28", followers: 604, reach: 200, engagements: 25, may_still_change: false },
      { date: "2026-10-29", followers: 605, reach: 200, engagements: 25, may_still_change: true },
      { date: "2026-10-30", followers: 606, reach: 200, engagements: 25, may_still_change: true },
      { date: "2026-10-31", followers: 607, reach: 200, engagements: 25, may_still_change: true },
    ]);
    expect(await scalar("select count(*)::int from meta_facebook_daily")).toBe(729);
    expect(await queryAnalytics(ORG, "select post_id, date::varchar as date, type, reactions::int as reactions, comments::int as comments, reach::int as reach from meta_facebook_posts order by date")).toEqual([
      { post_id: "1111_2", date: "2026-10-20", type: "Video", reactions: 35, comments: 4, reach: 400 },
      { post_id: "1111_3", date: "2026-10-29", type: "Photo", reactions: 35, comments: 4, reach: 900 },
    ]);
    // Instagram: days with no data are empty, not 0.
    expect(await scalar("select count(*)::int from meta_instagram_daily")).toBe(90);
    expect(await queryAnalytics(ORG, "select reach, follows::int as follows from meta_instagram_daily where date = '2026-10-20'")).toEqual([{ reach: null, follows: 5 }]);
    expect(await scalar("select reach::int from meta_instagram_daily where date = '2026-10-30'")).toBe(430);
    expect(await queryAnalytics(ORG, "select date::varchar as date, account, followers::int as followers from meta_instagram_followers")).toEqual([{ date: "2026-10-31", account: "@pawprints.nz", followers: 812 }]);
    expect(await queryAnalytics(ORG, "select post_id, type, likes::int as likes, reach::int as reach, profile_visits::int as visits from meta_instagram_posts order by date")).toEqual([
      { post_id: "m1", type: "Photo", likes: 7, reach: null, visits: null },
      { post_id: "m2", type: "Reel", likes: 120, reach: 2400, visits: null },
      { post_id: "m3", type: "Photo", likes: 51, reach: 700, visits: 12 },
    ]);
    // A reel isn't asked for profile visits.
    expect(asked(/\/m2\/insights$/)[0].url.searchParams.get("metric")).toBe("reach,views,saved,shares,total_interactions");
    // Ads: exact amounts in NZD, by campaign and the ad account's own days (26 Oct to 1 Nov).
    expect(await scalar("select count(*)::int from meta_ads_daily")).toBe(14);
    expect(await scalar("select sum(spend)::varchar from meta_ads_daily")).toBe("124.88");
    expect(await queryAnalytics(ORG, "select currency, spend::varchar as spend, results::varchar as results, result_type from meta_ads_daily where date = '2026-11-01' order by campaign")).toEqual([
      { currency: "NZD", spend: "5.50", results: null, result_type: null },
      { currency: "NZD", spend: "12.34", results: "30.00", result_type: "Link click" },
    ]);
    expect((await as(owner, (tx) => getMetaStatus(tx, true, NOW))).connection).toMatchObject({ facebookLoadedThrough: "2026-10-31", instagramLoadedThrough: "2026-10-31", adsLoadedThrough: "2026-11-01" });
    // A CSV source can't take the prefix.
    const csv = await sourcesRoute.POST(
      apiRequest("/api/analytics/sources", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "x", tableName: "meta_extra", fileName: "x.csv", columns: [{ source: "a", name: "a", kind: "text" }] } }),
      noContext,
    );
    expect(((await csv.json()) as { error: string }).error).toContain("kept for Meta");
  });

  it("META4 the next day fetches only the new days and the last two again; finished days are kept and changed ones replaced", async () => {
    calls = [];
    late = true;
    const run = await refreshMeta(organisation, actor(), "manual", NEXT_DAY);
    expect(run.status).toBe("ok");
    const pageAsks = asked(new RegExp(`/${PAGE}/insights$`));
    expect(pageAsks.map((call) => [day(call.url.searchParams.get("since")!), day(String(Number(call.url.searchParams.get("until")) - 1))])).toEqual([["2026-10-29", "2026-11-01"]]);
    expect(asked(new RegExp(`/${IG}/insights$`))).toHaveLength(8);
    expect(JSON.parse(asked(new RegExp(`/${AD}/insights$`))[0].url.searchParams.get("time_range")!)).toEqual({ since: "2026-10-25", until: "2026-11-02" });
    expect(await scalar("select count(*)::int from (select date from meta_facebook_daily group by date having count(*) > 1)")).toBe(0);
    expect(await scalar("select count(*)::int from meta_facebook_daily")).toBe(730);
    expect(await scalar("select reach::int from meta_facebook_daily where date = '2026-10-30'")).toBe(260);
    expect(await scalar("select may_still_change from meta_facebook_daily where date = '2026-10-29'")).toBe(false);
    // Posts from the last 28 days are read again; the follower count gains a day.
    expect(await scalar("select reach::int from meta_facebook_posts where post_id = '1111_3'")).toBe(950);
    expect(await scalar("select count(*)::int from meta_facebook_posts")).toBe(2);
    expect(await scalar("select count(*)::int from meta_instagram_followers")).toBe(2);
    expect(await scalar("select count(*)::int from meta_instagram_posts")).toBe(3);
    expect(await scalar("select count(*)::int from meta_ads_daily")).toBe(16);
    late = false;
  });

  it("META7 Meta's limits are retried; one Meta says lasts stops calling and keeps the parts already read", async () => {
    // A short limit is waited out and retried.
    failures = [{ path: new RegExp(`/${PAGE}/insights$`), reply: () => reply({ error: { message: "Application request limit reached", code: 4 } }, 400) }];
    expect((await refreshMeta(organisation, actor(), "manual", NEXT_DAY)).status).toBe("ok");

    // Instagram's limit for 30 minutes: Tohyee stops calling at once; the Page is saved, Instagram and ads carry on next time.
    calls = [];
    failures = [
      {
        path: new RegExp(`/${IG}/insights$`),
        reply: () =>
          reply({ error: { message: "Too many calls", code: 80002 } }, 400, {
            "x-business-use-case-usage": JSON.stringify({ [IG]: [{ type: "instagram", call_count: 100, estimated_time_to_regain_access: 30 }] }),
          }),
      },
    ];
    const before = (await as(owner, (tx) => getMetaStatus(tx, true, NOW))).connection!;
    const stopped = await refreshMeta(organisation, actor(), "manual", new Date("2026-11-02T20:00:00Z"));
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toContain("Instagram: Meta's limit for the Instagram account's insights is used up for now (Meta says to wait about 30 minutes)");
    expect(stopped.error).toContain("Facebook Page loaded to 2 Nov 2026.");
    expect(asked(new RegExp(`/${IG}/insights$`))).toHaveLength(1);
    expect(asked(new RegExp(`/${AD}/insights$`))).toHaveLength(0);
    expect((await as(owner, (tx) => getMetaStatus(tx, true, NOW))).connection).toMatchObject({ facebookLoadedThrough: "2026-11-02", instagramLoadedThrough: before.instagramLoadedThrough, adsLoadedThrough: before.adsLoadedThrough });

    // A permission Meta refuses: plain words, and nothing changes.
    failures = [{ path: new RegExp(`/${PAGE}/insights$`), reply: () => reply({ error: { message: "(#10) Requires read_insights permission", code: 10 } }, 403) }];
    const refused = await refreshMeta(organisation, actor(), "manual", new Date("2026-11-02T20:00:00Z"));
    expect(refused.error).toContain("Meta says this sign-in isn't allowed to read the Page's insights");
    expect(refused.error).toContain("Use Check setup");
  });

  it("META6 a password change ends the sign-in: nothing loads until an admin connects again, which keeps the choices", async () => {
    failures = [{ path: new RegExp(`/${PAGE}/insights$`), reply: () => reply({ error: { message: "Error validating access token: The session has been invalidated because the user changed their password.", code: 190, error_subcode: 460 } }, 400) }];
    const run = await refreshMeta(organisation, actor(), "manual", NEXT_DAY);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Meta no longer accepts this sign-in (the Facebook password was changed)");
    expect((await as(owner, (tx) => getMetaStatus(tx, true, NOW))).connection).toMatchObject({ needsReconnect: true, reconnectReason: "the Facebook password was changed" });
    expect(await as(owner, (tx) => metaLoadsNightly(tx))).toBe(false);
    await expect(refreshMeta(organisation, actor(), "manual", NEXT_DAY).then((made) => made.error)).resolves.toContain("connect again");
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setUTCHours(18, 0, 0, 0);
    expect((await runDueLoads(tomorrow)).map((made) => made.sourceName)).not.toContain("Meta (Facebook and Instagram)");

    await connect();
    expect((await as(owner, (tx) => getMetaStatus(tx, true, NOW))).connection).toMatchObject({ needsReconnect: false, reconnectReason: null, pageId: PAGE, instagramId: IG, adAccountId: AD, facebookLoadedThrough: "2026-11-02" });
    const nightly = await runDueLoads(new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000));
    expect(nightly.find((made) => made.sourceName === "Meta (Facebook and Instagram)")).toMatchObject({ status: "ok", trigger: "schedule" });
  });

  it("META8 Check setup goes through each part and says plainly what to fix", async () => {
    const response = await metaCheckRoute.GET(apiRequest(`/api/analytics/meta/check?organisationId=${ORG}`, { cookie: ownerCookie }), noContext);
    const { checks } = (await response.json()) as { checks: Array<{ id: string; state: string; text: string }> };
    expect(checks.map((check) => [check.id, check.state])).toEqual([
      ["server", "ok"],
      ["app", "ok"],
      ["signin", "ok"],
      ["permissions", "ok"],
      ["page", "ok"],
      ["instagram", "ok"],
      ["ads", "ok"],
    ]);
    expect(checks.find((check) => check.id === "app")!.text).toContain('"Tohyee reports"');
    expect((await metaCheckRoute.GET(apiRequest(`/api/analytics/meta/check?organisationId=${ORG}`, { cookie: viewerCookie }), noContext)).status).toBe(403);
    // Instagram not linked to the Page: how to make it professional and link it.
    instagramLinked = false;
    const unlinked = await checkMetaSetup(organisation, actor(), NOW);
    expect(unlinked.find((check) => check.id === "instagram")).toMatchObject({ state: "warning", text: expect.stringContaining("Switch to professional account") });
    instagramLinked = true;
    // The secret copied wrong: Meta doesn't accept the app.
    await as(owner, (tx) => saveMetaApp(tx, { appId: APP_ID, appSecret: "ffffffffffffffffffffffffffffffff" }));
    const wrong = await checkMetaSetup(organisation, actor(), NOW);
    expect(wrong.at(-1)).toMatchObject({ id: "app", state: "problem", text: expect.stringContaining("didn't accept the App ID and App secret") });
    await as(owner, (tx) => saveMetaApp(tx, { appId: APP_ID, appSecret: APP_SECRET }));
  });

  it("META9 the Social media report reads the tables, for people who can see Analytics, with Meta's changing days in its freshness", async () => {
    const tables = await listTables(ORG);
    const built = buildTemplate("social", [...tables].map(([name, columns]) => ({ name, columns })), "2026-10-31")!;
    expect(built).not.toBeNull();
    const made = await dashboardsRoute.POST(
      apiRequest("/api/analytics/dashboards", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: built.name, description: built.description, settings: { ...built.settings, preset: null, from: "2026-10-01", to: "2026-10-31" }, tiles: built.tiles } }),
      noContext,
    );
    expect(made.status).toBe(201);
    const dashboardId = ((await made.json()) as { dashboard: { id: string } }).dashboard.id;
    const ask = async (title: string, cookie = viewerCookie) => {
      const tile = built.tiles.find((entry) => entry.title === title)!;
      const response = await queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie, body: { organisationId: ORG, dashboardId, tileId: tile.id, filters: { from: "2026-10-01", to: "2026-10-31" } } }), noContext);
      return { status: response.status, data: (await response.json()) as { rows: Array<Record<string, unknown>> } };
    };
    // Followers are the latest day's total, not the days added up.
    const followers = await ask("Facebook followers");
    expect(followers.status).toBe(200);
    expect(Number(followers.data.rows[0].m0)).toBe(607);
    expect(Number((await ask("Instagram followers")).data.rows[0].m0)).toBe(812);
    // Spend in October: 26-31 Oct (Auckland days), 6 x (12.34 + 5.50) = 107.04; cost per click 107.04 / 300.
    expect(String((await ask("Ad spend")).data.rows[0].m0)).toMatch(/^107\.04/);
    expect(Number((await ask("Cost per click")).data.rows[0].m0)).toBeCloseTo(107.04 / 300, 6);
    const top = await ask("Top Facebook posts");
    expect(top.data.rows.map((row) => row.category)).toEqual(["Nose print rings are back", "Behind the scenes"]);
    expect((await ask("Facebook followers", reportViewerCookie)).status).toBe(404);
    const freshness = await freshnessRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}/freshness?organisationId=${ORG}`, { cookie: viewerCookie }), params({ dashboardId }));
    const sources = ((await freshness.json()) as { sources: Array<Record<string, unknown>> }).sources;
    expect(sources).toEqual([expect.objectContaining({ name: "Meta (Facebook and Instagram)", mayChangeFrom: expect.stringMatching(/^2026-1[01]-\d\d$/) })]);
    // The connection's status: viewers yes (no Facebook name), report viewers no.
    const seen = await metaRoute.GET(apiRequest(`/api/analytics/meta?organisationId=${ORG}`, { cookie: viewerCookie }), noContext);
    expect(((await seen.json()) as { connection: { facebookName: unknown } }).connection.facebookName).toBeNull();
    expect((await metaRoute.GET(apiRequest(`/api/analytics/meta?organisationId=${ORG}`, { cookie: reportViewerCookie }), noContext)).status).toBe(403);
    expect((await metaLoadRoute.POST(apiRequest("/api/analytics/meta/load", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }), noContext)).status).toBe(403);
  });

  it("META10 disconnecting deletes the sign-in and the tables, removes the app's permissions at Meta, and keeps the app and the load history", async () => {
    expect((await metaRoute.DELETE(apiRequest(`/api/analytics/meta?organisationId=${ORG}`, { method: "DELETE", cookie: viewerCookie }), noContext)).status).toBe(403);
    calls = [];
    await disconnectMeta(organisation, actor());
    expect(calls.filter((call) => call.method === "DELETE" && call.url.pathname.endsWith("/me/permissions"))).toHaveLength(1);
    expect((await as(owner, (tx) => tx.query("select 1 from analytics_meta_connections"))).rows).toEqual([]);
    expect((await as(owner, (tx) => tx.query("select 1 from analytics_meta_apps"))).rows).toHaveLength(1);
    expect(await scalar("select count(*)::int from information_schema.tables where table_name like 'meta\\_%' escape '\\'")).toBe(0);
    expect((await as(owner, (tx) => recentLoads(tx))).filter((run) => run.sourceName === "Meta (Facebook and Instagram)").length).toBeGreaterThan(3);
    await expect(refreshMeta(organisation, actor(), "manual", NOW)).rejects.toThrow("isn't connected");
  });
});
