import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { ensurePaymentLink, getInvoicePayNow } from "@/lib/payments/stripe";

type Context = { params: Promise<{ invoiceId: string }> };

/** POST: the invoice's payment link, made in Stripe if needed (Copy payment link, PN2, PN5). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const url = await ensurePaymentLink(organisation, actor, invoiceId);
  const payNow = await withOrganisation(request, body.organisationId, "viewer", (tx) => getInvoicePayNow(tx, invoiceId));
  return json({ url, payNow });
});
