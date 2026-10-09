import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { crmHome } from "@/lib/crm/service";

/** The signed-in person's open opportunities and tasks due, and recent activities (example CRM10). Read-only. */
export const GET = route(async (request) => {
  const home = await withCrm(request, searchParams(request).get("organisationId"), "read", (tx, { scope }) => crmHome(tx, scope));
  return json(home);
});
