import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { changeGroupCommentary } from "@/lib/commentary/service";

type Context = { params: Promise<{ groupId: string; commentaryId: string }> };

/** PUT `{ body? }`: accepts a suggestion, as it is or edited. Bookkeepers of every organisation. */
export const PUT = route<Context>(async (request, context) => {
  const { groupId, commentaryId } = await context.params;
  const auth = await requireAuth(request);
  const body = await readJson(request);
  return json({ commentary: await changeGroupCommentary({ id: auth.user.id, email: auth.user.email }, groupId, commentaryId, { body: body.body }) });
});

/** DELETE: removes it (kept). Bookkeepers of every organisation. */
export const DELETE = route<Context>(async (request, context) => {
  const { groupId, commentaryId } = await context.params;
  const auth = await requireAuth(request);
  await changeGroupCommentary({ id: auth.user.id, email: auth.user.email }, groupId, commentaryId, { remove: true });
  return json({ removed: true });
});
