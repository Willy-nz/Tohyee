import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addReading, listReadings } from "@/lib/farming/pasture";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's cover readings, newest first (`paddockId` for one paddock). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const readings = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listReadings(tx, { farmId, paddockId: params.get("paddockId") }));
  return json({ readings });
});

/** Adds a cover reading (`paddockId`, `measuredOn`, `cover`, `method`, `note`). Bookkeepers and above (PF1, PF8). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const reading = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => addReading(tx, { paddockId: body.paddockId, measuredOn: body.measuredOn, cover: body.cover, method: body.method, note: body.note }));
  return json({ reading }, { status: 201 });
});
