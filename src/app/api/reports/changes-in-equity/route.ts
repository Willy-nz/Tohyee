import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { runDefaultEquityLayout } from "@/lib/reports/report-layouts";
import { changesInEquity } from "@/lib/reports/statements";

/**
 * Statement of changes in equity for a period (defaults to the financial
 * year to date), with `layout`: the default changes in equity layout's
 * figures for the same period (CEL5), or null. `standard=1` leaves it out.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    const statement = await changesInEquity(tx, { from: params.get("from"), to: params.get("to") });
    const layout = params.get("standard") === "1" ? null : await runDefaultEquityLayout(tx, { from: statement.from, to: statement.to });
    return { ...statement, layout };
  });
  return json(report);
});
