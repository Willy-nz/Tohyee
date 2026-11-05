import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { dashboardHistory, restoreDashboardVersion } from "@/lib/analytics/dashboards";

type Context = { params: Promise<{ dashboardId: string }> };

/** A report's edit history (decision 1414): every saved version, who saved it and how. Bookkeepers and up, who change reports. */
export const GET = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  const history = await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => dashboardHistory(tx, dashboardId));
  return json(history);
});

/** Puts an earlier version back (decision 1415): `version`, and `expectedVersion` the report is at now. */
export const POST = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  const body = await readJson(request);
  const dashboard = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => restoreDashboardVersion(tx, dashboardId, body));
  return json({ dashboard });
});
