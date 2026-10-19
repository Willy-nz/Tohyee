import { withOrganisation } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { organisationFromState } from "@/lib/crm/mail/service";
import { claimFarmMailState, fetchFarmMailConnection, saveFarmMailbox } from "@/lib/farming/calendar";

/**
 * Where Google or Microsoft sends the browser back after signing in (FC1):
 * checks the one-time state against the signed-in member, exchanges the
 * code outside any database transaction, stores the mailbox and goes back
 * to the farm calendar.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = await requestOrigin(request);
  const back = (query: Record<string, string>) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/operations/farming/calendar?${new URLSearchParams(query)}` } });
  try {
    const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const organisationId = organisationFromState(state);
    const claimed = await withOrganisation(request, organisationId, "viewer", (tx) => claimFarmMailState(tx, state!));
    if (providerError) return back({ error: `Signing in didn't finish: ${providerError}` });
    const code = url.searchParams.get("code");
    if (!code) return back({ error: "Signing in didn't return a code. Try connecting again." });
    const connection = await fetchFarmMailConnection(claimed, code, origin);
    const mailbox = await withOrganisation(request, organisationId, "viewer", (tx) => saveFarmMailbox(tx, claimed, connection));
    return back({ connected: mailbox.email });
  } catch (error) {
    return back({ error: error instanceof Error ? error.message : "Connecting didn't work. Try again." });
  }
}
