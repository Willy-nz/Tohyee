import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { runDefaultCashFlowLayout } from "@/lib/reports/report-layouts";
import { cashFlowStatement } from "@/lib/reports/statements";

/**
 * Statement of cash flows, indirect method, for a period (defaults to the
 * financial year to date), with `layout`: the default cash flows layout's
 * figures for the same period (CFL5), or null. `standard=1` leaves it out.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    const statement = await cashFlowStatement(tx, { from: params.get("from"), to: params.get("to") });
    const layout = params.get("standard") === "1" ? null : await runDefaultCashFlowLayout(tx, { from: statement.from, to: statement.to });
    return { ...statement, layout };
  });
  return json(report);
});
