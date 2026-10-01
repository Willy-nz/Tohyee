import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { listPayRunPostings } from "@/lib/payroll/pay-runs";

type Context = { params: Promise<{ payRunId: string }> };

/** Each employee's share of each debit line of the pay run's journal (PRUN1). Payroll access only. */
export const GET = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const postings = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => listPayRunPostings(tx, payRunId));
  return json({ postings });
});
