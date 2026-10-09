import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createSalesTeam, listSalesTeams } from "@/lib/crm/teams";

/** The sales teams (decision 491): anyone in the CRM can see who's in which. */
export const GET = route(async (request) => {
  const teams = await withCrm(request, searchParams(request).get("organisationId"), "read", (tx) => listSalesTeams(tx));
  return json({ teams });
});

/** Makes a team: `name`, `managerUserId`, `memberUserIds`. Admins and owners only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const team = await withCrm(request, body.organisationId, "admin", (tx) =>
    createSalesTeam(tx, { name: body.name, managerUserId: body.managerUserId, memberUserIds: body.memberUserIds }),
  );
  return json({ team }, { status: 201 });
});
