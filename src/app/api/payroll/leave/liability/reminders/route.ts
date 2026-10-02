import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { leaveLiabilityReminders } from "@/lib/payroll/leave-liability";

/**
 * GET: the leave liability's month-end reminder (decision 191; HL61), for
 * the home page. Bookkeepers and up; empty without payroll access.
 */
export const GET = route(async (request) => {
  const reminders = await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => leaveLiabilityReminders(tx));
  return json({ reminders });
});
