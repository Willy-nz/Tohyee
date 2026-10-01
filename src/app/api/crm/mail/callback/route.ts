import { withOrganisation } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { appForProvider, claimState, fetchConnection, organisationFromState, saveConnection } from "@/lib/crm/mail/service";

/**
 * Where Google or Microsoft sends the browser back after signing in (example
 * MAIL2): checks the one-time state against the signed-in user, exchanges
 * the code outside any database transaction, stores the account, and goes
 * back to the CRM's email and calendar page.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = requestOrigin(request);
  const back = (query: Record<string, string>) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/crm/mail?${new URLSearchParams(query)}` } });
  try {
    const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const organisationId = organisationFromState(state);
    const { provider, app } = await withOrganisation(request, organisationId, "bookkeeper", async (tx) => {
      const claimed = await claimState(tx, state!);
      return { provider: claimed, app: await appForProvider(tx, claimed) };
    });
    if (providerError) return back({ error: `Signing in didn't finish: ${providerError}` });
    const code = url.searchParams.get("code");
    if (!code) return back({ error: "Signing in didn't return a code. Try connecting again." });
    const connection = await fetchConnection(provider, app, code, origin);
    const account = await withOrganisation(request, organisationId, "bookkeeper", (tx) => saveConnection(tx, provider, connection));
    return back({ connected: account.email });
  } catch (error) {
    return back({ error: error instanceof Error ? error.message : "Connecting didn't work. Try again." });
  }
}
