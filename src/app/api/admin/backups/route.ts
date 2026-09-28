import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import {
  backUpNow,
  backupStatus,
  getBackupSettings,
  listBackupFiles,
  recentBackupRuns,
  updateBackupSettings,
} from "@/lib/backups/service";
import { backupKeyStatus } from "@/lib/backups/key";

/** GET: backup settings, each database's latest and last good backup, recent attempts and the files in the folder. Server admins only. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const files = await listBackupFiles();
  return json({
    settings: await getBackupSettings(),
    keyStatus: await backupKeyStatus(),
    status: await backupStatus(),
    runs: await recentBackupRuns(30),
    // Paths on the server stay on the server; files are named relative to the backup folder.
    files: files.map((file) => ({ name: file.name, sizeBytes: file.sizeBytes, header: file.header, problem: file.problem })),
  });
});

/** Saves the backup settings: `enabled`, `folder` (blank = the default), `time` (HH:MM); `reset: true` goes back to the defaults. */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ settings: await updateBackupSettings(auth, await readJson(request)) });
});

/** Backs up now: everything, or one organisation (`organisationId`). Waits until it's done. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const runs = await backUpNow({
    trigger: "manual",
    requestedByEmail: auth.user.email,
    organisationId: typeof body.organisationId === "string" && body.organisationId ? body.organisationId : undefined,
  });
  return json({ runs });
});
