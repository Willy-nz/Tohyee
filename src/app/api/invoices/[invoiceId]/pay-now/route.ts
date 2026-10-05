import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getInvoicePayPal } from "@/lib/payments/paypal";
import { getInvoicePayNow, setInvoicePayNow } from "@/lib/payments/stripe";

type Context = { params: Promise<{ invoiceId: string }> };

/** GET: the invoice's Pay now: whether it's offered, its link and its online payments (PN12). Viewers and above. */
export const GET = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => ({
    payNow: await getInvoicePayNow(tx, invoiceId),
    paypal: await getInvoicePayPal(tx, invoiceId),
  }));
  return json(result);
});

/** PUT `{ payNow }`: leaves Pay now off on this invoice, or puts it back (question 5). Bookkeepers and above. */
export const PUT = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) => ({
    payNow: await setInvoicePayNow(tx, invoiceId, { payNow: body.payNow }),
    paypal: await getInvoicePayPal(tx, invoiceId),
  }));
  return json(result);
});
