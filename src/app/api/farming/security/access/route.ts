import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { NotFoundError } from "@/lib/errors";
import { getFarmingSettings } from "@/lib/farming/paddocks";
import { listCameraAccess, setCameraAccess } from "@/lib/security-cameras/access";
import { getMembershipAnyTime } from "@/lib/organisations/registry";

/** GET: who besides owners and admins has camera access, and at what level (decision 1220). Owners and admins. */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", async (tx) => {
    if (!(await getFarmingSettings(tx)).enabled) return { farming: false, access: [] };
    return { farming: true, access: await listCameraAccess(tx) };
  });
  return json(result);
});

/** PUT `{ userId, level }` (`level` view, download, delete or none). Owners and admins. Audited. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  // The member's role, from the core database, before the organisation's transaction opens.
  const organisationId = typeof body.organisationId === "string" ? body.organisationId : "";
  const member = typeof body.userId === "string" && organisationId ? await getMembershipAnyTime(organisationId, body.userId).catch(() => null) : null;
  const access = await withOrganisation(request, body.organisationId, "admin", (tx) => {
    if (!member) throw new NotFoundError("That person isn't a member of this organisation.");
    return setCameraAccess(tx, { userId: body.userId, role: member.role, level: body.level });
  });
  return json({ access });
});
