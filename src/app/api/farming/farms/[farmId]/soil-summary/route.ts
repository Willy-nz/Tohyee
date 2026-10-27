import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { soilSummary } from "@/lib/farming/soil";

type Context = { params: Promise<{ farmId: string }> };

/** GET: each current paddock with its latest soil test and results. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const summary = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => soilSummary(tx, { farmId }));
  return json({ summary });
});
