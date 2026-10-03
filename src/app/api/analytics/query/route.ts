import { json, readJson, route } from "@/lib/api/http";
import { runTile } from "@/lib/analytics/dashboards";
import { analyticsMember } from "@/lib/analytics/http";
import type { DashboardFilters } from "@/lib/analytics/query";
import { requireAnalytics } from "@/lib/analytics/sources";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";

/** Answers one tile's question: `query` (table, groupBy, measures, filters…) and the dashboard's `filters`. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "viewer");
  await withOrganisationTransaction(organisation, actor, (tx) => requireAnalytics(tx), { readOnly: true });
  const raw = (body.filters ?? {}) as Record<string, unknown>;
  const values: Record<string, string[]> = {};
  if (raw.values && typeof raw.values === "object") {
    for (const [field, list] of Object.entries(raw.values as Record<string, unknown>)) {
      if (Array.isArray(list)) values[field] = list.map(String);
    }
  }
  const filters: DashboardFilters = {
    from: typeof raw.from === "string" && raw.from ? raw.from : null,
    to: typeof raw.to === "string" && raw.to ? raw.to : null,
    values,
  };
  return json(await runTile(organisation.id, body.query, filters));
});
