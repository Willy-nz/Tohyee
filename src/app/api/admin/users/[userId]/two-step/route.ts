import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { resetUserTwoStep } from "@/lib/users/admin";

/** Resets a user's two-step sign-in (lost phone). They set it up again at their next sign-in. */
export const DELETE = route<{ params: Promise<{ userId: string }> }>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth);
  const { userId } = await context.params;
  return json({ user: await resetUserTwoStep(auth.user, userId) });
});
