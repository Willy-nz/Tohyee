import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { backupFileIn, inspectBackup, recoveryMaterial } from "@/lib/backups/recovery";
import { backupFileInFolder } from "@/lib/backups/service";

/**
 * Checks a backup before restoring it: the recovery material opens it, the
 * whole file is intact (decrypted into pg_restore --list) and this server
 * can take its version. Nothing is made.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request, { maxBytes: 64 * 1024 });
  const file = body.folder ? backupFileIn(body.folder, body.file) : await backupFileInFolder(body.file);
  return json(await inspectBackup(file, await recoveryMaterial(body)));
});
