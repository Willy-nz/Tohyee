import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listRestrictedMembers, setRestrictedMember } from "@/lib/safety/records";
import { ForbiddenError } from "@/lib/errors";

/** GET: who besides owners sees incident and medical details. Owners only. */
export const GET = route(async (request) => {
  const members = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => {
    if (tx.actor.role !== "owner") throw new ForbiddenError("Only an owner can see who has restricted access.");
    return listRestrictedMembers(tx);
  });
  return json({ members });
});

/** Gives (`allowed: true`) or takes away a member's access to restricted details. Owners only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const members = await withOrganisation(request, body.organisationId, "admin", (tx) => setRestrictedMember(tx, { userId: body.userId, allowed: body.allowed }));
  return json({ members });
});
