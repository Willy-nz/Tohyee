import { json, route, searchParams } from "@/lib/api/http";
import { inspectCsv } from "@/lib/analytics/engine";
import { organisationSourceFolder } from "@/lib/analytics/folders";
import { analyticsMember } from "@/lib/analytics/http";
import { requireAnalytics } from "@/lib/analytics/sources";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError } from "@/lib/errors";

/** A look at one file before it's set up: headings, suggested types and the first rows. Admins and owners. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const { organisation, actor } = await analyticsMember(request, params.get("organisationId"), "admin");
  await withOrganisationTransaction(organisation, actor, (tx) => requireAnalytics(tx), { readOnly: true });
  const folder = await organisationSourceFolder(organisation.id);
  if (!folder) throw new ConflictError("A server admin needs to choose this organisation's analytics folder first.");
  const delimiter = params.get("delimiter") || undefined;
  return json(await inspectCsv(folder, params.get("file") ?? "", delimiter));
});
