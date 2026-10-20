import { json, requireAuth, route } from "@/lib/api/http";
import { getReportSnapshot } from "@/lib/consolidation/snapshots";

type Context = { params: Promise<{ groupId: string; snapshotId: string }> };

/** GET: one saved report with its figures, as saved. */
export const GET = route<Context>(async (request, context) => {
  const { groupId, snapshotId } = await context.params;
  const auth = await requireAuth(request);
  return json({ snapshot: await getReportSnapshot({ id: auth.user.id, email: auth.user.email }, groupId, snapshotId) });
});
