import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { bankReconciliationReport } from "@/lib/reports/bank-reconciliation";

/** Bank reconciliation for `accountId` as at `asAt`: statement and Tohyee balances and the items between them (examples BK20, BK21). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    bankReconciliationReport(tx, { accountId: params.get("accountId"), asAt: params.get("asAt") }),
  );
  return json(report);
});
