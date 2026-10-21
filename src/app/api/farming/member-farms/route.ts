import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { NotFoundError } from "@/lib/errors";
import { listMemberFarmAccess, setMemberFarmAccess } from "@/lib/farming/access";
import { getFarmingSettings, listFarms } from "@/lib/farming/paddocks";
import { getMembership } from "@/lib/organisations/registry";

/** GET: each member's farms (decision 744), the farms, and whether farms are kept apart (two or more). Admins and owners. */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", async (tx) => {
    if (!(await getFarmingSettings(tx)).enabled) return { farming: false, farms: [], access: [], keptApart: false };
    const farms = await listFarms(tx);
    return { farming: true, farms: farms.map((farm) => ({ id: farm.id, name: farm.name, isActive: farm.isActive })), access: await listMemberFarmAccess(tx), keptApart: farms.length >= 2 };
  });
  return json(result);
});

/** PUT: which farms one member works on: `access` "all", "farms" (with `farmIds`) or "unassigned". Admins and owners. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  // The member's role, from the core database, before the organisation's transaction opens.
  const organisationId = typeof body.organisationId === "string" ? body.organisationId : "";
  const member = typeof body.userId === "string" && organisationId ? await getMembership(organisationId, body.userId).catch(() => null) : null;
  const access = await withOrganisation(request, body.organisationId, "admin", (tx) => {
    if (!member) throw new NotFoundError("That person isn't a member of this organisation.");
    return setMemberFarmAccess(tx, { userId: body.userId, role: member.role, access: body.access, farmIds: body.farmIds });
  });
  return json({ access });
});
