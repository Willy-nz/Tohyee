import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { sendSetupLink } from "@/lib/auth/setup-links";

/** POST: a fresh setup link for a login that hasn't set up two-step sign-in (the old one stops working). Server admins, on the server computer. */
export const POST = route<{ params: Promise<{ userId: string }> }>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { userId } = await context.params;
  return json({ setupLink: await sendSetupLink(auth.user, userId) });
});
