import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addAdjustment } from "@/lib/tax/income/service";

/** POST: a typed adjustment to taxable income (owners and admins; ITX3). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    addAdjustment(tx, { idempotencyKey: body.idempotencyKey, incomeYear: body.incomeYear, description: body.description, amount: body.amount }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
