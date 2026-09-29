import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listTransfers, transferStock } from "@/lib/inventory/transfers";

/** GET: transfers between locations, newest first. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listTransfers(tx, { beforeId: params.get("beforeId") }));
  return json(result);
});

/** Moves a quantity of a stock item from one location to another at the first location's average cost, with its journal. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    transferStock(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      transferDate: body.transferDate,
      itemId: body.itemId,
      fromLocationValueId: body.fromLocationValueId,
      toLocationValueId: body.toLocationValueId,
      quantity: body.quantity,
      reference: body.reference,
      description: body.description,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
