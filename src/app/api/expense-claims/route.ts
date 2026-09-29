import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createExpenseClaim, listExpenseClaims } from "@/lib/expense-claims/service";

/** GET: expense claims, newest first; `status` (draft, submitted, approved, voided, awaiting_payment) and `mine=true` filter them. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const claims = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listExpenseClaims(tx, { status: params.get("status"), mine: params.get("mine") }),
  );
  return json({ claims });
});

/** Starts a draft claim for the signed-in person, with `receipts` (EC1). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createExpenseClaim(tx, { source: body.source, idempotencyKey: body.idempotencyKey, description: body.description, receipts: body.receipts }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
