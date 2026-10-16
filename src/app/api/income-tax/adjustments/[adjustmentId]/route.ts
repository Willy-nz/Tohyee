import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeAdjustment } from "@/lib/tax/income/service";

type Context = { params: Promise<{ adjustmentId: string }> };

/** DELETE: removes a typed adjustment; the history keeps it (owners and admins). */
export const DELETE = route<Context>(async (request, context) => {
  const { adjustmentId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => removeAdjustment(tx, adjustmentId));
  return json({ removed: true });
});
