import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { accountTransactions } from "@/lib/reports/account-transactions";

/**
 * Account transactions (general ledger detail, examples ATX1-ATX6) from
 * `from` to `to` for `accountId` (or `accountIds`, several separated by
 * commas), or every account when both are left out;
 * `trackingCategoryId` with `trackingValueId` keeps only lines tagged with
 * that value or one under it. `hideVoidedPairs=1` leaves out journals
 * and their reversals when both are in the range (VP3).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    accountTransactions(tx, {
      accountId: params.get("accountId"),
      accountIds: params.get("accountIds"),
      from: params.get("from"),
      to: params.get("to"),
      trackingCategoryId: params.get("trackingCategoryId"),
      trackingValueId: params.get("trackingValueId"),
      hideVoidedPairs: params.get("hideVoidedPairs"),
    }),
  );
  return json(report);
});
