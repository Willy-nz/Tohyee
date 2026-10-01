import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { listLeaveLiabilityPostings, postLeaveLiability } from "@/lib/payroll/leave-liability";

/** Leave liability postings, newest first (decision 177; HL52-HL56). Query: organisationId. Payroll access and the bookkeeper role. */
export const GET = route(async (request) => {
  const postings = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => listLeaveLiabilityPostings(tx));
  return json({ postings });
});

/**
 * Posts the leave liability at a date: one journal for the change since the
 * last posting not voided (HL52, HL53). Body: { organisationId, idempotencyKey, asAt, source? }.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    postLeaveLiability(tx, { source: body.source, idempotencyKey: body.idempotencyKey, asAt: body.asAt }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
