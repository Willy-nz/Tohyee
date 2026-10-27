import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { todayIsoDate } from "@/lib/dates";
import { paddockStatuses } from "@/lib/farming/paddock-status";

type Context = { params: Promise<{ farmId: string }> };

/** GET `?onDate=`: each paddock's latest cover, mob in now and last day grazed, for the map and paddock card (decision 907). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const paddocks = await withFarmWork(request, params.get("organisationId"), "read", (tx) => paddockStatuses(tx, { farmId, onDate: params.get("onDate") || todayIsoDate() }));
  return json({ paddocks });
});
