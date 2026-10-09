import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { removeSalesTeam, updateSalesTeam } from "@/lib/crm/teams";

type Context = { params: Promise<{ teamId: string }> };

/** Renames a team, or changes its manager or members. Admins and owners only. */
export const PATCH = route<Context>(async (request, context) => {
  const { teamId } = await context.params;
  const body = await readJson(request);
  const team = await withCrm(request, body.organisationId, "admin", (tx) =>
    updateSalesTeam(tx, teamId, { name: body.name, managerUserId: body.managerUserId, memberUserIds: body.memberUserIds }),
  );
  return json({ team });
});

/** Removes a team; its members' deals and tasks stay theirs. Admins and owners only. */
export const DELETE = route<Context>(async (request, context) => {
  const { teamId } = await context.params;
  await withCrm(request, searchParams(request).get("organisationId"), "admin", (tx) => removeSalesTeam(tx, teamId));
  return json({ removed: true });
});
