import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { backupFileInFolder, restoreBackupAsCopy } from "@/lib/backups/service";

/**
 * Restores a backup from the backup folder as a new organisation (a copy):
 * `file` (as listed by GET /api/admin/backups), optional `id` and
 * `displayName` for the copy. Nothing existing is overwritten.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const organisation = await restoreBackupAsCopy(auth.user, {
    file: await backupFileInFolder(body.file),
    id: body.id,
    displayName: body.displayName,
  });
  return json({ organisation }, { status: 201 });
});
