import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { createEmployee, listEmployees } from "@/lib/payroll/employees";

export const GET = route(async (request) => {
  const params = searchParams(request);
  const employees = await withPayrollAccess(request, params.get("organisationId"), (tx) =>
    listEmployees(tx, { includeArchived: params.get("includeArchived") === "true" }),
  );
  return json({ employees });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => createEmployee(tx, body));
  return json(result, { status: result.created ? 201 : 200 });
});
