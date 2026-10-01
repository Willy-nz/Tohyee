import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { addAllocation, listAllocations } from "@/lib/payroll/allocations";

type Context = { params: Promise<{ employeeId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { employeeId } = await context.params;
  const allocations = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) =>
    listAllocations(tx, employeeId),
  );
  return json({ allocations });
});

export const POST = route<Context>(async (request, context) => {
  const { employeeId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    addAllocation(tx, employeeId, { idempotencyKey: body.idempotencyKey, effectiveFrom: body.effectiveFrom, lines: body.lines }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
