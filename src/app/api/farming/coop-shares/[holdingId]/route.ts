import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeHolding } from "@/lib/farming/coop-shares";

type Context = { params: Promise<{ holdingId: string }> };

/** Removes a holding added by mistake, once its entries are removed (CSR8). Kept for the history. */
export const DELETE = route<Context>(async (request, context) => {
  const { holdingId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeHolding(tx, holdingId));
  return json({ ok: true });
});
