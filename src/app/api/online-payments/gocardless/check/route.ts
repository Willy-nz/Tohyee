import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { checkGoCardless, getGoCardlessStatus } from "@/lib/payments/gocardless";

/** POST: checks GoCardless now (authorities, collections, payouts), outside a long transaction. Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const check = await checkGoCardless(organisation, actor);
  const gocardless = await withOrganisation(request, body.organisationId, "viewer", (tx) => getGoCardlessStatus(tx));
  return json({ check, gocardless });
});
