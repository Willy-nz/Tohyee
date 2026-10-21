import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { testRestore } from "@/lib/backups/recovery";

/**
 * A test restore (decision 739): the newest backup of each database (or one
 * organisation, `organisationId`) restored into a scratch database, checked
 * and dropped. Waits until it's done.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const checks = await testRestore({
    requestedByEmail: auth.user.email,
    organisationId: typeof body.organisationId === "string" && body.organisationId ? body.organisationId : undefined,
  });
  return json({ checks });
});
