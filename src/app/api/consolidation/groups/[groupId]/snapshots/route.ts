import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { listReportSnapshots, saveReportSnapshot } from "@/lib/consolidation/snapshots";

type Context = { params: Promise<{ groupId: string }> };

/** GET: the saved consolidated reports the person can see (every organisation in each). */
export const GET = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json(await listReportSnapshots({ id: auth.user.id, email: auth.user.email }, groupId));
});

/** POST `{ report: "profit_and_loss", from, to }` or `{ report: "balance_sheet", asAt }`: saves a copy, with the members it used. Bookkeepers of every organisation. */
export const POST = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ snapshot: await saveReportSnapshot({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)) }, { status: 201 });
});
