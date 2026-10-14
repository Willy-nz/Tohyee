import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { cashFlowStatement } from "@/lib/reports/statements";

/** Statement of cash flows, indirect method, for a period (defaults to the financial year to date). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    cashFlowStatement(tx, { from: params.get("from"), to: params.get("to") }),
  );
  return json(report);
});
