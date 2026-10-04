import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { listBankFileFolders, setBankFilesFolder } from "@/lib/bank/file-folders";
import { parseOrganisationId } from "@/lib/organisations/registry";

/** Each organisation's bank files folder on this server (decision 386). Server admins, on the server only. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ folders: await listBankFileFolders() });
});

/** Sets one organisation's bank files folder: `organisationId`, `folder` (a full path; blank clears it). */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const folder = await setBankFilesFolder(auth, parseOrganisationId(body.organisationId), body.folder);
  return json({ folder });
});
