import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { backupFileIn, recoveryMaterial } from "@/lib/backups/recovery";
import { backupFileInFolder, restoreBackup } from "@/lib/backups/service";

/**
 * Restores a backup as a new organisation (a copy; decisions 737-739):
 * `file` (relative to the backup folder, or to `folder` when the backups
 * are somewhere else on this computer), optional `id` and `displayName`,
 * and the recovery material when this server didn't make it: `key` (a
 * recovery code) or `kitFile` (a recovery file's text) and `passphrase`. Nothing existing is overwritten;
 * stored secrets are re-encrypted for this server and automatic jobs start
 * paused. Returns the organisation and what was checked and done.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request, { maxBytes: 64 * 1024 });
  const file = body.folder ? backupFileIn(body.folder, body.file) : await backupFileInFolder(body.file);
  const result = await restoreBackup(auth.user, {
    file,
    id: body.id,
    displayName: body.displayName,
    material: await recoveryMaterial(body),
  });
  return json(result, { status: 201 });
});
