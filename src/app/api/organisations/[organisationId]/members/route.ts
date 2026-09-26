import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { addMember, listMembers } from "@/lib/organisations/members";
import { parseOrganisationId } from "@/lib/organisations/registry";

type Context = { params: Promise<{ organisationId: string }> };

export const GET = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId((await context.params).organisationId);
  await requireOrganisationRole(auth, organisationId, "admin");
  return json({ members: await listMembers(organisationId) });
});

export const POST = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId((await context.params).organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  const body = await readJson(request);
  const member = await addMember(auth, membership.role, organisationId, {
    email: body.email,
    role: body.role,
  });
  return json({ member }, { status: 201 });
});
