import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createBudget, listBudgets } from "@/lib/budgets/service";

/** GET: budgets, the overall budget first; `archived=true` for archived ones (BU1). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const budgets = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listBudgets(tx, { archived: params.get("archived") }));
  return json({ budgets });
});

/** Starts a named budget (`name`, optional `trackingValueId`). Bookkeepers and above (BU1, BU8). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createBudget(tx, { source: body.source, idempotencyKey: body.idempotencyKey, name: body.name, trackingValueId: body.trackingValueId }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
