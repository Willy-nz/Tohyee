import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { crmHome } from "@/lib/crm/service";

/** The signed-in person's open opportunities and tasks due, and recent activities (example CRM10). Read-only. */
export const GET = route(async (request) => {
  const home = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => crmHome(tx));
  return json(home);
});
