import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { createPayRun, listPayRuns } from "@/lib/payroll/pay-runs";

/** Pay runs (examples PRUN1-PRUN11). Everything needs payroll access and the bookkeeper role. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const payRuns = await withPayrollAccess(request, params.get("organisationId"), (tx) => listPayRuns(tx, { status: params.get("status") }));
  return json({ payRuns });
});

/** Creates a draft. Body: { organisationId, idempotencyKey, source?, payGroupId, periodStart, payDate }. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    createPayRun(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      payGroupId: body.payGroupId,
      periodStart: body.periodStart,
      payDate: body.payDate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
