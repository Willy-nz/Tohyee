import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { removeGoogleSignIn } from "@/lib/auth/google-sign-in";

/** DELETE: removes someone's Google sign-in and ends their Google sessions (#424). Server admins, on the server computer. */
export const DELETE = route<{ params: Promise<{ userId: string }> }>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { userId } = await context.params;
  return json(await removeGoogleSignIn(auth.user, userId));
});
