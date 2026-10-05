import { json, requireAuth, route } from "@/lib/api/http";
import { removeAdjustment } from "@/lib/consolidation/groups";

type Context = { params: Promise<{ groupId: string; adjustmentId: string }> };

/** DELETE: removes an elimination adjustment (kept, with who removed it). Bookkeepers of every organisation. */
export const DELETE = route<Context>(async (request, context) => {
  const { groupId, adjustmentId } = await context.params;
  const auth = await requireAuth(request);
  return json({ adjustments: await removeAdjustment({ id: auth.user.id, email: auth.user.email }, groupId, adjustmentId) });
});
