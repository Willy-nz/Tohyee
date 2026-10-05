import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { createAdjustment } from "@/lib/consolidation/groups";

type Context = { params: Promise<{ groupId: string }> };

/** POST `{ date, description, lines: [{ organisationId, accountCode, debit, credit }] }`: an elimination adjustment (CO7). Bookkeepers of every organisation. */
export const POST = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ adjustments: await createAdjustment({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)) }, { status: 201 });
});
