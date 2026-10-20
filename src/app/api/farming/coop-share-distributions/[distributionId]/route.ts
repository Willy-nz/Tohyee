import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeDistribution } from "@/lib/farming/coop-shares";

type Context = { params: Promise<{ distributionId: string }> };

/** Removes a dividend, rebate or retention entered by mistake (CSR8). Kept for the history. */
export const DELETE = route<Context>(async (request, context) => {
  const { distributionId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeDistribution(tx, distributionId));
  return json({ ok: true });
});
