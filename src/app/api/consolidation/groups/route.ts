import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { createGroup, listGroups } from "@/lib/consolidation/groups";

/** GET: the consolidation groups the signed-in person can see (a member of every organisation in it, CO1). */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  return json({ groups: await listGroups({ id: auth.user.id, email: auth.user.email }) });
});

/** POST `{ name, parentOrganisationId, organisationIds }`: makes a group. An admin or owner of every organisation in it. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const group = await createGroup({ id: auth.user.id, email: auth.user.email }, await readJson(request));
  return json({ group }, { status: 201 });
});
