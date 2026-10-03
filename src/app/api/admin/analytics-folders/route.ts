import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { listSourceFolders, setSourceFolder } from "@/lib/analytics/folders";
import { parseOrganisationId } from "@/lib/organisations/registry";

/** Each organisation's analytics folder on this server (decision 358). Server admins, on the server only. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ folders: await listSourceFolders() });
});

/** Sets one organisation's folder: `organisationId`, `folder` (a full path; blank clears it). */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const folder = await setSourceFolder(auth, parseOrganisationId(body.organisationId), body.folder);
  return json({ folder });
});
