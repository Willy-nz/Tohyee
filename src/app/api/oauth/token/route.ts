import { RequestLimiter } from "@/lib/ai/limits";
import { FormProblem, oauthErrorResponse, oauthJson, readOAuthForm } from "@/lib/ai/oauth/http";
import { exchangeCode, OAuthError, refreshTokens } from "@/lib/ai/oauth/tokens";
import { route } from "@/lib/api/http";
import { sessionMetaFrom } from "@/lib/auth/sessions";

/**
 * The OAuth token endpoint for AI apps (#427, decisions 814, 815): swaps a
 * code (with its PKCE verifier) for tokens, and a refresh token for new
 * ones. Public clients only; no session, no same-origin check (AI services
 * call it from their own servers). Failures from one address are limited
 * like wrong AI keys (decision 343).
 */
const failures = new RequestLimiter(30);

export const POST = route(async (request) => {
  const address = sessionMetaFrom(request).ipAddress;
  if (address && failures.spent(address)) return oauthErrorResponse("invalid_request", "Too many failed requests from this address. Wait a minute.", 429);
  try {
    const form = await readOAuthForm(request);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") return oauthJson(await exchangeCode(form));
    if (grant === "refresh_token") return oauthJson(await refreshTokens(form));
    throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  } catch (error) {
    if (address) failures.take(address);
    if (error instanceof OAuthError) return oauthErrorResponse(error.error, error.description, error.status);
    if (error instanceof FormProblem) return oauthErrorResponse("invalid_request", error.message);
    throw error;
  }
});
