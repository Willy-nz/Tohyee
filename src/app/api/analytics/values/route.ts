import { json, route, searchParams } from "@/lib/api/http";
import { sliceValues } from "@/lib/analytics/dashboards";
import { analyticsMember } from "@/lib/analytics/http";
import { requireAnalytics } from "@/lib/analytics/sources";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";

/** The values a slicer offers (up to 500). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const { organisation, actor } = await analyticsMember(request, params.get("organisationId"), "viewer");
  await withOrganisationTransaction(organisation, actor, (tx) => requireAnalytics(tx), { readOnly: true });
  return json({ values: await sliceValues(organisation.id, params.get("table") ?? "", params.get("field") ?? "") });
});
