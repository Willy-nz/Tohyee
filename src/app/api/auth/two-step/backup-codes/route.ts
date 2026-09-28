import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { regenerateBackupCodes } from "@/lib/auth/two-step";

/** Makes new backup codes (the old ones stop working). Needs a current authenticator `code`. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  return json({ backupCodes: await regenerateBackupCodes(auth.user, { code: body.code }) });
});
