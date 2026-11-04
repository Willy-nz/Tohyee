import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { assertDemoAllows } from "@/lib/demo/guard";
import { changeMemberAccess, setMemberAccess } from "@/lib/organisations/members";
import { parseOrganisationId } from "@/lib/organisations/registry";

type Context = { params: Promise<{ organisationId: string; userId: string }> };

/**
 * PUT: when a member's access starts and ends (decision 1466): `accessFrom`
 * and `accessUntil` (YYYY-MM-DD, empty for no limit), each with an optional
 * time (`accessFromTime`, `accessUntilTime`, HH:MM). Owners and admins.
 */
export const PUT = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const params = await context.params;
  const organisationId = parseOrganisationId(params.organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  assertDemoAllows(request, membership.organisation);
  const body = await readJson(request);
  const member = await setMemberAccess(auth, membership.role, organisationId, params.userId, {
    accessFrom: body.accessFrom,
    accessFromTime: body.accessFromTime,
    accessUntil: body.accessUntil,
    accessUntilTime: body.accessUntilTime,
  });
  return json({ member });
});

/** POST: `action` extend_week, extend_month or end_now (decision 1470). Owners and admins. */
export const POST = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const params = await context.params;
  const organisationId = parseOrganisationId(params.organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  assertDemoAllows(request, membership.organisation);
  const body = await readJson(request);
  const member = await changeMemberAccess(auth, membership.role, organisationId, params.userId, body.action);
  return json({ member });
});
