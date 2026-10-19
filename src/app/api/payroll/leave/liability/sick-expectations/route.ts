import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { listSickLeaveExpectations, setSickLeaveExpectation } from "@/lib/payroll/sick-leave-expectations";

/** Sick leave expected to be used from carried-over leave, newest first (decision 564; HL62). Query: organisationId, employeeId?. Payroll access. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const expectations = await withPayrollAccess(request, params.get("organisationId"), (tx) => listSickLeaveExpectations(tx, params.get("employeeId") || undefined));
  return json({ expectations });
});

/** Records an assessment from a date. Body: { organisationId, idempotencyKey, employeeId, effectiveFrom, days, reason?, source? }. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    setSickLeaveExpectation(tx, { source: body.source, idempotencyKey: body.idempotencyKey, employeeId: body.employeeId, effectiveFrom: body.effectiveFrom, days: body.days, reason: body.reason }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
