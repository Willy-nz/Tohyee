import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listExpenseSources } from "@/lib/projects/service";

/** GET: lines that can go on a project (approved bills and claims, spend money; not stock, not already on one). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const sources = await withOrganisation(request, params.get("organisationId"), "bookkeeper", (tx) => listExpenseSources(tx, { search: params.get("search") }));
  return json({ sources });
});
