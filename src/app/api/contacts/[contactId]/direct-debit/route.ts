import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getContactDirectDebit, startDirectDebit } from "@/lib/payments/gocardless";

type Context = { params: Promise<{ contactId: string }> };

/** GET: the contact's direct debit authority, if any, and whether one can be asked for. Viewers. */
export const GET = route<Context>(async (request, context) => {
  const { contactId } = await context.params;
  const directDebit = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getContactDirectDebit(tx, contactId));
  return json({ directDebit });
});

/** POST: GC2, asks GoCardless for a page where the customer signs the authority. Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { contactId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ directDebit: await startDirectDebit(organisation, actor, contactId) }, { status: 201 });
});
