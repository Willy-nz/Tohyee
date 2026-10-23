import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as officeMetadataRoute from "@/app/.well-known/oauth-protected-resource/api/office/route";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as sharesRoute from "@/app/api/analytics/dashboards/[dashboardId]/shares/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as connectedAppsRoute from "@/app/api/auth/connected-apps/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as consentRoute from "@/app/api/oauth/requests/[handle]/route";
import * as registerRoute from "@/app/api/oauth/register/route";
import * as tokenRoute from "@/app/api/oauth/token/route";
import * as officeMeRoute from "@/app/api/office/me/route";
import * as officeQueryRoute from "@/app/api/office/query/route";
import * as officeFreshnessRoute from "@/app/api/office/reports/[dashboardId]/freshness/route";
import * as officeImageRoute from "@/app/api/office/reports/[dashboardId]/images/[imageId]/route";
import * as officeReportRoute from "@/app/api/office/reports/[dashboardId]/route";
import * as officeReportsRoute from "@/app/api/office/reports/route";
import * as officeValuesRoute from "@/app/api/office/values/route";
import * as addinStatusRoute from "@/app/api/powerpoint-addin/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import * as authorizeRoute from "@/app/oauth/authorize/route";
import * as clientDocumentRoute from "@/app/office/powerpoint/client.json/route";
import * as manifestRoute from "@/app/office/powerpoint/manifest.xml/route";
import { consentDetails, OAUTH_BROWSER_COOKIE } from "@/lib/ai/oauth/authorize";
import { setCodeExchangePauseForTests } from "@/lib/ai/oauth/tokens";
import { revokeUserAiKeys } from "@/lib/ai/tokens";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { writeServerValue } from "@/lib/server-settings";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";
import { gate, stillWaiting } from "../helpers/gate";

/*
 * The PowerPoint add-in (#429, decisions 830-849), end to end against the
 * routes: its sign-in with the OAuth from #427 as Tohyee's own built-in app,
 * tokens for the read-only Analytics API for Office that don't work for MCP
 * (nor MCP's for it), report viewers seeing only what's shared with them,
 * and no writes. Made-up data only; nothing outside Tohyee is called.
 */

const ORG = "office-books";
const PUBLIC = "https://slides.example.nz";
const OFFICE_RESOURCE = `${PUBLIC}/api/office`;
const MCP_RESOURCE = `${PUBLIC}/api/mcp`;
const CLIENT_ID = `${PUBLIC}/office/powerpoint/client.json`;
const REDIRECT = `${PUBLIC}/office/powerpoint/signed-in`;
const noContext = undefined as unknown;

type Json = Record<string, unknown>;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function setRemote(publicUrl: string | null) {
  await withCoreTransaction((client) => writeServerValue(client, "remote_access", { enabled: publicUrl !== null, publicUrl }, "test"));
}

async function token(values: Record<string, string>) {
  const response = await tokenRoute.POST(
    new Request(`${PUBLIC}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values).toString() }),
    noContext,
  );
  return { status: response.status, body: (await response.json()) as Json };
}

async function authorize(values: Record<string, string | undefined>) {
  const url = new URL("http://tohyee.test/oauth/authorize");
  for (const [name, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(name, value);
  const response = await authorizeRoute.GET(new Request(url), noContext);
  const location = response.headers.get("location") ?? "";
  return {
    status: response.status,
    location,
    cookie: /tohyee_oauth_browser=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? null,
    handle: /\/connect\/([A-Za-z0-9_-]{43})$/.exec(location)?.[1] ?? null,
  };
}

/** A GET to the Analytics API for Office with a bearer token (or a cookie, to show it's ignored). */
function officeGet(pathAndQuery: string, auth: { bearer?: string | null; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.cookie) headers.cookie = auth.cookie;
  return new Request(`${PUBLIC}${pathAndQuery}`, { headers });
}

function officePost(pathname: string, bearer: string | null, body: Json) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return new Request(`${PUBLIC}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function read(response: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked field by field
  return { status: response.status, body: (await response.json()) as Record<string, any>, headers: response.headers };
}

async function mcp(bearer: string) {
  const response = await mcpRoute.POST(
    new Request(MCP_RESOURCE, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
    noContext,
  );
  return { status: response.status };
}

describeWithDatabase("PowerPoint add-in for Analytics (#429, decisions 830-849)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let client: SessionUser;
  let ownerCookie: string;
  let clientCookie: string;
  let root: string;
  let sharedId = "";
  let privateId = "";

  const salesTile = (id: string) => ({
    id,
    title: "Sales by region",
    visual: "bar",
    width: "full",
    query: {
      table: "sales",
      groupBy: { field: "region" },
      measures: [{ label: "Sales", aggregate: "sum", field: "quantity", times: "unit_price" }],
      filters: [{ field: "channel", op: "eq", value: "Web" }],
      sort: { by: "category", direction: "asc" },
    },
  });

  /** Signs the add-in in as a person: authorise, allow on the consent screen, swap the code. */
  async function signIn(cookie: string, options: { resource?: string | null } = {}) {
    const { verifier, challenge } = pkce();
    const started = await authorize({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "slide-1",
      resource: options.resource === null ? undefined : (options.resource ?? OFFICE_RESOURCE),
    });
    expect(started.status).toBe(303);
    expect(started.handle).not.toBeNull();
    const decided = await consentRoute.POST(
      apiRequest(`/api/oauth/requests/${started.handle}`, { method: "POST", cookie: `${cookie}; ${OAUTH_BROWSER_COOKIE}=${started.cookie}`, body: { decision: "allow" } }),
      params({ handle: started.handle! }),
    );
    expect(decided.status).toBe(200);
    const back = new URL(((await decided.json()) as Json).redirectTo as string);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("slide-1");
    const answer = await token({ grant_type: "authorization_code", code: back.searchParams.get("code")!, client_id: CLIENT_ID, redirect_uri: REDIRECT, code_verifier: verifier, resource: OFFICE_RESOURCE });
    expect(answer.status).toBe(200);
    return { access: answer.body.access_token as string, refresh: answer.body.refresh_token as string };
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-office-it-"));
    const folder = path.join(root, "reports");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "sales.csv"), "Date,Region,Channel,Qty,Price\n2026-03-05,Otago,Web,2,10.00\n2026-03-09,Canterbury,Shop,1,0.10\n2026-04-01,Southland,Web,1,0.20\n");
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("office-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    client = await createTestUser("office-client@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'report_viewer')", [ORG, client.id]);
    ownerCookie = await sessionCookieFor(owner);
    clientCookie = await sessionCookieFor(client);
    await settingsRoute.PATCH(apiRequest(`/api/organisations/${ORG}/settings`, { method: "PATCH", cookie: ownerCookie, body: { analyticsEnabled: true } }), params({ organisationId: ORG }));
    await foldersRoute.PUT(apiRequest("/api/admin/analytics-folders", { method: "PUT", cookie: ownerCookie, body: { organisationId: ORG, folder } }), noContext);
    const source = await read(
      await sourcesRoute.POST(
        apiRequest("/api/analytics/sources", {
          method: "POST",
          cookie: ownerCookie,
          body: {
            organisationId: ORG,
            name: "Sales",
            tableName: "sales",
            fileName: "sales.csv",
            columns: [
              { source: "Date", name: "order_date", kind: "date" },
              { source: "Region", name: "region", kind: "text" },
              { source: "Channel", name: "channel", kind: "text" },
              { source: "Qty", name: "quantity", kind: "quantity" },
              { source: "Price", name: "unit_price", kind: "money" },
            ],
          },
        }),
        noContext,
      ),
    );
    const sourceId = source.body.source.id;
    await loadRoute.POST(apiRequest(`/api/analytics/sources/${sourceId}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ sourceId }));
    const make = async (name: string) => {
      const made = await read(
        await dashboardsRoute.POST(
          apiRequest("/api/analytics/dashboards", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name, settings: { slicers: [{ table: "sales", field: "region", label: "Region" }] }, tiles: [salesTile("regions")] } }),
          noContext,
        ),
      );
      expect(made.status).toBe(201);
      return String(made.body.dashboard.id);
    };
    sharedId = await make("Web sales for the client");
    privateId = await make("Internal");
    await sharesRoute.PUT(apiRequest(`/api/analytics/dashboards/${sharedId}/shares`, { method: "PUT", cookie: ownerCookie, body: { organisationId: ORG, userIds: [client.id] } }), params({ dashboardId: sharedId }));
  });

  afterAll(async () => {
    await setRemote(null);
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("offers no manifest, app details or sign-in while remote access is off", async () => {
    await setRemote(null);
    expect((await manifestRoute.GET(new Request(`${PUBLIC}/office/powerpoint/manifest.xml`))).status).toBe(404);
    expect((await clientDocumentRoute.GET()).status).toBe(404);
    expect((await officeMetadataRoute.GET()).status).toBe(404);
    const status = await read(await addinStatusRoute.GET(apiRequest("/api/powerpoint-addin", { cookie: ownerCookie }), noContext));
    expect(status.body).toMatchObject({ available: false, manifestUrl: null });
    // Plain http isn't enough either (decision 831).
    await setRemote("http://slides.example.nz");
    expect((await manifestRoute.GET(new Request(`${PUBLIC}/office/powerpoint/manifest.xml`))).status).toBe(404);
    await setRemote(PUBLIC);
  });

  it("serves the manifest, the add-in's app details and the Office API's resource metadata on the remote address", async () => {
    const manifest = await manifestRoute.GET(new Request(`${PUBLIC}/office/powerpoint/manifest.xml?download=1`));
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-disposition")).toContain("tohyee-powerpoint-addin.xml");
    const xml = await manifest.text();
    expect(xml).toContain('xsi:type="ContentApp"');
    expect(xml).toContain(`<SourceLocation DefaultValue="${PUBLIC}/office/powerpoint"/>`);
    expect(xml).toContain('<Host Name="Presentation"/>');
    expect(await (await clientDocumentRoute.GET()).json()).toMatchObject({ client_id: CLIENT_ID, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    expect(await (await officeMetadataRoute.GET()).json()).toEqual({ resource: OFFICE_RESOURCE, authorization_servers: [PUBLIC], bearer_methods_supported: ["header"], resource_name: "Tohyee Analytics for Office" });
    const status = await read(await addinStatusRoute.GET(apiRequest("/api/powerpoint-addin", { cookie: ownerCookie }), noContext));
    expect(status.body).toMatchObject({ available: true, manifestUrl: `${PUBLIC}/office/powerpoint/manifest.xml` });
  });

  it("signs the add-in in as the person, with nothing to choose, and lists it on their account", async () => {
    const { challenge } = pkce();
    const started = await authorize({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: OFFICE_RESOURCE });
    const details = await consentDetails({ sessionId: "x", user: client }, started.handle!, started.cookie);
    expect(details).toMatchObject({ kind: "office", appName: "Tohyee for PowerPoint", detailsFrom: { kind: "built_in" }, redirectHost: "slides.example.nz" });
    // A report viewer can't connect an AI app, but can use the add-in: their organisation is listed.
    expect(details!.organisations.map((organisation) => organisation.id)).toEqual([ORG]);

    const { access } = await signIn(clientCookie);
    const me = await read(await officeMeRoute.GET(officeGet("/api/office/me", { bearer: access }), noContext));
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ user: { email: "office-client@example.com", displayName: expect.any(String) }, organisations: [{ id: ORG, displayName: expect.any(String), role: "report_viewer" }] });

    const listed = await read(await connectedAppsRoute.GET(apiRequest("/api/auth/connected-apps", { cookie: clientCookie }), noContext));
    expect(listed.body.connections).toEqual([expect.objectContaining({ name: "Tohyee for PowerPoint", expired: false, revokedAt: null })]);
    // It isn't an AI app of the organisation, so the AI page doesn't list it.
    const row = await coreQuery<{ kind: string; organisation_id: string | null; access_level: string; resource: string }>("select kind, organisation_id, access_level, resource from ai_access_tokens where user_id = $1", [client.id]);
    expect(row.rows).toEqual([{ kind: "office", organisation_id: null, access_level: "read", resource: OFFICE_RESOURCE }]);
  });

  it("gives the add-in only Office tokens and other apps only MCP tokens", async () => {
    const { challenge } = pkce();
    // The add-in asking for MCP: refused, back to its own page.
    const asksMcp = await authorize({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: MCP_RESOURCE });
    expect(new URL(asksMcp.location).searchParams.get("error")).toBe("invalid_target");
    const asksOrigin = await authorize({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: PUBLIC });
    expect(new URL(asksOrigin.location).searchParams.get("error")).toBe("invalid_target");
    // Another app asking for the Office API: refused.
    const registered = await read(
      await registerRoute.POST(new Request(`${PUBLIC}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Tohyee for PowerPoint", redirect_uris: ["https://evil.example.com/cb"] }) }), noContext),
    );
    const other = await authorize({ response_type: "code", client_id: registered.body.client_id, redirect_uri: "https://evil.example.com/cb", code_challenge: challenge, code_challenge_method: "S256", resource: OFFICE_RESOURCE });
    expect(new URL(other.location).searchParams.get("error")).toBe("invalid_target");
    // Only Tohyee's own page can receive the add-in's code.
    const elsewhere = await authorize({ response_type: "code", client_id: CLIENT_ID, redirect_uri: "https://evil.example.com/cb", code_challenge: challenge, code_challenge_method: "S256", resource: OFFICE_RESOURCE });
    expect(elsewhere.location).toContain("/connect/problem?reason=redirect");
  });

  it("refuses an MCP token, an AI key and a session at the Office API, and an Office token at MCP", async () => {
    const office = await signIn(ownerCookie);
    expect((await mcp(office.access)).status).toBe(401);

    const key = ((await (await tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "Desktop" } }), noContext)).json()) as Json).token as string;
    expect((await mcp(key)).status).toBe(200);
    const withKey = await read(await officeMeRoute.GET(officeGet("/api/office/me", { bearer: key }), noContext));
    expect(withKey.status).toBe(401);
    expect(withKey.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/api/office", error="invalid_token"`);

    // An AI app's MCP token (signed in through the same OAuth) doesn't work here.
    const registered = await read(
      await registerRoute.POST(new Request(`${PUBLIC}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) }), noContext),
    );
    const { verifier, challenge } = pkce();
    const started = await authorize({ response_type: "code", client_id: registered.body.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256", resource: MCP_RESOURCE });
    const decided = await consentRoute.POST(
      apiRequest(`/api/oauth/requests/${started.handle}`, { method: "POST", cookie: `${ownerCookie}; ${OAUTH_BROWSER_COOKIE}=${started.cookie}`, body: { decision: "allow", organisationId: ORG, accessLevel: "read" } }),
      params({ handle: started.handle! }),
    );
    const code = new URL(((await decided.json()) as Json).redirectTo as string).searchParams.get("code")!;
    const mcpTokens = await token({ grant_type: "authorization_code", code, client_id: registered.body.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier, resource: MCP_RESOURCE });
    const mcpAccess = mcpTokens.body.access_token as string;
    expect((await mcp(mcpAccess)).status).toBe(200);
    expect((await officeMeRoute.GET(officeGet("/api/office/me", { bearer: mcpAccess }), noContext)).status).toBe(401);
    // Its refresh token can't be turned into Office tokens either.
    const crossed = await token({ grant_type: "refresh_token", refresh_token: mcpTokens.body.refresh_token as string, client_id: registered.body.client_id, resource: OFFICE_RESOURCE });
    expect(crossed.body.error).toBe("invalid_target");

    // A signed-in browser session doesn't work at the Office API.
    expect((await officeMeRoute.GET(officeGet("/api/office/me", { cookie: ownerCookie }), noContext)).status).toBe(401);
    expect((await officeMeRoute.GET(officeGet("/api/office/me", { bearer: office.access }), noContext)).status).toBe(200);
  });

  it("shows a report viewer only the reports shared with them, and only saved tiles", async () => {
    const { access } = await signIn(clientCookie);
    const reports = await read(await officeReportsRoute.GET(officeGet(`/api/office/reports?organisationId=${ORG}`, { bearer: access }), noContext));
    expect(reports.body.reports.map((report: { name: string }) => report.name)).toEqual(["Web sales for the client"]);
    expect(reports.body.reports[0].tiles).toEqual([{ id: "regions", title: "Sales by region", visual: "bar", page: expect.any(String) }]);

    const report = await read(await officeReportRoute.GET(officeGet(`/api/office/reports/${sharedId}?organisationId=${ORG}`, { bearer: access }), params({ dashboardId: sharedId })));
    expect(report.status).toBe(200);
    expect(report.body.dashboard.name).toBe("Web sales for the client");
    const hidden = await officeReportRoute.GET(officeGet(`/api/office/reports/${privateId}?organisationId=${ORG}`, { bearer: access }), params({ dashboardId: privateId }));
    expect(hidden.status).toBe(404);

    const answer = await read(await officeQueryRoute.POST(officePost("/api/office/query", access, { organisationId: ORG, dashboardId: sharedId, tileId: "regions", filters: { from: null, to: null, values: {} } }), noContext));
    expect(answer.status).toBe(200);
    // Only web sales: the tile's own filter holds.
    expect(answer.body.rows.map((row: { category: string }) => row.category)).toEqual(["Otago", "Southland"]);
    const notShared = await officeQueryRoute.POST(officePost("/api/office/query", access, { organisationId: ORG, dashboardId: privateId, tileId: "regions", filters: {} }), noContext);
    expect(notShared.status).toBe(404);
    // A question typed in is never run through the add-in, not even for an owner.
    const asked = await officeQueryRoute.POST(officePost("/api/office/query", access, { organisationId: ORG, query: salesTile("x").query, filters: {} }), noContext);
    expect(asked.status).toBe(403);
    const owners = await signIn(ownerCookie);
    expect((await officeQueryRoute.POST(officePost("/api/office/query", owners.access, { organisationId: ORG, query: salesTile("x").query, filters: {} }), noContext)).status).toBe(403);

    // The slicer lists only what the report's tiles show (decision 697).
    const values = await read(await officeValuesRoute.GET(officeGet(`/api/office/values?organisationId=${ORG}&dashboardId=${sharedId}&table=sales&field=region`, { bearer: access }), noContext));
    expect(values.body.values).toEqual(["Otago", "Southland"]);
    const notASlicer = await officeValuesRoute.GET(officeGet(`/api/office/values?organisationId=${ORG}&dashboardId=${sharedId}&table=sales&field=channel`, { bearer: access }), noContext);
    expect(notASlicer.status).toBe(403);
    const freshness = await read(await officeFreshnessRoute.GET(officeGet(`/api/office/reports/${sharedId}/freshness?organisationId=${ORG}`, { bearer: access }), params({ dashboardId: sharedId })));
    expect(freshness.status).toBe(200);
    expect(freshness.body.sources[0]).toMatchObject({ name: "Sales", refreshedAt: expect.any(String) });
    const image = await officeImageRoute.GET(officeGet(`/api/office/reports/${privateId}/images/1?organisationId=${ORG}`, { bearer: access }), params({ dashboardId: privateId, imageId: "1" }));
    expect(image.status).toBe(404);
  });

  it("only reads: the Office API has no write methods and changes nothing", async () => {
    const modules: Array<Record<string, unknown>> = [officeMeRoute, officeReportsRoute, officeReportRoute, officeFreshnessRoute, officeImageRoute, officeValuesRoute, officeQueryRoute];
    for (const routeModule of modules) {
      for (const method of ["PUT", "PATCH", "DELETE"]) expect(routeModule[method]).toBeUndefined();
    }
    expect(Object.keys(officeQueryRoute).filter((name) => /^[A-Z]+$/.test(name))).toEqual(["POST"]);
    const { access } = await signIn(ownerCookie);
    const count = () => inOrganisation(ORG, { userId: owner.id, email: owner.email }, async (tx) => (await tx.query<{ count: string }>("select (select count(*) from audit_events) + (select count(*) from analytics_dashboards) as count")).rows[0].count);
    const before = await count();
    // Even a request body shaped like a change is only ever read as a question.
    await officeQueryRoute.POST(officePost("/api/office/query", access, { organisationId: ORG, dashboardId: sharedId, tileId: "regions", name: "Renamed", tiles: [], filters: {} }), noContext);
    await officeReportRoute.GET(officeGet(`/api/office/reports/${sharedId}?organisationId=${ORG}`, { bearer: access }), params({ dashboardId: sharedId }));
    expect(await count()).toBe(before);
    const dashboard = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query<{ name: string }>("select name from analytics_dashboards where id = $1", [sharedId]));
    expect(dashboard.rows[0].name).toBe("Web sales for the client");
  });

  it("rotates refresh tokens, ends the sign-in when one is reused, and signs out from the account page", async () => {
    const first = await signIn(clientCookie);
    const next = await token({ grant_type: "refresh_token", refresh_token: first.refresh, client_id: CLIENT_ID, resource: OFFICE_RESOURCE });
    expect(next.status).toBe(200);
    expect((await officeMeRoute.GET(officeGet("/api/office/me", { bearer: next.body.access_token as string }), noContext)).status).toBe(200);
    // The old refresh token again: someone has a copy, so this sign-in ends.
    expect((await token({ grant_type: "refresh_token", refresh_token: first.refresh, client_id: CLIENT_ID })).body.error).toBe("invalid_grant");
    expect((await officeMeRoute.GET(officeGet("/api/office/me", { bearer: next.body.access_token as string }), noContext)).status).toBe(401);

    const second = await signIn(clientCookie);
    const listed = await read(await connectedAppsRoute.GET(apiRequest("/api/auth/connected-apps", { cookie: clientCookie }), noContext));
    const working = listed.body.connections.find((connection: { revokedAt: string | null }) => connection.revokedAt === null);
    const ended = await read(await connectedAppsRoute.DELETE(apiRequest("/api/auth/connected-apps", { method: "DELETE", cookie: clientCookie, body: { id: working.id } }), noContext));
    expect(ended.body.connection.revokedAt).not.toBeNull();
    expect((await officeMeRoute.GET(officeGet("/api/office/me", { bearer: second.access }), noContext)).status).toBe(401);
    // Someone else's sign-in can't be ended from your account.
    const third = await signIn(clientCookie);
    const theirs = (await coreQuery<{ id: string }>("select id::text from ai_access_tokens where user_id = $1 and kind = 'office' and revoked_at is null", [client.id])).rows[0].id;
    expect((await connectedAppsRoute.DELETE(apiRequest("/api/auth/connected-apps", { method: "DELETE", cookie: ownerCookie, body: { id: theirs } }), noContext)).status).toBe(404);
    expect((await officeMeRoute.GET(officeGet("/api/office/me", { bearer: third.access }), noContext)).status).toBe(200);
  });

  it("an add-in code swapped while the person's apps are being revoked never leaves a working sign-in (decision 853)", async () => {
    const held = gate();
    setCodeExchangePauseForTests(held.pause);
    try {
      const signing = signIn(clientCookie);
      await held.reached;
      const revoking = withCoreTransaction((tx) => revokeUserAiKeys(tx, client.id));
      expect(await stillWaiting(revoking)).toBe(true);
      held.open();
      const signedIn = await signing;
      await revoking;
      expect((await officeMeRoute.GET(officeGet("/api/office/me", { bearer: signedIn.access }), noContext)).status).toBe(401);
      expect((await token({ grant_type: "refresh_token", refresh_token: signedIn.refresh, client_id: CLIENT_ID, resource: OFFICE_RESOURCE })).body.error).toBe("invalid_grant");
    } finally {
      setCodeExchangePauseForTests(null);
    }
  });

  it("stops every add-in token when remote access is turned off or its address changes", async () => {
    const { access } = await signIn(clientCookie);
    await setRemote(null);
    expect((await officeMeRoute.GET(officeGet("/api/office/me", { bearer: access }), noContext)).status).toBe(401);
    await setRemote("https://other.example.nz");
    expect((await officeMeRoute.GET(officeGet("/api/office/me", { bearer: access }), noContext)).status).toBe(401);
    await setRemote(PUBLIC);
    expect((await officeMeRoute.GET(officeGet("/api/office/me", { bearer: access }), noContext)).status).toBe(200);
  });
});
