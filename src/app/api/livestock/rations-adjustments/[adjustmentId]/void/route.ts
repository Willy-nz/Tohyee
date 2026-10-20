import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidRationsAdjustment } from "@/lib/livestock/rations-adjustments";

type Context = { params: Promise<{ adjustmentId: string }> };

/** POST: voids the year's homekill adjustment with a `reason`; its journal is reversed on its date (bookkeepers and above; RAT8). */
export const POST = route<Context>(async (request, context) => {
  const { adjustmentId } = await context.params;
  const body = await readJson(request);
  const adjustment = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => voidRationsAdjustment(tx, adjustmentId, { reason: body.reason }));
  return json({ adjustment });
});
