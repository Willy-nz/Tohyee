import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listLayoutDefaults, setLayoutDefault } from "@/lib/reports/report-layouts";

/** GET: the default layout of the profit and loss and balance sheet, if any (decision 1359). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const defaults = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listLayoutDefaults(tx));
  return json({ defaults });
});

/** PUT { base, reportId }: makes a draft the default layout; reportId null goes back to the standard layout. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const defaults = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => setLayoutDefault(tx, { base: body.base, reportId: body.reportId }));
  return json({ defaults });
});
