import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { resumeOrganisationJobs } from "@/lib/backups/service";

/** Turns on a restored copy's automatic jobs (`organisationId`; decision 738). */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  await resumeOrganisationJobs(auth, body.organisationId);
  return json({ ok: true });
});
