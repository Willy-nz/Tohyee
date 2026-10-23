import { RequestLimiter } from "@/lib/ai/limits";
import { oauthAddresses } from "@/lib/ai/oauth/config";
import { bearerToken, wwwAuthenticate } from "@/lib/ai/oauth/format";
import { authenticateOfficeToken, type OfficeIdentity } from "@/lib/ai/oauth/tokens";
import { errorResponse, json, route } from "@/lib/api/http";
import { type AuthContext, requireOrganisationRole } from "@/lib/auth/guard";
import { assertRemoteAllowed } from "@/lib/auth/remote";
import type { Role } from "@/lib/auth/roles";
import { sessionMetaFrom } from "@/lib/auth/sessions";
import { type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { HttpError, UnauthorizedError } from "@/lib/errors";
import type { Membership } from "@/lib/organisations/registry";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { addPersonNames, loadMemberNames } from "@/lib/people/names";

/*
 * The Analytics API for Office (#429, decisions 833, 837): what the
 * PowerPoint add-in on a slide reads. Authenticated only by
 * `Authorization: Bearer <access token>` from the add-in's own sign-in;
 * session cookies are ignored (the slide is framed by Office, where a
 * cookie wouldn't be sent anyway), and so are AI keys and AI apps' MCP
 * tokens. It acts as the signed-in person with their role in the
 * organisation asked for, runs every organisation transaction read-only,
 * and only answers reads: the routes under /api/office only run a report's
 * saved tiles (never a question someone types), so a report viewer gets
 * exactly what the report gives them (decision 697).
 */

const failures = new RequestLimiter(30);
const requests = new RequestLimiter(240);

/** Who the request's token acts as, or an Unauthorized error. Throttled per address for wrong tokens and per sign-in for requests. */
export async function officeIdentity(request: Request): Promise<OfficeIdentity> {
  await assertRemoteAllowed(request.headers);
  const address = sessionMetaFrom(request).ipAddress;
  if (address && failures.spent(address)) throw new HttpError(429, "too_many_requests", "Too many failed sign-ins from this address. Wait a minute.");
  const token = bearerToken(request.headers.get("authorization"));
  const identity = token ? await authenticateOfficeToken(token) : null;
  if (!identity) {
    if (token && address) failures.take(address);
    throw new UnauthorizedError("Sign in to Tohyee in the add-in to see live data.");
  }
  if (!requests.take(identity.connectionId)) throw new HttpError(429, "too_many_requests", "Too many requests from this sign-in. Wait a minute.");
  return identity;
}

/** The person a token acts as, in the shape the Analytics code expects. Never a server admin through the add-in. */
export function officeAuthContext(identity: OfficeIdentity): AuthContext {
  return { sessionId: `office:${identity.connectionId}`, user: { ...identity.user, isServerAdmin: false } };
}

/**
 * `withOrganisation` for the add-in: the same signature, so the Analytics
 * route handlers run unchanged with it (src/lib/analytics/read-routes.ts),
 * but authenticated by the add-in's token and always in a read-only
 * transaction (PostgreSQL refuses any write in it).
 */
export async function withOfficeOrganisation<T>(
  request: Request,
  organisationIdInput: unknown,
  minimumRole: Role,
  work: (tx: OrgTx, context: { auth: AuthContext; membership: Membership }) => Promise<T>,
): Promise<T> {
  const auth = officeAuthContext(await officeIdentity(request));
  const organisationId = parseOrganisationId(organisationIdInput);
  const membership = await requireOrganisationRole(auth, organisationId, minimumRole);
  const people = await loadMemberNames(membership.organisation.id);
  const result = await withOrganisationTransaction(
    membership.organisation,
    { userId: auth.user.id, email: auth.user.email, role: membership.role },
    (tx) => work(tx, { auth, membership }),
    { people, readOnly: true },
  );
  return addPersonNames(result, people);
}

/** The runner both the Analytics routes and the add-in's routes hand to the shared handlers. */
export type OrganisationRunner = typeof withOfficeOrganisation;

/**
 * Wraps an add-in route: errors as JSON like every route, never cached, and
 * a 401 says where to sign in (RFC 9728 `resource_metadata`).
 */
export function officeRoute<Context = unknown>(handler: (request: Request, context: Context) => Promise<Response>) {
  return route<Context>(async (request, context) => {
    let response: Response;
    try {
      response = await handler(request, context);
    } catch (error) {
      response = errorResponse(error);
      if (error instanceof UnauthorizedError) {
        const addresses = await oauthAddresses();
        response.headers.set("www-authenticate", wwwAuthenticate(addresses?.officeResourceMetadataUrl ?? null, request.headers.has("authorization")));
      }
    }
    response.headers.set("cache-control", "no-store");
    return response;
  });
}

export { json };
