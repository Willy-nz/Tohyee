export function accountTransactionsHref(input: {
  accountId: string;
  from?: string | null;
  to: string;
  basis?: string | null;
  trackingCategoryId?: string | null;
  trackingValueId?: string | null;
}): string {
  const params = new URLSearchParams({ report: "transactions", account: input.accountId });
  if (input.from) params.set("from", input.from);
  params.set("to", input.to);
  if (input.basis) params.set("basis", input.basis);
  if (input.trackingCategoryId && input.trackingValueId) {
    params.set("trackingCategoryId", input.trackingCategoryId);
    params.set("trackingValueId", input.trackingValueId);
  }
  return `/operations/reports?${params.toString()}`;
}
