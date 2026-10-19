import { withOrganisation } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { organisationFromState } from "@/lib/crm/mail/service";
import { claimFarmMailState, fetchFarmMailConnection, saveFarmMailbox } from "@/lib/farming/calendar";
import { savePrivateMailbox } from "@/lib/private-mail/store";

/**
 * Where Google or Microsoft sends the browser back after signing in (FC1):
 * checks the one-time state against the signed-in member, exchanges the
 * code outside any database transaction, stores the mailbox and goes back
 * to the farm calendar, or to My mail when it was connected there (#250,
 * decision 610: one connection, and one sign-in address for both).
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = await requestOrigin(request);
  let page = "/operations/farming/calendar";
  const back = (query: Record<string, string>) => new Response(null, { status: 303, headers: { Location: `${origin}${page}?${new URLSearchParams(query)}` } });
  try {
    const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const organisationId = organisationFromState(state);
    const claimed = await withOrganisation(request, organisationId, "sales_rep", (tx) => claimFarmMailState(tx, state!));
    if (claimed.purpose === "private") page = "/operations/my-mail";
    if (providerError) return back({ error: `Signing in didn't finish: ${providerError}` });
    const code = url.searchParams.get("code");
    if (!code) return back({ error: "Signing in didn't return a code. Try connecting again." });
    const connection = await fetchFarmMailConnection(claimed, code, origin);
    if (claimed.purpose === "private") {
      const saved = await withOrganisation(request, organisationId, "sales_rep", (tx) => savePrivateMailbox(tx, claimed, connection));
      // PM2: straight to ticking its folders; nothing is copied until then.
      return back({ connected: saved.email, folders: saved.id });
    }
    const mailbox = await withOrganisation(request, organisationId, "viewer", (tx) => saveFarmMailbox(tx, claimed, connection));
    // FC25: straight to choosing its folders; nothing is read until then.
    return back({ connected: mailbox.email, folders: mailbox.id });
  } catch (error) {
    return back({ error: error instanceof Error ? error.message : "Connecting didn't work. Try again." });
  }
}
