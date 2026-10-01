import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { ForbiddenError } from "@/lib/errors";
import { getPaydayFilingSettings, updatePaydayFilingSettings } from "@/lib/payroll/payday-filing-service";

/**
 * Payday filing settings (PF7, decision 62): the employer's IRD number and
 * the payroll contact for IRD's employment information file. Reading needs
 * payroll access; changing needs payroll access and the admin role.
 */
export const GET = route(async (request) => {
  const settings = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => getPaydayFilingSettings(tx));
  return json({ settings });
});

/** Body: { organisationId, employerIrdNumber, contactName, contactPhone, contactEmail }. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withPayrollAccess(request, body.organisationId, (tx, { membership }) => {
    if (!roleAtLeast(membership.role, "admin")) throw new ForbiddenError("Only admins can change payroll settings.");
    return updatePaydayFilingSettings(tx, {
      employerIrdNumber: body.employerIrdNumber,
      contactName: body.contactName,
      contactPhone: body.contactPhone,
      contactEmail: body.contactEmail,
    });
  });
  return json({ settings });
});
