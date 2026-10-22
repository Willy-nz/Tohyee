import { writeAdminAuditEvent } from "@/lib/audit";
import { type AiAccessLevel, isAiAccessLevel, roleCeiling } from "@/lib/ai/access-levels";
import { ClientProblem, type OAuthClient, resolveClient } from "@/lib/ai/oauth/clients";
import { oauthAddresses } from "@/lib/ai/oauth/config";
import {
  AUTHORIZATION_CODE_SECONDS,
  AUTHORIZATION_REQUEST_SECONDS,
  CODE_PREFIX,
  isLoopbackRedirect,
  MAX_ACTIVE_CONNECTIONS,
  randomToken,
  redirectHost,
  redirectUriMatches,
  redirectWith,
  resourceIsOurs,
  sha256Hex,
  validCodeChallenge,
} from "@/lib/ai/oauth/format";
import type { ConnectProblem } from "@/lib/ai/oauth/messages";
import type { AuthContext } from "@/lib/auth/guard";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { isSecureRequest, readCookie } from "@/lib/auth/sessions";
import { coreQuery, type DbClient, withCoreTransaction } from "@/lib/db/transactions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { getMembership, listMembershipsForUser } from "@/lib/organisations/registry";

/*
 * The browser side of an AI app signing in (decisions 813, 814, 818, 819):
 *
 * 1. The app sends the person's browser to /oauth/authorize. Tohyee checks
 *    the app and its redirect address first; if either is wrong it shows its
 *    own page and never sends the browser anywhere (no open redirect). Then
 *    the rest: response_type=code, a PKCE S256 challenge, and a resource
 *    that is Tohyee's MCP address. Mistakes there go back to the app as
 *    OAuth errors, with state and iss.
 * 2. The request is kept (hashed handle, 10 minutes) and tied to the browser
 *    by a random HttpOnly cookie, and the browser goes to /connect/<handle>,
 *    through Tohyee's normal sign-in if it isn't signed in.
 * 3. The consent screen shows the app's name, where it sends you back to,
 *    and lets the person choose the organisation and level (the role
 *    ceiling, Full access for Owners only with the warning ticked). Allowing
 *    or refusing is a same-origin POST that also needs the browser cookie.
 * 4. Allowing makes a one-time code (5 minutes) that remembers what was
 *    chosen; the browser goes back to the app with it.
 */

export const OAUTH_BROWSER_COOKIE = "tohyee_oauth_browser";
const BROWSER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isConnectHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE_PATTERN.test(value);
}

function browserCookieHeader(request: Request, value: string): string {
  const parts = [`${OAUTH_BROWSER_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${AUTHORIZATION_REQUEST_SECONDS}`];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

export type StartResult =
  | { kind: "problem"; problem: ConnectProblem }
  | { kind: "redirect"; location: string }
  | { kind: "consent"; location: string; cookie: string };

/** Step 1 and 2: checks an authorisation request and keeps it for the consent screen. */
export async function startAuthorization(request: Request): Promise<StartResult> {
  const addresses = await oauthAddresses();
  if (!addresses) return { kind: "problem", problem: "off" };
  const query = new URL(request.url).searchParams;
  // A parameter given twice is refused (RFC 6749 section 3.1).
  for (const name of ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "resource"]) {
    if (query.getAll(name).length > 1) return { kind: "problem", problem: "bad_request" };
  }
  let client: OAuthClient;
  try {
    client = await resolveClient(query.get("client_id"));
  } catch (error) {
    if (error instanceof ClientProblem) return { kind: "problem", problem: query.get("client_id")?.startsWith("https://") ? "client_details" : "unknown_client" };
    throw error;
  }
  const redirectUri = query.get("redirect_uri") ?? "";
  if (!redirectUriMatches(redirectUri, client.redirectUris)) return { kind: "problem", problem: "redirect" };

  // From here on, mistakes go back to the app.
  const state = query.get("state");
  const back = (error: string, description: string): StartResult => ({
    kind: "redirect",
    location: redirectWith(redirectUri, { error, error_description: description, state, iss: addresses.issuer }),
  });
  if (state !== null && state.length > 500) return back("invalid_request", "state is longer than 500 characters.");
  if (query.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  if (query.get("code_challenge_method") !== "S256") return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  const challenge = query.get("code_challenge");
  if (!validCodeChallenge(challenge)) return back("invalid_request", "A PKCE code_challenge is required.");
  const resource = query.get("resource");
  if (resource !== null && !resourceIsOurs(resource, addresses.resource)) return back("invalid_target", `Tokens here are only for ${addresses.resource}.`);

  const existing = readCookie(request, OAUTH_BROWSER_COOKIE);
  const browser = existing && BROWSER_PATTERN.test(existing) ? existing : randomToken();
  const handle = randomToken();
  await coreQuery("delete from oauth_authorization_requests where created_at < now() - interval '1 day'");
  await coreQuery(
    `insert into oauth_authorization_requests (handle_hash, browser_hash, client_id, client_name, redirect_uri, state, code_challenge, resource)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [sha256Hex(handle), sha256Hex(browser), client.clientId, client.name, redirectUri, state, challenge, addresses.resource],
  );
  return { kind: "consent", location: `/connect/${handle}`, cookie: browserCookieHeader(request, browser) };
}

type RequestRow = {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  resource: string;
  source: OAuthClient["source"] | null;
  redirect_uris: string[] | null;
};

/** A waiting request for this browser, or null when it's unknown, used, too old or from another browser. */
async function findRequest(handle: string, browserCookie: string | null): Promise<RequestRow | null> {
  if (!isConnectHandle(handle) || !browserCookie || !BROWSER_PATTERN.test(browserCookie)) return null;
  const found = await coreQuery<RequestRow>(
    `select r.client_id, r.client_name, r.redirect_uri, r.state, r.code_challenge, r.resource, c.source, c.redirect_uris
       from oauth_authorization_requests r
       left join oauth_clients c on c.client_id = r.client_id
      where r.handle_hash = $1 and r.browser_hash = $2 and r.used_at is null
        and r.created_at > now() - make_interval(secs => $3)`,
    [sha256Hex(handle), sha256Hex(browserCookie), AUTHORIZATION_REQUEST_SECONDS],
  );
  return found.rows[0] ?? null;
}

/** An organisation the person could connect, with the most a connection can do there. */
export type ConsentOrganisation = { id: string; displayName: string; role: Role; ceiling: AiAccessLevel };

/** What the consent screen shows. Only things the app chose are its name and redirect address, shown as such. */
export type ConsentDetails = {
  appName: string;
  /** e.g. "claude.ai". */
  redirectHost: string;
  redirectUri: string;
  /** Where the app's details came from: its own address (a metadata document), or it registered itself. */
  detailsFrom: { kind: "metadata_document"; host: string } | { kind: "registered" };
  /** The app can only send people back to this computer. */
  loopbackOnly: boolean;
  organisations: ConsentOrganisation[];
  signedInAs: string;
};

export async function consentDetails(auth: AuthContext, handle: string, browserCookie: string | null): Promise<ConsentDetails | null> {
  const row = await findRequest(handle, browserCookie);
  if (!row) return null;
  const memberships = await listMembershipsForUser(auth.user.id);
  const organisations = memberships
    .filter((membership) => roleAtLeast(membership.role, "viewer") && membership.organisation.provisioningStatus === "ready" && membership.organisation.migrationStatus === "current")
    .map((membership) => ({ id: membership.organisation.id, displayName: membership.organisation.displayName, role: membership.role, ceiling: roleCeiling(membership.role) }));
  const registered = row.redirect_uris ?? [row.redirect_uri];
  return {
    appName: row.client_name,
    redirectHost: redirectHost(row.redirect_uri),
    redirectUri: row.redirect_uri,
    detailsFrom: row.source === "metadata_document" ? { kind: "metadata_document", host: redirectHost(row.client_id) } : { kind: "registered" },
    loopbackOnly: registered.every(isLoopbackRedirect),
    organisations,
    signedInAs: auth.user.email,
  };
}

/** Working (not disconnected, not expired) connections a person has in an organisation. */
export async function activeConnectionCount(client: DbClient | null, organisationId: string, userId: string): Promise<number> {
  const sql = `
select count(*)::text as count from ai_access_tokens t
      where t.organisation_id = $1 and t.user_id = $2 and t.kind = 'connection' and t.revoked_at is null
        and exists (select 1 from oauth_tokens o where o.connection_id = t.id and o.expires_at > now() and (o.kind = 'access' or o.used_at is null))`;
  const result = client ? await client.query<{ count: string }>(sql, [organisationId, userId]) : await coreQuery<{ count: string }>(sql, [organisationId, userId]);
  return Number(result.rows[0].count);
}

/**
 * Step 3 and 4: the person allows or refuses. Returns where to send the
 * browser: back to the app with a code, or with error=access_denied.
 */
export async function decideConsent(
  auth: AuthContext,
  request: Request,
  handle: string,
  body: { decision?: unknown; organisationId?: unknown; accessLevel?: unknown; confirmFullAccess?: unknown },
): Promise<{ redirectTo: string }> {
  const addresses = await oauthAddresses();
  const browserCookie = readCookie(request, OAUTH_BROWSER_COOKIE);
  const row = await findRequest(handle, browserCookie);
  if (!row || !addresses) throw new NotFoundError("This connection request has expired, was already used, or was started in another browser. Start connecting again from your AI app.");
  const backWith = (values: Record<string, string | null>) => redirectWith(row.redirect_uri, { ...values, state: row.state, iss: addresses.issuer });

  if (body.decision === "deny") {
    if (!(await claimRequest(handle))) throw new NotFoundError("This connection request was already used.");
    return { redirectTo: backWith({ error: "access_denied", error_description: "The person didn't allow the connection." }) };
  }
  if (body.decision !== "allow") throw new ValidationError("Choose Allow or Don't allow.");

  const level = await checkChoice(auth, body);
  if (!(await claimRequest(handle))) throw new NotFoundError("This connection request was already used.");
  const code = randomToken(CODE_PREFIX);
  await withCoreTransaction(async (client) => {
    await client.query(
      `insert into oauth_authorization_codes (code_hash, user_id, organisation_id, client_id, client_name, redirect_uri, code_challenge, resource, access_level, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))`,
      [sha256Hex(code), auth.user.id, level.organisationId, row.client_id, row.client_name, row.redirect_uri, row.code_challenge, row.resource, level.accessLevel, AUTHORIZATION_CODE_SECONDS],
    );
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "ai_connection.allowed",
      entityType: "organisation",
      entityId: level.organisationId,
      details: { app: row.client_name, redirectHost: redirectHost(row.redirect_uri), accessLevel: level.accessLevel },
    });
  });
  return { redirectTo: backWith({ code }) };
}

async function claimRequest(handle: string): Promise<boolean> {
  const claimed = await coreQuery("update oauth_authorization_requests set used_at = now() where handle_hash = $1 and used_at is null", [sha256Hex(handle)]);
  return claimed.rowCount === 1;
}

/** The organisation and level chosen, checked as making a key is (decisions 341, 346, 488). */
async function checkChoice(
  auth: AuthContext,
  body: { organisationId?: unknown; accessLevel?: unknown; confirmFullAccess?: unknown },
): Promise<{ organisationId: string; accessLevel: AiAccessLevel }> {
  const organisationId = typeof body.organisationId === "string" ? body.organisationId : "";
  const membership = organisationId ? await getMembership(organisationId, auth.user.id) : null;
  if (!membership || !membership.organisation.isActive || !roleAtLeast(membership.role, "viewer")) throw new NotFoundError("Choose one of your organisations.");
  const accessLevel = body.accessLevel ?? "read";
  if (!isAiAccessLevel(accessLevel)) throw new ValidationError("Choose what the app may do.");
  if (accessLevel === "full") {
    if (!roleAtLeast(membership.role, "owner")) throw new ForbiddenError("Only an Owner can give an AI app Full access.");
    if (body.confirmFullAccess !== true) throw new ValidationError("Read the warning about Full access and tick the box to confirm.");
  }
  if ((await activeConnectionCount(null, organisationId, auth.user.id)) >= MAX_ACTIVE_CONNECTIONS) {
    throw new ConflictError(`You already have ${MAX_ACTIVE_CONNECTIONS} AI apps connected to this organisation. Disconnect one on the AI page first.`);
  }
  return { organisationId, accessLevel };
}
