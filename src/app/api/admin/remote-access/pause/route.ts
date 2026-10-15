import { json, requireAuth, route } from "@/lib/api/http";
import { authenticate, requireServerAdmin } from "@/lib/auth/guard";
import { remotePauseStatus, resumeRemoteAccess } from "@/lib/auth/remote-pause";

/** GET: whether remote access is paused after many failed sign-ins (decision 542). Server admins only. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  requireServerAdmin(auth, request);
  return json({ pause: await remotePauseStatus() });
});

/** POST: resumes remote access before the pause ends. Server admins only, on the server computer. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ pause: await resumeRemoteAccess({ userId: auth.user.id, email: auth.user.email }) });
});
