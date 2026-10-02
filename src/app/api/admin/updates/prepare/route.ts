import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { prepareUpdate } from "@/lib/updates/updates";

/**
 * The server app's "Install" (decision 329): backs up everything, then hands
 * back the installer to download and its SHA-256. Body: `version`, the
 * version being installed. Waits until the backups are done.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json(await prepareUpdate(auth, await readJson(request)));
});
