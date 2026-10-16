import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { countBookPayment } from "@/lib/tax/income/book-payments";

/** POST: counts a payment from the books towards an income year (owners and admins; ITX39). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) => countBookPayment(tx, { journalLineId: body.journalLineId, incomeYear: body.incomeYear }));
  return json(result);
});
