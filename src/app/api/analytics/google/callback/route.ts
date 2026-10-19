import { withOrganisation } from "@/lib/api/http";
import { claimGaState, fetchGaSignIn, saveGaSignIn } from "@/lib/analytics/google-analytics";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { organisationFromState } from "@/lib/crm/mail/service";

/**
 * Where Google sends the browser back after signing in (GA1): checks the
 * one-time state against the signed-in admin, exchanges the code outside
 * any database transaction, stores the sign-in and goes back to Data
 * sources to choose the property.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = await requestOrigin(request);
  const back = (query: Record<string, string>) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/analytics/sources?${new URLSearchParams(query)}` } });
  try {
    const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const organisationId = organisationFromState(state);
    const app = await withOrganisation(request, organisationId, "admin", (tx) => claimGaState(tx, state!));
    if (providerError) return back({ googleAnalytics: "error", message: `Signing in didn't finish: ${providerError}` });
    const code = url.searchParams.get("code");
    if (!code) return back({ googleAnalytics: "error", message: "Signing in didn't return a code. Try connecting again." });
    const signIn = await fetchGaSignIn(app, code, origin);
    await withOrganisation(request, organisationId, "admin", (tx) => saveGaSignIn(tx, signIn));
    return back({ googleAnalytics: "connected" });
  } catch (error) {
    return back({ googleAnalytics: "error", message: error instanceof Error ? error.message : "Connecting didn't work. Try again." });
  }
}
