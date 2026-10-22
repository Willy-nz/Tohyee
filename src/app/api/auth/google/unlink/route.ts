import { json, requireAuth, route } from "@/lib/api/http";
import { getGoogleSignInStatus, unlinkOwnGoogle } from "@/lib/auth/google-sign-in";

/** POST: unlinks your Google account, only if you'd still have another way to sign in (#424). */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  await unlinkOwnGoogle(auth.user, auth.sessionId);
  return json({ google: await getGoogleSignInStatus(auth.user.id, auth.sessionId) });
});
