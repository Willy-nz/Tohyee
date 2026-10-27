import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { removeUserPasskeys } from "@/lib/auth/passkeys";

/** DELETE: removes all of someone's passkeys (#450): their passkey sessions end and their apps disconnect. Server admins, on the server computer. */
export const DELETE = route<{ params: Promise<{ userId: string }> }>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { userId } = await context.params;
  return json(await removeUserPasskeys(auth.user, userId));
});
