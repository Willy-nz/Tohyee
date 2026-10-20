import { json, requireAuth, route, searchParams } from "@/lib/api/http";
import { groupWorkspace } from "@/lib/consolidation/workspace";

type Context = { params: Promise<{ groupId: string }> };

/** GET `?asAt&basis=none|consolidation_current`: the group workspace on a date (decisions 640-645). Anyone who can see the group. */
export const GET = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  const params = searchParams(request);
  return json({ workspace: await groupWorkspace({ id: auth.user.id, email: auth.user.email }, groupId, { asAt: params.get("asAt"), basis: params.get("basis") }) });
});
