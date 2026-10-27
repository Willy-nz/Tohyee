import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addReading, listReadings } from "@/lib/farming/pasture";

type Context = { params: Promise<{ farmId: string }> };

/** GET: a page of the farm's cover readings, newest first (`paddockId`, `from`, `to`, `limit`, `cursor`; `next` is the next page's cursor). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const page = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listReadings(tx, { farmId, paddockId: params.get("paddockId"), from: params.get("from"), to: params.get("to"), limit: params.get("limit"), cursor: params.get("cursor") }));
  return json({ readings: page.rows, next: page.next });
});

/** Adds a cover reading (`paddockId`, `measuredOn`, `cover`, `method`, `note`). Bookkeepers and above (PF1, PF8). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  // The farm in the address must be the paddock's farm (decision 902).
  const reading = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => addReading(tx, { farmId, paddockId: body.paddockId, measuredOn: body.measuredOn, cover: body.cover, method: body.method, note: body.note }));
  return json({ reading }, { status: 201 });
});
