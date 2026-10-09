import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { markSignInsSeen, unseenFlags } from "@/lib/auth/sign-in-log";

/** POST: "I've looked": flagged sign-ins so far stop counting as new. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  await markSignInsSeen(auth.user);
  return json({ unseen: await unseenFlags() });
});
