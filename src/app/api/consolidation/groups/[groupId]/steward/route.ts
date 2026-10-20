import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { setSteward } from "@/lib/consolidation/groups";

type Context = { params: Promise<{ groupId: string }> };

/** PUT `{ organisationId, version }`: the member that keeps the group's records (decision 641). Admins of every organisation. */
export const PUT = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ group: await setSteward({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)) });
});
