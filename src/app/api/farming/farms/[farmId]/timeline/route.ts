import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { farmTimeline } from "@/lib/farming/timeline";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's timeline, newest first (`mobId`, `paddockId`, `from`, `to`, `kinds`, `limit`; TL1-TL2). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const timeline = await withFarmWork(request, params.get("organisationId"), "read", (tx) =>
    farmTimeline(tx, { farmId, mobId: params.get("mobId"), paddockId: params.get("paddockId"), from: params.get("from"), to: params.get("to"), kinds: params.get("kinds"), limit: params.get("limit") }),
  );
  return json(timeline);
});
