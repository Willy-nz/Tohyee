import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { makeStoreItemsNonStock, stockStuck } from "@/lib/sales-platforms/stock-stuck";

/** GET: the store's orders stuck for no stock on hand, and its stock items that could be non-stock (SSD2). Bookkeepers. */
export const GET = route<{ params: Promise<{ connectionId: string }> }>(async (request, context) => {
  const { connectionId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => stockStuck(tx, connectionId));
  return json(result);
});

/** POST: makes those items non-stock and tries the orders again at the next sync (SSD3). Admins. */
export const POST = route<{ params: Promise<{ connectionId: string }> }>(async (request, context) => {
  const { connectionId } = await context.params;
  const organisationId = searchParams(request).get("organisationId");
  const result = await withOrganisation(request, organisationId, "admin", (tx) => makeStoreItemsNonStock(tx, connectionId));
  return json(result);
});
