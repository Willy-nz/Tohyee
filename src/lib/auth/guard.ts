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

export type AuthContext = {
  sessionId: string;
  user: SessionUser;
};

export async function authenticate(request: Request): Promise<AuthContext> {
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
  const state = await getSessionState(readCookie(request, SESSION_COOKIE));
  if (!state) {
    throw new UnauthorizedError();
  }
  return state;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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
    // Non-browser clients (scripts, curl) don't send Origin.
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

export function requireServerAdmin(auth: AuthContext): void {
  if (!auth.user.isServerAdmin) {
    throw new ForbiddenError("Only a server admin can do that.");
  }
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
