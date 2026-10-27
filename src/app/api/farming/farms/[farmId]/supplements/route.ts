import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addSupplement, listSupplements } from "@/lib/farming/pasture";

type Context = { params: Promise<{ farmId: string }> };

/** GET: a page of supplements fed on the farm, newest first (`paddockId`, `from`, `to`, `limit`, `cursor`; `next` is the next page's cursor). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const page = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listSupplements(tx, { farmId, paddockId: params.get("paddockId"), from: params.get("from"), to: params.get("to"), limit: params.get("limit"), cursor: params.get("cursor") }));
  return json({ supplements: page.rows, next: page.next });
});

/** Records a supplement fed (`fedOn`, `feed`, `quantity`, `unit`, `kgDm`, `paddockId`, `mob`, `note`). Bookkeepers and above (PF6). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const supplement = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addSupplement(tx, { farmId, paddockId: body.paddockId, fedOn: body.fedOn, feed: body.feed, quantity: body.quantity, unit: body.unit, kgDm: body.kgDm, mob: body.mob, note: body.note }),
  );
  return json({ supplement }, { status: 201 });
});
