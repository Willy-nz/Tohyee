import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { listMembers } from "@/lib/crm/campaigns";

/** The campaigns a lead or person is in (decision 498): `leadId` or `personId`. */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const members = await withCrm(request, query.get("organisationId"), "read", (tx, { scope }) =>
    listMembers(tx, { leadId: query.get("leadId") ?? undefined, personId: query.get("personId") ?? undefined }, scope),
  );
  return json({ members });
});
