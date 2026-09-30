import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getMappings } from "@/lib/import/service";

/** The column mappings last used for each kind of import file. Admins. */
export const GET = route(async (request) => {
  const mappings = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => getMappings(tx));
  return json({ mappings });
});
