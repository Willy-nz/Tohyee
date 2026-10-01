import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { addPayRate, listPayRates } from "@/lib/payroll/pay-rates";

type Context = { params: Promise<{ employeeId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { employeeId } = await context.params;
  const payRates = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => listPayRates(tx, employeeId));
  return json({ payRates });
});

export const POST = route<Context>(async (request, context) => {
  const { employeeId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    addPayRate(tx, employeeId, {
      idempotencyKey: body.idempotencyKey,
      effectiveFrom: body.effectiveFrom,
      payBasis: body.payBasis,
      annualSalary: body.annualSalary,
      hourlyRate: body.hourlyRate,
      ordinaryHoursPerWeek: body.ordinaryHoursPerWeek,
      reason: body.reason,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
