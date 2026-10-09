import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { crmEnabled, listTeam } from "@/lib/crm/service";

/** The organisation's members (for owners and assignees) and whether the CRM is on. */
export const GET = route(async (request) => {
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx) => ({
    crmEnabled: await crmEnabled(tx),
    team: await listTeam(tx),
  }));
  return json(result);
});
