import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setPaymentAccounts } from "@/lib/tax/income/book-payments";

/** PUT: the accounts IRD income tax payments are coded to (owners and admins; ITX36). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const accounts = await withOrganisation(request, body.organisationId, "admin", (tx) => setPaymentAccounts(tx, { accountIds: body.accountIds }));
  return json({ accounts });
});
