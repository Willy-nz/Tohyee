import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { updateUser } from "@/lib/users/admin";

export const PATCH = route<{ params: Promise<{ userId: string }> }>(async (request, context) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth);
  const { userId } = await context.params;
  const body = await readJson(request);
  const user = await updateUser(auth.user, userId, {
    displayName: body.displayName,
    isActive: body.isActive,
    isServerAdmin: body.isServerAdmin,
    newPassword: body.newPassword,
  });
  return json({ user });
});
