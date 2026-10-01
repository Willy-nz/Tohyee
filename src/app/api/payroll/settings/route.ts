import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { ForbiddenError } from "@/lib/errors";
import { getPayrollSettings, updatePayrollSettings } from "@/lib/payroll/pay-items";

/** Payroll settings (example PRUN7). Reading needs payroll access; changing needs payroll access and the admin role. */
export const GET = route(async (request) => {
  const settings = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => getPayrollSettings(tx));
  return json({ settings });
});

/** Body: { organisationId, approverMustDiffer }. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withPayrollAccess(request, body.organisationId, (tx, { membership }) => {
    if (!roleAtLeast(membership.role, "admin")) throw new ForbiddenError("Only admins can change payroll settings.");
    return updatePayrollSettings(tx, { approverMustDiffer: body.approverMustDiffer });
  });
  return json({ settings });
});
