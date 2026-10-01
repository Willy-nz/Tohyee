import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { approvePayRun } from "@/lib/payroll/pay-runs";

type Context = { params: Promise<{ payRunId: string }> };

/** Approves a draft and posts its journal (PRUN1, PRUN5, PRUN7). Body: { organisationId, idempotencyKey, source? }. */
export const POST = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    approvePayRun(tx, payRunId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
