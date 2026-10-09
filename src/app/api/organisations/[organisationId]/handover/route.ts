import { json, requireAuth, route } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { cancelHandover, waitingHandover } from "@/lib/organisations/handover";
import { parseOrganisationId } from "@/lib/organisations/registry";

type Context = { params: Promise<{ organisationId: string }> };

/** GET: a handover a server admin asked for that's still waiting, if any (#208). Owners and admins. */
export const GET = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId((await context.params).organisationId);
  await requireOrganisationRole(auth, organisationId, "admin");
  return json({ handover: await waitingHandover(organisationId) });
});

/** DELETE: an owner or admin cancels it. */
export const DELETE = route<Context>(async (request, context) => {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId((await context.params).organisationId);
  await requireOrganisationRole(auth, organisationId, "admin");
  return json({ handover: await cancelHandover(auth.user, organisationId, "member") });
});
