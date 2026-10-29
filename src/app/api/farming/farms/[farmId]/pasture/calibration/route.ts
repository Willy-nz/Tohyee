import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { photoCalibration } from "@/lib/farming/pasture-photos";

type Context = { params: Promise<{ farmId: string }> };

/** GET: how far photo estimates were from other readings close in time, by method (`windowDays`, 0-14, default 2). Nothing is adjusted. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const calibration = await withFarmWork(request, params.get("organisationId"), "read", (tx) => photoCalibration(tx, { farmId, windowDays: params.get("windowDays") }));
  return json({ calibration });
});
