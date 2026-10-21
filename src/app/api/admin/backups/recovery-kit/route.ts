import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { exportRecoveryKit, recoveryKitStatus, suggestPassphrase } from "@/lib/backups/recovery-kit";

/** GET: the recovery kit's status (no key), and a passphrase to suggest for a recovery file. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ recoveryKit: await recoveryKitStatus(), suggestedPassphrase: suggestPassphrase() });
});

/**
 * POST: the recovery kit for the current recovery key (decision 735). Needs
 * `password` again. `form` "code" gives the recovery code; "file" gives a
 * recovery file encrypted with `passphrase` (14+ characters), named at
 * random when `randomName` is true. Nothing else leaves the server.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  return json({ kit: await exportRecoveryKit(auth, body) });
});
