import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { listHandovers } from "@/lib/organisations/handover";

/** GET: organisation handovers, newest first (#208). Server admins, on the server computer. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ handovers: await listHandovers() });
});
