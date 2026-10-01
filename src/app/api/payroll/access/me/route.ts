import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { hasPayrollAccess, PAYROLL_MINIMUM_ROLE } from "@/lib/payroll/access";

/** Whether the signed-in person can see payroll, so screens can say so instead of showing an error (PR10). */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx, { membership }) => ({
    hasPayrollAccess: roleAtLeast(membership.role, PAYROLL_MINIMUM_ROLE) && (await hasPayrollAccess(tx)),
    canManagePayrollAccess: roleAtLeast(membership.role, "admin"),
  }));
  return json(result);
});
