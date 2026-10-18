import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addSupplement, listSupplements } from "@/lib/farming/pasture";

type Context = { params: Promise<{ farmId: string }> };

/** GET: supplements fed on the farm, newest first. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const supplements = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listSupplements(tx, { farmId }));
  return json({ supplements });
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
