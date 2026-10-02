import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { serverStats } from "@/lib/server-stats/sampler";

/** The server app's Stats page (decision 332): this computer's and Tohyee's use, with the last 24 hours. Server admins only. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json(await serverStats());
});
