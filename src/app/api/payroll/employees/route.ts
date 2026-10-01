import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createEmployee, listEmployees } from "@/lib/payroll/employees";

export const GET = route(async (request) => {
  const params = searchParams(request);
  const employees = await withOrganisation(request, params.get("organisationId"), "bookkeeper", (tx) =>
    listEmployees(tx, { includeArchived: params.get("includeArchived") === "true" }),
  );
  return json({ employees });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createEmployee(tx, body));
  return json(result, { status: result.created ? 201 : 200 });
});
