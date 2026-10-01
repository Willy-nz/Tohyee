import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { voidPayRun } from "@/lib/payroll/pay-runs";

type Context = { params: Promise<{ payRunId: string }> };

/** Voids an approved pay run with a reversing journal (PRUN6). Body: { organisationId, idempotencyKey, voidDate, source? }. */
export const POST = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    voidPayRun(tx, payRunId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
