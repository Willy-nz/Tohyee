import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { updateDetails } from "@/lib/updates/updates";

/** The Updates page: the last automatic check, the last update, and any organisations blocked by a failed upgrade. Server admins only. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json(await updateDetails());
});
