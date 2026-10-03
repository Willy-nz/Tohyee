import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { listSourceFiles } from "@/lib/analytics/engine";
import { organisationSourceFolder, sourceFolderStatus } from "@/lib/analytics/folders";
import { lastBooksRun, listSources, recentLoads } from "@/lib/analytics/sources";

/**
 * The organisation's analytics: whether it's on, whether its folder is
 * chosen and readable, its sources with their last load, recent loads, and
 * (for admins and owners, who set up sources) the files in the folder. The
 * folder's path stays on the server.
 */
export const GET = route(async (request) => {
  const organisationId = searchParams(request).get("organisationId");
  const result = await withOrganisation(request, organisationId, "viewer", async (tx, { membership }) => {
    const enabled = await tx.query<{ on: boolean }>("select analytics_enabled as on from organisation_settings where id = true");
    return {
      enabled: enabled.rows[0]?.on === true,
      canManage: roleAtLeast(membership.role, "admin"),
      sources: await listSources(tx),
      books: await lastBooksRun(tx),
      loads: await recentLoads(tx, 50),
    };
  });
  const id = String(organisationId);
  const folder = await sourceFolderStatus(id);
  let files: ReturnType<typeof listSourceFiles> = [];
  if (result.canManage && result.enabled && folder.readable) {
    const path = await organisationSourceFolder(id);
    if (path) files = listSourceFiles(path);
  }
  return json({ ...result, folder, files });
});
