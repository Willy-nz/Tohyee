import { withOrganisation } from "@/lib/api/http";
import { claimMetaState, fetchMetaSignIn, saveMetaSignIn } from "@/lib/analytics/meta";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { organisationFromState } from "@/lib/crm/mail/service";

/**
 * Where Meta sends the browser back after signing in (META1): checks the
 * one-time state against the signed-in admin, exchanges the code outside
 * any database transaction, stores the sign-in, and goes back to Data
 * sources to choose the Page.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = await requestOrigin(request);
  const back = (status: string, message?: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/analytics/sources?${new URLSearchParams({ meta: status, ...(message ? { message } : {}) })}` } });
  try {
    const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error_reason") ?? url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const organisationId = organisationFromState(state);
    const { app } = await withOrganisation(request, organisationId, "admin", (tx) => claimMetaState(tx, state!));
    if (providerError) return back("error", `Signing in didn't finish: ${providerError.slice(0, 300)}`);
    const code = url.searchParams.get("code");
    if (!code) return back("error", "Signing in didn't return a code. Try connecting again.");
    const signIn = await fetchMetaSignIn(app, code, origin);
    await withOrganisation(request, organisationId, "admin", (tx) => saveMetaSignIn(tx, signIn));
    return back("connected");
  } catch (error) {
    return back("error", error instanceof Error ? error.message : "Connecting didn't work. Try again.");
  }
}
