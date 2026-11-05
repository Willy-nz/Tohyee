import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { addGauge, listGauges } from "@/lib/farming/rainfall";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's rain gauges, with each one's latest reading (`retired=1` includes retired ones). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const gauges = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listGauges(tx, farmId, { includeRetired: params.get("retired") === "1" }));
  return json({ gauges });
});

/** Adds a rain gauge (`name`, `note`, `point` as [longitude, latitude]). Farm staff and up (RF1). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const gauge = await withFarmWork(request, body.organisationId, "record", (tx) => addGauge(tx, { farmId, name: body.name, note: body.note, point: body.point }));
  return json({ gauge }, { status: 201 });
});
