export function accountTransactionsHref(input: {
  accountId: string;
  from?: string | null;
  to: string;
  basis?: string | null;
  trackingCategoryId?: string | null;
  trackingValueId?: string | null;
  trackingUnassigned?: boolean;
}): string {
  const params = new URLSearchParams({ report: "transactions", account: input.accountId });
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
