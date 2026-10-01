import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { voidIrdPayment } from "@/lib/payroll/ird-payments";

type Context = { params: Promise<{ paymentId: string }> };

/** Voids an IRD payment with a reversing journal (PPAY12). Body: { organisationId, idempotencyKey, voidDate, source? }. */
export const POST = route<Context>(async (request, context) => {
  const { paymentId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    voidIrdPayment(tx, paymentId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
