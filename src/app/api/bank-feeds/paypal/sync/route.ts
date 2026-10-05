import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { getPayPalStatus, syncPayPal } from "@/lib/bank/paypal/service";

/** Sync now: every linked PayPal currency. Bookkeepers. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const result = await syncPayPal(organisation, actor);
  const paypal = await withOrganisation(request, body.organisationId, "viewer", (tx) => getPayPalStatus(tx));
  return json({ result, paypal });
});
