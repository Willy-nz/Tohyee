import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { listStageMappings, saveStageMappings } from "@/lib/consolidation/stage-mappings";

type Context = { params: Promise<{ groupId: string }> };

/** GET: each member's opportunity stages and the group stage each counts as (decision 643). */
export const GET = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json(await listStageMappings({ id: auth.user.id, email: auth.user.email }, groupId));
});

/** PUT `{ mappings: [{ organisationId, stageKey, groupStage }] }`: saves mappings; a blank group stage removes one. Admins of every organisation. */
export const PUT = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json(await saveStageMappings({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)));
});
