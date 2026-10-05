import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { addGroupCommentary, listGroupCommentary } from "@/lib/commentary/service";

type Context = { params: Promise<{ groupId: string }> };

/** GET: commentary on the group's reports, newest first (decision 446). */
export const GET = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ commentary: await listGroupCommentary({ id: auth.user.id, email: auth.user.email }, groupId) });
});

/** POST `{ report, periodLabel, body }`: a person's commentary (accepted). Bookkeepers or above of every member. */
export const POST = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ commentary: await addGroupCommentary({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)) }, { status: 201 });
});
