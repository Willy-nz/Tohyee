import { json, route } from "@/lib/api/http";
import { authenticate } from "@/lib/auth/guard";
import { getGoogleSignInStatus } from "@/lib/auth/google-sign-in";

/** GET: Sign in with Google on Your account (#424): whether it's on here, and the linked account. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  return json({ google: await getGoogleSignInStatus(auth.user.id, auth.sessionId) });
});
