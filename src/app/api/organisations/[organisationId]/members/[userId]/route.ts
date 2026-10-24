import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { assertDemoAllows } from "@/lib/demo/guard";
import { changeMemberRole, removeMember } from "@/lib/organisations/members";
import { parseOrganisationId } from "@/lib/organisations/registry";

type Context = { params: Promise<{ organisationId: string; userId: string }> };

export const PATCH = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const params = await context.params;
  const organisationId = parseOrganisationId(params.organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  assertDemoAllows(request, membership.organisation);
  const body = await readJson(request);
  await changeMemberRole(auth, membership.role, organisationId, params.userId, { role: body.role });
  return json({ ok: true });
});

export const DELETE = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const params = await context.params;
  const organisationId = parseOrganisationId(params.organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  assertDemoAllows(request, membership.organisation);
  await removeMember(auth, membership.role, organisationId, params.userId);
  return json({ ok: true });
});
