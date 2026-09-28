import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { revealBackupKey } from "@/lib/backups/key";

/** Shows the backup key (this server's TOHYEE_SECRET_KEY) so a server admin can save a copy. Needs their `password` again. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  return json(await revealBackupKey(auth, body.password));
});
