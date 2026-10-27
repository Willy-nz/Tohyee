import { json, readJson, route, searchParams, withOrganisation, withFarmWork } from "@/lib/api/http";
import { addSoilTest, listSoilTests } from "@/lib/farming/soil";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's soil tests with their results, newest first (`paddockId` for one paddock). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const tests = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listSoilTests(tx, { farmId, paddockId: params.get("paddockId") }));
  return json({ tests });
});

/** Enters one soil test by hand (`paddockId`, `sampledOn`, lab details, `results`). Bookkeepers and above. */
export const POST = route<Context>(async (request) => {
  const body = await readJson(request);
  const test = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addSoilTest(tx, { paddockId: body.paddockId, sampledOn: body.sampledOn, sampleName: body.sampleName, lab: body.lab, labReference: body.labReference, depth: body.depth, results: body.results }),
  );
  return json({ test }, { status: 201 });
});
