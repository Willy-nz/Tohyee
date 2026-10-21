import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { checkStoredBackups } from "@/lib/backups/checks";

/**
 * Checks the backups now: reads each database's newest backup file (or one
 * organisation's, `organisationId`) back from the folder and checks it fully
 * again (decision 732). Waits until it's done.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const checks = await checkStoredBackups({
    requestedByEmail: auth.user.email,
    organisationId: typeof body.organisationId === "string" && body.organisationId ? body.organisationId : undefined,
  });
  return json({ checks });
});
