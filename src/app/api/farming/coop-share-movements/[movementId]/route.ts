import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeMovement } from "@/lib/farming/coop-shares";

type Context = { params: Promise<{ movementId: string }> };

/** Removes a movement entered by mistake (CSR8). Kept for the history. */
export const DELETE = route<Context>(async (request, context) => {
  const { movementId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeMovement(tx, movementId));
  return json({ ok: true });
});
