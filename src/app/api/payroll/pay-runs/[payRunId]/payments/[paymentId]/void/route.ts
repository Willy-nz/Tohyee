import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { voidWagePayment } from "@/lib/payroll/wage-payments";

type Context = { params: Promise<{ payRunId: string; paymentId: string }> };

/** Voids a wage payment with a reversing journal (PPAY3). Body: { organisationId, idempotencyKey, voidDate, source? }. */
export const POST = route<Context>(async (request, context) => {
  const { payRunId, paymentId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    voidWagePayment(tx, payRunId, paymentId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
