import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidMovement } from "@/lib/livestock/movements";

type Context = { params: Promise<{ movementId: string }> };

/** Voids a movement with a reason; it stays in the list, marked voided. Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { movementId } = await context.params;
  const body = await readJson(request);
  const movement = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => voidMovement(tx, movementId, { reason: body.reason }));
  return json({ movement });
});
