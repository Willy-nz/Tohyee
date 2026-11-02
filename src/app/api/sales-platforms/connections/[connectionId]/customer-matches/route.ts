import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listCustomerMatches, resolveCustomerMatch } from "@/lib/sales-platforms/customer-matches";

type Context = { params: Promise<{ connectionId: string }> };

/**
 * Customers to check (#539, decisions 1269-1272): store customers not
 * brought in because a contact has the same name. Viewers can read them,
 * as they read the sync log; nothing is fetched from the store.
 */
export const GET = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listCustomerMatches(tx, connectionId));
  return json(result);
});

/**
 * Resolves one (admins): `resolution` "same" with the contact's `contactId`
 * links the customer to it; "different", with an optional `name`, adds a
 * new contact for them.
 */
export const POST = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) => resolveCustomerMatch(tx, connectionId, body));
  return json({ result });
});
