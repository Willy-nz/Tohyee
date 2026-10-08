import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { getStripeStatus, syncStripe } from "@/lib/bank/stripe/service";

/** Sync now: every linked Stripe currency. Bookkeepers. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const result = await syncStripe(organisation, actor, { connectionId: body.connectionId });
  const stripe = await withOrganisation(request, body.organisationId, "viewer", (tx) => getStripeStatus(tx));
  return json({ result, stripe });
});
