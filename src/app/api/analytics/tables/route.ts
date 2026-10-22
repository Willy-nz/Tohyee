import { json, route, searchParams } from "@/lib/api/http";
import { describeTables } from "@/lib/analytics/dashboards";
import { hiddenFarmTables } from "@/lib/analytics/farm-access";
import { analyticsMember } from "@/lib/analytics/http";
import { requireAnalytics } from "@/lib/analytics/sources";
import { loadModel } from "@/lib/analytics/model";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";

/** The organisation's loaded tables and their columns. */
export const GET = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "viewer");
  const { hidden, fields } = await withOrganisationTransaction(
    organisation,
    actor,
    async (tx) => {
      await requireAnalytics(tx);
      return { hidden: await hiddenFarmTables(tx), fields: await loadModel(tx) };
    },
    { readOnly: true },
  );
  // A member who sees only some farms doesn't get the farm tables (decision 744). Calculated fields (decision 772) are listed as columns.
  const tables = await describeTables(organisation.id, fields);
  return json({ tables: hidden ? tables.filter((table) => !hidden.has(table.name)) : tables });
});
