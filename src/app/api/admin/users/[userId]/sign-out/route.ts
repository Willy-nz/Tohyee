import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { signOutEverywhere } from "@/lib/auth/session-list";

/** POST: signs the person out everywhere (#208). Server admins, on the server computer. */
export const POST = route<{ params: Promise<{ userId: string }> }>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { userId } = await context.params;
  return json({ ended: await signOutEverywhere(auth.user, userId) });
});
