import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { checkSavedBackupKey } from "@/lib/backups/key";

/** Checks a saved copy of the backup key (`key`, pasted back) is exactly right, and records that it was. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  return json({ keyStatus: await checkSavedBackupKey(auth, body.key) });
});
