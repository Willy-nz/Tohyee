import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createMeasure, listMeasures } from "@/lib/analytics/saved-measures";

/** Saved values on the data sources, and the books copy's built-in ones (#337). Viewers and up (they can see the tables). */
export const GET = route(async (request) => {
  const measures = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listMeasures(tx));
  return json({ measures });
});

/** Saves a value on a data source: { table, name, description?, definition, number? }. Bookkeepers and up. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const measure = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createMeasure(tx, body));
  return json({ measure }, { status: 201 });
});
