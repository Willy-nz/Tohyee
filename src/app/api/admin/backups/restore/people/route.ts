import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { backupFileIn, recoverPeople, recoveryMaterial } from "@/lib/backups/recovery";
import { backupFileInFolder } from "@/lib/backups/service";

/**
 * Recovers the people from a server backup (decision 738): `file` (and
 * `folder`), the recovery material, `apply` (false: only say what it would
 * do) and `replace` (emails whose account here the backup's should take
 * the place of).
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request, { maxBytes: 64 * 1024 });
  const file = body.folder ? backupFileIn(body.folder, body.file) : await backupFileInFolder(body.file);
  return json({ plan: await recoverPeople(auth, { file, material: await recoveryMaterial(body), apply: body.apply === true, replace: body.replace }) });
});
