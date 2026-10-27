import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { addSoilSample, listSoilSamples } from "@/lib/farming/soil-samples";

type Context = { params: Promise<{ farmId: string }> };

/** GET: soil samples taken in the field on the farm, newest first (FA4). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const samples = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listSoilSamples(tx, { farmId, paddockId: params.get("paddockId") }));
  return json({ samples });
});

/** POST: records a sample by hand (`paddockId`, `takenOn`, `sampleName`, `depth`, `latitude`, `longitude`, `note`). Farm staff, bookkeepers and above (decision 904). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const sample = await withFarmWork(request, body.organisationId, "record", (tx) =>
    addSoilSample(tx, { farmId, paddockId: body.paddockId, takenOn: body.takenOn, sampleName: body.sampleName, depth: body.depth, latitude: body.latitude, longitude: body.longitude, note: body.note }),
  );
  return json({ sample }, { status: 201 });
});
