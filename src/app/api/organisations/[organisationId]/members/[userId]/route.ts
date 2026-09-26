import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { changeMemberRole, removeMember } from "@/lib/organisations/members";
import { parseOrganisationId } from "@/lib/organisations/registry";

type Context = { params: Promise<{ organisationId: string; userId: string }> };

export const PATCH = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const params = await context.params;
  const organisationId = parseOrganisationId(params.organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  const body = await readJson(request);
  await changeMemberRole(auth, membership.role, organisationId, params.userId, { role: body.role });
  return json({ ok: true });
});

export const DELETE = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const params = await context.params;
  const organisationId = parseOrganisationId(params.organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  await removeMember(auth, membership.role, organisationId, params.userId);
  return json({ ok: true });
});
