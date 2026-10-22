import { RequestLimiter } from "@/lib/ai/limits";
import { ClientProblem, registerClient } from "@/lib/ai/oauth/clients";
import { oauthAddresses } from "@/lib/ai/oauth/config";
import { oauthErrorResponse, oauthJson } from "@/lib/ai/oauth/http";
import { readLimitedBytes, route } from "@/lib/api/http";
import { sessionMetaFrom } from "@/lib/auth/sessions";

/**
 * RFC 7591 dynamic client registration for AI apps (#427, decision 812).
 * Open to anyone, as the MCP specification expects: registering gives an app
 * a client_id and nothing else; only the person's consent connects it. At
 * most 10 registrations a minute from one address.
 */
const limiter = new RequestLimiter(10);

export const POST = route(async (request) => {
  if (!(await oauthAddresses())) return oauthErrorResponse("invalid_request", "Remote access is off, so AI apps can't sign in to this Tohyee.", 404);
  const address = sessionMetaFrom(request).ipAddress;
  if (address && !limiter.take(address)) return oauthErrorResponse("invalid_request", "Too many registrations from this address. Wait a minute.", 429);
  let metadata: unknown;
  try {
    metadata = JSON.parse((await readLimitedBytes(request, 16 * 1024)).toString("utf8"));
  } catch {
    return oauthErrorResponse("invalid_client_metadata", "The registration must be a JSON object of at most 16 KB.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return oauthErrorResponse("invalid_client_metadata", "The registration must be a JSON object.");
  try {
    return oauthJson(await registerClient(metadata as Record<string, unknown>), 201);
  } catch (error) {
    if (error instanceof ClientProblem) {
      return oauthErrorResponse(/redirect/i.test(error.message) ? "invalid_redirect_uri" : "invalid_client_metadata", error.message);
    }
    throw error;
  }
});
