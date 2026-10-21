import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { findBackups } from "@/lib/backups/recovery";
import { getBackupSettings } from "@/lib/backups/service";

/** The Tohyee backups in `folder` on this computer (blank: the backup folder), by their headers only. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const folder = typeof body.folder === "string" && body.folder.trim() ? body.folder : (await getBackupSettings()).folder;
  return json(await findBackups(folder));
});
