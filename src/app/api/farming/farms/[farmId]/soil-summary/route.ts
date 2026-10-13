import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { soilSummary } from "@/lib/farming/soil";

type Context = { params: Promise<{ farmId: string }> };

/** GET: each current paddock with its latest soil test and results. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const summary = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => soilSummary(tx, { farmId }));
  return json({ summary });
});
