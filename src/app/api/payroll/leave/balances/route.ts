import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { listLeaveBalances } from "@/lib/payroll/leave-reports";

/** Everyone's leave balances at a date (HL42). Query: organisationId, asAt?. Payroll access. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const balances = await withPayrollAccess(request, params.get("organisationId"), (tx) => listLeaveBalances(tx, params.get("asAt") || undefined));
  return json({ balances });
});
