import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { getPayslip } from "@/lib/payroll/payslips";

type Context = { params: Promise<{ payRunId: string; employeeId: string }> };

/** One employee's payslip on an approved pay run (PSLIP1-PSLIP3). Bookkeeper and payroll access. */
export const GET = route<Context>(async (request, context) => {
  const { payRunId, employeeId } = await context.params;
  const payslip = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => getPayslip(tx, payRunId, employeeId));
  return json({ payslip }, { headers: { "cache-control": "no-store" } });
});
