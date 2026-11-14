import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { moveAiDashboard } from "@/lib/ai-workspace/move-to-analytics";

type Context = { params: Promise<{ dashboardId: string }> };

/** Makes an Analytics report from one of the AI's older dashboards (#693). Bookkeepers and up, as for any new report. */
export const POST = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  const body = await readJson(request);
  const moved = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => moveAiDashboard(tx, dashboardId));
  return json(moved, { status: 201 });
});
