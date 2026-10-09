import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { listCompanies } from "@/lib/crm/service";

/** Companies (contacts) with their people, open tasks, open pipeline and last activity (example CRM8). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const companies = await withCrm(request, params.get("organisationId"), "read", (tx, { scope }) =>
    listCompanies(tx, { search: params.get("search"), includeArchived: params.get("includeArchived") === "true", scope }),
  );
  return json({ companies });
});
