import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { listWagePayments, recordWagePayment } from "@/lib/payroll/wage-payments";

type Context = { params: Promise<{ payRunId: string }> };

/** A pay run's wage payments and what's unpaid (PPAY1, PPAY2). Bookkeeper and payroll access. */
export const GET = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const payments = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => listWagePayments(tx, payRunId));
  return json({ payments });
});

/**
 * Pays an approved pay run's net wages (PPAY1, PPAY2).
 * Body: { organisationId, idempotencyKey, paymentDate, amount, bankAccountCode, employeeId?, source? }.
 */
export const POST = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    recordWagePayment(tx, payRunId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      paymentDate: body.paymentDate,
      amount: body.amount,
      bankAccountCode: body.bankAccountCode,
      employeeId: body.employeeId,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
