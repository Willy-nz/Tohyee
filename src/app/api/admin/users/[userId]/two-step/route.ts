import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { resetUserTwoStep } from "@/lib/users/admin";

/** Resets a user's two-step sign-in (lost phone). The answer has a setup link for setting it up again (#208). */
export const DELETE = route<{ params: Promise<{ userId: string }> }>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { userId } = await context.params;
  return json(await resetUserTwoStep(auth.user, userId));
});
