import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listAnnualDrafts } from "@/lib/reports/annual-document";

/** GET: the saved sets of annual financial statements, newest change first; `status` "draft" or "final" narrows them (FS17). Viewers and above. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const status = params.get("status");
  const drafts = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listAnnualDrafts(tx, { status: status === "draft" || status === "final" ? status : undefined }),
  );
  return json({ drafts });
});
