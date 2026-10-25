import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { assertDemoAllows } from "@/lib/demo/guard";
import { inviteMember, listMembers } from "@/lib/organisations/members";
import { parseOrganisationId } from "@/lib/organisations/registry";

type Context = { params: Promise<{ organisationId: string }> };

export const GET = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId((await context.params).organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  assertDemoAllows(request, membership.organisation);
  return json({ members: await listMembers(organisationId) });
});

export const POST = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId((await context.params).organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  assertDemoAllows(request, membership.organisation);
  const body = await readJson(request);
  // Invite (#441): someone with a login is added; someone new gets a login and a setup link.
  const result = await inviteMember(auth, membership.role, organisationId, {
    email: body.email,
    displayName: body.displayName,
    role: body.role,
  });
  return json(result, { status: 201 });
});
