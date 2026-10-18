import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addSoilSample, listSoilSamples } from "@/lib/farming/soil-samples";

type Context = { params: Promise<{ farmId: string }> };

/** GET: soil samples taken in the field on the farm, newest first (FA4). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const samples = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listSoilSamples(tx, { farmId, paddockId: params.get("paddockId") }));
  return json({ samples });
});

/** POST: records a sample by hand (`paddockId`, `takenOn`, `sampleName`, `depth`, `latitude`, `longitude`, `note`). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const sample = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addSoilSample(tx, { paddockId: body.paddockId, takenOn: body.takenOn, sampleName: body.sampleName, depth: body.depth, latitude: body.latitude, longitude: body.longitude, note: body.note }),
  );
  return json({ sample }, { status: 201 });
});
