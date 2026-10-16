import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addIcaEntry } from "@/lib/tax/income/ica";

/** POST: types an imputation credit account entry (owners and admins, companies only; ITX26-ITX29). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    addIcaEntry(tx, { idempotencyKey: body.idempotencyKey, entryDate: body.entryDate, kind: body.kind, amount: body.amount, dividendAmount: body.dividendAmount, description: body.description }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
