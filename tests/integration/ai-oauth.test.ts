import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as authorizationServerRoute from "@/app/.well-known/oauth-authorization-server/route";
import * as resourceRootRoute from "@/app/.well-known/oauth-protected-resource/route";
import * as resourceRoute from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import * as revokeKeyRoute from "@/app/api/ai/tokens/[tokenId]/revoke/route";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as registerRoute from "@/app/api/oauth/register/route";
import * as consentRoute from "@/app/api/oauth/requests/[handle]/route";
import * as revokeRoute from "@/app/api/oauth/revoke/route";
import * as tokenRoute from "@/app/api/oauth/token/route";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import * as authorizeRoute from "@/app/oauth/authorize/route";
import { consentDetails, OAUTH_BROWSER_COOKIE } from "@/lib/ai/oauth/authorize";
import { setClientMetadataFetcherForTests } from "@/lib/ai/oauth/clients";
import { setCodeExchangePauseForTests } from "@/lib/ai/oauth/tokens";
import { revokeUserAiKeys } from "@/lib/ai/tokens";
import { changeOwnPassword } from "@/lib/auth/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { resetTwoStep } from "@/lib/auth/two-step";
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
  TEST_PASSWORD,
  type TestServer,
} from "../helpers/test-server";
import { gate, stillWaiting } from "../helpers/gate";

/*
 * AI apps signing in to Tohyee with OAuth 2.1 (#427, decisions 810-829),
 * end to end against the routes, with made-up apps: no real AI service is
 * ever called.
 */

const ORG = "oauth-books";
const PUBLIC = "https://books.example.nz";
const RESOURCE = `${PUBLIC}/api/mcp`;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const DOC_ID = "https://app.example.com/oauth/client.json";
const noContext = undefined as unknown;

type Json = Record<string, unknown>;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function setRemote(publicUrl: string | null) {
  await withCoreTransaction((client) => writeServerValue(client, "remote_access", { enabled: publicUrl !== null, publicUrl }, "test"));
}

function form(values: Record<string, string>) {
  return new Request("http://tohyee.test/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
}

async function token(values: Record<string, string>) {
  const response = await tokenRoute.POST(form(values), noContext);
  return { status: response.status, body: (await response.json()) as Json, headers: response.headers };
}

async function mcp(accessToken: string | null, method = "tools/list") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await mcpRoute.POST(new Request(RESOURCE, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) }), noContext);
  return { status: response.status, body: (await response.json()) as Json, headers: response.headers };
}

async function register(metadata: Json) {
  const response = await registerRoute.POST(
    new Request("http://tohyee.test/api/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(metadata) }),
    noContext,
  );
  return { status: response.status, body: (await response.json()) as Json };
}

function authorizeUrl(values: Record<string, string | undefined>): string {
  const url = new URL("http://tohyee.test/oauth/authorize");
  for (const [name, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(name, value);
  return url.toString();
}

async function authorize(values: Record<string, string | undefined>, browser?: string) {
  const headers: Record<string, string> = {};
  if (browser) headers.cookie = `${OAUTH_BROWSER_COOKIE}=${browser}`;
  const response = await authorizeRoute.GET(new Request(authorizeUrl(values), { headers }), noContext);
  const location = response.headers.get("location") ?? "";
  const cookie = /tohyee_oauth_browser=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? null;
  const handle = /\/connect\/([A-Za-z0-9_-]{43})$/.exec(location)?.[1] ?? null;
  return { status: response.status, location, cookie, handle };
}

async function decide(handle: string, cookie: string, body: Json, options: { browser?: string | null; origin?: string } = {}) {
  const browser = options.browser === undefined ? null : options.browser;
  const response = await consentRoute.POST(
    apiRequest(`/api/oauth/requests/${handle}`, {
      method: "POST",
      cookie: browser ? `${cookie}; ${OAUTH_BROWSER_COOKIE}=${browser}` : cookie,
      body,
      ...(options.origin ? { origin: options.origin } : {}),
    }),
    params({ handle }),
  );
  return { status: response.status, body: (await response.json()) as Json };
}

describeWithDatabase("AI apps sign in instead of using a key (#427, decisions 810-829)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let clientId: string;

  /** The whole browser flow up to the code: authorise, consent (allow), and the code back at the app. */
  async function connect(options: { cookie?: string; organisationId?: string; accessLevel?: string; confirmFullAccess?: boolean; client?: string; redirect?: string } = {}) {
    const { verifier, challenge } = pkce();
    const redirectUri = options.redirect ?? CLAUDE_CALLBACK;
    const started = await authorize({
      response_type: "code",
      client_id: options.client ?? clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-123",
      resource: RESOURCE,
    });
    expect(started.status).toBe(303);
    expect(started.handle).not.toBeNull();
    const decided = await decide(started.handle!, options.cookie ?? ownerCookie, {
      decision: "allow",
      organisationId: options.organisationId ?? ORG,
      accessLevel: options.accessLevel ?? "read",
      ...(options.confirmFullAccess ? { confirmFullAccess: true } : {}),
    }, { browser: started.cookie });
    expect(decided.status).toBe(200);
    const back = new URL(decided.body.redirectTo as string);
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
    expect(back.searchParams.get("state")).toBe("state-123");
    expect(back.searchParams.get("iss")).toBe(PUBLIC);
    return { code: back.searchParams.get("code")!, verifier, redirectUri, client: options.client ?? clientId };
  }

  async function connectAndExchange(options: Parameters<typeof connect>[0] = {}) {
    const flow = await connect(options);
    const answer = await token({ grant_type: "authorization_code", code: flow.code, client_id: flow.client, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, resource: RESOURCE });
    expect(answer.status).toBe(200);
    return { ...flow, access: answer.body.access_token as string, refresh: answer.body.refresh_token as string };
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("oauth-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    viewer = await createTestUser("oauth-viewer@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    await setRemote(PUBLIC);
    const registered = await register({ client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
    clientId = registered.body.client_id as string;
  });

  afterAll(async () => {
    setClientMetadataFetcherForTests(null);
    await server?.teardown();
  });

  it("publishes protected resource and authorisation server metadata, and points to it from a 401", async () => {
    for (const routeModule of [resourceRoute, resourceRootRoute]) {
      const response = await routeModule.GET();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ resource: RESOURCE, authorization_servers: [PUBLIC], bearer_methods_supported: ["header"], resource_name: "Tohyee" });
    }
    const server = (await (await authorizationServerRoute.GET()).json()) as Json;
    expect(server).toMatchObject({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/oauth/authorize`,
      token_endpoint: `${PUBLIC}/api/oauth/token`,
      registration_endpoint: `${PUBLIC}/api/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
    });

    const anonymous = await mcp(null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/api/mcp"`);
    const wrong = await mcp("tohyee_at_" + "x".repeat(43));
    expect(wrong.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("registers apps (RFC 7591) as public clients and refuses unsafe redirect addresses", async () => {
    const made = await register({ client_name: "Some app", redirect_uris: ["https://app.example.com/cb"], token_endpoint_auth_method: "client_secret_basic" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: ["https://app.example.com/cb"] });
    expect(made.body).not.toHaveProperty("client_secret");
    for (const uris of [["http://evil.example/cb"], ["cursor://x/cb"], ["https://app.example.com/cb#x"], []]) {
      const refused = await register({ client_name: "Bad", redirect_uris: uris });
      expect(refused.status).toBe(400);
      expect(["invalid_redirect_uri", "invalid_client_metadata"]).toContain(refused.body.error);
    }
    expect((await register({ client_name: "No code", redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] })).status).toBe(400);
  });

  it("never sends the browser to an address the app didn't register, and sends other mistakes back to the app with iss", async () => {
    const { challenge } = pkce();
    const base = { response_type: "code", client_id: clientId, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: RESOURCE };
    for (const redirect of ["https://evil.example/cb", `${CLAUDE_CALLBACK}/`, `${CLAUDE_CALLBACK}?x=1`, "https://claude.ai.evil.example/api/mcp/auth_callback", undefined]) {
      const started = await authorize({ ...base, redirect_uri: redirect });
      expect(started.location).toBe(`http://tohyee.test/connect/problem?reason=redirect`);
    }
    expect((await authorize({ ...base, client_id: "tohyee_client_madeup", redirect_uri: CLAUDE_CALLBACK })).location).toBe("http://tohyee.test/connect/problem?reason=unknown_client");

    const back = async (values: Record<string, string | undefined>) => new URL((await authorize({ ...base, redirect_uri: CLAUDE_CALLBACK, ...values })).location);
    const noPkce = await back({ code_challenge: undefined });
    expect(noPkce.origin + noPkce.pathname).toBe(CLAUDE_CALLBACK);
    expect(noPkce.searchParams.get("error")).toBe("invalid_request");
    expect(noPkce.searchParams.get("state")).toBe("s");
    expect(noPkce.searchParams.get("iss")).toBe(PUBLIC);
    expect((await back({ code_challenge_method: "plain" })).searchParams.get("error")).toBe("invalid_request");
    expect((await back({ code_challenge_method: undefined })).searchParams.get("error")).toBe("invalid_request");
    expect((await back({ response_type: "token" })).searchParams.get("error")).toBe("unsupported_response_type");
    expect((await back({ resource: "https://other.example/api/mcp" })).searchParams.get("error")).toBe("invalid_target");
  });

  it("connects through the consent screen, and the connection works like a key", async () => {
    const { verifier, challenge } = pkce();
    const started = await authorize({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "abc", resource: RESOURCE });
    expect(started.location).toBe(`http://tohyee.test/connect/${started.handle}`);
    expect(started.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The consent screen: only for this browser.
    const auth = { sessionId: "x", user: owner };
    const details = await consentDetails(auth, started.handle!, started.cookie);
    expect(details).toMatchObject({ appName: "Claude", redirectHost: "claude.ai", detailsFrom: { kind: "registered" }, loopbackOnly: false });
    expect(details!.organisations).toEqual([{ id: ORG, displayName: expect.any(String), role: "owner", ceiling: "full" }]);
    expect(await consentDetails(auth, started.handle!, randomBytes(32).toString("base64url"))).toBeNull();
    expect(await consentDetails(auth, started.handle!, null)).toBeNull();

    // CSRF: another site, or a browser without the request's cookie, can't answer it.
    expect((await decide(started.handle!, ownerCookie, { decision: "allow", organisationId: ORG }, { browser: started.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await decide(started.handle!, ownerCookie, { decision: "allow", organisationId: ORG })).status).toBe(404);
    // Full access needs the box ticked.
    expect((await decide(started.handle!, ownerCookie, { decision: "allow", organisationId: ORG, accessLevel: "full" }, { browser: started.cookie })).status).toBe(400);

    const allowed = await decide(started.handle!, ownerCookie, { decision: "allow", organisationId: ORG, accessLevel: "draft" }, { browser: started.cookie });
    expect(allowed.status).toBe(200);
    const code = new URL(allowed.body.redirectTo as string).searchParams.get("code")!;
    expect(code).toMatch(/^tohyee_code_/);
    // The request is used up.
    expect((await decide(started.handle!, ownerCookie, { decision: "allow", organisationId: ORG }, { browser: started.cookie })).status).toBe(404);

    const answer = await token({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier, resource: RESOURCE });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    const access = answer.body.access_token as string;
    expect(access).toMatch(/^tohyee_at_/);
    expect(answer.body.refresh_token).toMatch(/^tohyee_rt_/);

    // Only hashes are kept.
    const stored = await coreQuery<{ token_hash: string }>("select token_hash from oauth_tokens");
    expect(stored.rows.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash))).toBe(true);
    expect(JSON.stringify(stored.rows)).not.toContain(access);

    const listed = await mcp(access);
    expect(listed.status).toBe(200);
    const tools = ((listed.body.result as Json).tools as { name: string }[]).map((tool) => tool.name);
    expect(tools).toContain("create_contact");
    expect(tools).not.toContain("approve_invoice");
    expect(tools).not.toContain("search_my_mail");

    // What it does shows as the person via the app (decision 822).
    const made = await mcpRoute.POST(
      new Request(RESOURCE, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_contact", arguments: { name: "Tui Bakery", isCustomer: true, idempotencyKey: "oauth-contact-1" } } }),
      }),
      noContext,
    );
    expect(made.status).toBe(200);
    const via = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) =>
      tx.query<{ actor_email: string; via: string }>("select actor_email, details->>'via' as via from audit_events where event_type = 'contact.created'"),
    );
    expect(via.rows).toEqual([{ actor_email: owner.email, via: 'AI app "Claude"' }]);

    // It's listed on the AI page as a connection, apart from keys.
    const page = (await (await tokensRoute.GET(apiRequest(`/api/ai/tokens?organisationId=${ORG}`, { cookie: ownerCookie }), noContext)).json()) as Json;
    expect(page.signInAddress).toBe(RESOURCE);
    expect(page.keys).toEqual([expect.objectContaining({ kind: "connection", name: "Claude", appHost: "claude.ai", accessLevel: "draft", startsWith: null, expired: false, revokedAt: null })]);
    const audit = await coreQuery<{ event_type: string }>("select event_type from admin_audit_events where event_type like 'ai_connection.%' order by id");
    expect(audit.rows.map((row) => row.event_type)).toEqual(["ai_connection.allowed", "ai_connection.connected"]);

    // Disconnecting stops it straight away.
    const connectionId = ((page.keys as Json[])[0].id) as string;
    const revoked = await revokeKeyRoute.POST(apiRequest(`/api/ai/tokens/${connectionId}/revoke`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ tokenId: connectionId }));
    expect(revoked.status).toBe(200);
    expect((await mcp(access)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: answer.body.refresh_token as string, client_id: clientId })).body.error).toBe("invalid_grant");
  });

  it("refuses a code with the wrong verifier, app, redirect address or resource, and only lets a code be tried once", async () => {
    const tries: Record<string, string>[] = [];
    const flow = await connect();
    const good = { grant_type: "authorization_code", code: flow.code, client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: flow.verifier };
    tries.push({ ...good, code_verifier: pkce().verifier });
    const wrongVerifier = await token(tries[0]);
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.body.error).toBe("invalid_grant");
    // Code injection: the stolen code can't be used even with the right verifier now.
    expect((await token(good)).body.error).toBe("invalid_grant");

    for (const change of <Record<string, string>[]>[{ client_id: "tohyee_client_other" }, { redirect_uri: "https://evil.example/cb" }, { resource: "https://other.example/api/mcp" }]) {
      const next = await connect();
      const refused = await token({ ...good, code: next.code, code_verifier: next.verifier, ...change });
      expect(refused.status).toBe(400);
      expect(["invalid_grant", "invalid_target"]).toContain(refused.body.error);
    }
    expect((await token({ grant_type: "password", username: "x", password: "y" })).body.error).toBe("unsupported_grant_type");
    expect((await token({ grant_type: "authorization_code" })).body.error).toBe("invalid_request");
  });

  it("ends the connection when a used code is replayed", async () => {
    const flow = await connectAndExchange();
    expect((await mcp(flow.access)).status).toBe(200);
    const replay = await token({ grant_type: "authorization_code", code: flow.code, client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: flow.verifier });
    expect(replay.body.error).toBe("invalid_grant");
    expect((await mcp(flow.access)).status).toBe(401);
  });

  it("rotates refresh tokens and ends the connection when an old one comes back", async () => {
    const flow = await connectAndExchange();
    const first = await token({ grant_type: "refresh_token", refresh_token: flow.refresh, client_id: clientId, resource: RESOURCE });
    expect(first.status).toBe(200);
    const second = first.body.refresh_token as string;
    expect(second).not.toBe(flow.refresh);
    expect((await mcp(first.body.access_token as string)).status).toBe(200);

    // A different app can't use it.
    const other = await connectAndExchange();
    expect((await token({ grant_type: "refresh_token", refresh_token: other.refresh, client_id: "tohyee_client_other" })).body.error).toBe("invalid_grant");

    // The old refresh token again: someone has a copy, so the whole connection ends.
    const reused = await token({ grant_type: "refresh_token", refresh_token: flow.refresh, client_id: clientId });
    expect(reused.body.error).toBe("invalid_grant");
    expect((await mcp(first.body.access_token as string)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: second, client_id: clientId })).body.error).toBe("invalid_grant");
    const ended = await coreQuery<{ event_type: string }>("select event_type from admin_audit_events where event_type = 'ai_connection.ended_reused'");
    expect(ended.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("binds tokens to the MCP address: a changed remote address or remote access off stops them", async () => {
    const flow = await connectAndExchange();
    expect((await mcp(flow.access)).status).toBe(200);
    await setRemote("https://moved.example.nz");
    expect((await mcp(flow.access)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: flow.refresh, client_id: clientId })).body.error).toBe("invalid_grant");
    await setRemote(null);
    expect((await resourceRoute.GET()).status).toBe(404);
    expect((await authorize({ client_id: clientId })).location).toBe("http://tohyee.test/connect/problem?reason=off");
    const anonymous = await mcp(null);
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer realm="tohyee"');
    await setRemote(PUBLIC);
  });

  it("caps the level by role, and gives Full access only to Owners who tick the box", async () => {
    // A viewer asking for Full access is refused; Make drafts is capped to Look only when used.
    const { challenge } = pkce();
    const started = await authorize({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE });
    expect((await decide(started.handle!, viewerCookie, { decision: "allow", organisationId: ORG, accessLevel: "full", confirmFullAccess: true }, { browser: started.cookie })).status).toBe(403);
    const capped = await connectAndExchange({ cookie: viewerCookie, accessLevel: "draft" });
    const tools = (((await mcp(capped.access)).body.result as Json).tools as { name: string }[]).map((tool) => tool.name);
    expect(tools).not.toContain("create_contact");

    const full = await connectAndExchange({ accessLevel: "full", confirmFullAccess: true });
    const fullTools = (((await mcp(full.access)).body.result as Json).tools as { name: string }[]).map((tool) => tool.name);
    expect(fullTools).toContain("match_bank_line");

    // Someone who isn't a member can't choose the organisation.
    const outsider = await createTestUser("oauth-outsider@example.com");
    const again = await authorize({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE });
    expect((await decide(again.handle!, await sessionCookieFor(outsider), { decision: "allow", organisationId: ORG }, { browser: again.cookie })).status).toBe(404);
  });

  it("sends a refusal back to the app as access_denied", async () => {
    const { challenge } = pkce();
    const started = await authorize({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "no" });
    const refused = await decide(started.handle!, ownerCookie, { decision: "deny" }, { browser: started.cookie });
    const back = new URL(refused.body.redirectTo as string);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("no");
    expect(back.searchParams.get("iss")).toBe(PUBLIC);
    expect(back.searchParams.has("code")).toBe(false);
  });

  it("ends connections, and codes not yet used, when the person is removed or their password or two-step is reset", async () => {
    const person = await createTestUser("oauth-person@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, person.id]);
    const as = async () => connectAndExchange({ cookie: await sessionCookieFor(person) });

    const first = await as();
    const pending = await connect({ cookie: await sessionCookieFor(person) });
    await changeOwnPassword(person.id, "0".repeat(64), { currentPassword: TEST_PASSWORD, newPassword: "a-brand-new-password-123" });
    expect((await mcp(first.access)).status).toBe(401);
    expect((await token({ grant_type: "authorization_code", code: pending.code, client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: pending.verifier })).body.error).toBe("invalid_grant");

    const second = await as();
    await withCoreTransaction((client) => resetTwoStep(client, person.id, { userId: owner.id, email: owner.email }, "admin"));
    expect((await mcp(second.access)).status).toBe(401);

    const third = await as();
    await coreQuery("update users set is_active = false where id = $1", [person.id]);
    expect((await mcp(third.access)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: third.refresh, client_id: clientId })).body.error).toBe("invalid_grant");
    await coreQuery("update users set is_active = true where id = $1", [person.id]);

    const fourth = await as();
    const removed = await memberRoute.DELETE(
      apiRequest(`/api/organisations/${ORG}/members/${person.id}`, { method: "DELETE", cookie: ownerCookie }),
      params({ organisationId: ORG, userId: person.id }),
    );
    expect(removed.status).toBe(200);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, person.id]);
    expect((await mcp(fourth.access)).status).toBe(401);
  });

  it("a code swapped at the same moment as a password or two-step reset, or removal, never leaves a working connection (decision 853)", async () => {
    const person = await createTestUser("oauth-race@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, person.id]);
    const swap = (flow: Awaited<ReturnType<typeof connect>>) =>
      token({ grant_type: "authorization_code", code: flow.code, client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: flow.verifier, resource: RESOURCE });

    // The exchange has claimed its code when the reset starts: the reset waits, then ends the new connection.
    for (const reset of [
      () => changeOwnPassword(person.id, "0".repeat(64), { currentPassword: TEST_PASSWORD, newPassword: "another-new-password-456" }),
      () => withCoreTransaction((client) => resetTwoStep(client, person.id, { userId: owner.id, email: owner.email }, "admin")),
    ]) {
      const flow = await connect({ cookie: await sessionCookieFor(person) });
      const held = gate();
      setCodeExchangePauseForTests(held.pause);
      try {
        const exchanging = swap(flow);
        await held.reached;
        const resetting = reset();
        expect(await stillWaiting(resetting)).toBe(true);
        held.open();
        const answer = await exchanging;
        await resetting;
        expect(answer.status).toBe(200);
        expect((await mcp(answer.body.access_token as string)).status).toBe(401);
        expect((await token({ grant_type: "refresh_token", refresh_token: answer.body.refresh_token as string, client_id: clientId })).body.error).toBe("invalid_grant");
      } finally {
        setCodeExchangePauseForTests(null);
      }
    }

    // The revoke has started when the app swaps its code: the exchange waits, then the code is refused.
    const flow = await connect({ cookie: await sessionCookieFor(person) });
    const revoking = gate();
    const revoke = withCoreTransaction(async (client) => {
      await revokeUserAiKeys(client, person.id);
      await revoking.pause();
    });
    await revoking.reached;
    const exchanging = swap(flow);
    expect(await stillWaiting(exchanging)).toBe(true);
    revoking.open();
    await revoke;
    expect((await exchanging).body.error).toBe("invalid_grant");

    // Removed from the organisation while a code is being swapped: the removal waits, then ends it.
    const last = await connect({ cookie: await sessionCookieFor(person) });
    const held = gate();
    setCodeExchangePauseForTests(held.pause);
    try {
      const exchanging2 = swap(last);
      await held.reached;
      const removing = memberRoute.DELETE(apiRequest(`/api/organisations/${ORG}/members/${person.id}`, { method: "DELETE", cookie: ownerCookie }), params({ organisationId: ORG, userId: person.id }));
      expect(await stillWaiting(removing)).toBe(true);
      held.open();
      const answer = await exchanging2;
      expect((await removing).status).toBe(200);
      expect(answer.status).toBe(200);
      expect((await mcp(answer.body.access_token as string)).status).toBe(401);
    } finally {
      setCodeExchangePauseForTests(null);
    }
  });

  it("an app can disconnect itself (RFC 7009)", async () => {
    const flow = await connectAndExchange();
    const response = await revokeRoute.POST(form({ token: flow.refresh, client_id: clientId }), noContext);
    expect(response.status).toBe(200);
    expect((await mcp(flow.access)).status).toBe(401);
    expect((await revokeRoute.POST(form({ token: "made-up" }), noContext)).status).toBe(200);
  });

  it("reads a client ID metadata document from the app's own address, and checks it", async () => {
    const documents: Record<string, { status?: number; body: unknown }> = {
      [DOC_ID]: { body: { client_id: DOC_ID, client_name: "Example‮ AI", redirect_uris: ["https://app.example.com/callback"] } },
      "https://app.example.com/oauth/wrong.json": { body: { client_id: DOC_ID, client_name: "Wrong", redirect_uris: ["https://app.example.com/callback"] } },
      "https://app.example.com/oauth/secret.json": { body: { client_id: "https://app.example.com/oauth/secret.json", client_name: "S", client_secret: "x", redirect_uris: ["https://app.example.com/callback"] } },
      "https://local.example.com/oauth/loop.json": { body: { client_id: "https://local.example.com/oauth/loop.json", client_name: "Local tool", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] } },
    };
    const fetched: string[] = [];
    setClientMetadataFetcherForTests(async (url) => {
      fetched.push(url);
      const doc = documents[url];
      return new Response(doc ? JSON.stringify(doc.body) : "nope", { status: doc ? (doc.status ?? 200) : 404, headers: { "cache-control": "max-age=600" } });
    });

    const flow = await connect({ client: DOC_ID, redirect: "https://app.example.com/callback" });
    const answer = await token({ grant_type: "authorization_code", code: flow.code, client_id: DOC_ID, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, resource: RESOURCE });
    expect(answer.status).toBe(200);
    // Cached: read once for the authorisation.
    expect(fetched.filter((url) => url === DOC_ID)).toHaveLength(1);
    const names = await coreQuery<{ name: string }>("select name from ai_access_tokens where oauth_client_id = $1", [DOC_ID]);
    expect(names.rows).toEqual([{ name: "Example AI" }]);

    const { challenge } = pkce();
    const base = { response_type: "code", code_challenge: challenge, code_challenge_method: "S256", redirect_uri: "https://app.example.com/callback" };
    for (const bad of ["https://app.example.com/oauth/wrong.json", "https://app.example.com/oauth/secret.json", "https://app.example.com/oauth/missing.json"]) {
      expect((await authorize({ ...base, client_id: bad })).location).toBe("http://tohyee.test/connect/problem?reason=client_details");
    }
    // Only loopback redirects: the consent screen warns.
    const loop = await authorize({ ...base, client_id: "https://local.example.com/oauth/loop.json", redirect_uri: "http://localhost:51234/callback" });
    expect(loop.handle).not.toBeNull();
    const details = await consentDetails({ sessionId: "x", user: owner }, loop.handle!, loop.cookie);
    expect(details).toMatchObject({ appName: "Local tool", redirectHost: "localhost:51234", loopbackOnly: true, detailsFrom: { kind: "metadata_document", host: "local.example.com" } });
  });

  it("keeps keys working beside connections", async () => {
    const made = await tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "Desktop" } }), noContext);
    const key = ((await made.json()) as Json).token as string;
    expect((await mcp(key, "ping")).status).toBe(200);
  });
});
