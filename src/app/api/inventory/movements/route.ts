import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listMovements, postMovement } from "@/lib/inventory/movements";

export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listMovements(tx, { itemCode: params.get("itemCode"), beforeId: params.get("beforeId") }),
  );
  return json(result);
});

/**
 * Posts a stock movement and its journal in one transaction.
 * movementType: receipt | issue | adjustment | customer_return | supplier_return | landed_cost
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    postMovement(tx, body),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
