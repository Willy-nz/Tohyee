import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listCompanies } from "@/lib/crm/service";

/** Companies (contacts) with their people, open tasks, open pipeline and last activity (example CRM8). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const companies = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listCompanies(tx, { search: params.get("search"), includeArchived: params.get("includeArchived") === "true" }),
  );
  return json({ companies });
});
