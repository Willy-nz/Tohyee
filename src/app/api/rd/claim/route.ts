import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { hasPayrollAccess } from "@/lib/payroll/access";
import { buildClaimReport } from "@/lib/rd/claim";

/**
 * GET: the RDTI claim report for an income year (viewers and above; decision
 * 65). Each employee's pay only for people with payroll access; reminders
 * only for owners and admins (decision 48). Read-only.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx, { membership }) =>
    buildClaimReport(tx, params.get("incomeYear"), {
      payrollDetail: roleAtLeast(membership.role, "bookkeeper") && (await hasPayrollAccess(tx)),
      showReminders: roleAtLeast(membership.role, "admin"),
    }),
  );
  return json({ report });
});
