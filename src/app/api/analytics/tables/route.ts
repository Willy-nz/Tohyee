import { json, route, searchParams } from "@/lib/api/http";
import { describeTables } from "@/lib/analytics/dashboards";
import { analyticsMember } from "@/lib/analytics/http";
import { requireAnalytics } from "@/lib/analytics/sources";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";

/** The organisation's loaded tables and their columns. */
export const GET = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "viewer");
  await withOrganisationTransaction(organisation, actor, (tx) => requireAnalytics(tx), { readOnly: true });
  return json({ tables: await describeTables(organisation.id) });
});
