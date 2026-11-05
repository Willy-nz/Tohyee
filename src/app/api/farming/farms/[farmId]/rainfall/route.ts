import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { addRainReading, listRainReadings } from "@/lib/farming/rainfall";

type Context = { params: Promise<{ farmId: string }> };

/** GET: rain readings on the farm from `from` to `to` (at most two years), newest first, for one `gaugeId` or every gauge. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const readings = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listRainReadings(tx, { farmId, gaugeId: params.get("gaugeId"), from: params.get("from"), to: params.get("to") }));
  return json({ readings });
});

/** Records a day's rain (`gaugeId`, `readOn`, `mm`, `note`, `operationId` from a phone's queue). Farm staff and up (RF2). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const reading = await withFarmWork(request, body.organisationId, "record", (tx) => addRainReading(tx, { farmId, gaugeId: body.gaugeId, readOn: body.readOn, mm: body.mm, note: body.note, operationId: body.operationId }));
  return json({ reading }, { status: 201 });
});
