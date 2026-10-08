import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getInvoiceDirectDebit, retryDirectDebit, setInvoiceDirectDebitSkip } from "@/lib/payments/gocardless";

type Context = { params: Promise<{ invoiceId: string }> };

/** GET: the invoice's direct debit collections and whether it's marked "don't collect". Viewers. */
export const GET = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const directDebit = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getInvoiceDirectDebit(tx, invoiceId));
  return json({ directDebit });
});

/** PUT `{ skip }`: "Don't collect this one by direct debit". Bookkeepers and above. */
export const PUT = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const body = await readJson(request);
  const directDebit = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => setInvoiceDirectDebitSkip(tx, invoiceId, body.skip));
  return json({ directDebit });
});

/** POST: GC6 "Try again" after a failed collection. Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ directDebit: await retryDirectDebit(organisation, actor, invoiceId) });
});
