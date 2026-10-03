import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { previewShapedTable } from "@/lib/analytics/shaped-tables";
import { requireAnalytics } from "@/lib/analytics/sources";

export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation } = await analyticsMember(request, body.organisationId, "viewer");
  await withOrganisation(request, organisation.id, "viewer", requireAnalytics);
  const preview = await previewShapedTable(organisation.id, String(body.baseTable ?? ""), body.steps, body.throughStep as number | undefined);
  return json(preview);
});
