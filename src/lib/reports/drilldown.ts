/**
 * Account transactions for one account (or several: a group's total,
 * decision 1356) over the dates an amount covers, with its tracking filter.
 */
export function accountTransactionsHref(input: {
  accountId?: string;
  accountIds?: string[];
  from?: string | null;
  to: string;
  basis?: string | null;
  trackingCategoryId?: string | null;
  trackingValueId?: string | null;
  trackingUnassigned?: boolean;
}): string {
  const params = new URLSearchParams({ report: "transactions" });
  if (input.accountIds && input.accountIds.length > 0) params.set("accounts", input.accountIds.join(","));
  else if (input.accountId) params.set("account", input.accountId);
  if (input.from) params.set("from", input.from);
  params.set("to", input.to);
  if (input.basis) params.set("basis", input.basis);
  if (input.trackingCategoryId && input.trackingValueId) {
    params.set("trackingCategoryId", input.trackingCategoryId);
    params.set("trackingValueId", input.trackingValueId);
  } else if (input.trackingCategoryId && input.trackingUnassigned) {
    params.set("trackingCategoryId", input.trackingCategoryId);
    params.set("trackingValueId", "unassigned");
  }
  return `/operations/reports?${params.toString()}`;
}
