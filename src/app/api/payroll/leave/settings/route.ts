import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { ForbiddenError } from "@/lib/errors";
import { getOrganisationLeaveSettings, updateOrganisationLeaveSettings } from "@/lib/payroll/leave-settings";

/** The organisation's leave settings (decision 22; s 28E). Reading needs payroll access; changing needs payroll access and the admin role. */
export const GET = route(async (request) => {
  const settings = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => getOrganisationLeaveSettings(tx));
  return json({ settings });
});

/** Body: { organisationId, anniversaryRegion?, noCashUps? }. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withPayrollAccess(request, body.organisationId, (tx, { membership }) => {
    if (!roleAtLeast(membership.role, "admin")) throw new ForbiddenError("Only admins can change the organisation's leave settings.");
    return updateOrganisationLeaveSettings(tx, { anniversaryRegion: body.anniversaryRegion, noCashUps: body.noCashUps });
  });
  return json({ settings });
});
