import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { setMembershipDates } from "@/lib/consolidation/groups";

type Context = { params: Promise<{ groupId: string }> };

/** PUT `{ organisationId, effectiveFrom, effectiveTo, version }`: the days a member joined and left the group (decision 640). Admins of every organisation. */
export const PUT = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ group: await setMembershipDates({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)) });
});
