import { type Role, roleAtLeast } from "@/lib/auth/roles";
import {
  getSessionState,
  getSessionUser,
  readCookie,
  SESSION_COOKIE,
  type SessionState,
  type SessionUser,
} from "@/lib/auth/sessions";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { getMembership, type Membership } from "@/lib/organisations/registry";
import { assertLocalAdminRequest } from "@/lib/server-admin/local";
import { assertRemoteAllowed } from "@/lib/auth/remote";

export type AuthContext = {
  sessionId: string;
  user: SessionUser;
};

export async function authenticate(request: Request): Promise<AuthContext> {
  await assertRemoteAllowed(request.headers);
  const session = await getSessionUser(readCookie(request, SESSION_COOKIE));
  if (!session) {
    throw new UnauthorizedError();
  }
  return session;
}

/**
 * Any session, including one part-way through two-step sign-in. Only the
 * two-step routes (and sign-out) use this; everything else uses authenticate.
 */
export async function authenticateAnyStage(request: Request): Promise<SessionState> {
  await assertRemoteAllowed(request.headers);
  const state = await getSessionState(readCookie(request, SESSION_COOKIE));
  if (!state) {
    throw new UnauthorizedError();
  }
  return state;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a read (GET) may also do the small side effects some reads have,
 * such as making an invoice's payment link before it's printed (decision
 * 568). A browser marks a request another site started (a link, a redirect)
 * as "cross-site" or "same-site"; Tohyee's own pages send "same-origin", and
 * a typed address or bookmark "none". Without the header (scripts, old
 * browsers) it's allowed, as the read itself is. Writes are checked by
 * assertSameOrigin.
 */
export function readMayChangeThings(request: Request): boolean {
  if (!SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

/**
 * Blocks cross-site writes. Session cookies are SameSite=Lax already; this is
 * a second layer that rejects state-changing requests a browser marks as
 * coming from another site.
 */
export function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ForbiddenError("Cross-site request blocked.");
  }
  const origin = request.headers.get("origin");
  if (!origin) {
    // Non-browser clients (scripts, curl) don't send Origin. A browser with a
    // session sends Origin or Sec-Fetch-Site on every write; one sending
    // neither (an old webview, a privacy add-on) can't be told apart from a
    // cross-site form, so it's refused while signed in.
    if (!fetchSite && readCookie(request, SESSION_COOKIE)) {
      throw new ForbiddenError("Cross-site request blocked.");
    }
    return;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ForbiddenError("Cross-site request blocked.");
  }
  const allowed = new Set<string>();
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) allowed.add(forwardedHost.split(",")[0].trim());
  const host = request.headers.get("host");
  if (host) allowed.add(host);
  allowed.add(new URL(request.url).host);
  if (!allowed.has(originHost)) {
    throw new ForbiddenError("Cross-site request blocked.");
  }
}

/**
 * A server admin, on the server computer itself (see
 * src/lib/server-admin/local.ts): server settings can't be changed over the
 * network or through the tunnel.
 */
export function requireServerAdmin(auth: AuthContext, request: Request): void {
  if (!auth.user.isServerAdmin) {
    throw new ForbiddenError("Only a server admin can do that.");
  }
  assertLocalAdminRequest(request.headers);
}

/**
 * The caller must be a member of the organisation with at least `minimum`.
 * Non-members get "not found" so organisation IDs can't be probed.
 */
export async function requireOrganisationRole(
  auth: AuthContext,
  organisationId: string,
  minimum: Role,
): Promise<Membership> {
  const membership = await getMembership(organisationId, auth.user.id);
  if (!membership || !membership.organisation.isActive) {
    throw new NotFoundError("Organisation not found.");
  }
  if (!roleAtLeast(membership.role, minimum)) {
    throw new ForbiddenError(`This needs the ${minimum} role or higher in this organisation.`);
  }
  return membership;
}
