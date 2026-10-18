import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { pastureSummary } from "@/lib/farming/pasture";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's cover on `onDate` (PF3), the feed wedge (PF4), each paddock's latest reading and growth, and supplements by month. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const summary = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => pastureSummary(tx, { farmId, onDate: params.get("onDate") }));
  return json({ summary });
});
