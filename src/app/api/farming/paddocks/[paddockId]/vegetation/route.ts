import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { getPaddockTrend } from "@/lib/farming/vegetation/service";

type Context = { params: Promise<{ paddockId: string }> };

/** GET: a paddock's greenness over time, with each date's clear share and quality (decision 1533). */
export const GET = route<Context>(async (request, context) => {
  const { paddockId } = await context.params;
  const query = searchParams(request);
  const trend = await withFarmWork(request, query.get("organisationId"), "read", (tx) => getPaddockTrend(tx, paddockId, { from: query.get("from") ?? undefined, to: query.get("to") ?? undefined }));
  return json({ trend });
});
