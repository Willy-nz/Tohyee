import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { rotateRecoveryKey } from "@/lib/backups/recovery-kit";

/** Makes a new recovery key version for backups from now on (decision 736). Needs `password` again. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  return json({ recoveryKit: await rotateRecoveryKey(auth, body.password) });
});
