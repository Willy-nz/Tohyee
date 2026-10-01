import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { createEmployeeGroup, createPayGroup, listPayrollGroups } from "@/lib/payroll/groups";

export const GET = route(async (request) => {
  const params = searchParams(request);
  const groups = await withPayrollAccess(request, params.get("organisationId"), (tx) =>
    listPayrollGroups(tx, { includeArchived: params.get("includeArchived") === "true" }),
  );
  return json(groups);
});

/** Body: { organisationId, kind: "pay" | "employee", idempotencyKey, name, payFrequency (pay groups) }. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const input = { idempotencyKey: body.idempotencyKey, name: body.name, payFrequency: body.payFrequency };
  const result = await withPayrollAccess(request, body.organisationId, (tx) => {
    if (body.kind === "pay") return createPayGroup(tx, input);
    if (body.kind === "employee") return createEmployeeGroup(tx, { idempotencyKey: input.idempotencyKey, name: input.name });
    throw new ValidationError('kind must be "pay" or "employee".');
  });
  return json(result, { status: result.created ? 201 : 200 });
});
