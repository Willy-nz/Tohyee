import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { voidLeaveLiabilityPosting } from "@/lib/payroll/leave-liability";

type Context = { params: Promise<{ postingId: string }> };

/** Voids the latest leave liability posting with a reversing journal (HL54). Body: { organisationId, idempotencyKey, voidDate, source? }. */
export const POST = route<Context>(async (request, context) => {
  const { postingId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    voidLeaveLiabilityPosting(tx, postingId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
