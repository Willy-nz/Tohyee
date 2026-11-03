import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { retryPayouts } from "@/lib/sales-platforms/service";

type Context = { params: Promise<{ connectionId: string }> };

/**
 * "Try again" for payouts not in the accounts (admins, SPC39): reads them
 * from the store again and syncs. The store is called outside any database
 * transaction; a payout already posted is never posted again.
 */
export const POST = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json(await retryPayouts(organisation, connectionId, actor));
});
