import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { decideCommentary } from "@/lib/analytics/dashboards";

type Context = { params: Promise<{ dashboardId: string; tileId: string }> };

/**
 * POST { action: "accept" | "remove", expectedVersion }: a person accepts the
 * connected AI's commentary on a report, or removes it (#706). Bookkeepers
 * and up, as for changing the report.
 */
export const POST = route<Context>(async (request, context) => {
  const { dashboardId, tileId } = await context.params;
  const body = await readJson(request);
  const dashboard = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    decideCommentary(tx, dashboardId, tileId, { action: body.action, expectedVersion: body.expectedVersion }),
  );
  return json({ dashboard });
});
