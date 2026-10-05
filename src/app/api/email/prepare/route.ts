import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { prepareDocumentEmail } from "@/lib/email/documents";
import { statementFromParams } from "@/lib/email/params";
import { linkBeforeSending } from "@/lib/payments/stripe";

/**
 * GET ?kind=invoice|credit_note|quote|purchase_order|statement&id=: what the
 * email dialog starts with (the contact's address, the filled-in template,
 * the attachment's name), or why email isn't set up. For a statement, `id`
 * is the customer and statementKind, from, to, asAt and includeSubCustomers
 * describe it. Bookkeepers and above.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  // PN2: an invoice's Pay now link is made before the message is written.
  await linkBeforeSending(request, params.get("organisationId"), params.get("kind"), params.get("id"));
  const prepared = await withOrganisation(request, params.get("organisationId"), "bookkeeper", (tx) =>
    prepareDocumentEmail(tx, { kind: params.get("kind"), id: params.get("id"), statement: statementFromParams(params) }),
  );
  return json({ email: prepared });
});
