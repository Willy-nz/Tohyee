import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { checkForUpdatesNow } from "@/lib/updates/update-checker";
import { updateDetails } from "@/lib/updates/updates";

/** Checks GitHub now instead of waiting for the daily check. Server admins only. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  await checkForUpdatesNow();
  return json(await updateDetails());
});
