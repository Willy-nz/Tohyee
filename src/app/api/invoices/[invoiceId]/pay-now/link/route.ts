import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { ensurePayPalInvoice, getInvoicePayPal } from "@/lib/payments/paypal";
import { ensurePaymentLink, getInvoicePayNow } from "@/lib/payments/stripe";

type Context = { params: Promise<{ invoiceId: string }> };

/**
 * POST `{ provider }` ("stripe", the default, or "paypal"): the invoice's
 * payment link, made if needed (Copy payment link, PN2, PPN2). Bookkeepers
 * and above.
 */
export const POST = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const url = body.provider === "paypal" ? await ensurePayPalInvoice(organisation, actor, invoiceId) : await ensurePaymentLink(organisation, actor, invoiceId);
  const result = await withOrganisation(request, body.organisationId, "viewer", async (tx) => ({
    payNow: await getInvoicePayNow(tx, invoiceId),
    paypal: await getInvoicePayPal(tx, invoiceId),
  }));
  return json({ url, ...result });
});
