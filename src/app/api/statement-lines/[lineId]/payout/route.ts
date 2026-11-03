import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { payoutGuidanceForLine } from "@/lib/sales-platforms/payout-reconcile";

type Context = { params: Promise<{ lineId: string }> };

/** GET: whether a statement line is a platform payout, its settlement and the reconcile command a person could use (#548). Read-only. */
export const GET = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const guidance = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => payoutGuidanceForLine(tx, lineId));
  return json({ guidance });
});
