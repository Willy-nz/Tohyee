import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { salesDashboard } from "@/lib/crm/dashboard";

/**
 * The standard sales dashboard (decision 500): `period` month or quarter,
 * `from` a date in the first period (else the periods end with today's),
 * `periods` how many. A sales rep or manager sees only their own figures.
 */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const dashboard = await withCrm(request, query.get("organisationId"), "read", (tx, { scope }) =>
    salesDashboard(tx, { period: query.get("period"), from: query.get("from"), periods: query.get("periods") }, scope),
  );
  return json({ dashboard });
});
