import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { checkOnlinePayments, getOnlinePaymentStatus } from "@/lib/payments/stripe";

/** POST: checks Stripe for payments now (Check now, PN3), outside a long transaction. Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const check = await checkOnlinePayments(organisation, actor);
  const payments = await withOrganisation(request, body.organisationId, "viewer", (tx) => getOnlinePaymentStatus(tx));
  return json({ check, payments });
});
