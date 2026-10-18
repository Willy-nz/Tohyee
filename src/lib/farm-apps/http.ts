import { readJson, route } from "@/lib/api/http";
import { MCP_FAILED_KEYS_PER_MINUTE, MCP_REQUESTS_PER_MINUTE, RequestLimiter } from "@/lib/ai/limits";
import { sessionMetaFrom } from "@/lib/auth/sessions";
import { type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { loadMemberNames } from "@/lib/people/names";
import { authenticateFarmAppKey, bearerFarmAppKey, type FarmAppIdentity } from "@/lib/farm-apps/keys";
import { FARM_APP_SCOPE_LABELS, type FarmAppScope } from "@/lib/farm-apps/scopes";

/*
 * The Farming API's plumbing (#249 stage 5; examples FA2, FA3, FA7, decision
 * 561). Only `Authorization: Bearer tohyee_app_…` lets an app in; cookies are
 * never read, so answering any site's browser (CORS) can't expose a signed-in
 * session. Each request runs in the key owner's organisation as them, "via
 * app '<name>'", read-only unless the scope records something.
 */

const limiter = new RequestLimiter(MCP_REQUESTS_PER_MINUTE);
const failedKeys = new RequestLimiter(MCP_FAILED_KEYS_PER_MINUTE);

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

export function apiReply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS_HEADERS, ...headers } });
}

/** Browsers ask first (a CORS preflight) because of the Authorization header. */
export const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

export const farmAppVia = (identity: Pick<FarmAppIdentity, "keyName">) => `app "${identity.keyName}"`;

type Context = { params: Promise<Record<string, string>> };
type Work = (tx: OrgTx, input: { url: URL; body: Record<string, unknown>; params: Record<string, string>; identity: FarmAppIdentity }) => Promise<unknown>;

/** A Farming API endpoint needing `scope` (null: any good key). Recording scopes write; the rest run read-only. */
export function farmAppEndpoint(scope: FarmAppScope | null, work: Work, options: { writes?: boolean; status?: number } = {}) {
  return withCors(route<Context>(async (request, context) => {
    const address = sessionMetaFrom(request).ipAddress;
    if (address && failedKeys.spent(address)) return apiReply({ error: "Too many wrong app keys from this address. Wait a minute and try again.", code: "too_many_failures" }, 429, { "retry-after": "60" });
    const key = bearerFarmAppKey(request.headers.get("authorization"));
    const identity = key ? await authenticateFarmAppKey(key) : null;
    if (!identity) {
      if (address && !failedKeys.take(address)) return apiReply({ error: "Too many wrong app keys from this address. Wait a minute and try again.", code: "too_many_failures" }, 429, { "retry-after": "60" });
      return apiReply({ error: "This needs a Tohyee app key: Authorization: Bearer tohyee_app_… Make one under Farming › Apps.", code: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="tohyee", error="invalid_token"' });
    }
    if (!limiter.take(`app-${identity.keyId}`)) return apiReply({ error: "Too many requests with this key. Wait a minute and try again.", code: "rate_limited" }, 429, { "retry-after": "60" });
    if (scope !== null && !identity.effectiveScopes.includes(scope)) {
      const why = identity.scopes.includes(scope) ? " Its owner's role doesn't allow it now: recording needs the bookkeeper role or higher." : "";
      return apiReply({ error: `This key can't ${FARM_APP_SCOPE_LABELS[scope].toLowerCase()}.${why}`, code: "forbidden_scope", scope }, 403);
    }
    const body = request.method === "POST" ? await readJson(request) : {};
    const params = context?.params ? await context.params : {};
    const organisation = identity.membership.organisation;
    const people = await loadMemberNames(organisation.id);
    const result = await withOrganisationTransaction(
      organisation,
      { userId: identity.user.id, email: identity.user.email, via: farmAppVia(identity) },
      (tx) => work(tx, { url: new URL(request.url), body, params, identity }),
      { people, readOnly: !options.writes },
    );
    return apiReply(result, options.status ?? 200);
  }));
}

/** Errors from `route` come back without CORS headers; add them so a browser app can read the message. */
function withCors(handler: (request: Request, context: Context) => Promise<Response>) {
  return async (request: Request, context: Context) => {
    const response = await handler(request, context);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  };
}
