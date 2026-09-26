import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { changeOwnPassword } from "@/lib/auth/service";

/** Change your own password. Signs out your other sessions. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  await changeOwnPassword(auth.user.id, auth.sessionId, {
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
  });
  return json({ ok: true });
});
