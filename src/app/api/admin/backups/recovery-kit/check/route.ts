import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { checkRecoveryKit } from "@/lib/backups/recovery-kit";

/**
 * Checks a saved recovery kit (decision 736): `code`, or `file` (the
 * recovery file's text) and `passphrase`. The server opens it, compares it
 * with the key it holds for that version, and records that it matched.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  return json({ recoveryKit: await checkRecoveryKit(auth, body) });
});
