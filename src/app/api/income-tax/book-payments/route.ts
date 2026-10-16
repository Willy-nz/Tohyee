import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { bookPayments } from "@/lib/tax/income/book-payments";

/** GET: payments to IRD in the books not counted yet, and possible refunds (owners and admins; ITX37, ITX40). */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => bookPayments(tx));
  return json(result);
});
