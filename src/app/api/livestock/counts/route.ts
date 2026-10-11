import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { recordCounts } from "@/lib/livestock/movements";

/** Records what was counted at a year end by class (LV2); returns the head count with any "not explained" differences. Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => recordCounts(tx, { countDate: body.countDate, lines: body.lines }));
  return json({ headCount: result });
});
