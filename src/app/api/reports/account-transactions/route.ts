import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { accountTransactions } from "@/lib/reports/account-transactions";

/**
 * Account transactions (general ledger detail, examples ATX1-ATX5) from
 * `from` to `to` for `accountId`, or every account when it's left out;
 * `trackingCategoryId` with `trackingValueId` keeps only lines tagged with
 * that value or one under it.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    accountTransactions(tx, {
      accountId: params.get("accountId"),
      from: params.get("from"),
      to: params.get("to"),
      trackingCategoryId: params.get("trackingCategoryId"),
      trackingValueId: params.get("trackingValueId"),
    }),
  );
  return json(report);
});
