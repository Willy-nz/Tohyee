import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addPayment } from "@/lib/tax/income/service";

/** POST: a payment made to IRD towards an income year, typed in (owners and admins; ITX6, ITX9). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    addPayment(tx, { idempotencyKey: body.idempotencyKey, incomeYear: body.incomeYear, paidOn: body.paidOn, amount: body.amount, note: body.note }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
