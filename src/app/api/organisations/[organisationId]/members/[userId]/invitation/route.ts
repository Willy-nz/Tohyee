import { json, requireAuth, route } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { assertDemoAllows } from "@/lib/demo/guard";
import { cancelInvitation, resendInvitation } from "@/lib/organisations/members";
import { parseOrganisationId } from "@/lib/organisations/registry";

type Context = { params: Promise<{ organisationId: string; userId: string }> };

/** Resend an invitation that's still waiting (#441): a new setup link, and the old one stops. */
export const POST = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const params = await context.params;
  const organisationId = parseOrganisationId(params.organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  assertDemoAllows(request, membership.organisation);
  return json({ invitation: await resendInvitation(auth, membership.role, organisationId, params.userId) });
});

/** Cancel an invitation that's still waiting (#441). */
export const DELETE = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const params = await context.params;
  const organisationId = parseOrganisationId(params.organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "admin");
  assertDemoAllows(request, membership.organisation);
  return json(await cancelInvitation(auth, membership.role, organisationId, params.userId));
});
