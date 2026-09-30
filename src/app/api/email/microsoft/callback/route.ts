import { withOrganisation } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { organisationFromState } from "@/lib/crm/mail/service";
import { claimSendingState, fetchSendingConnection, saveSendingConnection } from "@/lib/email/microsoft";

/**
 * Where Microsoft sends the browser back after an admin signs in to the
 * mailbox documents are sent from: checks the one-time state against the
 * signed-in admin, exchanges the code outside any database transaction,
 * stores the mailbox (tokens encrypted), and goes back to Settings > Email.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = requestOrigin(request);
  const back = (query: Record<string, string>) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/operations/settings/email?${new URLSearchParams(query)}` } });
  try {
    const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const organisationId = organisationFromState(state);
    const app = await withOrganisation(request, organisationId, "admin", (tx) => claimSendingState(tx, state!));
    if (providerError) return back({ error: `Signing in didn't finish: ${providerError}` });
    const code = url.searchParams.get("code");
    if (!code) return back({ error: "Signing in didn't return a code. Try connecting again." });
    const connection = await fetchSendingConnection(app, code, origin);
    const email = await withOrganisation(request, organisationId, "admin", (tx) => saveSendingConnection(tx, connection));
    return back({ connected: email });
  } catch (error) {
    return back({ error: error instanceof Error ? error.message : "Connecting didn't work. Try again." });
  }
}
