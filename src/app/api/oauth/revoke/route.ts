import { FormProblem, oauthErrorResponse, readOAuthForm } from "@/lib/ai/oauth/http";
import { revokeToken } from "@/lib/ai/oauth/tokens";
import { route } from "@/lib/api/http";

/** RFC 7009 token revocation (#427): an app disconnecting itself. Always 200, whether or not the token was known. */
export const POST = route(async (request) => {
  try {
    await revokeToken(await readOAuthForm(request));
  } catch (error) {
    if (error instanceof FormProblem) return oauthErrorResponse("invalid_request", error.message);
    throw error;
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
});
